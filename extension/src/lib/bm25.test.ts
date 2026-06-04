import { describe, expect, it } from "vitest";
import { tokenize, rankBM25 } from "./bm25.js";

describe("tokenize", () => {
  it("lowercases and splits on non-word characters", () => {
    expect(tokenize("Hello, World! foo-bar")).toEqual(["hello", "world", "foo", "bar"]);
  });

  it("keeps digits and splits Latin from Arabic", () => {
    expect(tokenize("PR 123 جاهز")).toEqual(["pr", "123", "جاهز"]);
  });

  it("strips Arabic diacritics so vowelled and bare forms match", () => {
    expect(tokenize("كِتَاب")).toEqual(tokenize("كتاب"));
  });

  it("handles empty / null / undefined safely", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize(null)).toEqual([]);
    expect(tokenize(undefined)).toEqual([]);
  });
});

describe("rankBM25", () => {
  it("returns only docs that share a query term, ranked by relevance", () => {
    const docs = [
      "the cat sat on the mat",     // 0 — has "cat"
      "dogs are loyal animals",     // 1 — no overlap
      "a cat and another cat",      // 2 — "cat" twice
    ];
    const r = rankBM25("cat", docs);
    expect(r.map((d) => d.index)).toEqual([2, 0]); // doc 2 outranks doc 0
    expect(r.every((d) => d.score > 0)).toBe(true);
    expect(r.find((d) => d.index === 1)).toBeUndefined(); // no-overlap omitted
  });

  it("returns [] for an empty query or empty corpus", () => {
    expect(rankBM25("", ["anything"])).toEqual([]);
    expect(rankBM25("   ", ["anything"])).toEqual([]);
    expect(rankBM25("cat", [])).toEqual([]);
  });

  it("respects the limit", () => {
    const docs = ["cat a", "cat b", "cat c", "cat d"];
    expect(rankBM25("cat", docs, { limit: 2 })).toHaveLength(2);
  });

  it("ranks a rarer term's match above a common term's match", () => {
    // "quota" appears in 1 doc (rare → high IDF); "the" in all (common → low).
    const docs = [
      "the the the the the",          // 0 — only the common term
      "remember the monthly quota",   // 1 — the rare term
      "the the the the",              // 2 — common term only
    ];
    const r = rankBM25("the quota", docs);
    expect(r[0].index).toBe(1); // the doc with the rare term wins
  });

  it("matches Arabic regardless of diacritics", () => {
    const docs = ["نقل كأس العالم", "أخبار الطقس اليوم", "كأس آسيا"];
    const r = rankBM25("كَأس", docs); // vowelled query
    expect(r.map((d) => d.index).sort()).toEqual([0, 2]); // both "كأس" docs
  });

  it("is deterministic — ties broken by earlier index", () => {
    const docs = ["alpha match", "alpha match"]; // identical → equal score
    const r = rankBM25("alpha", docs);
    expect(r.map((d) => d.index)).toEqual([0, 1]);
  });

  it("longer documents don't unfairly win on length alone (b normalisation)", () => {
    const short = "quota";
    const long = "quota " + "filler ".repeat(50);
    const r = rankBM25("quota", [short, long]);
    expect(r[0].index).toBe(0); // the concise doc scores higher
  });
});
