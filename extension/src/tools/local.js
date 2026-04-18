/**
 * Local (no-AI) shortcuts.
 * Arabic/English command patterns that execute directly — free, instant.
 * Format: { pattern: RegExp, action: string, extract: (match) => params }
 */

import { executeTool } from "./executor.js";
import { sendContentMessage, getActiveTab } from "../core/cdp.js";

const SHORTCUTS = [
  { pattern: /^(?:اضغط|انقر|كليك|اختر|حدد)\s+(?:على\s+)?(.+)$/i,
    action: "click_by_text", extract: (m) => ({ query: m[1].trim() }) },
  { pattern: /^(?:اكتب|ادخل|حط)\s+(.+?)\s+(?:في|بـ|داخل)\s+(.+)$/i,
    action: "type_in", extract: (m) => ({ value: m[1].trim(), target: m[2].trim() }) },
  { pattern: /^(?:صورة|لقطة|سكرين|سكرينشوت|لقطة\s+شاشة|التقط\s+صورة|screenshot)$/i,
    action: "screenshot" },
  { pattern: /^(?:اقرأ|اقرا|قراءة|read\s+page)\s*(?:الصفحة|الصفحه)?$/i,
    action: "read_page" },
  { pattern: /^(?:استخرج|استخراج|get\s+text)\s*(?:النص|المحتوى|نص\s+الصفحة)?$/i,
    action: "get_text" },
  { pattern: /^(?:انزل|تمرير\s+لأسفل|نزل|اسكرول\s+تحت|مرر\s+لأسفل|scroll\s+down)$/i,
    action: "scroll", extract: () => ({ direction: "down" }) },
  { pattern: /^(?:اطلع|طلع|تمرير\s+لأعلى|اسكرول\s+فوق|مرر\s+لأعلى|scroll\s+up)$/i,
    action: "scroll", extract: () => ({ direction: "up" }) },
  { pattern: /^(?:افتح|اذهب\s+الى|اذهب\s+إلى|روح|انتقل|go\s+to|open)\s+(.+)$/i,
    action: "navigate", extract: (m) => ({ url: m[1].trim() }) },

  // Pure browser-history moves — no AI needed, no DOM work.
  { pattern: /^(?:ارجع|رجوع|خلف|للخلف|back)$/i,
    action: "history", extract: () => ({ direction: "back" }) },
  { pattern: /^(?:تقدم|للأمام|امام|أمام|forward)$/i,
    action: "history", extract: () => ({ direction: "forward" }) },
  { pattern: /^(?:حدّث|حدث|تحديث|reload|refresh)$/i,
    action: "reload" },

  // Tab management — instant, no AI.
  { pattern: /^(?:اغلق\s+التبويب|اغلق\s+تبويب|اقفل\s+التبويب|close\s+tab)$/i,
    action: "close_current_tab" },
  { pattern: /^(?:تبويب\s+جديد|افتح\s+تبويب|new\s+tab)$/i,
    action: "new_tab" },
  { pattern: /^(?:التبويبات|اعرض\s+التبويبات|قائمة\s+التبويبات|list\s+tabs|show\s+tabs)$/i,
    action: "list_tabs" },
  { pattern: /^(?:التبويب\s+التالي|التالي|next\s+tab)$/i,
    action: "switch_tab_rel", extract: () => ({ dir: 1 }) },
  { pattern: /^(?:التبويب\s+السابق|السابق|previous\s+tab|prev\s+tab)$/i,
    action: "switch_tab_rel", extract: () => ({ dir: -1 }) },

  // Zoom — plain CSS/CDP, instant.
  { pattern: /^(?:قرّب|قرب|كبّر|كبر|zoom\s+in)$/i,
    action: "zoom", extract: () => ({ delta: +0.1 }) },
  { pattern: /^(?:بعّد|بعد|صغّر|صغر|zoom\s+out)$/i,
    action: "zoom", extract: () => ({ delta: -0.1 }) },
  { pattern: /^(?:zoom\s+reset|حجم\s+أصلي|حجم\s+اصلي)$/i,
    action: "zoom", extract: () => ({ reset: true }) },

  // Find in page — uses content-script findElements + scroll-into-view
  // (Chrome's native Find bar isn't reachable from an extension reliably).
  //
  // The old pattern accepted bare "ابحث X" which swallowed conversational
  // replies like "ابحث بنفسك" (= "go ahead with your research") as a
  // literal find-in-page request for the word "بنفسك", producing the
  // useless error bubble "لا يوجد 'بنفسك' في الصفحة". Tightened to
  // require an explicit "في الصفحة" (or English "on page"), so only
  // deliberate find-in-page commands trigger this shortcut. Everything
  // else falls through to Claude — who can still call the `find` tool
  // when that's what the user actually meant.
  { pattern: /^(?:ابحث\s+في\s+(?:الصفحة|هذه\s+الصفحة)\s+عن|find\s+on\s+page|search\s+on\s+page)\s+(.+)$/i,
    action: "find_in_page", extract: (m) => ({ query: m[1].trim() }) },

  // Clipboard copies — straight to the panel, no Claude, no CDP.
  { pattern: /^(?:انسخ\s+الرابط|انسخ\s+العنوان|انسخ\s+الـurl|copy\s+(?:url|link|address))$/i,
    action: "copy_url" },
  { pattern: /^(?:انسخ\s+اسم\s+الصفحة|انسخ\s+عنوان\s+التبويب|copy\s+title)$/i,
    action: "copy_title" },

  // Tab state toggles.
  { pattern: /^(?:ضاعف\s+التبويب|كرّر\s+التبويب|كرر\s+التبويب|duplicate\s+tab)$/i,
    action: "duplicate_tab" },
  { pattern: /^(?:اكتم|كتم|mute)$/i,
    action: "set_muted", extract: () => ({ muted: true }) },
  { pattern: /^(?:فكّ\s+الكتم|فك\s+الكتم|الغِ\s+الكتم|الغ\s+الكتم|unmute)$/i,
    action: "set_muted", extract: () => ({ muted: false }) },
  { pattern: /^(?:ثبّت|ثبت\s+التبويب|pin|pin\s+tab)$/i,
    action: "set_pinned", extract: () => ({ pinned: true }) },
  { pattern: /^(?:فكّ\s+التثبيت|فك\s+التثبيت|unpin|unpin\s+tab)$/i,
    action: "set_pinned", extract: () => ({ pinned: false }) },
];

// Common Arabic names → canonical URLs
const SITE_ALIASES = {
  "يوتيوب": "https://www.youtube.com",
  "youtube": "https://www.youtube.com",
  "قوقل": "https://www.google.com",
  "جوجل": "https://www.google.com",
  "غوغل": "https://www.google.com",
  "google": "https://www.google.com",
  "تويتر": "https://x.com",
  "twitter": "https://x.com",
  "اكس": "https://x.com",
  "إكس": "https://x.com",
  "فيسبوك": "https://www.facebook.com",
  "facebook": "https://www.facebook.com",
  "انستقرام": "https://www.instagram.com",
  "انستاجرام": "https://www.instagram.com",
  "instagram": "https://www.instagram.com",
  "ويكيبيديا": "https://ar.wikipedia.org",
  "wikipedia": "https://en.wikipedia.org",
  "أمازون": "https://www.amazon.sa",
  "امازون": "https://www.amazon.sa",
  "amazon": "https://www.amazon.com",
  "نون": "https://www.noon.com",
  "noon": "https://www.noon.com",
  "جيميل": "https://mail.google.com",
  "بريدي": "https://mail.google.com",
  "gmail": "https://mail.google.com",
  "خرائط": "https://maps.google.com",
  "خريطة": "https://maps.google.com",
  "maps": "https://maps.google.com",
  "لينكدإن": "https://www.linkedin.com",
  "لينكد إن": "https://www.linkedin.com",
  "linkedin": "https://www.linkedin.com",
  "ريديت": "https://www.reddit.com",
  "reddit": "https://www.reddit.com",
  "تيك توك": "https://www.tiktok.com",
  "tiktok": "https://www.tiktok.com",
  "جيتهاب": "https://github.com",
  "github": "https://github.com",
  // Arabic news / Saudi media
  "سبق": "https://sabq.org",
  "العربية": "https://www.alarabiya.net",
  "الجزيرة": "https://www.aljazeera.net",
  "عاجل": "https://www.ajel.sa",
  "الرياض": "https://www.alriyadh.com",
  "عكاظ": "https://www.okaz.com.sa",
  "المدينة": "https://www.al-madina.com",
  "اليوم": "https://www.alyaum.com",
  "مكة": "https://makkahnewspaper.com",
  "الوطن": "https://www.alwatan.com.sa",
  // Common services
  "twitch": "https://www.twitch.tv",
  "تويتش": "https://www.twitch.tv",
  "netflix": "https://www.netflix.com",
  "نتفلكس": "https://www.netflix.com",
  "spotify": "https://open.spotify.com",
  "whatsapp": "https://web.whatsapp.com",
  "واتساب": "https://web.whatsapp.com",
  "واتس": "https://web.whatsapp.com",
  "telegram": "https://web.telegram.org",
  "تلغرام": "https://web.telegram.org",
};

function resolveSiteUrl(raw) {
  const q = (raw || "").trim();
  if (!q) return null;
  // Already a URL / domain we can trust?
  if (/^https?:\/\//i.test(q) || /^[\w-]+(\.[\w-]+)+$/i.test(q)) return q;
  const lower = q.toLowerCase();
  if (SITE_ALIASES[lower]) return SITE_ALIASES[lower];
  for (const k of Object.keys(SITE_ALIASES)) {
    if (lower.endsWith(k)) return SITE_ALIASES[k];
  }
  return null; // Unknown — caller must defer to AI (which knows site names)
}

/**
 * Try to match a user text against a local shortcut. Returns action+params if matched.
 * For `navigate`, we additionally verify the target is resolvable — if not, we
 * decline the local shortcut and let Claude Max handle it (it knows sites like
 * سبق/العربية/الجزيرة that aren't in our alias table).
 */
export function tryLocal(text) {
  for (const s of SHORTCUTS) {
    const m = text.match(s.pattern);
    if (!m) continue;
    const params = s.extract ? s.extract(m) : {};

    // Navigate is special: only claim the shortcut if we're confident about the URL.
    if (s.action === "navigate") {
      const url = resolveSiteUrl(params.url);
      if (!url) return null; // defer to AI
      params.url = url;
    }
    return { action: s.action, params };
  }
  return null;
}

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
      const r = await executeTool("screenshot", {}, tabId);
      return { screenshot: r?.base64, toolActions: [{ tool: "screenshot" }] };
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
      // params.url is pre-validated by tryLocal — always a real URL/domain here
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
