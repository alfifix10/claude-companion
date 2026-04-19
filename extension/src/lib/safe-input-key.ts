/**
 * safe-input-key — deterministic hash of a tool-call input, used by
 * the loop detector to spot "same tool, same input, again".
 *
 * Requirements:
 *   • Deterministic for objects: key order must NOT change the output
 *     (Claude Code emits inputs with different key orderings).
 *   • Safe for circular references / exotic objects: never throws —
 *     falls back to a best-effort String() representation.
 *   • Cheap: hot path, called on every tool call.
 */
export function safeInputKey(input: unknown): string {
  try {
    if (input === null || input === undefined) return "";
    if (typeof input !== "object") return String(input);
    const keys = Object.keys(input as object).sort();
    const record = input as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const k of keys) normalized[k] = record[k];
    return JSON.stringify(normalized);
  } catch {
    return String(input);
  }
}
