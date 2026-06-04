/**
 * Confirmation-gate registry (ROADMAP 1.3).
 *
 * The Pro-Mode shell/file tools that can modify the machine run inside the
 * mcp-server (Node). Before executing one, the server asks the browser "is
 * this OK?" via a `__confirm__` tool_request. native.js routes that here:
 * requestConfirm() shows the open side-panel(s) a `confirm_request` and
 * returns a Promise<boolean> that settles when the user clicks Approve/Deny
 * (resolveConfirm, called from the panel port handler), or DENIES on timeout
 * or when no panel is open. Fail-safe by construction: the only path to
 * `true` is an explicit human approval.
 */
import { connectedPanels } from "../core/state.js";

const pending = new Map(); // confirmId -> { resolve, timer }
let confirmCounter = 0;
const CONFIRM_TIMEOUT_MS = 120_000; // human has 2 min; after that, deny

export function requestConfirm(summary, tool, timeoutMs = CONFIRM_TIMEOUT_MS) {
  return new Promise((resolve) => {
    // No panel open → nobody can approve → deny immediately. (The agent runs
    // headless; a destructive action with no human present must not proceed.)
    if (connectedPanels.size === 0) { resolve(false); return; }

    const confirmId = `cf_${Date.now()}_${++confirmCounter}`;
    const timer = setTimeout(() => {
      if (pending.delete(confirmId)) resolve(false); // timed out → deny
    }, timeoutMs);
    pending.set(confirmId, { resolve, timer });

    // Post directly to panels (not broadcastToPanels) so this transient prompt
    // isn't buffered onto activeTask.messages and replayed to a panel that
    // reopens later.
    const payload = { type: "confirm_request", confirmId, summary, tool };
    for (const p of [...connectedPanels]) {
      try { p.postMessage(payload); } catch { connectedPanels.delete(p); }
    }
    // If every post failed (all ports stale), there's no one to answer → deny.
    if (connectedPanels.size === 0) {
      clearTimeout(timer);
      pending.delete(confirmId);
      resolve(false);
    }
  });
}

export function resolveConfirm(confirmId, approved) {
  const entry = pending.get(confirmId);
  if (!entry) return; // unknown / already-settled (timeout or duplicate click)
  clearTimeout(entry.timer);
  pending.delete(confirmId);
  entry.resolve(!!approved);
}
