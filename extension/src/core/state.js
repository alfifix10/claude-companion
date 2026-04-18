/**
 * Shared in-memory state for the service worker.
 * Every module imports from here — single source of truth.
 */

// Native messaging port to the host process
export let nativePort = null;
export function setNativePort(p) { nativePort = p; }

// CDP debugger attachments
export const attachedTabs = new Map(); // tabId → { enabledDomains: Set }

// Console + network capture per tab
export const consoleMessages = new Map();
export const networkRequests = new Map();

// Screenshot ring-buffer
export const screenshotStore = new Map();

// JS dialog tracking
export const pendingDialogs = new Map();

// Latest text selection per tab (pushed by content.js on selectionchange).
// Powers the side panel's "📌 المحدَّد" chip: clicking it pulls the active
// tab's stored selection and sends it to Claude as context.
// tabId → { text: string, url: string, ts: number }
export const tabSelections = new Map();

// Tab group tracking (if we adopt tab grouping later)
export let tabGroupId = null;
export const tabGroupTabs = new Set();
export function setTabGroupId(id) { tabGroupId = id; }

// Background task (Max query in progress) — survives panel open/close
export let activeTask = null;
export function setActiveTask(t) { activeTask = t; }

// Connected side-panel ports (can be multiple windows)
export const connectedPanels = new Set();
export function addConnectedPanel(p) { connectedPanels.add(p); }
export function removeConnectedPanel(p) { connectedPanels.delete(p); }

// Broadcast a message to every open side-panel AND buffer it on activeTask
// so a panel that opens mid-task can catch up via get_status.
export function broadcastToPanels(msg) {
  if (activeTask) {
    activeTask.messages.push(msg);
    if (activeTask.messages.length > 200) activeTask.messages.shift();
  }
  // Iterate over a snapshot — deleting while iterating a Set skips elements
  // in some engines, causing dropped messages when any panel is stale.
  const snapshot = [...connectedPanels];
  for (const p of snapshot) {
    try { p.postMessage(msg); } catch { connectedPanels.delete(p); }
  }
}
