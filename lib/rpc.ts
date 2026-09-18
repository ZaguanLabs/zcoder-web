import { FlatJson, listSessions, loadTranscript, ZcoderError, ZcoderServer, zcoderRequest } from "@/lib/zcoder";
import { validateInputRequest } from "@/lib/input-queue";

type RpcInput = { action?: unknown; [key: string]: unknown };

function text(input: RpcInput, key: string, maxLength: number): string {
  const value = input[key];
  if (typeof value !== "string" || !value || value.length > maxLength) throw new ZcoderError(`Invalid ${key}`, 400);
  return value;
}

function cursor(input: RpcInput): number {
  const value = input.after;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ZcoderError("Invalid event cursor", 400);
  return value as number;
}

export async function runRpc(server: ZcoderServer, input: RpcInput): Promise<FlatJson | FlatJson[]> {
  switch (input.action) {
    case "hello": return zcoderRequest(server, "GET", "/v1/hello");
    case "model.get": return zcoderRequest(server, "GET", "/v1/model");
    case "model.ensure": return zcoderRequest(server, "POST", "/v1/model/ensure", {});
    case "sessions.list": return listSessions(server);
    case "session.load": return loadTranscript(server, text(input, "id", 80));
    case "session.select": return zcoderRequest(server, "POST", "/v1/session/select", { id: text(input, "id", 80) });
    case "session.new": return zcoderRequest(server, "POST", "/v1/session/new", {});
    case "turn.start": return zcoderRequest(server, "POST", "/v1/turn", { prompt: text(input, "prompt", 900_000) });
    case "input.submit": {
      let request;
      try { request = validateInputRequest(input); }
      catch (error) { throw new ZcoderError(error instanceof Error ? error.message : "Invalid queued input", 400); }
      return zcoderRequest(server, "POST", "/v1/input", request);
    }
    case "input.list": return zcoderRequest(server, "POST", "/v1/input/list", { session_id: text(input, "session_id", 80) });
    case "input.status":
    case "input.drop": {
      const messageId = text(input, "message_id", 64);
      if (!/^[A-Za-z0-9_-]+$/.test(messageId)) throw new ZcoderError("Invalid message_id", 400);
      return zcoderRequest(server, "POST", input.action === "input.status" ? "/v1/input/status" : "/v1/input/drop", {
        session_id: text(input, "session_id", 80), message_id: messageId,
      });
    }
    case "events.next": return zcoderRequest(server, "GET", `/v1/events?after=${cursor(input)}`);
    case "approval": {
      const decision = text(input, "decision", 1);
      if (!new Set(["y", "a", "n"]).has(decision)) throw new ZcoderError("Invalid approval decision", 400);
      return zcoderRequest(server, "POST", "/v1/approval", { id: text(input, "id", 100), decision });
    }
    case "cancel": {
      const scoped = input.session_id !== undefined || input.turn_id !== undefined || input.continue_queued !== undefined;
      if (!scoped) return zcoderRequest(server, "POST", "/v1/cancel", {});
      if (typeof input.continue_queued !== "boolean") throw new ZcoderError("Invalid continue_queued", 400);
      return zcoderRequest(server, "POST", "/v1/cancel", {
        session_id: text(input, "session_id", 80),
        turn_id: text(input, "turn_id", 100),
        continue_queued: input.continue_queued,
      });
    }
    default: throw new ZcoderError("Unknown operation", 400);
  }
}
