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

// ──────────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────────

const DEFAULT_TCP_PORT = 18799; // distinct from old project's 18765
const CONFIG_DIR = path.join(os.homedir(), ".config", "claude-companion");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

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

  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (!pureMode) {
    args.push("--dangerously-skip-permissions");
  } else {
    // No tools available means no permission prompts to skip — disable
    // every built-in tool with the empty allowlist.
    args.push("--tools", "");
  }
  // msg.model is validated against a strict allowlist before reaching the
  // CLI — a crafted "model" field like "foo & calc.exe" would otherwise
  // ride into cmd.exe when we go through a shell on Windows.
  const MODEL_ALLOWED = /^[A-Za-z0-9._:/-]{1,64}$/;
  if (msg.model) {
    if (!MODEL_ALLOWED.test(String(msg.model))) {
      write({ id: msg.id, type: "max_error", error: "invalid model name" });
      return;
    }
    args.push("--model", String(msg.model));
  }

  if (!pureMode) {
    // Hard filter on built-in tools that could touch the filesystem or
    // spawn shells. Respected even with --dangerously-skip-permissions.
    const HARD_DISALLOW = [
      "Bash", "Write", "Edit", "NotebookEdit",
      "mcp__claude-companion__run_javascript",
    ];
    for (const t of HARD_DISALLOW) args.push("--disallowedTools", t);

    // Static system prompt — passed via --system-prompt so the portion
    // that never changes between turns hits Anthropic's server-side
    // prompt cache (5 min TTL, ~90% discount on cached tokens).
    const systemPrompt = typeof msg.system === "string" ? msg.system : "";
    if (systemPrompt && systemPrompt.length < 8000) {
      args.push("--system-prompt", systemPrompt);
    }
  }
  // pureMode intentionally leaves the system prompt empty — the model's
  // default "describe what you see" behaviour is exactly what we want.

  // If the user pasted images, switch to stream-json input so we can attach
  // them as proper image content blocks instead of text.
  if (images.length > 0) {
    args.push("--input-format", "stream-json");
  }

  try {
    const isWin = process.platform === "win32";
    // AVOID shell: true on Windows. With shell: true, every arg is
    // interpolated into a cmd.exe command line where metacharacters
    // (`&`, `|`, `>`, `%VAR%`) would execute. Instead, launch .cmd
    // shims via cmd.exe /c with args passed as an array — cmd.exe
    // then hands each arg to the target process without re-parsing.
    let cmd = CLAUDE_BIN;
    let finalArgs = args;
    let useShell = false;
    if (isWin && /\.cmd$/i.test(CLAUDE_BIN)) {
      cmd = process.env.COMSPEC || "cmd.exe";
      finalArgs = ["/d", "/s", "/c", CLAUDE_BIN, ...args];
    }
    const proc = spawn(cmd, finalArgs, {
      shell: useShell,
      windowsHide: true,
      env: { ...process.env, CLAUDE_COMPANION_SESSION: SESSION_ID },
      stdio: ["pipe", "pipe", "pipe"],
    });
    activeProcs.set(msg.id, proc);
    streamClaude(msg.id, proc);
    try {
      if (images.length > 0) {
        // stream-json user message with text + image content blocks
        const content = [];
        if (prompt) content.push({ type: "text", text: prompt });
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
        proc.stdin.write(prompt);
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
// ──────────────────────────────────────────────────────────────────────────

const USER_DATA_PATH = path.join(CONFIG_DIR, "user-data.json");

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
