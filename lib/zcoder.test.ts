import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { getServers, listSessions, zcoderRequest, ZcoderServer } from "@/lib/zcoder";

const token = "test-token-with-at-least-thirty-two-characters";
let server: Server;
let origin = "";
const seen: { authorization?: string; connection?: string; body?: string } = {};

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      seen.authorization = request.headers.authorization;
      seen.connection = request.headers.connection;
      seen.body = Buffer.concat(chunks).toString("utf8");
      const url = new URL(request.url ?? "/", origin);
      let payload: object;
      if (url.pathname === "/v1/hello") payload = { protocol: 1, server_name: "Test bench" };
      else if (url.pathname === "/v1/sessions" && url.searchParams.get("after") === "0") {
        payload = { event: "session", seq: 1, id: "100_200", title: "One", current: 1, empty: 0 };
      } else payload = { event: "none" };
      const body = JSON.stringify(payload);
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Connection: "close" });
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
    const sessions = await listSessions(remote());
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("100_200");
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

