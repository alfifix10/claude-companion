import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWarmSignature, isWarmUsable, WARM_MAX_AGE_MS } from "./warm-pool.js";

const liveProc = () => ({ exitCode: null, killed: false });
const slot = (over = {}) => ({
  proc: liveProc(),
  signature: computeWarmSignature({ model: "sonnet", proMode: false, systemPrompt: "SYS" }),
  spawnedAt: 1_000,
  ...over,
});
const SIG = computeWarmSignature({ model: "sonnet", proMode: false, systemPrompt: "SYS" });

test("matching live young slot is usable", () => {
  assert.equal(isWarmUsable(slot(), SIG, 2_000), true);
});

test("no slot / no proc is not usable", () => {
  assert.equal(isWarmUsable(null, SIG, 2_000), false);
  assert.equal(isWarmUsable(slot({ proc: null }), SIG, 2_000), false);
});

test("exited or killed proc is not usable", () => {
  assert.equal(isWarmUsable(slot({ proc: { exitCode: 0, killed: false } }), SIG, 2_000), false);
  assert.equal(isWarmUsable(slot({ proc: { exitCode: null, killed: true } }), SIG, 2_000), false);
});

test("SECURITY: proMode flip changes the signature — stale privilege never adopted", () => {
  // Warm proc was spawned while Pro Mode was ON (run_javascript allowed).
  const warmedProSig = computeWarmSignature({ model: "sonnet", proMode: true, systemPrompt: "SYS" });
  const s = slot({ signature: warmedProSig });
  // User then turned Pro Mode OFF — the query's signature differs, so the
  // privileged warm proc must be rejected (killed + fresh spawn).
  const queryNonProSig = computeWarmSignature({ model: "sonnet", proMode: false, systemPrompt: "SYS" });
  assert.equal(isWarmUsable(s, queryNonProSig, 2_000), false);
});

test("model switch changes the signature", () => {
  const haiku = computeWarmSignature({ model: "haiku", proMode: false, systemPrompt: "SYS" });
  assert.notEqual(haiku, SIG);
  assert.equal(isWarmUsable(slot(), haiku, 2_000), false);
});

test("system prompt change (extension update mid-session) changes the signature", () => {
  const newSys = computeWarmSignature({ model: "sonnet", proMode: false, systemPrompt: "SYS v2" });
  assert.equal(isWarmUsable(slot(), newSys, 2_000), false);
});

test("expired slot is not usable (CLI update / login drift guard)", () => {
  assert.equal(isWarmUsable(slot(), SIG, 1_000 + WARM_MAX_AGE_MS + 1), false);
  // ... but just inside the window is fine.
  assert.equal(isWarmUsable(slot(), SIG, 1_000 + WARM_MAX_AGE_MS - 1), true);
});

test("empty/undefined model + system normalize identically", () => {
  assert.equal(
    computeWarmSignature({ model: undefined, proMode: false, systemPrompt: undefined }),
    computeWarmSignature({ model: "", proMode: false, systemPrompt: "" }),
  );
});
