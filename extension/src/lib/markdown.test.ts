import { describe, expect, it } from "vitest";
import { escapeHtml, renderMarkdown } from "./markdown";

describe("escapeHtml", () => {
  it("escapes the five sensitive chars", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });

  it("handles null / undefined / numbers", () => {
    expect(escapeHtml(null)).toBe("null");
    expect(escapeHtml(undefined)).toBe("undefined");
    expect(escapeHtml(42)).toBe("42");
  });
});

describe("renderMarkdown — empty / falsy input", () => {
  it("empty string → empty", () => {
    expect(renderMarkdown("")).toBe("");
  });

  it("null → empty", () => {
    expect(renderMarkdown(null)).toBe("");
  });

  it("undefined → empty", () => {
    expect(renderMarkdown(undefined)).toBe("");
  });
});

describe("renderMarkdown — inline", () => {
  it("bold", () => {
    expect(renderMarkdown("**hello**")).toBe("<p><strong>hello</strong></p>");
  });

  it("italic", () => {
    expect(renderMarkdown("*hello*")).toBe("<p><em>hello</em></p>");
  });

  it("inline code", () => {
    expect(renderMarkdown("`foo`")).toBe("<p><code>foo</code></p>");
  });

  it("combined inline on one line", () => {
    expect(renderMarkdown("**bold** and *italic* and `code`")).toBe(
      "<p><strong>bold</strong> and <em>italic</em> and <code>code</code></p>",
    );
  });

  it("preserves plain text", () => {
    expect(renderMarkdown("just some words")).toBe("<p>just some words</p>");
  });
});

describe("renderMarkdown — headings", () => {
  it("# h2", () => {
    expect(renderMarkdown("# Big")).toBe("<h2>Big</h2>");
  });

  it("## h3", () => {
    expect(renderMarkdown("## Title")).toBe("<h3>Title</h3>");
  });

  it("### h4", () => {
    expect(renderMarkdown("### Section")).toBe("<h4>Section</h4>");
  });

  it("#### h5", () => {
    expect(renderMarkdown("#### Smaller")).toBe("<h5>Smaller</h5>");
  });

  it("mid-line # is not a heading", () => {
    // should NOT be treated as a heading — # not at start of line
    expect(renderMarkdown("prefix # Big")).not.toContain("<h2>");
  });
});

describe("renderMarkdown — lists", () => {
  it("unordered with -", () => {
    expect(renderMarkdown("- one\n- two")).toBe("<ul><li>one</li><li>two</li></ul>");
  });

  it("unordered with *", () => {
    expect(renderMarkdown("* alpha\n* beta")).toBe("<ul><li>alpha</li><li>beta</li></ul>");
  });

  it("ordered (1. 2.)", () => {
    expect(renderMarkdown("1. first\n2. second")).toBe("<ol><li>first</li><li>second</li></ol>");
  });
});

describe("renderMarkdown — fenced code blocks", () => {
  it("basic code block", () => {
    const out = renderMarkdown("```\nconst x = 1;\n```");
    expect(out).toContain("<pre><code>const x = 1;</code></pre>");
  });

  it("code block with language tag (ignored, still escapes content)", () => {
    const out = renderMarkdown("```js\nconst x = 1;\n```");
    expect(out).toContain("<pre><code>const x = 1;</code></pre>");
  });

  it("code block escapes HTML inside", () => {
    const out = renderMarkdown("```\n<script>bad</script>\n```");
    expect(out).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(out).not.toContain("<script>");
  });

  it("code block is untouched by inline rules", () => {
    const out = renderMarkdown("```\n**not bold**\n```");
    expect(out).toContain("**not bold**");
    expect(out).not.toContain("<strong>");
  });
});

describe("renderMarkdown — tables", () => {
  it("simple 2×2 table", () => {
    const md = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |";
    const out = renderMarkdown(md);
    expect(out).toContain("<table>");
    expect(out).toContain("<thead><tr><th>a</th><th>b</th></tr></thead>");
    expect(out).toContain("<tbody>");
    expect(out).toContain("<tr><td>1</td><td>2</td></tr>");
    expect(out).toContain("<tr><td>3</td><td>4</td></tr>");
  });
});

describe("renderMarkdown — links (XSS hardening)", () => {
  it("absolute https URL is kept", () => {
    const out = renderMarkdown("[click](https://example.com)");
    expect(out).toContain(
      `<a href="https://example.com/" target="_blank" rel="noopener noreferrer">click</a>`,
    );
  });

  it("relative URL is kept", () => {
    const out = renderMarkdown("[home](/dash)");
    expect(out).toContain(`<a href="/dash"`);
  });

  it("anchor is kept", () => {
    const out = renderMarkdown("[top](#intro)");
    expect(out).toContain(`<a href="#intro"`);
  });

  it("mailto is kept", () => {
    const out = renderMarkdown("[mail](mailto:a@b.c)");
    expect(out).toContain(`<a href="mailto:a@b.c"`);
  });

  it("javascript: is REJECTED (rendered as plain text)", () => {
    const out = renderMarkdown("[click](javascript:alert(1))");
    expect(out).not.toContain("javascript");
    expect(out).not.toContain("<a ");
  });

  it("URL with whitespace is REJECTED", () => {
    const out = renderMarkdown("[click](https://x onmouseover=alert(1))");
    expect(out).not.toContain("<a ");
    expect(out).toContain("click");
  });

  it("URL with control char is REJECTED", () => {
    const out = renderMarkdown("[x](https://evil.com\u0000)");
    expect(out).not.toContain("<a ");
  });

  it("unparseable URL is REJECTED", () => {
    const out = renderMarkdown("[x](https://)");
    expect(out).not.toContain("<a ");
  });
});

describe("renderMarkdown — escaping", () => {
  it("raw HTML in body is escaped", () => {
    const out = renderMarkdown("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script>");
  });

  it("ampersand is escaped", () => {
    expect(renderMarkdown("AT&T")).toContain("AT&amp;T");
  });

  it("quote inside text is escaped", () => {
    expect(renderMarkdown(`say "hi"`)).toContain("&quot;hi&quot;");
  });
});

describe("renderMarkdown — paragraph handling", () => {
  it("double newline = separate paragraphs", () => {
    expect(renderMarkdown("one\n\ntwo")).toBe("<p>one</p><p>two</p>");
  });

  it("single newline = <br>", () => {
    expect(renderMarkdown("one\ntwo")).toBe("<p>one<br>two</p>");
  });

  it("heading isn't wrapped in <p>", () => {
    expect(renderMarkdown("# Title")).toBe("<h2>Title</h2>");
  });

  it("list isn't wrapped in <p>", () => {
    expect(renderMarkdown("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
  });
});

describe("renderMarkdown — combined document", () => {
  it("mixed content renders end-to-end", () => {
    const md = "# Title\n\nSome **bold** text.\n\n- item 1\n- item 2\n\n```\ncode\n```";
    const out = renderMarkdown(md);
    expect(out).toContain("<h2>Title</h2>");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<li>item 1</li>");
    expect(out).toContain("<pre><code>code</code></pre>");
  });
});
