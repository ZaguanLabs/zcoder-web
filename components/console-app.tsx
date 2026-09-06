"use client";

import { FormEvent, KeyboardEvent, memo, useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { isTransientRpcError, readRpcJson } from "@/lib/client-rpc";

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
  const [serverId, setServerId] = useState(() => sessionStorage.getItem("zcoder-server-id") ?? "");
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
  const initialServerId = useRef(serverId);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const connectController = useRef<AbortController | null>(null);
  const pollController = useRef<AbortController | null>(null);
  const modelWarming = hello?.model_status === "warming";
  const modelReady = Boolean(hello) && !modelWarming && hello?.model_status !== "error";
  const canPrompt = modelReady && !busy && !approval;
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
    if (select) await rpc(id, { action: "session.select", id: targetId }, signal);
    const transcript = await rpc(id, { action: "session.load", id: targetId }, signal) as Flat[];
    setSessionId(targetId);
    setMessages(transcript);
    setMobileSessions(false);
    if (select) await refreshSessions(id, signal);
  }, [refreshSessions, rpc]);

  const connect = useCallback(async (id: string) => {
    pollController.current?.abort();
    connectController.current?.abort();
    const controller = new AbortController();
    connectController.current = controller;
    setConnecting(true);
    setError("");
    setStatus("Connecting");
    setHello(null);
    setMessages([]);
    setSessions([]);
    setSessionsLoading(false);
    setSessionId("");
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
          } else {
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
      setStatus("Stopping");
      void rpc(serverId, { action: "cancel" }).catch((cause) => {
        setError(cause instanceof Error ? cause.message : "Cancellation was not acknowledged");
      });
    }
    window.addEventListener("keydown", stopOnEscape);
    return () => window.removeEventListener("keydown", stopOnEscape);
  }, [busy, rpc, serverId]);

  async function pollEvents(id: string) {
    const controller = new AbortController();
    pollController.current = controller;
    let cursor = 0;
    let reconnectAttempts = 0;
    try {
      while (!controller.signal.aborted) {
        let event: Flat;
        try {
          event = await rpc(id, { action: "events.next", after: cursor }, controller.signal) as Flat;
          if (reconnectAttempts > 0) {
            reconnectAttempts = 0;
            setStatus("Working");
          }
        } catch (cause) {
          if (isAbortError(cause)) throw cause;
          if (!isTransientRpcError(cause) || reconnectAttempts >= EVENT_RECONNECT_ATTEMPTS) throw cause;
          reconnectAttempts += 1;
          setStatus("Reconnecting");
          await wait(Math.min(250 * reconnectAttempts, 1_500), controller.signal);
          continue;
        }
        if (event.event === "none") {
          await wait(550, controller.signal);
          continue;
        }
        if (typeof event.seq === "number") cursor = event.seq;
        if (event.event === "message") setMessages((current) => [...current, event]);
        if (event.event === "status") setStatus(String(event.status || "Working"));
        if (event.event === "approval_required") {
          setApproval({ id: String(event.id), command: String(event.command) });
          setStatus("Approval required");
        }
        if (event.event === "complete") {
          setBusy(false);
          setApproval(null);
          setStatus(event.exit_code === 0 ? "Ready" : event.exit_code === 130 ? "Stopped" : `Exited ${event.exit_code}`);
          await refreshSessions(id).catch(() => undefined);
          return;
        }
      }
    } catch (cause) {
      if (isAbortError(cause)) return;
      setError(cause instanceof Error ? cause.message : "Event stream failed");
      setBusy(false);
      setStatus("Connection lost");
    }
  }

  async function submitPrompt(event: FormEvent) {
    event.preventDefault();
    const value = prompt.trim();
    if (!value || !serverId || busy) return;
    setError("");
    setBusy(true);
    setStatus("Checking model");
    setMessages((current) => [...current, { event: "message", role: "user", content: value, thinking: "", time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }]);
    setPrompt("");
    try {
      let model = await rpc(serverId, { action: "model.ensure" }) as Flat;
      while (model.model_status === "warming") {
        setStatus("Warming up");
        await new Promise((resolve) => setTimeout(resolve, 700));
        model = await rpc(serverId, { action: "model.get" }) as Flat;
      }
      if (model.model_status === "error") throw new Error(String(model.model_error || "Model preparation failed"));
      setStatus("Starting turn");
      await rpc(serverId, { action: "turn.start", prompt: value });
      setStatus("Working");
      void pollEvents(serverId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the turn");
      setBusy(false);
      setStatus("Ready");
    }
  }

  async function createSession() {
    if (!serverId || busy) return;
    setError("");
    try {
      const result = await rpc(serverId, { action: "session.new" }) as Flat;
      if (typeof result.id !== "string") throw new Error("Server returned an invalid session id");
      await refreshSessions(serverId);
      await loadSession(serverId, result.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create a session"); }
  }

  async function answerApproval(decision: "y" | "a" | "n") {
    if (!approval || !serverId) return;
    try {
      await rpc(serverId, { action: "approval", id: approval.id, decision });
      setApproval(null);
      setStatus(decision === "n" ? "Command denied" : "Working");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Approval failed"); }
  }

  async function cancelTurn() {
    if (!serverId || !busy) return;
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
        <div className="wordmark"><span><Icon name="bolt" size={17} /></span> zweb <small>/ remote zcoder</small></div>
        <div className="server-switcher">
          <label htmlFor="server-select">Server</label>
          <select id="server-select" value={serverId} disabled={busy} onChange={(event) => { const id = event.target.value; sessionStorage.setItem("zcoder-server-id", id); setServerId(id); void connect(id); }}>
            {servers.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}
          </select>
        </div>
        <div className={`connection-state state-${displayStatus.toLowerCase().replaceAll(" ", "-")}`} role="status"><span />{displayStatus}</div>
        <button type="button" className="icon-button logout-button" onClick={logout} aria-label="Log out" title="Log out"><Icon name="logout" /></button>
      </header>

      <div className="mobile-bar">
        <button type="button" className="mobile-session-trigger" aria-expanded={mobileSessions} aria-controls="session-drawer" onClick={() => setMobileSessions((open) => !open)}>
          <Icon name="server" /> Sessions <span>{sessions.length}</span>
        </button>
        <label className="mobile-server-switcher">
          <span className="sr-only">Server</span>
          <select value={serverId} aria-label="Active server" disabled={busy} onChange={(event) => { const id = event.target.value; sessionStorage.setItem("zcoder-server-id", id); setMobileSessions(false); setServerId(id); void connect(id); }}>
            {servers.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}
          </select>
        </label>
      </div>

      <div className="workbench">
        <button type="button" className={`session-backdrop ${mobileSessions ? "visible" : ""}`} aria-label="Close sessions" tabIndex={mobileSessions ? 0 : -1} onClick={() => setMobileSessions(false)} />
        <aside id="session-drawer" className={`session-pane ${mobileSessions ? "mobile-open" : ""}`} aria-label="Remote sessions">
          <div className="pane-title"><span>Sessions</span><b>{String(sessions.length).padStart(2, "0")}</b><button type="button" className="drawer-close" aria-label="Close sessions" onClick={() => setMobileSessions(false)}>×</button></div>
          <button type="button" className="new-session" disabled={busy || sessionsLoading || !hello} onClick={createSession}><Icon name="plus" /> New session</button>
          <nav aria-label="Remote sessions">
            {sessions.map((session) => {
              const id = String(session.id);
              return (
                <button type="button" key={id} className={sessionId === id ? "active" : ""} disabled={busy} onClick={() => void loadSession(serverId, id, true)}>
                  <span className="session-rail" />
                  <span className="session-text"><strong>{String(session.title || "Untitled session")}</strong><small>{String(session.model || "Model unknown")}</small></span>
                  <Icon name="chevron" size={13} />
                </button>
              );
            })}
            {sessionsLoading ? <p className="empty-list">Loading sessions…</p> : !sessions.length && !connecting ? <p className="empty-list">No sessions on this server.</p> : null}
          </nav>
          {hello ? (
            <dl className="server-facts">
              <div><dt>Workspace</dt><dd title={String(hello.workspace)}>{String(hello.workspace)}</dd></div>
              <div><dt>Model</dt><dd>{String(hello.model)}</dd></div>
              <div><dt>Profile</dt><dd>{String(hello.profile)}</dd></div>
              <div><dt>Shell</dt><dd className={`policy-${hello.command_policy}`}>{String(hello.command_policy)}</dd></div>
            </dl>
          ) : null}
        </aside>

        <section className="transcript-pane">
          <div className="pane-title transcript-title"><span>Agent transcript</span><b>{messages.length} events</b><small>{hello ? String(hello.model) : "protocol 1"}</small></div>
          <div className="transcript" ref={transcriptRef} aria-live="polite">
            {connecting ? <div className="loading-state"><span /><p>Establishing secure gateway</p></div> : null}
            {!connecting && !hello ? (
              <div className="empty-state"><Icon name="server" size={28} /><h2>{servers.length ? "Server unavailable" : "No servers configured"}</h2><p>{servers.length ? "Check the tunnel, zcoder process, and token." : "Add ZCODER_SERVERS_JSON to .env, then restart zweb."}</p>{error ? <code>{error}</code> : null}{servers.length && serverId ? <button type="button" className="retry-button" onClick={() => void connect(serverId)}>Reconnect</button> : null}</div>
            ) : null}
            {!connecting && hello && !messages.length ? (
              <div className="empty-state ready-empty">
                <span className="prompt-symbol">›_</span>
                <h2>{modelReady ? "Ready for a job" : modelWarming ? "Model warming up" : "Model unavailable"}</h2>
                <p>{modelReady ? "Start a new turn in the selected server session." : modelWarming ? "Sessions remain available while the model prepares." : "Sessions remain available while the model is unavailable."}</p>
              </div>
            ) : null}
            {messages.map((message, index) => <TranscriptMessage key={`${String(message.seq ?? "local")}-${index}`} event={message} />)}
          </div>
          {error && hello ? <div className="error-strip" role="alert"><strong>!</strong><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss error">×</button></div> : null}
          {approval ? (
            <section className="approval-bar" aria-labelledby="approval-title">
              <div><p id="approval-title"><span>!</span> Command approval required</p><code>{approval.command}</code></div>
              <div className="approval-actions"><button type="button" className="deny" onClick={() => void answerApproval("n")}>Deny</button><button type="button" onClick={() => void answerApproval("y")}>Allow once</button><button type="button" className="allow" onClick={() => void answerApproval("a")}>Allow until restart</button></div>
            </section>
          ) : null}
          <form className="prompt-box" onSubmit={submitPrompt}>
            <div className="prompt-row"><span aria-hidden="true">›</span><textarea ref={promptRef} id="prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={promptKeyDown} disabled={!canPrompt} rows={1} autoFocus enterKeyHint="send" placeholder={busy ? "Agent is working…" : modelReady ? "Describe the job" : modelWarming ? "Model is warming up…" : "Model unavailable"} /><button type={busy ? "button" : "submit"} onClick={busy ? cancelTurn : undefined} disabled={!hello || !modelReady || (!busy && !prompt.trim())} className={busy ? "stop-button" : "send-button"}>{busy ? <><Icon name="stop" /> Stop</> : <><Icon name="send" /> Send</>}</button></div>
          </form>
        </section>
      </div>
      <footer className="keybar"><span><kbd>Enter</kbd> Send</span><span><kbd>Shift Enter</kbd> Newline</span><span><kbd>Esc</kbd> Stop</span><span className="keybar-right">Protocol 1 · browser secrets: none</span></footer>
    </main>
  );
}
