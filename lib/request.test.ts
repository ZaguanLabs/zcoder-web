import { describe, expect, it } from "vitest";
import { readBoundedForm, readBoundedJson } from "@/lib/request";

describe("bounded JSON requests", () => {
  it("parses a body within the limit", async () => {
    const request = new Request("http://localhost/test", { method: "POST", body: JSON.stringify({ ok: true }) });
    await expect(readBoundedJson(request, 100)).resolves.toEqual({ ok: true });
  });

  it("rejects streamed bodies that exceed the limit", async () => {
    const request = new Request("http://localhost/test", { method: "POST", body: "x".repeat(101) });
    await expect(readBoundedJson(request, 100)).rejects.toMatchObject({ status: 413 });
  });

  it("parses a native form submission without putting fields in the URL", async () => {
    const request = new Request("http://localhost/test", { method: "POST", body: new URLSearchParams({ username: "operator", password: "secret" }) });
    await expect(readBoundedForm(request, 100)).resolves.toEqual({ username: "operator", password: "secret" });
  });
});
