export const MODEL_BY_SPEED = {
    fast: "haiku",
    balanced: "sonnet",
    powerful: "opus",
};
// Default to balanced: noticeably faster than the CLI's opus default while
// staying high quality. Applied for unset/unknown values too.
export const DEFAULT_MODEL_SPEED = "balanced";
export function resolveModel(speed) {
    if (speed === "fast" || speed === "balanced" || speed === "powerful") {
        return MODEL_BY_SPEED[speed];
    }
    return MODEL_BY_SPEED[DEFAULT_MODEL_SPEED];
}
