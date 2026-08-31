import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const serviceWorkerPath = new URL("../public/sw.js", import.meta.url);

describe("service worker security boundary", () => {
  it("never caches API traffic, mutations, or navigated application pages", async () => {
    const source = await readFile(serviceWorkerPath, "utf8");

    expect(source).toContain('request.method !== "GET"');
    expect(source).toContain('url.pathname.startsWith("/api/")');
    expect(source).toContain('fetch(request, { cache: "no-store" })');

    const start = source.indexOf("const PRECACHE");
    const precache = source.slice(start, source.indexOf("];", start) + 2);
    expect(precache).not.toContain('"/"');
    expect(precache).not.toContain("/login");
    expect(precache).not.toContain("/api/");
  });
});
