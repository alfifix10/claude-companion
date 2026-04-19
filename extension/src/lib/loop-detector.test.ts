import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LOOP_CONFIG, LoopDetector, type LoopDetectorConfig } from "./loop-detector";

describe("LoopDetector — default config sanity", () => {
  it("exports sensible defaults", () => {
    expect(DEFAULT_LOOP_CONFIG.window).toBeGreaterThanOrEqual(4);
    expect(DEFAULT_LOOP_CONFIG.mutatingRepeats).toBeLessThan(DEFAULT_LOOP_CONFIG.readonlyRepeats);
    expect(DEFAULT_LOOP_CONFIG.window).toBeGreaterThanOrEqual(DEFAULT_LOOP_CONFIG.readonlyRepeats);
  });
});

describe("LoopDetector — mutating tools (3-repeat threshold)", () => {
  let d: LoopDetector;
  beforeEach(() => {
    d = new LoopDetector();
  });

  it("first identical click is fine", () => {
    const r = d.record("click", "ref_42");
    expect(r.loop).toBe(false);
    expect(r.identical).toBe(1);
    expect(r.threshold).toBe(3);
  });

  it("second identical click is still fine", () => {
    d.record("click", "ref_42");
    const r = d.record("click", "ref_42");
    expect(r.loop).toBe(false);
    expect(r.identical).toBe(2);
  });

  it("third identical click fires the loop", () => {
    d.record("click", "ref_42");
    d.record("click", "ref_42");
    const r = d.record("click", "ref_42");
    expect(r.loop).toBe(true);
    expect(r.identical).toBe(3);
  });

  it("different input on same mutating tool does not trip", () => {
    d.record("click", "ref_1");
    d.record("click", "ref_2");
    d.record("click", "ref_3");
    const r = d.record("click", "ref_4");
    expect(r.loop).toBe(false);
    expect(r.identical).toBe(1);
  });

  it("different mutating tools do not conflate", () => {
    d.record("click", "ref_1");
    d.record("navigate", "https://x");
    d.record("type_text", "hello");
    const r = d.record("click", "ref_1");
    expect(r.loop).toBe(false);
    expect(r.identical).toBe(2);
  });
});

describe("LoopDetector — read-only tools (6-repeat threshold)", () => {
  let d: LoopDetector;
  beforeEach(() => {
    d = new LoopDetector();
  });

  it("5 identical screenshots — not yet a loop", () => {
    for (let i = 0; i < 5; i++) d.record("screenshot", "{}");
    const r = d.record("screenshot", "{}");
    expect(r.loop).toBe(true); // 6th is exactly the threshold
    expect(r.identical).toBe(6);
    expect(r.threshold).toBe(6);
  });

  it("interleaved screenshot+scroll stays below threshold", () => {
    // Progress pattern: shot → scroll → shot → scroll → shot → scroll
    d.record("screenshot", "{}");
    d.record("scroll", "down");
    d.record("screenshot", "{}");
    d.record("scroll", "down");
    d.record("screenshot", "{}");
    d.record("scroll", "down");
    // 3 screenshots in 6-wide window, threshold is 6 → NOT a loop
    const r = d.record("screenshot", "{}");
    expect(r.loop).toBe(false);
    expect(r.identical).toBe(4);
  });

  it("wait_for repeats legitimately", () => {
    for (let i = 0; i < 5; i++) {
      const r = d.record("wait_for", "selector=button.primary");
      expect(r.loop).toBe(false);
    }
  });
});

describe("LoopDetector — sliding window", () => {
  let d: LoopDetector;
  beforeEach(() => {
    d = new LoopDetector();
  });

  it("drops oldest entries past the window", () => {
    const config: LoopDetectorConfig = {
      window: 4,
      mutatingRepeats: 3,
      readonlyRepeats: 6,
    };
    const small = new LoopDetector(config);
    // click ref_a twice, click ref_b four times → first click ref_a
    // rolls out of the 4-entry window
    small.record("click", "ref_a");
    small.record("click", "ref_a");
    small.record("click", "ref_b");
    small.record("click", "ref_b");
    small.record("click", "ref_b");
    // window now: [a, b, b, b]
    const r = small.record("click", "ref_b");
    // 4 b's in window of 4 → loop fires at the 3rd identical
    expect(r.loop).toBe(true);
    expect(small.snapshot()).toHaveLength(4);
  });
});

describe("LoopDetector — reset", () => {
  it("wipes the window", () => {
    const d = new LoopDetector();
    d.record("click", "ref_1");
    d.record("click", "ref_1");
    d.reset();
    const r = d.record("click", "ref_1");
    expect(r.loop).toBe(false);
    expect(r.identical).toBe(1);
  });
});
