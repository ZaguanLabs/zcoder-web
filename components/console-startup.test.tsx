// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsoleApp } from "@/components/console-app";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));

describe("console startup", () => {
  let container: HTMLDivElement;
  let root: Root;
  let requests: Record<string, unknown>[];
  let metadata: Record<string, unknown>;
  let create: () => Response | Promise<Response>;
  let list: () => Response | Promise<Response>;
  let turnId: string;
  const history = [{ id: "100_200", title: "Previous conversation", current: 1 }];

  beforeEach(() => {
    requests = [];
    turnId = "";
    metadata = { protocol: 1, sessions: true, model: "Test", profile: "coding" };
    create = () => Response.json({ id: "100_201" });
    list = () => Response.json(history);
    sessionStorage.clear();
    localStorage.clear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/servers") return Response.json([{ id: "test", name: "Test" }]);
      const body = JSON.parse(String(options?.body));
      requests.push(body);
      switch (body.action) {
        case "hello": return Response.json(metadata);
        case "session.new": return create();
        case "sessions.list": return list();
        case "session.select": return Response.json({ ok: true });
        case "session.load": return Response.json([{ event: "message", seq: 1, role: "user", content: "Existing message", thinking: "" }]);
        case "input.list": return Response.json({ turn_id: turnId, pending: "" });
        case "events.next": return new Promise<Response>((_, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
        default: throw new Error(`Unexpected action: ${body.action}`);
      }
    }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function mount() {
    await act(async () => root.render(<ConsoleApp />));
  }

  function sendButton() {
    return container.querySelector<HTMLButtonElement>(".send-button")!;
  }

  it("keeps sending disabled until creation is acknowledged", async () => {
    let resolveCreate!: (response: Response) => void;
    create = () => new Promise<Response>((resolve) => { resolveCreate = resolve; });
    await mount();
    expect(sendButton().disabled).toBe(true);
    expect(requests.some((request) => request.action === "sessions.list")).toBe(false);
    await act(async () => resolveCreate(Response.json({ id: "100_201" })));
    expect(sendButton().disabled).toBe(false);
  });

  it("readies a fresh conversation before history arrives, then opens saved sessions only on selection", async () => {
    metadata.input_queue = true;
    let resolveList!: (response: Response) => void;
    list = () => new Promise<Response>((resolve) => { resolveList = resolve; });
    await mount();

    expect(requests.filter((request) => request.action === "session.new")).toHaveLength(1);
    expect(requests).toContainEqual({ action: "input.list", session_id: "100_201" });
    expect(requests.some((request) => request.action === "session.load")).toBe(false);
    expect(sendButton().disabled).toBe(false);
    expect(container.textContent).toContain("Loading sessions…");

    list = () => Response.json(history);
    await act(async () => resolveList(Response.json(history)));
    expect(requests.some((request) => request.action === "session.load")).toBe(false);
    expect(container.textContent).toContain("Agent transcript (0 events)");

    await act(async () => container.querySelector<HTMLButtonElement>(".session-pane nav button")!.click());
    expect(requests).toContainEqual({ action: "session.select", id: "100_200" });
    expect(requests).toContainEqual({ action: "session.load", id: "100_200" });
    expect(container.textContent).toContain("Agent transcript (1 events)");
  });

  it("reconnects to the current conversation without creating another", async () => {
    list = () => Response.json({ error: "History unavailable" }, { status: 502 });
    await mount();
    expect(sendButton().disabled).toBe(false);
    list = () => Response.json(history);
    const reconnect = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Reconnect")!;
    await act(async () => reconnect.click());
    expect(requests.filter((request) => request.action === "session.new")).toHaveLength(1);
    expect(requests).toContainEqual({ action: "session.load", id: "100_200" });
    expect(sendButton().disabled).toBe(false);
  });

  it("reattaches to an active run when new-session creation returns a conflict", async () => {
    metadata.input_queue = true;
    turnId = "running-turn";
    create = () => Response.json({ error: "cannot create a session while a remote turn is running" }, { status: 409 });
    await mount();
    expect(requests).toContainEqual({ action: "session.load", id: "100_200" });
    expect(requests).toContainEqual({ action: "input.list", session_id: "100_200" });
    expect(requests).toContainEqual({ action: "events.next", after: 0 });
    expect(container.querySelector(".error-strip")).toBeNull();
    expect(sendButton().textContent).toContain("Stop");
  });

  it.each(["failure", "invalid receipt"])("blocks sending to the previous conversation after a creation %s", async (kind) => {
    create = () => kind === "failure"
      ? Response.json({ error: "Could not create session" }, { status: 500 })
      : Response.json({ id: "" });
    await mount();
    expect(sendButton().disabled).toBe(true);
    expect(container.querySelector(".error-strip")).not.toBeNull();
    expect(requests.some((request) => ["sessions.list", "session.load", "turn.start"].includes(String(request.action)))).toBe(false);
  });

  it("keeps legacy servers without saved sessions usable", async () => {
    metadata.sessions = false;
    await mount();
    expect(requests.map((request) => request.action)).toEqual(["hello"]);
    expect(sendButton().disabled).toBe(false);
  });

  it("creates only one conversation under Strict Mode", async () => {
    await act(async () => root.render(<StrictMode><ConsoleApp /></StrictMode>));
    expect(requests.filter((request) => request.action === "session.new")).toHaveLength(1);
    expect(sendButton().disabled).toBe(false);
  });
});
