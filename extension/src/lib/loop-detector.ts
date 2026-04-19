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
 *   • Read-only tools: 6 identical = loop (genuine stuck state, not
 *                                          paginated browsing).
 *
 * Stateful — one detector per task. Caller should construct a fresh
 * one when handleMaxChat starts a new run.
 */

import { isMutating } from "./tool-registry";

export interface LoopDetectorConfig {
  /** Number of recent calls kept in the window. */
  window: number;
  /** Threshold for mutating tools (click, navigate, ...). */
  mutatingRepeats: number;
  /** Threshold for read-only tools (screenshot, scroll, ...). */
  readonlyRepeats: number;
}

export const DEFAULT_LOOP_CONFIG: LoopDetectorConfig = {
  window: 8,
  mutatingRepeats: 3,
  readonlyRepeats: 6,
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

    const identical = this.recent.filter((c) => c.name === name && c.inputKey === inputKey).length;

    const threshold = isMutating(name) ? this.config.mutatingRepeats : this.config.readonlyRepeats;

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
