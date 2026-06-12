import { describe, expect, it } from "vitest";
import {
  type InflightMap,
  inflightCount,
  isIdle,
  markRequestEnd,
  markRequestStart,
  sweepStale,
} from "./network-idle.js";

const m = (): InflightMap => new Map();

describe("network-idle accounting", () => {
  it("counts requests in and out", () => {
    const map = m();
    markRequestStart(map, "a", 1000);
    markRequestStart(map, "b", 1000);
    expect(inflightCount(map, 1000)).toBe(2);
    markRequestEnd(map, "a");
    expect(inflightCount(map, 1000)).toBe(1);
    markRequestEnd(map, "b");
    expect(inflightCount(map, 1000)).toBe(0);
  });

  it("treats redirect re-fire of the same id as one in-flight request", () => {
    const map = m();
    markRequestStart(map, "a", 1000);
    markRequestStart(map, "a", 1050); // redirect leg, same requestId
    expect(map.size).toBe(1);
    markRequestEnd(map, "a");
    expect(map.size).toBe(0);
  });

  it("ignores terminal events for unknown ids (no negative count)", () => {
    const map = m();
    markRequestEnd(map, "ghost");
    expect(map.size).toBe(0);
    markRequestStart(map, "a", 1000);
    markRequestEnd(map, "ghost");
    expect(map.size).toBe(1);
  });

  it("sweeps entries older than maxAge but keeps fresh ones", () => {
    const map = m();
    markRequestStart(map, "old", 0);
    markRequestStart(map, "fresh", 9000);
    const swept = sweepStale(map, 10_000, 15_000);
    expect(swept).toBe(0); // neither is 15s old yet
    expect(sweepStale(map, 20_000, 15_000)).toBe(1); // "old" is now 20s
    expect(map.has("old")).toBe(false);
    expect(map.has("fresh")).toBe(true);
  });

  it("redirect re-fire resets the stale clock", () => {
    const map = m();
    markRequestStart(map, "a", 0);
    markRequestStart(map, "a", 14_000); // re-fired late
    // At t=16s the original start (0) is 16s old, but the re-fire (14s) is
    // only 2s old — must NOT be swept.
    expect(sweepStale(map, 16_000, 15_000)).toBe(0);
    expect(map.has("a")).toBe(true);
  });

  it("isIdle respects threshold and sweeps stale leaks", () => {
    const map = m();
    expect(isIdle(map, 1000)).toBe(true); // empty = idle
    markRequestStart(map, "a", 1000);
    expect(isIdle(map, 1000)).toBe(false);
    // A leaked id that never terminated should be swept and report idle.
    expect(isIdle(map, 1000 + 15_000)).toBe(true);
    expect(map.size).toBe(0);
  });

  it("threshold tolerates always-on telemetry pings", () => {
    const map = m();
    markRequestStart(map, "ping", 1000);
    expect(isIdle(map, 1000, { threshold: 0 })).toBe(false);
    expect(isIdle(map, 1000, { threshold: 1 })).toBe(true);
  });

  it("a long-lived request (persistent long-poll/SSE) stops vetoing idleness", () => {
    const map = m();
    markRequestStart(map, "longpoll", 0);
    // Young (1s old) → busy.
    expect(isIdle(map, 1_000)).toBe(false);
    // Past longLivedMs (default 3s) → no longer counts as busy, but the
    // entry survives in the map (it may still finish legitimately).
    expect(isIdle(map, 3_500)).toBe(true);
    expect(map.has("longpoll")).toBe(true);
    // ... until the 15s stale-sweep finally drops it.
    expect(isIdle(map, 15_000)).toBe(true);
    expect(map.has("longpoll")).toBe(false);
  });

  it("a fresh action-triggered request still vetoes idleness next to an old long-poll", () => {
    const map = m();
    markRequestStart(map, "longpoll", 0);
    markRequestStart(map, "click-xhr", 5_000); // the action's own request
    expect(isIdle(map, 5_100)).toBe(false); // young XHR → busy
    markRequestEnd(map, "click-xhr");
    expect(isIdle(map, 5_200)).toBe(true); // only the old long-poll left → idle
  });

  it("longLivedMs is configurable", () => {
    const map = m();
    markRequestStart(map, "a", 0);
    expect(isIdle(map, 1_500, { longLivedMs: 1_000 })).toBe(true);
    expect(isIdle(map, 1_500, { longLivedMs: 5_000 })).toBe(false);
  });
});
