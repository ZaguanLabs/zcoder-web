import { describe, expect, it } from "vitest";
import { eventRetryDelayMs, isTransientRpcError, readRpcJson, RpcResponseError } from "./client-rpc";

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

describe("eventRetryDelayMs", () => {
  it("climbs and then holds, so the attempts outlast an upstream restart", () => {
    const ladder = Array.from({ length: 8 }, (_, attempt) => eventRetryDelayMs(attempt));

    expect(ladder).toEqual([250, 500, 1_000, 2_000, 4_000, 4_000, 4_000, 4_000]);
    // A zcoder restart holds the upstream down for roughly fifteen seconds.
    expect(ladder.reduce((total, delay) => total + delay, 0)).toBeGreaterThan(15_000);
  });

  it("clamps attempt counts outside the ladder", () => {
    expect(eventRetryDelayMs(-1)).toBe(250);
    expect(eventRetryDelayMs(99)).toBe(4_000);
  });
});
