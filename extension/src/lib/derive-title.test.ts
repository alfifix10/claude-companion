import { describe, expect, it } from "vitest";
import { type Message, deriveTitle } from "./derive-title";

describe("deriveTitle — fallback", () => {
  it("null messages → 'محادثة جديدة'", () => {
    expect(deriveTitle(null)).toBe("محادثة جديدة");
  });

  it("undefined messages → 'محادثة جديدة'", () => {
    expect(deriveTitle(undefined)).toBe("محادثة جديدة");
  });

  it("empty array → 'محادثة جديدة'", () => {
    expect(deriveTitle([])).toBe("محادثة جديدة");
  });

  it("only assistant messages → 'محادثة جديدة'", () => {
    const msgs: Message[] = [{ role: "assistant", content: "hi" }];
    expect(deriveTitle(msgs)).toBe("محادثة جديدة");
  });

  it("first user content is non-string → 'محادثة بصور'", () => {
    const msgs: Message[] = [{ role: "user", content: { some: "object" } }];
    expect(deriveTitle(msgs)).toBe("محادثة بصور");
  });

  it("first user content is empty string → 'محادثة بصور'", () => {
    const msgs: Message[] = [{ role: "user", content: "" }];
    expect(deriveTitle(msgs)).toBe("محادثة بصور");
  });

  it("first user content is only markdown noise → 'محادثة بصور'", () => {
    const msgs: Message[] = [{ role: "user", content: "*_`#>*_`#>" }];
    expect(deriveTitle(msgs)).toBe("محادثة بصور");
  });
});

describe("deriveTitle — normal use", () => {
  it("simple short user message", () => {
    const msgs: Message[] = [{ role: "user", content: "لخّص هذه الصفحة" }];
    expect(deriveTitle(msgs)).toBe("لخّص هذه الصفحة");
  });

  it("picks the FIRST user message (skips assistant)", () => {
    const msgs: Message[] = [
      { role: "assistant", content: "hi there!" },
      { role: "user", content: "the real question" },
    ];
    expect(deriveTitle(msgs)).toBe("the real question");
  });

  it("skips to first user even if multiple assistants precede", () => {
    const msgs: Message[] = [
      { role: "assistant", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "the question" },
    ];
    expect(deriveTitle(msgs)).toBe("the question");
  });
});

describe("deriveTitle — markdown noise stripping", () => {
  it("strips asterisks", () => {
    const msgs: Message[] = [{ role: "user", content: "**bold** and *italic*" }];
    expect(deriveTitle(msgs)).toBe("bold and italic");
  });

  it("strips backticks", () => {
    const msgs: Message[] = [{ role: "user", content: "call `foo()` please" }];
    expect(deriveTitle(msgs)).toBe("call foo() please");
  });

  it("strips headings / blockquote markers then collapses whitespace", () => {
    const msgs: Message[] = [{ role: "user", content: "# big > quote" }];
    // `# ` + `> ` removed → "  big   quote" → collapsed + trimmed
    expect(deriveTitle(msgs)).toBe("big quote");
  });

  it("strips underscores", () => {
    const msgs: Message[] = [{ role: "user", content: "some_var_name" }];
    expect(deriveTitle(msgs)).toBe("somevarname");
  });
});

describe("deriveTitle — whitespace collapsing", () => {
  it("collapses multiple spaces", () => {
    const msgs: Message[] = [{ role: "user", content: "hello   world" }];
    expect(deriveTitle(msgs)).toBe("hello world");
  });

  it("collapses tabs and newlines", () => {
    const msgs: Message[] = [{ role: "user", content: "hello\n\tworld\n\nagain" }];
    expect(deriveTitle(msgs)).toBe("hello world again");
  });

  it("trims leading / trailing whitespace", () => {
    const msgs: Message[] = [{ role: "user", content: "   padded   " }];
    expect(deriveTitle(msgs)).toBe("padded");
  });
});

describe("deriveTitle — length cap", () => {
  it("keeps message at exactly 40 chars", () => {
    const forty = "x".repeat(40);
    const msgs: Message[] = [{ role: "user", content: forty }];
    expect(deriveTitle(msgs)).toBe(forty);
    expect(deriveTitle(msgs)).not.toContain("…");
  });

  it("truncates + adds … when over 40 chars", () => {
    const long = "x".repeat(100);
    const msgs: Message[] = [{ role: "user", content: long }];
    const out = deriveTitle(msgs);
    expect(out).toBe(`${"x".repeat(40)}…`);
    expect(out.length).toBe(41); // 40 + ellipsis char
  });

  it("truncates Arabic at 40 chars", () => {
    // 42 Arabic chars → cap at 40 + …
    const arabic = "ابحث في يوتيوب عن أفضل مقاطع تعلّم البرمجة بالعربية";
    const msgs: Message[] = [{ role: "user", content: arabic }];
    const out = deriveTitle(msgs);
    if (arabic.length > 40) {
      expect(out.endsWith("…")).toBe(true);
    }
  });
});
