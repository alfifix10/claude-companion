/**
 * Single dispatch point for every browser tool.
 * Both the MCP server (Claude Code side) and local Arabic shortcuts route
 * through here, so tool behavior is consistent everywhere.
 */

import {
  cdp, ensureAttached, mouseClick, dispatchMouse, waitForDomStable,
  takeScreenshot, sendContentMessage, resolveRefCoords, resolveClickTarget,
  dialogNote, getActiveTab,
} from "../core/cdp.js";
import { sleep, parseKeyCombo } from "../core/utils.js";
import { activeTask, broadcastToPanels } from "../core/state.js";

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
// For very long text (>300 chars) we fall back to instant insertText —
// Claude typically means "paste this" for long content, and a 300-char
// string at 90 ms average is already ~27 s of waiting.
async function humanType(tabId, text) {
  if (!text) return;
  if (text.length > 300) {
    await cdp(tabId, "Input.insertText", { text });
    return;
  }
  let untilPause = 8 + Math.floor(Math.random() * 7); // next pause in 8–14 chars
  for (let i = 0; i < text.length; i++) {
    await cdp(tabId, "Input.insertText", { text: text[i] });
    const base = 60 + Math.random() * 80;
    let extra = 0;
    if (--untilPause <= 0) {
      extra = 200 + Math.random() * 250;
      untilPause = 8 + Math.floor(Math.random() * 7);
    }
    await sleep(base + extra);
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
      const t = await chrome.tabs.create({ url: input.url, active: input.active !== false });
      retargetTaskTab(t.id);
      return `Opened tab ${t.id}: ${t.url}`;
    }
    case "navigate": {
      if (input.direction === "back") { await cdp(tabId, "Page.goBack", {}); return "Went back"; }
      if (input.direction === "forward") { await cdp(tabId, "Page.goForward", {}); return "Went forward"; }
      let url = input.url;
      if (!url) return "url or direction required";
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;
      await chrome.tabs.update(tabId, { url });
      await sleep(1200);
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
      const resp = await sendContentMessage(tabId, { type: "getPageText" });
      if (!resp?.result) return "Error extracting text";
      try {
        const d = JSON.parse(resp.result);
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
      const urlBefore = (await cdp(tabId, "Runtime.evaluate", { expression: "location.href", returnByValue: true }))?.result?.value;
      rippleAt(tabId, x, y);
      await mouseClick(tabId, x, y);
      await waitForDomStable(tabId);
      try {
        const urlAfter = (await cdp(tabId, "Runtime.evaluate", { expression: "location.href", returnByValue: true }))?.result?.value;
        if (urlAfter && urlAfter !== urlBefore) return `Clicked → navigated to ${urlAfter}.${dialogNote(tabId)}`;
      } catch {}
      return `Clicked at (${x}, ${y}).${dialogNote(tabId)}`;
    }
    case "type_text": {
      await ensureAttached(tabId);
      await humanType(tabId, input.text);
      return `Typed "${input.text.slice(0, 50)}${input.text.length > 50 ? "..." : ""}"`;
    }
    case "press_key": {
      await ensureAttached(tabId);
      const { key, modifiers } = parseKeyCombo(input.key);
      const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
      await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers });
      await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
      return `Pressed ${input.key}`;
    }
    case "form_input": {
      const resp = await sendContentMessage(tabId, { type: "setFormValue", ref: input.ref, value: input.value });
      if (resp?.result?.error) return `Error: ${resp.result.error}`;
      return `Set ${input.ref} = "${input.value}"`;
    }
    case "screenshot": {
      await ensureAttached(tabId);
      const { base64 } = await takeScreenshot(tabId);
      return { type: "screenshot", base64 };
    }
    case "scroll": {
      await ensureAttached(tabId);
      const amt = Math.min(input.amount || 3, 10);
      const deltaY = input.direction === "up" ? -amt * 300 : amt * 300;
      // window.scrollBy is far more reliable than dispatching a mouseWheel at
      // a random (400,400) point — that often misses the scrollable area.
      // Also wake any scrollable parent by scrolling the focused element too.
      await cdp(tabId, "Runtime.evaluate", {
        expression: `(() => {
          // Prefer the deepest scrollable ancestor of the focused element
          let el = document.activeElement || document.scrollingElement || document.documentElement;
          while (el && el !== document.body) {
            const cs = getComputedStyle(el);
            const ov = cs.overflowY;
            if ((ov === 'auto' || ov === 'scroll') && el.scrollHeight > el.clientHeight) {
              el.scrollBy({ top: ${deltaY}, behavior: 'instant' });
              return true;
            }
            el = el.parentElement;
          }
          window.scrollBy({ top: ${deltaY}, behavior: 'instant' });
          return true;
        })()`,
        returnByValue: true,
      });
      await sleep(200);
      return `Scrolled ${input.direction} by ${Math.abs(deltaY)}px`;
    }
    case "run_javascript": {
      await ensureAttached(tabId);
      const r = await cdp(tabId, "Runtime.evaluate", { expression: input.code, returnByValue: true, awaitPromise: true });
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
    case "switch_tab": {
      await chrome.tabs.update(input.tabId, { active: true });
      const t = await chrome.tabs.get(input.tabId);
      retargetTaskTab(t.id);
      return `Switched to tab ${t.id}`;
    }
    default:
      return `Unknown tool: ${name}`;
  }
}
