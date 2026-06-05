/**
 * Chrome DevTools Protocol helpers.
 * Attach, enable domains, dispatch input, take screenshots, talk to content script.
 */

import { attachedTabs, screenshotStore, pendingDialogs } from "./state.js";
import { sleep } from "./utils.js";

// URL schemes where Chromium blocks chrome.debugger.attach and content
// scripts. We preflight-check so the user sees a clear Arabic message
// instead of the raw "Cannot access a chrome:// URL" from the browser.
//
// Deliberately NOT included:
//   • about:blank — attachable and common during tab transitions.
//     Other about:* URLs (version, config, ...) get redirected to
//     chrome:// by Chromium, so the chrome|brave arm catches them.
const RESTRICTED_SCHEME = /^(?:chrome|brave|edge|chrome-extension|devtools|view-source|chrome-search|chrome-untrusted):/i;
const RESTRICTED_HOST = /^https?:\/\/chrome\.google\.com\/webstore/i;
function describeRestrictedUrl(url) {
  if (!url) return null;
  if (RESTRICTED_SCHEME.test(url) || RESTRICTED_HOST.test(url)) {
    return "صفحة داخليّة — افتح موقعاً عادياً ثم حاول.";
  }
  return null;
}

export async function ensureAttached(tabId) {
  // A new attach means a fresh period of activity — cancel any pending
  // idle-detach from a previous task so we don't tear the pipe out mid-flight.
  cancelDetachSchedule();
  if (attachedTabs.has(tabId)) return;
  // Preflight URL check — Chromium would reject the attach with an
  // English error; surface a friendlier one without attempting first.
  try {
    const tab = await chrome.tabs.get(tabId);
    const why = describeRestrictedUrl(tab?.url);
    if (why) throw new Error(why);
  } catch (e) {
    if (e?.message?.startsWith("صفحة داخليّة")) throw e;
    // get() itself failed — fall through and let attach() surface it.
  }
  await chrome.debugger.attach({ tabId }, "1.3");
  attachedTabs.set(tabId, { enabledDomains: new Set() });
  await ensureDomain(tabId, "Page");
  // Enable the data-collection domains eagerly so the DevTools MCP
  // tools (read_console_messages, read_network_requests,
  // read_page_errors) always have data — not just data captured AFTER
  // the first Runtime.evaluate happens to enable Runtime as a side
  // effect. Enable failures are non-fatal: the listeners in
  // background.js silently no-op when no events arrive.
  for (const dom of ["Runtime", "Console", "Network"]) {
    try { await ensureDomain(tabId, dom); } catch {}
  }
  // Lock deviceScaleFactor to 1 so screenshots are 1:1 with the CSS
  // coordinates the AI sees. CRITICAL: size the override to the page's ACTUAL
  // CSS viewport (window.innerWidth/innerHeight), NOT chrome.windows.get()
  // dimensions — on a maximized window at fractional display scaling (e.g.
  // 125%) the windows API overstates the height by ~16px, which forced the
  // emulated viewport TALLER than the visible window and clipped the bottom of
  // every page + the automation border. Querying the real viewport first (the
  // override isn't applied yet on a fresh attach) keeps it 1:1 and unclipped.
  try {
    const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: "({ w: window.innerWidth, h: window.innerHeight })",
      returnByValue: true,
    });
    const vp = r?.result?.value;
    if (vp && vp.w > 0 && vp.h > 0) {
      await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
        width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false,
      });
    }
  } catch {}
  // Pretend the tab has focus even when it doesn't.
  //   Many sites pause video/animations/analytics when the tab is
  //   backgrounded (`document.hasFocus() === false` or Page Visibility
  //   API says hidden). While the user interacts with our side panel
  //   they technically "leave" the tab, which breaks automation that
  //   depends on visible rendering. Emulation.setFocusEmulationEnabled
  //   makes `document.hasFocus()` return true without actually stealing
  //   the user's focus from the side panel.
  try {
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", {
      enabled: true,
    });
  } catch {}
}

// ──────────────────────────────────────────────────────────────────────────
// Idle detach
//
// Chromium shows a mandatory "Extension is debugging this browser" bar
// while any tab has chrome.debugger attached. The bar steals ~36 px of
// vertical space from both the page AND the side panel, which users
// reasonably find annoying.
//
// Trade-off:
//   • Short idle (e.g. 5 s)  → bar disappears between tasks, BUT
//     reappears every time the user runs a new task. Constant flicker.
//   • Long idle (e.g. 30 m)  → bar appears once per session and stays.
//     No flicker. The page/panel get used to the lost 36 px and the
//     user only "pays" for it once.
//
// User feedback was overwhelmingly the second option: stop the flicker.
// We now wait 30 minutes of zero browser-tool activity before detaching.
// For permanent suppression of the bar entirely, launch Chrome with
// `--silent-debugger-extension-api` (Chromium-supported since 2017).
// ──────────────────────────────────────────────────────────────────────────
const DETACH_IDLE_MS = 30 * 60_000;
let detachTimer = null;

export function cancelDetachSchedule() {
  if (detachTimer) { clearTimeout(detachTimer); detachTimer = null; }
}

export function scheduleDetachAll(delayMs = DETACH_IDLE_MS) {
  cancelDetachSchedule();
  if (attachedTabs.size === 0) return; // nothing to detach
  detachTimer = setTimeout(async () => {
    detachTimer = null;
    // Snapshot first — we mutate the map as we go.
    const tabIds = [...attachedTabs.keys()];
    for (const tabId of tabIds) {
      try { await chrome.debugger.detach({ tabId }); } catch {}
      attachedTabs.delete(tabId);
    }
  }, delayMs);
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

// ──────────────────────────────────────────────────────────────────────────
// Human-like mouse path
//
// A raw Input.dispatchMouseEvent to (x, y) is a single teleport — no
// mousemove history, which is the exact fingerprint sites like Stripe,
// Cloudflare Turnstile, and Gmail's click handlers look for. Real users
// move the cursor along a curved path with mousemove events before the
// click lands, so we reproduce that:
//
//   1. Start from the last known cursor position on this tab (or a
//      plausible edge pixel on first call).
//   2. Trace a quadratic Bezier to the target with a perpendicular
//      offset control point — gives a soft, non-straight arc.
//   3. Emit 6–9 mouseMoved events along the arc with 8–20 ms jitter.
//   4. Sleep briefly on target (hover-before-click), then press/release
//      with a slightly random hold duration.
//
// Total added latency: ~100–250 ms per click. Worth it — this alone
// unblocks dozens of sites that silently ignored synthetic clicks.
// ──────────────────────────────────────────────────────────────────────────

const lastMousePos = new Map(); // tabId → { x, y }

function bezier(t, p0, p1, p2) {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
    y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
  };
}

function curveControlPoint(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  // Perpendicular offset, scaled to the distance but capped so short
  // hops don't produce wild arcs.
  const magnitude = Math.min(dist * 0.25, 90) * (Math.random() * 0.6 + 0.4);
  const sign = Math.random() < 0.5 ? 1 : -1;
  return {
    x: (from.x + to.x) / 2 + (-dy / dist) * magnitude * sign,
    y: (from.y + to.y) / 2 + (dx / dist) * magnitude * sign,
  };
}

async function humanMouseMove(tabId, from, to, modifiers = 0) {
  const cp = curveControlPoint(from, to);
  const steps = 6 + Math.floor(Math.random() * 4); // 6–9
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const p = bezier(t, from, cp, to);
    await dispatchMouse(tabId, "mouseMoved", Math.round(p.x), Math.round(p.y), { modifiers });
    // Per-step delay: keeps the curve's natural rhythm. Tightened from
    // 8–20 ms to 5–12 ms — still variable enough to avoid linear-timer
    // fingerprints, ~40% faster across a 6–9 step path.
    await sleep(5 + Math.random() * 7);
  }
}

export async function mouseClick(tabId, x, y, opts = {}) {
  const base = {
    button: opts.button || "left",
    clickCount: opts.clickCount || 1,
    modifiers: opts.modifiers || 0,
  };

  // Start point: wherever the cursor was last seen on this tab, or a
  // plausible neutral position if this is the first click.
  const from = lastMousePos.get(tabId) || {
    x: 40 + Math.random() * 80,
    y: 40 + Math.random() * 80,
  };
  await humanMouseMove(tabId, from, { x, y }, base.modifiers);
  lastMousePos.set(tabId, { x, y });

  // Brief hover before the press — real users don't click the instant
  // the cursor arrives. Random 30–80 ms (tightened from 50–130).
  await sleep(30 + Math.random() * 50);
  await dispatchMouse(tabId, "mousePressed", x, y, base);
  // Hold duration — real clicks are 25–65 ms between down and up
  // (tightened from 40–110, still within observed human range).
  await sleep(25 + Math.random() * 40);
  await dispatchMouse(tabId, "mouseReleased", x, y, base);
}

/**
 * Human-like drag gesture.
 *
 * Mouse events (not HTML5 Drag Events) are what most JS drag libraries
 * rely on today — react-beautiful-dnd, SortableJS, drag-plugin of
 * jQuery-UI, most canvas apps (Figma, Miro, tldraw). Browsers fire
 * `dragstart` automatically once mousedown is followed by a mousemove
 * that crosses the drag threshold, so the mouse-event sequence we emit
 * covers both worlds in the same call.
 *
 * Sequence (roughly what a hand actually does):
 *   1. Approach the source with a curved path
 *   2. Settle, press
 *   3. Nudge a few pixels to cross the drag threshold and trigger dragstart
 *   4. Slow curve to the target (more waypoints than a plain click —
 *      dragging is deliberate)
 *   5. Hover briefly at the drop point (users hesitate before releasing)
 *   6. Release
 */
export async function mouseDrag(tabId, fromX, fromY, toX, toY, opts = {}) {
  const mods = opts.modifiers || 0;
  const base = { button: "left", clickCount: 1, modifiers: mods };

  const startFrom = lastMousePos.get(tabId) || {
    x: fromX - 30 - Math.random() * 40,
    y: fromY - 30 - Math.random() * 40,
  };
  await humanMouseMove(tabId, startFrom, { x: fromX, y: fromY }, mods);
  // Settle on source before press (tightened from 80–160 → 50–100 ms).
  await sleep(50 + Math.random() * 50);

  await dispatchMouse(tabId, "mousePressed", fromX, fromY, base);
  // Threshold-crossing nudge so HTML5 dragstart fires
  // (tightened from 40–80 → 25–50 ms).
  await sleep(25 + Math.random() * 25);
  await dispatchMouse(tabId, "mouseMoved", fromX + 4, fromY + 4, { modifiers: mods, button: "left" });
  await sleep(20);

  // Deliberate curve to the target — more waypoints, slower than a plain
  // click but still tightened (was 12–30 → now 8–18 ms per step).
  const cp = curveControlPoint({ x: fromX, y: fromY }, { x: toX, y: toY });
  const steps = 12 + Math.floor(Math.random() * 6);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const p = bezier(t, { x: fromX, y: fromY }, cp, { x: toX, y: toY });
    await dispatchMouse(tabId, "mouseMoved", Math.round(p.x), Math.round(p.y), {
      modifiers: mods, button: "left",
    });
    await sleep(8 + Math.random() * 10);
  }

  lastMousePos.set(tabId, { x: toX, y: toY });
  // Drop hesitation — real users pause before releasing
  // (tightened from 100–250 → 60–150 ms).
  await sleep(60 + Math.random() * 90);
  await dispatchMouse(tabId, "mouseReleased", toX, toY, base);
}

/**
 * Parse a list like ["ctrl","shift"] into the bitmask CDP expects.
 * Bits: alt=1, ctrl=2, meta=4, shift=8.
 */
export function modifiersBitmask(list) {
  if (!Array.isArray(list)) return 0;
  let n = 0;
  for (const m of list) {
    const lc = String(m).toLowerCase();
    if (lc === "alt") n |= 1;
    else if (lc === "ctrl" || lc === "control") n |= 2;
    else if (lc === "meta" || lc === "cmd" || lc === "command") n |= 4;
    else if (lc === "shift") n |= 8;
  }
  return n;
}

// Public accessor so other modules can know where we last moved the
// cursor (useful for drag gestures and chained hovers later).
export function getLastMousePos(tabId) {
  return lastMousePos.get(tabId) || null;
}
export function clearLastMousePos(tabId) {
  lastMousePos.delete(tabId);
}

// ──────────────────────────────────────────────────────────────────────────
// DOM stability (wait until mutations settle)
// ──────────────────────────────────────────────────────────────────────────

// Quiet period: how long the DOM must be mutation-free before we call
// it "stable". 150 ms is tight enough to not block Claude's next action
// on pages that settle instantly (most), and long enough to let a
// single React re-render batch complete. Raising to 300 ms (old
// default) added ~150 ms per click/nav/enter — ~1.5 s across a
// 10-action task. Under 100 ms trips React's dev-mode double-render.
const STABLE_QUIET_MS = 150;

export async function waitForDomStable(tabId, timeoutMs = 2000) {
  try {
    await cdp(tabId, "Runtime.evaluate", {
      expression: `new Promise(resolve => {
        let t = null;
        const o = new MutationObserver(() => {
          clearTimeout(t);
          t = setTimeout(() => { o.disconnect(); resolve(true); }, ${STABLE_QUIET_MS});
        });
        o.observe(document.body, { childList: true, subtree: true, attributes: true });
        t = setTimeout(() => { o.disconnect(); resolve(false); }, ${timeoutMs});
      })`,
      awaitPromise: true, returnByValue: true,
    });
  } catch {}
}

// ──────────────────────────────────────────────────────────────────────────
// Screenshot — two profiles, picked by the caller:
//
//   • AGENT profile (default): JPEG q45 @ 1280px max width.
//     Tuned for the LLM's automated tool-loop where it shoots 5-30 times
//     per task. Speed and token cost dominate; small text legibility is a
//     soft requirement.
//
//   • MANUAL profile (highQuality: true): JPEG q80 @ 1920px max width.
//     Tuned for the user pressing the 📸 chip to ask "what's in this?".
//     One-shot capture, latency invisible to humans, and small text
//     (sidebar labels, buttons, tab strips) MUST be readable. The old
//     q45/1280 settings made small Arabic / English UI text unreadable
//     and Claude vision filled the gap by guessing from project context
//     ("I'm in Claude Companion → that sparkle must be Claude's logo")
//     — a real hallucination case observed in the wild.
//
// Implementation note: even MANUAL stays JPEG (not WebP) for now because
// our test surface and the Anthropic Files API both accept JPEG by default
// and we want to keep one code path. Switching to WebP can save another
// ~25-30% with no quality cost — see screenshot perf TODO.
// ──────────────────────────────────────────────────────────────────────────

export async function takeScreenshot(tabId, options = {}) {
  await ensureAttached(tabId);

  const highQuality = options.highQuality === true;

  // Format: PNG (lossless) for the user-pressed path; JPEG for the
  // agent loop. Why this matters: JPEG compression — even at q80 —
  // smudges the 1-2 px stems of small Arabic letters and fine UI text
  // (sidebar labels, tab strips), which is exactly the input that
  // tripped Claude into hallucinating "Claude logo" instead of reading
  // the actual "X" / "Grok" labels off X.com. PNG removes the entire
  // failure mode at the cost of 3-4× the bytes — fine for a one-off
  // user request, not fine for the 30-shot agent loop.
  const FORMAT = highQuality ? "png" : "jpeg";
  const MEDIA_TYPE = highQuality ? "image/png" : "image/jpeg";

  // Width caps: agent loop needs cheap, user inspection needs detail.
  const MAX_W = highQuality ? 1920 : 1280;
  // Speed/quality knob: when the user is waiting for an answer, prefer
  // crisp output over the ~30 ms saved by speed-optimised encoding.
  const OPTIMIZE_SPEED = !highQuality;
  // Size budget: agent shots stay tight (Anthropic charges per image
  // token); user shots get a bigger budget for PNG which is naturally
  // 3-4× a JPEG of the same scene.
  const SIZE_CAP = highQuality ? 4_500_000 : 400_000;

  // Downscale oversized viewports — image tokens scale with dimensions.
  let clip = null;
  try {
    const metrics = await cdp(tabId, "Page.getLayoutMetrics", {});
    const vw = metrics?.cssLayoutViewport?.clientWidth || metrics?.layoutViewport?.clientWidth;
    const vh = metrics?.cssLayoutViewport?.clientHeight || metrics?.layoutViewport?.clientHeight;
    if (vw && vh) {
      const scale = vw > MAX_W ? MAX_W / vw : 1;
      clip = { x: 0, y: 0, width: vw, height: vh, scale };
    }
  } catch {}

  const opts = {
    format: FORMAT,
    optimizeForSpeed: OPTIMIZE_SPEED,
    captureBeyondViewport: false,
  };
  // PNG ignores the `quality` field — only set it for JPEG.
  if (FORMAT === "jpeg") opts.quality = highQuality ? 80 : 45;
  if (clip) opts.clip = clip;
  // Diagnostic so we can verify in the panel/service-worker console
  // that the high-quality path is actually running. If a user reports
  // hallucination and this line never appears, the extension wasn't
  // reloaded — that has been the #1 cause of "fix didn't work" so far.
  try { console.log(`[screenshot] profile=${highQuality ? "MANUAL/png" : "AGENT/jpeg"} maxW=${MAX_W}`); } catch {}

  // Hide our own automation overlay so it doesn't end up baked into the
  // screenshot as a thick orange frame. Best-effort — if the page has a
  // hostile CSP that blocks Runtime.evaluate, the worst case is the old
  // behaviour (border visible in shot).
  const HIDE_OVERLAY_JS = `(() => {
    const ids = ['__cc_automation_border__'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) el.style.setProperty('visibility', 'hidden', 'important');
    }
    // Click ripples are short-lived but still bake into screenshots if
    // taken mid-animation — nuke any visible ones for the duration.
    document.querySelectorAll('[style*="__cc_ripple"]').forEach(
      el => el.style.setProperty('visibility', 'hidden', 'important')
    );
  })()`;
  const SHOW_OVERLAY_JS = `(() => {
    const el = document.getElementById('__cc_automation_border__');
    if (el) el.style.removeProperty('visibility');
  })()`;

  try { await cdp(tabId, "Runtime.evaluate", { expression: HIDE_OVERLAY_JS }); } catch {}

  const res = await cdp(tabId, "Page.captureScreenshot", opts);
  let base64 = res.data;
  let outMediaType = MEDIA_TYPE;

  // Adaptive size cap.
  // - JPEG path: drop quality once.
  // - PNG path:  PNG can't be re-encoded smaller, so on overflow we
  //   degrade gracefully to a JPEG q70 capture (still better than the
  //   agent default and well under the host's 10 MB cap). This only
  //   triggers on huge viewports (e.g. 4K monitors at 1.0 DPR) — the
  //   common case stays PNG.
  if (base64.length > SIZE_CAP) {
    if (FORMAT === "jpeg") {
      const fallbackQ = highQuality ? 60 : 25;
      const smaller = await cdp(tabId, "Page.captureScreenshot", { ...opts, quality: fallbackQ });
      base64 = smaller.data;
    } else {
      const jpegOpts = { ...opts, format: "jpeg", quality: 70 };
      const smaller = await cdp(tabId, "Page.captureScreenshot", jpegOpts);
      base64 = smaller.data;
      outMediaType = "image/jpeg";
    }
  }

  // Restore the border so the sticky-during-task indicator doesn't vanish
  // permanently after a screenshot.
  try { await cdp(tabId, "Runtime.evaluate", { expression: SHOW_OVERLAY_JS }); } catch {}

  const imageId = `shot_${Date.now()}`;
  screenshotStore.set(imageId, base64);
  const keys = Array.from(screenshotStore.keys());
  while (keys.length > 10) screenshotStore.delete(keys.shift());
  // Diagnostic: helps confirm the new pipeline is running and that
  // PNG actually shipped (not silently degraded by the SIZE_CAP path).
  try { console.log(`[screenshot] sent mediaType=${outMediaType} bytes=${base64.length}`); } catch {}

  return { base64, imageId, mediaType: outMediaType };
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
