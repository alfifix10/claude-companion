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
    default:
      return { error: `إجراء غير معروف: ${action}` };
  }
}
