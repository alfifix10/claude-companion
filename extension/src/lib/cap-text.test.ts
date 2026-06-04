import { describe, expect, it } from "vitest";
import { capText } from "./cap-text.js";

describe("capText", () => {
  it("returns short text unchanged", () => {
    expect(capText("hello", 100)).toBe("hello");
    expect(capText("", 100)).toBe("");
  });

  it("truncates and reports how much was dropped", () => {
    const out = capText("x".repeat(50), 20);
    expect(out.startsWith("x".repeat(20))).toBe(true);
    expect(out).toContain("truncated 30 of 50 chars");
  });

  it("appends the hint when given", () => {
    const out = capText("y".repeat(30), 10, "write it to a file instead.");
    expect(out).toContain("write it to a file instead.");
  });

  it("respects an exact-length boundary (no truncation at == max)", () => {
    expect(capText("abcde", 5)).toBe("abcde");
    expect(capText("abcdef", 5)).toContain("truncated 1 of 6 chars");
  });

  it("coerces non-strings and null safely", () => {
    expect(capText(null, 100)).toBe("");
    expect(capText(undefined, 100)).toBe("");
    expect(capText(12345, 100)).toBe("12345");
  });
});
