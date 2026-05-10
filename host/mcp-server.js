#!/usr/bin/env node

/**
 * MCP server for Claude Companion.
 *
 * Exposes browser tools (read_page, navigate, click, …) to Claude Code via
 * stdio MCP. Tool calls are forwarded over TCP to whichever native-host
 * (browser) is currently "active" — the most recently connected one.
 *
 * Multi-browser handling (important!):
 *   If the user has the extension running in both Brave AND Chrome, each
 *   browser spawns its own native-host that connects here as a TCP client.
 *   We track them all, but route tool calls to a SINGLE "active" one — the
 *   last to send activity. This lets the user naturally switch by using the
 *   side panel in whichever browser they want.
 *
 *   A background "which-browser-am-I-in?" ping could refine this, but the
 *   last-active heuristic covers ~99% of real usage without complexity.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// ──────────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────────

const DEFAULT_PORT = 18799;
const CONFIG_DIR = path.join(os.homedir(), ".config", "claude-companion");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
// Pro Mode settings live in the same user-data.json that the extension
// mirrors to disk. We re-read it on every Pro-Mode tool call (cheap —
// it's a few KB) so toggling Pro Mode in the UI takes effect on the
// VERY NEXT tool invocation, no restart required.
const USER_DATA_PATH = path.join(CONFIG_DIR, "user-data.json");
function loadProModeSettings() {
  try {
    const raw = fs.readFileSync(USER_DATA_PATH, "utf-8");
    const data = JSON.parse(raw);
    return {
      proMode: data.proMode === true,
      workingDirectory: typeof data.workingDirectory === "string" ? data.workingDirectory : "",
    };
  } catch {
    return { proMode: false, workingDirectory: "" };
  }
}
// Validate that `inputPath` resolves inside `workingDirectory` (and only
// inside — symlinks pointing out are rejected). Throws on violations so
// the MCP tool returns an error to Claude. Path arg may be absolute or
// relative — we resolve against workingDirectory in either case.
function validatePath(inputPath, workingDirectory) {
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
    if (e.code === "ENOENT") return abs;   // file doesn't exist yet — return lexical
    throw e;
  }
}
// Gate every Pro-Mode tool with this. Throws (Claude sees the message)
// if Pro Mode is off or working directory isn't set.
function requireProMode() {
  const settings = loadProModeSettings();
  if (!settings.proMode) {
    throw new Error("Pro Mode is off. Enable it in the extension settings to use file/shell tools.");
  }
  if (!settings.workingDirectory) {
    throw new Error("Pro Mode is on but working directory is empty. Set it in extension settings.");
  }
  return settings;
}

// Locate a Chrome (or Chromium-flavoured) binary we can drive headlessly
// for PDF generation. Almost certain to succeed because the user is
// running the extension — they have a Chromium browser installed.
// Search order biased to Brave / Chrome first, falling back to Edge.
function findChromeBin() {
  const candidates = [];
  if (process.platform === "win32") {
    const pf = process.env["PROGRAMFILES"] || "C:\\Program Files";
    const pfx = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    candidates.push(
      path.join(localApp, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      path.join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pfx, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(localApp, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(pfx, "Microsoft", "Edge", "Application", "msedge.exe"),
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
  } else {
    candidates.push(
      "/usr/bin/brave-browser", "/usr/bin/google-chrome",
      "/usr/bin/chromium", "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
      "/snap/bin/chromium",
    );
  }
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  return null;
}

// Shared with native-host.js — keep logic identical so both sides converge
// on the same secret regardless of who starts first.
function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); } catch {}
  let changed = false;
  if (!cfg.port) { cfg.port = DEFAULT_PORT; changed = true; }
  if (typeof cfg.secret !== "string" || cfg.secret.length < 32) {
    cfg.secret = randomBytes(32).toString("hex");
    changed = true;
  }
  if (changed) {
    try {
      // Owner-only perms — see native-host.js for the rationale.
      fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    } catch {}
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

// Constant-time comparison so a rogue local process can't time the check.
function secretOK(claimed) {
  if (typeof claimed !== "string" || claimed.length !== SHARED_SECRET.length) return false;
  try {
    return timingSafeEqual(Buffer.from(claimed, "utf-8"), Buffer.from(SHARED_SECRET, "utf-8"));
  } catch { return false; }
}

// ──────────────────────────────────────────────────────────────────────────
// TCP server — accepts native-host connections + sibling mcp-server clients
// ──────────────────────────────────────────────────────────────────────────

// There can be many Claude Code sessions running simultaneously. Only ONE
// mcp-server binds the port (the "primary"); the others become clients of
// the primary. All tool requests, from any Claude Code session, get funneled
// through the primary to the active native-host.

let mode = "primary";      // or "client"
const nativeHostSockets = [];  // connected browser native-hosts
let activeNativeHost = null;   // last-used browser (fallback target)
const hostsBySession = new Map(); // sessionId -> native-host socket (precise routing)
const siblingClients = new Map(); // other mcp-server clients
let siblingIdCounter = 0;
let pendingRequests = new Map();  // requestId → { resolve, reject, timer }
let requestCounter = 0;
let primarySocket = null;
let clientBuffer = Buffer.alloc(0);

// If we were spawned by a native-host's `claude -p`, this env var tells us
// which browser session to route tool requests back to.
const MY_SESSION = process.env.CLAUDE_COMPANION_SESSION || null;

// Pick the destination native-host for a tool request.
// Priority:
//   1. Exact session match (request originated from a specific browser)
//   2. activeNativeHost (user-initiated Claude Code session → follow focus)
//   3. Any live host
function pickHostFor(sessionId) {
  if (sessionId) {
    const exact = hostsBySession.get(sessionId);
    if (exact && !exact.destroyed) return exact;
  }
  if (activeNativeHost && !activeNativeHost.destroyed) return activeNativeHost;
  return nativeHostSockets.find((s) => !s.destroyed) || null;
}

function sendToHost(obj, sessionId) {
  const target = pickHostFor(sessionId);
  if (!target) return false;
  try {
    target.write(JSON.stringify(obj) + "\n");
    return true;
  } catch { return false; }
}

function handleNativeHostMessage(socket, msg) {
  // host_hello registers this host under its session id for precise routing.
  if (msg.type === "host_hello" && msg.sessionId) {
    socket._sessionId = msg.sessionId;
    hostsBySession.set(msg.sessionId, socket);
    activeNativeHost = socket;
    return;
  }

  // Any other message from a host marks it as active (fallback focus).
  activeNativeHost = socket;

  // Tool response from the browser → complete the pending request
  if (msg.id && pendingRequests.has(msg.id)) {
    const { resolve, reject, timer } = pendingRequests.get(msg.id);
    clearTimeout(timer);
    pendingRequests.delete(msg.id);
    if (msg.type === "tool_error") reject(new Error(msg.error || "Tool failed"));
    else resolve(msg.result);
    return;
  }

  // Sibling-client request result? Forward back to that client.
  // Strict format: "c<digits>_<origId>". Anything else is a foreign id and
  // must NOT be routed to any sibling — that would leak tool output across
  // Claude Code sessions.
  if (msg.id && typeof msg.id === "string") {
    const m = /^c(\d+)_(.+)$/.exec(msg.id);
    if (!m) return;
    const clientId = m[1];
    const origId = m[2];
    const client = siblingClients.get(clientId);
    if (client && !client.destroyed) {
      client.write(JSON.stringify({ ...msg, id: origId }) + "\n");
    }
  }
}

function handleSiblingClientMessage(clientId, socket, msg) {
  if (msg.type === "tool_request" && msg.id) {
    // Prefix so we can route the reply back to this sibling client.
    const prefixedId = `c${clientId}_${msg.id}`;
    // msg.session is the originating browser — if set, route precisely; else
    // fall back to active host (works for user's manual Claude Code sessions).
    if (!sendToHost({ ...msg, id: prefixedId }, msg.session)) {
      socket.write(JSON.stringify({ id: msg.id, type: "tool_error", error: "No browser connected." }) + "\n");
    }
  }
}

// Same DoS guard as native-host — reject a runaway unterminated line.
const MAX_LINE_BYTES = 16 * 1024 * 1024;

function parseLines(socket, bufProp, chunk, onLine) {
  socket[bufProp] = Buffer.concat([socket[bufProp] || Buffer.alloc(0), chunk]);
  if (socket[bufProp].length > MAX_LINE_BYTES) {
    socket[bufProp] = Buffer.alloc(0);
    try { socket.destroy(); } catch {}
    return;
  }
  let idx;
  while ((idx = socket[bufProp].indexOf(10)) !== -1) {
    const line = socket[bufProp].subarray(0, idx).toString("utf-8").trim();
    socket[bufProp] = socket[bufProp].subarray(idx + 1);
    if (!line) continue;
    try { onLine(JSON.parse(line)); } catch {}
  }
}

const tcpServer = net.createServer((socket) => {
  // SECURITY: every connection must send a hello line with a valid secret
  // within 2 seconds. No more "silent = native-host" inference — that was
  // a soft spot where any local process could impersonate a browser just
  // by opening the port.
  let classified = false;
  let early = Buffer.alloc(0);

  const cls = setTimeout(() => {
    if (!classified) {
      classified = true;
      // No hello arrived — drop. Legitimate clients always send immediately.
      try { socket.destroy(); } catch {}
    }
  }, 2000);

  socket.on("data", function onEarly(chunk) {
    if (classified) return;
    early = Buffer.concat([early, chunk]);
    // Cap early buffer so a flood of non-newline bytes can't exhaust memory
    // before the timeout fires.
    if (early.length > 64 * 1024) {
      classified = true;
      clearTimeout(cls);
      try { socket.destroy(); } catch {}
      return;
    }
    const nl = early.indexOf(10);
    if (nl === -1) return;
    const firstLine = early.subarray(0, nl).toString("utf-8").trim();
    let first = null;
    try { first = JSON.parse(firstLine); } catch {}
    if (!first || !secretOK(first.secret)) {
      classified = true;
      clearTimeout(cls);
      try { socket.destroy(); } catch {}
      return;
    }
    classified = true;
    clearTimeout(cls);
    socket.removeListener("data", onEarly);
    const rest = early.subarray(nl + 1);
    if (first.type === "client_hello") {
      setupAsSiblingClient(socket, rest);
    } else if (first.type === "host_hello") {
      // Register the session immediately from the hello so the first
      // tool_request after connect routes correctly.
      if (first.sessionId) {
        // Custom property on Socket — tolerated by Node but not in Socket's
        // type. Cast keeps checkJs happy.
        /** @type {any} */ (socket)._sessionId = first.sessionId;
        hostsBySession.set(first.sessionId, socket);
      }
      setupAsNativeHost(socket, rest);
    } else {
      try { socket.destroy(); } catch {}
    }
  });
});

function setupAsNativeHost(socket, initial) {
  nativeHostSockets.push(socket);
  activeNativeHost = socket;
  parseLines(socket, "_buf", initial, (m) => handleNativeHostMessage(socket, m));
  socket.on("data", (c) => parseLines(socket, "_buf", c, (m) => handleNativeHostMessage(socket, m)));
  socket.on("error", () => {});
  socket.on("close", () => {
    const i = nativeHostSockets.indexOf(socket);
    if (i >= 0) nativeHostSockets.splice(i, 1);
    // Only delete if the map still points at THIS socket — otherwise a fresh
    // reconnect under the same sessionId could get clobbered by the old
    // socket's late close handler.
    if (socket._sessionId && hostsBySession.get(socket._sessionId) === socket) {
      hostsBySession.delete(socket._sessionId);
    }
    if (activeNativeHost === socket) {
      activeNativeHost = nativeHostSockets[nativeHostSockets.length - 1] || null;
    }
  });
}

function setupAsSiblingClient(socket, initial) {
  const id = String(++siblingIdCounter);
  siblingClients.set(id, socket);
  socket.write(JSON.stringify({ type: "client_ack", clientId: id }) + "\n");
  parseLines(socket, "_buf", initial, (m) => handleSiblingClientMessage(id, socket, m));
  socket.on("data", (c) => parseLines(socket, "_buf", c, (m) => handleSiblingClientMessage(id, socket, m)));
  socket.on("error", () => {});
  socket.on("close", () => { siblingClients.delete(id); });
}

// ──────────────────────────────────────────────────────────────────────────
// Primary/client mode
// ──────────────────────────────────────────────────────────────────────────

tcpServer.on("error", async (/** @type {NodeJS.ErrnoException} */ err) => {
  if (err.code !== "EADDRINUSE") throw err;
  // Another mcp-server is already primary — become a client of it.
  mode = "client";
  primarySocket = new net.Socket();
  primarySocket.connect(TCP_PORT, "127.0.0.1", () => {
    primarySocket.write(JSON.stringify({ type: "client_hello", secret: SHARED_SECRET }) + "\n");
  });
  primarySocket.on("data", (chunk) => {
    clientBuffer = Buffer.concat([clientBuffer, chunk]);
    let idx;
    while ((idx = clientBuffer.indexOf(10)) !== -1) {
      const line = clientBuffer.subarray(0, idx).toString("utf-8").trim();
      clientBuffer = clientBuffer.subarray(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && pendingRequests.has(msg.id)) {
          const { resolve, reject, timer } = pendingRequests.get(msg.id);
          clearTimeout(timer);
          pendingRequests.delete(msg.id);
          if (msg.type === "tool_error") reject(new Error(msg.error || "Tool failed"));
          else resolve(msg.result);
        }
      } catch {}
    }
  });
  primarySocket.on("error", () => process.exit(1));
});
tcpServer.listen(TCP_PORT, "127.0.0.1");

// ──────────────────────────────────────────────────────────────────────────
// Unified request dispatch — works in both primary and client modes
// ──────────────────────────────────────────────────────────────────────────

function request(tool, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const id = String(++requestCounter);
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Tool '${tool}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pendingRequests.set(id, { resolve, reject, timer });

    // Tag with session so the primary routes us back to the originating browser.
    const payload = { id, type: "tool_request", tool, args };
    if (MY_SESSION) payload.session = MY_SESSION;

    if (mode === "primary") {
      if (!sendToHost(payload, MY_SESSION)) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        reject(new Error("Browser extension is not connected. Open the extension in a Chromium browser."));
      }
    } else {
      if (!primarySocket || primarySocket.destroyed) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        reject(new Error("Lost connection to primary mcp-server."));
        return;
      }
      primarySocket.write(JSON.stringify(payload) + "\n");
    }
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Tool definitions — 18 browser tools exposed to Claude Code
// ──────────────────────────────────────────────────────────────────────────

const server = new McpServer({ name: "claude-companion", version: "1.0.0" });

const coord = z.array(z.number()).length(2).describe("[x, y] in CSS pixels");

server.tool("tabs_context", "Get current active tab info (url, title, tab id, window id).", {}, async () => {
  const r = await request("tabs_context", {});
  return { content: [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r, null, 2) }] };
});

server.tool("tabs_create", "Open a new tab with optional URL.", {
  url: z.string().optional(),
  active: z.boolean().optional(),
}, async (a) => ({ content: [{ type: "text", text: String(await request("tabs_create", a)) }] }));

server.tool("navigate", "Navigate the current tab to a URL, go back, or go forward.", {
  url: z.string().optional(),
  direction: z.enum(["back", "forward"]).optional(),
}, async (a) => ({ content: [{ type: "text", text: String(await request("navigate", a)) }] }));

server.tool("read_page", "Get page accessibility tree with interactive element refs. Returns a diff on subsequent same-URL calls.", {
  filter: z.enum(["interactive", "all"]).optional(),
  full: z.boolean().optional(),
}, async (a) => ({ content: [{ type: "text", text: String(await request("read_page", a)) }] }));

server.tool("get_page_text", "Extract the main article/body text from the page. Strips nav/footer/ads (Readability-style).", {}, async () => ({
  content: [{ type: "text", text: String(await request("get_page_text", {})) }],
}));

server.tool("find", "Find elements by text or CSS selector.", {
  query: z.string(),
}, async (a) => ({ content: [{ type: "text", text: String(await request("find", a)) }] }));

server.tool("click", "Click an element by ref or coordinates. Set button to 'right' for context menu, 'middle' to open link in new tab. Use modifiers like ['ctrl'] for Ctrl+click (open in new tab on links).", {
  ref: z.string().optional(),
  coordinate: coord.optional(),
  button: z.enum(["left", "right", "middle"]).optional(),
  modifiers: z.array(z.enum(["ctrl", "shift", "alt", "meta"])).optional(),
}, async (a) => ({ content: [{ type: "text", text: String(await request("click", a)) }] }));

server.tool("drag", "Drag from a source to a destination. Works for sortable lists (Trello, Notion), canvas apps (Figma, Miro), file-drop zones, and slider handles. Source and destination can each be given as ref OR coordinate.", {
  from_ref: z.string().optional(),
  from_coordinate: coord.optional(),
  to_ref: z.string().optional(),
  to_coordinate: coord.optional(),
}, async (a) => ({ content: [{ type: "text", text: String(await request("drag", a)) }] }));

server.tool("type_text", "Type text at the current keyboard focus.", {
  text: z.string(),
}, async (a) => ({ content: [{ type: "text", text: String(await request("type_text", a)) }] }));

server.tool("press_key", "Press a keyboard key/shortcut (e.g. Enter, Tab, Ctrl+A).", {
  key: z.string(),
}, async (a) => ({ content: [{ type: "text", text: String(await request("press_key", a)) }] }));

server.tool("form_input", "Set the value of a form field by ref.", {
  ref: z.string(),
  value: z.string(),
}, async (a) => ({ content: [{ type: "text", text: String(await request("form_input", a)) }] }));

server.tool("screenshot", "Capture a JPEG screenshot of the viewport. Set labels=true to overlay numbered badges on every visible interactive element and return a legend mapping each label to its ref + coordinates — use this when DOM refs are unreliable (canvas-heavy pages, dynamic SPAs) or when you want to see WHERE each element is on screen.", {
  labels: z.boolean().optional(),
  max_labels: z.number().int().min(5).max(60).optional(),
}, async (a) => {
  const r = await request("screenshot", a);
  if (r && typeof r === "object" && r.base64) {
    const text = r.text || "Screenshot captured.";
    return { content: [
      { type: "text", text },
      { type: "image", data: r.base64, mimeType: "image/jpeg" },
    ]};
  }
  return { content: [{ type: "text", text: String(r) }] };
});

server.tool("scroll", "Scroll the page up or down.", {
  direction: z.enum(["up", "down"]),
  amount: z.number().min(1).max(10).optional(),
}, async (a) => ({ content: [{ type: "text", text: String(await request("scroll", a)) }] }));

server.tool("run_javascript", "Execute JavaScript in the page context and return the result.", {
  code: z.string(),
}, async (a) => ({ content: [{ type: "text", text: String(await request("run_javascript", a)) }] }));

server.tool("wait_for", "Wait for text / selector / DOM stability (max 10s).", {
  text: z.string().optional(),
  selector: z.string().optional(),
  timeout: z.number().optional(),
}, async (a) => ({ content: [{ type: "text", text: String(await request("wait_for", a)) }] }));

server.tool("hover", "Hover over an element.", {
  ref: z.string().optional(),
  coordinate: coord.optional(),
}, async (a) => ({ content: [{ type: "text", text: String(await request("hover", a)) }] }));

server.tool("select_option", "Pick an option in a dropdown by ref.", {
  ref: z.string(),
  value: z.string().optional(),
}, async (a) => ({ content: [{ type: "text", text: String(await request("select_option", a)) }] }));

server.tool("list_tabs", "List all tabs in the focused window (IDs + titles + URLs only — no content).", {}, async () => ({
  content: [{ type: "text", text: String(await request("list_tabs", {})) }],
}));

server.tool("tabs_overview", "List all tabs PLUS a short content snippet from each — useful for cross-tab reasoning like 'compare these three articles' or 'find the tab that talks about X'. Extracts ~300 characters of Readability text per tab in parallel. Cheaper than calling get_page_text on each tab individually.", {
  max_tabs: z.number().int().min(1).max(15).optional(),
}, async (a) => ({ content: [{ type: "text", text: String(await request("tabs_overview", a)) }] }));

server.tool("switch_tab", "Switch to a tab by ID.", {
  tabId: z.number(),
}, async (a) => ({ content: [{ type: "text", text: String(await request("switch_tab", a)) }] }));

server.tool("tabs_close", "Close one or more tabs by ID. Omit tabIds to close the currently active tab. Refuses to close the tab a running task is still driving — wait for it to finish first. Closing the last tab in a window closes the window.", {
  tabIds: z.array(z.number()).optional(),
  tabId: z.number().optional(),
}, async (a) => ({ content: [{ type: "text", text: String(await request("tabs_close", a)) }] }));

server.tool("file_upload", "Upload local file(s) to an <input type=\"file\"> element. Identify the input by `ref` (preferred — from read_page/find) OR `selector` (CSS). `files` must be ABSOLUTE paths on the user's machine (e.g. 'C:/Users/.../photo.jpg'). Multiple files require the input to have the `multiple` attribute. Safety: paths that look like credentials/secrets (.ssh, .aws, .env, *_rsa, *.pem, password/wallet/keystore, browser Login Data, etc.) are REFUSED — this is an anti-exfiltration guard against malicious page instructions.", {
  ref: z.string().optional(),
  selector: z.string().optional(),
  files: z.array(z.string()).min(1),
}, async (a) => ({ content: [{ type: "text", text: String(await request("file_upload", a)) }] }));

// ──────────────────────────────────────────────────────────────────────────
// DevTools — read-only access to the browser's debug data
//
// All six tools surface state the extension is ALREADY collecting via
// chrome.debugger event listeners (consoleMessages, networkRequests,
// pageErrors maps live in extension/src/core/state.js). Buffers cap
// at 1000 (console), 200 (errors), 1000 (network) entries per tab and
// roll forward — older entries drop off as new ones arrive.
//
// `read_storage` is the one Pro-Mode-gated entry: localStorage on a
// logged-in tab routinely contains auth tokens, and we don't expose
// that read surface in default mode. The gate runs in the executor
// (it has access to chrome.storage); the tool definition here doesn't
// need to repeat the check.
// ──────────────────────────────────────────────────────────────────────────

server.tool("read_console_messages",
  "Read console.log / console.warn / console.error / console.info messages from the active tab. " +
  "Use this to debug page behaviour — what errors did JavaScript log? what warnings fired? " +
  "Filter by level when you only care about errors. " +
  "Note: messages are captured from the moment the extension first attached to the tab; earlier output is not retroactive.",
  {
    level: z.enum(["log", "warn", "error", "info", "debug"]).optional()
      .describe("Filter to one level only. Omit for all levels."),
    limit: z.number().int().min(1).max(500).optional()
      .describe("Most-recent N messages (default 100, max 500)."),
  },
  async (a) => ({ content: [{ type: "text", text: String(await request("read_console_messages", a)) }] }));

server.tool("read_network_requests",
  "Read HTTP requests captured for the active tab — URL, method, status code, resource type, timestamp. " +
  "Use to diagnose API failures, find authentication problems, see what XHR / fetch / image / script loads happened. " +
  "Captured from the moment the extension attached.",
  {
    url_contains: z.string().optional().describe("Substring filter on URL (case-sensitive)."),
    method: z.string().optional().describe("Filter by HTTP method (GET, POST, PUT, DELETE, ...). Case-insensitive."),
    status_min: z.number().int().min(0).max(999).optional().describe("Minimum status code (default 0)."),
    status_max: z.number().int().min(0).max(999).optional().describe("Maximum status code (default 999). Use 400/599 for errors only."),
    limit: z.number().int().min(1).max(200).optional().describe("Most-recent N (default 50)."),
  },
  async (a) => ({ content: [{ type: "text", text: String(await request("read_network_requests", a)) }] }));

server.tool("read_page_errors",
  "Read uncaught JavaScript exceptions thrown on the active tab. " +
  "Distinct from console.error (which is just a log call). These are real exceptions — TypeError, ReferenceError, network failures bubbling up to window.onerror. " +
  "Use when a page is broken and you want to know WHY.",
  {
    limit: z.number().int().min(1).max(100).optional().describe("Most-recent N errors (default 50)."),
  },
  async (a) => ({ content: [{ type: "text", text: String(await request("read_page_errors", a)) }] }));

server.tool("inspect_element",
  "Get full details of one DOM element: tag name, id, classes, attributes, computed style (curated subset), bounding rect, visibility. " +
  "Identify the element by `ref` (preferred — from read_page or find), CSS `selector`, or screen `coordinate` [x, y]. " +
  "Returns a JSON object — the keys are stable, so you can drill in without re-querying.",
  {
    ref: z.string().optional().describe("Element ref from read_page or find."),
    selector: z.string().optional().describe("CSS selector (alternative to ref)."),
    coordinate: z.array(z.number()).length(2).optional().describe("[x, y] in CSS pixels (alternative to ref/selector)."),
  },
  async (a) => ({ content: [{ type: "text", text: String(await request("inspect_element", a)) }] }));

server.tool("read_storage",
  "Read localStorage or sessionStorage entries for the active tab. " +
  "Returns all key-value pairs as a JSON object, OR a single value when `key` is supplied. " +
  "PRO MODE REQUIRED: storage commonly holds auth tokens; this read surface is gated to prevent silent harvesting in default mode.",
  {
    area: z.enum(["local", "session"]).describe("Which storage area to read."),
    key: z.string().optional().describe("Read just this one key. Omit to dump all entries."),
  },
  async (a) => ({ content: [{ type: "text", text: String(await request("read_storage", a)) }] }));

server.tool("read_performance",
  "Read the active tab's performance timing — TTFB, DOMContentLoaded, full-load, first paint, first-contentful paint, JS heap size. " +
  "Useful for diagnosing slow pages. Values are ms since navigationStart; null when not yet reached. " +
  "Memory metrics are Chromium-specific (other engines return null).",
  {},
  async (a) => ({ content: [{ type: "text", text: String(await request("read_performance", a)) }] }));

// ──────────────────────────────────────────────────────────────────────────
// Pro Mode — Filesystem (read-only, Layer 1 / Phase 2)
//
// All tools below gate on the user-set Pro Mode flag and confine paths
// to the configured working directory. Off by default. The tools are
// VISIBLE to Claude even when Pro Mode is off — Claude calls them, gets
// a clear "Pro Mode is off" error, and tells the user to enable it.
// That's better UX than hiding the tools (Claude wouldn't know they
// exist and would suggest CLI-based workarounds).
// ──────────────────────────────────────────────────────────────────────────

server.tool("read_file",
  "Read a text file from the user's working directory. Path may be absolute (must resolve inside working dir) or relative (resolved against working dir). Refuses files larger than 1 MB — for those, use `find_files` + targeted reads. Pro Mode required.",
  { path: z.string().min(1).describe("Path to the file, absolute or relative to working dir") },
  async (a) => {
    try {
      const { workingDirectory } = requireProMode();
      const safePath = validatePath(a.path, workingDirectory);
      const stat = fs.statSync(safePath);
      if (stat.isDirectory()) throw new Error("Path is a directory, not a file. Use list_directory.");
      // 1 MB cap — protects the chat from accidentally pasting a binary
      // and ensures the model can actually process the content. Larger
      // files should be searched/sliced via find_files + grep first.
      const MAX_BYTES = 1024 * 1024;
      if (stat.size > MAX_BYTES) {
        throw new Error(`File is ${(stat.size / 1024).toFixed(0)} KB — over the 1 MB read cap. Use targeted reads via find_files / grep.`);
      }
      const content = fs.readFileSync(safePath, "utf-8");
      return { content: [{ type: "text", text: content }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

server.tool("list_directory",
  "List entries in a directory (files + subdirs). Each entry shows name, type, size (files), and last-modified time. Path resolves against working dir. Pro Mode required.",
  { path: z.string().optional().describe("Directory path; defaults to working directory itself") },
  async (a) => {
    try {
      const { workingDirectory } = requireProMode();
      const safePath = validatePath(a.path || ".", workingDirectory);
      const stat = fs.statSync(safePath);
      if (!stat.isDirectory()) throw new Error("Path is a file, not a directory. Use read_file.");
      const entries = fs.readdirSync(safePath, { withFileTypes: true });
      const lines = entries.map((ent) => {
        const full = path.join(safePath, ent.name);
        try {
          const s = fs.statSync(full);
          const kind = ent.isDirectory() ? "DIR" : ent.isSymbolicLink() ? "LNK" : "FILE";
          const size = ent.isDirectory() ? "-" : `${s.size}`;
          const mtime = s.mtime.toISOString().slice(0, 19).replace("T", " ");
          return `${kind.padEnd(4)}  ${size.padStart(10)}  ${mtime}  ${ent.name}`;
        } catch { return `?     -          -                    ${ent.name}`; }
      });
      const header = `Directory: ${path.relative(workingDirectory, safePath) || "."}\n` +
        `Entries: ${entries.length}\n` +
        `─────────────────────────────────────────────────────────`;
      return { content: [{ type: "text", text: header + "\n" + lines.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

server.tool("find_files",
  "Find files in the working directory matching a glob-like pattern. Supports `*` and `?` and `**` for recursive. Returns up to 200 paths. Examples: `*.md`, `src/**/*.ts`, `**/test_*.py`. Pro Mode required.",
  {
    pattern: z.string().min(1).describe("Glob pattern (e.g. '**/*.ts', 'src/*.py', 'README*')"),
    root: z.string().optional().describe("Subdirectory to search; defaults to working directory"),
  },
  async (a) => {
    try {
      const { workingDirectory } = requireProMode();
      const safeRoot = validatePath(a.root || ".", workingDirectory);
      const stat = fs.statSync(safeRoot);
      if (!stat.isDirectory()) throw new Error("Root is not a directory.");

      // Hand-rolled glob: simple but covers the cases Claude actually
      // writes. We deliberately don't pull in `glob` or `minimatch` —
      // both have known prototype-pollution histories and the surface
      // we need is small.
      const pat = a.pattern;
      const recursive = pat.includes("**");
      // Convert glob to RegExp by escaping regex specials except *, ?, /
      // and translating: ** → .*, * → [^/]*, ? → [^/]
      const regex = new RegExp("^" + pat
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "<DOUBLESTAR>")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/<DOUBLESTAR>/g, ".*")
        + "$");
      const MAX_RESULTS = 200;
      const matches = [];
      // Skip directories that explode the search (node_modules, .git)
      // unless the pattern explicitly mentions them.
      const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__"]);
      const wantsSkipped = SKIP_DIRS.values && [...SKIP_DIRS].some((d) => pat.includes(d));

      function walk(dir) {
        if (matches.length >= MAX_RESULTS) return;
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
          if (matches.length >= MAX_RESULTS) return;
          const full = path.join(dir, ent.name);
          const rel = path.relative(safeRoot, full).replace(/\\/g, "/");
          if (ent.isDirectory()) {
            if (!wantsSkipped && SKIP_DIRS.has(ent.name)) continue;
            if (recursive) walk(full);
          } else if (ent.isFile()) {
            if (regex.test(rel) || regex.test(ent.name)) matches.push(rel);
          }
        }
      }
      walk(safeRoot);

      if (matches.length === 0) {
        return { content: [{ type: "text", text: `No files matched: ${pat}` }] };
      }
      const text = `${matches.length} match${matches.length === 1 ? "" : "es"}` +
        (matches.length === MAX_RESULTS ? " (capped at 200 — narrow the pattern for more)" : "") +
        ":\n" + matches.join("\n");
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

server.tool("get_working_directory",
  "Report the currently-configured Pro Mode working directory. Useful as a sanity-check before file operations. Returns the path even if Pro Mode is off (so the user can verify their setup before turning it on).",
  {},
  async () => {
    const settings = loadProModeSettings();
    const text = settings.workingDirectory
      ? `Working directory: ${settings.workingDirectory}\nPro Mode: ${settings.proMode ? "ON ✓" : "OFF — enable in extension settings"}`
      : "Working directory not configured. Open extension settings → Pro Mode → set the working directory.";
    return { content: [{ type: "text", text }] };
  });

// ──────────────────────────────────────────────────────────────────────────
// Pro Mode — Filesystem (write, Layer 1 / Phase 3)
// ──────────────────────────────────────────────────────────────────────────

server.tool("write_file",
  "Create or overwrite a text file in the working directory. Path resolves against working dir. Parent directories auto-created. Pro Mode required. NOTE: silently overwrites — use list_directory first if you need to check.",
  {
    path: z.string().min(1).describe("Path to file (absolute inside working dir, or relative)"),
    content: z.string().describe("File content (UTF-8 text)"),
  },
  async (a) => {
    try {
      const { workingDirectory } = requireProMode();
      const safePath = validatePath(a.path, workingDirectory);
      // Auto-create parent directory chain — convenient for Claude that
      // wants to write `data/exports/foo.json` in one shot.
      fs.mkdirSync(path.dirname(safePath), { recursive: true });
      // Atomic-ish: write to .tmp then rename. Protects against the
      // half-written-on-crash case the user would otherwise have to
      // diagnose with `cat`.
      const tmp = safePath + ".tmp";
      fs.writeFileSync(tmp, a.content, "utf-8");
      fs.renameSync(tmp, safePath);
      const size = Buffer.byteLength(a.content, "utf-8");
      return { content: [{ type: "text", text: `Wrote ${size} bytes to ${path.relative(workingDirectory, safePath)}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

server.tool("edit_file",
  "Find and replace a unique substring in a file. `old_string` MUST appear EXACTLY ONCE in the file — otherwise the call refuses to avoid ambiguous replacements. For broader rewrites, use write_file. Pro Mode required.",
  {
    path: z.string().min(1),
    old_string: z.string().min(1).describe("Exact substring to find. Must be unique in the file."),
    new_string: z.string().describe("Replacement text. May be empty to delete the substring."),
  },
  async (a) => {
    try {
      const { workingDirectory } = requireProMode();
      const safePath = validatePath(a.path, workingDirectory);
      const original = fs.readFileSync(safePath, "utf-8");
      // Count occurrences. `String.split(needle).length - 1` is the
      // standard non-regex count and avoids regex-escaping the user's
      // search string.
      const occurrences = original.split(a.old_string).length - 1;
      if (occurrences === 0) {
        throw new Error("old_string not found in file. Read the file first to check the exact text.");
      }
      if (occurrences > 1) {
        throw new Error(`old_string appears ${occurrences} times. Make it unique by including more context.`);
      }
      const updated = original.replace(a.old_string, a.new_string);
      const tmp = safePath + ".tmp";
      fs.writeFileSync(tmp, updated, "utf-8");
      fs.renameSync(tmp, safePath);
      return { content: [{ type: "text", text: `Edited ${path.relative(workingDirectory, safePath)} (1 replacement).` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

server.tool("delete_file",
  "Delete a single file from the working directory. Refuses directories — use list_directory first to be sure. Pro Mode required. CAUTION: irreversible.",
  { path: z.string().min(1) },
  async (a) => {
    try {
      const { workingDirectory } = requireProMode();
      const safePath = validatePath(a.path, workingDirectory);
      const stat = fs.statSync(safePath);
      if (stat.isDirectory()) throw new Error("Path is a directory. delete_file only removes files.");
      fs.unlinkSync(safePath);
      return { content: [{ type: "text", text: `Deleted ${path.relative(workingDirectory, safePath)}.` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

server.tool("create_directory",
  "Create a directory (and any missing parent directories) inside the working directory. No-op if it already exists. Pro Mode required.",
  { path: z.string().min(1) },
  async (a) => {
    try {
      const { workingDirectory } = requireProMode();
      const safePath = validatePath(a.path, workingDirectory);
      fs.mkdirSync(safePath, { recursive: true });
      return { content: [{ type: "text", text: `Created ${path.relative(workingDirectory, safePath)}.` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

// ──────────────────────────────────────────────────────────────────────────
// Pro Mode — Shell (Layer 1 / Phase 4)
//
// Three layers of defense before a user-supplied command actually runs:
//   1. Allowlist: a set of well-known dev tools (git, npm, python, ...)
//      auto-approve. Anything outside is rejected — Claude must ask the
//      user to switch the cmd to something on the list.
//   2. Denylist: explicit blocks for catastrophic verbs even if they
//      somehow shadow an allowlisted name (e.g. user aliases `python`
//      to `rm`). Belt-and-suspenders.
//   3. cwd locked to working directory unless explicitly inside it.
//
// shell:false is also key: args are passed as an array, so users CAN'T
// inject shell metacharacters via prompt injection. `git status; rm -rf`
// arrives as one literal arg "status; rm -rf" — git ignores it.
// ──────────────────────────────────────────────────────────────────────────

const COMMAND_ALLOWLIST = new Set([
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
  // Inspection of binaries / processes (read-only)
  "node", "type",
]);

// Hard refusal regardless of allowlist position. Substrings, not whole-token.
const COMMAND_DENY_SUBSTR = [
  "rm -rf", "rm -fr", "rmdir /s",   // recursive deletes
  "sudo", "doas", "su ",            // privilege escalation
  "chmod 777", "chown ",            // perm changes
  "format ", "mkfs",                 // filesystem destruction
  "dd if=", "> /dev/",               // disk overwrites
  ":(){",                            // fork bomb shorthand
  "curl http", "wget http",          // discourage random downloads (allow inside scripts via npm/python though)
];

server.tool("run_command",
  "Run a shell command from the allowlist (git, npm, python, node, pip, etc). " +
  "Args are passed as an array — shell metacharacters in args don't get interpreted. " +
  "Working directory defaults to the configured working dir. " +
  "Output is capped at 16 KB. " +
  "Pro Mode required.",
  {
    cmd: z.string().min(1).describe("Executable name from the allowlist (e.g. 'git', 'npm', 'python')"),
    args: z.array(z.string()).optional().describe("Arguments as separate strings (NOT one shell-string)"),
    cwd: z.string().optional().describe("Working subdirectory; defaults to the configured working dir"),
    timeout_ms: z.number().int().min(100).max(300_000).optional().describe("Timeout in ms (default 30000, max 300000)"),
  },
  async (a) => {
    try {
      const { workingDirectory } = requireProMode();
      // Normalise cmd — basename only (no path traversal in the cmd itself).
      const cmdName = path.basename(a.cmd).toLowerCase().replace(/\.(exe|cmd|bat|sh|ps1)$/i, "");
      if (!COMMAND_ALLOWLIST.has(cmdName)) {
        const allowed = [...COMMAND_ALLOWLIST].sort().join(", ");
        throw new Error(`Command "${a.cmd}" is not on the Pro Mode allowlist. Allowed: ${allowed}`);
      }
      // Reconstruct what the user/Claude would have invoked and check the
      // full string against the denylist. This catches cases where args
      // smuggle a destructive verb (e.g. `git`, args=['!','rm','-rf','.']).
      const fullCmd = (a.cmd + " " + (a.args || []).join(" ")).toLowerCase();
      for (const bad of COMMAND_DENY_SUBSTR) {
        if (fullCmd.includes(bad.toLowerCase())) {
          throw new Error(`Command rejected: contains banned substring "${bad}".`);
        }
      }
      const cwd = a.cwd ? validatePath(a.cwd, workingDirectory) : workingDirectory;
      const timeout = a.timeout_ms || 30_000;
      // shell: false is the security spine here. Passing args as an array
      // means user-controlled strings can't be re-parsed as commands.
      const child = spawn(a.cmd, a.args || [], {
        cwd,
        shell: false,
        windowsHide: true,
        timeout,
      });

      const MAX_OUTPUT = 16 * 1024;
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        if (stdout.length < MAX_OUTPUT) stdout += d.toString("utf-8");
      });
      child.stderr.on("data", (d) => {
        if (stderr.length < MAX_OUTPUT) stderr += d.toString("utf-8");
      });

      const exitCode = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve(code));
      });

      const truncate = (s) => {
        if (s.length <= MAX_OUTPUT) return s;
        return s.slice(0, MAX_OUTPUT) + `\n…(truncated at ${MAX_OUTPUT} bytes)`;
      };
      const text =
        `$ ${a.cmd} ${(a.args || []).join(" ")}\n` +
        `(cwd: ${path.relative(workingDirectory, cwd) || "."}, exit: ${exitCode})\n` +
        (stdout ? `\n--- stdout ---\n${truncate(stdout)}` : "") +
        (stderr ? `\n--- stderr ---\n${truncate(stderr)}` : "");
      return { content: [{ type: "text", text: text.trim() }], isError: exitCode !== 0 };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

// ──────────────────────────────────────────────────────────────────────────
// Pro Mode — Git (structured)
//
// Five wrappers that run git in the working directory and parse the
// output into JSON. Could be done via `run_command` + the model parsing
// raw text — these tools save round-trips and make filtering trivial.
// All read-only: write operations (commit, push, branch, merge) stay
// in run_command where the user can see and approve the exact arg
// list. The model can still propose them via run_command; these tools
// just remove ambiguity for the diagnostic 80% of git use.
// ──────────────────────────────────────────────────────────────────────────

// Shared helper: spawn git inside the working directory, collect
// stdout, return it as a string (or throw on non-zero exit). The
// run_command shell flags (allowlist, denylist) don't apply here —
// we control the binary + args directly, so there's no surface for
// shell injection from caller args.
function runGit(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const { workingDirectory } = requireProMode();
    const cwd = opts.cwd
      ? validatePath(opts.cwd, workingDirectory)
      : workingDirectory;
    const child = spawn("git", args, {
      cwd, shell: false, windowsHide: true, timeout: opts.timeout || 15_000,
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString("utf-8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf-8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `git exited with ${code}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

server.tool("git_status",
  "Get a structured view of `git status`. Returns the current branch, ahead/behind counts vs upstream, and three lists: staged, modified (unstaged changes to tracked files), untracked. " +
  "Pro Mode required. Working dir is the configured working directory.",
  {},
  async () => {
    try {
      const out = await runGit(["status", "--porcelain=v1", "-b"]);
      const lines = out.split("\n").filter(Boolean);
      let branch = ""; let ahead = 0; let behind = 0;
      const staged = []; const modified = []; const untracked = [];
      for (const line of lines) {
        if (line.startsWith("##")) {
          // "## main...origin/main [ahead 2, behind 1]"
          const m = line.match(/^##\s+([^\s.]+)(?:\.\.\.[^\s]+)?(?:\s+\[([^\]]+)\])?/);
          if (m) {
            branch = m[1];
            const tag = m[2] || "";
            const a = tag.match(/ahead (\d+)/);
            const b = tag.match(/behind (\d+)/);
            ahead = a ? parseInt(a[1], 10) : 0;
            behind = b ? parseInt(b[1], 10) : 0;
          }
          continue;
        }
        // XY <space> path  (X = staged status, Y = unstaged status)
        const X = line[0]; const Y = line[1]; const path = line.slice(3);
        if (X === "?" && Y === "?") { untracked.push(path); continue; }
        if (X !== " " && X !== "?") staged.push({ path, status: X });
        if (Y !== " " && Y !== "?") modified.push({ path, status: Y });
      }
      return { content: [{ type: "text", text: JSON.stringify({ branch, ahead, behind, staged, modified, untracked }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

server.tool("git_diff",
  "Get a unified diff. Without args, shows unstaged changes (everything `git diff` would show). " +
  "With `staged: true`, shows what's about to be committed. " +
  "With `path`, restricts to one file. " +
  "Output truncated at 32 KB to keep the model's context manageable.",
  {
    staged: z.boolean().optional().describe("Show staged-but-not-committed diff (default: unstaged)."),
    path: z.string().optional().describe("Restrict to one file (relative to working dir)."),
  },
  async (a) => {
    try {
      const args = ["diff"];
      if (a.staged) args.push("--cached");
      if (a.path) args.push("--", a.path);
      const out = await runGit(args);
      const MAX = 32 * 1024;
      const truncated = out.length > MAX;
      const text = truncated
        ? out.slice(0, MAX) + `\n\n…(truncated at ${MAX} bytes — narrow with \`path\`)`
        : (out || "(no changes)");
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

server.tool("git_log",
  "List recent commits. Returns an array of {sha, author, date, subject} objects. " +
  "Default: 20 entries, all branches reachable from HEAD. " +
  "Use `path` to restrict to commits touching one file.",
  {
    limit: z.number().int().min(1).max(200).optional().describe("Number of commits to return (default 20, max 200)."),
    path: z.string().optional().describe("Show only commits touching this file."),
    author: z.string().optional().describe("Filter by author (substring match on name or email)."),
  },
  async (a) => {
    try {
      const limit = a.limit || 20;
      // Use a sentinel separator unlikely to appear in real commit
      // messages so we can split safely. \x1f is Unit Separator.
      const args = [
        "log", `-n`, String(limit),
        "--pretty=format:%H\x1f%an\x1f%ae\x1f%aI\x1f%s",
      ];
      if (a.author) args.push(`--author=${a.author}`);
      if (a.path) args.push("--", a.path);
      const out = await runGit(args);
      const commits = out.split("\n").filter(Boolean).map((line) => {
        const [sha, author, email, date, subject] = line.split("\x1f");
        return { sha, author, email, date, subject };
      });
      return { content: [{ type: "text", text: JSON.stringify({ count: commits.length, commits }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

server.tool("git_blame",
  "Show line-by-line authorship for a file. Returns {path, lines: [{line, sha, author, date, content}]}. " +
  "Use `from`/`to` (1-indexed line numbers) to restrict to a range — full-file blame is large.",
  {
    path: z.string().min(1).describe("File to blame (relative to working dir)."),
    from: z.number().int().min(1).optional().describe("First line (1-indexed)."),
    to: z.number().int().min(1).optional().describe("Last line (1-indexed)."),
  },
  async (a) => {
    try {
      const args = ["blame", "--line-porcelain"];
      if (a.from && a.to) args.push("-L", `${a.from},${a.to}`);
      else if (a.from) args.push("-L", `${a.from},+200`);  // default a 200-line slice
      args.push("--", a.path);
      const out = await runGit(args);
      // line-porcelain is a multi-block format. Each chunk:
      //   <sha> <orig> <final> [count]
      //   author Foo Bar
      //   author-mail <foo@bar>
      //   author-time 1234567890
      //   author-tz +0300
      //   ...
      //   <TAB>actual content
      const lines = [];
      const blocks = out.split(/^(?=[0-9a-f]{40} )/m).filter(Boolean);
      for (const block of blocks) {
        const lns = block.split("\n");
        const head = lns[0].split(" ");
        const sha = head[0];
        const final = parseInt(head[2], 10);
        let author = ""; let date = ""; let content = "";
        for (const ln of lns) {
          if (ln.startsWith("author ")) author = ln.slice(7).trim();
          else if (ln.startsWith("author-time ")) date = new Date(parseInt(ln.slice(12), 10) * 1000).toISOString();
          else if (ln.startsWith("\t")) content = ln.slice(1);
        }
        lines.push({ line: final, sha: sha.slice(0, 7), author, date, content });
      }
      return { content: [{ type: "text", text: JSON.stringify({ path: a.path, lineCount: lines.length, lines }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

server.tool("git_branches",
  "List local branches with their upstream tracking and last commit. Returns {current, branches: [{name, upstream, lastCommit, isCurrent}]}. " +
  "Use this before checkout / merge / rebase decisions to see what's available.",
  {},
  async () => {
    try {
      // %(refname:short)\t%(upstream:short)\t%(objectname:short)\t%(subject)\t%(HEAD)
      const out = await runGit([
        "for-each-ref", "refs/heads/",
        "--format=%(refname:short)\x1f%(upstream:short)\x1f%(objectname:short)\x1f%(subject)\x1f%(HEAD)",
      ]);
      let current = "";
      const branches = out.split("\n").filter(Boolean).map((line) => {
        const [name, upstream, sha, subject, head] = line.split("\x1f");
        const isCurrent = head === "*";
        if (isCurrent) current = name;
        return { name, upstream: upstream || null, lastCommit: { sha, subject }, isCurrent };
      });
      return { content: [{ type: "text", text: JSON.stringify({ current, count: branches.length, branches }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

// ──────────────────────────────────────────────────────────────────────────
// Pro Mode — Documents (Layer 2 / Phase 5)
//
// PDF generation runs the user's already-installed Chrome in headless
// mode. Zero npm dependency for PDF — we leverage the browser they're
// using to run this very extension.
//
// JSON / CSV are trivial wrappers over write_file with proper formatting.
// We expose them as separate tools so Claude doesn't need to remember
// to JSON.stringify or CSV-escape.
// ──────────────────────────────────────────────────────────────────────────

server.tool("generate_pdf",
  "Generate a PDF from HTML content using the user's installed Chromium browser (headless). " +
  "Useful for archives, reports, formatted exports. " +
  "HTML supports full CSS — design RTL-friendly templates for Arabic content. " +
  "Output is saved to working directory. Pro Mode required.",
  {
    html: z.string().min(1).describe("Full HTML document. Include <html>, <head>, and CSS for proper layout."),
    output_path: z.string().min(1).describe("Where to save the PDF (relative to working dir, e.g. 'report.pdf')"),
    landscape: z.boolean().optional().describe("Landscape orientation (default false)"),
  },
  async (a) => {
    try {
      const { workingDirectory } = requireProMode();
      const safeOut = validatePath(a.output_path, workingDirectory);
      if (!safeOut.toLowerCase().endsWith(".pdf")) {
        throw new Error("output_path must end in .pdf");
      }
      const chrome = findChromeBin();
      if (!chrome) {
        throw new Error("Chromium browser not found. Install Chrome / Brave / Edge to enable PDF generation.");
      }
      // Write HTML to a tmp file. Chrome's --print-to-pdf reads file://
      // URLs without the JS sandbox restrictions of `data:` URIs.
      fs.mkdirSync(path.dirname(safeOut), { recursive: true });
      const tmpHtml = path.join(os.tmpdir(), `cc-pdf-${Date.now()}-${randomBytes(4).toString("hex")}.html`);
      fs.writeFileSync(tmpHtml, a.html, "utf-8");
      try {
        const args = [
          "--headless=new",
          "--disable-gpu",
          "--no-sandbox",
          "--no-margins",
          "--no-pdf-header-footer",
          "--virtual-time-budget=10000",  // give CSS/web fonts a moment to load
          `--print-to-pdf=${safeOut}`,
        ];
        if (a.landscape) args.push("--print-to-pdf-no-header", "--landscape");
        // Use file:// URL — relative paths in the HTML resolve against
        // the tmp dir, which matters for embedded <img src="...">.
        const fileUrl = "file://" + tmpHtml.replace(/\\/g, "/");
        args.push(fileUrl);

        await new Promise((resolve, reject) => {
          const proc = spawn(chrome, args, { windowsHide: true, timeout: 60_000 });
          let stderr = "";
          proc.stderr.on("data", (d) => { stderr += d.toString("utf-8"); });
          proc.on("error", reject);
          proc.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Chrome exited with ${code}. ${stderr.slice(-300)}`));
          });
        });
        if (!fs.existsSync(safeOut)) {
          throw new Error("Chrome reported success but no PDF was created. Check the HTML for fatal errors.");
        }
        const size = fs.statSync(safeOut).size;
        return {
          content: [{
            type: "text",
            text: `Generated PDF: ${path.relative(workingDirectory, safeOut)} (${(size / 1024).toFixed(1)} KB)`,
          }],
        };
      } finally {
        try { fs.unlinkSync(tmpHtml); } catch {}
      }
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

server.tool("save_json",
  "Save data as a pretty-printed JSON file in the working directory. Wrapper over write_file with JSON.stringify (indent 2). Pro Mode required.",
  {
    data: z.unknown().describe("Any JSON-serialisable value (object, array, string, etc)"),
    output_path: z.string().min(1).describe("File path ending in .json"),
  },
  async (a) => {
    try {
      const { workingDirectory } = requireProMode();
      const safeOut = validatePath(a.output_path, workingDirectory);
      const json = JSON.stringify(a.data, null, 2);
      fs.mkdirSync(path.dirname(safeOut), { recursive: true });
      const tmp = safeOut + ".tmp";
      fs.writeFileSync(tmp, json, "utf-8");
      fs.renameSync(tmp, safeOut);
      const lines = json.split("\n").length;
      return { content: [{ type: "text", text: `Wrote JSON: ${path.relative(workingDirectory, safeOut)} (${lines} lines, ${(json.length / 1024).toFixed(1)} KB)` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

server.tool("save_csv",
  "Save tabular data as a CSV file. Each row in `rows` is a record; the FIRST row is treated as headers. " +
  "Quotes and commas in cells are escaped per RFC 4180. " +
  "Output written with UTF-8 BOM so Excel auto-detects encoding for Arabic. " +
  "Pro Mode required.",
  {
    rows: z.array(z.array(z.string())).min(1).describe("Array of rows; rows[0] is the header row"),
    output_path: z.string().min(1).describe("File path ending in .csv"),
  },
  async (a) => {
    try {
      const { workingDirectory } = requireProMode();
      const safeOut = validatePath(a.output_path, workingDirectory);
      const escape = (cell) => {
        const s = String(cell == null ? "" : cell);
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      // CRLF + UTF-8 BOM so Excel reads Arabic correctly. RFC 4180.
      const csv = "﻿" + a.rows.map((row) => row.map(escape).join(",")).join("\r\n");
      fs.mkdirSync(path.dirname(safeOut), { recursive: true });
      const tmp = safeOut + ".tmp";
      fs.writeFileSync(tmp, csv, "utf-8");
      fs.renameSync(tmp, safeOut);
      return { content: [{ type: "text", text: `Wrote CSV: ${path.relative(workingDirectory, safeOut)} (${a.rows.length} rows)` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

// ──────────────────────────────────────────────────────────────────────────
// Start MCP stdio transport (Claude Code side)
// ──────────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

// Clean shutdown
function shutdown() {
  try { tcpServer.close(); } catch {}
  if (primarySocket && !primarySocket.destroyed) primarySocket.destroy();
  for (const s of nativeHostSockets) { try { s.destroy(); } catch {} }
  for (const s of siblingClients.values()) { try { s.destroy(); } catch {} }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGHUP", shutdown);
process.stdin.on("end", shutdown);
process.stdin.resume();
