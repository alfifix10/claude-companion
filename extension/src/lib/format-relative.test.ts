import { describe, expect, it } from "vitest";
import { formatRelative } from "./format-relative";

// All tests pin `now` to a known instant so they're deterministic.
const NOW = new Date("2026-04-19T12:00:00Z").getTime();

describe("formatRelative — under 1 minute", () => {
  it("same instant → الآن", () => {
    expect(formatRelative(NOW, NOW)).toBe("الآن");
  });

  it("30 seconds ago → الآن", () => {
    expect(formatRelative(NOW - 30_000, NOW)).toBe("الآن");
  });

  it("59 seconds ago → الآن", () => {
    expect(formatRelative(NOW - 59_000, NOW)).toBe("الآن");
  });
});

describe("formatRelative — minutes (< 1 hour)", () => {
  it("exactly 1 minute → منذ 1 دقيقة", () => {
    expect(formatRelative(NOW - 60_000, NOW)).toBe("منذ 1 دقيقة");
  });

  it("15 minutes → منذ 15 دقيقة", () => {
    expect(formatRelative(NOW - 15 * 60_000, NOW)).toBe("منذ 15 دقيقة");
  });

  it("59 minutes → منذ 59 دقيقة", () => {
    expect(formatRelative(NOW - 59 * 60_000, NOW)).toBe("منذ 59 دقيقة");
  });
});

describe("formatRelative — hours (< 1 day)", () => {
  it("exactly 1 hour", () => {
    expect(formatRelative(NOW - 60 * 60_000, NOW)).toBe("منذ 1 ساعة");
  });

  it("5 hours", () => {
    expect(formatRelative(NOW - 5 * 60 * 60_000, NOW)).toBe("منذ 5 ساعة");
  });

  it("23 hours", () => {
    expect(formatRelative(NOW - 23 * 60 * 60_000, NOW)).toBe("منذ 23 ساعة");
  });
});

describe("formatRelative — days (< 1 week)", () => {
  it("exactly 1 day", () => {
    expect(formatRelative(NOW - 24 * 60 * 60_000, NOW)).toBe("منذ 1 يوم");
  });

  it("3 days", () => {
    expect(formatRelative(NOW - 3 * 24 * 60 * 60_000, NOW)).toBe("منذ 3 يوم");
  });

  it("6 days", () => {
    expect(formatRelative(NOW - 6 * 24 * 60 * 60_000, NOW)).toBe("منذ 6 يوم");
  });
});

describe("formatRelative — 1 week+ falls back to locale date", () => {
  it("7 days ago → a date string (not relative)", () => {
    const out = formatRelative(NOW - 7 * 24 * 60 * 60_000, NOW);
    expect(out).not.toBe("منذ 7 يوم");
    expect(out).not.toBe("الآن");
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("30 days ago → locale date", () => {
    const out = formatRelative(NOW - 30 * 24 * 60 * 60_000, NOW);
    expect(out).not.toMatch(/منذ/);
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("formatRelative — defaults to Date.now when omitted", () => {
  it("works without explicit `now` arg", () => {
    const out = formatRelative(Date.now());
    expect(out).toBe("الآن");
  });
});
