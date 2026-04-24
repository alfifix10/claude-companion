/**
 * Port handler for the side-panel.
 * The panel opens a long-lived port (name "chat") used for:
 *   • streaming a Max query (assistant text, tool events, final result)
 *   • reconnecting to an in-flight task when the panel reopens
 *
 * It also exposes a few one-shot chrome.runtime.onMessage RPCs:
 *   { type: "diag" }        → health/diag snapshot
 *   { type: "max_probe" }   → quick bool: is the native host healthy?
 *   { type: "local_action" }→ fire a local (no-AI) command
 */

import {
  activeTask,
  setActiveTask,
  addConnectedPanel,
  removeConnectedPanel,
} from "../core/state.js";
import { handleMaxChat, cancelActiveMaxTask } from "../agent/max.js";
import { executeLocal } from "../tools/local.js";
import { rejectToolsFor } from "../tools/native-tool-handlers.js";
import { cancelAllHost } from "./native.js";

export function setupPanelListener() {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "chat") return;
    addConnectedPanel(port);

    port.onMessage.addListener(async (msg) => {
      if (msg.type === "chat_send") {
        let tabId = null;
        try {
          const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          tabId = t?.id || null;
        } catch {}
        // Diagnostic: confirm images survived the bgPort transfer.
        // Temporary — remove once "Claude doesn't see pasted images"
        // bug is resolved.
        const imgs = msg.images || [];
        console.log("[bg<-panel] chat_send received images:", imgs.length,
          "mediaTypes:", imgs.map((i) => i?.mediaType).join(","),
          "sizes(base64):", imgs.map((i) => i?.base64?.length || 0).join(","));
        setActiveTask({
          running: true, stopped: false, messages: [],
          finalResult: null, runId: null, tabId,
          images: imgs,
        });
        handleMaxChat(msg.messages || []);
      }
      if (msg.type === "chat_stop") {
        if (activeTask) activeTask.stopped = true;
        cancelActiveMaxTask();
        // Belt-and-suspenders: nuke ALL claude subprocesses the host is
        // tracking (not just the "current" one we think is running).
        cancelAllHost();
        // Blackout: ignore any in-flight tool calls for 10 seconds. That's
        // longer than typical tool execution + native-messaging queue flush,
        // so lagging requests from the killed process can't sneak through.
        rejectToolsFor(10000);
      }
      if (msg.type === "get_status") {
        if (activeTask && activeTask.running) {
          for (const m of activeTask.messages) {
            try { port.postMessage(m); } catch { break; }
          }
        } else if (activeTask && activeTask.finalResult && !activeTask.resultSent) {
          activeTask.resultSent = true;
          try { port.postMessage(activeTask.finalResult); } catch {}
        } else {
          try { port.postMessage({ type: "no_task" }); } catch {}
        }
      }
    });

    port.onDisconnect.addListener(() => {
      removeConnectedPanel(port);
      // Task keeps running in background — user can reopen the panel to catch up
    });
  });

  // One-shot request/response endpoints (used by panel + welcome + settings)
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "local_action") {
      executeLocal(msg.action, msg.params || {})
        .then((r) => sendResponse(r || {}))
        .catch((err) => sendResponse({ error: err?.message || String(err) }));
      return true;
    }
    if (msg.type === "max_probe") {
      // Be generous with the timeout — host may be busy answering another
      // request, or SW just woke up and the pipe is still warming.
      import("./native.js").then(({ ensureHealthyPort }) => {
        ensureHealthyPort(5000)
          .then((ok) => sendResponse({ ok }))
          .catch(() => sendResponse({ ok: false }));
      });
      return true;
    }
    if (msg.type === "diag") {
      import("./native.js").then(({ requestDiag }) => {
        requestDiag(3000).then(sendResponse);
      });
      return true;
    }
  });
}
