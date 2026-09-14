import { BodyError, readBoundedText } from "@/lib/request";

type Scalar = string | number | boolean | null;
export type FlatJson = Record<string, Scalar>;

export type ZcoderServer = { id: string; name: string; url: string; token: string };

export class ZcoderError extends Error {
  constructor(message: string, public readonly status = 502) {
    super(message);
  }
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,}$/;

export function getServers(): ZcoderServer[] {
  const raw = process.env.ZCODER_SERVERS_JSON;
  if (!raw) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("ZCODER_SERVERS_JSON is not valid JSON"); }
  if (!Array.isArray(value)) throw new Error("ZCODER_SERVERS_JSON must be an array");
  const ids = new Set<string>();

  return value.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`Server ${index + 1} is invalid`);
    const candidate = item as Partial<ZcoderServer>;
    if (!candidate.id || !ID_PATTERN.test(candidate.id)) throw new Error(`Server ${index + 1} has an invalid id`);
    if (ids.has(candidate.id)) throw new Error(`Duplicate server id: ${candidate.id}`);
    ids.add(candidate.id);
    if (!candidate.name || candidate.name.length > 80) throw new Error(`Server ${candidate.id} has an invalid name`);
    if (!candidate.token || !TOKEN_PATTERN.test(candidate.token)) throw new Error(`Server ${candidate.id} has an invalid token`);

    let url: URL;
    try { url = new URL(candidate.url ?? ""); } catch { throw new Error(`Server ${candidate.id} has an invalid URL`); }
    if (url.protocol !== "http:") throw new Error(`Server ${candidate.id} must use an http:// protocol-1 endpoint`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error(`Server ${candidate.id} URL must contain only scheme, host, and port`);
    }
    return { id: candidate.id, name: candidate.name, token: candidate.token, url: url.origin };
  });
}

export function findServer(id: string): ZcoderServer {
  const server = getServers().find((candidate) => candidate.id === id);
  if (!server) throw new ZcoderError("Configured server not found", 404);
  return server;
}

function isFlatJson(value: unknown): value is FlatJson {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.values(value as object).every((field) => field === null || ["string", "number", "boolean"].includes(typeof field));
}

export async function zcoderRequest(server: ZcoderServer, method: "GET" | "POST", path: string, body?: FlatJson): Promise<FlatJson> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${server.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${server.token}`, Accept: "application/json", "Content-Type": "application/json", Connection: "close" },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      cache: "no-store",
      signal: controller.signal,
    });
    const responseText = await readBoundedText(response, 2_000_000);
    let data: unknown;
    try { data = JSON.parse(responseText); } catch { throw new ZcoderError("Remote server returned malformed JSON"); }
    if (!isFlatJson(data)) throw new ZcoderError("Remote server returned a non-flat protocol response");
    if (!response.ok) throw new ZcoderError(typeof data.error === "string" ? data.error : `Remote request failed (${response.status})`, response.status);
    return data;
  } catch (error) {
    if (error instanceof ZcoderError) throw error;
    if (error instanceof BodyError) throw new ZcoderError(error.message, error.status);
    if (error instanceof Error && error.name === "AbortError") throw new ZcoderError("Remote server did not respond within 15 seconds", 504);
    throw new ZcoderError("Could not reach the remote zcoder server");
  } finally {
    clearTimeout(timeout);
  }
}

const SESSION_PAGE_LIMIT = 100;

export async function listSessions(server: ZcoderServer): Promise<FlatJson[]> {
  const sessions: FlatJson[] = [];
  let cursor = 0;
  for (let count = 0; count < 500; count += 1) {
    const item = await zcoderRequest(server, "GET", `/v1/sessions?after=${cursor}&limit=${SESSION_PAGE_LIMIT}`);
    if (item.event === "none") return sessions;
    if (item.event !== "session" || typeof item.seq !== "number" || item.seq <= cursor) throw new ZcoderError("Remote session cursor did not advance");
    sessions.push(item);
    cursor = item.seq;
  }
  throw new ZcoderError("Remote session list exceeded 500 items");
}

const TRANSCRIPT_PAGE_LIMIT = 500;

export async function loadTranscript(server: ZcoderServer, id: string): Promise<FlatJson[]> {
  if (!/^\d+_\d+$/.test(id)) throw new ZcoderError("Invalid session id", 400);
  const events: FlatJson[] = [];
  let cursor = 0;
  for (let count = 0; count < 10_000; count += 1) {
    const item = await zcoderRequest(server, "GET", `/v1/session?id=${id}&after=${cursor}&limit=${TRANSCRIPT_PAGE_LIMIT}`);
    if (item.event === "none") return events;
    if (item.event !== "message" || typeof item.seq !== "number" || item.seq <= cursor) throw new ZcoderError("Remote transcript cursor did not advance");
    events.push(item);
    cursor = item.seq;
  }
  throw new ZcoderError("Remote transcript exceeded 10,000 events");
}
