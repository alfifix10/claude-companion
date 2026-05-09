/**
 * Local (no-AI) action dispatcher.
 *
 * The text-pattern shortcut matcher (`tryLocal` + SHORTCUTS + SITE_ALIASES)
 * was removed in commit a8a64db — typed prompts now always go to Claude.
 * What remains here is `executeLocal()`: the handler invoked by the
 * deliberate quick-action chips (📸 لقطة / 🎯 العناصر / 📝 النص / etc.)
 * and by user-defined ⚡ repeated tasks when they dispatch a known
 * action name.
 */

import { executeTool } from "./executor.js";
import { sendContentMessage, getActiveTab } from "../core/cdp.js";

/**
 * Execute a shortcut directly (no AI involved).
 * Returns { text, toolActions?, screenshot?, error? }
 */
export async function executeLocal(action, params = {}) {
  const tab = await getActiveTab();
  const tabId = tab.id;

  switch (action) {
    case "click_by_text": {
      const resp = await sendContentMessage(tabId, { type: "findElements", query: params.query });
      const hits = resp?.result || [];
      if (!hits.length) return { error: `لم أجد "${params.query}"` };
      const target = hits[0];
      await executeTool("click", { ref: target.ref }, tabId);
      return { toolActions: [{ tool: "click", detail: `"${target.name || target.role}"` }] };
    }
    case "type_in": {
      const resp = await sendContentMessage(tabId, { type: "findElements", query: params.target });
      const hits = resp?.result || [];
      if (!hits.length) return { error: `لم أجد حقل "${params.target}"` };
      const r = await executeTool("form_input", { ref: hits[0].ref, value: params.value }, tabId);
      if (typeof r === "string" && r.startsWith("Error")) return { error: r };
      return { toolActions: [{ tool: "form_input", detail: `"${params.value}" → ${hits[0].name || hits[0].role}` }] };
    }
    case "screenshot": {
      // User-pressed-the-camera path → high quality (PNG, 1920px).
      // The agent loop continues to use the default cheap profile
      // (JPEG q45, 1280px) via the executor.
      const r = await executeTool("screenshot", { highQuality: true }, tabId);
      return {
        screenshot: r?.base64,
        screenshotMediaType: r?.mediaType || "image/png",
        toolActions: [{ tool: "screenshot" }],
      };
    }
    case "read_page": {
      const r = await executeTool("read_page", { filter: "interactive" }, tabId);
      return { text: r, toolActions: [{ tool: "read_page" }] };
    }
    case "get_text": {
      const r = await executeTool("get_page_text", {}, tabId);
      return { text: r, toolActions: [{ tool: "get_page_text" }] };
    }
    case "scroll": {
      await executeTool("scroll", { direction: params.direction }, tabId);
      return { toolActions: [{ tool: "scroll" }] };
    }
    case "navigate": {
      // Callers (chips / tasks) pass a real URL or a bare domain;
      // add https:// if it's not already a scheme.
      let url = params.url;
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;
      await executeTool("navigate", { url }, tabId);
      return { toolActions: [{ tool: "navigate", detail: url }] };
    }
    case "history": {
      // Pure history traversal — no DOM work. CDP is faster than navigate
      // because no tab update round-trip.
      await executeTool("navigate", { direction: params.direction }, tabId);
      return { toolActions: [{ tool: "navigate", detail: params.direction === "back" ? "رجوع" : "تقدّم" }] };
    }
    case "reload": {
      await chrome.tabs.reload(tabId);
      return { toolActions: [{ tool: "reload" }] };
    }
    case "close_current_tab": {
      const info = `${tab.title || tab.url}`;
      await chrome.tabs.remove(tabId);
      return { text: `أُغلق التبويب: ${info}`, toolActions: [{ tool: "tabs_close" }] };
    }
    case "new_tab": {
      const t = await chrome.tabs.create({ url: "chrome://newtab/", active: true });
      return { text: `فُتح تبويب جديد (${t.id})`, toolActions: [{ tool: "tabs_create" }] };
    }
    case "list_tabs": {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const list = tabs
        .map((t) => `${t.active ? "▸ " : "  "}[${t.id}] ${t.title || "(بلا عنوان)"}\n    ${t.url}`)
        .join("\n");
      return { text: `التبويبات (${tabs.length}):\n${list}` };
    }
    case "switch_tab_rel": {
      // Rotate within the current window. +1 = next, -1 = previous.
      const all = await chrome.tabs.query({ currentWindow: true });
      const ordered = all.sort((a, b) => a.index - b.index);
      const curIdx = ordered.findIndex((t) => t.active);
      if (curIdx < 0) return { error: "لم أجد التبويب النشط" };
      const nextIdx = (curIdx + params.dir + ordered.length) % ordered.length;
      const next = ordered[nextIdx];
      await chrome.tabs.update(next.id, { active: true });
      return { text: `→ ${next.title || next.url}`, toolActions: [{ tool: "switch_tab" }] };
    }
    case "zoom": {
      const current = await chrome.tabs.getZoom(tabId);
      const target = params.reset
        ? 1.0
        : Math.max(0.3, Math.min(3.0, current + (params.delta || 0)));
      await chrome.tabs.setZoom(tabId, target);
      return { text: `Zoom: ${Math.round(target * 100)}%`, toolActions: [{ tool: "zoom" }] };
    }
    case "find_in_page": {
      // Find the first match and scroll it into view. Highlights via the
      // existing findElements path so the user sees a visual cue.
      const resp = await sendContentMessage(tabId, { type: "findElements", query: params.query });
      const hits = resp?.result || [];
      if (!hits.length) return { error: `لا يوجد "${params.query}" في الصفحة` };
      try { await sendContentMessage(tabId, { type: "scrollToRef", ref: hits[0].ref }); } catch {}
      try { await sendContentMessage(tabId, { type: "highlightElements", refs: hits.slice(0, 8).map((h) => h.ref) }); } catch {}
      return { text: `عثرت على ${hits.length} نتيجة لـ "${params.query}". الأولى مُظلّلة في الصفحة.` };
    }
    case "copy_url": {
      // Clipboard API is only available in secure contexts; the side panel
      // qualifies, but we also guard for older browsers.
      const value = tab.url || "";
      try {
        await navigator.clipboard.writeText(value);
        return { text: `نُسخ: ${value}` };
      } catch (e) {
        return { error: `تعذّر النسخ: ${e?.message || e}` };
      }
    }
    case "copy_title": {
      const value = tab.title || "";
      try {
        await navigator.clipboard.writeText(value);
        return { text: `نُسخ العنوان: "${value}"` };
      } catch (e) {
        return { error: `تعذّر النسخ: ${e?.message || e}` };
      }
    }
    case "duplicate_tab": {
      const copy = await chrome.tabs.duplicate(tabId);
      return { text: `ضوعف التبويب (${copy?.id}): ${copy?.url || tab.url}` };
    }
    case "set_muted": {
      await chrome.tabs.update(tabId, { muted: !!params.muted });
      return { text: params.muted ? `كُتم صوت التبويب 🔇` : `أُعيد صوت التبويب 🔊` };
    }
    case "set_pinned": {
      await chrome.tabs.update(tabId, { pinned: !!params.pinned });
      return { text: params.pinned ? `ثُبِّت التبويب 📌` : `أُزيل التثبيت` };
    }
    default:
      return { error: `إجراء غير معروف: ${action}` };
  }
}
