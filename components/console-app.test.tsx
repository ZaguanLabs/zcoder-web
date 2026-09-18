// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsoleApp } from "@/components/console-app";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));

describe("console keyboard controls", () => {
  let container: HTMLDivElement;
  let root: Root;
  let mobile: boolean;
  let compact: boolean;
  let mediaListeners: Set<() => void>;
  let requests: Record<string, unknown>[];
  let resolveApproval: (response: Response) => void;

  beforeEach(async () => {
    mobile = false;
    compact = false;
    mediaListeners = new Set();
    requests = [];
    sessionStorage.clear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() { return query.includes("max-height") ? compact : mobile; },
      addEventListener: (_type: string, listener: () => void) => mediaListeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => mediaListeners.delete(listener),
    }));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let approvalEmitted = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/servers") return Response.json([{ id: "test", name: "Test" }]);
      const body = JSON.parse(String(options?.body));
      requests.push(body);
      switch (body.action) {
        case "hello": return Response.json({ protocol: 1, sessions: true, model: "Test", profile: "coding" });
        case "session.new": return Response.json({ id: "session-2" });
        case "sessions.list": return Response.json([{ id: "session-2", title: "Test session", current: 1 }]);
        case "turn.start": return Response.json({ turn_id: "turn-1" });
        case "events.next":
          if (!approvalEmitted) {
            approvalEmitted = true;
            return Response.json({ event: "approval_required", seq: 1, id: "approval-1", command: "echo test" });
          }
          return new Promise<Response>(() => {});
        case "approval": return new Promise<Response>((resolve) => { resolveApproval = resolve; });
        case "cancel": return Response.json({});
        default: throw new Error(`Unexpected action: ${body.action}`);
      }
    }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<ConsoleApp />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function button(label: string) {
    const result = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!result) throw new Error(`Missing button: ${label}`);
    return result;
  }

  async function press(key: string, options: KeyboardEventInit = {}, target: EventTarget = window) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
    await act(async () => { target.dispatchEvent(event); });
    return event;
  }

  async function requestCommandApproval() {
    await press("x", {}, document.body);
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(container.querySelector(".approval-bar code")?.textContent).toBe("echo test");
  }

  it("toggles the desktop sidebar with its button and Ctrl+B, including from the prompt", async () => {
    expect(button("Hide sidebar").getAttribute("aria-expanded")).toBe("true");
    await act(async () => button("Hide sidebar").click());
    expect(container.querySelector(".workbench")?.classList.contains("sidebar-hidden")).toBe(true);
    const prompt = container.querySelector("textarea")!;
    prompt.focus();
    const event = await press("b", { ctrlKey: true }, prompt);
    expect(event.defaultPrevented).toBe(true);
    expect(button("Hide sidebar").getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(prompt);
    await press("b", { ctrlKey: true, repeat: true }, prompt);
    expect(button("Hide sidebar").getAttribute("aria-expanded")).toBe("true");
  });

  it("moves focus out of the sidebar when hiding it", async () => {
    const sessionButton = container.querySelector<HTMLButtonElement>(".session-pane nav button")!;
    sessionButton.focus();
    await press("b", { ctrlKey: true }, sessionButton);
    expect(document.activeElement).toBe(button("Show sidebar"));
  });

  it("toggles the mobile drawer independently of desktop visibility", async () => {
    await press("b", { ctrlKey: true });
    mobile = true;
    await press("b", { ctrlKey: true });
    expect(container.querySelector(".session-pane")?.classList.contains("mobile-open")).toBe(true);
    expect(container.querySelector(".mobile-session-trigger")?.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(container.querySelector(".drawer-close"));
    expect(container.querySelector(".mobile-session-trigger")?.textContent).toContain("Sessions");
    expect(container.querySelector("#session-drawer-title")?.textContent).toContain("Sessions");
    await act(async () => container.querySelector<HTMLButtonElement>(".mobile-session-trigger")!.click());
    expect(container.querySelector(".session-pane")?.classList.contains("mobile-open")).toBe(false);
    expect(container.querySelector(".workbench")?.classList.contains("sidebar-hidden")).toBe(true);
    expect(document.activeElement).toBe(container.querySelector(".mobile-session-trigger"));
  });

  it("shows the selected session beside the transcript heading", () => {
    expect(container.querySelector("#transcript-title")?.textContent).toContain("Test session");
    expect(container.querySelector("#transcript-title")?.getAttribute("aria-label")).toContain("session Test session");
  });

  it("discloses secondary server facts in a short mobile drawer", async () => {
    mobile = true;
    compact = true;
    await act(async () => mediaListeners.forEach((listener) => listener()));
    await press("b", { ctrlKey: true });

    const facts = container.querySelector<HTMLDListElement>(".server-facts")!;
    const toggle = container.querySelector<HTMLButtonElement>(".server-details-toggle")!;
    expect(facts.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await act(async () => toggle.click());
    expect(facts.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps keyboard focus inside the mobile drawer and closes it before stopping a run", async () => {
    await requestCommandApproval();
    mobile = true;
    await press("b", { ctrlKey: true });
    const close = container.querySelector<HTMLButtonElement>(".drawer-close")!;
    expect(document.activeElement).toBe(close);

    const drawer = container.querySelector<HTMLElement>(".session-pane")!;
    const controls = Array.from(drawer.querySelectorAll<HTMLElement>("button:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])"));
    const last = controls.at(-1)!;
    last.focus();
    const tab = await press("Tab", {}, last);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);

    const escape = await press("Escape", {}, close);
    expect(escape.defaultPrevented).toBe(true);
    expect(drawer.classList.contains("mobile-open")).toBe(false);
    expect(document.activeElement).toBe(container.querySelector(".mobile-session-trigger"));
    expect(requests.filter((request) => request.action === "cancel")).toHaveLength(0);

    await press("Escape");
    expect(requests.filter((request) => request.action === "cancel")).toHaveLength(1);
  });

  it("preserves transcript position when new activity arrives away from the live edge", async () => {
    await requestCommandApproval();
    const transcript = container.querySelector<HTMLDivElement>(".transcript")!;
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 300 },
    });
    transcript.scrollTop = 100;
    await act(async () => transcript.dispatchEvent(new Event("scroll", { bubbles: true })));

    const allow = Array.from(container.querySelectorAll<HTMLButtonElement>(".approval-actions button"))
      .find((element) => element.textContent?.startsWith("Allow once"))!;
    await act(async () => allow.click());
    await act(async () => resolveApproval(Response.json({})));

    expect(transcript.scrollTop).toBe(100);
    const jump = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((element) => element.textContent === "Jump to latest activity")!;
    expect(jump).toBeDefined();
    await act(async () => jump.click());
    expect(transcript.scrollTop).toBe(1_000);
    expect(container.textContent).not.toContain("Jump to latest activity");
  });

  it.each([ ["y", "Allow once"], ["n", "Deny"] ])("sends one %s decision despite repeated shortcuts and clicks", async (key, label) => {
    await requestCommandApproval();
    await press("d", {}, document.body);
    const prompt = container.querySelector("textarea")!;
    const decisionButton = Array.from(container.querySelectorAll(".approval-actions button"))
      .find((element) => element.textContent?.startsWith(label)) as HTMLButtonElement;
    await press(key, { altKey: true, repeat: true }, prompt);
    expect(requests.filter((request) => request.action === "approval")).toHaveLength(0);
    await press(key, { altKey: true }, prompt);
    await press(key, { altKey: true }, prompt);
    await act(async () => decisionButton.click());
    expect(requests.filter((request) => request.action === "approval")).toEqual([
      { action: "approval", id: "approval-1", decision: key },
    ]);
    expect(decisionButton.disabled).toBe(true);
    expect(prompt.value).toBe("d");
    await act(async () => resolveApproval(Response.json({})));
    expect(container.querySelector(".approval-bar")).toBeNull();
    await press(key, { altKey: true }, prompt);
    expect(requests.filter((request) => request.action === "approval")).toHaveLength(1);
  });

  it("ignores plain typing, composition, extra modifiers, and handled events for approval", async () => {
    await requestCommandApproval();
    await press("y", {}, document.body);
    await press("n", {}, document.body);
    await press("y", { altKey: true, isComposing: true });
    await press("y", { altKey: true, ctrlKey: true });
    await press("y", { altKey: true, shiftKey: true });
    await press("y", { altKey: true, metaKey: true });
    const event = new KeyboardEvent("keydown", { key: "y", altKey: true, cancelable: true });
    event.preventDefault();
    await act(async () => { window.dispatchEvent(event); });
    expect(container.querySelector("textarea")?.value).toBe("yn");
    expect(requests.filter((request) => request.action === "approval")).toHaveLength(0);
  });
});
