/**
 * Chrome DevTools Protocol helpers.
 * Attach, enable domains, dispatch input, take screenshots, talk to content script.
 */

import { attachedTabs, screenshotStore, pendingDialogs } from "./state.js";
import { sleep } from "./utils.js";

export async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attachedTabs.set(tabId, { enabledDomains: new Set() });
  await ensureDomain(tabId, "Page");
  // Lock devicePixelRatio so screenshots match CSS coordinates the AI sees.
  try {
    const tab = await chrome.tabs.get(tabId);
    const win = await chrome.windows.get(tab.windowId);
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
      width: win.width, height: win.height, deviceScaleFactor: 1, mobile: false,
    });
  } catch {}
}

export async function ensureDomain(tabId, domain) {
  const st = attachedTabs.get(tabId);
  if (!st) throw new Error("Not attached");
  if (st.enabledDomains.has(domain)) return;
  await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`, {});
  st.enabledDomains.add(domain);
}

export async function cdp(tabId, method, params = {}) {
  await ensureAttached(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// ──────────────────────────────────────────────────────────────────────────
// Mouse + keyboard
// ──────────────────────────────────────────────────────────────────────────

export async function dispatchMouse(tabId, type, x, y, opts = {}) {
  await cdp(tabId, "Input.dispatchMouseEvent", {
    type, x, y,
    button: opts.button || "left",
    clickCount: opts.clickCount || 1,
    modifiers: opts.modifiers || 0,
  });
}

export async function mouseClick(tabId, x, y, opts = {}) {
  const base = { button: opts.button || "left", clickCount: opts.clickCount || 1, modifiers: opts.modifiers || 0 };
  await dispatchMouse(tabId, "mouseMoved", x, y, { modifiers: base.modifiers });
  await sleep(40);
  await dispatchMouse(tabId, "mousePressed", x, y, base);
  await sleep(40);
  await dispatchMouse(tabId, "mouseReleased", x, y, base);
}

// ──────────────────────────────────────────────────────────────────────────
// DOM stability (wait until mutations settle)
// ──────────────────────────────────────────────────────────────────────────

export async function waitForDomStable(tabId, timeoutMs = 2000) {
  try {
    await cdp(tabId, "Runtime.evaluate", {
      expression: `new Promise(resolve => {
        let t = null;
        const o = new MutationObserver(() => {
          clearTimeout(t);
          t = setTimeout(() => { o.disconnect(); resolve(true); }, 300);
        });
        o.observe(document.body, { childList: true, subtree: true, attributes: true });
        t = setTimeout(() => { o.disconnect(); resolve(false); }, ${timeoutMs});
      })`,
      awaitPromise: true, returnByValue: true,
    });
  } catch {}
}

// ──────────────────────────────────────────────────────────────────────────
// Screenshot (JPEG q45 + downscaled for token efficiency)
// ──────────────────────────────────────────────────────────────────────────

export async function takeScreenshot(tabId) {
  await ensureAttached(tabId);

  // Downscale oversized viewports — image tokens scale with dimensions.
  let clip = null;
  try {
    const metrics = await cdp(tabId, "Page.getLayoutMetrics", {});
    const vw = metrics?.cssLayoutViewport?.clientWidth || metrics?.layoutViewport?.clientWidth;
    const vh = metrics?.cssLayoutViewport?.clientHeight || metrics?.layoutViewport?.clientHeight;
    if (vw && vh) {
      const MAX_W = 1280;
      const scale = vw > MAX_W ? MAX_W / vw : 1;
      clip = { x: 0, y: 0, width: vw, height: vh, scale };
    }
  } catch {}

  const opts = { format: "jpeg", quality: 45, optimizeForSpeed: true, captureBeyondViewport: false };
  if (clip) opts.clip = clip;

  const res = await cdp(tabId, "Page.captureScreenshot", opts);
  let base64 = res.data;

  // Hard cap at ~400KB — if still too big, drop to q25
  if (base64.length > 400_000) {
    const smaller = await cdp(tabId, "Page.captureScreenshot", { ...opts, quality: 25 });
    base64 = smaller.data;
  }

  const imageId = `shot_${Date.now()}`;
  screenshotStore.set(imageId, base64);
  const keys = Array.from(screenshotStore.keys());
  while (keys.length > 10) screenshotStore.delete(keys.shift());

  return { base64, imageId };
}

// ──────────────────────────────────────────────────────────────────────────
// Content-script bridge (for DOM-level helpers)
// ──────────────────────────────────────────────────────────────────────────

export async function sendContentMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Content script wasn't injected (e.g. the tab was already open when the
    // extension loaded). Inject it on demand and retry.
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

export async function resolveRefCoords(tabId, ref) {
  const resp = await sendContentMessage(tabId, { type: "getRefCoordinates", ref });
  if (resp?.result) return [resp.result.x, resp.result.y];
  return null;
}

export async function resolveClickTarget(tabId, input) {
  if (input.ref) {
    let c = await resolveRefCoords(tabId, input.ref);
    if (!c) {
      await sendContentMessage(tabId, { type: "scrollToRef", ref: input.ref });
      await sleep(400);
      c = await resolveRefCoords(tabId, input.ref);
    }
    return c || [null, null];
  }
  if (input.coordinate) return input.coordinate;
  return [null, null];
}

export function dialogNote(tabId) {
  const d = pendingDialogs.get(tabId);
  if (!d) return "";
  // Include the disposition so Claude knows whether the action went through.
  // E.g. a confirm() dialog is auto-dismissed, so Claude should not assume
  // the underlying action (delete/submit) actually ran.
  const disp = d.accepted === false ? "dismissed" : "accepted";
  return ` [Dialog ${disp}: ${d.type} "${d.message}"]`;
}

export async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("No active tab");
  return tab;
}
