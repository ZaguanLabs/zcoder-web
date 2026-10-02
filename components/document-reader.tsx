"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import dynamic from "next/dynamic";

const MarkdownContent = dynamic(
  () => import("@/components/markdown-content").then((module) => module.MarkdownContent),
  { loading: () => <span className="markdown-loading">Formatting…</span> },
);

type Document = { path: string; text: string };
type Props = {
  serverId: string;
  supported: boolean;
  available: boolean;
  approvalPending: boolean;
  rpc: (id: string, body: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  onReadingChange: (reading: boolean) => void;
  onCodingFocus: () => void;
  children: ReactNode;
};

export function DocumentReader({ serverId, supported, available, approvalPending, rpc, onReadingChange, onCodingFocus, children }: Props) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [activePath, setActivePath] = useState("");
  const [path, setPath] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const pathInput = useRef<HTMLInputElement>(null);
  const panelId = useId();
  const canRead = supported && available && !loading && !approvalPending;

  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    onReadingChange(Boolean(activePath));
    return () => onReadingChange(false);
  }, [activePath, onReadingChange]);

  function select(path: string) {
    setActivePath(path);
    if (!path) onCodingFocus();
  }

  async function read(path: string) {
    if (!canRead || !path || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const result = await rpc(serverId, { action: "document.read", path }, controller.signal);
      if (controller.signal.aborted) return;
      if (!result || typeof result !== "object" || !("path" in result) || typeof result.path !== "string" || !result.path ||
        !("text" in result) || typeof result.text !== "string") throw new Error("Remote server returned an invalid document");
      const document = { path: result.path, text: result.text };
      const exists = documents.some((item) => item.path === document.path);
      if (!exists && documents.length >= 4) throw new Error("Close a document before opening another. Four documents can be open at once.");
      setDocuments((current) => exists ? current.map((item) => item.path === document.path ? document : item) : [...current, document]);
      select(document.path);
      setOpen(false);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not read the document");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (request.current === controller) request.current = null;
    }
  }

  function close(path: string) {
    setDocuments((current) => current.filter((item) => item.path !== path));
    select("");
    setError("");
  }

  return (
    <div className="document-reader" inert={approvalPending ? true : undefined}>
      <div className="document-toolbar">
        {documents.length ? <nav className="document-tabs" aria-label="Workspace views">
          <button type="button" aria-current={!activePath ? "page" : undefined} onClick={() => select("")}>Coding</button>
          {documents.map((document) => <span className="document-tab" key={document.path}>
            <button type="button" title={document.path} aria-current={activePath === document.path ? "page" : undefined} onClick={() => select(document.path)}>{document.path}</button>
            <button type="button" aria-label={`Close ${document.path}`} disabled={loading} onClick={() => close(document.path)}>×</button>
          </span>)}
        </nav> : <span className="document-hint">Workspace documents</span>}
        <button type="button" aria-expanded={open} aria-controls={panelId} onClick={() => {
          setOpen((value) => !value);
          if (!open) requestAnimationFrame(() => pathInput.current?.focus());
        }}>Open document</button>
        {activePath ? <button type="button" disabled={!canRead} onClick={() => void read(activePath)}>{loading ? "Reading…" : "Reload"}</button> : null}
      </div>
      {open ? <form id={panelId} className="document-open" onSubmit={(event) => { event.preventDefault(); void read(path); }}>
        {supported ? <>
          <label htmlFor={`${panelId}-path`}>Markdown path</label>
          <input ref={pathInput} id={`${panelId}-path`} value={path} onChange={(event) => setPath(event.target.value)} placeholder="docs/Design notes.md" autoComplete="off" spellCheck={false} />
          <button type="submit" disabled={!canRead || !path}>{loading ? "Reading…" : "Open"}</button>
        </> : <p role="status">This server does not support document reading. Update the zcoder server to enable it.</p>}
      </form> : null}
      {error ? <div className="document-error" role="alert">{error}<button type="button" aria-label="Dismiss document error" onClick={() => setError("")}>×</button></div> : null}
      <div className="coding-view" hidden={Boolean(activePath)}>{children}</div>
      {documents.map((document) => <section key={document.path} className="document-view" hidden={activePath !== document.path} aria-label={document.path} tabIndex={0}>
        <header><strong>{document.path}</strong><span>Read only</span></header>
        {document.text ? <MarkdownContent>{document.text}</MarkdownContent> : <p className="document-hint">Empty document.</p>}
      </section>)}
    </div>
  );
}
