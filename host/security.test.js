/**
 * Tests for the Pro-Mode security primitives (host/security.js).
 *
 * Run with the built-in runner — no test framework dependency:
 *   node --test host/security.test.js
 * (or `node --test` from the host/ dir to pick up every *.test.js).
 *
 * These guard the three critical attack surfaces: the filesystem sandbox,
 * the run_command allowlist/denylist, and the --model injection filter.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validatePath,
  validateCommand,
  isModelAllowed,
} from "./security.js";

// A real temp directory as the sandbox root. realpath it up front because
// validatePath resolves symlinks internally (macOS /tmp -> /private/tmp,
// Windows 8.3 short names), so comparisons must be against the real path.
const WD = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-sec-")));

// ── validatePath: the filesystem sandbox ──────────────────────────────────
test("validatePath: throws when no working directory is configured", () => {
  assert.throws(() => validatePath("foo.txt", ""), /Working directory not configured/);
});

test("validatePath: accepts a file that exists inside the sandbox", () => {
  const f = path.join(WD, "inside.txt");
  fs.writeFileSync(f, "x");
  assert.equal(validatePath("inside.txt", WD), f);
  assert.equal(validatePath(f, WD), f);
});

test("validatePath: accepts a not-yet-existing path under the sandbox (ENOENT branch)", () => {
  const out = validatePath("new/nested/file.txt", WD);
  assert.ok(out.startsWith(WD + path.sep));
  assert.ok(out.endsWith("file.txt"));
});

test("validatePath: rejects ../ traversal even when the target doesn't exist", () => {
  assert.throws(() => validatePath("../escape.txt", WD), /outside the working directory/);
  assert.throws(() => validatePath("a/b/../../../escape.txt", WD), /outside the working directory/);
});

test("validatePath: rejects an absolute path outside the sandbox", () => {
  const outside = process.platform === "win32" ? "C:\\Windows\\System32\\x" : "/etc/passwd";
  assert.throws(() => validatePath(outside, WD), /outside the working directory/);
});

test("validatePath: rejects a sibling dir that shares the sandbox name prefix", () => {
  // WD = /tmp/cc-sec-XXXX ; a sibling /tmp/cc-sec-XXXX-evil must NOT pass the
  // startsWith(wd) check — the separator guard is what prevents that.
  const sibling = WD + "-evil";
  assert.throws(() => validatePath(sibling, WD), /outside the working directory/);
});

test("validatePath: rejects writing THROUGH a symlinked parent that points outside", { skip: process.platform === "win32" ? "symlink creation needs privilege on Windows" : false }, () => {
  const linkDir = path.join(WD, "link");
  try {
    fs.symlinkSync(os.tmpdir(), linkDir, "dir");
  } catch (e) {
    return; // environment without symlink privilege — nothing to assert
  }
  // wd/link -> os.tmpdir(); writing wd/link/escape.txt must be refused because
  // it resolves outside the sandbox via the symlinked parent.
  assert.throws(() => validatePath("link/escape.txt", WD), /symlinked parent|outside the working directory/);
});

// ── validateCommand: the run_command allowlist + denylist ─────────────────
test("validateCommand: accepts an allowlisted command and normalises the name", () => {
  assert.equal(validateCommand("git", ["status"]), "git");
  assert.equal(validateCommand("git.exe", ["status"]), "git"); // extension stripped
  assert.equal(validateCommand("GIT", ["status"]), "git");      // lower-cased
  assert.equal(validateCommand("npm", ["run", "build"]), "npm");
});

test("validateCommand: rejects a path instead of a bare executable name", () => {
  assert.throws(() => validateCommand("./node", []), /bare executable name/);
  assert.throws(() => validateCommand("C:\\evil\\git", []), /bare executable name/);
  assert.throws(() => validateCommand("/usr/bin/git", []), /bare executable name/);
});

test("validateCommand: rejects a command not on the allowlist", () => {
  assert.throws(() => validateCommand("rm", ["-rf", "/"]), /not on the Pro Mode allowlist/);
  assert.throws(() => validateCommand("bash", ["-c", "x"]), /not on the Pro Mode allowlist/);
});

test("validateCommand: rejects a banned substring smuggled through args", () => {
  // allowlisted cmd, but the denylist scans the full cmd+args string
  assert.throws(() => validateCommand("git", ["status", "&&", "rm", "-rf", "."]), /banned substring/);
  assert.throws(() => validateCommand("echo", ["sudo", "su"]), /banned substring/);
  assert.throws(() => validateCommand("npm", ["run", "dd if=/dev/sda"]), /banned substring/);
});

// ── isModelAllowed: the --model injection filter ──────────────────────────
test("isModelAllowed: accepts real model aliases and ids", () => {
  for (const ok of ["haiku", "sonnet", "opus", "claude-haiku-4-5-20251001", "claude-opus-4-8", "sonnet/4.6:beta_1"]) {
    assert.equal(isModelAllowed(ok), true, ok);
  }
});

test("isModelAllowed: rejects shell-injection and out-of-range values", () => {
  for (const bad of ["foo & calc.exe", "a b", "x;y", "$(whoami)", "model`id`", "", "a".repeat(65)]) {
    assert.equal(isModelAllowed(bad), false, JSON.stringify(bad));
  }
});
