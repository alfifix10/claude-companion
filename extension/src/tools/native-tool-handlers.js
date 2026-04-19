/**
 * Tool handlers invoked when the MCP server (Claude Code) asks the
 * extension to perform a browser action. Routes to the single executor.
 *
 * Tab-locking: if a task is in flight (activeTask.tabId set), we target THAT
 * tab regardless of what the user is currently looking at. Prevents an
 * "open a new window" from derailing an automated workflow.
 *
 * Post-stop quiet period: after a cancel, we refuse all tool requests for a
 * short window so in-flight calls from the dying claude process don't keep
 * clicking/navigating after the user said "stop".
 */

import { executeTool } from "./executor.js";
import { activeTask } from "../core/state.js";
import { getAllToolNames } from "../lib/tool-registry.js";

let rejectUntil = 0;
export function rejectToolsFor(ms = 3000) {
  rejectUntil = Date.now() + ms;
}
// Call this when a NEW task deliberately starts after a stop — edit-
// and-resend, send-while-streaming, quick-action-while-loading. Without
// it, the previous hardStop's 10 s blackout rejects the new task's
// first tool calls, Claude retries them, hits the loop detector, and
// bails. The adversarial reviewer called this finding #1.
export function clearToolRejection() {
  rejectUntil = 0;
}

async function resolveTabId(preferred) {
  if (preferred) {
    try { const t = await chrome.tabs.get(preferred); if (t) return t.id; } catch {}
  }
  // Use the locked task tab when one exists and it's still alive.
  if (activeTask?.tabId) {
    try { const t = await chrome.tabs.get(activeTask.tabId); if (t) return t.id; } catch {}
  }
  // Fall back to whatever is active right now.
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t?.id;
}

async function pass(name, args) {
  if (Date.now() < rejectUntil) throw new Error("Task cancelled by user");
  const tabId = await resolveTabId(args?.tabId);
  return await executeTool(name, args || {}, tabId);
}

// Derived from src/lib/tool-registry.ts — one declaration per tool,
// one handler map, zero drift. Adding a tool = update the registry,
// and this map updates itself on next load. Previously 22 lines of
// copy-paste `name: (a) => pass(name, a)`.
export const nativeToolHandlers = Object.fromEntries(
  getAllToolNames().map((name) => [name, (a) => pass(name, a)]),
);
