import { describe, expect, it } from "vitest";
import { isTransientRpcError, readRpcJson, RpcResponseError } from "./client-rpc";

describe("readRpcJson", () => {
  it("reads successful JSON responses", async () => {
    await expect(readRpcJson(Response.json({ ok: true }))).resolves.toEqual({ ok: true });
  });

  it("preserves JSON error messages", async () => {
    await expect(readRpcJson(Response.json({ error: "Authentication required" }, { status: 401 })))
      .rejects.toMatchObject({ message: "Authentication required", retryable: false });
  });

  it("turns a gateway HTML response into a retryable restart error", async () => {
    const response = new Response("<h1>Service Unavailable</h1>", { status: 503, headers: { "Content-Type": "text/html" } });

    await expect(readRpcJson(response))
      .rejects.toMatchObject({ message: "Service temporarily unavailable during restart", retryable: true });
  });

  it("reports malformed successful responses without exposing JSON parser internals", async () => {
    await expect(readRpcJson(new Response("not json")))
      .rejects.toMatchObject({ message: "Server returned an invalid response", retryable: false });
  });
});

describe("isTransientRpcError", () => {
  it("retries fetch failures and explicitly retryable responses", () => {
    expect(isTransientRpcError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransientRpcError(new RpcResponseError("Unavailable", true))).toBe(true);
    expect(isTransientRpcError(new RpcResponseError("Unauthorized"))).toBe(false);
  });
});
