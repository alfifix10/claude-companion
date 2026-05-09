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
import { isMutating, getLoopThreshold } from "./tool-registry.js";
export const DEFAULT_LOOP_CONFIG = {
    // Window large enough to accommodate per-tool overrides (run_javascript
    // = 12). If the window is smaller than the highest threshold, shifting
    // out old entries means we'd never count high enough to trip the
    // threshold — effectively disabling loop detection for that tool.
    window: 16,
    mutatingRepeats: 3,
    readonlyRepeats: 6,
};
/**
 * Stateful detector. Construct one per task; call `record` on every
 * tool invocation.
 */
export class LoopDetector {
    config;
    recent = [];
    constructor(config = DEFAULT_LOOP_CONFIG) {
        this.config = config;
    }
    /**
     * Register a tool call. Returns `{ loop: true, ... }` when the
     * identical-call count has hit the threshold for the tool's class.
     */
    record(name, inputKey) {
        this.recent.push({ name, inputKey });
        if (this.recent.length > this.config.window) {
            this.recent.shift();
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
    reset() {
        this.recent.length = 0;
    }
    /** Testing helper: inspect the current window contents. */
    snapshot() {
        return [...this.recent];
    }
}
