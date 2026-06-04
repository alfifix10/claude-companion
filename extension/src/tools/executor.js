/**
 * Single dispatch point for every browser tool.
 * Both the MCP server (Claude Code side) and local Arabic shortcuts route
 * through here, so tool behavior is consistent everywhere.
 */

import {
  cdp, ensureAttached, ensureDomain, mouseClick, mouseDrag, dispatchMouse, waitForDomStable,
  takeScreenshot, sendContentMessage, resolveRefCoords, resolveClickTarget,
  dialogNote, getActiveTab, modifiersBitmask,
} from "../core/cdp.js";
import { sleep, parseKeyCombo } from "../core/utils.js";
import { activeTask, broadcastToPanels, consoleMessages, networkRequests, pageErrors } from "../core/state.js";
import { refusalMessage } from "../lib/file-upload-denylist.js";
import { fenceUntrusted } from "../lib/untrusted-fence.js";

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

// Vision fallback escalation. Self-healing refs (content.js) recover most
// stale refs; when an ACTION still can't resolve its target, the element is
// genuinely gone or never had a name, and re-reading often hands back the same
// dead ref. After two such misses in a row we tell Claude to take a labelled
// screenshot — the Set-of-Mark image locates controls that the DOM tree can't.
// Counter is per-tab; read_page clears it (a fresh read is a clean slate).
const refFailStreak = new Map(); // tabId → consecutive ref-resolution failures
function noteRefMiss(tabId) {
  const n = (refFailStreak.get(tabId) || 0) + 1;
  refFailStreak.set(tabId, n);
  return n >= 2
    ? " — تعذّر تحديد العنصر مرّتين؛ استدعِ screenshot مع labels=true لتحديده بصريًّا."
    : "";
}
function clearRefMiss(tabId) { refFailStreak.delete(tabId); }

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

// Wait for a tab to finish loading after a navigation, then return its SETTLED
// state. Fixes the stale-read trap: chrome.tabs.get can return the PRE-nav
// url/title (or the old page's "complete") before the new page commits — which
// made navigate/tabs_context report the wrong location and cost the agent
// extra screenshots to figure out where it actually landed. Bounded so a
// never-finishing page (infinite spinner / long-poll) can't hang the tool.
async function waitForTabComplete(tabId, timeoutMs = 8000) {
  // Let the navigation commit first (status flips complete→loading) so we
  // don't immediately read the OLD page's "complete".
  await sleep(300);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return null; }
    if (tab.status === "complete") return tab;
    await sleep(150);
  }
  try { return await chrome.tabs.get(tabId); } catch { return null; }
}

// CROSS-FRAME clickable enumeration via CDP (chrome.debugger). content.js sees
// only the top frame (same-origin); the debugger can read EVERY frame including
// CROSS-ORIGIN iframes (Google account chooser, Stripe card fields, captchas).
// We flatten the whole document (pierce shadow DOM + iframes), pick clickable
// nodes, and resolve each to TOP-PAGE coordinates via DOM.getBoxModel — so the
// agent can click them precisely by (x,y). [Phase 1: cross-origin iframes]
async function enumerateClickablesAllFrames(tabId, max = 40) {
  const attr = (n, key) => {
    const a = n.attributes || [];
    for (let i = 0; i < a.length; i += 2) if (a[i] === key) return a[i + 1];
    return null;
  };
  const TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"]);
  const ROLES = new Set(["button", "link", "textbox", "checkbox", "radio", "tab",
    "menuitem", "option", "switch", "combobox", "searchbox"]);
  let doc;
  try {
    await ensureDomain(tabId, "DOM");
    // getDocument(pierce) is the supported API (getFlattenedDocument is
    // deprecated/removed in current Chrome). pierce:true descends into shadow
    // roots AND iframe content documents — including cross-origin (OOPIF).
    doc = await cdp(tabId, "DOM.getDocument", { depth: -1, pierce: true });
  } catch (e) {
    return { items: [], diag: "getDocument failed: " + (e?.message || e) };
  }
  const cand = [];
  let totalNodes = 0;
  // Walk the WHOLE pierced tree (shadow roots + iframe documents). We collect
  // top-frame elements too on purpose: CDP catches controls content.js's
  // Set-of-Mark can't (e.g. opacity:0 radio inputs styled as a toolbar, as in
  // Excalidraw). Duplicates of already-labelled controls are removed by the
  // coordinate de-dupe in the caller, so what's left is the genuine extra:
  // cross-origin iframe controls + anything content.js missed.
  (function walk(n) {
    if (!n || cand.length >= 300) return;
    totalNodes++;
    if (n.nodeType === 1) {
      const tag = String(n.nodeName || "").toUpperCase();
      const role = attr(n, "role");
      const ti = attr(n, "tabindex");
      if ((TAGS.has(tag) || (role && ROLES.has(role)) || (ti && ti !== "-1"))
          && !(tag === "INPUT" && String(attr(n, "type") || "").toLowerCase() === "hidden")) {
        cand.push({
          nodeId: n.nodeId,
          role: role || tag.toLowerCase(),
          name: (attr(n, "aria-label") || attr(n, "value") || attr(n, "placeholder")
            || attr(n, "title") || attr(n, "alt") || "").trim(),
        });
      }
    }
    if (n.children) for (const c of n.children) walk(c);
    if (n.shadowRoots) for (const c of n.shadowRoots) walk(c);
    if (n.contentDocument) walk(n.contentDocument);
  })(doc?.root);
  // Viewport bounds so we only surface ON-SCREEN controls (the cross-frame
  // candidate list includes off-screen skip-links and below-fold content).
  let vw = 1e9, vh = 1e9;
  try {
    const m = await cdp(tabId, "Page.getLayoutMetrics", {});
    vw = m?.cssLayoutViewport?.clientWidth || m?.layoutViewport?.clientWidth || vw;
    vh = m?.cssLayoutViewport?.clientHeight || m?.layoutViewport?.clientHeight || vh;
  } catch {}
  const items = [];
  for (const c of cand) {
    if (items.length >= max) break;
    let bm;
    try { bm = await cdp(tabId, "DOM.getBoxModel", { nodeId: c.nodeId }); } catch { continue; }
    const q = bm?.model?.content;
    if (!q || q.length < 8) continue;
    if ((bm.model.width || 0) < 6 || (bm.model.height || 0) < 6) continue;
    const x = Math.round((q[0] + q[2] + q[4] + q[6]) / 4);
    const y = Math.round((q[1] + q[3] + q[5] + q[7]) / 4);
    if (x < 0 || y < 0 || x > vw || y > vh) continue; // off-screen — skip
    // Trim verbose ARIA names ("الحساب، الصف رقم 1 من أصل 3…" → "الحساب").
    const name = c.name.split(/[،,\n]/)[0].trim().slice(0, 50);
    items.push({ role: c.role, name, x, y });
  }
  return { items, diag: `nodes=${totalNodes} candidates=${cand.length} onscreen=${items.length}` };
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
      let tab = await chrome.tabs.get(tabId);
      // If a navigation is still in flight, wait briefly so we report the
      // CURRENT page, not a stale loading url/title. Bounded.
      if (tab.status === "loading") {
        const settled = await waitForTabComplete(tabId, 4000);
        if (settled) tab = settled;
      }
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
      if (input.direction === "back" || input.direction === "forward") {
        await cdp(tabId, input.direction === "back" ? "Page.goBack" : "Page.goForward", {});
        const t = await waitForTabComplete(tabId);
        schedulePageTextPrefetch(tabId);
        const word = input.direction === "back" ? "back" : "forward";
        return t ? `Went ${word} → ${t.url}\nTitle: ${t.title || ""}` : `Went ${word}`;
      }
      let url = input.url;
      if (!url) return "url or direction required";
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;
      await chrome.tabs.update(tabId, { url });
      // Wait for the page to actually settle, then report the FINAL url +
      // title (captures redirects, e.g. authuser → u/0). The agent now knows
      // where it landed without a separate tabs_context/screenshot round-trip.
      const t = await waitForTabComplete(tabId);
      schedulePageTextPrefetch(tabId);
      return t ? `Navigated to ${t.url}\nTitle: ${t.title || ""}` : `Navigated to ${url}`;
    }
    case "read_page": {
      clearRefMiss(tabId); // fresh read — reset the vision-fallback streak
      const diff = input.full !== true;
      const resp = await sendContentMessage(tabId, {
        type: "generateAccessibilityTree",
        options: { filter: input.filter || "interactive", max_chars: 12000, diff },
      });
      const tab = await chrome.tabs.get(tabId);
      if (resp?.mode === "unchanged") return `Page unchanged since last read_page — refs still valid.`;
      const tag = resp?.mode === "diff" ? " (diff)" : "";
      return `Page${tag}: ${tab.title}\nURL: ${tab.url}\n\n${fenceUntrusted(resp?.result || "(error reading page)")}`;
    }
    case "get_page_text": {
      const tab = await chrome.tabs.get(tabId);
      const cached = pageTextCache.get(tabId);
      if (cached
          && cached.url === tab.url
          && Date.now() - cached.ts < PAGE_TEXT_TTL_MS) {
        return `Title: ${cached.title}\nURL: ${cached.url}\n\n${fenceUntrusted(cached.text.slice(0, 15000))}`;
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
        return `Title: ${d.title}\nURL: ${d.url}\n\n${fenceUntrusted((d.text || "").slice(0, 15000))}`;
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
    case "act": {
      // Compound action: target + scroll-into-view + click/fill in ONE call,
      // so Claude doesn't need read_page → extract ref → click as three
      // separate turns. Target by `ref` (self-healing) OR by `text` (ranked
      // find picks the closest match). Delegates to the existing click /
      // form_input handlers so all their hardening — JS click fallback, delta
      // trailer, React-safe value set — applies unchanged.
      let ref = input.ref;
      if (!ref && input.text) {
        const resp = await sendContentMessage(tabId, { type: "findElements", query: input.text });
        const results = resp?.result || [];
        if (!results.length) return `act: no element matching "${input.text}". Call read_page to see what's available.${noteRefMiss(tabId)}`;
        ref = results[0].ref; // top-ranked match — see find() relevance scoring
      }
      if (!ref) return "act: provide either 'ref' or 'text' to target an element.";
      await sendContentMessage(tabId, { type: "scrollToRef", ref });
      const action = String(input.action || "click").toLowerCase();
      if (action === "click") return await executeTool("click", { ref }, tabId);
      if (action === "fill" || action === "type") {
        if (input.value == null) return "act: 'value' is required for a fill action.";
        return await executeTool("form_input", { ref, value: String(input.value) }, tabId);
      }
      return `act: unknown action "${action}". Use "click" or "fill".`;
    }
    case "fill_form": {
      // Fill MANY fields in one call (login/signup/checkout) instead of one
      // act/form_input round-trip per field. Each field is found by its label
      // (ranked find) or a ref, then filled via the existing form_input path
      // (React-safe setNativeValue). A missing field is skipped + reported, not
      // fatal, so the rest still fill.
      const fields = Array.isArray(input.fields) ? input.fields : [];
      if (!fields.length) return "fill_form: provide a 'fields' array of { field, value }.";
      const out = [];
      let ok = 0;
      for (const f of fields) {
        const label = f?.field;
        const value = String(f?.value ?? "");
        if (!label && !f?.ref) { out.push("✗ (missing field name)"); continue; }
        let ref = f?.ref;
        if (!ref) {
          const resp = await sendContentMessage(tabId, { type: "findElements", query: label });
          const hits = resp?.result || [];
          if (!hits.length) { out.push(`✗ "${label}": not found`); continue; }
          ref = hits[0].ref;
        }
        const r = await executeTool("form_input", { ref, value }, tabId);
        if (typeof r === "string" && r.toLowerCase().startsWith("error")) {
          out.push(`✗ "${label || ref}": ${r}`);
        } else {
          ok++;
          out.push(`✓ "${label || ref}" = "${value.slice(0, 30)}${value.length > 30 ? "…" : ""}"`);
        }
      }
      return `Filled ${ok}/${fields.length} field(s):\n${out.join("\n")}`;
    }
    case "click": {
      const [x, y] = await resolveClickTarget(tabId, input);
      if (x == null) return "Element not found (ref may have expired — call read_page again)" + noteRefMiss(tabId);
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
        // Cross-frame clickables (incl. cross-origin iframes) via CDP — the
        // top-frame content.js labels above are blind to these.
        const cf = input.labels
          ? await enumerateClickablesAllFrames(tabId, 40).catch((e) => ({ items: [], diag: "threw: " + (e?.message || e) }))
          : { items: [], diag: "" };
        const hasTop = labels && Object.keys(labels).length;
        // De-dupe: drop cross-frame items that coincide (within ~12px) with a
        // top-frame label already listed above, so the agent sees each control
        // once.
        const topCoords = hasTop ? Object.values(labels) : [];
        const crossFrame = (cf.items || []).filter((c) =>
          !topCoords.some((m) => Math.abs(m.x - c.x) < 12 && Math.abs(m.y - c.y) < 12));
        if (hasTop || crossFrame.length) {
          let lines = "";
          if (hasTop) {
            lines += Object.entries(labels)
              .map(([n, m]) => `  ${n}: ${m.role}${m.name ? ` "${m.name}"` : ""} @(${m.x},${m.y}) ref=${m.ref}`)
              .join("\n");
          }
          if (crossFrame.length) {
            lines += (lines ? "\n\n" : "")
              + "Additional clickable elements (cross-origin iframes + controls not labeled above — click by (x,y)):\n"
              + crossFrame.map((c) => `  • ${c.role}${c.name ? ` "${c.name}"` : ""} @(${c.x},${c.y})`).join("\n");
          }
          return { type: "screenshot_labeled", base64, mediaType, labels: labels || {},
            text: `Screenshot interactive elements:\n${lines}\n\nTo act: "click ref=<value>" (top-frame) or click by coordinates (x,y).` };
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
      return `Overview of ${tabs.length} tab(s):\n\n${fenceUntrusted(lines.join("\n\n"))}${truncatedNote}`;
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

    // ───────────────────────────────────────────────────────────────
    // DevTools (read-only browser internals)
    // ───────────────────────────────────────────────────────────────

    case "read_console_messages": {
      // Pull the rolling buffer of console messages collected by the
      // background CDP listener. Ensure the tab is attached so future
      // messages get captured even if the user just opened it.
      await ensureAttached(tabId);
      const all = consoleMessages.get(tabId) || [];
      const wantLevel = typeof input.level === "string" ? input.level.toLowerCase() : "";
      const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(500, input.limit)) : 100;
      let filtered = all;
      if (wantLevel) {
        filtered = all.filter((m) => String(m.level || "").toLowerCase() === wantLevel);
      }
      // Most-recent N — slice from the end.
      const slice = filtered.slice(-limit);
      if (slice.length === 0) {
        return wantLevel
          ? `No "${wantLevel}" console messages on this tab.`
          : "No console messages captured. Note: messages emitted before the extension attached are not retroactive.";
      }
      const lines = slice.map((m) => {
        const ts = new Date(m.timestamp).toISOString().slice(11, 19);
        const where = m.url ? ` (${m.url})` : "";
        return `[${ts}] [${m.level}] ${m.text}${where}`;
      });
      return `${slice.length} message(s) (newest last):\n` + lines.join("\n");
    }

    case "read_network_requests": {
      await ensureAttached(tabId);
      const all = networkRequests.get(tabId) || [];
      const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(200, input.limit)) : 50;
      const urlFilter = typeof input.url_contains === "string" ? input.url_contains : "";
      const methodFilter = typeof input.method === "string" ? input.method.toUpperCase() : "";
      const statusMin = Number.isFinite(input.status_min) ? input.status_min : 0;
      const statusMax = Number.isFinite(input.status_max) ? input.status_max : 999;
      let filtered = all;
      if (urlFilter) filtered = filtered.filter((r) => (r.url || "").includes(urlFilter));
      if (methodFilter) filtered = filtered.filter((r) => (r.method || "").toUpperCase() === methodFilter);
      filtered = filtered.filter((r) => {
        const s = Number.isFinite(r.status) ? r.status : 0;
        return s >= statusMin && s <= statusMax;
      });
      const slice = filtered.slice(-limit);
      if (slice.length === 0) return "No network requests match the filter.";
      const lines = slice.map((r) => {
        const ts = new Date(r.timestamp).toISOString().slice(11, 19);
        const status = r.status > 0 ? r.status : "—";
        return `[${ts}] ${r.method || "GET"} ${status} ${r.type || ""} ${r.url}`;
      });
      return `${slice.length} request(s) (newest last):\n` + lines.join("\n");
    }

    case "read_page_errors": {
      await ensureAttached(tabId);
      const all = pageErrors.get(tabId) || [];
      const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(100, input.limit)) : 50;
      const slice = all.slice(-limit);
      if (slice.length === 0) {
        return "No uncaught exceptions captured on this tab.";
      }
      const lines = slice.map((e) => {
        const ts = new Date(e.timestamp).toISOString().slice(11, 19);
        const loc = e.url ? ` ${e.url}${e.lineNumber != null ? `:${e.lineNumber}` : ""}` : "";
        return `[${ts}] ${e.message}${loc}`;
      });
      return `${slice.length} error(s) (newest last):\n` + lines.join("\n");
    }

    case "inspect_element": {
      await ensureAttached(tabId);
      // Resolve the target — by ref, selector, or coordinate. We only
      // need a CSS selector to evaluate against, so the resolution
      // path collapses everything down to that.
      let selector = typeof input.selector === "string" ? input.selector : "";
      if (!selector && input.ref) {
        const resp = await sendContentMessage(tabId, { type: "selectorForRef", ref: input.ref });
        const r = resp?.result;
        if (r?.error) return `Error: ${r.error}`;
        selector = r?.selector || "";
      }
      if (!selector && Array.isArray(input.coordinate) && input.coordinate.length === 2) {
        // Pick the topmost element at (x, y) and ask the page for a
        // CSS selector path. Rough but adequate for inspection.
        const [x, y] = input.coordinate;
        const r = await cdp(tabId, "Runtime.evaluate", {
          expression: `(() => {
            const el = document.elementFromPoint(${x}, ${y});
            if (!el) return null;
            const path = [];
            let cur = el;
            while (cur && cur.nodeType === 1 && path.length < 5) {
              let n = cur.tagName.toLowerCase();
              if (cur.id) { n += '#' + cur.id; path.unshift(n); break; }
              if (cur.className && typeof cur.className === 'string') {
                n += '.' + cur.className.trim().split(/\\s+/).slice(0,2).join('.');
              }
              path.unshift(n);
              cur = cur.parentElement;
            }
            return path.join(' > ');
          })()`,
          returnByValue: true,
        });
        selector = r?.result?.value || "";
      }
      if (!selector) return "Error: provide ref, selector, or coordinate.";

      // Build a single Runtime.evaluate that returns everything we want
      // in one round trip — much cheaper than 5 separate CDP calls.
      const expr = `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false, error: 'No element matched ' + ${JSON.stringify(selector)} };
        const cs = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        // Pick a curated subset of computed styles — full dump is
        // hundreds of properties and almost always noise.
        const wantedStyles = [
          'display','position','visibility','opacity','color','backgroundColor',
          'fontSize','fontWeight','lineHeight','width','height','margin','padding',
          'border','zIndex','overflow','cursor','pointerEvents'
        ];
        const styles = {};
        for (const k of wantedStyles) styles[k] = cs.getPropertyValue(k.replace(/[A-Z]/g, m => '-' + m.toLowerCase()));
        const attrs = {};
        for (const a of el.attributes) attrs[a.name] = a.value;
        return {
          ok: true,
          tagName: el.tagName.toLowerCase(),
          id: el.id || null,
          classes: (el.className && typeof el.className === 'string') ? el.className.split(/\\s+/).filter(Boolean) : [],
          attrs,
          textPreview: (el.textContent || '').trim().slice(0, 200),
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
          styles,
          isVisible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0,
        };
      })()`;
      const res = await cdp(tabId, "Runtime.evaluate", { expression: expr, returnByValue: true });
      const v = res?.result?.value;
      if (!v) return "Error: failed to inspect element.";
      if (v.ok === false) return `Error: ${v.error}`;
      return JSON.stringify(v, null, 2);
    }

    case "read_storage": {
      // Pro Mode gate. localStorage / sessionStorage on a logged-in
      // tab routinely contain auth tokens — exposing reads in default
      // mode would let the agent harvest them silently. With Pro Mode
      // the user has explicitly accepted that risk surface.
      const proMode = await checkProModeEnabled();
      if (!proMode) {
        return "Error: Pro Mode required (storage often contains auth tokens). Enable in extension settings.";
      }
      await ensureAttached(tabId);
      const area = String(input.area || "local").toLowerCase();
      if (area !== "local" && area !== "session") {
        return 'Error: area must be "local" or "session".';
      }
      const target = area === "session" ? "sessionStorage" : "localStorage";
      const key = typeof input.key === "string" ? input.key : "";
      const expr = key
        ? `(() => { const v = window.${target}.getItem(${JSON.stringify(key)}); return { ok:true, key: ${JSON.stringify(key)}, value: v }; })()`
        : `(() => {
            const out = {};
            for (let i = 0; i < window.${target}.length; i++) {
              const k = window.${target}.key(i);
              if (k != null) out[k] = window.${target}.getItem(k);
            }
            return { ok: true, area: ${JSON.stringify(area)}, count: Object.keys(out).length, entries: out };
          })()`;
      const res = await cdp(tabId, "Runtime.evaluate", { expression: expr, returnByValue: true });
      const v = res?.result?.value;
      if (!v) return "Error: failed to read storage.";
      return JSON.stringify(v, null, 2);
    }

    case "clear_injected_scripts": {
      // Recovery from "agent left auto-scrollers running" scenarios.
      // The script mass-clears intervals + timeouts in a wide id range
      // (browsers assign sequential numeric ids), then deletes window
      // properties matching common auto-loop names OR a custom pattern.
      // Optional page reload nukes any closures we couldn't reach.
      await ensureAttached(tabId);
      const customPattern = typeof input.pattern === "string" && input.pattern
        ? input.pattern
        : "";
      const reload = input.reload === true;
      // Default pattern catches the agent's typical injected globals:
      //   • TK1, TK4, TK4_2 (TikTok scrapers)
      //   • __autoLoop, __autoStop (control flags)
      //   • __tk_v3_snapshot (data caches)
      //   • Any name starting with __ or autoLoop / autoScroll
      const patternLiteral = customPattern
        ? JSON.stringify(customPattern)
        : `"^(?:__|TK\\\\d+|tk\\\\d+|autoLoop|autoScroll|autoDrain)"`;
      const expr = `(() => {
        const removed = [];
        const errs = [];
        let intervalsKilled = 0;

        // 1. Clear interval/timeout ids in a wide range. Browsers
        //    assign sequential 32-bit ints; 100k covers any realistic
        //    session. Ignored ids no-op silently.
        const MAX = 100000;
        for (let i = 1; i < MAX; i++) {
          try { clearInterval(i); } catch {}
          try { clearTimeout(i); } catch {}
        }
        intervalsKilled = MAX;

        // 2. Delete matching window properties.
        let re;
        try { re = new RegExp(${patternLiteral}, 'i'); }
        catch (e) { errs.push('bad pattern: ' + e.message); re = null; }
        if (re) {
          for (const key of Object.keys(window)) {
            if (re.test(key)) {
              try {
                delete window[key];
                removed.push(key);
              } catch (e) {
                errs.push(key + ': ' + e.message);
              }
            }
          }
        }

        return { removed, removedCount: removed.length, intervalsCleared: intervalsKilled, errors: errs };
      })()`;
      const r = await cdp(tabId, "Runtime.evaluate", { expression: expr, returnByValue: true });
      const v = r?.result?.value || { removed: [], removedCount: 0, intervalsCleared: 0, errors: [] };
      let summary = `Cleared ${v.intervalsCleared} interval/timeout ids, removed ${v.removedCount} window propert${v.removedCount === 1 ? "y" : "ies"}.`;
      if (v.removed.length) summary += `\nRemoved: ${v.removed.join(", ")}`;
      if (v.errors?.length) summary += `\nErrors: ${v.errors.join("; ")}`;
      if (reload) {
        try {
          await cdp(tabId, "Page.reload", { ignoreCache: false });
          summary += "\nPage reloaded — any remaining closures are now gone.";
        } catch (e) {
          summary += `\nReload failed: ${e.message}`;
        }
      }
      return summary;
    }

    case "read_performance": {
      await ensureAttached(tabId);
      const expr = `(() => {
        const t = performance.timing || {};
        const nav = (performance.getEntriesByType && performance.getEntriesByType('navigation')[0]) || null;
        const paints = (performance.getEntriesByType && performance.getEntriesByType('paint')) || [];
        const mem = performance.memory ? {
          usedJSHeapSize: performance.memory.usedJSHeapSize,
          totalJSHeapSize: performance.memory.totalJSHeapSize,
          jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
        } : null;
        const out = {
          // ms since navigationStart (legacy timing API — widely supported)
          domContentLoaded: t.domContentLoadedEventEnd && t.navigationStart
            ? t.domContentLoadedEventEnd - t.navigationStart : null,
          loadComplete: t.loadEventEnd && t.navigationStart
            ? t.loadEventEnd - t.navigationStart : null,
          // Modern navigation entry — more accurate when present
          ttfb: nav && nav.responseStart ? Math.round(nav.responseStart) : null,
          domInteractive: nav && nav.domInteractive ? Math.round(nav.domInteractive) : null,
          // Paint timings — null when page hasn't painted yet
          firstPaint: (paints.find(p => p.name === 'first-paint') || {}).startTime || null,
          firstContentfulPaint: (paints.find(p => p.name === 'first-contentful-paint') || {}).startTime || null,
          memory: mem,
          url: location.href,
        };
        // Round float timings for readability
        for (const k of ['firstPaint','firstContentfulPaint']) {
          if (typeof out[k] === 'number') out[k] = Math.round(out[k]);
        }
        return out;
      })()`;
      const res = await cdp(tabId, "Runtime.evaluate", { expression: expr, returnByValue: true });
      const v = res?.result?.value;
      if (!v) return "Error: failed to read performance.";
      return JSON.stringify(v, null, 2);
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// Pro Mode gate (extension side). chrome.storage.local is the LIVE source of
// truth while the extension runs; the host's user-data.json is only a
// best-effort backup mirror of it (see core/user-data.js). The host-side
// tools (mcp-server's requireProMode) read that mirror instead, because they
// have no access to chrome.storage from the Node context. Both read paths are
// intentional — they live in different process contexts. This one reads
// storage directly (no native round-trip). Fails closed on any error.
async function checkProModeEnabled() {
  try {
    const stored = await chrome.storage.local.get("proMode");
    return stored?.proMode === true;
  } catch {
    return false;
  }
}
