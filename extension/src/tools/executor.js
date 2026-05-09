/**
 * Single dispatch point for every browser tool.
 * Both the MCP server (Claude Code side) and local Arabic shortcuts route
 * through here, so tool behavior is consistent everywhere.
 */

import {
  cdp, ensureAttached, mouseClick, mouseDrag, dispatchMouse, waitForDomStable,
  takeScreenshot, sendContentMessage, resolveRefCoords, resolveClickTarget,
  dialogNote, getActiveTab, modifiersBitmask,
} from "../core/cdp.js";
import { sleep, parseKeyCombo } from "../core/utils.js";
import { activeTask, broadcastToPanels } from "../core/state.js";
import { refusalMessage } from "../lib/file-upload-denylist.js";

// Keep the task-locked tab in sync when Claude creates or switches tabs.
function retargetTaskTab(newTabId) {
  if (!activeTask || !newTabId || activeTask.tabId === newTabId) return;
  const oldId = activeTask.tabId;
  activeTask.tabId = newTabId;
  if (oldId) sendContentMessage(oldId, { type: "hideAutomationBorder" }).catch(() => {});
  sendContentMessage(newTabId, { type: "showAutomationBorder", sticky: true }).catch(() => {});
}

// Pulse the activity border on the target tab for each tool call. This is
// refreshed on every action and auto-hides after 2.5s idle.
function pulseBorder(tabId) {
  if (!tabId) return;
  sendContentMessage(tabId, { type: "showAutomationBorder", autoHideMs: 2500 }).catch(() => {});
}

// Per-URL cache of get_page_text output.
//
// Readability extraction + serialisation runs ~100–300 ms inside the
// content script, and Claude frequently calls get_page_text twice in a
// row (once to confirm navigation, once to actually consume the text).
// Caching the previous result saves that round-trip entirely when the
// page has not been interacted with.
//
// Invalidation rules (see invalidatePageTextCache below):
//   • Any click / type_text / form_input / press_key / scroll / drag
//     on the tab → evict that tab's entry.
//   • navigate → evict.
//   • 60-second TTL as a defensive fallback for pages that update on
//     their own (news tickers, timelines).
// Everything else (read_page, screenshot, etc.) is allowed to re-use.
const pageTextCache = new Map(); // tabId → { url, title, text, ts }
const PAGE_TEXT_TTL_MS = 60_000;

export function invalidatePageTextCache(tabId) {
  if (tabId == null) return;
  pageTextCache.delete(tabId);
}

// Fire-and-forget page-text extraction. Scheduled after any state-
// changing tool so the next get_page_text call (which Claude issues
// after almost every click/nav/enter to "see what happened") hits a
// warm cache instead of paying the 200–400 ms Readability cost inline.
//
// Contract:
//   • Never throws — silent failure is fine, normal get_page_text will
//     just re-run the extraction on miss.
//   • Never awaited by the caller — runs in the background while the
//     agent sends its response back to Claude.
//   • Skips if a fresh entry was written in the meantime.
function schedulePageTextPrefetch(tabId) {
  if (tabId == null) return;
  // Defer one macrotask so the state-changing action's response goes
  // out first; Claude starts thinking while this runs in parallel.
  setTimeout(async () => {
    try {
      const tab = await chrome.tabs.get(tabId);
      const cached = pageTextCache.get(tabId);
      if (cached && cached.url === tab.url && Date.now() - cached.ts < PAGE_TEXT_TTL_MS) {
        return; // someone else filled it
      }
      const resp = await sendContentMessage(tabId, { type: "getPageText" });
      if (!resp?.result) return;
      const d = JSON.parse(resp.result);
      pageTextCache.set(tabId, {
        url: d.url || tab.url,
        title: d.title || tab.title,
        text: d.text || "",
        ts: Date.now(),
      });
    } catch { /* prefetch is best-effort */ }
  }, 0);
}

// ──────────────────────────────────────────────────────────────────────
// Page-delta capture
//
// After any state-changing tool (click, type, form_input, press_key,
// drag, navigate) we want to tell Claude IMMEDIATELY what that action
// caused on the page, without Claude having to spend another tool call
// on read_page just to check. Signal payload is intentionally tiny —
// just enough to answer "did this click open a modal? navigate? lose
// elements? surface an error?"
//
// The query runs as one Runtime.evaluate, ~30–60 ms total. Results
// attach as a short trailer on the tool-result string.
// ──────────────────────────────────────────────────────────────────────
async function capturePageSignals(tabId) {
  try {
    // Previous implementation checked element visibility via
    // `offsetParent !== null`, which forces a full layout flush on
    // every query — 80-200 ms on busy pages (Gmail, Twitter, Reddit)
    // TWICE per action (before + after). Switched to existence-only
    // queries plus `:not([aria-hidden="true"])` so we avoid the
    // layout. The false-positive rate on "error visible" is tiny
    // because apps that reveal errors normally set aria-hidden=false.
    const res = await cdp(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const q = (sel) => document.querySelectorAll(sel).length;
        return {
          url: location.href,
          title: document.title || "",
          interactive: q('button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="menuitem"]'),
          hasDialog: !!document.querySelector('[role="dialog"][aria-hidden="false"], dialog[open]'),
          errorVisible: !!document.querySelector('[role="alert"]:not([aria-hidden="true"]), [aria-live="assertive"]:not([aria-hidden="true"])'),
        };
      })()`,
      returnByValue: true,
    });
    return res?.result?.value || null;
  } catch { return null; }
}

function formatPageDelta(before, after) {
  if (!before || !after) return "";
  const parts = [];
  if (before.url !== after.url) {
    try {
      const u = new URL(after.url);
      parts.push(`→ ${u.pathname}${u.search || ""}`);
    } catch { parts.push(`→ ${after.url}`); }
  }
  if (before.title !== after.title && after.title) {
    const t = after.title.slice(0, 60);
    parts.push(`"${t}${after.title.length > 60 ? "…" : ""}"`);
  }
  const diff = after.interactive - before.interactive;
  if (Math.abs(diff) > 2) parts.push(`${diff > 0 ? "+" : ""}${diff} عناصر`);
  if (!before.hasDialog && after.hasDialog) parts.push("⚠ حوار ظهر");
  if (!before.errorVisible && after.errorVisible) parts.push("⚠ خطأ ظاهر");
  return parts.length ? ` | ${parts.join(", ")}` : "";
}

// Human-paced typing. Input.insertText is atomic — the whole string
// appears in one tick, which most keystroke-listening apps (Gmail,
// Twitter composer, Google Docs, rich-text editors) notice and either
// mishandle or flag as bot input. Typing one character at a time with
// variable delays solves both:
//   • Each insertText triggers the site's input/keyup listeners in the
//     same cadence a keyboard would.
//   • Variable delay (60–140 ms) + occasional "thinking pause" (200–
//     450 ms every 8–14 chars) reproduces the irregular rhythm of a
//     human typist.
//
// Three guards learned from real usage:
//   1. Always clear the focused field first. Without this, a retry
//      after an uncertain observation (common LLM behavior) appends
//      to the previous attempt, producing garbled output like
//      "beardobearsbearsholi" from three sequential goals. Clearing
//      runs via the content script — CDP Ctrl+A + Delete fails
//      silently on React-controlled inputs (CapCut, Figma, …) because
//      React consumes modifier+key events through its own synthetic
//      event layer and never runs the selection path. See
//      clearFocusedField in content.js.
//   2. Serialise humanType calls with a module-level mutex. An LLM
//      that calls type_text twice before the first finishes would
//      otherwise interleave the two loops and scramble both strings.
//   3. Fast path for short text (<20 chars). Human pacing exists to
//      fool keystroke listeners on rich composers; for a 5-char
//      search box, 2–4 s of character-by-character typing just makes
//      Claude think nothing happened and retry — re-introducing #1.
// Long-form (>300) still uses atomic insertText as before (~27 s
// otherwise).

// Serialise all typing so concurrent type_text calls can't interleave.
let typingInFlight = Promise.resolve();

async function clearFocusedField(tabId) {
  try {
    await sendContentMessage(tabId, { type: "clearFocusedField" });
  } catch { /* best-effort; worst case is one stale append */ }
}

async function humanType(tabId, text) {
  if (!text) return;
  // Wait for any prior humanType on any tab to finish before starting.
  // Global (not per-tab) is fine here: the active task types into one
  // tab at a time, and serialising across tabs adds a ~ms hiccup at
  // worst while eliminating a whole class of race bugs.
  const prev = typingInFlight;
  let release;
  typingInFlight = new Promise((r) => { release = r; });
  try {
    await prev;

    // Replace, don't append.
    await clearFocusedField(tabId);

    // Fast paths: very short (search queries, short form values) and
    // very long (pasted content). The human-paced middle band is for
    // composing messages, tweets, docs — places where keystroke
    // cadence actually matters.
    if (text.length < 20 || text.length > 300) {
      await cdp(tabId, "Input.insertText", { text });
      return;
    }

    let untilPause = 8 + Math.floor(Math.random() * 7); // next pause in 8–14 chars
    for (let i = 0; i < text.length; i++) {
      // Honour user-initiated stop between characters.
      if (activeTask?.stopped) return;
      await cdp(tabId, "Input.insertText", { text: text[i] });
      const base = 60 + Math.random() * 80;
      let extra = 0;
      if (--untilPause <= 0) {
        extra = 200 + Math.random() * 250;
        untilPause = 8 + Math.floor(Math.random() * 7);
      }
      await sleep(base + extra);
    }
  } finally {
    release();
  }
}

function rippleAt(tabId, x, y) {
  if (!tabId || x == null) return;
  sendContentMessage(tabId, { type: "showClickRipple", x, y }).catch(() => {});
}

export async function executeTool(name, input, tabId) {
  if (!tabId) {
    const tab = await getActiveTab();
    tabId = tab.id;
  }

  // Show the "something is happening" border for every tool call — auto-hides
  // 2.5s after the last action. Sticky task-level show is handled separately.
  pulseBorder(tabId);

  switch (name) {
    case "tabs_context": {
      const tab = await chrome.tabs.get(tabId);
      return { tabId: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title };
    }
    case "tabs_create": {
      const active = input.active !== false;
      const t = await chrome.tabs.create({ url: input.url, active });
      // Only migrate the task to the new tab if it was opened active —
      // otherwise we'd silently steer subsequent click/type to a tab
      // the user can't see, which looked to them like "nothing moved".
      if (active) retargetTaskTab(t.id);
      return `Opened tab ${t.id}${active ? "" : " (background)"}: ${t.url}`;
    }
    case "navigate": {
      invalidatePageTextCache(tabId);
      if (input.direction === "back") { await cdp(tabId, "Page.goBack", {}); return "Went back"; }
      if (input.direction === "forward") { await cdp(tabId, "Page.goForward", {}); return "Went forward"; }
      let url = input.url;
      if (!url) return "url or direction required";
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;
      await chrome.tabs.update(tabId, { url });
      await sleep(1200);
      schedulePageTextPrefetch(tabId);
      return `Navigated to ${url}`;
    }
    case "read_page": {
      const diff = input.full !== true;
      const resp = await sendContentMessage(tabId, {
        type: "generateAccessibilityTree",
        options: { filter: input.filter || "interactive", max_chars: 12000, diff },
      });
      const tab = await chrome.tabs.get(tabId);
      if (resp?.mode === "unchanged") return `Page unchanged since last read_page — refs still valid.`;
      const tag = resp?.mode === "diff" ? " (diff)" : "";
      return `Page${tag}: ${tab.title}\nURL: ${tab.url}\n\n${resp?.result || "(error reading page)"}`;
    }
    case "get_page_text": {
      const tab = await chrome.tabs.get(tabId);
      const cached = pageTextCache.get(tabId);
      if (cached
          && cached.url === tab.url
          && Date.now() - cached.ts < PAGE_TEXT_TTL_MS) {
        return `Title: ${cached.title}\nURL: ${cached.url}\n\n${cached.text.slice(0, 15000)}`;
      }
      const resp = await sendContentMessage(tabId, { type: "getPageText" });
      if (!resp?.result) return "Error extracting text";
      try {
        const d = JSON.parse(resp.result);
        pageTextCache.set(tabId, {
          url: d.url || tab.url,
          title: d.title || tab.title,
          text: d.text || "",
          ts: Date.now(),
        });
        return `Title: ${d.title}\nURL: ${d.url}\n\n${(d.text || "").slice(0, 15000)}`;
      } catch { return resp.result; }
    }
    case "find": {
      const resp = await sendContentMessage(tabId, { type: "findElements", query: input.query });
      const results = resp?.result || [];
      if (!results.length) return `No elements matching "${input.query}".`;
      let out = `Found ${results.length}:\n`;
      for (const r of results) {
        const tag = r.interactive ? "⚡" : "  ";
        out += `${tag} [${r.ref}] <${r.tag}> ${r.role} "${r.name}" at (${r.coordinates[0]},${r.coordinates[1]})\n`;
      }
      try { sendContentMessage(tabId, { type: "highlightElements", refs: results.map((r) => r.ref) }); } catch {}
      return out;
    }
    case "click": {
      const [x, y] = await resolveClickTarget(tabId, input);
      if (x == null) return "Element not found (ref may have expired — call read_page again)";
      await ensureAttached(tabId);
      invalidatePageTextCache(tabId);
      const button = input.button || "left";
      const modifiers = modifiersBitmask(input.modifiers);
      const before = await capturePageSignals(tabId);
      // Element-level snapshot so we can detect "click had no effect"
      // even when the page as a whole didn't change — covers React
      // styled toggles where only aria-checked flips.
      const elBefore = input.ref
        ? (await sendContentMessage(tabId, { type: "captureElementSnapshot", ref: input.ref }))?.result
        : null;

      rippleAt(tabId, x, y);
      await mouseClick(tabId, x, y, { button, modifiers });
      await waitForDomStable(tabId);
      schedulePageTextPrefetch(tabId);

      const after = await capturePageSignals(tabId);
      const delta = formatPageDelta(before, after);
      const modNote = input.modifiers?.length ? ` with ${input.modifiers.join("+")}` : "";
      const btnNote = button !== "left" ? ` (${button} button)` : "";

      // Multi-strategy fallback: CDP synthetic events get refused by
      // React/styled toggles that check `event.isTrusted`. If the
      // click had no measurable effect on either the page OR the
      // target element, retry with element.click() — which dispatches
      // through the DOM's click event and reaches React handlers that
      // sidestep the isTrusted check. This is the fix for the "10-min
      // GitHub toggle loop" we hit during dogfood.
      const pageChanged = delta && delta.trim().length > 0;
      const elementChanged =
        elBefore && !elBefore.error
          ? await (async () => {
              const snap = await sendContentMessage(tabId, {
                type: "captureElementSnapshot",
                ref: input.ref,
              });
              const after = snap?.result;
              if (!after || after.error) return false;
              return (
                after.outer !== elBefore.outer ||
                JSON.stringify(after.attrs) !== JSON.stringify(elBefore.attrs)
              );
            })()
          : false;

      if (!pageChanged && !elementChanged && input.ref) {
        // CDP click had zero effect. Try JS fallback.
        const jsResult = await sendContentMessage(tabId, {
          type: "clickRefViaJS",
          ref: input.ref,
        });
        const jsOk = jsResult?.result?.ok === true;
        if (jsOk) {
          await waitForDomStable(tabId);
          schedulePageTextPrefetch(tabId);
          const after2 = await capturePageSignals(tabId);
          const delta2 = formatPageDelta(before, after2);
          return `Clicked${btnNote}${modNote} at (${x}, ${y}) via JS fallback${delta2}.${dialogNote(tabId)}`;
        }
        return `Clicked${btnNote}${modNote} at (${x}, ${y}) but nothing observably changed. Element may be disabled, covered, or require a specific key/modifier. Try a different approach.${dialogNote(tabId)}`;
      }

      return `Clicked${btnNote}${modNote} at (${x}, ${y})${delta}.${dialogNote(tabId)}`;
    }
    case "drag": {
      // Resolve source + destination independently — either can be a ref
      // or a raw coordinate pair. Reuses resolveClickTarget which knows
      // how to translate refs via the content script.
      const src = await resolveClickTarget(tabId, {
        ref: input.from_ref,
        coordinate: input.from_coordinate,
      });
      const dst = await resolveClickTarget(tabId, {
        ref: input.to_ref,
        coordinate: input.to_coordinate,
      });
      if (src[0] == null) return "Drag source not found (ref expired?)";
      if (dst[0] == null) return "Drag destination not found (ref expired?)";
      await ensureAttached(tabId);
      invalidatePageTextCache(tabId);
      const beforeDrag = await capturePageSignals(tabId);
      rippleAt(tabId, src[0], src[1]);
      await mouseDrag(tabId, src[0], src[1], dst[0], dst[1]);
      await waitForDomStable(tabId);
      schedulePageTextPrefetch(tabId);
      rippleAt(tabId, dst[0], dst[1]);
      const afterDrag = await capturePageSignals(tabId);
      const dragDelta = formatPageDelta(beforeDrag, afterDrag);
      return `Dragged from (${src[0]}, ${src[1]}) to (${dst[0]}, ${dst[1]})${dragDelta}.${dialogNote(tabId)}`;
    }
    case "type_text": {
      await ensureAttached(tabId);
      invalidatePageTextCache(tabId);
      await humanType(tabId, input.text);
      return `Typed "${input.text.slice(0, 50)}${input.text.length > 50 ? "..." : ""}"`;
    }
    case "press_key": {
      await ensureAttached(tabId);
      invalidatePageTextCache(tabId);
      const { key, modifiers } = parseKeyCombo(input.key);
      const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
      // Enter / Tab / Escape often submit or navigate — capture the
      // delta so Claude knows what just happened.
      const triggeringKey = /^(Enter|NumpadEnter|Tab|Escape)$/i.test(key);
      const before = triggeringKey ? await capturePageSignals(tabId) : null;
      await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers });
      await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
      if (triggeringKey) {
        await waitForDomStable(tabId);
        schedulePageTextPrefetch(tabId);
        const after = await capturePageSignals(tabId);
        return `Pressed ${input.key}${formatPageDelta(before, after)}`;
      }
      return `Pressed ${input.key}`;
    }
    case "form_input": {
      invalidatePageTextCache(tabId);
      const resp = await sendContentMessage(tabId, { type: "setFormValue", ref: input.ref, value: input.value });
      if (resp?.result?.error) return `Error: ${resp.result.error}`;
      return `Set ${input.ref} = "${input.value}"`;
    }
    case "screenshot": {
      await ensureAttached(tabId);
      // Set-of-Mark mode: overlay numbered labels on every interactive
      // element before taking the shot, then remove them. Claude sees
      // the image and can say "click label 5" — we resolve to the ref.
      // Useful for complex pages where A11y refs get stale and for any
      // "find me this button" situation where coords are too fragile.
      //
      // try/finally is critical: if takeScreenshot throws (tab crashed,
      // debugger detached, tab switched), the labels would otherwise
      // stay painted on the page until the user navigates or reloads
      // — a high-visibility failure mode. The content script also
      // auto-removes them after 8 s as a secondary safety net.
      let labels = null;
      let labelsAdded = false;
      try {
        if (input.labels) {
          try {
            const resp = await sendContentMessage(tabId, {
              type: "addScreenshotLabels",
              max: Math.min(Math.max(input.max_labels || 30, 5), 60),
            });
            labels = resp?.result?.labels || null;
            labelsAdded = !!labels;
          } catch {}
        }
        // highQuality lets the user-initiated 📸 chip pass through a
        // crisper-shot request. Default (agent loop) stays on the
        // token-cheap profile defined in cdp.takeScreenshot.
        // mediaType is "image/png" when highQuality wins the budget,
        // "image/jpeg" otherwise (or on PNG-too-big fallback). Pass it
        // through so the panel doesn't hardcode "image/jpeg" in the
        // attachment it sends to Claude — passing PNG bytes with a
        // jpeg mediaType would corrupt the image at the API boundary.
        const { base64, mediaType } = await takeScreenshot(tabId, { highQuality: input.highQuality === true });
        if (labels && Object.keys(labels).length) {
          const lines = Object.entries(labels)
            .map(([n, m]) => `  ${n}: ${m.role}${m.name ? ` "${m.name}"` : ""} @(${m.x},${m.y}) ref=${m.ref}`)
            .join("\n");
          return { type: "screenshot_labeled", base64, mediaType, labels,
            text: `Screenshot with ${Object.keys(labels).length} labeled interactive elements:\n${lines}\n\nTo act on one: "click ref=<value>" from the legend above, or use coordinates (x,y) from the entry.` };
        }
        return { type: "screenshot", base64, mediaType };
      } finally {
        if (labelsAdded) {
          try { await sendContentMessage(tabId, { type: "removeScreenshotLabels" }); } catch {}
        }
      }
    }
    case "scroll": {
      await ensureAttached(tabId);
      const amt = Math.min(input.amount || 3, 10);
      const totalDelta = input.direction === "up" ? -amt * 300 : amt * 300;

      // Hybrid strategy:
      //   1. Fire real wheel events at the viewport centre, split into a
      //      5–7 flick sequence with decay. This triggers any `wheel`
      //      listeners on the page (infinite feeds use these to load
      //      more content; some sites key animations to them too).
      //   2. Measure how far window actually scrolled. If the wheel
      //      didn't land on a window-scrollable container (e.g. the
      //      focus is inside a fixed sidebar with its own overflow:auto),
      //      fall back to the previous ancestor-finding scrollBy for the
      //      remaining delta. This preserves the "reliable even on weird
      //      layouts" property of the old implementation while adding the
      //      naturalness wheel events provide.
      let cx = 400, cy = 400;
      try {
        const metrics = await cdp(tabId, "Page.getLayoutMetrics", {});
        const vw = metrics?.cssLayoutViewport?.clientWidth || metrics?.layoutViewport?.clientWidth;
        const vh = metrics?.cssLayoutViewport?.clientHeight || metrics?.layoutViewport?.clientHeight;
        if (vw && vh) { cx = Math.round(vw / 2); cy = Math.round(vh / 2); }
      } catch {}

      const beforeRes = await cdp(tabId, "Runtime.evaluate", {
        expression: "window.scrollY",
        returnByValue: true,
      });
      const before = beforeRes?.result?.value || 0;

      // Split into 5–7 flicks with ±20% jitter per flick.
      const flicks = 5 + Math.floor(Math.random() * 3);
      const per = totalDelta / flicks;
      for (let i = 0; i < flicks; i++) {
        const delta = Math.round(per * (0.8 + Math.random() * 0.4));
        try {
          await cdp(tabId, "Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: cx, y: cy,
            deltaX: 0, deltaY: delta,
          });
        } catch {}
        await sleep(50 + Math.random() * 60);
      }

      // Let momentum / smooth-scroll complete before measuring.
      await sleep(120);

      const afterRes = await cdp(tabId, "Runtime.evaluate", {
        expression: "window.scrollY",
        returnByValue: true,
      });
      const after = afterRes?.result?.value || 0;
      const moved = after - before;
      const remaining = totalDelta - moved;

      // Anything left? The focused element probably has its own overflow.
      // Fall back to the programmatic scrollBy on the nearest scrollable
      // ancestor for the rest.
      if (Math.abs(remaining) > 30) {
        await cdp(tabId, "Runtime.evaluate", {
          expression: `(() => {
            let el = document.activeElement || document.scrollingElement || document.documentElement;
            while (el && el !== document.body) {
              const cs = getComputedStyle(el);
              const ov = cs.overflowY;
              if ((ov === 'auto' || ov === 'scroll') && el.scrollHeight > el.clientHeight) {
                el.scrollBy({ top: ${remaining}, behavior: 'instant' });
                return true;
              }
              el = el.parentElement;
            }
            window.scrollBy({ top: ${remaining}, behavior: 'instant' });
            return true;
          })()`,
          returnByValue: true,
        });
        await sleep(150);
      }
      return `Scrolled ${input.direction} by ${Math.abs(totalDelta)}px`;
    }
    case "run_javascript": {
      await ensureAttached(tabId);
      // Hard 10-second cap on evaluated JS — without it, an infinite
      // loop (`while(true){}`) or a never-resolving promise
      // (`new Promise(()=>{})`) wedges the whole tool pipeline for the
      // CDP default (~30 s) and blocks every subsequent action. On
      // timeout we call Runtime.terminateExecution so the next tool
      // call starts on a clean context.
      const RUN_JS_TIMEOUT = 10_000;
      const evalPromise = cdp(tabId, "Runtime.evaluate", {
        expression: input.code,
        returnByValue: true,
        awaitPromise: true,
      });
      const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => resolve({ __timeout: true }), RUN_JS_TIMEOUT);
      });
      const r = await Promise.race([evalPromise, timeoutPromise]);
      if (r?.__timeout) {
        try { await cdp(tabId, "Runtime.terminateExecution", {}); } catch {}
        return `Error: run_javascript timed out after ${RUN_JS_TIMEOUT}ms (execution terminated).`;
      }
      if (r.exceptionDetails) return `Error: ${r.exceptionDetails.text || JSON.stringify(r.exceptionDetails)}`;
      const v = r.result;
      if (v.type === "undefined") return "undefined";
      return v.value !== undefined ? JSON.stringify(v.value) : v.description || String(v);
    }
    case "wait_for": {
      const timeout = Math.min(input.timeout || 5000, 10000);
      if (input.text) {
        const r = await cdp(tabId, "Runtime.evaluate", {
          expression: `new Promise(res => {
            const check = () => document.body.innerText.includes(${JSON.stringify(input.text)});
            if (check()) return res(true);
            const o = new MutationObserver(() => { if (check()) { o.disconnect(); res(true); } });
            o.observe(document.body, { childList: true, subtree: true, characterData: true });
            setTimeout(() => { o.disconnect(); res(false); }, ${timeout});
          })`, awaitPromise: true, returnByValue: true,
        });
        return r.result?.value ? `Text "${input.text}" appeared` : `Timeout: text not seen in ${timeout}ms`;
      }
      if (input.selector) {
        const r = await cdp(tabId, "Runtime.evaluate", {
          expression: `new Promise(res => {
            if (document.querySelector(${JSON.stringify(input.selector)})) return res(true);
            const o = new MutationObserver(() => { if (document.querySelector(${JSON.stringify(input.selector)})) { o.disconnect(); res(true); } });
            o.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => { o.disconnect(); res(false); }, ${timeout});
          })`, awaitPromise: true, returnByValue: true,
        });
        return r.result?.value ? `Selector "${input.selector}" appeared` : `Timeout`;
      }
      await waitForDomStable(tabId, timeout);
      return "DOM stabilized";
    }
    case "hover": {
      const [x, y] = await resolveClickTarget(tabId, input);
      if (x == null) return "Element not found";
      await ensureAttached(tabId);
      rippleAt(tabId, x, y);
      await dispatchMouse(tabId, "mouseMoved", x, y);
      await sleep(400);
      return `Hovered at (${x}, ${y})`;
    }
    case "select_option": {
      const resp = await sendContentMessage(tabId, { type: "setFormValue", ref: input.ref, value: input.value });
      if (resp?.result?.error) return `Error: ${resp.result.error}`;
      return `Selected "${input.value}" in ${input.ref}`;
    }
    case "list_tabs": {
      const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
      return tabs.map((t) => `[${t.id}]${t.active ? " *" : ""} ${t.title} — ${t.url}`).join("\n");
    }
    case "tabs_overview": {
      // Cross-tab snapshot. For each normal (http/https) tab we ask the
      // content script for its Readability text in parallel, keep the
      // first 300 chars. Tabs on chrome://, file://, the Web Store, or
      // discarded pages have no content script — we include them with
      // an "(no content accessible)" marker so Claude still knows they
      // exist.
      const cap = Math.min(Math.max(input?.max_tabs || 10, 1), 15);
      const all = await chrome.tabs.query({ lastFocusedWindow: true });
      const tabs = all.slice(0, cap);

      async function snippetFor(tab) {
        if (!/^https?:\/\//.test(tab.url || "")) return null;
        // Fast path: if the page-text cache already has this tab, use it.
        const cached = pageTextCache.get(tab.id);
        if (cached && cached.url === tab.url && Date.now() - cached.ts < PAGE_TEXT_TTL_MS) {
          return cached.text;
        }
        try {
          const resp = await Promise.race([
            sendContentMessage(tab.id, { type: "getPageText" }),
            new Promise((r) => setTimeout(() => r(null), 1500)),
          ]);
          if (!resp?.result) return null;
          const d = JSON.parse(resp.result);
          // Opportunistic cache-fill — the next get_page_text on this
          // tab gets a cache hit for free.
          pageTextCache.set(tab.id, {
            url: d.url || tab.url,
            title: d.title || tab.title,
            text: d.text || "",
            ts: Date.now(),
          });
          return d.text || "";
        } catch { return null; }
      }

      const snippets = await Promise.all(tabs.map(snippetFor));
      const lines = tabs.map((t, i) => {
        const header = `[${t.id}]${t.active ? " *" : ""} ${t.title || "(untitled)"}\n    ${t.url}`;
        const snip = snippets[i];
        if (snip == null) return header + "\n    (no content accessible — chrome://, file://, or discarded)";
        const trimmed = snip.trim().replace(/\s+/g, " ").slice(0, 300);
        return header + (trimmed ? `\n    ${trimmed}${snip.length > 300 ? "…" : ""}` : "\n    (empty)");
      });
      const truncatedNote = all.length > cap ? `\n\n(${all.length - cap} more tabs not shown — raise max_tabs to include them)` : "";
      return `Overview of ${tabs.length} tab(s):\n\n${lines.join("\n\n")}${truncatedNote}`;
    }
    case "switch_tab": {
      await chrome.tabs.update(input.tabId, { active: true });
      const t = await chrome.tabs.get(input.tabId);
      retargetTaskTab(t.id);
      return `Switched to tab ${t.id}`;
    }

    case "tabs_close": {
      // Accept either { tabIds: [...] } or { tabId: n }; default to the
      // current contextual tab when neither is provided.
      const raw = Array.isArray(input.tabIds) && input.tabIds.length
        ? input.tabIds
        : (input.tabId != null ? [input.tabId] : [tabId]);
      const ids = raw.map(Number).filter(Number.isFinite);
      if (!ids.length) return "Error: no tab IDs to close";
      // Safety rail: never kill the tab a live task is still driving —
      // the next tool call would land on a null tabId and CDP would
      // throw a confusing error trail. Let the task finish first.
      if (activeTask?.running && activeTask.tabId && ids.includes(activeTask.tabId)) {
        return `Error: refused to close tab ${activeTask.tabId} — it's the active task's tab. Finish the task first.`;
      }
      try {
        await chrome.tabs.remove(ids);
        return `Closed ${ids.length} tab(s): [${ids.join(", ")}]`;
      } catch (e) {
        return `Error closing tabs: ${e.message}`;
      }
    }

    case "file_upload": {
      // Path denylist lives in src/lib/file-upload-denylist.ts — 14
      // patterns, 35 unit tests guarding both must-block and must-allow
      // cases. Keeps this handler focused on CDP orchestration.
      const files = Array.isArray(input.files) && input.files.length
        ? input.files.slice()
        : (input.file ? [input.file] : []);
      if (!files.length) return "Error: `files` (array of absolute paths) is required";
      for (const f of files) {
        if (typeof f !== "string" || !f.trim()) {
          return "Error: every file path must be a non-empty string";
        }
        const refusal = refusalMessage(f);
        if (refusal) return refusal;
      }

      // Resolve the target <input type=file>. Prefer `ref` (content script
      // confirms it's actually a file input); fall back to raw CSS selector
      // when the caller knows what they're doing.
      await ensureAttached(tabId);
      invalidatePageTextCache(tabId);
      let selector = input.selector;
      let markToken = null;
      if (!selector && input.ref) {
        const resp = await sendContentMessage(tabId, { type: "markRefForUpload", ref: input.ref });
        const r = resp?.result;
        if (r?.error) return `Error: ${r.error}`;
        selector = r?.selector;
        markToken = r?.token;
      }
      if (!selector) return "Error: `ref` or `selector` is required to locate the <input type=\"file\">";

      try {
        const doc = await cdp(tabId, "DOM.getDocument", { depth: 1 });
        const rootId = doc?.root?.nodeId;
        if (!rootId) return "Error: could not get DOM root";
        const q = await cdp(tabId, "DOM.querySelector", { nodeId: rootId, selector });
        if (!q?.nodeId) return `Error: no element matched selector "${selector}"`;
        await cdp(tabId, "DOM.setFileInputFiles", { nodeId: q.nodeId, files });
        const names = files.map((f) => f.split(/[\\/]/).pop()).join(", ");
        return `Uploaded ${files.length} file(s) to ${selector}: ${names}`;
      } catch (e) {
        return `Error uploading: ${e.message}`;
      } finally {
        // Always clear the marker attribute so we don't leave DOM litter
        // behind, even if the CDP call threw.
        if (markToken) {
          try { await sendContentMessage(tabId, { type: "clearUploadMark", token: markToken }); } catch {}
        }
      }
    }

    default:
      return `Unknown tool: ${name}`;
  }
}
