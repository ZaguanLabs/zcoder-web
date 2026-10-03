"use client";

import { FormEvent, KeyboardEvent, memo, useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { DocumentReader } from "@/components/document-reader";
import { eventRetryDelayMs, isTransientRpcError, readRpcJson, RpcResponseError } from "@/lib/client-rpc";
import { emptyQueue, InputQueue, type InputMode, type QueueSnapshot } from "@/lib/input-queue";
import { isPageVisible, onPageVisible, waitForPageVisible } from "@/lib/visibility";

const MarkdownContent = dynamic(
  () => import("@/components/markdown-content").then((module) => module.MarkdownContent),
  { loading: () => <span className="markdown-loading">Formatting…</span> },
);

type ServerSummary = { id: string; name: string };
type Flat = Record<string, string | number | boolean | null>;
type Approval = { id: string; command: string };

const EVENT_RECONNECT_ATTEMPTS = 8;
const TRANSCRIPT_FOLLOW_THRESHOLD = 48;
/** Long enough that alt-tabbing through windows is not a session request per tab stop. */
const SESSIONS_REREAD_MIN_INTERVAL_MS = 10_000;

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

const TOOL_NAMES: Record<string, string> = {
  list_files: "List Files",
  read_file: "Read File",
  read_file_range: "Read File Range",
  search: "Search Files",
  write_file: "Write File",
  replace_text: "Replace Text",
  apply_patch: "Apply Patch",
  run_command: "Run Command",
  list_agents: "List Agents",
  send_agent_message: "Send Agent Message",
  discover_skills: "Discover Skills",
  activate_skill: "Activate Skill",
  read_skill_resource: "Read Skill Resource",
  finish: "Finish",
};

function roleName(role: Flat["role"]) {
  if (role === "assistant") return "Assistant";
  if (role === "user") return "You";
  if (role === "tool") return "Tool activity";
  if (role === "error") return "Error";
  return String(role || "System");
}

function toolName(tool: string | undefined | null): string {
  if (!tool) return tool ?? "";
  return TOOL_NAMES[tool] ?? tool;
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

const CopyButton = memo(function CopyButton({ markdown }: { markdown: string }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  const resetTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
  }, []);

  async function copy() {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    try {
      await navigator.clipboard.writeText(markdown);
      setState("copied");
    } catch {
      setState("error");
    }
    resetTimer.current = window.setTimeout(() => setState("idle"), 1_600);
  }

  return (
    <button
      type="button"
      className={`message-copy copy-${state}`}
      onClick={() => void copy()}
      aria-label="Copy Markdown response"
    >
      {state === "copied" ? "Copied" : state === "error" ? "Copy failed" : "Copy"}
    </button>
  );
});

const TranscriptMessage = memo(function TranscriptMessage({ event }: { event: Flat }) {
  const [reasoningOpen, setReasoningOpen] = useState(event.reasoning_open === 1);
  const thinking = typeof event.thinking === "string" ? event.thinking : "";
  const role = String(event.role || "system");
  const isTool = role === "tool";
  const content = isTool ? stripAnsi(String(event.content)) : undefined;
  return (
    <article className={`message message-${role}`}>
      <header>
        <span className="message-glyph" aria-hidden="true">{role === "assistant" ? "◆" : role === "user" ? "›" : role === "tool" ? "⚙" : "!"}</span>
        {role !== "tool" ? <strong>{roleName(event.role)}</strong> : null}
        {isTool ? <span className="tool-name">{toolName(String(event.tool_name ?? ""))}</span> : null}
        {event.time ? <time>{String(event.time)}</time> : null}
      </header>
      {thinking ? (
        <div className="reasoning">
          <button type="button" onClick={() => setReasoningOpen((open) => !open)} aria-expanded={reasoningOpen}>
            <span aria-hidden="true">{reasoningOpen ? "▾" : "▸"}</span> Reasoning · {thinking.split("\n").length} {thinking.includes("\n") ? "lines" : "line"}
          </button>
          {reasoningOpen ? <div className="reasoning-content"><MarkdownContent compact>{thinking}</MarkdownContent></div> : null}
        </div>
      ) : null}
      {content ? (
        <div className="message-content message-content-pre">
          <pre className="message-pre">{content}</pre>
        </div>
      ) : event.content ? (
        <div className="message-content"><MarkdownContent>{String(event.content)}</MarkdownContent></div>
      ) : null}
      {role === "assistant" && typeof event.content === "string" && event.content ? (
        <footer className="message-actions">
          <CopyButton markdown={event.content} />
        </footer>
      ) : null}
    </article>
  );
});

export function ConsoleApp() {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [serverId, setServerId] = useState(() => typeof window === "undefined" ? "" : localStorage.getItem("zcoder-server-id") ?? "");
  const [hello, setHello] = useState<Flat | null>(null);
  const [sessions, setSessions] = useState<Flat[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState<Flat[]>([]);
  const [status, setStatus] = useState("Disconnected");
  const [error, setError] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsListing, setSessionsListing] = useState(false);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [approvalSending, setApprovalSending] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [mobileSessions, setMobileSessions] = useState(false);
  const [online, setOnline] = useState(true);
  const [runId, setRunId] = useState("");
  const [queue, setQueue] = useState<QueueSnapshot>(emptyQueue);
  const [inputMode, setInputMode] = useState<InputMode>("steer");
  const [inputSending, setInputSending] = useState(false);
  const [hasNewActivity, setHasNewActivity] = useState(false);
  const [compactDrawer, setCompactDrawer] = useState(false);
  const [serverDetailsOpen, setServerDetailsOpen] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [readingDocument, setReadingDocument] = useState(false);
  const queueClient = useRef<InputQueue | null>(null);
  const submissionLock = useRef(false);
  const approvalLock = useRef<Approval | null>(null);
  const approvalRef = useRef<HTMLElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const mobileSidebarToggleRef = useRef<HTMLButtonElement>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  const transcriptTitleRef = useRef<HTMLSpanElement>(null);
  const preparingController = useRef<AbortController | null>(null);
  const initialServerId = useRef(serverId);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const connectController = useRef<AbortController | null>(null);
  const pollController = useRef<AbortController | null>(null);
  const authExpired = useRef(false);
  // Set when the event stream gave up, so returning to the app can recover it.
  const streamLost = useRef(false);
  const lastSessionsReadAt = useRef(0);
  const followingTranscript = useRef(true);
  const modelWarming = hello?.model_status === "warming";
  const modelReady = Boolean(hello) && !modelWarming && hello?.model_status !== "error";
  const queueSupported = hello?.input_queue === true && hello?.sessions === true;
  const canPrompt = Boolean(hello) && !connecting;
  const canQueue = busy && queueSupported && Boolean(runId) && queue.turnId === runId && !queue.loading && !queue.error;
  const hasUncertainInput = queue.records.some((record) => record.state === "uncertain");
  const queuedInputs = queue.records.filter((record) => record.state !== "consumed" && record.state !== "discarded");
  const queueNeedsAttention = Boolean(queue.error) || queuedInputs.some((record) => record.state === "rejected" || Boolean(record.error));
  const canSend = online && !connecting && !sessionsLoading && !inputSending && !hasUncertainInput &&
    (hello?.sessions !== true || Boolean(sessionId)) &&
    (busy ? canQueue : modelReady && !approval && (!queueSupported || Boolean(sessionId) && !queue.loading && !queue.error));
  const displayStatus = busy ? "Working" : online ? status : "Offline";
  const selectedSession = sessions.find((session) => String(session.id) === sessionId);
  const selectedSessionTitle = selectedSession ? String(selectedSession.title || "Untitled session") : sessionId ? "Current session" : "No session";

  const expireSession = useCallback(() => {
    if (authExpired.current) return;
    authExpired.current = true;
    connectController.current?.abort();
    pollController.current?.abort();
    preparingController.current?.abort();
    setSessionExpired(true);
    routerRef.current.replace("/login?error=expired");
    routerRef.current.refresh();
  }, []);

  const rpc = useCallback(async (id: string, body: Record<string, unknown>, signal?: AbortSignal) => {
    const response = await fetch(`/api/servers/${encodeURIComponent(id)}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    return readRpcJson(response, expireSession);
  }, [expireSession]);

  const refreshSessions = useCallback(async (id: string, signal?: AbortSignal) => {
    const list = await rpc(id, { action: "sessions.list" }, signal) as Flat[];
    if (!signal?.aborted) setSessions(list);
    return list;
  }, [rpc]);

  const loadSession = useCallback(async (id: string, targetId: string, select = false, signal?: AbortSignal) => {
    if (select) setSessionsLoading(true);
    try {
      if (select) {
        await rpc(id, { action: "session.select", id: targetId }, signal);
        followingTranscript.current = true;
        setHasNewActivity(false);
        setSessionId(targetId);
        setQueue(emptyQueue);
        setMessages([]);
      }
      const transcript = await rpc(id, { action: "session.load", id: targetId }, signal) as Flat[];
      if (signal?.aborted) return;
      setSessionId(targetId);
      setMessages(transcript);
      setMobileSessions(false);
      if (select) await refreshSessions(id, signal);
    } finally { if (select) setSessionsLoading(false); }
  }, [refreshSessions, rpc]);

  const pollEvents = useCallback(async (id: string, targetSession: string, supportsSessions: boolean, turnId: string, reattached = false) => {
    pollController.current?.abort();
    const controller = new AbortController();
    pollController.current = controller;
    streamLost.current = false;
    let cursor = 0;
    let reconnectAttempts = 0;
    let transcriptDirty = false;
    const reloadTranscript = async () => {
      if (!transcriptDirty || !targetSession) return;
      const transcript = await rpc(id, { action: "session.load", id: targetSession }, controller.signal) as Flat[];
      if (!controller.signal.aborted) setMessages(transcript);
      transcriptDirty = false;
    };
    try {
      while (!controller.signal.aborted) {
        // A hidden page polls nothing. The event cursor is durable upstream, so
        // the run resumes from the seq it stopped at instead of losing events.
        if (!isPageVisible()) {
          await waitForPageVisible(controller.signal);
          // Coming back is a fresh start, not another failed attempt.
          reconnectAttempts = 0;
        }
        let event: Flat;
        try {
          event = await rpc(id, { action: "events.next", after: cursor }, controller.signal) as Flat;
          if (reconnectAttempts > 0) { reconnectAttempts = 0; setStatus("Working"); }
        } catch (cause) {
          if (isAbortError(cause)) throw cause;
          if (!isTransientRpcError(cause) || reconnectAttempts >= EVENT_RECONNECT_ATTEMPTS) throw cause;
          setStatus("Reconnecting");
          await wait(eventRetryDelayMs(reconnectAttempts), controller.signal);
          reconnectAttempts += 1;
          continue;
        }
        if (!event || typeof event !== "object") throw new Error("Malformed remote event");
        if (event.event === "none") {
          await reloadTranscript();
          await wait(550, controller.signal);
          continue;
        }
        if (!Number.isSafeInteger(event.seq) || (event.seq as number) <= cursor) throw new Error("Remote event cursor did not advance");
        cursor = event.seq as number;
        switch (event.event) {
          case "message":
            if (typeof event.role !== "string" || typeof event.content !== "string" || typeof event.thinking !== "string") throw new Error("Malformed remote message");
            // On reattach, the saved transcript already contains streamed messages.
            // Reload that authoritative transcript without matching message text.
            if (reattached) transcriptDirty = true;
            else setMessages((current) => [...current, event]);
            break;
          case "status":
            if (typeof event.status !== "string") throw new Error("Malformed remote status");
            setStatus(event.status);
            break;
          case "approval_required":
            if (typeof event.id !== "string" || !event.id || typeof event.command !== "string") throw new Error("Malformed remote approval");
            setApproval({ id: event.id, command: event.command });
            setStatus("Approval required");
            break;
          case "complete": {
            const code = Number.isInteger(event.exit_code) && (event.exit_code as number) >= 0 && (event.exit_code as number) <= 255 ? event.exit_code : 1;
            setRunId("");
            setApproval(null);
            queueClient.current?.closeRun(turnId);
            await reloadTranscript();
            await queueClient.current?.refresh();
            if (supportsSessions) await refreshSessions(id, controller.signal);
            setBusy(false);
            setStatus(code === 0 ? "Ready" : code === 130 ? "Stopped" : `Exited ${code}`);
            return;
          }
          default: throw new Error("Unknown remote event type");
        }
      }
    } catch (cause) {
      if (isAbortError(cause)) return;
      streamLost.current = true;
      setError(cause instanceof Error ? cause.message : "Event stream failed");
      setBusy(false);
      setStatus("Connection lost");
    } finally {
      if (pollController.current === controller) pollController.current = null;
    }
  }, [refreshSessions, rpc]);

  const connect = useCallback(async (id: string, fresh = false) => {
    pollController.current?.abort();
    preparingController.current?.abort();
    connectController.current?.abort();
    const controller = new AbortController();
    connectController.current = controller;
    streamLost.current = false;
    setBusy(false);
    setRunId("");
    setApproval(null);
    setConnecting(true);
    setError("");
    setStatus("Connecting");
    setHello(null);
    followingTranscript.current = true;
    setHasNewActivity(false);
    setMessages([]);
    setSessions([]);
    setSessionsLoading(false);
    setSessionsListing(false);
    setSessionId("");
    setQueue(emptyQueue);
    try {
      const metadata = await rpc(id, { action: "hello" }, controller.signal) as Flat;
      if (controller.signal.aborted) return;
      if (metadata.protocol !== 1) throw new Error("This server does not speak zcoder protocol 1");
      setHello(metadata);
      setConnecting(false);

      if (metadata.model_status === "error") {
        setStatus("Model error");
        setError(String(metadata.model_error || "Model preparation failed"));
      } else {
        setStatus(metadata.model_status === "warming" ? "Warming up" : "Ready");
      }

      if (metadata.sessions === true) {
        setSessionsLoading(true);
        let loadingSession = true;
        void (async () => {
          if (fresh) {
            let created: Flat | undefined;
            try {
              created = await rpc(id, { action: "session.new" }, controller.signal) as Flat;
            } catch (cause) {
              // An active run owns the server's current session. Reattach to it.
              if (!(cause instanceof RpcResponseError) || cause.status !== 409) throw cause;
            }
            if (controller.signal.aborted) return;
            if (created) {
              if (typeof created.id !== "string" || !created.id) throw new Error("Server returned an invalid session id");
              setSessionId(created.id);
              // A new session has no transcript. History must not delay the composer.
              loadingSession = false;
              setSessionsLoading(false);
              setSessionsListing(true);
              await refreshSessions(id, controller.signal);
              return;
            }
          }
          const list = await refreshSessions(id, controller.signal);
          if (controller.signal.aborted) return;
          const current = list.find((session) => session.current === 1);
          if (current && typeof current.id === "string") await loadSession(id, current.id, false, controller.signal);
        })().catch((cause) => {
          if (!controller.signal.aborted && !isAbortError(cause)) setError(cause instanceof Error ? cause.message : "Could not load sessions");
        }).finally(() => {
          if (!controller.signal.aborted) {
            if (loadingSession) setSessionsLoading(false);
            setSessionsListing(false);
          }
        });
      }

      if (metadata.model_status === "warming") {
        void (async () => {
          let model = metadata;
          while (model.model_status === "warming") {
            await wait(700, controller.signal);
            model = await rpc(id, { action: "model.get" }, controller.signal) as Flat;
          }
          setHello((current) => current ? { ...current, ...model } : current);
          if (model.model_status === "error") {
            setStatus("Model error");
            setError(String(model.model_error || "Model preparation failed"));
          } else if (!pollController.current) {
            setStatus("Ready");
          }
        })().catch((cause) => {
          if (isAbortError(cause)) return;
          setStatus("Model error");
          setError(cause instanceof Error ? cause.message : "Could not check model status");
        });
      }
    } catch (cause) {
      if (isAbortError(cause)) return;
      setError(cause instanceof Error ? cause.message : "Connection failed");
      setStatus("Offline");
      setConnecting(false);
    }
  }, [loadSession, refreshSessions, rpc]);

  useEffect(() => {
    if (!queueSupported || !serverId || !sessionId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    let client: InputQueue;
    try {
      client = new InputQueue(sessionId, serverId, (body) => rpc(serverId, body, controller.signal), localStorage,
        (snapshot) => { if (!disposed) setQueue(snapshot); });
      queueClient.current = client;
    } catch (cause) {
      queueMicrotask(() => { if (!disposed) setQueue({ ...emptyQueue, error: cause instanceof Error ? cause.message : "Could not restore queued input" }); });
      return () => { disposed = true; };
    }
    let inspecting = false;
    const inspect = async (initial = false) => {
      inspecting = true;
      try {
        await client.refresh();
        if (disposed) return;
        if (initial && client.snapshot.turnId && !pollController.current) {
          setRunId(client.snapshot.turnId);
          setBusy(true);
          setStatus("Working");
          void pollEvents(serverId, sessionId, true, client.snapshot.turnId, true);
        }
        const pending = client.snapshot.records.some((record) => ["accepted", "uncertain"].includes(record.state));
        // Armed only while the page is showing. A hidden tab costs the upstream
        // nothing, and the checks it missed collapse into the one made on return.
        if (isPageVisible()) timer = setTimeout(() => void inspect(), client.snapshot.turnId || pending ? 2_000 : 10_000);
      } finally { inspecting = false; }
    };
    void inspect(true);
    const stopWatchingVisibility = onPageVisible(() => { if (!disposed && !inspecting) void inspect(); });
    return () => {
      disposed = true;
      stopWatchingVisibility();
      controller.abort();
      clearTimeout(timer);
      if (queueClient.current === client) queueClient.current = null;
    };
  }, [queueSupported, serverId, sessionId, rpc, pollEvents]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/servers", { cache: "no-store" })
      .then((response) => readRpcJson<ServerSummary[]>(response, expireSession))
      .then((list: ServerSummary[]) => {
        if (cancelled) return;
        setServers(list);
        if (list[0]) {
          const initialId = initialServerId.current || list[0].id;
          setServerId(initialId);
          localStorage.setItem("zcoder-server-id", initialId);
          void connect(initialId, true);
        } else {
          setConnecting(false);
          setStatus("No servers");
        }
      })
      .catch((cause) => {
        if (!cancelled && !authExpired.current) {
          setError(cause instanceof Error ? cause.message : "Could not load servers");
          setConnecting(false);
        }
      });
    return () => {
      cancelled = true;
      connectController.current?.abort();
      pollController.current?.abort();
      preparingController.current?.abort();
    };
  }, [connect, expireSession]);

  useEffect(() => {
    const mobile = window.matchMedia("(max-width: 860px)");
    const shortMobile = window.matchMedia("(max-width: 860px) and (max-height: 620px)");
    const updateMobile = () => {
      if (sidebarRef.current?.contains(document.activeElement)) {
        const target = mobile.matches ? mobileSidebarToggleRef : sidebarToggleRef;
        requestAnimationFrame(() => target.current?.focus({ preventScroll: true }));
      }
      if (!mobile.matches) setMobileSessions(false);
    };
    const updateCompact = () => setCompactDrawer(shortMobile.matches);
    setCompactDrawer(shortMobile.matches);
    if (!mobile.matches) setMobileSessions(false);
    mobile.addEventListener?.("change", updateMobile);
    shortMobile.addEventListener?.("change", updateCompact);
    return () => {
      mobile.removeEventListener?.("change", updateMobile);
      shortMobile.removeEventListener?.("change", updateCompact);
    };
  }, []);

  useEffect(() => {
    const element = transcriptRef.current;
    if (!element) return;
    if (readingDocument) {
      setHasNewActivity(true);
      return;
    }
    const shouldFollow = followingTranscript.current;
    requestAnimationFrame(() => {
      if (shouldFollow) {
        element.scrollTop = element.scrollHeight;
        setHasNewActivity(false);
      } else {
        setHasNewActivity(true);
      }
    });
  }, [messages, approval, readingDocument]);

  useEffect(() => {
    if (approval) approvalRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [approval]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // Coming back to the app is one moment that deserves a read. The stream may
  // have exhausted its retries while the page was frozen, and the session list
  // has been sitting still for as long as the window was hidden.
  useEffect(() => onPageVisible(() => {
    if (!serverId || connecting) return;
    if (streamLost.current) {
      void connect(serverId);
      return;
    }
    const now = Date.now();
    if (now - lastSessionsReadAt.current < SESSIONS_REREAD_MIN_INTERVAL_MS) return;
    lastSessionsReadAt.current = now;
    refreshSessions(serverId).catch(() => {});
  }), [connect, connecting, refreshSessions, serverId]);

  useEffect(() => {
    if (!canPrompt) return;
    const frame = requestAnimationFrame(() => promptRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [canPrompt, serverId, sessionId]);

  useEffect(() => {
    const field = promptRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
  }, [prompt]);

  useEffect(() => {
    if (!canPrompt || readingDocument) return;
    function routeTypingToPrompt(event: globalThis.KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, button, a, [contenteditable='true']")) return;
      const field = promptRef.current;
      if (!field) return;
      event.preventDefault();
      field.focus({ preventScroll: true });
      const start = field.selectionStart ?? field.value.length;
      const end = field.selectionEnd ?? start;
      setPrompt((current) => `${current.slice(0, start)}${event.key}${current.slice(end)}`);
      requestAnimationFrame(() => field.setSelectionRange(start + event.key.length, start + event.key.length));
    }
    window.addEventListener("keydown", routeTypingToPrompt);
    return () => window.removeEventListener("keydown", routeTypingToPrompt);
  }, [canPrompt, readingDocument]);

  async function startTurn(value: string, resume = false) {
    if (!serverId || busy || submissionLock.current) return;
    submissionLock.current = true;
    setError("");
    setBusy(true);
    setStatus("Checking model");
    const controller = new AbortController();
    preparingController.current = controller;
    try {
      if (resume) await rpc(serverId, { action: "session.select", id: sessionId }, controller.signal);
      if (!resume) {
        followingTranscript.current = true;
        setHasNewActivity(false);
        setMessages((current) => [...current, { event: "message", role: "user", content: value, thinking: "", time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }]);
        setPrompt((current) => current === value ? "" : current);
      }
      let model: Flat = hello ?? {};
      if (hello?.model_status !== undefined) {
        model = await rpc(serverId, { action: "model.ensure" }, controller.signal) as Flat;
        while (model.model_status === "warming") {
          setStatus("Warming up");
          await wait(700, controller.signal);
          model = await rpc(serverId, { action: "model.get" }, controller.signal) as Flat;
        }
        if (model.model_status !== "ready") throw new Error(String(model.model_error || "Model preparation failed"));
      }
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      preparingController.current = null;
      setStatus("Starting turn");
      const receipt = await rpc(serverId, { action: "turn.start", prompt: value }) as Flat;
      if (typeof receipt.turn_id !== "string" || !receipt.turn_id) throw new Error("Server returned an invalid turn receipt; reconnect to inspect the run before retrying");
      setRunId(receipt.turn_id);
      setStatus(receipt.model_status === "warming" ? "Warming up" : "Working");
      void queueClient.current?.refresh();
      void pollEvents(serverId, sessionId, hello?.sessions === true, receipt.turn_id);
    } catch (cause) {
      if (!isAbortError(cause)) setError(cause instanceof Error ? cause.message : "Could not start the turn");
      setBusy(false);
      setStatus(isAbortError(cause) ? "Stopped" : "Check connection");
    } finally {
      preparingController.current = null;
      submissionLock.current = false;
    }
  }

  async function submitPrompt(event: FormEvent) {
    event.preventDefault();
    if (!prompt || !canSend) return;
    if (!busy) { await startTurn(prompt); return; }
    if (!canQueue || !queueClient.current || submissionLock.current) return;
    submissionLock.current = true;
    setInputSending(true);
    const value = prompt;
    const client = queueClient.current;
    try {
      const accepted = await client.submit(runId, inputMode, value);
      if (accepted && queueClient.current === client) setPrompt((current) => current === value ? "" : current);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save queued input"); }
    finally { submissionLock.current = false; setInputSending(false); }
  }

  async function createSession() {
    if (!serverId || busy || sessionsLoading || inputSending || hello?.sessions !== true) return;
    const mobile = window.matchMedia("(max-width: 860px)").matches;
    setError("");
    setSessionsLoading(true);
    try {
      const result = await rpc(serverId, { action: "session.new" }) as Flat;
      if (typeof result.id !== "string") throw new Error("Server returned an invalid session id");
      setSessionId(result.id);
      // A new session has no transcript. History must not delay the composer.
      setMessages([]);
      setQueue(emptyQueue);
      followingTranscript.current = true;
      setHasNewActivity(false);
      setMobileSessions(false);
      await refreshSessions(serverId);
      if (mobile) requestAnimationFrame(() => transcriptTitleRef.current?.focus({ preventScroll: true }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create a session"); }
    finally { setSessionsLoading(false); }
  }

  async function answerApproval(decision: "y" | "a" | "n") {
    if (!approval || !serverId || approvalLock.current || !online || connecting) return;
    approvalLock.current = approval;
    setApprovalSending(true);
    try {
      await rpc(serverId, { action: "approval", id: approval.id, decision });
      setApproval((current) => current === approval ? null : current);
      setStatus(decision === "n" ? "Command denied" : "Working");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Approval failed");
      await rpc(serverId, { action: "cancel" }).catch(() => undefined);
      pollController.current?.abort();
      setBusy(false);
      setRunId("");
      setApproval(null);
      setStatus("Approval failed");
      await queueClient.current?.refresh();
    } finally {
      approvalLock.current = null;
      setApprovalSending(false);
    }
  }

  function toggleSidebar() {
    const mobile = window.matchMedia("(max-width: 860px)").matches;
    if (mobile) {
      if (mobileSessions) {
        setMobileSessions(false);
        requestAnimationFrame(() => mobileSidebarToggleRef.current?.focus({ preventScroll: true }));
      } else {
        setMobileSessions(true);
        requestAnimationFrame(() => drawerCloseRef.current?.focus({ preventScroll: true }));
      }
      return;
    }
    if (sidebarRef.current?.contains(document.activeElement)) sidebarToggleRef.current?.focus({ preventScroll: true });
    setSidebarHidden((hidden) => !hidden);
  }

  function closeMobileSessions(restoreFocus = true) {
    setMobileSessions(false);
    if (restoreFocus) requestAnimationFrame(() => mobileSidebarToggleRef.current?.focus({ preventScroll: true }));
  }

  function handleDrawerKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMobileSessions();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])") ?? [])
      .filter((control) => !control.closest("[hidden]"));
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function updateTranscriptFollow() {
    const element = transcriptRef.current;
    if (!element) return;
    const following = element.scrollHeight - element.scrollTop - element.clientHeight <= TRANSCRIPT_FOLLOW_THRESHOLD;
    followingTranscript.current = following;
    if (following) setHasNewActivity(false);
  }

  function jumpToLatestActivity() {
    const element = transcriptRef.current;
    if (!element) return;
    followingTranscript.current = true;
    element.scrollTop = element.scrollHeight;
    setHasNewActivity(false);
  }

  const handleShortcut = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.getModifierState("AltGraph")) return;
    const key = event.key.toLowerCase();
    if (event.key === "Escape" && mobileSessions) {
      event.preventDefault();
      closeMobileSessions();
    } else if (event.key === "Escape" && busy && serverId) {
      event.preventDefault();
      if (preparingController.current) { preparingController.current.abort(); return; }
      void cancelTurn();
    } else if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && key === "b") {
      event.preventDefault();
      if (!event.repeat) toggleSidebar();
    } else if (approval && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (key === "y" || key === "n")) {
      event.preventDefault();
      if (!event.repeat) void answerApproval(key);
    }
  });

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => handleShortcut(event);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function cancelTurn() {
    if (!serverId || !busy) return;
    if (preparingController.current) { preparingController.current.abort(); return; }
    setStatus("Stopping");
    const request = queueSupported && sessionId && runId
      ? { action: "cancel", session_id: sessionId, turn_id: runId, continue_queued: true }
      : { action: "cancel" };
    try {
      const result = await rpc(serverId, request) as Flat;
      if (result.continued === true) {
        setStatus("Working");
        void queueClient.current?.refresh();
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Cancellation was not acknowledged"); }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  function promptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  if (sessionExpired) {
    return <main className="loading-state session-expired" role="status"><span /><p>Session expired · returning to sign in</p></main>;
  }

  return (
    <main className="console-shell">
      <header className="topbar">
        <button ref={sidebarToggleRef} type="button" className="sidebar-toggle" onClick={toggleSidebar} aria-label={sidebarHidden ? "Show sidebar" : "Hide sidebar"} aria-expanded={!sidebarHidden} aria-controls="session-drawer" aria-keyshortcuts="Control+b" title={`${sidebarHidden ? "Show" : "Hide"} sidebar (Ctrl+B)`}><Icon name="sidebar" size={18} /></button>
        <div className="wordmark"><span><Icon name="bolt" size={17} /></span> zweb <small>/ zcoder.zsh</small></div>
        <div className="active-model" title={hello ? String(hello.model) : undefined}>{hello ? String(hello.model) : "No model connected"}</div>
        <div className="server-switcher">
          <label htmlFor="server-select">Server</label>
          <select id="server-select" value={serverId} disabled={busy || inputSending || sessionsLoading} onChange={(event) => { const id = event.target.value; localStorage.setItem("zcoder-server-id", id); setServerId(id); void connect(id); }}>
            {servers.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}
          </select>
        </div>
        <div className={`connection-state state-${displayStatus.toLowerCase().replaceAll(" ", "-")}`} role="status">{displayStatus}</div>
        <button type="button" className="icon-button logout-button" onClick={logout} aria-label="Log out" title="Log out"><Icon name="logout" /></button>
      </header>

      <div className="mobile-bar">
        <button ref={mobileSidebarToggleRef} type="button" className="mobile-session-trigger" aria-expanded={mobileSessions} aria-controls="session-drawer" aria-keyshortcuts="Control+b" title="Toggle sessions (Ctrl+B)" onClick={toggleSidebar}>
          <Icon name="server" /> <span className="mobile-sessions-label">Sessions</span> <span className="mobile-session-count">{sessions.length}</span>
        </button>
        <label className="mobile-server-switcher">
          <span className="sr-only">Server</span>
          <select value={serverId} aria-label="Active server" disabled={busy || inputSending || sessionsLoading} onChange={(event) => { const id = event.target.value; localStorage.setItem("zcoder-server-id", id); setMobileSessions(false); setServerId(id); void connect(id); }}>
            {servers.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}
          </select>
        </label>
      </div>

      <div className={`workbench ${sidebarHidden ? "sidebar-hidden" : ""}`}>
        <button type="button" className={`session-backdrop ${mobileSessions ? "visible" : ""}`} aria-label="Close sessions" tabIndex={-1} onClick={() => closeMobileSessions()} />
        <aside ref={sidebarRef} id="session-drawer" className={`session-pane ${mobileSessions ? "mobile-open" : ""}`} aria-labelledby="session-drawer-title" role={mobileSessions ? "dialog" : undefined} aria-modal={mobileSessions ? true : undefined} onKeyDown={handleDrawerKeyDown}>
          <div className="pane-title"><span id="session-drawer-title"><span className="sessions-label">Sessions</span> ({sessions.length})</span><button ref={drawerCloseRef} type="button" className="drawer-close" aria-label="Close sessions" onClick={() => closeMobileSessions()}>×</button></div>
          <button type="button" className="new-session" disabled={busy || inputSending || sessionsLoading || hello?.sessions !== true} onClick={createSession}><Icon name="plus" /> New session</button>
          <nav aria-label="Remote sessions">
            {sessions.map((session) => {
              const id = String(session.id);
              return (
                <button type="button" key={id} className={sessionId === id ? "active" : ""} aria-current={sessionId === id ? "true" : undefined} title={String(session.title || "Untitled session")} disabled={busy || inputSending || sessionsLoading} onClick={() => {
                  const mobile = window.matchMedia("(max-width: 860px)").matches;
                  void loadSession(serverId, id, true).then(() => {
                    if (mobile) requestAnimationFrame(() => transcriptTitleRef.current?.focus({ preventScroll: true }));
                  }).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not select session"));
                }}>
                  <span className="session-rail" aria-hidden="true">{sessionId === id ? "▸" : ""}</span>
                  <span className="session-text"><strong>{String(session.title || "Untitled session")}</strong><small>{String(session.model || "Model unknown")}</small></span>
                </button>
              );
            })}
            {sessionsLoading || sessionsListing ? <p className="empty-list">Loading sessions…</p> : !sessions.length && !connecting ? <p className="empty-list">No sessions on this server.</p> : null}
          </nav>
          {hello ? (
            <section className={`server-details ${serverDetailsOpen ? "open" : ""}`}>
              <button type="button" className="server-details-toggle" aria-expanded={serverDetailsOpen} aria-controls="server-facts" onClick={() => setServerDetailsOpen((open) => !open)}>Server details <span aria-hidden="true">{serverDetailsOpen ? "−" : "+"}</span></button>
              <dl id="server-facts" className="server-facts" hidden={compactDrawer && !serverDetailsOpen}>
              <div><dt>Server</dt><dd><select className="mobile-server-select" value={serverId} aria-label="Active server" disabled={busy || inputSending || sessionsLoading} onChange={(event) => { const id = event.target.value; localStorage.setItem("zcoder-server-id", id); setServerId(id); void connect(id); }}>{servers.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}</select></dd></div>
              <div><dt>Project</dt><dd className="workspace-name" title={String(hello.workspace)}>{String(hello.workspace)}</dd></div>
              <div><dt>Model</dt><dd className="model-name" title={String(hello.model)}>{String(hello.model)}</dd></div>
              <div><dt>Profile</dt><dd>{String(hello.profile)}</dd></div>
              <div><dt>Shell</dt><dd className={`policy-${hello.command_policy}`}>{String(hello.command_policy)}</dd></div>
              </dl>
            </section>
          ) : null}
        </aside>

        <section className="transcript-pane" aria-labelledby="transcript-title" inert={mobileSessions ? true : undefined}>
          <DocumentReader key={serverId} serverId={serverId} supported={hello?.documents === true} available={online && !connecting} approvalPending={Boolean(approval)} rpc={rpc} onReadingChange={setReadingDocument} onCodingFocus={() => promptRef.current?.focus({ preventScroll: true })}>
          <div className="pane-title transcript-title"><span ref={transcriptTitleRef} id="transcript-title" className="transcript-heading" tabIndex={-1} aria-label={`Agent transcript, session ${selectedSessionTitle}, ${messages.length} events`}><span>Agent transcript</span> <span className="transcript-event-count">({messages.length} events)</span><span className="transcript-session-title">/ {selectedSessionTitle}</span></span></div>
          <div className="transcript" ref={transcriptRef} aria-live="polite" onScroll={updateTranscriptFollow}>
            {connecting ? <div className="loading-state"><span /><p>Establishing secure gateway</p></div> : null}
            {!connecting && !hello ? (
              <div className="empty-state"><Icon name="server" size={28} /><h2>{servers.length ? "Server unavailable" : "No servers configured"}</h2><p>{servers.length ? "Check the tunnel, zcoder process, and token." : "Add ZCODER_SERVERS_JSON to .env, then restart zweb."}</p>{error ? <code>{error}</code> : null}{servers.length && serverId ? <button type="button" className="retry-button" onClick={() => void connect(serverId)}>Reconnect</button> : null}</div>
            ) : null}
            {!connecting && hello && !messages.length ? (
              <div className="empty-state ready-empty">
                <h2><span className="prompt-symbol" aria-hidden="true">›</span> {modelReady ? "Welcome to zcoder.zsh" : modelWarming ? "Model warming up" : "Model unavailable"}</h2>
                <p>{modelReady ? "Ask for a change, investigation, or build. Start a new job or continue a session from the sidebar." : modelWarming ? "Sessions remain available while the model prepares." : "Sessions remain available while the model is unavailable."}</p>
                {modelReady ? <p className="welcome-hint">Write your prompt below to get started.</p> : null}
              </div>
            ) : null}
            {messages.map((message, index) => <TranscriptMessage key={`${String(message.seq ?? "local")}-${index}`} event={message} />)}
          </div>
          {hasNewActivity ? <button type="button" className="transcript-jump" onClick={jumpToLatestActivity}>Jump to latest activity</button> : null}
          </DocumentReader>
          {error && hello ? <div className="error-strip" role="alert"><strong>!</strong><span>{error} <button type="button" onClick={() => void connect(serverId)}>Reconnect</button></span><button type="button" onClick={() => setError("")} aria-label="Dismiss error">×</button></div> : null}
          {approval ? (
            <section ref={approvalRef} className="approval-bar" aria-labelledby="approval-title">
              <div><p id="approval-title"><span>!</span> Command approval required</p><code>{approval.command}</code></div>
              <div className="approval-actions">
                <button type="button" className="deny" disabled={approvalSending || !online || connecting} aria-keyshortcuts="Alt+n" title="Deny command (Alt+N)" onClick={() => void answerApproval("n")}>Deny <kbd>Alt+N</kbd></button>
                <button type="button" disabled={approvalSending || !online || connecting} aria-keyshortcuts="Alt+y" title="Allow command once (Alt+Y)" onClick={() => void answerApproval("y")}>Allow once <kbd>Alt+Y</kbd></button>
                {hello?.profile === "coding" ? <button type="button" className="allow" disabled={approvalSending || !online || connecting} onClick={() => void answerApproval("a")}>Allow until restart</button> : null}
              </div>
            </section>
          ) : null}
        </section>
      </div>
      <form className="prompt-box" onSubmit={submitPrompt} inert={mobileSessions ? true : undefined}>
        {queueSupported && sessionId && (queuedInputs.length > 0 || queue.pending || queue.error) ? (
          <details key={`${serverId}:${sessionId}`} className="queue-panel" open={queueNeedsAttention ? true : undefined}>
            <summary>
              <span className="queue-label">{queueNeedsAttention ? "Queue needs attention" : "Queue"}{queuedInputs.length > 0 ? ` · ${queuedInputs.length}` : ""}</span>
              {queuedInputs[0] ? <span className="queue-preview">{queuedInputs[0].request.mode === "steer" ? "Steering" : "Follow-up"} · {queuedInputs[0].request.text}</span> : null}
              {!queue.turnId && (queue.pending || queuedInputs.some((record) => record.state === "accepted")) ? <span className="queue-status">Paused</span> : null}
            </summary>
            {queue.error ? <p role="alert">{queue.error}</p> : null}
            <div className="queue-records">
              {queuedInputs.map((record) => (
                <div className="queue-item" key={record.request.message_id}>
                  <div className="queue-item-label">{record.request.mode === "steer" ? "Steering" : "Follow-up"}{record.state !== "accepted" ? <span>{record.state === "uncertain" ? "Unconfirmed" : "Rejected"}</span> : null}</div>
                  <pre>{record.request.text}</pre>
                  {record.error ? <p role="alert">{record.error}</p> : null}
                  <div className="queue-actions">
                    {record.state === "uncertain" ? <button type="button" disabled={inputSending || !online} onClick={async () => {
                      if (!queueClient.current || inputSending) return;
                      setInputSending(true);
                      try {
                        if (await queueClient.current.retry(record.request.message_id)) setPrompt((current) => current === record.request.text ? "" : current);
                      } finally { setInputSending(false); }
                    }}>Retry exact submission</button> : null}
                    {["accepted", "uncertain"].includes(record.state) ? <>
                      <button type="button" disabled={!online} onClick={() => void queueClient.current?.check(record.request.message_id)}>Check status</button>
                      <button type="button" disabled={!online || inputSending} onClick={() => void queueClient.current?.drop(record.request.message_id)}>Discard</button>
                    </> : <button type="button" onClick={() => { try { queueClient.current?.dismiss(record.request.message_id); } catch { setError("Could not update saved input"); } }}>Dismiss</button>}
                  </div>
                </div>
              ))}
            </div>
            {queue.pending ? <details><summary>Server pending listing</summary><pre className="queue-listing">{queue.pending}</pre></details> : null}
            <div className="queue-actions">
              <button type="button" disabled={!online} onClick={() => void queueClient.current?.refresh()}>Refresh queue</button>
              {!busy && !queue.turnId && (queue.pending || queue.records.some((record) => record.state === "accepted")) ? <button type="button" disabled={!online || !modelReady || queue.loading} onClick={() => void startTurn("/queue resume", true)}>Resume pending input</button> : null}
            </div>
          </details>
        ) : null}
        <div className="composer-actions">
          {busy && queueSupported ? <label>Send as <select aria-label="Queued input mode" value={inputMode} onChange={(event) => setInputMode(event.target.value as InputMode)}><option value="steer">Steering</option><option value="follow_up">Follow-up</option></select></label> : null}

        </div>
        <div className="prompt-row"><span aria-hidden="true">›</span><textarea ref={promptRef} id="prompt" aria-label="Message" value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={promptKeyDown} disabled={!canPrompt} rows={1} autoFocus enterKeyHint="send" placeholder={busy ? queueSupported ? "Add steering or a follow-up…" : "Draft your next message…" : modelReady ? "Describe the job" : modelWarming ? "Model is warming up…" : "Model unavailable"} /><button type={busy && !prompt ? "button" : "submit"} disabled={!canSend && !busy} className={busy && !prompt ? "send-button stop-button" : "send-button"} onClick={busy && !prompt ? cancelTurn : undefined}><Icon name={busy && !prompt ? "stop" : "send"} /> {busy && !prompt ? "Stop" : busy ? (inputMode === "steer" ? "Steer" : "Queue") : "Send"}</button></div>
      </form>
      <footer className="keybar"><span><kbd>Enter</kbd> Send</span><span><kbd>Shift Enter</kbd> Newline</span><span><kbd>Esc</kbd> Stop</span><span><kbd>Ctrl+B</kbd> Sidebar</span><span><kbd>Tab</kbd> Focus</span>{busy && queueSupported ? <span>{inputMode === "steer" ? "Joins after the current response and its tools." : "Waits until the current task finishes."}</span> : null}<span className="keybar-right">zweb · remote zcoder</span></footer>
    </main>
  );
}
