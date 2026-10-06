// @vitest-environment jsdom

import { act, StrictMode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsoleApp } from "@/components/console-app";
import { queueStorageKey, type InputRecord } from "@/lib/input-queue";

const navigation = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
const renderCounts = vi.hoisted(() => ({ documentReader: 0 }));
vi.mock("@/components/document-reader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/document-reader")>();
  return {
    ...actual,
    DocumentReader: (props: ComponentProps<typeof actual.DocumentReader>) => {
      renderCounts.documentReader += 1;
      return <actual.DocumentReader {...props} />;
    },
  };
});

describe("console startup", () => {
  let container: HTMLDivElement;
  let root: Root;
  let requests: Record<string, unknown>[];
  let metadata: Record<string, unknown>;
  let create: () => Response | Promise<Response>;
  let list: () => Response | Promise<Response>;
  let transcript: Record<string, unknown>[];
  let turnId: string;
  let receipts: Record<string, string>;
  let pending: string;
  let submitInput: (body: Record<string, unknown>) => Response | Promise<Response>;
  const history = [{ id: "100_200", title: "Previous conversation", current: 1 }];

  beforeEach(() => {
    requests = [];
    navigation.replace.mockReset();
    navigation.refresh.mockReset();
    turnId = "";
    receipts = {};
    pending = "";
    submitInput = (body) => Response.json({ message_id: body.message_id, state: "accepted" });
    metadata = { protocol: 1, sessions: true, model: "Test", profile: "coding" };
    create = () => Response.json({ id: "100_201" });
    list = () => Response.json(history);
    transcript = [{ event: "message", seq: 1, role: "user", content: "Existing message", thinking: "" }];
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
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
        case "session.load": return Response.json(transcript);
        case "input.list": return Response.json({ turn_id: turnId, pending });
        case "input.status": return receipts[String(body.message_id)]
          ? Response.json({ message_id: body.message_id, state: receipts[String(body.message_id)] })
          : Response.json({ error: "Could not confirm delivery" }, { status: 503 });
        case "input.submit":
          receipts[String(body.message_id)] = "accepted";
          return submitInput(body);
        case "input.drop":
          receipts[String(body.message_id)] = "discarded";
          return Response.json({ message_id: body.message_id, state: "discarded" });
        case "cancel": return Response.json({ ok: true, continued: true });
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

  function saveQueue(states: InputRecord["state"][]) {
    metadata.input_queue = true;
    const records = states.map((state, index) => ({
      request: { session_id: "100_201", turn_id: "turn-1", message_id: `message-${index}`, mode: "steer", text: `Queued message ${index}` },
      state,
    }));
    localStorage.setItem(queueStorageKey("test", "100_201"), JSON.stringify(records));
    return records;
  }

  it("shows pending messages inline and removes them once consumed", async () => {
    turnId = "turn-1";
    saveQueue(["consumed", "discarded", "accepted"]);
    receipts["message-2"] = "accepted";
    await mount();

    const queue = container.querySelector(".transcript .queued-messages")!;
    expect(container.querySelector(".prompt-box .queued-messages")).toBeNull();
    expect(container.querySelector(".queue-panel")).toBeNull();
    expect(queue.querySelectorAll(".message-queued")).toHaveLength(1);
    expect(queue.textContent).toContain("Queued message 2");
    expect(queue.querySelector(".queued-status")?.textContent).toContain("Queued");
    expect(queue.textContent).not.toContain("Queued message 0");
    expect(queue.textContent).not.toContain("Queued message 1");

    receipts["message-2"] = "consumed";
    const refresh = Array.from(queue.querySelectorAll("button")).find((button) => button.textContent === "Refresh queue")!;
    await act(async () => refresh.click());
    expect(container.querySelector(".message-queued")).toBeNull();
  });

  it("shows delivery problems beside their message with recovery controls", async () => {
    turnId = "turn-1";
    saveQueue(["consumed", "uncertain", "rejected"]);
    await mount();
    const prompt = container.querySelector<HTMLTextAreaElement>("#prompt")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "Another message");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(sendButton().disabled).toBe(true);

    const queue = container.querySelector(".transcript .queued-messages")!;
    expect(queue.textContent).not.toContain("Queued message 0");
    expect(queue.textContent).toContain("Unconfirmed");
    expect(queue.textContent).toContain("Rejected");
    expect(queue.textContent).toContain("Could not confirm delivery");
    expect(queue.textContent).toContain("Retry exact submission");
    expect(queue.querySelector('[aria-label="Remove queued message"]')).not.toBeNull();
    expect(queue.textContent).toContain("Dismiss");
  });

  it("keeps server-only pending input reachable without inventing local messages", async () => {
    metadata.input_queue = true;
    pending = "A message queued from another client";
    await mount();

    const queue = container.querySelector(".transcript .queued-messages")!;
    expect(queue.querySelectorAll(".message-queued")).toHaveLength(0);
    expect(queue.textContent).toContain(pending);
    expect(queue.textContent).toContain("Resume pending input");
  });

  it("queues a follow-up on the active run and removes it by its receipt ID", async () => {
    metadata.input_queue = true;
    turnId = "running-turn";
    create = () => Response.json({ error: "active run" }, { status: 409 });
    await mount();
    const prompt = container.querySelector<HTMLTextAreaElement>("#prompt")!;
    const mode = container.querySelector<HTMLSelectElement>('[aria-label="Queued input mode"]')!;
    await act(async () => {
      mode.value = "follow_up";
      mode.dispatchEvent(new Event("change", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "Do this next\nwith exact text");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector("form.prompt-box")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    const submitted = requests.find((request) => request.action === "input.submit")!;
    expect(submitted).toMatchObject({ session_id: "100_200", turn_id: "running-turn", mode: "follow_up", text: "Do this next\nwith exact text" });
    expect(prompt.value).toBe("");
    const queued = container.querySelector(".transcript .message-queued")!;
    expect(queued.querySelector(".queued-status")?.textContent).toBe("Queued");
    await act(async () => queued.querySelector<HTMLButtonElement>('[aria-label="Remove queued message"]')!.click());
    expect(requests).toContainEqual({ action: "input.drop", session_id: "100_200", message_id: submitted.message_id });
    expect(container.querySelector(".message-queued")).toBeNull();
  });

  it("keeps draft edits out of the transcript's render path", async () => {
    await mount();
    const initialRenders = renderCounts.documentReader;
    const prompt = container.querySelector<HTMLTextAreaElement>("#prompt")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "A draft");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(prompt.value).toBe("A draft");
    expect(renderCounts.documentReader).toBe(initialRenders);
  });

  it("preserves a newer draft when a queued submission is acknowledged", async () => {
    metadata.input_queue = true;
    turnId = "running-turn";
    create = () => Response.json({ error: "active run" }, { status: 409 });
    let acknowledge!: (response: Response) => void;
    submitInput = () => new Promise<Response>((resolve) => { acknowledge = resolve; });
    await mount();
    const prompt = container.querySelector<HTMLTextAreaElement>("#prompt")!;
    const setDraft = async (text: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, text);
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await setDraft("First draft");
    await act(async () => container.querySelector("form.prompt-box")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(sendButton().disabled).toBe(true);
    await setDraft("Next draft");
    const submitted = requests.find((request) => request.action === "input.submit")!;
    await act(async () => acknowledge(Response.json({ message_id: submitted.message_id, state: "accepted" })));
    expect(prompt.value).toBe("Next draft");
    expect(container.querySelector(".queued-content")?.textContent).toBe("First draft");
  });

  it("mounts tool output only when expanded and preserves transcript position", async () => {
    transcript = [{ event: "message", seq: 2, role: "tool", tool_name: "run_command", content: "\u001b[32mResult\u001b[0m\n" + "output\n".repeat(500), thinking: "" }];
    await mount();
    await act(async () => container.querySelector<HTMLButtonElement>(".session-pane nav button")!.click());
    const transcriptElement = container.querySelector<HTMLDivElement>(".transcript")!;
    transcriptElement.scrollTop = 100;
    const tool = container.querySelector(".message-tool")!;
    const disclosure = tool.querySelector<HTMLButtonElement>(".tool-disclosure")!;
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(disclosure.textContent).toContain("Run Command");
    expect(tool.querySelector("pre")).toBeNull();
    await act(async () => disclosure.click());
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(tool.querySelector("pre")?.textContent).toBe("Result\n" + "output\n".repeat(500));
    expect(transcriptElement.scrollTop).toBe(100);
    await act(async () => disclosure.click());
    expect(tool.querySelector("pre")).toBeNull();
    expect(transcriptElement.scrollTop).toBe(100);
  });

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

  it("copies the raw Markdown for assistant responses", async () => {
    const markdown = "## Result\n\n- **done**";
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    transcript = [{ event: "message", seq: 2, role: "assistant", content: markdown, thinking: "" }];
    await mount();

    await act(async () => container.querySelector<HTMLButtonElement>(".session-pane nav button")!.click());
    const copy = container.querySelector<HTMLButtonElement>(".message-copy")!;
    expect(copy.textContent).toBe("Copy");
    await act(async () => copy.click());

    expect(writeText).toHaveBeenCalledWith(markdown);
    expect(copy.textContent).toBe("Copied");
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

  it("scopes Escape cancellation and keeps polling when queued work continues", async () => {
    metadata.input_queue = true;
    turnId = "running-turn";
    create = () => Response.json({ error: "cannot create a session while a remote turn is running" }, { status: 409 });
    await mount();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });

    expect(requests).toContainEqual({
      action: "cancel",
      session_id: "100_200",
      turn_id: "running-turn",
      continue_queued: true,
    });
    expect(container.querySelector(".connection-state")?.textContent).toBe("Working");
    expect(requests.filter((request) => request.action === "events.next")).toHaveLength(1);
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

  it("hides the console and returns to login when a foreground request finds an expired session", async () => {
    await mount();
    expect(container.textContent).toContain("Agent transcript");

    list = () => Response.json({ error: "Authentication required" }, {
      status: 401,
      headers: { "X-Zweb-Auth": "required" },
    });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(container.textContent).toBe("Session expired · returning to sign in");
    expect(container.textContent).not.toContain("Agent transcript");
    expect(navigation.replace).toHaveBeenCalledExactlyOnceWith("/login?error=expired");
    expect(navigation.refresh).toHaveBeenCalledOnce();
  });
});
