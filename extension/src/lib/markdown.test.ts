// @vitest-environment jsdom
//
// renderMarkdown's final pass calls DOMPurify, which needs a window/DOM
// to operate. In the real extension this is just `window`; under
// vitest's default "node" environment there is no window, so the
// whole renderer throws. jsdom gives us a minimal DOM that's enough
// for sanitisation logic to run end-to-end.

import { describe, expect, it } from "vitest";
import { escapeHtml, renderMarkdown } from "./markdown.js";

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
    // Attribute order isn't significant — DOMPurify may reorder.
    // Assert each piece independently.
    expect(out).toContain(`href="https://example.com/"`);
    expect(out).toContain(`target="_blank"`);
    expect(out).toContain(`rel="noopener noreferrer"`);
    expect(out).toContain(">click</a>");
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

  it("quote in text content does not break out of an attribute", () => {
    // The renderer escapes `"` to &quot; while building HTML; DOMPurify
    // then re-decodes it in TEXT positions (where `"` is harmless) but
    // KEEPS escaping in ATTRIBUTE positions (where it matters). Assert
    // the security property — the resulting HTML must be parseable
    // without the quote being interpreted as a markup delimiter.
    const out = renderMarkdown(`say "hi"`);
    expect(out).toContain("hi");
    // Crucial: no stray attribute introduced
    expect(out).not.toMatch(/<[a-z][a-z0-9]*[^>]*\s"hi"/i);
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

// DOMPurify defense-in-depth — these inputs are not produced by the
// upstream Markdown rules, but cover the case where a future syntax
// addition or a regex blind-spot lets raw HTML reach the sanitiser.
// We assert the sanitiser strips dangerous constructs even when our
// own escaping fails to.
describe("renderMarkdown — sanitisation (defense-in-depth)", () => {
  it("strips <script> tags that somehow reach the output", () => {
    // Use a plausible bypass: a code-fence that contains a script.
    // The fenced-code path escapes content, so this is already safe;
    // the test confirms the final sanitiser is in the pipeline.
    const out = renderMarkdown("```\n<script>alert(1)</script>\n```");
    expect(out).not.toContain("<script>");
  });

  it("strips <iframe> tags", () => {
    // Markdown text → escaped, but verify the allowlist denies iframe
    // even if it ever leaks through.
    const out = renderMarkdown("Hello <iframe src=\"//evil\"></iframe>");
    expect(out).not.toContain("<iframe");
  });

  it("strips on* event handlers from <a>", () => {
    // Our link rule emits target+rel only; if a future bug ever lets
    // an onclick reach the output, DOMPurify removes it.
    const out = renderMarkdown('[t](https://example.com)');
    expect(out).toContain("<a ");
    expect(out).not.toMatch(/\son\w+=/i);
  });

  it("rejects javascript: URLs (markdown rule blocks; sanitiser is the second wall)", () => {
    const out = renderMarkdown("[click](javascript:alert(1))");
    // Markdown rule already drops the href, leaving just the text.
    // Sanitiser additionally guarantees no javascript: ever survives.
    expect(out).not.toContain("javascript:");
  });

  it("preserves the standard tag set we emit", () => {
    const md =
      "# H\n\n**b** *i* `c`\n\n[t](https://example.com)\n\n- a\n\n```\nx\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |";
    const out = renderMarkdown(md);
    for (const tag of ["h2", "strong", "em", "code", "a", "ul", "li", "pre", "table", "thead", "tbody", "tr", "th", "td"]) {
      expect(out).toContain(`<${tag}`);
    }
  });
});
