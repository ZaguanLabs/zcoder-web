import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "@/components/markdown-content";

describe("MarkdownContent", () => {
  it("renders GFM structure as React elements", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent>{"## Result\n\n- **done**\n\n| file | state |\n| --- | --- |\n| app.ts | ok |\n\n`inline`"}</MarkdownContent>,
    );
    expect(html).toContain("<h2>");
    expect(html).toContain("<strong>");
    expect(html).toContain("markdown-table-wrap");
    expect(html).toContain("<code>");
  });

  it("keeps remote HTML, unsafe links, and images inert", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent>{"<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n![tracker](https://example.test/pixel.gif)"}</MarkdownContent>,
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
    expect(html).toContain("markdown-unsafe-link");
    expect(html).toContain("[image: tracker]");
  });
});

