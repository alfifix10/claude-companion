export const MODEL_BY_SPEED = {
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
export const DEFAULT_MODEL_SPEED = "balanced";
export function resolveModel(speed) {
    if (speed === "fast" || speed === "balanced" || speed === "powerful") {
        return MODEL_BY_SPEED[speed];
    }
    return MODEL_BY_SPEED[DEFAULT_MODEL_SPEED];
}
