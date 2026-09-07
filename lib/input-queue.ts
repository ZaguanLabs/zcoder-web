import { RpcResponseError } from "./client-rpc";

export type InputMode = "steer" | "follow_up";
export type InputRequest = { session_id: string; turn_id: string; message_id: string; mode: InputMode; text: string };
export type ReceiptState = "accepted" | "consumed" | "discarded";
export type InputRecord = { request: InputRequest; state: ReceiptState | "uncertain" | "rejected"; error?: string };
export type QueueSnapshot = { records: InputRecord[]; turnId: string; pending: string; loading: boolean; error: string };
export type QueueRpc = (body: Record<string, unknown>) => Promise<unknown>;
type QueueStorage = Pick<Storage, "getItem" | "setItem">;

export function validateInputRequest(value: Record<string, unknown>): InputRequest {
  for (const key of ["session_id", "turn_id", "message_id", "text"]) {
    if (typeof value[key] !== "string" || !value[key]) throw new Error(`Invalid ${key}`);
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value.message_id as string)) throw new Error("Invalid message_id");
  if ((value.session_id as string).length > 80 || (value.turn_id as string).length > 100) throw new Error("Invalid session or run ID");
  const mode = value.mode === undefined || value.mode === "" ? "steer" : value.mode;
  if (mode !== "steer" && mode !== "follow_up") throw new Error("Invalid input mode");
  if (new TextEncoder().encode(value.text as string).length > 65_536) throw new Error("Queued input exceeds 65,536 UTF-8 bytes");
  return { session_id: value.session_id as string, turn_id: value.turn_id as string, message_id: value.message_id as string, mode, text: value.text as string };
}

export function readReceipt(value: unknown, messageId: string): ReceiptState {
  if (!value || typeof value !== "object" || !("message_id" in value) || value.message_id !== messageId || !("state" in value) ||
    !["accepted", "consumed", "discarded"].includes(value.state as string)) throw new Error("Server returned a mismatched or invalid input receipt");
  return value.state as ReceiptState;
}

export function readQueueListing(value: unknown): { turnId: string; pending: string } {
  if (!value || typeof value !== "object" || !("turn_id" in value) || typeof value.turn_id !== "string" ||
    !("pending" in value) || typeof value.pending !== "string") throw new Error("Server returned an invalid queue listing");
  // The pending string is display-only: message text can imitate listing rows.
  return { turnId: value.turn_id, pending: value.pending };
}

export function queueStorageKey(serverId: string, sessionId: string): string {
  return `zcoder-input-v1:${encodeURIComponent(serverId)}:${encodeURIComponent(sessionId)}`;
}

export const emptyQueue: QueueSnapshot = { records: [], turnId: "", pending: "", loading: true, error: "" };

/** A session-scoped outbox. Persist the exact request before any network mutation. */
export class InputQueue {
  snapshot: QueueSnapshot = { ...emptyQueue };
  private readonly key: string;
  private refreshing: Promise<void> | null = null;
  private operations = new Set<string>();

  constructor(private readonly sessionId: string, serverId: string, private readonly rpc: QueueRpc,
    private readonly storage: QueueStorage, private readonly changed: (snapshot: QueueSnapshot) => void) {
    this.key = queueStorageKey(serverId, sessionId);
    const raw = storage.getItem(this.key);
    if (raw) {
      const saved: unknown = JSON.parse(raw);
      if (!Array.isArray(saved)) throw new Error("Saved queued input is invalid");
      this.snapshot.records = saved.map((record: InputRecord) => {
        const request = validateInputRequest(record.request);
        if (request.session_id !== sessionId || !["uncertain", "rejected", "accepted", "consumed", "discarded"].includes(record.state)) {
          throw new Error("Saved queued input is invalid");
        }
        return { request, state: record.state, error: record.error };
      });
    }
    changed(this.snapshot);
  }

  private publish(update: Partial<QueueSnapshot>) {
    this.snapshot = { ...this.snapshot, ...update };
    this.changed(this.snapshot);
  }

  private save(records: InputRecord[]) {
    // Failure blocks a new submission, so it can never lose its retry identity.
    this.storage.setItem(this.key, JSON.stringify(records));
    this.publish({ records });
  }

  private update(id: string, change: Partial<InputRecord>) {
    const records = this.snapshot.records.map((record) => {
      if (record.request.message_id !== id) return record;
      // An older in-flight status response must not undo a terminal receipt.
      if (["consumed", "discarded"].includes(record.state) && change.state && change.state !== record.state) return record;
      return { ...record, ...change };
    });
    try { this.save(records); }
    catch { this.publish({ records, error: "Could not save updated receipts in this browser. Keep this tab open." }); }
  }

  closeRun(turnId: string) {
    if (this.snapshot.turnId === turnId) this.publish({ turnId: "" });
  }

  async submit(turnId: string, mode: InputMode, text: string) {
    const request = validateInputRequest({ session_id: this.sessionId, turn_id: turnId, message_id: `web-${crypto.randomUUID()}`, mode, text });
    this.save([...this.snapshot.records, { request, state: "uncertain" }]);
    return this.send(request, true);
  }

  async retry(id: string) {
    const record = this.snapshot.records.find((item) => item.request.message_id === id);
    if (!record) throw new Error("Saved input not found");
    return this.send(record.request, false);
  }

  private async send(request: InputRequest, firstAttempt: boolean) {
    const id = request.message_id;
    if (this.operations.has(id)) return false;
    this.operations.add(id);
    let receivedResponse = false;
    try {
      const response = await this.rpc({ action: "input.submit", ...request });
      receivedResponse = true;
      const state = readReceipt(response, id);
      this.update(id, { state, error: undefined });
      return true;
    } catch (error) {
      this.update(id, { error: error instanceof Error ? error.message : "Submission outcome is unknown" });
      // Reconcile even a conflict; an earlier attempt may have reached the server.
      const reconciled = await this.check(id);
      if (reconciled) return !receivedResponse;
      if (firstAttempt && error instanceof RpcResponseError && [400, 404, 409, 413].includes(error.status ?? 0)) {
        this.update(id, { state: "rejected", error: error.message });
      }
      return false;
    } finally { this.operations.delete(id); }
  }

  async check(id: string): Promise<boolean> {
    try {
      const state = readReceipt(await this.rpc({ action: "input.status", session_id: this.sessionId, message_id: id }), id);
      this.update(id, { state, error: undefined });
      return true;
    } catch (error) {
      this.update(id, { error: error instanceof Error ? error.message : "Could not reconcile input" });
      return false;
    }
  }

  async drop(id: string) {
    if (this.operations.has(id)) return;
    this.operations.add(id);
    try {
      const state = readReceipt(await this.rpc({ action: "input.drop", session_id: this.sessionId, message_id: id }), id);
      if (state !== "discarded") throw new Error("Server did not confirm discard");
      this.update(id, { state, error: undefined });
    } catch (error) {
      this.update(id, { error: error instanceof Error ? error.message : "Discard outcome is unknown" });
      await this.check(id); // Drop itself is not idempotent; consumption may have won.
    } finally { this.operations.delete(id); }
    await this.refresh();
  }

  dismiss(id: string) {
    this.save(this.snapshot.records.filter((record) => record.request.message_id !== id || ["uncertain", "accepted"].includes(record.state)));
  }

  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.inspect().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async inspect() {
    try {
      const listing = readQueueListing(await this.rpc({ action: "input.list", session_id: this.sessionId }));
      this.publish({ ...listing, error: "" });
      // The native listener is serial. Bound polling and never fan out 100 requests.
      for (const record of this.snapshot.records) {
        if (["accepted", "uncertain"].includes(record.state) && !this.operations.has(record.request.message_id)) await this.check(record.request.message_id);
      }
    } catch (error) {
      this.publish({ error: error instanceof Error ? error.message : "Could not inspect queued input" });
    } finally { this.publish({ loading: false }); }
  }
}
