// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentReader } from "./document-reader";

vi.mock("next/dynamic", () => ({ default: () => ({ children }: { children: string }) => <pre>{children}</pre> }));

describe("remote document reader", () => {
  let container: HTMLDivElement;
  let root: Root;
  const rpc = vi.fn();
  const reading = vi.fn();
  const focus = vi.fn();
  const props = { serverId: "one", supported: true, available: true, approvalPending: false, rpc, onReadingChange: reading, onCodingFocus: focus };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(changes: Partial<typeof props> = {}) {
    await act(async () => root.render(<DocumentReader key={changes.serverId ?? "one"} {...props} {...changes}><textarea defaultValue="unsent draft" /><p>Transcript</p></DocumentReader>));
  }
  function button(label: string) {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.getAttribute("aria-label") === label || item.textContent === label);
    if (!button) throw new Error(`Missing button ${label}`);
    return button;
  }
  async function click(label: string) { await act(async () => button(label).click()); }
  async function open(path: string) {
    if (!container.querySelector("form")) await click("Open document");
    await act(async () => {
      const input = container.querySelector("input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, path);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  }

  it("gates unsupported servers without sending a read", async () => {
    await render({ supported: false });
    await click("Open document");
    expect(container.textContent).toContain("Update the zcoder server");
    expect(container.querySelector("input")).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("uses canonical identity, preserves drafts and scroll positions, and reloads explicitly", async () => {
    await render();
    rpc.mockResolvedValue({ path: "docs/Design notes.md", text: "# Å\n\n**bold**\n\n" });
    await open("/workspace/link.md");
    expect(rpc).toHaveBeenLastCalledWith("one", { action: "document.read", path: "/workspace/link.md" }, expect.any(AbortSignal));
    const panel = container.querySelector<HTMLElement>(".document-view")!;
    panel.scrollTop = 250;
    await click("Coding");
    expect(focus).toHaveBeenCalled();
    expect(container.querySelector("textarea")!.value).toBe("unsent draft");
    await open("docs/Design notes.md");
    expect(container.querySelectorAll(".document-view")).toHaveLength(1);
    expect(container.querySelector(".document-view")).toBe(panel);
    expect(panel.scrollTop).toBe(250);
    expect(panel.textContent).toContain("# Å\n\n**bold**\n\n");
    rpc.mockResolvedValueOnce({ path: "docs/Design notes.md", text: "updated" });
    await click("Reload");
    expect(panel.textContent).toContain("updated");
    await click("Close docs/Design notes.md");
    expect(container.querySelector(".document-tabs")).toBeNull();
    expect(container.querySelector<HTMLElement>(".coding-view")!.hidden).toBe(false);
  });

  it.each([new Error("outside workspace"), { path: "a.md", text: 12 }, { path: "", text: "replacement" }])("preserves the loaded view and draft on read failure: %j", async (failure) => {
    await render();
    rpc.mockResolvedValueOnce({ path: "a.md", text: "old contents" });
    await open("a.md");
    if (failure instanceof Error) rpc.mockRejectedValueOnce(failure);
    else rpc.mockResolvedValueOnce(failure);
    await click("Reload");
    expect(container.querySelector(".document-view")?.textContent).toContain("old contents");
    expect(container.querySelector("textarea")!.value).toBe("unsent draft");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("limits tabs to four but permits reopening a canonical alias at capacity", async () => {
    await render();
    for (const path of ["a.md", "b.md", "c.md", "d.md", "e.md"]) {
      rpc.mockResolvedValueOnce({ path, text: "" });
      await open(path);
    }
    expect(container.querySelectorAll(".document-view")).toHaveLength(4);
    expect(container.textContent).toContain("Four documents can be open");
    rpc.mockResolvedValueOnce({ path: "a.md", text: "" });
    await open("alias.md");
    expect(container.querySelectorAll(".document-view")).toHaveLength(4);
    expect(container.querySelector<HTMLElement>('.document-view[aria-label="a.md"]')!.hidden).toBe(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await click("Close b.md");
    rpc.mockResolvedValueOnce({ path: "e.md", text: "" });
    await open("e.md");
    expect(container.querySelectorAll(".document-view")).toHaveLength(4);
  });

  it("keeps the reader inert for approvals and prevents reads while offline", async () => {
    await render();
    rpc.mockResolvedValueOnce({ path: "a.md", text: "read only" });
    await open("a.md");
    await render({ approvalPending: true });
    expect(container.querySelector(".document-reader")!.hasAttribute("inert")).toBe(true);
    expect(button("Reload").disabled).toBe(true);
    await render({ available: false });
    await click("Reload");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("aborts pending reads and clears tabs on server switch", async () => {
    await render();
    let resolve!: (value: unknown) => void;
    rpc.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await open("a.md");
    const signal = rpc.mock.calls[0][2] as AbortSignal;
    await render({ serverId: "two" });
    expect(signal.aborted).toBe(true);
    await act(async () => resolve({ path: "a.md", text: "old server" }));
    expect(container.querySelector(".document-view")).toBeNull();
    expect(container.textContent).not.toContain("old server");
    expect(reading).toHaveBeenLastCalledWith(false);
  });
});
