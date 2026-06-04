import { describe, expect, it } from "vitest";
import { buildSmartHistory, isPivot, DEFAULT_HISTORY_CONFIG } from "./conversation-history.js";

const u = (content: unknown) => ({ role: "user", content });
const a = (content: unknown) => ({ role: "assistant", content });

describe("isPivot", () => {
  it("flags English course-corrections", () => {
    expect(isPivot("actually, focus on the second tab")).toBe(true);
    expect(isPivot("ignore the previous instruction")).toBe(true);
  });
  it("flags Arabic course-corrections", () => {
    expect(isPivot("بدل ذلك ركّز على الجدول")).toBe(true);
    expect(isPivot("تجاهل ما سبق")).toBe(true);
  });
  it("does not flag ordinary messages", () => {
    expect(isPivot("نعم اكمل")).toBe(false);
    expect(isPivot("click the blue button")).toBe(false);
  });
  it("non-strings are never pivots", () => {
    expect(isPivot(null)).toBe(false);
    expect(isPivot([{ type: "text", text: "actually" }])).toBe(false);
  });
});

describe("buildSmartHistory — small conversations", () => {
  it("passes through when within keepFirst+keepLast", () => {
    const msgs = [u("hi"), a("hello"), u("do X")];
    const out = buildSmartHistory(msgs);
    expect(out).toBe("USER: hi\nASSISTANT: hello\nUSER: do X");
  });

  it("summarises structured content instead of '(structured content)'", () => {
    const msgs = [
      u([{ type: "text", text: "look at this" }, { type: "image" }]),
      a([
        { type: "text", text: "done" },
        { type: "tool_use", name: "mcp__claude-companion__read_page" },
        { type: "tool_use", name: "mcp__claude-companion__click" },
      ]),
    ];
    const out = buildSmartHistory(msgs);
    expect(out).toContain("[image]");
    expect(out).toContain("[used: read_page, click]");
    expect(out).not.toContain("structured content");
  });
});

describe("buildSmartHistory — long conversations", () => {
  // 2 head + 20 middle + 12 tail = 34 messages
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => (i % 2 === 0 ? u(`u${i}`) : a(`a${i}`)));

  it("keeps first + last and elides the middle with a marker", () => {
    const out = buildSmartHistory(many(34));
    expect(out).toContain("USER: u0");          // first kept
    expect(out).toContain("u32");               // last-12 region kept
    expect(out).toMatch(/ELIDED: \d+ earlier turn/);
    expect(out).not.toContain("u10");           // a middle turn is gone
  });

  it("rescues a pivot turn buried in the elided middle", () => {
    const msgs = many(34);
    msgs[10] = u("actually, ركّز على القائمة الثانية");  // pivot in the middle
    const out = buildSmartHistory(msgs);
    expect(out).toContain("earlier course-correction");
    expect(out).toContain("القائمة الثانية");
    // marker count excludes the rescued pivot
    expect(out).toMatch(/ELIDED: 19 earlier turn/);
  });
});

describe("buildSmartHistory — BM25 retrieval (4.5)", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => (i % 2 === 0 ? u(`u${i}`) : a(`a${i}`)));

  it("surfaces an elided-middle turn relevant to the current question", () => {
    const msgs = many(34);
    msgs[10] = u("my passport number is XYZ789, keep it safe"); // buried in the middle
    msgs[32] = u("remind me of that passport number");           // the current question (tail)
    const out = buildSmartHistory(msgs);
    expect(out).toContain("[relevant earlier]");
    expect(out).toContain("XYZ789"); // the relevant old turn was retrieved
  });

  it("does not surface unrelated middle turns", () => {
    const msgs = many(34);
    msgs[10] = u("weather forecast tomorrow looks pleasant"); // middle, no shared terms
    msgs[32] = u("remind me of my passport number");           // current question
    const out = buildSmartHistory(msgs);
    expect(out).not.toContain("[relevant earlier]");
    expect(out).not.toContain("weather forecast");
  });

  it("retrieval is disabled when retrieveK is 0", () => {
    const msgs = many(34);
    msgs[10] = u("passport XYZ789");
    msgs[32] = u("passport number please");
    const out = buildSmartHistory(msgs, { retrieveK: 0 });
    expect(out).not.toContain("[relevant earlier]");
  });
});

describe("buildSmartHistory — character budget", () => {
  it("clips an oversized single message", () => {
    const big = "x".repeat(5000);
    const out = buildSmartHistory([u(big), a("ok")], { maxPerMessage: 100 });
    expect(out).toContain("…[clipped]");
    expect(out.length).toBeLessThan(1000);
  });

  it("sheds oldest tail turns when over the total budget", () => {
    const msgs = Array.from({ length: 40 }, (_, i) => u(`turn-${i}-${"y".repeat(300)}`));
    const out = buildSmartHistory(msgs, { maxChars: 2000 });
    expect(out.length).toBeLessThanOrEqual(2000 + 200); // budget + one trim marker line
    expect(out).toContain("trimmed to fit");
    expect(out).toContain("turn-39");                   // most recent survives
  });
});

describe("config", () => {
  it("exposes sane defaults", () => {
    expect(DEFAULT_HISTORY_CONFIG.keepFirst).toBe(2);
    expect(DEFAULT_HISTORY_CONFIG.keepLast).toBe(12);
  });
});
