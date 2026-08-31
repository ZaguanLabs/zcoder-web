import { FlatJson, listSessions, loadTranscript, ZcoderError, ZcoderServer, zcoderRequest } from "@/lib/zcoder";

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
    case "events.next": return zcoderRequest(server, "GET", `/v1/events?after=${cursor(input)}`);
    case "approval": {
      const decision = text(input, "decision", 1);
      if (!new Set(["y", "a", "n"]).has(decision)) throw new ZcoderError("Invalid approval decision", 400);
      return zcoderRequest(server, "POST", "/v1/approval", { id: text(input, "id", 100), decision });
    }
    case "cancel": return zcoderRequest(server, "POST", "/v1/cancel", {});
    default: throw new ZcoderError("Unknown operation", 400);
  }
}

