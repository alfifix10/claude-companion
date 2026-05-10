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
// Pro Mode — Code search (4 tools)
//
// File-walker-based tools that work where shell `grep` falls short on
// Windows (the binary is often missing or behaves differently in Git
// Bash). Implemented in pure Node so behaviour is identical across
// platforms. All four respect the working directory sandbox + skip
// the same heavy dirs (node_modules, .git, dist, build, etc.).
// ──────────────────────────────────────────────────────────────────────────

// Shared file walker. Walks `root` recursively, calling `cb(absPath,
// relPath)` for each plain file. Stops when count reaches `max`.
// Returns the count actually visited so callers can detect the cap.
const CODE_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "__pycache__",
  ".venv", "venv", "coverage", ".cache", ".turbo", ".svelte-kit",
]);
const CODE_MAX_FILE_SIZE = 1024 * 1024; // skip files > 1 MB (binaries, lockfiles)

function walkCodeFiles(root, max, includeRegex, cb) {
  let visited = 0;
  function recurse(dir) {
    if (visited >= max) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (visited >= max) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (CODE_SKIP_DIRS.has(ent.name)) continue;
        recurse(full);
      } else if (ent.isFile()) {
        const rel = path.relative(root, full).replace(/\\/g, "/");
        if (includeRegex && !includeRegex.test(rel)) continue;
        // Skip oversized files (lockfiles, build artifacts, blobs)
        try { if (fs.statSync(full).size > CODE_MAX_FILE_SIZE) continue; } catch { continue; }
        cb(full, rel);
        visited++;
      }
    }
  }
  recurse(root);
  return visited;
}

// Convert a glob-ish include filter ("*.ts", "src/**/*.tsx") to RegExp.
// Same translation as find_files. Empty input → null (= match all).
function compileIncludePattern(pattern) {
  if (!pattern) return null;
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<DOUBLESTAR>")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/<DOUBLESTAR>/g, ".*");
  return new RegExp("^" + re + "$");
}

server.tool("grep_files",
  "Search file CONTENTS for a regex pattern. Returns lines that match, with file path, line number, and a snippet. " +
  "Faster than reading each file and grepping manually. " +
  "Skips node_modules, .git, dist, build, etc. by default. Pro Mode required.",
  {
    pattern: z.string().min(1).describe("Regex (JavaScript flavour). Wrap in (?i:…) for case-insensitive."),
    include: z.string().optional().describe("Glob filter on relative path (e.g. '**/*.ts', 'src/**/*.{js,ts}')."),
    root: z.string().optional().describe("Subdirectory to search. Defaults to working directory."),
    max_matches: z.number().int().min(1).max(500).optional().describe("Cap on total matches (default 100)."),
    context_lines: z.number().int().min(0).max(5).optional().describe("Lines of context above + below each match (default 0)."),
  },
  async (a) => {
    try {
      const { workingDirectory } = requireProMode();
      const safeRoot = a.root ? validatePath(a.root, workingDirectory) : workingDirectory;
      let regex;
      try { regex = new RegExp(a.pattern); }
      catch (e) { return { content: [{ type: "text", text: `Error: invalid regex — ${e.message}` }], isError: true }; }
      const includeRe = compileIncludePattern(a.include || "");
      const ctx = a.context_lines || 0;
      const max = a.max_matches || 100;
      const matches = [];
      let filesScanned = 0;

      walkCodeFiles(safeRoot, 5000, includeRe, (full, rel) => {
        if (matches.length >= max) return;
        filesScanned++;
        let content;
        try { content = fs.readFileSync(full, "utf-8"); } catch { return; }
        // Skip files that look binary — null bytes in the first 8 KB
        // are a reliable cheap signal.
        if (content.slice(0, 8192).indexOf(" ") >= 0) return;
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= max) return;
          if (regex.test(lines[i])) {
            const before = ctx ? lines.slice(Math.max(0, i - ctx), i) : [];
            const after = ctx ? lines.slice(i + 1, i + 1 + ctx) : [];
            matches.push({ path: rel, line: i + 1, text: lines[i], before, after });
          }
        }
      });

      if (matches.length === 0) {
        return { content: [{ type: "text", text: `No matches across ${filesScanned} file(s).` }] };
      }
      // Render: path:line:text — readable by humans, parseable by tools
      const out = matches.map((m) => {
        const head = `${m.path}:${m.line}: ${m.text}`;
        if (!ctx) return head;
        const beforeFmt = m.before.map((l, j) => `${m.path}:${m.line - m.before.length + j}- ${l}`).join("\n");
        const afterFmt = m.after.map((l, j) => `${m.path}:${m.line + 1 + j}- ${l}`).join("\n");
        return [beforeFmt, head, afterFmt].filter(Boolean).join("\n");
      }).join("\n\n");
      const cap = matches.length >= max ? ` (capped at ${max} — narrow the search)` : "";
      return { content: [{ type: "text", text: `${matches.length} match(es) in ${filesScanned} files${cap}:\n\n${out}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

server.tool("find_symbol",
  "Find where a symbol (function, class, interface, type, const, let, var) is DEFINED. " +
  "Regex-based — works for JavaScript, TypeScript, Python, Go. " +
  "Returns file path + line + the line itself, for each definition site found. " +
  "Pro Mode required.",
  {
    name: z.string().min(1).describe("Symbol name. Matched as a whole word."),
    kind: z.enum(["any", "function", "class", "interface", "type", "const"]).optional()
      .describe("Restrict by definition kind (default 'any')."),
    include: z.string().optional().describe("Glob filter on path. Defaults to common code extensions."),
  },
  async (a) => {
    try {
      const { workingDirectory } = requireProMode();
      const name = a.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const kind = a.kind || "any";

      // Definition patterns by kind. Each captures the "name" position
      // so we can confirm it matches `a.name`. We use \\b boundaries to
      // avoid substring false-matches.
      const patterns = [];
      if (kind === "any" || kind === "function") {
        patterns.push(new RegExp(`\\bfunction\\s+${name}\\b`));     // JS
        patterns.push(new RegExp(`\\bdef\\s+${name}\\b`));           // Python
        patterns.push(new RegExp(`\\bfunc\\s+(?:\\([^)]*\\)\\s+)?${name}\\b`)); // Go
        patterns.push(new RegExp(`\\b${name}\\s*[:=]\\s*(?:async\\s+)?(?:function|\\([^)]*\\)\\s*=>)`)); // const foo = ...
      }
      if (kind === "any" || kind === "class") {
        patterns.push(new RegExp(`\\bclass\\s+${name}\\b`));
      }
      if (kind === "any" || kind === "interface") {
        patterns.push(new RegExp(`\\binterface\\s+${name}\\b`));
      }
      if (kind === "any" || kind === "type") {
        patterns.push(new RegExp(`\\btype\\s+${name}\\b`));         // TS / Go
      }
      if (kind === "any" || kind === "const") {
        patterns.push(new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`));
      }

      const include = a.include || "**/*.{js,jsx,mjs,cjs,ts,tsx,py,go,rs,java,c,cc,cpp,h,hpp,cs,rb,php,swift}";
      // Single-extension glob doesn't expand "{a,b}" without help — split.
      const subs = include.match(/\{([^}]+)\}/);
      const includeList = subs
        ? subs[1].split(",").map((ext) => include.replace(/\{[^}]+\}/, ext.trim()))
        : [include];
      const includeRes = includeList.map(compileIncludePattern).filter(Boolean);

      const results = [];
      walkCodeFiles(workingDirectory, 3000, null, (full, rel) => {
        if (results.length >= 200) return;
        if (includeRes.length && !includeRes.some((re) => re.test(rel))) return;
        let content;
        try { content = fs.readFileSync(full, "utf-8"); } catch { return; }
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= 200) return;
          for (const p of patterns) {
            if (p.test(lines[i])) {
              results.push({ path: rel, line: i + 1, text: lines[i].trim() });
              break;
            }
          }
        }
      });
      if (results.length === 0) {
        return { content: [{ type: "text", text: `No definitions found for "${a.name}" (kind: ${kind}).` }] };
      }
      const out = results.map((r) => `${r.path}:${r.line}: ${r.text}`).join("\n");
      return { content: [{ type: "text", text: `${results.length} definition(s):\n${out}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

server.tool("find_references",
  "Find every place a symbol is USED across the codebase. Whole-word matching, no regex needed from caller. " +
  "Like grep_files but with sane defaults for symbol-search and a wider extension filter. Pro Mode required.",
  {
    name: z.string().min(1).describe("Symbol name to search for (whole-word)."),
    include: z.string().optional().describe("Glob filter on path. Defaults to common code extensions."),
    max: z.number().int().min(1).max(500).optional().describe("Cap on matches (default 200)."),
  },
  async (a) => {
    try {
      const { workingDirectory } = requireProMode();
      const escaped = a.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`\\b${escaped}\\b`);
      const include = a.include || "**/*.{js,jsx,mjs,cjs,ts,tsx,py,go,rs,java,c,cc,cpp,h,hpp,cs,rb,php,swift,html,css,scss}";
      const subs = include.match(/\{([^}]+)\}/);
      const includeList = subs
        ? subs[1].split(",").map((ext) => include.replace(/\{[^}]+\}/, ext.trim()))
        : [include];
      const includeRes = includeList.map(compileIncludePattern).filter(Boolean);
      const max = a.max || 200;

      const results = [];
      walkCodeFiles(workingDirectory, 5000, null, (full, rel) => {
        if (results.length >= max) return;
        if (includeRes.length && !includeRes.some((re) => re.test(rel))) return;
        let content;
        try { content = fs.readFileSync(full, "utf-8"); } catch { return; }
        if (content.slice(0, 8192).indexOf(" ") >= 0) return;
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= max) return;
          if (regex.test(lines[i])) {
            results.push({ path: rel, line: i + 1, text: lines[i].trim() });
          }
        }
      });
      if (results.length === 0) {
        return { content: [{ type: "text", text: `No references to "${a.name}".` }] };
      }
      // Group by file for readability.
      const byFile = new Map();
      for (const r of results) {
        if (!byFile.has(r.path)) byFile.set(r.path, []);
        byFile.get(r.path).push(r);
      }
      const sections = [];
      for (const [filePath, refs] of byFile) {
        sections.push(`${filePath} (${refs.length}):\n` + refs.map((r) => `  ${r.line}: ${r.text}`).join("\n"));
      }
      const cap = results.length >= max ? ` (capped at ${max})` : "";
      return { content: [{ type: "text", text: `${results.length} reference(s) in ${byFile.size} file(s)${cap}:\n\n${sections.join("\n\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

server.tool("code_outline",
  "Return a high-level outline of one source file: every function, class, interface, type, top-level const declaration, with its line number. " +
  "Useful before reading a long file — see the structure first, then read the parts that matter. Pro Mode required.",
  {
    path: z.string().min(1).describe("File to outline (relative to working dir)."),
  },
  async (a) => {
    try {
      const { workingDirectory } = requireProMode();
      const safePath = validatePath(a.path, workingDirectory);
      const content = fs.readFileSync(safePath, "utf-8");
      const lines = content.split("\n");
      // Outline patterns. Order matters: more specific first.
      const rules = [
        { kind: "class",     re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Z]\w*)/ },
        { kind: "interface", re: /^\s*(?:export\s+)?interface\s+([A-Z]\w*)/ },
        { kind: "type",      re: /^\s*(?:export\s+)?type\s+([A-Z]\w*)/ },
        { kind: "function",  re: /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s+(\w+)/ },
        { kind: "function",  re: /^\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)\s*=>|function)/ },
        { kind: "method",    re: /^\s+(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(\w+)\s*\([^)]*\)\s*\{/ },
        { kind: "def",       re: /^\s*def\s+(\w+)/ },        // Python
        { kind: "class",     re: /^\s*class\s+([A-Z]\w*)/ },  // Python class
        { kind: "func",      re: /^\s*func\s+(?:\([^)]*\)\s+)?(\w+)/ }, // Go
        { kind: "const",     re: /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=/ }, // SCREAMING_CONST top-level
      ];
      const symbols = [];
      for (let i = 0; i < lines.length; i++) {
        for (const { kind, re } of rules) {
          const m = lines[i].match(re);
          if (m) {
            symbols.push({ kind, name: m[1], line: i + 1 });
            break;  // one match per line
          }
        }
      }
      if (symbols.length === 0) {
        return { content: [{ type: "text", text: `No top-level symbols detected in ${a.path} (${lines.length} lines).` }] };
      }
      const text = symbols.map((s) => `${String(s.line).padStart(5)}  ${s.kind.padEnd(9)} ${s.name}`).join("\n");
      return { content: [{ type: "text", text: `${symbols.length} symbol(s) in ${a.path} (${lines.length} lines):\n\n${text}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

// ──────────────────────────────────────────────────────────────────────────
// Pro Mode — HTTP (2 tools)
//
// Direct outbound HTTP from the host (Node fetch). Useful for testing
// APIs without spinning up a tab. Pro Mode required because:
//   • exfiltration vector (could POST page content to an attacker host)
//   • internal-network probe (could hit 127.0.0.1 / 192.168.* services)
// We cap response body at 1 MB to keep the model's context manageable
// and the runtime memory bounded.
// ──────────────────────────────────────────────────────────────────────────

const HTTP_RESPONSE_CAP = 1024 * 1024; // 1 MB
const HTTP_DEFAULT_TIMEOUT = 30_000;

server.tool("http_fetch",
  "Make an HTTP request and return the response (status, headers, body). " +
  "Body can be a string (sent as-is) or an object (auto-JSON-stringified with content-type set). " +
  "Response body is capped at 1 MB. Pro Mode required.",
  {
    url: z.string().url().describe("Full URL (https://...). http:// is allowed but https is preferred."),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).optional().describe("Default GET."),
    headers: z.record(z.string(), z.string()).optional().describe("Object of header name → value. Common: Authorization, Content-Type, User-Agent."),
    body: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional()
      .describe("Request body. Object/array auto-JSON; string sent verbatim. Ignored for GET/HEAD."),
    timeout_ms: z.number().int().min(100).max(120_000).optional().describe("Default 30000."),
  },
  async (a) => {
    try {
      requireProMode();
      const method = a.method || "GET";
      /** @type {Record<string, string>} */
      const headers = { ...(a.headers || {}) };
      let bodyToSend;
      if (a.body !== undefined && method !== "GET" && method !== "HEAD") {
        if (typeof a.body === "string") {
          bodyToSend = a.body;
        } else {
          bodyToSend = JSON.stringify(a.body);
          // Set content-type only if caller didn't.
          const hasCT = Object.keys(headers).some((k) => k.toLowerCase() === "content-type");
          if (!hasCT) headers["Content-Type"] = "application/json";
        }
      }
      // AbortController so we honour the timeout cleanly.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), a.timeout_ms || HTTP_DEFAULT_TIMEOUT);
      let res;
      try {
        res = await fetch(a.url, { method, headers, body: bodyToSend, signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      // Read up to HTTP_RESPONSE_CAP bytes — slice if larger.
      const reader = res.body?.getReader?.();
      let bodyText = "";
      let truncated = false;
      if (reader) {
        const decoder = new TextDecoder();
        let total = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > HTTP_RESPONSE_CAP) {
            truncated = true;
            // Decode just up to the cap.
            const overshoot = total - HTTP_RESPONSE_CAP;
            bodyText += decoder.decode(value.slice(0, value.length - overshoot), { stream: false });
            try { reader.cancel(); } catch {}
            break;
          }
          bodyText += decoder.decode(value, { stream: true });
        }
        bodyText += decoder.decode();
      } else {
        bodyText = await res.text();
        if (bodyText.length > HTTP_RESPONSE_CAP) {
          truncated = true;
          bodyText = bodyText.slice(0, HTTP_RESPONSE_CAP);
        }
      }
      const headersObj = {};
      res.headers.forEach((v, k) => { headersObj[k] = v; });
      const out = {
        url: res.url,
        status: res.status,
        statusText: res.statusText,
        ok: res.ok,
        headers: headersObj,
        body: bodyText,
        truncated,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        isError: !res.ok,
      };
    } catch (e) {
      const msg = e?.name === "AbortError" ? "Request timed out." : (e?.message || String(e));
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  });

server.tool("http_get_json",
  "GET a URL that returns JSON, parse it, and return the parsed value. " +
  "Convenience wrapper over http_fetch — saves a JSON.parse step and gives clearer error messages on parse failure. Pro Mode required.",
  {
    url: z.string().url().describe("Full URL returning JSON."),
    headers: z.record(z.string(), z.string()).optional().describe("Optional headers (Authorization, Accept, ...)."),
    timeout_ms: z.number().int().min(100).max(120_000).optional(),
  },
  async (a) => {
    try {
      requireProMode();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), a.timeout_ms || HTTP_DEFAULT_TIMEOUT);
      let res;
      try {
        res = await fetch(a.url, {
          method: "GET",
          headers: { Accept: "application/json", ...(a.headers || {}) },
          signal: ctrl.signal,
        });
      } finally { clearTimeout(timer); }
      const text = await res.text();
      if (!res.ok) {
        return { content: [{ type: "text", text: `HTTP ${res.status} ${res.statusText}\n${text.slice(0, 1000)}` }], isError: true };
      }
      let parsed;
      try { parsed = JSON.parse(text); }
      catch (e) {
        return { content: [{ type: "text", text: `Response is not JSON: ${e.message}\nFirst 500 chars: ${text.slice(0, 500)}` }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }] };
    } catch (e) {
      const msg = e?.name === "AbortError" ? "Request timed out." : (e?.message || String(e));
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  });

// ──────────────────────────────────────────────────────────────────────────
// Pro Mode — Code Quality (3 tools)
//
// Smart wrappers over the appropriate tool for the file's language:
//   • lint:        biome → eslint → ruff
//   • format:      biome → prettier → ruff format → black
//   • type-check:  tsc (project-level) → mypy (file-level)
// All three try the FIRST tool that's available for the language, in
// the order most projects use today. Output is the tool's own stderr/
// stdout — the model is good at reading lint output. Pro Mode required
// (these spawn binaries inside the working directory).
// ──────────────────────────────────────────────────────────────────────────

// Spawn a binary and resolve with {stdout, stderr, exitCode}. Single
// helper so the three tools below stay terse. No retry logic — the
// model can choose to fix and re-run.
function runTool(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const { workingDirectory } = requireProMode();
    const cwd = opts.cwd
      ? validatePath(opts.cwd, workingDirectory)
      : workingDirectory;
    let child;
    try {
      child = spawn(cmd, args, {
        cwd, shell: false, windowsHide: true, timeout: opts.timeout || 60_000,
      });
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = ""; let stderr = "";
    const MAX = 32 * 1024;
    child.stdout.on("data", (d) => { if (stdout.length < MAX) stdout += d.toString("utf-8"); });
    child.stderr.on("data", (d) => { if (stderr.length < MAX) stderr += d.toString("utf-8"); });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code }));
  });
}

// Detect language from extension. Returns one of:
// 'js' | 'ts' | 'py' | 'rs' | 'go' | 'unknown'
function detectLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if ([".ts", ".tsx", ".mts", ".cts"].includes(ext)) return "ts";
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "js";
  if (ext === ".py") return "py";
  if (ext === ".rs") return "rs";
  if (ext === ".go") return "go";
  return "unknown";
}

// Try a list of [cmd, args] pairs in order; first one whose process
// starts (no ENOENT) wins. Returns the result of that one. Used so
// e.g. lint can prefer biome → eslint without each tool defining
// its own fallback ladder.
async function tryTools(candidates) {
  for (const [cmd, args] of candidates) {
    try {
      const r = await runTool(cmd, args);
      return { cmd, ...r };
    } catch (e) {
      // ENOENT: tool not installed → try next
      // Other errors: also fall through (e.g. bad shim) — last
      // candidate's error surfaces below.
      if (candidates.indexOf([cmd, args]) === candidates.length - 1) throw e;
    }
  }
  throw new Error("No suitable tool found.");
}

server.tool("lint_file",
  "Lint one source file. Picks the right tool for the language: " +
  "biome → eslint for JS/TS, ruff → pylint for Python. " +
  "Returns the linter's own output (warnings + errors with line numbers). " +
  "Pro Mode required.",
  {
    path: z.string().min(1).describe("Path to the file (relative to working dir)."),
  },
  async (a) => {
    try {
      const { workingDirectory } = requireProMode();
      const safePath = validatePath(a.path, workingDirectory);
      const lang = detectLanguage(safePath);
      const rel = path.relative(workingDirectory, safePath);
      let candidates;
      if (lang === "js" || lang === "ts") {
        candidates = [
          ["biome", ["check", rel]],
          ["eslint", [rel]],
        ];
      } else if (lang === "py") {
        candidates = [
          ["ruff", ["check", rel]],
          ["pylint", [rel]],
        ];
      } else if (lang === "go") {
        candidates = [["go", ["vet", rel]]];
      } else if (lang === "rs") {
        candidates = [["cargo", ["clippy", "--", rel]]];
      } else {
        return { content: [{ type: "text", text: `No linter configured for extension "${path.extname(safePath)}".` }], isError: true };
      }
      const r = await tryTools(candidates);
      const summary = `$ ${r.cmd} (exit ${r.exitCode})`;
      const body = (r.stdout + r.stderr).trim() || "(no output — file is clean)";
      return {
        content: [{ type: "text", text: `${summary}\n\n${body}` }],
        isError: r.exitCode !== 0,
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

server.tool("format_file",
  "Format one source file. By default prints the proposed formatting (no write). " +
  "Set `write: true` to overwrite the file in place. " +
  "Picks the right tool: biome → prettier for JS/TS, ruff format → black for Python, gofmt for Go, rustfmt for Rust. " +
  "Pro Mode required.",
  {
    path: z.string().min(1).describe("Path to the file (relative to working dir)."),
    write: z.boolean().optional().describe("Apply changes in-place (default false: report diff only)."),
  },
  async (a) => {
    try {
      const { workingDirectory } = requireProMode();
      const safePath = validatePath(a.path, workingDirectory);
      const lang = detectLanguage(safePath);
      const rel = path.relative(workingDirectory, safePath);
      const write = a.write === true;
      let candidates;
      if (lang === "js" || lang === "ts") {
        candidates = [
          ["biome", write ? ["format", "--write", rel] : ["format", rel]],
          ["prettier", write ? ["--write", rel] : ["--check", rel]],
        ];
      } else if (lang === "py") {
        candidates = [
          ["ruff", write ? ["format", rel] : ["format", "--diff", rel]],
          ["black", write ? [rel] : ["--diff", rel]],
        ];
      } else if (lang === "go") {
        candidates = write
          ? [["gofmt", ["-w", rel]]]
          : [["gofmt", ["-d", rel]]];
      } else if (lang === "rs") {
        candidates = write
          ? [["rustfmt", [rel]]]
          : [["rustfmt", ["--check", rel]]];
      } else {
        return { content: [{ type: "text", text: `No formatter configured for extension "${path.extname(safePath)}".` }], isError: true };
      }
      const r = await tryTools(candidates);
      const action = write ? "formatted in place" : "diff-only (no write)";
      const summary = `$ ${r.cmd} — ${action} (exit ${r.exitCode})`;
      const body = (r.stdout + r.stderr).trim() || (write ? "(file written)" : "(no changes needed)");
      return {
        content: [{ type: "text", text: `${summary}\n\n${body}` }],
        isError: !write && r.exitCode !== 0,  // diff mode reports non-zero when changes needed; that's not an error
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

server.tool("type_check",
  "Run the type checker. For TypeScript projects: tsc --noEmit (whole project — TS doesn't really do per-file). " +
  "For Python: mypy on the given path (or whole working dir if path omitted). " +
  "Pro Mode required.",
  {
    path: z.string().optional().describe("Optional file/dir to focus on. Omit for project-wide."),
    language: z.enum(["ts", "py", "auto"]).optional().describe("Force language. Default 'auto' (detects from path or project files)."),
  },
  async (a) => {
    try {
      const { workingDirectory } = requireProMode();
      let lang = a.language || "auto";
      if (lang === "auto") {
        if (a.path) {
          const det = detectLanguage(a.path);
          if (det === "ts" || det === "py") lang = det;
        }
        if (lang === "auto") {
          // Look at the project for a tsconfig or pyproject
          if (fs.existsSync(path.join(workingDirectory, "tsconfig.json"))) lang = "ts";
          else if (fs.existsSync(path.join(workingDirectory, "pyproject.toml"))) lang = "py";
          else if (fs.existsSync(path.join(workingDirectory, "mypy.ini"))) lang = "py";
        }
      }
      let candidates;
      if (lang === "ts") {
        candidates = [["tsc", ["--noEmit"]]];
      } else if (lang === "py") {
        const target = a.path || ".";
        const safeTarget = validatePath(target, workingDirectory);
        const rel = path.relative(workingDirectory, safeTarget);
        candidates = [
          ["mypy", [rel || "."]],
          ["pyright", [rel || "."]],
        ];
      } else {
        return { content: [{ type: "text", text: "Could not detect language. Pass `language: 'ts' | 'py'` explicitly, or run from a project with tsconfig.json or pyproject.toml." }], isError: true };
      }
      const r = await tryTools(candidates);
      const summary = `$ ${r.cmd} (exit ${r.exitCode})`;
      const body = (r.stdout + r.stderr).trim() || "(no output — clean)";
      return {
        content: [{ type: "text", text: `${summary}\n\n${body}` }],
        isError: r.exitCode !== 0,
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

// ──────────────────────────────────────────────────────────────────────────
// Pro Mode — SQLite (2 tools)
//
// Read-only access to local SQLite database files. Uses the sqlite3
// CLI binary (must be in PATH — pre-installed on macOS, available via
// brew/apt/scoop on other platforms). Zero npm deps, zero native
// compilation.
//
// Safety:
//   • Always launches sqlite3 with `-readonly` so even a malicious SQL
//     blob can't write/drop/delete.
//   • Path is sandboxed to working directory.
//   • Output uses sqlite3's JSON mode for structured parsing.
// ──────────────────────────────────────────────────────────────────────────

// Run sqlite3 CLI in read-only mode with JSON output.
function runSqlite(dbPath, sql) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("sqlite3", ["-readonly", "-json", dbPath, sql], {
        shell: false, windowsHide: true, timeout: 15_000,
      });
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = ""; let stderr = "";
    const MAX = 256 * 1024;
    child.stdout.on("data", (d) => { if (stdout.length < MAX) stdout += d.toString("utf-8"); });
    child.stderr.on("data", (d) => { if (stderr.length < MAX) stderr += d.toString("utf-8"); });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || `sqlite3 exited with ${code}`));
      else resolve(stdout);
    });
  });
}

server.tool("sqlite_query",
  "Run a read-only SQL query against a local SQLite database (.db / .sqlite / .sqlite3 file). " +
  "Connection is opened with -readonly so write/drop/delete attempts fail at the engine level — " +
  "safe even if the SQL string was generated by Claude. " +
  "Returns the rows as JSON. Path is sandboxed to working directory. " +
  "Requires sqlite3 CLI in PATH (pre-installed on macOS, install via brew/apt/scoop elsewhere). Pro Mode required.",
  {
    path: z.string().min(1).describe("Path to the .db file (relative to working dir)."),
    sql: z.string().min(1).describe("SQL query. Read-only enforcement is at the connection level — write attempts fail with a clear error."),
  },
  async (a) => {
    try {
      const { workingDirectory } = requireProMode();
      const safePath = validatePath(a.path, workingDirectory);
      if (!fs.existsSync(safePath)) {
        return { content: [{ type: "text", text: `Error: file not found: ${a.path}` }], isError: true };
      }
      const out = await runSqlite(safePath, a.sql);
      // sqlite3 prints "[]" for empty result, raw rows otherwise. Validate.
      let parsed;
      try { parsed = out.trim() ? JSON.parse(out) : []; }
      catch {
        return { content: [{ type: "text", text: `sqlite3 output (not JSON):\n${out.slice(0, 4000)}` }] };
      }
      const rowCount = Array.isArray(parsed) ? parsed.length : 0;
      return { content: [{ type: "text", text: `${rowCount} row(s):\n${JSON.stringify(parsed, null, 2)}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

server.tool("sqlite_schema",
  "List the schema of a local SQLite database — every table with its columns and the CREATE statement. " +
  "Use this to understand the structure before writing queries with sqlite_query. " +
  "Pro Mode required.",
  {
    path: z.string().min(1).describe("Path to the .db file (relative to working dir)."),
  },
  async (a) => {
    try {
      const { workingDirectory } = requireProMode();
      const safePath = validatePath(a.path, workingDirectory);
      if (!fs.existsSync(safePath)) {
        return { content: [{ type: "text", text: `Error: file not found: ${a.path}` }], isError: true };
      }
      // sqlite_master holds the CREATE statements. PRAGMA table_info()
      // gives column details per table — but we'd need a query per
      // table (loop in JS or run multiple sqlite3 calls). For a single
      // round-trip, just use sqlite_master and parse the CREATE.
      const tablesJson = await runSqlite(safePath,
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
      let tables;
      try { tables = JSON.parse(tablesJson || "[]"); }
      catch { return { content: [{ type: "text", text: `sqlite3 output (not JSON):\n${tablesJson}` }] }; }
      // For each table, run PRAGMA table_info to get typed columns.
      // 1 round-trip per table — fine for typical DBs (< 50 tables).
      const result = [];
      for (const t of tables) {
        try {
          const colsJson = await runSqlite(safePath, `PRAGMA table_info(${JSON.stringify(t.name)})`);
          const cols = JSON.parse(colsJson || "[]");
          result.push({
            table: t.name,
            columns: cols.map((c) => ({ name: c.name, type: c.type, notNull: !!c.notnull, primaryKey: !!c.pk })),
            createSql: t.sql,
          });
        } catch {
          result.push({ table: t.name, columns: [], createSql: t.sql });
        }
      }
      return { content: [{ type: "text", text: `${result.length} table(s):\n${JSON.stringify(result, null, 2)}` }] };
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
