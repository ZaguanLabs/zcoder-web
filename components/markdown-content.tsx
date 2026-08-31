"use client";

import { memo } from "react";
import Markdown, { ReactRenderer } from "marked-react";

function safeHref(href: string): string | null {
  if (href.startsWith("#") || href.startsWith("/")) return href;
  try {
    const url = new URL(href, "https://zweb.invalid");
    return new Set(["http:", "https:", "mailto:"]).has(url.protocol) ? href : null;
  } catch {
    return null;
  }
}

const renderer: Partial<ReactRenderer> = {
  link(href, text) {
    const safe = safeHref(href);
    return safe
      ? <a key={this.elementId} href={safe} target="_blank" rel="noopener noreferrer">{text}</a>
      : <span key={this.elementId} className="markdown-unsafe-link">{text}</span>;
  },
  image(_src, alt) {
    return <span key={this.elementId} className="markdown-image-label">[image: {alt || "untitled"}]</span>;
  },
  table(children) {
    return <div key={this.elementId} className="markdown-table-wrap"><table>{children}</table></div>;
  },
};

export const MarkdownContent = memo(function MarkdownContent({ children, compact = false }: { children: string; compact?: boolean }) {
  return (
    <div className={compact ? "markdown markdown-compact" : "markdown"}>
      <Markdown value={children} renderer={renderer} gfm />
    </div>
  );
});
