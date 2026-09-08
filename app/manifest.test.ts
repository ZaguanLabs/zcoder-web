import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";

describe("web app manifest", () => {
  it("is installable and provides regular and maskable icons", () => {
    const value = manifest();

    expect(value).toMatchObject({
      id: "/",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#1e1e1e",
      theme_color: "#1e1e1e",
    });
    expect(value.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ sizes: "192x192", purpose: "any" }),
      expect.objectContaining({ sizes: "512x512", purpose: "any" }),
      expect.objectContaining({ sizes: "512x512", purpose: "maskable" }),
    ]));
  });
});
