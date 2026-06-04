/**
 * security.js — the Pro-Mode security primitives, extracted into a
 * side-effect-free module so they can be unit-tested directly (the host
 * scripts that used to hold them start a server on import, which a test
 * can't pull in cleanly).
 *
 * Pure functions + constants only. No server, no I/O at import time. The
 * three guards here are the critical attack surface:
 *   • validatePath  — filesystem sandbox (keeps file tools inside the
 *                     configured working directory, even through symlinks).
 *   • validateCommand — shell allowlist/denylist for run_command.
 *   • isModelAllowed  — strips command injection from the --model arg.
 *
 * mcp-server.js and native-host.js import from here so there is ONE source
 * of truth (and one place to test). Behaviour is byte-for-byte what used to
 * live inline; security.test.js locks it down.
 */
import fs from "node:fs";
import path from "node:path";

// Validate that `inputPath` resolves inside `workingDirectory` (and only
// inside — symlinks pointing out are rejected). Throws on violations so
// the MCP tool returns an error to Claude. Path arg may be absolute or
// relative — we resolve against workingDirectory in either case. Returns the
// real (symlink-resolved) absolute path on success.
export function validatePath(inputPath, workingDirectory) {
  if (!workingDirectory) {
    throw new Error("Working directory not configured. Open settings → Pro Mode.");
  }
  const wd = path.resolve(workingDirectory);
  let abs;
  if (path.isAbsolute(inputPath)) {
    abs = path.resolve(inputPath);
  } else {
    abs = path.resolve(wd, inputPath);
  }
  // First check the lexical path — defends against `../` traversal even
  // when the resolved file doesn't exist.
  const sep = path.sep;
  if (abs !== wd && !abs.startsWith(wd + sep)) {
    throw new Error(`Path is outside the working directory: ${inputPath}`);
  }
  // Then resolve any symlinks. If the file exists and points outside, refuse.
  // If it doesn't exist (write_file new path), realpath throws — that's fine,
  // we already validated the lexical path above.
  try {
    const real = fs.realpathSync(abs);
    if (real !== wd && !real.startsWith(wd + sep)) {
      throw new Error(`Symlink points outside the working directory: ${inputPath}`);
    }
    return real;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    // The leaf doesn't exist yet (e.g. write_file to a brand-new path).
    // The lexical check above only guards the *spelled* path — it can't
    // see an intermediate symlink. Resolve the nearest existing ancestor's
    // real path and re-validate, so e.g. `wd/link/new.txt` where
    // `wd/link` -> /etc is rejected instead of silently writing THROUGH
    // the symlink to outside the sandbox.
    let probe = abs;
    for (;;) {
      const parent = path.dirname(probe);
      if (parent === probe) break;            // reached the filesystem root
      let realParent;
      try {
        realParent = fs.realpathSync(parent);
      } catch (e2) {
        if (e2.code === "ENOENT") { probe = parent; continue; }  // walk up
        throw e2;
      }
      if (realParent !== wd && !realParent.startsWith(wd + sep)) {
        throw new Error(`Path resolves outside the working directory via a symlinked parent: ${inputPath}`);
      }
      // Ancestor is real and inside the sandbox — rebuild the not-yet-
      // existing tail under the resolved ancestor.
      return path.join(realParent, path.relative(parent, abs));
    }
    return abs;   // nothing along the path exists yet — lexical check stands
  }
}

// run_command allowlist — only these bare executables may be spawned.
export const COMMAND_ALLOWLIST = new Set([
  // Version control
  "git",
  // Package managers
  "npm", "pnpm", "yarn", "bun", "pip", "pip3", "pipx", "poetry", "uv",
  // Runtimes / interpreters
  "node", "python", "python3", "deno",
  // Test / lint / build
  "tsc", "vitest", "jest", "pytest", "mocha", "eslint", "prettier", "biome",
  "rollup", "esbuild", "webpack", "vite",
  // POSIX-y read-only utilities (Windows has them via Git Bash / WSL)
  "ls", "cat", "head", "tail", "wc", "grep", "find", "echo", "pwd",
  "which", "where", "whoami", "date",
  // Safe-ish creates
  "mkdir", "touch",
  // Inspection (read-only). `type` is the Windows equivalent of `cat`.
  "type",
]);

// Hard refusal regardless of allowlist position. Substrings, not whole-token.
export const COMMAND_DENY_SUBSTR = [
  "rm -rf", "rm -fr", "rmdir /s",   // recursive deletes
  "sudo", "doas", "su ",            // privilege escalation
  "chmod 777", "chown ",            // perm changes
  "format ", "mkfs",                 // filesystem destruction
  "dd if=", "> /dev/",               // disk overwrites
  ":(){",                            // fork bomb shorthand
  "curl http", "wget http",          // discourage random downloads (allow inside scripts via npm/python though)
];

// Validate a run_command invocation against the allowlist + denylist. Throws
// (Claude sees the message) on any violation. Returns the normalised command
// name on success. Pure — no spawn, no I/O.
export function validateCommand(cmd, args = []) {
  // The allowlist check normalises to basename, but spawn() runs the RAW
  // cmd. Reject any path separator so a basename of "git" can't smuggle an
  // arbitrary executable like "C:\evil\git" or "./node" past the allowlist.
  if (/[\\/]/.test(cmd)) {
    throw new Error(`Command must be a bare executable name, not a path: "${cmd}"`);
  }
  // Normalise cmd — basename only (no path traversal in the cmd itself).
  const cmdName = path.basename(cmd).toLowerCase().replace(/\.(exe|cmd|bat|sh|ps1)$/i, "");
  if (!COMMAND_ALLOWLIST.has(cmdName)) {
    const allowed = [...COMMAND_ALLOWLIST].sort().join(", ");
    throw new Error(`Command "${cmd}" is not on the Pro Mode allowlist. Allowed: ${allowed}`);
  }
  // Reconstruct what the user/Claude would have invoked and check the full
  // string against the denylist. This catches cases where args smuggle a
  // destructive verb (e.g. `git`, args=['!','rm','-rf','.']).
  const fullCmd = (cmd + " " + (args || []).join(" ")).toLowerCase();
  for (const bad of COMMAND_DENY_SUBSTR) {
    if (fullCmd.includes(bad.toLowerCase())) {
      throw new Error(`Command rejected: contains banned substring "${bad}".`);
    }
  }
  return cmdName;
}

// Allowed shape for the --model CLI arg. A crafted value like "foo & calc.exe"
// would otherwise ride into cmd.exe when we go through a shell on Windows.
export const MODEL_ALLOWED = /^[A-Za-z0-9._:/-]{1,64}$/;

export function isModelAllowed(name) {
  return MODEL_ALLOWED.test(String(name));
}

// ── Confirmation gate (1.3) ───────────────────────────────────────────────
// The Pro-Mode shell/file tools that can MODIFY the machine (and, via the
// interpreters on the run_command allowlist, run arbitrary code). The denylist
// can't fully contain `node -e ...` / `python -c ...`, so instead of removing
// those interpreters (which would gut the capability) we require an explicit
// human approval before each such action runs. Read-only tools (read_file,
// list_directory, grep_files, git_*, …) are NOT gated — they can't harm.
export const CONFIRM_REQUIRED = new Set([
  "write_file",
  "edit_file",
  "delete_file",
  "run_command",
]);

export function requiresConfirmation(tool) {
  return CONFIRM_REQUIRED.has(String(tool));
}

// Fail-safe interpreter for the gate's answer: ONLY the exact token "approved"
// counts as approval. Anything else — "denied", "", null, a timeout, a dropped
// channel — is treated as a refusal, so the action is blocked by default.
export function isApprovalToken(answer) {
  return answer === "approved";
}
