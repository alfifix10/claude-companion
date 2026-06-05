/**
 * resolve-model — map a user-facing speed choice to a `claude --model` value.
 *
 * The CLI defaults to the most powerful (slowest) model. Most browser tasks —
 * automation loops, planning, summarising — run great on a faster model with
 * no real quality loss, so we let the USER pick the speed/quality point in
 * settings (not auto-routed, so there's no misclassification risk).
 *
 *   fast      → haiku   (snappiest)
 *   balanced  → sonnet  (recommended: fast AND high quality)
 *   powerful  → opus    (hardest reasoning; slowest)
 *
 * Pure + unit-tested. Aliases (not pinned versions) so the CLI always resolves
 * to the latest of each tier.
 */
export type ModelSpeed = "fast" | "balanced" | "powerful";

export const MODEL_BY_SPEED: Record<ModelSpeed, string> = {
  fast: "haiku",
  balanced: "sonnet",
  powerful: "opus",
};

// Default to balanced (sonnet): the best speed/economy/quality point for the
// vast majority of browser + coding tasks. Opus is ~5x heavier on a Max plan's
// session budget and slower, for a quality gain that only shows on the hardest
// reasoning — so the user opts UP to "powerful" when they hit such a task,
// rather than burning the budget on everything by default. (Chosen explicitly
// by the user after weighing the tradeoff.) Applied for unset/unknown values.
export const DEFAULT_MODEL_SPEED: ModelSpeed = "balanced";

export function resolveModel(speed: unknown): string {
  if (speed === "fast" || speed === "balanced" || speed === "powerful") {
    return MODEL_BY_SPEED[speed];
  }
  return MODEL_BY_SPEED[DEFAULT_MODEL_SPEED];
}
