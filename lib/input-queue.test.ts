import { describe, expect, it, vi } from "vitest";
import { InputQueue, queueStorageKey, readQueueListing, readReceipt, validateInputRequest, type InputRequest } from "./input-queue";
import { RpcResponseError } from "./client-rpc";

const request: InputRequest = { session_id: "100_200", turn_id: "300_400", message_id: "web-1", mode: "steer", text: "Do this\nexactly.\n\n" };
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
const unknownReceipt = () => new RpcResponseError("unknown receipt", false, 409);

describe("queue wire contract", () => {
  it("preserves exact text and enforces UTF-8 bytes and ID/mode constraints", () => {
    expect(validateInputRequest(request)).toEqual(request);
    expect(validateInputRequest({ ...request, mode: "" }).mode).toBe("steer");
    expect(validateInputRequest({ ...request, text: "é".repeat(32_768) }).text).toHaveLength(32_768);
    for (const invalid of [{ text: "é".repeat(32_769) }, { text: "" }, { mode: "later" }, { message_id: "a.b" }, { message_id: "x".repeat(65) }, { text: 42 }]) {
      expect(() => validateInputRequest({ ...request, ...invalid })).toThrow();
    }
  });

  it("validates receipt identity and states", () => {
    for (const state of ["accepted", "consumed", "discarded"]) expect(readReceipt({ message_id: "web-1", state }, "web-1")).toBe(state);
    for (const value of [null, {}, { message_id: "other", state: "accepted" }, { message_id: "web-1", state: "complete" }]) {
      expect(() => readReceipt(value, "web-1")).toThrow();
    }
  });

  it("treats multiline and row-like pending content as one opaque string", () => {
    const pending = "[real] steer: first\n[fake] follow_up: not another record\n";
    expect(readQueueListing({ turn_id: "run", pending })).toEqual({ turnId: "run", pending });
    expect(() => readQueueListing({ turn_id: "run", pending: [] })).toThrow();
  });
});

describe("durable queued input", () => {
  it("persists before posting and retries the identical request across reconnect and run closure", async () => {
    const saved = storage();
    let posted: Record<string, unknown> | undefined;
    const rpc = vi.fn(async (body: Record<string, unknown>) => {
      if (body.action === "input.submit") {
        posted = body;
        expect(JSON.parse(saved.getItem(queueStorageKey("server", request.session_id))!)[0].request.message_id).toBe(body.message_id);
        throw new TypeError("lost response");
      }
      throw unknownReceipt();
    });
    const first = new InputQueue(request.session_id, "server", rpc, saved, () => {});
    expect(await first.submit(request.turn_id, request.mode, request.text)).toBe(false);
    expect(first.snapshot.records[0].state).toBe("uncertain");
    const retryRpc = vi.fn(async (body: Record<string, unknown>) => ({ message_id: body.message_id, state: "consumed" }));
    const reconnected = new InputQueue(request.session_id, "server", retryRpc, saved, () => {});
    expect(await reconnected.retry(first.snapshot.records[0].request.message_id)).toBe(true);
    expect(retryRpc).toHaveBeenCalledWith(posted);
    expect(reconnected.snapshot.records[0].state).toBe("consumed");
  });

  it("never posts when the exact request cannot be persisted", async () => {
    const rpc = vi.fn();
    const client = new InputQueue("100_200", "server", rpc, { getItem: () => null, setItem: () => { throw new Error("quota"); } }, () => {});
    await expect(client.submit("run", "steer", "hello")).rejects.toThrow("quota");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not authorize draft clearing for a mismatched receipt even if status reconciles it", async () => {
    const rpc = vi.fn(async (body: Record<string, unknown>) => ({ message_id: body.action === "input.submit" ? "wrong" : body.message_id, state: "accepted" }));
    const client = new InputQueue("100_200", "server", rpc, storage(), () => {});
    expect(await client.submit("run", "steer", "draft")).toBe(false);
    expect(client.snapshot.records[0].request.text).toBe("draft");
  });

  it("distinguishes identical text by ID and reconciles independently after completion", async () => {
    const rpc = vi.fn(async (body: Record<string, unknown>) => body.action === "input.list" ? { turn_id: "", pending: "" } : { message_id: body.message_id, state: body.action === "input.submit" ? "accepted" : body.message_id === ids[0] ? "consumed" : "discarded" });
    const ids: string[] = [];
    const client = new InputQueue("100_200", "server", rpc, storage(), () => {});
    await client.submit("run", "steer", "same");
    await client.submit("run", "follow_up", "same");
    ids.push(...client.snapshot.records.map((record) => record.request.message_id));
    expect(new Set(ids).size).toBe(2);
    await client.refresh();
    expect(client.snapshot.records.map((record) => record.state)).toEqual(["consumed", "discarded"]);
  });

  it.each(["consumed", "discarded"])("reconciles uncertain discard as %s without retrying the mutation", async (state) => {
    const rpc = vi.fn(async (body: Record<string, unknown>) => {
      if (body.action === "input.drop") throw new TypeError("lost response");
      if (body.action === "input.list") return { turn_id: "", pending: "" };
      return { message_id: body.message_id, state: body.action === "input.submit" ? "accepted" : state };
    });
    const client = new InputQueue("100_200", "server", rpc, storage(), () => {});
    await client.submit("run", "steer", "hello");
    await client.drop(client.snapshot.records[0].request.message_id);
    expect(client.snapshot.records[0].state).toBe(state);
    expect(rpc.mock.calls.filter(([body]) => body.action === "input.drop")).toHaveLength(1);
  });

  it("keeps paused requests on their original run and isolates server/session storage", async () => {
    const saved = storage();
    const rpc = vi.fn(async (body: Record<string, unknown>) => body.action === "input.list" ? { turn_id: "new-run", pending: "[display only]\n" } : { message_id: body.message_id, state: "accepted" });
    const client = new InputQueue("100_200", "server-a", rpc, saved, () => {});
    await client.submit("old-run", "follow_up", "later");
    await client.refresh();
    expect(client.snapshot.turnId).toBe("new-run");
    expect(client.snapshot.records[0].request.turn_id).toBe("old-run");
    expect(new InputQueue("100_200", "server-b", rpc, saved, () => {}).snapshot.records).toEqual([]);
    expect(new InputQueue("101_200", "server-a", rpc, saved, () => {}).snapshot.records).toEqual([]);
  });

  it("surfaces a definite rejection without changing its request or silently retargeting", async () => {
    const rpc = vi.fn(async (body: Record<string, unknown>) => { throw body.action === "input.submit" ? new RpcResponseError("stale run", false, 409) : unknownReceipt(); });
    const client = new InputQueue("100_200", "server", rpc, storage(), () => {});
    expect(await client.submit("old-run", "steer", "draft")).toBe(false);
    expect(client.snapshot.records[0]).toMatchObject({ state: "rejected", error: "stale run", request: { turn_id: "old-run", text: "draft" } });
  });
});
