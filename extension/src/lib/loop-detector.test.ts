import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LOOP_CONFIG, LoopDetector, type LoopDetectorConfig } from "./loop-detector.js";

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

describe("LoopDetector — read-only tools (8-repeat threshold)", () => {
  let d: LoopDetector;
  beforeEach(() => {
    d = new LoopDetector();
  });

  it("7 identical screenshots with no progress — not yet a loop", () => {
    for (let i = 0; i < 7; i++) {
      const r = d.record("screenshot", "{}");
      expect(r.loop).toBe(false);
    }
    const r = d.record("screenshot", "{}");
    expect(r.loop).toBe(true); // 8th is exactly the threshold
    expect(r.identical).toBe(8);
    expect(r.threshold).toBe(8);
  });

  it("interleaved screenshot+scroll stays below threshold", () => {
    // scroll is read-only (not progress), so screenshots accumulate —
    // the 8-repeat threshold is what keeps this from tripping.
    d.record("screenshot", "{}");
    d.record("scroll", "down");
    d.record("screenshot", "{}");
    d.record("scroll", "down");
    d.record("screenshot", "{}");
    d.record("scroll", "down");
    const r = d.record("screenshot", "{}");
    expect(r.loop).toBe(false);
    expect(r.identical).toBe(4);
  });

  it("wait_for repeats legitimately", () => {
    for (let i = 0; i < 7; i++) {
      const r = d.record("wait_for", "selector=button.primary");
      expect(r.loop).toBe(false);
    }
  });
});

describe("LoopDetector — progress-aware reset", () => {
  let d: LoopDetector;
  beforeEach(() => {
    d = new LoopDetector();
  });

  it("a mutating action between observations resets the read-only count", () => {
    // The real-world Stripe-cancellation pattern: screenshot, click,
    // screenshot, click, … Each click is genuine progress, so the
    // screenshots must never accumulate toward a loop.
    for (let i = 0; i < 10; i++) {
      const shot = d.record("screenshot", "{}");
      expect(shot.loop).toBe(false);
      expect(shot.identical).toBe(1); // reset by the previous click
      d.record("click", `ref_${i}`); // distinct, real progress
    }
  });

  it("dead-ref click loop is still caught even with screenshots between", () => {
    // Same click ref repeated — clicks are mutating and stay in the
    // window, so the 3-repeat mutating threshold still fires.
    d.record("click", "ref_dead");
    d.record("screenshot", "{}");
    d.record("click", "ref_dead");
    d.record("screenshot", "{}");
    const r = d.record("click", "ref_dead");
    expect(r.loop).toBe(true);
    expect(r.identical).toBe(3);
  });

  it("pure observation with zero actions still trips at the threshold", () => {
    let last = d.record("read_page", "{}");
    for (let i = 0; i < 7; i++) last = d.record("read_page", "{}");
    expect(last.loop).toBe(true);
    expect(last.identical).toBe(8);
  });
});

describe("LoopDetector — delta-aware progress (5.3)", () => {
  let d: LoopDetector;
  beforeEach(() => {
    d = new LoopDetector();
  });

  it("a paginating scroll that keeps revealing new content never loops", () => {
    // The whole point of 5.3: scrolling a long page 12 times — far past the
    // 8-repeat read-only threshold — must NOT be flagged as stuck, because
    // each scroll produced new content (progressed=true).
    for (let i = 0; i < 12; i++) {
      const r = d.record("scroll", "down");
      expect(r.loop).toBe(false);
      expect(r.identical).toBe(1); // every prior scroll is excluded as progress
      d.markProgress("scroll", "down", true);
    }
  });

  it("a stagnant read/scroll still trips at the threshold", () => {
    // Same input, no new content each time → genuinely stuck → must trip.
    for (let i = 0; i < 7; i++) {
      const r = d.record("scroll", "down");
      expect(r.loop).toBe(false);
      d.markProgress("scroll", "down", false);
    }
    const r = d.record("scroll", "down"); // 8th stagnant
    expect(r.loop).toBe(true);
    expect(r.identical).toBe(8);
  });

  it("trips only AFTER progress stops — progress resets the effective count", () => {
    // 6 productive scrolls (excluded), then it plateaus.
    for (let i = 0; i < 6; i++) {
      d.record("scroll", "down");
      d.markProgress("scroll", "down", true);
    }
    // Now 7 stagnant scrolls — none should trip yet (1..7 counted).
    for (let i = 0; i < 7; i++) {
      const r = d.record("scroll", "down");
      expect(r.loop).toBe(false);
      d.markProgress("scroll", "down", false);
    }
    const r = d.record("scroll", "down"); // 8th stagnant → trips
    expect(r.loop).toBe(true);
    expect(r.identical).toBe(8);
  });

  it("markProgress is a no-op on an empty window", () => {
    expect(() => d.markProgress("scroll", "down", true)).not.toThrow();
    const r = d.record("read_page", "{}");
    expect(r.identical).toBe(1);
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
