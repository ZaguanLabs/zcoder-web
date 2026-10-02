import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { getServers, listSessions, loadTranscript, zcoderRequest, ZcoderServer } from "@/lib/zcoder";

const token = "test-token-with-at-least-thirty-two-characters";
let server: Server;
let origin = "";
const seen: { authorization?: string; connection?: string; body?: string } = {};
const paths: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      seen.authorization = request.headers.authorization;
      seen.connection = request.headers.connection;
      seen.body = Buffer.concat(chunks).toString("utf8");
      const path = request.url ?? "/";
      paths.push(path);
      const url = new URL(path, origin);
      let payload: object;
      let status = 200;
      if (url.pathname === "/v1/hello") payload = { protocol: 1, server_name: "Test bench" };
      else if (url.pathname === "/v1/document") payload = { path: "docs/Design notes.md", text: "\u0001".repeat(262_144) };
      else if (url.pathname === "/v1/sessions" || url.pathname === "/v1/session") {
        // Protocol 1 parses the raw target: after must be the final parameter.
        // URLSearchParams alone would hide incompatible suffixes such as &limit=100.
        const match = url.pathname === "/v1/sessions"
          ? /^\/v1\/sessions\?after=([0-9]+)$/.exec(path)
          : /^\/v1\/session\?id=100_200&after=([0-9]+)$/.exec(path);
        if (!match) {
          status = url.pathname === "/v1/sessions" ? 400 : 404;
          payload = { error: status === 400 ? "after must be a non-negative integer" : "remote session does not exist" };
        } else {
          const cursor = Number(match[1]);
          payload = cursor >= 2 ? { event: "none" }
            : url.pathname === "/v1/sessions"
              ? { event: "session", seq: cursor + 1, id: `100_${200 + cursor}`, title: `Session ${cursor + 1}`, current: cursor === 0 ? 1 : 0, empty: 0 }
              : { event: "message", seq: cursor + 1, role: cursor === 0 ? "user" : "assistant", content: cursor === 0 ? "Hello" : "Hi" };
        }
      } else payload = { event: "none" };
      const body = JSON.stringify(payload);
      response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Connection: "close" });
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

function remote(): ZcoderServer {
  return { id: "test", name: "Test", url: origin, token };
}

describe("zcoder protocol gateway", () => {
  it("sends protocol authentication and connection-close framing", async () => {
    const hello = await zcoderRequest(remote(), "GET", "/v1/hello");
    expect(hello.protocol).toBe(1);
    expect(seen.authorization).toBe(`Bearer ${token}`);
    expect(seen.connection).toBe("close");
  });

  it("enumerates cursor-based sessions until none", async () => {
    paths.length = 0;
    const sessions = await listSessions(remote());
    expect(sessions.map((session) => session.id)).toEqual(["100_200", "100_201"]);
    expect(paths).toEqual(["/v1/sessions?after=0", "/v1/sessions?after=1", "/v1/sessions?after=2"]);
  });

  it("reads authenticated documents even when JSON escaping exceeds the source-file limit", async () => {
    const path = "docs/Design notes.md";
    const document = await zcoderRequest(remote(), "POST", "/v1/document", { path });
    expect(document).toEqual({ path, text: "\u0001".repeat(262_144) });
    expect(seen.authorization).toBe(`Bearer ${token}`);
    expect(seen.body).toBe(JSON.stringify({ path }));
  });

  it("loads the transcript with id first and the cursor last until none", async () => {
    paths.length = 0;
    const transcript = await loadTranscript(remote(), "100_200");
    expect(transcript.map((event) => event.content)).toEqual(["Hello", "Hi"]);
    expect(paths).toEqual([
      "/v1/session?id=100_200&after=0",
      "/v1/session?id=100_200&after=1",
      "/v1/session?id=100_200&after=2",
    ]);
  });

  it("keeps secrets in the server-only configuration object", () => {
    process.env.ZCODER_SERVERS_JSON = JSON.stringify([{ id: "bench", name: "Bench", url: origin, token }]);
    expect(getServers()).toEqual([{ id: "bench", name: "Bench", url: origin, token }]);
  });

  it("rejects HTTPS because native protocol 1 is HTTP-only", () => {
    process.env.ZCODER_SERVERS_JSON = JSON.stringify([{ id: "bench", name: "Bench", url: "https://example.test", token }]);
    expect(() => getServers()).toThrow(/http:\/\//);
  });
});
