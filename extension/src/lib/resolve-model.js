export const MODEL_BY_SPEED = {
    fast: "haiku",
    balanced: "sonnet",
    powerful: "opus",
};
// Default to powerful (opus): never degrade intelligence silently. The user
// opts INTO a faster model when they decide a task doesn't need full power —
// quality is the safe default. Applied for unset/unknown values too.
export const DEFAULT_MODEL_SPEED = "powerful";
export function resolveModel(speed) {
    if (speed === "fast" || speed === "balanced" || speed === "powerful") {
        return MODEL_BY_SPEED[speed];
    }
    return MODEL_BY_SPEED[DEFAULT_MODEL_SPEED];
}
