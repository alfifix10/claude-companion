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
 * Stateful — one detector per task. Caller should construct a fresh
 * one when handleMaxChat starts a new run.
 */

import { isMutating, getLoopThreshold } from "./tool-registry.js";

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

    const identical = this.recent.filter((c) => c.name === name && c.inputKey === inputKey).length;

    // Per-tool override > class default. The override exists for tools
    // like run_javascript whose "same input, different output" pattern
    // is by design (scrape → scroll → scrape again with new content).
    const override = getLoopThreshold(name);
    const threshold = override !== undefined
      ? override
      : (isMutating(name) ? this.config.mutatingRepeats : this.config.readonlyRepeats);

    return {
      loop: identical >= threshold,
      identical,
      threshold,
    };
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
