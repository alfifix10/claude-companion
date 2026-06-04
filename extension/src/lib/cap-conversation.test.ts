import { describe, expect, it } from "vitest";
import { capConversation } from "./cap-conversation.js";

const seq = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("capConversation", () => {
  it("returns the array unchanged when within the cap", () => {
    expect(capConversation(seq(5), 10)).toEqual([0, 1, 2, 3, 4]);
    expect(capConversation(seq(10), 10)).toEqual(seq(10)); // exactly max → no cap
  });

  it("pins the first 2 and keeps the most recent for the rest", () => {
    const out = capConversation(seq(200), 100); // 200-message marathon
    expect(out).toHaveLength(100);
    expect(out.slice(0, 2)).toEqual([0, 1]); // the goal survives
    expect(out[2]).toBe(102); // then jumps to the last 98 (102..199)
    expect(out[out.length - 1]).toBe(199); // most recent kept
  });

  it("produces no overlap or duplication right at max+1", () => {
    const out = capConversation(seq(101), 100);
    expect(out).toHaveLength(100);
    expect(new Set(out).size).toBe(100); // all unique
    expect(out.slice(0, 2)).toEqual([0, 1]);
  });

  it("honours a custom pinHead", () => {
    const out = capConversation(seq(50), 10, 3);
    expect(out.slice(0, 3)).toEqual([0, 1, 2]);
    expect(out).toHaveLength(10);
    expect(out[out.length - 1]).toBe(49);
  });

  it("pinHead=0 behaves like a plain tail slice", () => {
    expect(capConversation(seq(50), 10, 0)).toEqual(seq(50).slice(-10));
  });

  it("degrades gracefully when pinHead >= max", () => {
    expect(capConversation(seq(50), 3, 5)).toEqual([47, 48, 49]);
  });

  it("handles non-positive max", () => {
    expect(capConversation(seq(50), 0)).toEqual([]);
  });
});
