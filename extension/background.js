/**
 * Service worker entry point.
 * Kept intentionally thin — wires modules together and handles lifecycle.
 *
 * Keep-alive strategy:
 *   Manifest V3 suspends the service worker after ~30s idle. To keep Max
 *   queries running uninterrupted we combine:
 *     • chrome.alarms every 20s (cheapest heartbeat)
 *     • heartbeat over the native port while a query is active
 *     • connected ports from the side panel (chrome.runtime.connect)
 *   Together these keep the SW alive indefinitely while work is happening,
 *   and let it sleep cleanly when idle.
 */

import { attachedTabs, consoleMessages, networkRequests, pendingDialogs, tabGroupTabs, nativePort, tabSelections, connectedPanels } from "./src/core/state.js";
import { cdp } from "./src/core/cdp.js";
import { recoverTabGroupState } from "./src/core/tabs.js";
import { connectNativeHost, ensureHealthyPort } from "./src/messaging/native.js";
import { restoreFromNativeIfEmpty, mirrorToNative } from "./src/core/user-data.js";
import { setupPanelListener } from "./src/messaging/panel.js";

// Prevent unhandled rejections from killing the SW
self.addEventListener("unhandledrejection", (event) => { event.preventDefault(); });

// Side panel opens on action-click (toolbar icon)
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});


// ──────────────────────────────────────────────────────────────────────────
// Keep-alive alarm — every 20 seconds, below the 30s SW idle limit
// ──────────────────────────────────────────────────────────────────────────
chrome.alarms.create("keepalive", { periodInMinutes: 20 / 60 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "keepalive") return;
  // Cheap wake-up: ensure the native port is healthy (reconnects if needed).
  // Doesn't spawn anything expensive — just keeps the pipe warm.
  if (!nativePort) connectNativeHost();
});

// ──────────────────────────────────────────────────────────────────────────
// Tab lifecycle cleanup
// ──────────────────────────────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  tabGroupTabs.delete(tabId);
  if (attachedTabs.has(tabId)) {
    try { chrome.debugger.detach({ tabId }); } catch {}
    attachedTabs.delete(tabId);
  }
  consoleMessages.delete(tabId);
  networkRequests.delete(tabId);
  // Was missing: a dialog open at the moment of close leaves a stale entry.
  // Chromium sometimes recycles tab IDs, so this can mislead later dialogs.
  pendingDialogs.delete(tabId);
  // Same concern for stored selections.
  tabSelections.delete(tabId);
});

chrome.debugger.onDetach.addListener((source) => {
  attachedTabs.delete(source.tabId);
});

// ──────────────────────────────────────────────────────────────────────────
// CDP event stream (console, network, dialogs) — for read_console_messages etc.
// ──────────────────────────────────────────────────────────────────────────
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;

  if (method === "Console.messageAdded" && params.message) {
    const msgs = consoleMessages.get(tabId) || [];
    msgs.push({ level: params.message.level, text: params.message.text, url: params.message.url || "", timestamp: Date.now() });
    if (msgs.length > 1000) msgs.splice(0, msgs.length - 1000);
    consoleMessages.set(tabId, msgs);
  }
  if (method === "Runtime.consoleAPICalled" && params.args) {
    const msgs = consoleMessages.get(tabId) || [];
    const text = params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    msgs.push({ level: params.type || "log", text, url: params.stackTrace?.callFrames?.[0]?.url || "", timestamp: Date.now() });
    if (msgs.length > 1000) msgs.splice(0, msgs.length - 1000);
    consoleMessages.set(tabId, msgs);
  }
  if (method === "Network.responseReceived" && params.response) {
    const reqs = networkRequests.get(tabId) || [];
    reqs.push({ url: params.response.url, method: "GET", status: params.response.status, statusText: params.response.statusText, type: params.type || "Other", mimeType: params.response.mimeType, timestamp: Date.now() });
    if (reqs.length > 1000) reqs.splice(0, reqs.length - 1000);
    networkRequests.set(tabId, reqs);
  }
  if (method === "Network.requestWillBeSent" && params.request) {
    const reqs = networkRequests.get(tabId) || [];
    reqs.push({ url: params.request.url, method: params.request.method, status: 0, type: params.type || "Other", timestamp: Date.now() });
    if (reqs.length > 1000) reqs.splice(0, reqs.length - 1000);
    networkRequests.set(tabId, reqs);
  }
  if (method === "Page.javascriptDialogOpening") {
    // Per-dialog-type policy. Blanket "accept everything" was dangerous:
    //   • confirm()    — auto-clicking "OK" could greenlight destructive
    //                     actions like "Delete account?" the AI didn't mean.
    //   • prompt()     — auto-accept with empty string submits garbage.
    // Safe defaults:
    //   • alert        → accept (just dismisses an informational box)
    //   • confirm      → DISMISS (treat as "Cancel" — don't do the action)
    //   • prompt       → DISMISS (don't submit a blank answer)
    //   • beforeunload → accept (the AI asked to navigate; honor it)
    let accept;
    switch (params.type) {
      case "alert":        accept = true;  break;
      case "confirm":      accept = false; break;
      case "prompt":       accept = false; break;
      case "beforeunload": accept = true;  break;
      default:             accept = false;
    }
    pendingDialogs.set(tabId, {
      type: params.type,
      message: params.message,
      accepted: accept,
    });
    cdp(tabId, "Page.handleJavaScriptDialog", { accept, promptText: "" }).catch(() => {});
  }
  if (method === "Page.javascriptDialogClosed") {
    pendingDialogs.delete(tabId);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Kick-off
// ──────────────────────────────────────────────────────────────────────────
recoverTabGroupState();
connectNativeHost();
setupPanelListener();

// Best-effort initial health probe — warms the pipe and updates the diag state
ensureHealthyPort(3000).catch(() => {});

// If the user reinstalled the extension, chrome.storage.local is empty but
// the native-host backup file still has their memories + tasks. Pull them
// back in silently. Does nothing when storage already has data.
restoreFromNativeIfEmpty().catch(() => {});

// Settings page can't directly hit the native port (it's a plain script, not
// a service-worker module). It asks us to mirror via runtime.sendMessage.
// Content script also uses this channel to push text-selection updates.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "mirror_user_data") {
    mirrorToNative(msg.data || {});
    sendResponse({ ok: true });
    return true;
  }

  // Selection state from content.js. Store per-tab so the panel can pick
  // up whichever tab is currently active — NOT just the most-recent any-tab
  // selection, which would cause a wrong-tab chip state after switching.
  if (msg?.type === "selection_update" && sender?.tab?.id !== undefined) {
    const tabId = sender.tab.id;
    if (msg.text) {
      tabSelections.set(tabId, { text: msg.text, url: msg.url || "", ts: Date.now() });
    } else {
      tabSelections.delete(tabId);
    }
    // Only notify panels if the update is for the currently-active tab.
    // Other tabs' selections are stored but silent.
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => {
      const activeId = tabs[0]?.id;
      if (activeId !== tabId) return;
      broadcastSelection(tabId);
    }).catch(() => {});
    return false;
  }

  // Panel pulls the current active tab's selection on demand (e.g. when
  // it first opens, or the user switches tabs).
  if (msg?.type === "get_selection") {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => {
      const activeId = tabs[0]?.id;
      const entry = activeId !== undefined ? tabSelections.get(activeId) : null;
      sendResponse({ text: entry?.text || "", url: entry?.url || "" });
    }).catch(() => sendResponse({ text: "", url: "" }));
    return true; // async sendResponse
  }
});

function broadcastSelection(tabId) {
  const entry = tabSelections.get(tabId);
  const msg = {
    type: "selection_changed",
    text: entry?.text || "",
    url: entry?.url || "",
  };
  for (const p of [...connectedPanels]) {
    try { p.postMessage(msg); } catch { connectedPanels.delete(p); }
  }
}

// Tab-switch → refresh the panel's chip state for the new active tab.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  broadcastSelection(tabId);
});
