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
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// ──────────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────────

const DEFAULT_PORT = 18799;
const CONFIG_DIR = path.join(os.homedir(), ".config", "claude-companion");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

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
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
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
        socket._sessionId = first.sessionId;
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

tcpServer.on("error", async (err) => {
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

server.tool("screenshot", "Capture a JPEG screenshot of the viewport.", {}, async () => {
  const r = await request("screenshot", {});
  if (r && typeof r === "object" && r.base64) {
    return { content: [
      { type: "text", text: "Screenshot captured." },
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
