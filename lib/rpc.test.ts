import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRpc } from "./rpc";
import { zcoderRequest, type FlatJson } from "./zcoder";
vi.mock("./zcoder", async (original) => ({ ...await original<typeof import("./zcoder")>(), zcoderRequest: vi.fn() }));
const server = { id: "test", name: "Test", url: "http://127.0.0.1:7337", token: "test-token" };
beforeEach(() => vi.clearAllMocks());

describe("document RPC allowlist", () => {
  it.each(["docs/Design notes.md", "/workspace/docs/Design notes.md", "docs/λ.markdown"])("forwards the literal path %s and preserves Markdown", async (path) => {
    const result = { path: "docs/Design notes.md", text: "# Å\n\n**bold**\n\n" };
    vi.mocked(zcoderRequest).mockResolvedValueOnce(result);
    expect(await runRpc(server, { action: "document.read", path, text: "do not write", url: "/evil" })).toEqual(result);
    expect(zcoderRequest).toHaveBeenCalledExactlyOnceWith(server, "POST", "/v1/document", { path });
  });
  it.each([undefined, null, 1, "", "bad\0.md"])("rejects invalid document paths: %j", async (path) => {
    await expect(runRpc(server, { action: "document.read", path })).rejects.toMatchObject({ status: 400 });
    expect(zcoderRequest).not.toHaveBeenCalled();
  });
  it.each<FlatJson>([{ path: "", text: "old" }, { path: "a.md" }, { path: 1, text: "old" }, { path: "a.md", text: false }])("rejects malformed upstream documents: %j", async (result) => {
    vi.mocked(zcoderRequest).mockResolvedValueOnce(result);
    await expect(runRpc(server, { action: "document.read", path: "a.md" })).rejects.toMatchObject({ status: 502 });
  });
  it("accepts empty documents", async () => {
    vi.mocked(zcoderRequest).mockResolvedValueOnce({ path: "empty.md", text: "" });
    expect(await runRpc(server, { action: "document.read", path: "empty.md" })).toEqual({ path: "empty.md", text: "" });
  });
});

describe("queue RPC allowlist", () => {
  it("forwards exact flat input to /v1/input without changing whitespace", async () => {
    const request = { session_id: "100_200", turn_id: "300_400", message_id: "web-id", mode: "follow_up", text: "å\nline\n\n" };
    await runRpc(server, { action: "input.submit", ...request, path: "/evil" });
    expect(zcoderRequest).toHaveBeenCalledExactlyOnceWith(server, "POST", "/v1/input", request);
  });
  it.each(["status", "drop"])("forwards input.%s by session and message ID", async (action) => {
    const request = { session_id: "100_200", message_id: "web-id" };
    await runRpc(server, { action: `input.${action}`, ...request });
    expect(zcoderRequest).toHaveBeenCalledExactlyOnceWith(server, "POST", `/v1/input/${action}`, request);
  });
  it("forwards listing by session and leaves display text intact", async () => {
    const listing = { turn_id: "", pending: "[id] steer: a\n[fake] follow_up: b\n" };
    vi.mocked(zcoderRequest).mockResolvedValueOnce(listing);
    expect(await runRpc(server, { action: "input.list", session_id: "100_200" })).toEqual(listing);
    expect(zcoderRequest).toHaveBeenCalledExactlyOnceWith(server, "POST", "/v1/input/list", { session_id: "100_200" });
  });
  it.each([{ message_id: "bad.id" }, { text: "😀".repeat(16_385) }, { text: 12 }, { mode: "invalid" }, { turn_id: "" }])("rejects invalid input before forwarding: %j", async (change) => {
    await expect(runRpc(server, { action: "input.submit", session_id: "100_200", turn_id: "run", message_id: "id", mode: "steer", text: "hello", ...change })).rejects.toMatchObject({ status: 400 });
    expect(zcoderRequest).not.toHaveBeenCalled();
  });
  it("preserves upstream conflict details", async () => {
    vi.mocked(zcoderRequest).mockRejectedValueOnce(new Error("run closed"));
    await expect(runRpc(server, { action: "input.drop", session_id: "100_200", message_id: "id" })).rejects.toThrow("run closed");
  });
});

describe("cancellation RPC allowlist", () => {
  it("forwards a scoped queued-continuation request", async () => {
    const request = { session_id: "100_200", turn_id: "300_400", continue_queued: true };
    await runRpc(server, { action: "cancel", ...request });
    expect(zcoderRequest).toHaveBeenCalledExactlyOnceWith(server, "POST", "/v1/cancel", request);
  });

  it("retains ordinary cancellation without a scope", async () => {
    await runRpc(server, { action: "cancel" });
    expect(zcoderRequest).toHaveBeenCalledExactlyOnceWith(server, "POST", "/v1/cancel", {});
  });

  it.each([
    { session_id: "100_200", turn_id: "", continue_queued: true },
    { session_id: "", turn_id: "300_400", continue_queued: true },
    { session_id: "100_200", turn_id: "300_400", continue_queued: "true" },
  ])("rejects an invalid scoped cancellation: %j", async (request) => {
    await expect(runRpc(server, { action: "cancel", ...request })).rejects.toMatchObject({ status: 400 });
    expect(zcoderRequest).not.toHaveBeenCalled();
  });
});
