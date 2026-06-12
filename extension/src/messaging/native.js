/**
 * Native messaging — the pipe to our Node.js host process.
 *
 * Reliability design:
 *   • ping/pong health check catches stale ports before we waste time
 *   • progressive back-off on "host not found" (registration not done yet)
 *   • exponential reconnect on flaky errors (host crashed)
 *   • handlers keyed by id so streaming Max queries work in parallel
 *
 * Protocol (wire format: Chrome native-messaging, 4-byte LE length prefix):
 *   → { type: "ping" }                     → { type: "pong" }
 *   → { type: "diag" }                     → { type: "diag_result", checks }
 *   → { type: "max_query", id, prompt }    → streaming { type: "max_*", id }
 *   → { type: "tool_request", id, tool }   → forwarded to mcp-server via TCP
 *   ← { type: "ready" } (on host startup)
 *   ← { type: "tool_request", id, tool }   (from mcp-server ← Claude Code)
 */

import { nativePort, setNativePort } from "../core/state.js";
import { nativeToolHandlers } from "../tools/native-tool-handlers.js";
import { scheduleDetachAll } from "../core/cdp.js";
import { requestConfirm } from "./confirm.js";

const HOST_NAME = "com.anthropic.claude_companion";

// Back-off state (module-level — resets when SW restarts)
let nativeHostAvailable = true;
let consecutiveNotFound = 0;
let nextAllowedConnectAt = 0;

// Was the most recent `ready` banner received? Used to skip ping overhead.
let hostIsReady = false;
let lastMessageAt = 0;

// id → handler for streaming responses (max_event / max_text / diag_result)
const responseHandlers = new Map();
const pendingPings = new Map();

// ──────────────────────────────────────────────────────────────────────────
// Tool request handling (from Claude Code → MCP server → native host → us)
// ──────────────────────────────────────────────────────────────────────────

function sendResponse(id, result) {
  if (!nativePort) return;
  try { nativePort.postMessage({ id, type: "tool_response", result }); } catch {}
}
function sendToolError(id, error) {
  if (!nativePort) return;
  try { nativePort.postMessage({ id, type: "tool_error", error: String(error) }); } catch {}
}

async function handleToolRequest(id, tool, args) {
  // Confirmation gate (1.3): not a browser tool — the mcp-server asks the user
  // to approve a destructive Pro-Mode action. Show the panel a prompt and reply
  // with "approved"/"denied". Never throws; a refusal is a normal response.
  if (tool === "__confirm__") {
    let approved = false;
    try { approved = await requestConfirm(args?.summary || "", args?.tool || ""); } catch {}
    sendResponse(id, approved ? "approved" : "denied");
    return;
  }
  const handler = nativeToolHandlers[tool];
  if (!handler) { sendToolError(id, `Unknown tool: ${tool}`); return; }
  try {
    const result = await handler(args);
    sendResponse(id, result);
  } catch (err) {
    sendToolError(id, `${tool} failed: ${err?.message || err}`);
  } finally {
    // After every claude-companion tool completes, schedule a detach of
    // the debugger. ensureAttached cancels the schedule when the next
    // tool call arrives, so back-to-back calls won't flicker the banner.
    // This is what actually removes Chromium's debug banner during
    // multi-MCP tasks (where finishTask may not fire for minutes).
    scheduleDetachAll();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Connection lifecycle
// ──────────────────────────────────────────────────────────────────────────

export function connectNativeHost() {
  if (nativePort) return;
  if (Date.now() < nextAllowedConnectAt) return;
  if (!nativeHostAvailable) return;

  console.log("[native] connecting...");
  let port;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (err) {
    console.error("[native] connectNative threw:", err);
    setNativePort(null);
    consecutiveNotFound++;
    nextAllowedConnectAt = Date.now() + 5_000;
    return;
  }
  setNativePort(port);

  port.onMessage.addListener((msg) => {
    consecutiveNotFound = 0;
    lastMessageAt = Date.now();

    if (msg.type === "ready") {
      hostIsReady = true;
      console.log("[native] host ready, claude at:", msg.claudeBin);
      return;
    }
    if (msg.type === "pong") {
      const r = pendingPings.get(msg.id);
      if (r) { pendingPings.delete(msg.id); r(true); }
      return;
    }
    if (msg.type === "tool_request" && msg.id) {
      handleToolRequest(msg.id, msg.tool, msg.args || {});
      return;
    }
    if (msg.type === "max_event" || msg.type === "max_text" ||
        msg.type === "max_done" || msg.type === "max_error" ||
        msg.type === "diag_result" || msg.type === "folder_picked") {
      const h = responseHandlers.get(msg.id);
      if (h) h(msg);
      if (msg.type === "max_done" || msg.type === "max_error") {
        responseHandlers.delete(msg.id);
      }
    }
    // Temporary diagnostic channel for the image-handling bug. The
    // native host uses this to tell us "I filtered out N images and
    // here's why" — otherwise that failure is silent. Remove with
    // the other [native-host] / [panel->bg] logs once closed.
    if (msg.type === "max_debug" && msg.line) {
      console.log("[host->native]", msg.line);
    }
  });

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    const errMsg = err?.message || "";
    // Log level by severity:
    //   • "Native host has exited" / empty  → console.log. Normal
    //     lifecycle (browser shutdown, extension reload, post-
    //     shutdown() cleanup). Used to hit console.error and
    //     surfaced as scary red rows in Chrome's Errors panel.
    //   • "not found" / "not reachable"     → console.error. Real
    //     install problem; developers need to see it.
    if (/not found|not reachable/i.test(errMsg)) {
      console.error("[native] port disconnected:", errMsg);
    } else {
      console.log("[native] port disconnected:", errMsg || "(clean exit)");
    }
    setNativePort(null);
    hostIsReady = false;
    for (const [, r] of pendingPings) r(false);
    pendingPings.clear();

    if (errMsg.includes("not found") || errMsg.includes("not reachable")) {
      // Host isn't registered or the .bat wrapper path is wrong.
      consecutiveNotFound++;
      const backoff = Math.min(30_000, 2_000 * consecutiveNotFound);
      nextAllowedConnectAt = Date.now() + backoff;
      if (consecutiveNotFound >= 20) {
        nativeHostAvailable = false; // after ~10 min, stop hammering
      }
      return;
    }
    // Generic disconnect — try again soon
    consecutiveNotFound = 0;
    setTimeout(connectNativeHost, 5000);
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Health check
// ──────────────────────────────────────────────────────────────────────────

function pingHost(timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (!nativePort) return resolve(false);
    const id = `ping_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    pendingPings.set(id, resolve);
    try { nativePort.postMessage({ type: "ping", id }); }
    catch { pendingPings.delete(id); return resolve(false); }
    setTimeout(() => {
      if (pendingPings.has(id)) { pendingPings.delete(id); resolve(false); }
    }, timeoutMs);
  });
}

function forceReconnect() {
  if (nativePort) {
    try { nativePort.disconnect(); } catch {}
    setNativePort(null);
    hostIsReady = false;
  }
  consecutiveNotFound = 0;
  nextAllowedConnectAt = 0;
  nativeHostAvailable = true;
  connectNativeHost();
}

/**
 * Guarantees that by the time this resolves `true`, sending a message to the
 * native port actually reaches a live host. Used before important ops.
 */
export async function ensureHealthyPort(totalTimeoutMs = 5000) {
  const deadline = Date.now() + totalTimeoutMs;

  if (!nativePort) {
    forceReconnect();
  }
  // Wait for the port to come up (ready banner arrives)
  while (Date.now() < deadline && !(nativePort && hostIsReady)) {
    await new Promise((r) => setTimeout(r, 100));
  }

  // If the port is up and we've seen a ready banner, trust it without pinging.
  // Pings can race when the host is mid-stream (e.g. serving a Max query), so
  // optimistic success here prevents false "disconnected" reports.
  if (nativePort && hostIsReady) return true;
  if (!nativePort) return false;

  // Fallback: ping once
  const ok = await pingHost(Math.min(1500, deadline - Date.now()));
  if (ok) return true;

  // Port exists but no pong — try a clean reconnect
  forceReconnect();
  while (Date.now() < deadline && !(nativePort && hostIsReady)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return !!(nativePort && hostIsReady);
}

// ──────────────────────────────────────────────────────────────────────────
// Public API for providers
// ──────────────────────────────────────────────────────────────────────────

export function registerResponseHandler(id, handler) {
  responseHandlers.set(id, handler);
}
export function unregisterResponseHandler(id) {
  responseHandlers.delete(id);
}

export function sendMaxQuery(id, prompt, opts = {}) {
  if (!nativePort) return false;
  try {
    const images = opts.images || [];
    nativePort.postMessage({
      type: "max_query",
      id,
      prompt,
      model: opts.model,
      allowedTools: opts.allowedTools,
      images,
      system: opts.system || "",
      // pureMode=true → native host disables ALL tools and skips the
      // browser-agent system prompt. Used for image Q&A where the agent
      // loop's machinery (tool definitions, browser context, anti-stuck
      // guards) actively poisons a simple "what's in this image?" turn.
      pureMode: opts.pureMode === true,
    });
    return true;
  } catch (err) {
    console.error("[native] sendMaxQuery failed:", err);
    return false;
  }
}

export function cancelMaxQuery(id) {
  responseHandlers.delete(id);
  if (!nativePort) return;
  try { nativePort.postMessage({ type: "max_cancel", id }); } catch {}
}

// Hard kill: nuke every active claude process the host is tracking AND
// drop every pending response handler. We don't trust that max_cancel alone
// caught everything — killing the process tree and clearing handlers ensures
// no more events arrive for the stopped task.
export function cancelAllHost() {
  // Drop all pending handlers so late "done"/"text" events go nowhere.
  responseHandlers.clear();
  if (!nativePort) return;
  try { nativePort.postMessage({ type: "cancel_all" }); } catch {}
}

/**
 * Open a native OS folder-picker dialog via the host and resolve with
 * `{ path }` (null path = user cancelled) or `{ error }`. The timeout is
 * deliberately LONG — the dialog legitimately stays open while the user
 * browses; it only guards against an old host that doesn't know the
 * message type and would never reply.
 */
export function requestPickFolder(timeoutMs = 300_000) {
  return new Promise(async (resolve) => {
    const healthy = await ensureHealthyPort(2000);
    if (!healthy) return resolve({ error: "NO_NATIVE_HOST" });
    const id = `pick_${Date.now()}`;
    responseHandlers.set(id, (msg) => {
      if (msg.type === "folder_picked") {
        responseHandlers.delete(id);
        resolve(msg.error ? { error: msg.error } : { path: msg.path || null });
      }
    });
    try { nativePort.postMessage({ type: "pick_folder", id }); }
    catch { responseHandlers.delete(id); return resolve({ error: "POST_FAILED" }); }
    setTimeout(() => {
      if (responseHandlers.has(id)) {
        responseHandlers.delete(id);
        resolve({ error: "TIMEOUT" });
      }
    }, timeoutMs);
  });
}

/** Ask the host for a diagnostic snapshot (node version, claude path, etc.). */
export function requestDiag(timeoutMs = 3000) {
  return new Promise(async (resolve) => {
    const healthy = await ensureHealthyPort(2000);
    if (!healthy) return resolve({ error: "NO_NATIVE_HOST" });
    const id = `diag_${Date.now()}`;
    responseHandlers.set(id, (msg) => {
      if (msg.type === "diag_result") {
        responseHandlers.delete(id);
        resolve(msg.checks);
      }
    });
    try { nativePort.postMessage({ type: "diag", id }); }
    catch { responseHandlers.delete(id); return resolve({ error: "POST_FAILED" }); }
    setTimeout(() => {
      if (responseHandlers.has(id)) {
        responseHandlers.delete(id);
        resolve({ error: "TIMEOUT" });
      }
    }, timeoutMs);
  });
}
