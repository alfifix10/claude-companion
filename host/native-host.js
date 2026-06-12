#!/usr/bin/env node

/**
 * Native messaging host for Claude Companion.
 *
 * Bridges three things:
 *   • the extension (stdin/stdout, length-prefixed JSON)
 *   • the MCP server (TCP on localhost, shared with Claude Code)
 *   • the `claude` CLI subprocess (Max-subscription agent)
 *
 * Design principles (learned the hard way):
 *   • Never pass user prompts as CLI args — pipe them via stdin to avoid
 *     every shell-quoting nightmare on Windows.
 *   • Resolve `claude` by absolute path — the browser launches us with a
 *     stripped PATH that often excludes %APPDATA%\npm.
 *   • Announce readiness proactively (`ready` banner) so the extension can
 *     distinguish "alive host" from "port-but-no-host".
 *   • Answer pings synchronously and cheaply.
 *   • Expose a `diag` endpoint so the UI can show a real setup checklist.
 */

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isModelAllowed } from "./security.js";
import { computeWarmSignature, isWarmUsable, WARM_MAX_AGE_MS } from "./warm-pool.js";

// ──────────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────────

const DEFAULT_TCP_PORT = 18799; // distinct from old project's 18765
const CONFIG_DIR = path.join(os.homedir(), ".config", "claude-companion");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
// Shared with mcp-server.js — both processes read this file as the
// single source of truth for proMode + workingDirectory + memories +
// tasks. Defined up here so the spawn path can read proMode without a
// forward reference to the user-data save/load handlers below.
const USER_DATA_PATH = path.join(CONFIG_DIR, "user-data.json");

// Read config; generate a fresh shared secret on first run so native-host
// and mcp-server can authenticate each other over the localhost TCP port.
// Even on a personal machine, this blocks other processes on the box from
// injecting tool_requests into the browser.
function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); } catch {}
  let changed = false;
  if (!cfg.port) { cfg.port = DEFAULT_TCP_PORT; changed = true; }
  if (typeof cfg.secret !== "string" || cfg.secret.length < 32) {
    cfg.secret = randomBytes(32).toString("hex");
    changed = true;
  }
  if (changed) {
    try {
      // 0o700 on dir, 0o600 on file: on macOS/Linux the default umask
      // produces 0644 which means any other local user (or process
      // running under a different account) can read the shared
      // TCP secret and impersonate the extension to the MCP server.
      // On Windows the mode is ignored; ACLs already restrict to owner.
      fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    } catch {}
    // Re-read in case another process wrote first — converge on that value.
    try {
      const cfg2 = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      if (cfg2.secret) cfg = cfg2;
    } catch {}
  }
  return cfg;
}
const CONFIG = loadConfig();
const TCP_PORT = CONFIG.port;
const SHARED_SECRET = CONFIG.secret;

// Unique session id — used by the primary mcp-server to route tool requests
// back to THIS browser (not just whichever one was active most recently).
const SESSION_ID = `sess_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// ──────────────────────────────────────────────────────────────────────────
// Native messaging protocol (4-byte LE length prefix + JSON)
// ──────────────────────────────────────────────────────────────────────────

// Hard cap so a malformed length prefix (e.g. 0xFFFFFFFF) can't OOM us.
// 16MB is huge for extension messages — legitimate inputs (even base64 images)
// stay well below this.
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

function readMessages(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const len = buffer.readUInt32LE(offset);
    if (len > MAX_MESSAGE_BYTES) {
      // Corrupted frame. Discard everything — we can't recover a valid boundary.
      return { messages, remainder: Buffer.alloc(0) };
    }
    if (offset + 4 + len > buffer.length) break;
    const json = buffer.subarray(offset + 4, offset + 4 + len).toString("utf-8");
    try { messages.push(JSON.parse(json)); } catch {}
    offset += 4 + len;
  }
  return { messages, remainder: buffer.subarray(offset) };
}

/**
 * Write a framed JSON message to stdout (4-byte LE length prefix +
 * UTF-8 body). See host/src/types.ts for the full message union.
 * @param {import("./src/types").OutboundMessage | Record<string, unknown>} obj
 */
function write(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

// ──────────────────────────────────────────────────────────────────────────
// Find the claude CLI
// ──────────────────────────────────────────────────────────────────────────

function findClaudeBin() {
  const candidates = [];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    candidates.push(path.join(appData, "npm", "claude.cmd"));
    candidates.push(path.join(appData, "npm", "claude.exe"));
    const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    candidates.push(path.join(localApp, "Programs", "claude-code", "claude.exe"));
  } else if (process.platform === "darwin") {
    candidates.push("/opt/homebrew/bin/claude");
    candidates.push("/usr/local/bin/claude");
    candidates.push(path.join(os.homedir(), ".local", "bin", "claude"));
    candidates.push(path.join(os.homedir(), ".npm-global", "bin", "claude"));
  } else {
    candidates.push("/usr/local/bin/claude");
    candidates.push(path.join(os.homedir(), ".local", "bin", "claude"));
    candidates.push(path.join(os.homedir(), ".npm-global", "bin", "claude"));
  }
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return null;
}
const CLAUDE_BIN = findClaudeBin();

// ──────────────────────────────────────────────────────────────────────────
// TCP bridge to MCP server (Claude Code side)
// ──────────────────────────────────────────────────────────────────────────

let tcpSocket = null;
let tcpBuffer = Buffer.alloc(0);
let reconnectTimer = null;

// IMPORTANT: the MCP server (TCP side) is OPTIONAL — it's only running when
// Claude Code has a session open. The native host must stay alive for the
// extension regardless, so we keep retrying TCP in the background without
// ever exiting the process. Exit only when stdin (extension) closes.
function connectTcp() {
  if (tcpSocket) return;
  tcpSocket = new net.Socket();
  tcpSocket.connect(TCP_PORT, "127.0.0.1", () => {
    if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
    // Announce who we are + prove we know the shared secret. The primary
    // drops the connection silently if the secret is wrong, so a rogue
    // process on 127.0.0.1 can't impersonate a browser.
    try {
      tcpSocket.write(JSON.stringify({
        type: "host_hello",
        sessionId: SESSION_ID,
        secret: SHARED_SECRET,
      }) + "\n");
    } catch {}
  });
  tcpSocket.on("data", (chunk) => {
    tcpBuffer = Buffer.concat([tcpBuffer, chunk]);
    // Protect against runaway lines (no newline ever arrives) that would
    // slowly exhaust memory.
    if (tcpBuffer.length > MAX_MESSAGE_BYTES) {
      tcpBuffer = Buffer.alloc(0);
      return;
    }
    let idx;
    while ((idx = tcpBuffer.indexOf(10)) !== -1) {
      const line = tcpBuffer.subarray(0, idx).toString("utf-8").trim();
      tcpBuffer = tcpBuffer.subarray(idx + 1);
      if (!line) continue;
      try { write(JSON.parse(line)); } catch {}
    }
  });
  tcpSocket.on("error", () => { tcpSocket = null; });
  tcpSocket.on("close", () => {
    tcpSocket = null;
    // Retry in the background forever. Cheap — 1 connect attempt every 2s,
    // no data sent until the port accepts.
    if (!reconnectTimer) {
      reconnectTimer = setInterval(() => {
        if (!tcpSocket) connectTcp();
      }, 2000);
    }
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Claude Max spawner — stream JSON events back to the extension
// ──────────────────────────────────────────────────────────────────────────

const activeProcs = new Map();

// ──────────────────────────────────────────────────────────────────────────
// Shared spawn plumbing (used by both the per-query path and the warm pool)
// ──────────────────────────────────────────────────────────────────────────

function readProMode() {
  // Same user-data.json the MCP server reads — single source of truth.
  try {
    const ud = JSON.parse(fs.readFileSync(USER_DATA_PATH, "utf-8"));
    return ud?.proMode === true;
  } catch { return false; }
}

/**
 * Assemble the claude CLI argv for one query. Everything here is knowable
 * BEFORE the prompt exists (the prompt travels via stdin), which is the
 * property the warm pool depends on.
 */
function buildClaudeArgs({ pureMode, model, proMode, systemPromptFile, streamInput }) {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (!pureMode) {
    args.push("--dangerously-skip-permissions");
  } else {
    // No tools available means no permission prompts to skip — disable
    // every built-in tool with the empty allowlist.
    args.push("--tools", "");
  }
  if (model) args.push("--model", String(model));
  if (!pureMode) {
    // Hard filter on built-in tools that could touch the filesystem or
    // spawn shells via the *built-in* Bash/Write/Edit. We use our own
    // explicit MCP tools for those when Pro Mode is on, with proper
    // working-directory sandboxing — better than the CLI built-ins
    // which have no sandbox at all.
    const HARD_DISALLOW = ["Bash", "Write", "Edit", "NotebookEdit"];
    // run_javascript exposes arbitrary Runtime.evaluate on the user's
    // active tab — session-hijack surface in default mode; Pro Mode is
    // the explicit opt-in that unlocks it (same toggle as file/shell).
    if (!proMode) {
      HARD_DISALLOW.push("mcp__claude-companion__run_javascript");
    }
    for (const t of HARD_DISALLOW) args.push("--disallowedTools", t);
    // System prompt rides in a TEMP FILE (--system-prompt-file), never as a
    // raw arg: cmd.exe silently truncates command lines over ~8191 chars,
    // which once mangled the whole invocation (see CLAUDE.md lessons).
    if (systemPromptFile) args.push("--system-prompt-file", systemPromptFile);
  }
  // pureMode intentionally leaves the system prompt empty — the model's
  // default "describe what you see" behaviour is exactly what we want.
  if (streamInput) args.push("--input-format", "stream-json");
  return args;
}

function spawnClaude(args) {
  const isWin = process.platform === "win32";
  // AVOID shell: true on Windows. With shell: true, every arg is
  // interpolated into a cmd.exe command line where metacharacters
  // (`&`, `|`, `>`, `%VAR%`) would execute. Instead, launch .cmd
  // shims via cmd.exe /c with args passed as an array — cmd.exe
  // then hands each arg to the target process without re-parsing.
  let cmd = CLAUDE_BIN;
  let finalArgs = args;
  if (isWin && /\.cmd$/i.test(CLAUDE_BIN)) {
    cmd = process.env.COMSPEC || "cmd.exe";
    finalArgs = ["/d", "/s", "/c", CLAUDE_BIN, ...args];
  }
  const proc = spawn(cmd, finalArgs, {
    shell: false,
    windowsHide: true,
    env: { ...process.env, CLAUDE_COMPANION_SESSION: SESSION_ID },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // A stream 'error' with no listener is an UNCAUGHT exception that kills
  // the whole host. stdin EPIPE is reachable whenever claude dies before
  // (or while) we write the prompt — and a warm proc waits on stdin for
  // minutes, so the window is wide. Swallow it; the proc-level 'error' /
  // 'close' handlers report the failure through the normal channel.
  proc.stdin.on("error", () => {});
  return proc;
}

// ──────────────────────────────────────────────────────────────────────────
// Warm pool — ONE pre-spawned claude process waiting on stdin
//
// Spawning claude fresh per turn pays node boot + config load + MCP connect
// (~100-300ms on Windows) on the critical path of EVERY chat turn. All CLI
// args are knowable before the next query arrives, so after each turn ends
// we pre-spawn the next process and leave it blocked reading stdin — zero
// API traffic until a prompt is written. Adoption is gated by warm-pool.js
// (exact arg-signature match incl. a FRESH proMode read — never adopt stale
// privileges — plus liveness + 15-min age cap). Any miss falls back to the
// fresh-spawn path, byte-identical to the old behaviour.
// ──────────────────────────────────────────────────────────────────────────

let warmSlot = null; // { proc, spFile, signature, spawnedAt, expireTimer }
let shuttingDown = false;

function clearWarmSlot(kill) {
  const w = warmSlot;
  warmSlot = null;
  if (!w) return;
  if (w.expireTimer) clearTimeout(w.expireTimer);
  if (kill) { try { killTree(w.proc); } catch {} }
  if (w.spFile) { try { fs.unlinkSync(w.spFile); } catch {} }
}

// Detach the slot for adoption — caller now owns proc + spFile cleanup.
function takeWarmSlot() {
  const w = warmSlot;
  warmSlot = null;
  if (w?.expireTimer) clearTimeout(w.expireTimer);
  return w;
}

function scheduleWarmUp(model, systemPrompt) {
  if (shuttingDown || !CLAUDE_BIN) return;
  // Small defer so the finished turn's teardown (taskkill, close events)
  // settles first. unref: never keep the host alive just to warm.
  const t = setTimeout(() => { if (!shuttingDown) warmUp(model, systemPrompt); }, 250);
  if (typeof t.unref === "function") t.unref();
}

function warmUp(model, systemPrompt) {
  clearWarmSlot(true); // at most one warm proc, ever
  const proMode = readProMode(); // FRESH — signature must reflect reality NOW
  let spFile = null;
  try {
    if (systemPrompt && systemPrompt.length < 32_768) {
      spFile = path.join(os.tmpdir(), `cc-sys-warm-${process.pid}-${Date.now()}.txt`);
      fs.writeFileSync(spFile, systemPrompt, "utf-8");
    }
    // streamInput: true — warm procs serve non-pure turns, which deliver the
    // prompt as a stream-json user message. This is ALSO what lets the warm
    // proc outlive the 3s plain-stdin timeout (see useStreamInput in
    // handleMaxQuery): stream-json input waits indefinitely for the first
    // message, so the slot survives until the user's next turn.
    const args = buildClaudeArgs({
      pureMode: false, model, proMode, systemPromptFile: spFile, streamInput: true,
    });
    const proc = spawnClaude(args);
    const slot = { proc, spFile, signature: computeWarmSignature({ model, proMode, systemPrompt }), spawnedAt: Date.now(), expireTimer: null };
    // Age out: a warm proc older than this may predate a CLI update or a
    // login change — kill it rather than risk adopting a zombie.
    slot.expireTimer = setTimeout(() => { if (warmSlot === slot) clearWarmSlot(true); }, WARM_MAX_AGE_MS);
    if (typeof slot.expireTimer.unref === "function") slot.expireTimer.unref();
    // Spontaneous death (crash, external kill, CLI self-update) frees the
    // slot so isWarmUsable can never see a corpse with stale handles.
    proc.on("error", () => { if (warmSlot === slot) clearWarmSlot(false); });
    proc.on("close", () => { if (warmSlot === slot) clearWarmSlot(false); });
    warmSlot = slot;
    try { process.stderr.write(`[native-host] warm CLI spawned (pid ${proc.pid})\n`); } catch {}
  } catch {
    if (spFile) { try { fs.unlinkSync(spFile); } catch {} }
  }
}

function streamClaude(id, proc) {
  let buf = "";
  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf-8");
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        write({ id, type: "max_event", event });
      } catch {
        write({ id, type: "max_text", text: line });
      }
    }
  });
  let err = "";
  proc.stderr.on("data", (c) => { err += c.toString("utf-8"); });
  proc.on("error", (e) => {
    activeProcs.delete(id);
    write({ id, type: "max_error", error: e.message });
  });
  proc.on("close", (code) => {
    activeProcs.delete(id);
    if (buf.trim()) write({ id, type: "max_text", text: buf.trim() });
    write({ id, type: "max_done", exitCode: code, stderr: err.slice(-500) });
  });
}

// Host-side caps on user-controllable payload. Panel already caps at
// the UI level, but a compromised extension page could bypass that —
// this is the authoritative limit. Generous enough to fit legitimate
// pasted articles + screenshots, tight enough to block DoS.
const MAX_PROMPT_CHARS = 256 * 1024;         // 256 KB of UTF-16
const MAX_IMAGE_BYTES  = 10 * 1024 * 1024;   // 10 MB per image (base64 → ~7.5 MB raw)
const MAX_IMAGE_COUNT  = 8;
const IMAGE_MEDIA_OK   = /^image\/(png|jpeg|jpg|webp|gif)$/i;

function handleMaxQuery(msg) {
  if (!CLAUDE_BIN) {
    write({ id: msg.id, type: "max_error", error: "NO_CLAUDE_CLI" });
    return;
  }
  const prompt = String(msg.prompt || "");
  if (prompt.length > MAX_PROMPT_CHARS) {
    write({ id: msg.id, type: "max_error", error: "prompt exceeds 256KB cap" });
    return;
  }
  const incomingImages = Array.isArray(msg.images) ? msg.images : [];
  const dropReasons = [];
  const images = incomingImages
    .slice(0, MAX_IMAGE_COUNT)
    .filter((img, idx) => {
      if (!img || typeof img !== "object") {
        dropReasons.push(`[${idx}] not-an-object`);
        return false;
      }
      const mt = String(img.mediaType || "");
      if (!IMAGE_MEDIA_OK.test(mt)) {
        dropReasons.push(`[${idx}] bad-mediaType="${mt}"`);
        return false;
      }
      const b64 = String(img.base64 || "");
      if (b64.length === 0) {
        dropReasons.push(`[${idx}] empty-base64`);
        return false;
      }
      if (b64.length > MAX_IMAGE_BYTES) {
        dropReasons.push(`[${idx}] too-big=${b64.length}B>${MAX_IMAGE_BYTES}B`);
        return false;
      }
      return true;
    });
  // Diagnostic: surface the silent-drop path. If the user pastes an
  // image and it never reaches Claude, the log here tells us exactly
  // why (wrong mediaType, size over cap, malformed entry). Writes to
  // stderr for bin-run logs and emits max_debug so the extension's
  // service-worker console can see it too.
  if (incomingImages.length !== images.length) {
    const line = `[native-host] images: ${incomingImages.length} in, ${images.length} kept. Dropped: ${dropReasons.join("; ")}`;
    try { process.stderr.write(line + "\n"); } catch {}
    write({ type: "max_debug", id: msg.id, line });
  } else if (incomingImages.length > 0) {
    try {
      process.stderr.write(`[native-host] images: all ${images.length} accepted (types: ${images.map((i) => i.mediaType).join(",")})\n`);
    } catch {}
  }
  if (!prompt && images.length === 0) {
    write({ id: msg.id, type: "max_error", error: "EMPTY_PROMPT" });
    return;
  }

  // Project memory — auto-load CLAUDE.md + _STATE.md from the Pro
  // Mode working directory and prepend their contents to the user
  // prompt. Why this exists: the model has no memory across chat
  // sessions; a fresh chat starts from zero. By keeping a CLAUDE.md
  // (stable docs: architecture, conventions, lessons) and a _STATE.md
  // (working memory: what's done, what's next) in the project
  // directory, every session begins with the relevant context loaded
  // automatically. The `update_project_state` MCP tool lets Claude
  // refresh _STATE.md at the end of a session.
  //
  // Design notes:
  //   • Goes into the DYNAMIC user message, NOT the static system
  //     prompt. _STATE.md changes turn-by-turn, so caching it as
  //     "static" would invalidate the prompt cache constantly. Putting
  //     it in user text keeps the static block (rules, aliases) cached.
  //   • Pro Mode + workingDirectory required. Non-Pro users see no
  //     change in behaviour.
  //   • Caps: CLAUDE.md ≤ 8 KB, _STATE.md ≤ 4 KB. Beyond that the
  //     project-memory cost outweighs the value; the user gets a
  //     truncation note in the same block so the model knows.
  //   • Image-Q&A (pureMode) skips this — context bleed is exactly
  //     what we're trying to avoid there.
  let projectContextBlock = "";
  if (msg.pureMode !== true) {
    try {
      const ud = JSON.parse(fs.readFileSync(USER_DATA_PATH, "utf-8"));
      if (ud?.proMode === true && typeof ud?.workingDirectory === "string" && ud.workingDirectory) {
        const wd = path.resolve(ud.workingDirectory);
        const wdName = path.basename(wd) || wd;
        const parts = [];
        const tryRead = (filename, capBytes) => {
          const p = path.join(wd, filename);
          try {
            const stat = fs.statSync(p);
            if (!stat.isFile()) return null;
            // Don't read absurdly-large files — likely not a memory file.
            if (stat.size > 64 * 1024) return null;
            const raw = fs.readFileSync(p, "utf-8");
            const truncated = raw.length > capBytes;
            const text = truncated ? raw.slice(0, capBytes) : raw;
            return { text, truncated };
          } catch {
            return null;
          }
        };
        const claude = tryRead("CLAUDE.md", 8 * 1024);
        if (claude) {
          parts.push(`PROJECT CONTEXT (${wdName}/CLAUDE.md):\n${claude.text}` +
            (claude.truncated ? "\n…(truncated at 8 KB)" : ""));
        }
        const state = tryRead("_STATE.md", 4 * 1024);
        if (state) {
          parts.push(`PROJECT STATE (${wdName}/_STATE.md — kept fresh by update_project_state tool):\n${state.text}` +
            (state.truncated ? "\n…(truncated at 4 KB)" : ""));
        }
        if (parts.length > 0) {
          projectContextBlock = parts.join("\n\n") + "\n\n──────────────\n\n";
        }
      }
    } catch {
      // Missing user-data, malformed JSON, etc. — degrade silently.
    }
  }
  // The model sees this concatenation as one user message. The "──"
  // separator above is a strong visual cue between project context
  // and the user's actual turn-of-conversation prompt.
  const finalPrompt = projectContextBlock + prompt;

  // pureMode = "this is a vanilla image-Q&A turn, strip everything".
  // The browser-agent flow needs tools, a system prompt, and the rest of
  // the harness. Image questions ("what's in this picture?") need NONE
  // of that — the model is perfectly capable of answering on its own,
  // and every extra context block is a chance for it to hallucinate
  // ("I see Claude's logo" instead of reading the actual pixels).
  // pureMode skips: --system-prompt, --disallowedTools, the dummy MCP
  // wiring. What's left is a clean Messages API call: image + question
  // → text, like calling claude.ai directly.
  const pureMode = msg.pureMode === true;

  // msg.model is validated against a strict allowlist before reaching the
  // CLI — a crafted "model" field like "foo & calc.exe" would otherwise
  // ride into cmd.exe when we go through a shell on Windows. isModelAllowed
  // lives in ./security.js (shared, unit-tested).
  if (msg.model && !isModelAllowed(msg.model)) {
    write({ id: msg.id, type: "max_error", error: "invalid model name" });
    return;
  }

  // One fresh proMode read per query: it feeds both the --disallowedTools
  // list and the warm-pool signature, and reading it once keeps the two
  // consistent (a stale-privilege warm proc can never slip past the gate).
  const proMode = readProMode();
  // Static system prompt — file-passed so the never-changing block hits
  // Anthropic's server-side prompt cache (5 min TTL, ~90% discount).
  const systemPrompt = !pureMode && typeof msg.system === "string" ? msg.system : "";
  const hasImages = images.length > 0;
  // CRITICAL for the warm pool: `claude -p` with PLAIN stdin self-aborts if
  // no data arrives within 3s ("no stdin data received in 3s"), so a process
  // pre-spawned more than 3s before the next turn is dead on arrival. The
  // stream-json INPUT format has no such timeout — it waits indefinitely for
  // the first user message (verified live: 6s idle then processed normally).
  // So every warm-able (non-pure) turn delivers its prompt as a stream-json
  // user message, not raw text. pure image-Q&A already used stream-json for
  // image blocks; pure text turns keep raw stdin (never warm-pooled).
  const useStreamInput = !pureMode || hasImages;

  // Path of the temp file holding the system prompt. Declared here so the
  // post-spawn close handler can delete it. null when unused.
  let spFile = null;
  let proc = null;

  // Warm-pool adoption: a pre-spawned claude with EXACTLY these args is
  // sitting on its stdin stream → skip the cold start and just feed it the
  // prompt. Image and pureMode turns use different args and always spawn
  // fresh. Any miss (signature, liveness, age) also falls through to the
  // fresh path — behaviour identical to pre-warm-pool.
  const sig = computeWarmSignature({ model: msg.model, proMode, systemPrompt });
  if (!pureMode && !hasImages && isWarmUsable(warmSlot, sig, Date.now())) {
    const w = takeWarmSlot();
    proc = w.proc;
    spFile = w.spFile;
    const ageMs = Date.now() - w.spawnedAt;
    try { process.stderr.write(`[native-host] warm CLI adopted (${ageMs}ms old) — cold start skipped\n`); } catch {}
    write({ type: "max_debug", id: msg.id, line: `warm CLI adopted (${(ageMs / 1000).toFixed(1)}s old) — cold start skipped` });
  } else if (warmSlot && !pureMode && !hasImages) {
    // A warm proc exists but can't serve this TEXT query (model switch,
    // Pro toggle, system-prompt change, stale). Kill it — wrong-args
    // processes must never linger — and let the post-turn re-warm build
    // the right one. pure/image turns DON'T clear the slot: they never
    // use it, and it stays valid for the next ordinary text turn.
    clearWarmSlot(true);
  }

  try {
    if (!proc) {
      if (systemPrompt) {
        // 32 KB sanity cap lives in the same check as before.
        if (systemPrompt.length < 32_768) {
          try {
            const safeId = String(msg.id || Date.now()).replace(/[^a-zA-Z0-9_-]/g, "");
            spFile = path.join(os.tmpdir(), `cc-sys-${safeId}.txt`);
            fs.writeFileSync(spFile, systemPrompt, "utf-8");
          } catch {
            spFile = null; // fall back to the default system prompt, never crash
          }
        }
      }
      const args = buildClaudeArgs({
        pureMode, model: msg.model, proMode, systemPromptFile: spFile, streamInput: useStreamInput,
      });
      proc = spawnClaude(args);
    }
    activeProcs.set(msg.id, proc);
    streamClaude(msg.id, proc);
    // Delete the system-prompt temp file once claude exits (it has been read
    // by then). Best-effort — a leftover temp file is harmless.
    if (spFile) {
      const f = spFile;
      proc.on("close", () => { try { fs.unlinkSync(f); } catch {} });
    }
    // Pre-warm the NEXT turn's process once this one finishes. Uses this
    // turn's model + system prompt as the best prediction of the next
    // turn's args (proMode is re-read fresh at warm time AND at adoption).
    if (!pureMode) {
      proc.on("close", () => scheduleWarmUp(msg.model, systemPrompt));
    }
    try {
      if (useStreamInput) {
        // stream-json user message with text + any image content blocks.
        // Used for ALL non-pure turns (warm-pool requirement) and any image
        // turn. pureMode image-Q&A skipped the project-context block above,
        // so finalPrompt === prompt there; non-pure turns carry it.
        const content = [];
        if (finalPrompt) content.push({ type: "text", text: finalPrompt });
        for (const img of images) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: img.mediaType || "image/png",
              data: img.base64 || "",
            },
          });
        }
        const userMsg = {
          type: "user",
          message: { role: "user", content },
        };
        proc.stdin.write(JSON.stringify(userMsg) + "\n");
        proc.stdin.end();
      } else {
        // pure text Q&A — raw stdin, never warm-pooled.
        proc.stdin.write(finalPrompt);
        proc.stdin.end();
      }
    } catch (e) {
      write({ id: msg.id, type: "max_error", error: "stdin: " + e.message });
    }
  } catch (e) {
    write({ id: msg.id, type: "max_error", error: `spawn: ${e.message}` });
  }
}

// Kill a process AND all its children. On Windows, SIGTERM doesn't propagate
// to the process tree — we need `taskkill /T` to nuke the whole branch,
// otherwise claude's child mcp-server keeps emitting tool requests.
function killTree(proc) {
  if (!proc || proc.killed) return;
  if (process.platform === "win32" && proc.pid) {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { windowsHide: true })
        .on("error", () => { try { proc.kill("SIGKILL"); } catch {} });
    } catch { try { proc.kill("SIGKILL"); } catch {} }
  } else {
    try { proc.kill("SIGTERM"); } catch {}
    // Escalate if still alive after 1s
    setTimeout(() => { try { if (!proc.killed) proc.kill("SIGKILL"); } catch {} }, 1000);
  }
}

function handleMaxCancel(msg) {
  const p = activeProcs.get(msg.id);
  if (p) killTree(p);
  activeProcs.delete(msg.id);
}

// Cancel ALL active claude processes — used when we want a hard stop
// regardless of which specific run the user meant.
function cancelAllActive() {
  for (const [id, p] of activeProcs) {
    killTree(p);
    activeProcs.delete(id);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// User data persistence — survives extension uninstall
//   chrome.storage.local dies with the extension, so we mirror memories/tasks
//   to a file in the user's home. Read on startup, written on every save.
//   USER_DATA_PATH is declared at the top of this file so the Pro-Mode
//   detection in handleMaxQuery can read it without a forward reference.
// ──────────────────────────────────────────────────────────────────────────


function handleLoadUserData(msg) {
  let data = null;
  try {
    const raw = fs.readFileSync(USER_DATA_PATH, "utf-8");
    data = JSON.parse(raw);
  } catch {
    // Missing or corrupt — treat as empty. A fresh install on a fresh machine
    // lands here and will populate the file on first save.
    data = null;
  }
  write({ id: msg.id, type: "user_data_result", data });
}

function handleSaveUserData(msg) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    // Atomic: write to tmp then rename. If we crash mid-write, the original
    // stays intact instead of becoming a half-written JSON blob.
    const tmp = USER_DATA_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(msg.data || {}, null, 2), "utf-8");
    fs.renameSync(tmp, USER_DATA_PATH);
    write({ id: msg.id, type: "user_data_saved", ok: true });
  } catch (e) {
    write({ id: msg.id, type: "user_data_saved", ok: false, error: e.message });
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Diagnostic — answers "what's actually wrong with my setup?"
// ──────────────────────────────────────────────────────────────────────────

function handleDiag(msg) {
  // native-host.js lives in <project>/host/, so go up one level to get project root.
  const hostDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
  const projectRoot = path.resolve(hostDir, "..");
  write({
    id: msg.id,
    type: "diag_result",
    checks: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      claudeCli: { found: !!CLAUDE_BIN, path: CLAUDE_BIN },
      mcpReachable: !!(tcpSocket && !tcpSocket.destroyed),
      hostPid: process.pid,
      tcpPort: TCP_PORT,
      projectRoot,
    },
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Main dispatch loop
// ──────────────────────────────────────────────────────────────────────────

let stdinBuf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  stdinBuf = Buffer.concat([stdinBuf, chunk]);
  const { messages, remainder } = readMessages(stdinBuf);
  stdinBuf = remainder;

  /** @type {import("./src/types").InboundMessage[]} */
  const typed = messages;
  for (const m of typed) {
    switch (m.type) {
      case "ping":
        write({ type: "pong", id: m.id, ts: Date.now(), claudeBin: CLAUDE_BIN });
        break;
      case "diag":
        handleDiag(m);
        break;
      case "max_query":
        handleMaxQuery(m);
        break;
      case "max_cancel":
        handleMaxCancel(m);
        break;
      case "cancel_all":
        cancelAllActive();
        break;
      case "load_user_data":
        handleLoadUserData(m);
        break;
      case "save_user_data":
        handleSaveUserData(m);
        break;
      default:
        // Forward unknown messages to MCP server (e.g. tool_request/tool_response)
        if (tcpSocket && !tcpSocket.destroyed) {
          tcpSocket.write(JSON.stringify(m) + "\n");
        }
    }
  }
});

// When the browser goes away (stdin EOF on the native-messaging pipe)
// we MUST take every claude subprocess with us. Using p.kill() here
// sends SIGTERM, which Windows doesn't propagate to grandchildren —
// so claude's own mcp-server kept running after browser close, and
// its tool calls kept firing on the next browser launch. killTree
// shells out to `taskkill /F /T /PID` on Windows and does the full
// SIGTERM→SIGKILL dance on POSIX.
//
// SIGINT / SIGTERM / SIGHUP cover the other ways this process can be
// asked to quit (Ctrl-C from a dev shell, OS shutdown, service mgr).
function shutdown() {
  shuttingDown = true; // blocks any pending scheduleWarmUp from respawning
  clearWarmSlot(true); // the warm proc is OUR child too — never orphan it
  if (tcpSocket) { try { tcpSocket.destroy(); } catch {} }
  for (const p of activeProcs.values()) { try { killTree(p); } catch {} }
  activeProcs.clear();
  // Give taskkill a beat to finish before we exit, otherwise Node
  // tears down the spawn handles mid-call and the taskkill process
  // inherits nothing to operate on.
  setTimeout(() => process.exit(0), 150);
}
process.stdin.on("end", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);

// Announce readiness immediately.
write({ type: "ready", claudeBin: CLAUDE_BIN, ts: Date.now(), tcpPort: TCP_PORT });

connectTcp();
