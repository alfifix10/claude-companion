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

let rejectUntil = 0;
export function rejectToolsFor(ms = 3000) {
  rejectUntil = Date.now() + ms;
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

export const nativeToolHandlers = {
  tabs_context: (a) => pass("tabs_context", a),
  tabs_create: (a) => pass("tabs_create", a),
  navigate: (a) => pass("navigate", a),
  read_page: (a) => pass("read_page", a),
  get_page_text: (a) => pass("get_page_text", a),
  find: (a) => pass("find", a),
  click: (a) => pass("click", a),
  drag: (a) => pass("drag", a),
  type_text: (a) => pass("type_text", a),
  press_key: (a) => pass("press_key", a),
  form_input: (a) => pass("form_input", a),
  screenshot: (a) => pass("screenshot", a),
  scroll: (a) => pass("scroll", a),
  run_javascript: (a) => pass("run_javascript", a),
  wait_for: (a) => pass("wait_for", a),
  hover: (a) => pass("hover", a),
  select_option: (a) => pass("select_option", a),
  list_tabs: (a) => pass("list_tabs", a),
  tabs_overview: (a) => pass("tabs_overview", a),
  switch_tab: (a) => pass("switch_tab", a),
  tabs_close: (a) => pass("tabs_close", a),
  file_upload: (a) => pass("file_upload", a),
};
