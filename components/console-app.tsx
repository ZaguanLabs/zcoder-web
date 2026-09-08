"use client";

import { FormEvent, KeyboardEvent, memo, useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { isTransientRpcError, readRpcJson } from "@/lib/client-rpc";
import { emptyQueue, InputQueue, type InputMode, type QueueSnapshot } from "@/lib/input-queue";

const MarkdownContent = dynamic(
  () => import("@/components/markdown-content").then((module) => module.MarkdownContent),
  { loading: () => <span className="markdown-loading">Formatting…</span> },
);

type ServerSummary = { id: string; name: string };
type Flat = Record<string, string | number | boolean | null>;
type Approval = { id: string; command: string };

const EVENT_RECONNECT_ATTEMPTS = 8;

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

function roleName(role: Flat["role"]) {
  if (role === "assistant") return "Assistant";
  if (role === "user") return "You";
  if (role === "tool") return "Tool activity";
  if (role === "error") return "Error";
  return String(role || "System");
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

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
        <strong>{roleName(event.role)}</strong>
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
    </article>
  );
});

export function ConsoleApp() {
  const router = useRouter();
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [serverId, setServerId] = useState(() => typeof window === "undefined" ? "" : sessionStorage.getItem("zcoder-server-id") ?? "");
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
  const [approval, setApproval] = useState<Approval | null>(null);
  const [mobileSessions, setMobileSessions] = useState(false);
  const [online, setOnline] = useState(true);
  const [runId, setRunId] = useState("");
  const [queue, setQueue] = useState<QueueSnapshot>(emptyQueue);
  const [inputMode, setInputMode] = useState<InputMode>("steer");
  const [inputSending, setInputSending] = useState(false);
  const queueClient = useRef<InputQueue | null>(null);
  const submissionLock = useRef(false);
  const preparingController = useRef<AbortController | null>(null);
  const initialServerId = useRef(serverId);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const connectController = useRef<AbortController | null>(null);
  const pollController = useRef<AbortController | null>(null);
  const modelWarming = hello?.model_status === "warming";
  const modelReady = Boolean(hello) && !modelWarming && hello?.model_status !== "error";
  const queueSupported = hello?.input_queue === true && hello?.sessions === true;
  const canPrompt = Boolean(hello) && !connecting;
  const canQueue = busy && queueSupported && Boolean(runId) && queue.turnId === runId && !queue.loading && !queue.error;
  const hasUncertainInput = queue.records.some((record) => record.state === "uncertain");
  const canSend = online && !sessionsLoading && !inputSending && !hasUncertainInput &&
    (busy ? canQueue : modelReady && !approval && (!queueSupported || Boolean(sessionId) && !queue.loading && !queue.error));
  const displayStatus = online ? status : "Offline";

  const rpc = useCallback(async (id: string, body: Record<string, unknown>, signal?: AbortSignal) => {
    const response = await fetch(`/api/servers/${encodeURIComponent(id)}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    return readRpcJson(response);
  }, []);

  const refreshSessions = useCallback(async (id: string, signal?: AbortSignal) => {
    const list = await rpc(id, { action: "sessions.list" }, signal) as Flat[];
    setSessions(list);
    return list;
  }, [rpc]);

  const loadSession = useCallback(async (id: string, targetId: string, select = false, signal?: AbortSignal) => {
    if (select) setSessionsLoading(true);
    try {
      if (select) {
        await rpc(id, { action: "session.select", id: targetId }, signal);
        setSessionId(targetId);
        setQueue(emptyQueue);
        setMessages([]);
      }
      const transcript = await rpc(id, { action: "session.load", id: targetId }, signal) as Flat[];
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
        let event: Flat;
        try {
          event = await rpc(id, { action: "events.next", after: cursor }, controller.signal) as Flat;
          if (reconnectAttempts > 0) { reconnectAttempts = 0; setStatus("Working"); }
        } catch (cause) {
          if (isAbortError(cause)) throw cause;
          if (!isTransientRpcError(cause) || reconnectAttempts >= EVENT_RECONNECT_ATTEMPTS) throw cause;
          reconnectAttempts += 1;
          setStatus("Reconnecting");
          await wait(Math.min(250 * reconnectAttempts, 1_500), controller.signal);
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
      setError(cause instanceof Error ? cause.message : "Event stream failed");
      setBusy(false);
      setStatus("Connection lost");
    } finally {
      if (pollController.current === controller) pollController.current = null;
    }
  }, [refreshSessions, rpc]);

  const connect = useCallback(async (id: string) => {
    pollController.current?.abort();
    preparingController.current?.abort();
    connectController.current?.abort();
    const controller = new AbortController();
    connectController.current = controller;
    setBusy(false);
    setRunId("");
    setApproval(null);
    setConnecting(true);
    setError("");
    setStatus("Connecting");
    setHello(null);
    setMessages([]);
    setSessions([]);
    setSessionsLoading(false);
    setSessionId("");
    setQueue(emptyQueue);
    try {
      const metadata = await rpc(id, { action: "hello" }, controller.signal) as Flat;
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
        void (async () => {
          const list = await refreshSessions(id, controller.signal);
          const current = list.find((session) => session.current === 1);
          if (current && typeof current.id === "string") await loadSession(id, current.id, false, controller.signal);
        })().catch((cause) => {
          if (!isAbortError(cause)) setError(cause instanceof Error ? cause.message : "Could not load sessions");
        }).finally(() => {
          if (!controller.signal.aborted) setSessionsLoading(false);
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
    const inspect = async (initial = false) => {
      await client.refresh();
      if (disposed) return;
      if (initial && client.snapshot.turnId && !pollController.current) {
        setRunId(client.snapshot.turnId);
        setBusy(true);
        setStatus("Working");
        void pollEvents(serverId, sessionId, true, client.snapshot.turnId, true);
      }
      const pending = client.snapshot.records.some((record) => ["accepted", "uncertain"].includes(record.state));
      timer = setTimeout(() => void inspect(), client.snapshot.turnId || pending ? 2_000 : 10_000);
    };
    void inspect(true);
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
      if (queueClient.current === client) queueClient.current = null;
    };
  }, [queueSupported, serverId, sessionId, rpc, pollEvents]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/servers", { cache: "no-store" })
      .then((response) => readRpcJson<ServerSummary[]>(response))
      .then((list: ServerSummary[]) => {
        if (cancelled) return;
        setServers(list);
        if (list[0]) {
          const initialId = initialServerId.current || list[0].id;
          setServerId(initialId);
          sessionStorage.setItem("zcoder-server-id", initialId);
          void connect(initialId);
        } else {
          setConnecting(false);
          setStatus("No servers");
        }
      })
      .catch((cause) => {
        if (!cancelled) {
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
  }, [connect]);

  useEffect(() => {
    const element = transcriptRef.current;
    if (!element) return;
    requestAnimationFrame(() => { element.scrollTop = element.scrollHeight; });
  }, [messages, approval]);

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
    if (!canPrompt) return;
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
  }, [canPrompt]);

  useEffect(() => {
    if (!busy || !serverId) return;
    function stopOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (preparingController.current) { preparingController.current.abort(); return; }
      setStatus("Stopping");
      void rpc(serverId, { action: "cancel" }).catch((cause) => {
        setError(cause instanceof Error ? cause.message : "Cancellation was not acknowledged");
      });
    }
    window.addEventListener("keydown", stopOnEscape);
    return () => window.removeEventListener("keydown", stopOnEscape);
  }, [busy, rpc, serverId]);

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
      if (!resume) {
        setMessages((current) => [...current, { event: "message", role: "user", content: value, thinking: "", time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }]);
        setPrompt((current) => current === value ? "" : current);
      }
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
    setError("");
    setSessionsLoading(true);
    try {
      const result = await rpc(serverId, { action: "session.new" }) as Flat;
      if (typeof result.id !== "string") throw new Error("Server returned an invalid session id");
      await refreshSessions(serverId);
      await loadSession(serverId, result.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create a session"); }
    finally { setSessionsLoading(false); }
  }

  async function answerApproval(decision: "y" | "a" | "n") {
    if (!approval || !serverId) return;
    try {
      await rpc(serverId, { action: "approval", id: approval.id, decision });
      setApproval(null);
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
    }
  }

  async function cancelTurn() {
    if (!serverId || !busy) return;
    if (preparingController.current) { preparingController.current.abort(); return; }
    setStatus("Stopping");
    try { await rpc(serverId, { action: "cancel" }); } catch (cause) { setError(cause instanceof Error ? cause.message : "Cancellation was not acknowledged"); }
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

  return (
    <main className="console-shell">
      <header className="topbar">
        <div className="wordmark"><span><Icon name="bolt" size={17} /></span> zweb <small>/ zcoder.zsh</small></div>
        <div className="active-model" title={hello ? String(hello.model) : undefined}>{hello ? String(hello.model) : "No model connected"}</div>
        <div className="server-switcher">
          <label htmlFor="server-select">Server</label>
          <select id="server-select" value={serverId} disabled={busy || inputSending || sessionsLoading} onChange={(event) => { const id = event.target.value; sessionStorage.setItem("zcoder-server-id", id); setServerId(id); void connect(id); }}>
            {servers.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}
          </select>
        </div>
        <div className={`connection-state state-${displayStatus.toLowerCase().replaceAll(" ", "-")}`} role="status">{displayStatus}</div>
        <button type="button" className="icon-button logout-button" onClick={logout} aria-label="Log out" title="Log out"><Icon name="logout" /></button>
      </header>

      <div className="mobile-bar">
        <button type="button" className="mobile-session-trigger" aria-expanded={mobileSessions} aria-controls="session-drawer" onClick={() => setMobileSessions((open) => !open)}>
          <Icon name="server" /> Sessions <span>{sessions.length}</span>
        </button>
        <label className="mobile-server-switcher">
          <span className="sr-only">Server</span>
          <select value={serverId} aria-label="Active server" disabled={busy || inputSending || sessionsLoading} onChange={(event) => { const id = event.target.value; sessionStorage.setItem("zcoder-server-id", id); setMobileSessions(false); setServerId(id); void connect(id); }}>
            {servers.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}
          </select>
        </label>
      </div>

      <div className="workbench">
        <button type="button" className={`session-backdrop ${mobileSessions ? "visible" : ""}`} aria-label="Close sessions" tabIndex={mobileSessions ? 0 : -1} onClick={() => setMobileSessions(false)} />
        <aside id="session-drawer" className={`session-pane ${mobileSessions ? "mobile-open" : ""}`} aria-label="Remote sessions">
          <div className="pane-title"><span>Sessions ({sessions.length})</span><button type="button" className="drawer-close" aria-label="Close sessions" onClick={() => setMobileSessions(false)}>×</button></div>
          <button type="button" className="new-session" disabled={busy || inputSending || sessionsLoading || hello?.sessions !== true} onClick={createSession}><Icon name="plus" /> New session</button>
          <nav aria-label="Remote sessions">
            {sessions.map((session) => {
              const id = String(session.id);
              return (
                <button type="button" key={id} className={sessionId === id ? "active" : ""} aria-current={sessionId === id ? "true" : undefined} title={String(session.title || "Untitled session")} disabled={busy || inputSending || sessionsLoading} onClick={() => void loadSession(serverId, id, true).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not select session"))}>
                  <span className="session-rail" aria-hidden="true">{sessionId === id ? "▸" : ""}</span>
                  <span className="session-text"><strong>{String(session.title || "Untitled session")}</strong><small>{String(session.model || "Model unknown")}</small></span>
                </button>
              );
            })}
            {sessionsLoading ? <p className="empty-list">Loading sessions…</p> : !sessions.length && !connecting ? <p className="empty-list">No sessions on this server.</p> : null}
          </nav>
          {hello ? (
            <dl className="server-facts">
              <div><dt>Project</dt><dd className="workspace-name" title={String(hello.workspace)}>{String(hello.workspace)}</dd></div>
              <div><dt>Model</dt><dd className="model-name" title={String(hello.model)}>{String(hello.model)}</dd></div>
              <div><dt>Profile</dt><dd>{String(hello.profile)}</dd></div>
              <div><dt>Shell</dt><dd className={`policy-${hello.command_policy}`}>{String(hello.command_policy)}</dd></div>
            </dl>
          ) : null}
        </aside>

        <section className="transcript-pane" aria-labelledby="transcript-title">
          <div className="pane-title transcript-title"><span id="transcript-title">Agent transcript ({messages.length} events)</span></div>
          <div className="transcript" ref={transcriptRef} aria-live="polite">
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
          {error && hello ? <div className="error-strip" role="alert"><strong>!</strong><span>{error} <button type="button" onClick={() => void connect(serverId)}>Reconnect</button></span><button type="button" onClick={() => setError("")} aria-label="Dismiss error">×</button></div> : null}
          {approval ? (
            <section className="approval-bar" aria-labelledby="approval-title">
              <div><p id="approval-title"><span>!</span> Command approval required</p><code>{approval.command}</code></div>
              <div className="approval-actions"><button type="button" className="deny" onClick={() => void answerApproval("n")}>Deny</button><button type="button" onClick={() => void answerApproval("y")}>Allow once</button>{hello?.profile === "coding" ? <button type="button" className="allow" onClick={() => void answerApproval("a")}>Allow until restart</button> : null}</div>
            </section>
          ) : null}
        </section>
      </div>
      <form className="prompt-box" onSubmit={submitPrompt}>
        <label htmlFor="prompt" className="prompt-title">Prompt</label>
        {queueSupported && sessionId ? (
          <details className="queue-panel" open={queue.records.some((record) => ["uncertain", "accepted"].includes(record.state)) || Boolean(queue.pending) || Boolean(queue.error)}>
            <summary>Queued input · {queue.records.filter((record) => record.state === "accepted").length} pending from this browser</summary>
            {queue.error ? <p role="alert">{queue.error}</p> : null}
            <div className="queue-records">
              {queue.records.map((record) => (
                <article className="queue-card" key={record.request.message_id}>
                  <header><strong>{record.request.mode === "steer" ? "Steering" : "Follow-up"}</strong><span>{record.state === "uncertain" ? "Unconfirmed" : record.state === "accepted" ? (queue.turnId ? "Pending" : "Paused") : record.state === "consumed" ? "Added to history" : record.state === "discarded" ? "Discarded" : "Rejected"}</span></header>
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
                </article>
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
          <small>{busy ? queueSupported ? inputMode === "steer" ? "Joins after the current response and its tools." : "Waits until the current task finishes." : "Draft saved here until this run finishes; this server does not support queued input." : "Enter to send · Shift Enter for a newline"}</small>
          {busy ? <button type="button" className="stop-button" onClick={cancelTurn}><Icon name="stop" size={14} /> Stop</button> : null}
        </div>
        <div className="prompt-row"><span aria-hidden="true">›</span><textarea ref={promptRef} id="prompt" aria-label="Message" value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={promptKeyDown} disabled={!canPrompt} rows={1} autoFocus enterKeyHint="send" placeholder={busy ? queueSupported ? "Add steering or a follow-up…" : "Draft your next message…" : modelReady ? "Describe the job" : modelWarming ? "Model is warming up…" : "Model unavailable"} /><button type="submit" disabled={!canSend || !prompt} className="send-button"><Icon name="send" /> {busy ? inputMode === "steer" ? "Steer" : "Queue" : "Send"}</button></div>
      </form>
      <footer className="keybar"><span><kbd>Enter</kbd> Send</span><span><kbd>Shift Enter</kbd> Newline</span><span><kbd>Esc</kbd> Stop</span><span><kbd>Tab</kbd> Focus</span><span className="keybar-right">zweb · remote zcoder</span></footer>
    </main>
  );
}
