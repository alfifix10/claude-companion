import { describe, expect, it } from "vitest";
import { buildSnippet } from "./search-snippet";

describe("buildSnippet — fallback", () => {
  it("null text → null", () => {
    expect(buildSnippet(null, "x")).toBeNull();
  });
  it("empty text → null", () => {
    expect(buildSnippet("", "x")).toBeNull();
  });
  it("undefined text → null", () => {
    expect(buildSnippet(undefined, "x")).toBeNull();
  });
  it("null query → null", () => {
    expect(buildSnippet("some text", null)).toBeNull();
  });
  it("empty query → null", () => {
    expect(buildSnippet("some text", "")).toBeNull();
  });
  it("query not found → null", () => {
    expect(buildSnippet("hello world", "zzz")).toBeNull();
  });
});

describe("buildSnippet — basic highlighting", () => {
  it("exact match", () => {
    const out = buildSnippet("hello world", "world");
    expect(out).toBe("hello <mark>world</mark>");
  });

  it("case-insensitive — query 'World' matches 'world'", () => {
    const out = buildSnippet("hello world", "World");
    expect(out).toBe("hello <mark>world</mark>");
  });

  it("case-insensitive — preserves the original casing in hit", () => {
    const out = buildSnippet("say HELLO now", "hello");
    expect(out).toBe("say <mark>HELLO</mark> now");
  });

  it("first occurrence wins (only first is highlighted)", () => {
    const out = buildSnippet("abc foo bar foo baz", "foo");
    expect(out).toMatch(/<mark>foo<\/mark>/);
    // Match is the FIRST foo; the second stays unwrapped
    const marks = out?.match(/<mark>/g) ?? [];
    expect(marks).toHaveLength(1);
  });
});

describe("buildSnippet — context window + ellipsis", () => {
  it("short text, no clipping needed", () => {
    const out = buildSnippet("abc foo xyz", "foo");
    expect(out).not.toContain("…");
  });

  it("long prefix is elided with … on the left", () => {
    const long = `${"x".repeat(100)}HIT${"x".repeat(100)}`;
    const out = buildSnippet(long, "HIT", 20);
    expect(out).toMatch(/^…/);
    expect(out).toMatch(/…$/);
    expect(out).toContain("<mark>HIT</mark>");
  });

  it("windowChars sizes the context on each side", () => {
    const text = `${"x".repeat(50)}HIT${"y".repeat(50)}`;
    const out = buildSnippet(text, "HIT", 10);
    // Expect roughly: …(10 x's)<mark>HIT</mark>(10 y's)…
    expect(out).toMatch(/^…x{10}<mark>HIT<\/mark>y{10}…$/);
  });

  it("hit near start — no leading ellipsis", () => {
    const out = buildSnippet("HIT then more text", "HIT", 20);
    expect(out).not.toMatch(/^…/);
  });

  it("hit near end — no trailing ellipsis", () => {
    const out = buildSnippet("earlier text HIT", "HIT", 20);
    expect(out).not.toMatch(/…$/);
  });
});

describe("buildSnippet — HTML escaping", () => {
  it("escapes < and > in surrounding context", () => {
    const out = buildSnippet("before <script> foo </script> after", "foo");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&lt;/script&gt;");
    expect(out).not.toContain("<script>");
  });

  it("escapes the hit itself", () => {
    const out = buildSnippet('the <img onerror="x"> tag', "img");
    expect(out).toContain("<mark>img</mark>");
    expect(out).toContain("&lt;");
    expect(out).not.toContain("<img");
  });

  it("ampersands escaped", () => {
    const out = buildSnippet("AT&T is a company", "T&T");
    expect(out).toContain("A<mark>T&amp;T</mark>");
  });

  it("quotes escaped", () => {
    const out = buildSnippet(`say "hi" now`, "hi");
    expect(out).toContain("&quot;");
  });
});

describe("buildSnippet — Arabic text", () => {
  it("highlights Arabic substring", () => {
    const out = buildSnippet("ابحث عن Gmail في الصفحة", "Gmail");
    expect(out).toBe("ابحث عن <mark>Gmail</mark> في الصفحة");
  });

  it("Arabic query in Arabic text", () => {
    const out = buildSnippet("لخّص هذه الصفحة من فضلك", "الصفحة");
    expect(out).toContain("<mark>الصفحة</mark>");
  });
});
