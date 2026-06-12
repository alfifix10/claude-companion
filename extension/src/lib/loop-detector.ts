/**
 * loop-detector — catches Claude when it calls the same tool with the
 * same input too many times in a row.
 *
 * Previous iterations oscillated between:
 *   • too eager (3 identical calls = loop) → killed paginated scroll
 *   • too lenient (no loop check on reads) → Claude stuck 5 min on a
 *                                             GitHub settings page
 *
 * Per-class thresholds solve both:
 *   • Mutating tools: 3 identical = loop (dead-ref click pattern).
 *   • Read-only tools: 8 identical = loop (genuine stuck state, not
 *                                          paginated browsing).
 *
 * Progress-aware counting (the key refinement): a "loop" means repeated
 * calls WITH NO PROGRESS BETWEEN THEM — not just repeated calls in a
 * window. When a mutating action runs, the page advanced, so the
 * read-only observations that preceded it (screenshot, read_page, ...)
 * are no longer evidence of a stall and get dropped from the window.
 * This stops the false positive where a legitimate observe→act→observe
 * cycle ("screenshot, click, screenshot, click, …") tripped the
 * read-only threshold even though the agent was clearly making headway.
 * Repeated *mutating* calls stay in the window, so a genuine dead-action
 * loop (same click ×3) is still caught.
 *
 * Hub-pattern awareness (the navigate fix): the same rule extended to
 * MUTATING repeats. Long tasks legitimately revisit a hub URL over and
 * over — navigate(list) → act(item 1) → navigate(list) → act(item 2) —
 * and the old strict count tripped the 3-repeat threshold on the third
 * visit even though every cycle did fresh work. Now a repeated identical
 * mutating call only counts as stuck when NOTHING between it and its
 * previous occurrence shows progress. Progress evidence is:
 *   • a read-only call that produced new content (progressed === true), or
 *   • a DIFFERENT mutating action that is itself still below its own loop
 *     threshold (the freshness guard — without it, two alternating dead
 *     actions A,B,A,B would neutralize each other forever; with it, the
 *     pair loses freshness after a couple of cycles and still trips).
 * A genuinely dead navigate — three in a row, or with only stagnant reads
 * between — still trips at 3 exactly as before.
 *
 * Stateful — one detector per task. Caller should construct a fresh
 * one when handleMaxChat starts a new run.
 */

import { getLoopThreshold, isMutating } from "./tool-registry.js";

export interface LoopDetectorConfig {
  /** Number of recent calls kept in the window. */
  window: number;
  /** Threshold for mutating tools (click, navigate, ...). */
  mutatingRepeats: number;
  /** Threshold for read-only tools (screenshot, scroll, ...). */
  readonlyRepeats: number;
}

export const DEFAULT_LOOP_CONFIG: LoopDetectorConfig = {
  // Window large enough to accommodate per-tool overrides (run_javascript
  // = 12). If the window is smaller than the highest threshold, shifting
  // out old entries means we'd never count high enough to trip the
  // threshold — effectively disabling loop detection for that tool.
  window: 16,
  mutatingRepeats: 3,
  readonlyRepeats: 8,
};

export interface LoopDetectionResult {
  /** True when the call count hit the threshold for this tool's class. */
  loop: boolean;
  /** How many times this (tool, input) has appeared in the window. */
  identical: number;
  /** Threshold that was applied (mutating vs read-only). */
  threshold: number;
}

interface Call {
  name: string;
  inputKey: string;
  /**
   * Delta-awareness (5.3): set after the call's result arrives. `true` means
   * the call produced NEW content (a scroll that revealed more, a read_page
   * that changed) — genuine progress, so it is excluded from the stuck count.
   * A repeated read/scroll only counts toward the loop threshold once it stops
   * producing new content. Left undefined for calls whose outcome we don't
   * track (chiefly mutating tools, which keep their existing strict counting).
   */
  progressed?: boolean;
}

/**
 * Stateful detector. Construct one per task; call `record` on every
 * tool invocation.
 */
export class LoopDetector {
  private readonly config: LoopDetectorConfig;
  private readonly recent: Call[] = [];

  constructor(config: LoopDetectorConfig = DEFAULT_LOOP_CONFIG) {
    this.config = config;
  }

  /**
   * Register a tool call. Returns `{ loop: true, ... }` when the
   * identical-call count has hit the threshold for the tool's class.
   */
  record(name: string, inputKey: string): LoopDetectionResult {
    this.recent.push({ name, inputKey });
    if (this.recent.length > this.config.window) {
      this.recent.shift();
    }

    // Hub-pattern neutralization — see the module header. MUST run before
    // the read-only purge below: the evidence it looks for includes
    // progressed reads sitting between the two occurrences, and the purge
    // is about to delete exactly those entries.
    if (isMutating(name)) {
      this.neutralizePriorIfProgressed(name, inputKey);
    }

    // Progress reset — see the module header. A mutating action advanced
    // the page, so the read-only observations that came before it are no
    // longer evidence of a stall. Drop them. Mutating entries stay, so
    // dead-action loops (same click ×3) are still caught.
    if (isMutating(name)) {
      for (let i = this.recent.length - 2; i >= 0; i--) {
        const entry = this.recent[i];
        if (entry && !isMutating(entry.name)) this.recent.splice(i, 1);
      }
    }

    // Delta-aware count (5.3): a same-(tool,input) call that produced NEW
    // content is progress, not a stall, so exclude it. The just-pushed call
    // has progressed === undefined (its result hasn't arrived yet) and is
    // counted — so a genuinely stagnant streak still trips, while a paginating
    // read/scroll that keeps revealing new content never does.
    const identical = this.recent.filter(
      (c) => c.name === name && c.inputKey === inputKey && c.progressed !== true,
    ).length;

    const threshold = this.thresholdFor(name);

    return {
      loop: identical >= threshold,
      identical,
      threshold,
    };
  }

  /**
   * Per-tool override > class default. The override exists for tools
   * like run_javascript whose "same input, different output" pattern
   * is by design (scrape → scroll → scrape again with new content).
   */
  private thresholdFor(name: string): number {
    const override = getLoopThreshold(name);
    return override !== undefined
      ? override
      : isMutating(name)
        ? this.config.mutatingRepeats
        : this.config.readonlyRepeats;
  }

  /**
   * Hub-pattern fix: if anything between the just-pushed mutating call and
   * its nearest previous identical occurrence shows progress, mark that
   * previous occurrence progressed (= excluded from the stuck count).
   * Progress evidence: a progressed read, or a different mutating action
   * still below its own threshold (freshness guard — an alternating dead
   * pair must not keep neutralizing each other forever).
   */
  private neutralizePriorIfProgressed(name: string, inputKey: string): void {
    let prevIdx = -1;
    for (let i = this.recent.length - 2; i >= 0; i--) {
      const c = this.recent[i];
      if (c && c.name === name && c.inputKey === inputKey) {
        prevIdx = i;
        break;
      }
    }
    if (prevIdx === -1) return;
    const prev = this.recent[prevIdx];
    if (!prev) return;

    for (let j = prevIdx + 1; j < this.recent.length - 1; j++) {
      const mid = this.recent[j];
      if (!mid) continue;
      if (mid.name === name && mid.inputKey === inputKey) continue;
      if (!isMutating(mid.name)) {
        if (mid.progressed === true) {
          prev.progressed = true;
          return;
        }
        continue;
      }
      // Different mutating action. Raw occurrence count (neutralized
      // entries included — freshness is about how often it was TRIED,
      // not whether it was excused) against its own threshold.
      const raw = this.recent.filter(
        (c) => c.name === mid.name && c.inputKey === mid.inputKey,
      ).length;
      if (raw < this.thresholdFor(mid.name)) {
        prev.progressed = true;
        return;
      }
    }
  }

  /**
   * Annotate the most-recent call matching (name, inputKey) with whether its
   * result was progress (new content) or a stall (5.3). Keyed rather than
   * "last" so it stays correct when the model emits several tool calls in one
   * turn (parallel tool_use) before any result arrives. No-op if no match.
   */
  markProgress(name: string, inputKey: string, progressed: boolean): void {
    for (let i = this.recent.length - 1; i >= 0; i--) {
      const c = this.recent[i];
      if (c && c.name === name && c.inputKey === inputKey) {
        c.progressed = progressed;
        return;
      }
    }
  }

  /** Manually reset the window — useful on task boundaries. */
  reset(): void {
    this.recent.length = 0;
  }

  /** Testing helper: inspect the current window contents. */
  snapshot(): ReadonlyArray<Call> {
    return [...this.recent];
  }
}
