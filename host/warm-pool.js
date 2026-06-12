/**
 * warm-pool — pure decision logic for the pre-warmed claude CLI slot.
 *
 * Spawning `claude` fresh on every turn pays the cold start (node boot,
 * config load, MCP connect — ~100-300ms on Windows) on the critical path of
 * EVERY chat turn. Because the prompt travels via stdin (a hard-won design
 * rule — see native-host.js), every CLI argument is knowable before the next
 * query arrives: we can pre-spawn one process after each turn completes and
 * leave it blocked on stdin, moving the entire cold start off the critical
 * path. When the next query lands we just write the prompt.
 *
 * This module holds ONLY the decisions (no spawn, no fs, no timers) so they
 * are provable with node --test, same pattern as security.js:
 *
 *   • computeWarmSignature — the exact-match contract for adoption. The
 *     signature covers everything that changes the spawn args: model,
 *     proMode (SECURITY: it gates run_javascript via --disallowedTools —
 *     adopting a warm proc spawned with stale proMode would carry the old
 *     privilege), and the full system prompt text (not a hash — exact
 *     equality, no collisions, the string is ≤32KB).
 *   • isWarmUsable — liveness + signature + age gate. Age caps staleness:
 *     a warm proc outliving WARM_MAX_AGE_MS may predate a CLI update or a
 *     login change, so it gets killed rather than adopted.
 *
 * Anything that fails these checks falls back to the fresh-spawn path —
 * behaviour identical to before this feature existed.
 */

export const WARM_MAX_AGE_MS = 15 * 60_000;

/**
 * Canonical signature for "would the spawn args be identical?".
 * pureMode and image turns never use the warm slot (different args), so
 * they are not part of the signature space.
 */
export function computeWarmSignature({ model, proMode, systemPrompt }) {
  return JSON.stringify([
    String(model || ""),
    proMode === true,
    String(systemPrompt || ""),
  ]);
}

/**
 * True when the warm slot can serve a query with `signature` right now.
 * `slot.proc` only needs `exitCode` and `killed` — testable with fakes.
 */
export function isWarmUsable(slot, signature, now) {
  if (!slot || !slot.proc) return false;
  if (slot.proc.exitCode !== null || slot.proc.killed) return false;
  if (slot.signature !== signature) return false;
  if (typeof slot.spawnedAt !== "number") return false;
  if (now - slot.spawnedAt > WARM_MAX_AGE_MS) return false;
  return true;
}
