/**
 * Side-panel controller.
 * Owns the visible chat UI and delegates everything else to the background.
 */

// ─────────────────────────────────────────────────────────────────────
// DOM refs
// ─────────────────────────────────────────────────────────────────────
const $messages = document.getElementById("messages");
const $input = document.getElementById("input");
const $send = document.getElementById("sendBtn");
const $mic = document.getElementById("micBtn");
const $typing = document.getElementById("typing");
const $typingText = document.getElementById("typingText");
const $settings = document.getElementById("settingsBtn");
const $tabTitle = document.getElementById("tabTitle");
const $tabDot = document.getElementById("tabDot");
const $welcome = document.getElementById("welcome");
const $tasksRow = document.getElementById("tasksRow");
const $attachments = document.getElementById("attachments");
const $scrollBtn = document.getElementById("scrollBtn");
const $newChatBtn = document.getElementById("newChatBtn");
const $historyBtn = document.getElementById("historyBtn");
const $app = document.querySelector(".app");
const $notice = document.getElementById("notice");

// Transient notice — for errors/info that shouldn't become a chat
// bubble (voice failure, image cap, etc.). Appears floating above
// everything, auto-dismisses. Replaces previous notice on new call.
let noticeTimer = 0;
function showNotice(text, { variant = "error", ms = 6000 } = {}) {
  if (!$notice) return;
  $notice.className = "notice" + (variant === "info" ? " info" : "");
  $notice.textContent = text;
  $notice.hidden = false;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { $notice.hidden = true; }, ms);
}
const $historyOverlay = document.getElementById("historyOverlay");
const $historyList = document.getElementById("historyList");
const $historySearch = document.getElementById("historySearch");
const $closeHistoryBtn = document.getElementById("closeHistoryBtn");

// Pasted images waiting to be sent with the next message.
// { mediaType: "image/png", base64: "iVBOR..." }
let pendingImages = [];

// Current task's cancellation token. Replaced on every new task start.
// `hardStop()` sets `.aborted = true` so any in-flight local work bails.
let currentCancel = { aborted: false };

function setLoading(on) {
  isLoading = on;
  $send.classList.toggle("stopping", on);
  $send.title = on ? "إيقاف صارم" : "إرسال";
  if (on) {
    $send.disabled = false;            // always clickable as stop
  } else {
    $send.disabled = !$input.value.trim();
    setTyping(false);
  }
}

function hardStop(reason = "أوقفت العملية.") {
  // 1. Abort any in-flight local runLocal
  if (currentCancel) currentCancel.aborted = true;
  // 2. Tell the background to kill claude + blackout tool calls
  if (bgPort) { try { bgPort.postMessage({ type: "chat_stop" }); } catch {} }
  // 3. Close the streaming bubble cleanly
  streamingBubble = null;
  // 4. Reset all UI state
  setLoading(false);
  if (reason) appendError(reason);
}

const TOOL_LABELS = {
  read_page: "قراءة العناصر", get_page_text: "استخراج النص",
  find: "بحث", click: "نقر", type_text: "كتابة",
  press_key: "ضغط مفتاح", form_input: "ملء حقل",
  screenshot: "لقطة شاشة", run_javascript: "JavaScript",
  scroll: "تمرير", navigate: "انتقال",
  hover: "تمرير الماوس", wait_for: "انتظار",
  select_option: "اختيار", list_tabs: "تبويبات",
  switch_tab: "تبديل تبويب", tabs_create: "تبويب جديد", tabs_context: "معلومات التبويب",
};

let conversation = [];
const MAX_HISTORY = 50;
let isLoading = false;
let streamingBubble = null;

// ─────────────────────────────────────────────────────────────────────
// Background port (long-lived)
// ─────────────────────────────────────────────────────────────────────
let bgPort = null;
function connectBg() {
  bgPort = chrome.runtime.connect({ name: "chat" });
  bgPort.onMessage.addListener(onBgMessage);
  bgPort.onDisconnect.addListener(() => { bgPort = null; });
  bgPort.postMessage({ type: "get_status" });
}

function onBgMessage(msg) {
  // Ignore any message from a task the user already stopped.
  // `isLoading` is the reliable signal — hardStop sets it false.
  if (!isLoading && msg.type !== "no_task") return;

  switch (msg.type) {
    case "text_delta":
      setTyping(false);
      streamingBubble ??= appendAssistantBubble("");
      streamingBubble.dataset.raw = (streamingBubble.dataset.raw || "") + msg.text;
      // Coalesce renders onto the next animation frame: a fast stream
      // of tokens (dozens per second) would otherwise re-parse the
      // ENTIRE markdown on every token — O(n²) over growing string.
      // One render per frame caps the cost at 60fps regardless of
      // token rate. markPlanIfPresent + scroll run inside the same
      // scheduled tick so everything is in sync.
      scheduleStreamRender(streamingBubble);
      break;
    case "tool_start":
      setTyping(true, `جارٍ: ${TOOL_LABELS[msg.tool] || msg.tool}...`);
      break;
    case "provider_info":
      // We don't display this anywhere — status header was removed.
      break;
    case "done": {
      // Make sure any coalesced render that was waiting for the next
      // animation frame lands synchronously — otherwise the bubble
      // might freeze one token short of the final text.
      flushStreamRender();
      const bubble = streamingBubble;
      const text = bubble?.dataset?.raw || msg.text || "";
      streamingBubble = null;
      if (!bubble && text) appendAssistantBubble(text);
      if (msg.toolActions?.length) appendToolActions(msg.toolActions);
      if (text) conversation.push({ role: "assistant", content: text });
      setLoading(false);
      saveHistory();
      // If the user had scrolled up to read something else while the
      // answer was streaming, give the floating ↓ button a brief pulse so
      // they notice the reply is ready.
      notifyNewMessage();
      break;
    }
    case "error":
      // Terminate the streaming bubble so the next task doesn't append to it.
      // Without this, a retry after error keeps writing into the old bubble.
      if (streamingBubble) streamingBubble = null;
      appendError(msg.text || "خطأ غير معروف");
      setLoading(false);
      break;
    case "no_task":
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────
async function init() {
  try { await loadHistory(); } catch (e) { console.error("loadHistory:", e); }
  // loadHistory renders stored messages and flips off fresh mode; if it
  // didn't find anything (brand-new user, deleted last conv, etc.) we
  // land here with an empty conversation and no currentConvId → fresh.
  if (!conversation.length && !currentConvId) setFreshChat(true);
  try { await updateTabInfo(); } catch (e) { console.error("updateTabInfo:", e); }
  try { await loadTasks(); } catch (e) { console.error("loadTasks:", e); }
  try { connectBg(); } catch (e) { console.error("connectBg:", e); }
}

// Starter cards inside the welcome block — each drops a ready-made
// prompt into the input and sends, exactly as if the user had typed
// it and hit Enter. send() handles the fresh→active transition.
// Each starter maps to the full prompt that lands in $input then fires
// send(). Keep the chip label short but make the prompt itself explicit
// so Claude has enough to act — the model doesn't see the chip text.
const STARTER_PROMPTS = {
  summarize:       "لخّص محتوى هذه الصفحة في ٥-٨ نقاط واضحة",
  translate:       "ترجم محتوى هذه الصفحة كاملاً إلى العربيّة الفصحى، مع الحفاظ على الأسماء والمصطلحات التقنيّة",
  youtube_summary: "اقرأ transcript هذا الفيديو ولخّصه في نقاط رئيسيّة مع ذكر أي أرقام أو اقتباسات مهمّة",
  simplify:        "اشرح محتوى هذه الصفحة بلغة بسيطة جدّاً كأنّك تخاطب شخصاً غير متخصّص، مع أمثلة لتوضيح المفاهيم الصعبة",
  extract_table:   "استخرج البيانات المنظَّمة من هذه الصفحة (منتجات / نتائج / قوائم / إحصاءات) واعرضها في جدول Markdown منظَّم",
  draft_reply:     "اقرأ المحتوى المُحدَّد أو البريد/التعليق المفتوح، واكتب ردّاً احترافيّاً ومهذّباً بالعربيّة. اعرض الردّ فقط دون شرح",
  fact_check:      "تحقّق من صحّة الادعاءات والأرقام الرئيسيّة في هذه الصفحة. اذكر لكلّ ادعاء: (١) ما قالته الصفحة (٢) هل هو صحيح/مشكوك/خاطئ (٣) السبب باختصار",
};
document.querySelectorAll(".starter-chip").forEach((btn) => {
  btn.addEventListener("click", () => {
    const kind = btn.dataset.starter;
    const prompt = STARTER_PROMPTS[kind];
    if (!prompt) return;
    $input.value = prompt;
    $input.dispatchEvent(new Event("input"));
    send();
  });
});

// ─────────────────────────────────────────────────────────────────────
// User-defined repeated tasks
// Format in storage (string):
//   name = prompt
//   name = prompt
// Clicking a chip fires the prompt as a normal user message (goes through
// the usual local-shortcut → Max pipeline, same as typing it manually).
// ─────────────────────────────────────────────────────────────────────
// Parser supports two shapes:
//   (a) single-line task:    name: the full prompt text on one line
//   (b) multi-line task:     name:
//                            the full prompt
//                            across multiple lines
// Tasks are separated by blank line(s). Lines starting with `#` are comments.
// Legacy `=` separator is still accepted for backward compatibility.
function parseTasks(raw) {
  const out = [];
  if (!raw) return out;

  // Split into blocks by blank line
  const blocks = raw.split(/\r?\n\s*\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    if (!lines.length) continue;

    const first = lines[0];
    // Detect separator: colon or legacy `=`
    let idx = first.indexOf(":");
    let sep = ":";
    const eqIdx = first.indexOf("=");
    if ((idx === -1) || (eqIdx !== -1 && eqIdx < idx)) {
      idx = eqIdx;
      sep = "=";
    }
    if (idx <= 0) continue;

    const name = first.slice(0, idx).trim();
    const inlineRest = first.slice(idx + 1).trim();
    const restLines = lines.slice(1);
    const prompt = [inlineRest, ...restLines].filter(Boolean).join("\n").trim();
    if (name && prompt) out.push({ name, prompt });
  }
  return out;
}

async function loadTasks() {
  const { tasks } = await chrome.storage.local.get("tasks");
  renderTasks(parseTasks(tasks));
}

function renderTasks(list) {
  $tasksRow.innerHTML = "";
  for (const t of list) {
    const btn = document.createElement("button");
    btn.className = "task-chip";
    btn.textContent = "⚡ " + t.name;
    btn.title = t.prompt; // full prompt on hover
    btn.addEventListener("click", () => fireTask(t.prompt));
    $tasksRow.appendChild(btn);
  }
}

// Fire a saved prompt exactly as if the user typed it and hit send.
function fireTask(prompt) {
  $input.value = prompt;
  $input.dispatchEvent(new Event("input"));
  send();
}

// Re-render when the user saves new tasks (chrome.storage change event).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.tasks) {
    renderTasks(parseTasks(changes.tasks.newValue || ""));
  }
});


async function updateTabInfo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) {
      $tabTitle.textContent = tab.title || tab.url || "(بلا عنوان)";
    }
  } catch {}
}

chrome.tabs?.onActivated?.addListener(updateTabInfo);
chrome.tabs?.onUpdated?.addListener((id, ch, tab) => {
  if (!tab?.active || !ch.url) return;
  updateTabInfo();
});

// ─────────────────────────────────────────────────────────────────────
// Fresh-chat mode
//
// When the current conversation has no messages (either it's a brand-new
// chat the user hasn't typed in yet, or they just clicked + / مسح), we
// enter "fresh mode": the welcome block + starter cards become visible
// and the input row floats up to the centre of the panel. Once the first
// message lands, we switch to active mode and everything pins to its
// normal positions.
//
// All visibility + layout is driven by toggling the single .fresh-chat
// class on .app — the CSS handles the rest, which keeps JS simple and
// avoids inline style leaks.
// ─────────────────────────────────────────────────────────────────────
function setFreshChat(fresh) {
  if (!$app) return;
  $app.classList.toggle("fresh-chat", !!fresh);
}

// ─────────────────────────────────────────────────────────────────────
// Messages rendering
// ─────────────────────────────────────────────────────────────────────
// Any bubble append lands us firmly in "active" mode. Keeping this as
// the single choke-point means individual appenders don't need to
// know about the mode system.
function removeWelcome() { setFreshChat(false); }

// Wrap the bubble in a container that can hold the copy button next to it.
function makeMessageWrap(cls) {
  const wrap = document.createElement("div");
  wrap.className = "msg-wrap " + cls;
  return wrap;
}

function attachCopyButton(wrap, getText) {
  const btn = document.createElement("button");
  btn.className = "copy-ico";
  btn.title = "نسخ";
  btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(getText());
      btn.classList.add("done");
      btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>`;
      setTimeout(() => {
        btn.classList.remove("done");
        btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
      }, 1500);
    } catch {}
  });
  wrap.appendChild(btn);
}

function appendUser(text) {
  appendUserMessage(text, []);
}

/**
 * Unified user-message renderer. Produces a SINGLE bubble that can hold:
 *   • text only                  (classic case)
 *   • images only                (e.g. screenshot paste + send with no caption)
 *   • text + images stacked      (most natural flow)
 *
 * Keeping images inside the bubble matches the WhatsApp/Telegram/ChatGPT
 * pattern — a message is one visual unit, not a text bubble + floating
 * images below it.
 *
 * Copy button still only copies the text; copying images is browser-clumsy
 * and out of scope here.
 */
function appendUserMessage(text, images) {
  if (!text && (!images || images.length === 0)) return;
  removeWelcome();
  const wrap = makeMessageWrap("user");
  const d = document.createElement("div");
  d.className = "msg user";
  // Image-only bubble uses a tighter padding via .has-media so the
  // image can breathe without a fat padding frame around it.
  if (images && images.length) d.classList.add("has-media");

  if (text) {
    const t = document.createElement("div");
    t.className = "msg-text";
    t.textContent = text;
    d.appendChild(t);
  }
  if (images && images.length) {
    const wrap2 = document.createElement("div");
    wrap2.className = "msg-media";
    for (const img of images) {
      const el = document.createElement("img");
      el.className = "msg-img";
      el.src = `data:${img.mediaType};base64,${img.base64}`;
      el.alt = "";
      wrap2.appendChild(el);
    }
    d.appendChild(wrap2);
  }
  wrap.appendChild(d);
  // Copy button for text portion only — image copy is browser-specific and
  // adds complexity for marginal value.
  if (text) attachCopyButton(wrap, () => text);
  $messages.appendChild(wrap);
  scrollToBottom();
}

function appendAssistantBubble(text = "") {
  removeWelcome();
  const wrap = makeMessageWrap("assistant");
  const d = document.createElement("div");
  d.className = "msg assistant markdown";
  d.dataset.raw = text;
  d.innerHTML = renderMarkdown(text);
  wrap.appendChild(d);
  attachCopyButton(wrap, () => d.dataset.raw || "");
  $messages.appendChild(wrap);
  scrollToBottom();
  return d;
}

// ─────────────────────────────────────────────────────────────────────
// Minimal Markdown renderer — no dependencies, safe (HTML-escapes first).
// Handles: headings, bold, italic, inline+block code, lists, tables, links.
// ─────────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderMarkdown(src) {
  if (!src) return "";
  let text = String(src);

  // Extract fenced code blocks so their contents aren't touched by other rules.
  const codeBlocks = [];
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
  });

  // Escape everything else
  text = escapeHtml(text);

  // Headings (###, ##, #)
  text = text.replace(/^#### (.*)$/gm, "<h5>$1</h5>")
             .replace(/^### (.*)$/gm, "<h4>$1</h4>")
             .replace(/^## (.*)$/gm, "<h3>$1</h3>")
             .replace(/^# (.*)$/gm, "<h2>$1</h2>");

  // Tables: | col1 | col2 | with ---|---| separator
  text = text.replace(
    /^(\|[^\n]+\|\n\|[\s|:-]+\|\n(?:\|[^\n]+\|\n?)+)/gm,
    (block) => {
      const lines = block.trim().split(/\n/);
      const head = lines[0].split("|").slice(1, -1).map((c) => c.trim());
      const rows = lines.slice(2).map((l) =>
        l.split("|").slice(1, -1).map((c) => c.trim())
      );
      let html = "<table><thead><tr>";
      for (const h of head) html += `<th>${h}</th>`;
      html += "</tr></thead><tbody>";
      for (const r of rows) {
        html += "<tr>";
        for (const c of r) html += `<td>${c}</td>`;
        html += "</tr>";
      }
      return html + "</tbody></table>";
    }
  );

  // Unordered lists (- item / * item)
  text = text.replace(/(?:^[-*] .*(?:\n|$))+/gm, (m) => {
    const items = m.trim().split(/\n/).map((l) => l.replace(/^[-*] /, "").trim());
    return "<ul>" + items.map((i) => `<li>${i}</li>`).join("") + "</ul>";
  });
  // Ordered lists (1. item)
  text = text.replace(/(?:^\d+\. .*(?:\n|$))+/gm, (m) => {
    const items = m.trim().split(/\n/).map((l) => l.replace(/^\d+\. /, "").trim());
    return "<ol>" + items.map((i) => `<li>${i}</li>`).join("") + "</ol>";
  });

  // Bold / italic / inline code
  text = text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");

  // Links [text](url) — harden against prompt-injected XSS.
  //   1. Reject any whitespace/control chars in the URL: a URL like
  //      `https://x\n onmouseover=alert(1)` survived the old scheme
  //      check because only the `"` was escaped.
  //   2. Only relative/anchor/simple schemes are kept as-is.
  //   3. For absolute http(s) URLs we round-trip through `new URL()`
  //      so the browser's own parser normalises the value — anything
  //      that can't be parsed is dropped.
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => {
    const raw = String(u).trim();
    // Fail closed on any control / whitespace inside the URL
    if (/[\u0000-\u001f\u007f <>"`\\]/.test(raw)) return t;
    const relOrAnchor = /^(?:#|\/|\.\.?\/|mailto:|tel:)/i.test(raw);
    let safe = null;
    if (relOrAnchor) {
      safe = raw;
    } else if (/^https?:/i.test(raw)) {
      try { safe = new URL(raw).href; } catch { safe = null; }
    }
    if (!safe) return t;
    const url = safe.replace(/"/g, "&quot;");
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${t}</a>`;
  });

  // Paragraph / line-break handling: double newline = paragraph, single = <br>
  const parts = text.split(/\n{2,}/).map((p) => {
    const trimmed = p.trim();
    if (!trimmed) return "";
    // Skip wrapping if it's already a block element
    if (/^<(h[2-6]|ul|ol|pre|table)/i.test(trimmed)) return trimmed;
    return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
  });
  text = parts.join("");

  // Restore code blocks
  text = text.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, i) => codeBlocks[Number(i)]);
  return text;
}

// Map the most common English/technical error strings that leak up from
// CDP / Chromium / the network stack into a short Arabic explanation.
// Anything we don't recognise falls through so we don't hide real info.
function humanizeError(text) {
  const s = String(text ?? "").trim();
  if (!s) return "خطأ غير معروف";
  // Keep already-Arabic messages as-is (our own layers).
  if (/[\u0600-\u06FF]/.test(s)) return s;

  const map = [
    [/Cannot access a chrome:\/\/ URL|Cannot access contents of (?:url|the page)/i,
     "صفحة داخليّة — افتح موقعاً عادياً ثم حاول."],
    [/No tab with id/i,                          "التبويب أُغلِق — أعد فتحه."],
    [/Debugger is already attached/i,            "المتصفّح متّصل بالفعل — أعد المحاولة."],
    [/Detached while handling command|Target closed/i,
                                                 "التبويب أُغلِق أثناء التنفيذ."],
    [/Cannot navigate to invalid URL/i,          "رابط غير صالح."],
    [/ERR_NAME_NOT_RESOLVED/i,                   "فشل حلّ عنوان الموقع."],
    [/ERR_INTERNET_DISCONNECTED|Failed to fetch|NetworkError/i,
                                                 "تعذّر الاتصال بالشبكة."],
    [/ERR_CONNECTION_REFUSED/i,                  "الخادم رفض الاتصال."],
    [/ERR_TIMED_OUT/i,                           "انتهت مهلة الاتصال."],
    [/ERR_CERT_|ERR_SSL_/i,                      "مشكلة في شهادة الموقع."],
    [/NO_NATIVE_HOST/i,                          "جسر الإضافة غير متّصل — أعد تحميل الإضافة."],
    [/POST_FAILED/i,                             "فشل إرسال الطلب للمضيف."],
    [/TIMEOUT/i,                                 "انتهت المهلة دون ردّ."],
  ];
  for (const [re, ar] of map) if (re.test(s)) return ar;
  // Unknown English error — flag it clearly as technical so the user
  // doesn't confuse it with the assistant's actual reply.
  return "خطأ فنيّ: " + s;
}

function appendError(text) {
  removeWelcome();
  const d = document.createElement("div");
  d.className = "msg error";
  d.textContent = humanizeError(text);
  $messages.appendChild(d);
  scrollToBottom();
}

// Single compact line below the assistant bubble summarizing what Claude did.
// Much cleaner than one box per tool. Screenshots render separately.
function appendToolActions(actions) {
  if (!actions?.length) return;
  removeWelcome();

  // Collapse to unique labels — if Claude did read_page 3 times, show once.
  const labels = [];
  const seen = new Set();
  const screenshots = [];
  for (const a of actions) {
    if (a.screenshot) screenshots.push(a.screenshot);
    const lbl = TOOL_LABELS[a.tool] || a.tool;
    const key = a.error ? `!${lbl}` : lbl;
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push({ label: lbl, error: !!a.error });
  }
  if (labels.length === 0 && screenshots.length === 0) return;

  if (labels.length > 0) {
    const line = document.createElement("div");
    line.className = "tool-line";
    line.innerHTML = labels
      .map((l) => `<span class="${l.error ? "t-bad" : "t-ok"}">${l.error ? "✗" : "✓"} ${l.label}</span>`)
      .join(`<span class="t-sep">·</span>`);
    $messages.appendChild(line);
  }

  for (const b64 of screenshots) {
    const img = document.createElement("img");
    img.className = "tool-screenshot";
    img.src = `data:image/jpeg;base64,${b64}`;
    $messages.appendChild(img);
  }
  scrollToBottom();
}

// ─────────────────────────────────────────────────────────────────────
// Scroll management
//
// The user can be in one of two modes:
//   • "following"  — they're at (or near) the bottom, so we auto-scroll
//                    as new streamed tokens arrive. Default.
//   • "browsing"   — they've scrolled up to read older content. We must
//                    NOT yank them to the bottom; that's rude and loses
//                    their place. Instead we show the floating ↓ button.
//
// The floating button:
//   • Appears when we're in browsing mode.
//   • Pulses for ~1.4s when a new assistant message arrives while it's
//     visible — one-shot attention, not per-token noise.
// ─────────────────────────────────────────────────────────────────────
const NEAR_BOTTOM_PX = 60;   // slack so tiny overshoot still counts as "at bottom"
const SHOW_BTN_PX    = 150;  // button appears when farther than this from bottom
let followingBottom = true;

function distanceFromBottom() {
  return $messages.scrollHeight - $messages.scrollTop - $messages.clientHeight;
}

// When the system prompt asks Claude to lead with "خطّتي:" for multi-step
// tasks, we detect that opening in the streaming bubble and add a CSS
// class so the list renders as a proper plan card (left border, step
// icons). Purely presentational — we don't parse or track step state
// here, just help the user see at a glance "Claude has a plan".
const PLAN_PREFIX_RE = /^(?:\s*\S{0,80})?خطّتي\s*:/;
function markPlanIfPresent(bubble) {
  if (!bubble) return;
  const raw = bubble.dataset.raw || "";
  if (!bubble.classList.contains("has-plan") && PLAN_PREFIX_RE.test(raw)) {
    bubble.classList.add("has-plan");
  }
}

// Coalesced streaming render.
//
// The naive implementation called renderMarkdown(full_raw_text) on every
// `text_delta` event. On a 2 000-char reply arriving in ~200 tokens,
// that's 200 full re-parses of a string growing 10→2000 chars each
// time — effectively O(n²) main-thread work during the stream (400 ms
// to 1 s measured). Users saw jank on long replies.
//
// Coalescing caps the render at one per animation frame (~60 Hz). When
// multiple tokens arrive in the same frame they all contribute to
// `dataset.raw` but only a single markdown render fires. Nothing else
// changes — the DOM content is identical, just updated less often.
//
// flushStreamRender() runs the pending render synchronously; called at
// end-of-stream to guarantee the final text lands even if a `done`
// event arrives before the next rAF tick.
let pendingRenderBubble = null;
let pendingRenderFrame = 0;
function scheduleStreamRender(bubble) {
  pendingRenderBubble = bubble;
  if (pendingRenderFrame) return;
  pendingRenderFrame = requestAnimationFrame(() => {
    pendingRenderFrame = 0;
    flushStreamRender();
  });
}
function flushStreamRender() {
  const bubble = pendingRenderBubble;
  pendingRenderBubble = null;
  if (pendingRenderFrame) { cancelAnimationFrame(pendingRenderFrame); pendingRenderFrame = 0; }
  if (!bubble || !bubble.isConnected) return;
  bubble.innerHTML = renderMarkdown(bubble.dataset.raw || "");
  markPlanIfPresent(bubble);
  scrollToBottomIfFollowing();
}

/** Unconditional — jump to bottom and re-enter following mode. */
function scrollToBottom() {
  $messages.scrollTop = $messages.scrollHeight;
  followingBottom = true;
  updateScrollBtn();
}

/** Only scrolls if the user was already near the bottom. Use this for
 *  streaming/reactive updates so we don't yank a reader around. */
function scrollToBottomIfFollowing() {
  if (followingBottom) {
    $messages.scrollTop = $messages.scrollHeight;
  }
}

function updateScrollBtn() {
  if (!$scrollBtn) return;
  const d = distanceFromBottom();
  $scrollBtn.classList.toggle("visible", d > SHOW_BTN_PX);
}

/** Called when a new assistant message lands. If the user is NOT at the
 *  bottom, fire a one-shot pulse so they notice there's something new. */
function notifyNewMessage() {
  if (distanceFromBottom() > SHOW_BTN_PX && $scrollBtn) {
    // Restart the animation: remove the class, force reflow, re-add.
    $scrollBtn.classList.remove("pulse");
    void $scrollBtn.offsetWidth;
    $scrollBtn.classList.add("pulse");
  }
}

// Throttle scroll handling via requestAnimationFrame — a fast wheel can
// fire dozens of events per second; we only need one visual update per frame.
let scrollRaf = 0;
$messages.addEventListener("scroll", () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    followingBottom = distanceFromBottom() <= NEAR_BOTTOM_PX;
    updateScrollBtn();
  });
}, { passive: true });

$scrollBtn?.addEventListener("click", () => {
  $messages.scrollTo({ top: $messages.scrollHeight, behavior: "smooth" });
  followingBottom = true;
  // Hide immediately on click — visual feedback even before smooth-scroll completes.
  $scrollBtn.classList.remove("visible", "pulse");
});

function setTyping(show, text) {
  $typing.style.display = show ? "flex" : "none";
  if (text) $typingText.textContent = text;
}

// ─────────────────────────────────────────────────────────────────────
// Send flow
// ─────────────────────────────────────────────────────────────────────
async function send() {
  const text = $input.value.trim();
  const hasImages = pendingImages.length > 0;
  if (!text && !hasImages) return;

  // If a previous task is still running, cancel it first (ChatGPT-style
  // behaviour — new question wins). We don't want to queue or block.
  if (isLoading) {
    hardStop("");  // silent cancel — user is starting fresh
    // Give the hard-stop a moment to propagate (blackout, kill subprocesses)
    await new Promise((r) => setTimeout(r, 150));
  }

  // Capture and clear attachments BEFORE any async so subsequent paste can
  // start filling a fresh batch without racing this send.
  const images = pendingImages;
  pendingImages = [];
  renderAttachments();

  // One unified bubble for text + attached images — matches mainstream
  // chat UX (WhatsApp/Telegram/ChatGPT).
  if (text || images.length) appendUserMessage(text, images);

  conversation.push({ role: "user", content: text });
  if (conversation.length > MAX_HISTORY) conversation = conversation.slice(-MAX_HISTORY);
  $input.value = "";
  $input.style.height = "auto";
  updateSend();

  currentCancel = { aborted: false };

  // Local shortcuts don't support images — skip to Max when images attached
  if (!hasImages) {
    const { tryLocal } = await import("./src/tools/local.js");
    const hit = tryLocal(text);
    if (hit) {
      await runLocal(hit, currentCancel);
      return;
    }
  }

  setLoading(true);
  setTyping(true, "Claude يفكّر...");
  streamingBubble = null;

  if (!bgPort) connectBg();
  bgPort.postMessage({
    type: "chat_send",
    messages: conversation,
    images,  // forwarded to Max via native host
  });
}

// (appendUserImages removed — appendUserMessage now owns image rendering
// inside the user bubble.)

async function runLocal(hit, myCancel) {
  // Defensive: always have a valid cancel token.
  myCancel = myCancel || { aborted: false };

  setLoading(true);
  setTyping(true, "جارٍ التنفيذ...");

  // 30s safety cap
  const hardTimer = setTimeout(() => {
    if (myCancel.aborted) return;
    myCancel.aborted = true;
    setLoading(false);
    appendError("استغرقت العملية أكثر من اللازم. أوقفتها — جرّب مجدداً.");
  }, 30000);

  try {
    const r = await chrome.runtime.sendMessage({
      type: "local_action", action: hit.action, params: hit.params,
    });
    if (myCancel.aborted) { clearTimeout(hardTimer); return; }
    clearTimeout(hardTimer);
    setLoading(false);

    if (r?.error) appendError(r.error);
    else {
      if (r?.toolActions) appendToolActions(r.toolActions);
      if (r?.screenshot) {
        removeWelcome();
        const img = document.createElement("img");
        img.className = "tool-screenshot";
        img.src = `data:image/jpeg;base64,${r.screenshot}`;
        $messages.appendChild(img);
        scrollToBottom();
      }
      if (r?.text) {
        appendAssistantBubble(r.text);
        conversation.push({ role: "assistant", content: r.text });
      }
    }
    saveHistory();
  } catch (e) {
    if (myCancel.aborted) { clearTimeout(hardTimer); return; }
    clearTimeout(hardTimer);
    setLoading(false);
    // Let humanizeError translate/prefix — double-prefixing produces
    // "خطأ: خطأ فنيّ: ..." which reads badly.
    appendError(e?.message || String(e));
  }
}

// Dual-purpose send/stop button:
//   • empty input + loading  → stop
//   • empty input + idle     → (disabled, no-op)
//   • text present           → send (which auto-cancels any running task)
$send.addEventListener("click", () => {
  const hasContent = $input.value.trim() || pendingImages.length > 0;
  if (!hasContent && isLoading) { hardStop(""); return; }
  if (!hasContent) return;
  send();
});
$input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const hasContent = $input.value.trim() || pendingImages.length > 0;
    if (!hasContent && isLoading) { hardStop(""); return; }
    if (hasContent) send();
  }
});

// ─────────────────────────────────────────────────────────────────────
// Paste images from clipboard
// Works with Win+Shift+S snips, screenshots, any copied image.
//
// Caps protect the panel and Claude from pathological pastes:
//   • MAX_PER_IMAGE_BYTES: refuse a single huge image before we even
//     base64-encode it (encoding a 50 MB blob locks the UI for seconds)
//   • MAX_IMAGE_COUNT: keep the total attachment set small so we don't
//     ship a 100 MB prompt to the CLI
// ─────────────────────────────────────────────────────────────────────
const MAX_PER_IMAGE_BYTES = 10 * 1024 * 1024;   // 10 MB
const MAX_IMAGE_COUNT = 8;

$input.addEventListener("paste", async (e) => {
  const items = e.clipboardData?.items || [];
  let rejectedBig = 0;
  let rejectedFull = 0;
  for (const it of items) {
    if (it.kind === "file" && it.type.startsWith("image/")) {
      e.preventDefault();
      const blob = it.getAsFile();
      if (!blob) continue;
      if (pendingImages.length >= MAX_IMAGE_COUNT) {
        rejectedFull++;
        continue;
      }
      if (blob.size > MAX_PER_IMAGE_BYTES) {
        rejectedBig++;
        continue;
      }
      try {
        const base64 = await blobToBase64(blob);
        pendingImages.push({ mediaType: it.type, base64 });
        renderAttachments();
      } catch {}
    }
  }
  if (rejectedBig) {
    showNotice(`تم تجاهل ${rejectedBig} صورة أكبر من 10MB — جرّب ضغطها أوّلاً.`);
  }
  if (rejectedFull) {
    showNotice(`الحد الأقصى ${MAX_IMAGE_COUNT} صور في الرسالة — أرسل الحالية ثم ألصق الباقي.`);
  }
});

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

function renderAttachments() {
  $attachments.innerHTML = "";
  for (let i = 0; i < pendingImages.length; i++) {
    const img = pendingImages[i];
    const wrap = document.createElement("div");
    wrap.className = "attach-item";
    const thumb = document.createElement("img");
    thumb.src = `data:${img.mediaType};base64,${img.base64}`;
    wrap.appendChild(thumb);
    const rm = document.createElement("button");
    rm.className = "attach-remove";
    rm.textContent = "×";
    rm.title = "إزالة";
    rm.addEventListener("click", () => {
      // Look up by identity, not captured index. The captured `i` would be
      // wrong if the array shifted (e.g. a paste added an item between
      // render and click, or a previous click already removed one).
      const idx = pendingImages.indexOf(img);
      if (idx >= 0) pendingImages.splice(idx, 1);
      renderAttachments();
    });
    wrap.appendChild(rm);
    $attachments.appendChild(wrap);
  }
  // Enable send button when we have images even if input is empty
  updateSend();
}

$input.addEventListener("input", () => {
  $input.style.height = "auto";
  $input.style.height = Math.min($input.scrollHeight, 80) + "px";
  updateSend();
});
function updateSend() {
  // While loading, the button is a stop button — keep it enabled.
  if (isLoading) { $send.disabled = false; return; }
  // Enable if there's text OR at least one pasted image.
  $send.disabled = !$input.value.trim() && pendingImages.length === 0;
}

// ─────────────────────────────────────────────────────────────────────
// Settings overlay
//
// Settings used to open as a separate options page (chrome://extensions
// options entry + own tab). Consistency with the history overlay — and
// the user's preference to stay inside the panel — means settings now
// live as an in-panel overlay too. Same layout pattern, same keyboard
// shortcut to close (Escape), same full-panel takeover.
// ─────────────────────────────────────────────────────────────────────
const $settingsOverlay = document.getElementById("settingsOverlay");
const $closeSettingsBtn = document.getElementById("closeSettingsBtn");
const $memoriesInput = document.getElementById("memoriesInput");
const $tasksInput = document.getElementById("tasksInput");
const $saveSettingsBtn = document.getElementById("saveSettingsBtn");
const $settingsToast = document.getElementById("settingsToast");

async function openSettings() {
  // Pull the latest values at open time so edits made elsewhere (e.g. a
  // restore from the native-host backup that ran while the panel was open)
  // are reflected.
  const { memories = "", tasks = "" } = await chrome.storage.local.get(["memories", "tasks"]);
  $memoriesInput.value = memories;
  $tasksInput.value = tasks;
  $settingsToast.hidden = true;
  $settingsOverlay.hidden = false;
  // Focus the first textarea for keyboard-first users.
  try { $memoriesInput.focus({ preventScroll: true }); } catch { $memoriesInput.focus(); }
}

function closeSettings() {
  $settingsOverlay.hidden = true;
}

async function saveSettings() {
  const memories = $memoriesInput.value.trim();
  const tasks = $tasksInput.value.trim();
  await chrome.storage.local.set({ memories, tasks });
  // Mirror to native-host backup file so settings survive extension
  // uninstall. Best-effort; a failure here is silent.
  try { chrome.runtime.sendMessage({ type: "mirror_user_data", data: { memories, tasks } }); } catch {}
  // Reload the task chips row since it's driven by `tasks`.
  try { await loadTasks(); } catch {}
  // Brief confirmation without closing — users often tweak twice.
  $settingsToast.hidden = false;
  setTimeout(() => { $settingsToast.hidden = true; }, 1800);
}

$settings.addEventListener("click", openSettings);
$closeSettingsBtn?.addEventListener("click", closeSettings);
$saveSettingsBtn?.addEventListener("click", saveSettings);

// Escape closes whichever overlay is open. Scoped to the panel so it
// doesn't hijack Escape elsewhere.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$settingsOverlay.hidden) { closeSettings(); return; }
  if (!$historyOverlay.hidden) { closeHistory(); return; }
});

// ─────────────────────────────────────────────────────────────────────
// Quick actions
// ─────────────────────────────────────────────────────────────────────

document.querySelectorAll(".chip").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const action = btn.dataset.quick;
    if (action === "clear_all") {
      // "Clear" now means "start a fresh conversation" — the previous
      // one stays in the history overlay so nothing is destroyed. If
      // the user wants permanent deletion, the × in history does it.
      await startNewConversation();
      return;
    }
    if (action === "copy_chat") {
      // Copy the conversation in BOTH flavours so the paste target
      // gets the best available representation:
      //   • text/html  → Gmail, Docs, Notion, Word → rendered formatting
      //   • text/plain → terminals, code editors   → raw markdown
      // Pasting into the extension's own input still shows raw text
      // because user bubbles aren't rendered as markdown (by design).
      if (!conversation.length) {
        showNotice("لا توجد محادثة للنسخ", { variant: "info", ms: 1500 });
        return;
      }
      const plainParts = [];
      const htmlParts = [];
      for (const m of conversation) {
        const role = m.role === "user" ? "المستخدم" : "المساعد";
        const raw = typeof m.content === "string"
          ? m.content
          : "[محتوى غير نصّيّ — صور/أدوات]";
        plainParts.push(`${role}:\n${raw}`);
        // Assistant messages get full markdown rendering; user messages
        // stay verbatim (just newlines → <br>) so what the user wrote
        // is preserved literally.
        const bodyHtml = m.role === "assistant" && typeof m.content === "string"
          ? renderMarkdown(m.content)
          : escapeHTML(raw).replace(/\n/g, "<br>");
        htmlParts.push(
          `<div style="margin:0 0 6px 0;font-weight:600">${role}:</div>` +
          `<div style="margin:0 0 14px 0">${bodyHtml}</div>`
        );
      }
      const plainText = plainParts.join("\n\n──────────────\n\n");
      const htmlText =
        `<div dir="rtl" style="font-family:'Segoe UI',Tahoma,Arial,sans-serif;line-height:1.6">` +
        htmlParts.join('<hr style="margin:12px 0;border:0;border-top:1px solid #d0d0d0">') +
        `</div>`;

      const showOK = () => showNotice("تم نسخ المحادثة", { variant: "info", ms: 1500 });
      try {
        if (navigator.clipboard?.write && window.ClipboardItem) {
          await navigator.clipboard.write([new ClipboardItem({
            "text/html":  new Blob([htmlText],  { type: "text/html"  }),
            "text/plain": new Blob([plainText], { type: "text/plain" }),
          })]);
          showOK();
        } else {
          // Older browsers: plain text only.
          await navigator.clipboard.writeText(plainText);
          showOK();
        }
      } catch (e) {
        // ClipboardItem can fail in odd contexts (permission, focus).
        // Fall back to plain text; if that also fails, surface the error.
        try {
          await navigator.clipboard.writeText(plainText);
          showOK();
        } catch (e2) {
          showNotice("فشل النسخ: " + (e2?.message || e2), { ms: 2500 });
        }
      }
      return;
    }
    // scroll_up / scroll_down chips were removed; the floating ↓ button
    // replaces both (see scrollBtn + the followingBottom logic above).
    const map = {
      screenshot: { action: "screenshot" },
      read_page: { action: "read_page" },
      get_text: { action: "get_text" },
    };
    const hit = map[action];
    if (!hit) return;
    // If a task is already streaming, clicking a quick-action chip means
    // "cancel that and do this instead" — same ChatGPT-style behaviour
    // as re-sending while a response streams. Without this we race: the
    // old currentCancel gets overwritten, the old task keeps streaming,
    // and both results land in the same chat in unpredictable order.
    if (isLoading) {
      hardStop("");
      // Give hardStop a beat to tear down the bg port + tool blackout
      // before the new local action starts dispatching CDP calls.
      await new Promise((r) => setTimeout(r, 150));
    }
    await runLocal(hit, currentCancel = { aborted: false });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Conversation persistence
//
// Storage layout (chrome.storage.local):
//   conv_index: [{ id, title, updatedAt, count }, ...]  // metadata list
//   conv_<id>:  [...messages]                           // per-conversation
//   currentConvId: "<id>"                               // for resume
//
// Design choices:
//   • Lazy creation — a conversation is only written to storage once the
//     user sends their first message. Opening the panel, clicking
//     "new chat", and never typing leaves zero storage footprint.
//   • 20-conversation cap with LRU eviction. ~1 MB typical total.
//   • Migration from the old single chatHistory key runs on first load
//     with new code: the history becomes conv_<new id>, old key removed.
// ─────────────────────────────────────────────────────────────────────
const CONV_MAX = 20;
let currentConvId = null;

async function convLoadIndex() {
  const { conv_index = [] } = await chrome.storage.local.get("conv_index");
  return Array.isArray(conv_index) ? conv_index : [];
}

async function convSaveIndex(index) {
  await chrome.storage.local.set({ conv_index: index });
}

function newConvId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// Derive a display title from the first user message — first 40 chars,
// collapsed whitespace, markdown stripped of emphasis markers.
function deriveTitle(messages) {
  const first = messages.find((m) => m.role === "user");
  if (!first) return "محادثة جديدة";
  const raw = typeof first.content === "string" ? first.content : "";
  const cleaned = raw
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "محادثة بصور";
  return cleaned.length > 40 ? cleaned.slice(0, 40) + "…" : cleaned;
}

// Lazy-create the current conversation id when the user is about to save
// their first message. Called from saveHistory.
async function ensureCurrentConv() {
  if (currentConvId) return currentConvId;
  const id = newConvId();
  const index = await convLoadIndex();
  index.unshift({
    id, title: "محادثة جديدة", updatedAt: Date.now(), count: 0,
  });
  // LRU eviction of anything beyond the cap.
  if (index.length > CONV_MAX) {
    const evicted = index.splice(CONV_MAX);
    const keys = evicted.map((e) => `conv_${e.id}`);
    if (keys.length) await chrome.storage.local.remove(keys);
  }
  await convSaveIndex(index);
  await chrome.storage.local.set({ currentConvId: id });
  currentConvId = id;
  return id;
}

async function saveHistory() {
  if (!conversation.length) return;
  const id = await ensureCurrentConv();
  await chrome.storage.local.set({ [`conv_${id}`]: conversation });
  // Update index entry (title + count + updatedAt).
  const index = await convLoadIndex();
  const entry = index.find((c) => c.id === id);
  if (entry) {
    entry.count = conversation.length;
    entry.updatedAt = Date.now();
    entry.title = deriveTitle(conversation);
    await convSaveIndex(index);
  }
}

async function loadHistory() {
  // Migration path: if the old single-bucket chatHistory key is present
  // and no conversations have been set up yet, move it into the new
  // scheme and drop the old key.
  const { chatHistory, currentConvId: savedId } = await chrome.storage.local.get(["chatHistory", "currentConvId"]);
  if (Array.isArray(chatHistory) && chatHistory.length && !savedId) {
    const id = newConvId();
    await chrome.storage.local.set({
      [`conv_${id}`]: chatHistory,
      currentConvId: id,
      conv_index: [{
        id, title: deriveTitle(chatHistory),
        updatedAt: Date.now(), count: chatHistory.length,
      }],
    });
    await chrome.storage.local.remove("chatHistory");
    currentConvId = id;
    conversation = chatHistory;
    renderStoredConversation(conversation);
    return;
  }

  if (savedId) {
    const stored = await chrome.storage.local.get(`conv_${savedId}`);
    const msgs = stored[`conv_${savedId}`];
    if (Array.isArray(msgs) && msgs.length) {
      currentConvId = savedId;
      conversation = msgs;
      renderStoredConversation(conversation);
      return;
    }
  }
  // Nothing to show — welcome state stays.
}

function renderStoredConversation(messages) {
  setFreshChat(false);
  for (const m of messages) {
    if (m.role === "user") appendUser(m.content);
    else appendAssistantBubble(m.content);
  }
}

// ─────────────────────────────────────────────────────────────────────
// History overlay — opens on 🕐, lists saved conversations
// ─────────────────────────────────────────────────────────────────────
function formatRelative(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "الآن";
  const m = Math.floor(s / 60);
  if (m < 60) return `منذ ${m} دقيقة`;
  const h = Math.floor(m / 60);
  if (h < 24) return `منذ ${h} ساعة`;
  const d = Math.floor(h / 24);
  if (d < 7) return `منذ ${d} يوم`;
  return new Date(ts).toLocaleDateString("ar");
}

// Escape the five HTML-sensitive characters so snippet text can be
// safely injected with innerHTML (the only markup we add is our own
// trusted <mark>).
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// Build the highlighted snippet around the first case-insensitive
// occurrence of `q` in `text`. Returns escaped HTML with <mark> around
// the hit, or null if no match. ±40 chars of context on each side,
// with "…" elision markers when we're clipping.
function buildSnippet(text, q, windowChars = 40) {
  if (!text || !q) return null;
  const lower = text.toLowerCase();
  const i = lower.indexOf(q.toLowerCase());
  if (i === -1) return null;
  const start = Math.max(0, i - windowChars);
  const end = Math.min(text.length, i + q.length + windowChars);
  const before = (start > 0 ? "…" : "") + text.slice(start, i);
  const hit = text.slice(i, i + q.length);
  const after = text.slice(i + q.length, end) + (end < text.length ? "…" : "");
  return escapeHTML(before) + "<mark>" + escapeHTML(hit) + "</mark>" + escapeHTML(after);
}

// Track the live search term so re-renders (e.g. after delete) keep
// the user's filter applied.
let currentSearchQuery = "";
let historySearchTimer = null;

async function renderHistoryList(query = "") {
  const q = (query || "").trim();
  const index = await convLoadIndex();
  $historyList.innerHTML = "";
  if (!index.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "لا توجد محادثات سابقة. ابدأ بكتابة سؤال في الأسفل.";
    $historyList.appendChild(empty);
    return;
  }

  // Search mode: pull every saved conversation in one batch call,
  // then filter locally. At our cap (20 convs × 50 msgs × ~500 B)
  // we're scanning ≤ 500 KB — substring search finishes in well
  // under a frame.
  let convsById = null;
  if (q) {
    const keys = index.map((e) => `conv_${e.id}`);
    convsById = await chrome.storage.local.get(keys);
  }

  const rows = [];
  for (const meta of index) {
    if (!q) {
      rows.push({ meta, snippet: null });
      continue;
    }
    const msgs = convsById[`conv_${meta.id}`];
    let snippet = null;
    if (Array.isArray(msgs)) {
      // First matching message in the conversation wins the snippet.
      for (const m of msgs) {
        const text = typeof m.content === "string" ? m.content : "";
        snippet = buildSnippet(text, q);
        if (snippet) break;
      }
    }
    // Fall back to title match so searching for a topic in the derived
    // title still surfaces the conversation even when the raw messages
    // don't contain the query verbatim.
    if (!snippet) snippet = buildSnippet(meta.title || "", q);
    if (snippet) rows.push({ meta, snippet });
  }

  if (q && rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = `لا نتائج مطابقة لـ "${q}".`;
    $historyList.appendChild(empty);
    return;
  }

  for (const { meta, snippet } of rows) {
    const item = document.createElement("div");
    item.className = "conv-item";
    if (meta.id === currentConvId) item.classList.add("active");
    item.dataset.id = meta.id;

    const body = document.createElement("div");
    body.className = "conv-item-body";
    const title = document.createElement("div");
    title.className = "conv-title";
    title.textContent = meta.title || "محادثة";
    body.appendChild(title);

    if (snippet) {
      // In search mode, show the matched context instead of the date
      // + message-count meta — the snippet is the more useful signal.
      const sn = document.createElement("div");
      sn.className = "conv-snippet";
      sn.innerHTML = snippet;  // safe: buildSnippet escapes; only <mark> is ours
      body.appendChild(sn);
    } else {
      const info = document.createElement("div");
      info.className = "conv-meta";
      info.textContent = `${formatRelative(meta.updatedAt)} • ${meta.count} رسالة`;
      body.appendChild(info);
    }
    item.appendChild(body);

    const del = document.createElement("button");
    del.className = "conv-delete";
    del.title = "حذف";
    del.setAttribute("aria-label", "حذف");
    // Inline SVG × — matches the rest of the UI instead of a text glyph
    // that varies by font.
    del.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M6 18L18 6"/></svg>';
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      await convDelete(meta.id);
      await renderHistoryList(currentSearchQuery);
    });
    item.appendChild(del);

    item.addEventListener("click", () => openConversation(meta.id));
    $historyList.appendChild(item);
  }
}

async function openConversation(id) {
  if (id === currentConvId) { closeHistory(); return; }
  // Don't race with an in-flight task.
  if (isLoading) {
    hardStop("");
    await new Promise((r) => setTimeout(r, 150));
  }
  const stored = await chrome.storage.local.get(`conv_${id}`);
  const msgs = stored[`conv_${id}`];
  if (!Array.isArray(msgs)) { closeHistory(); return; }
  currentConvId = id;
  await chrome.storage.local.set({ currentConvId: id });
  conversation = msgs;
  $messages.innerHTML = "";
  setFreshChat(false);
  renderStoredConversation(conversation);
  closeHistory();
}

async function convDelete(id) {
  const index = await convLoadIndex();
  const filtered = index.filter((c) => c.id !== id);
  await convSaveIndex(filtered);
  await chrome.storage.local.remove(`conv_${id}`);
  if (currentConvId === id) {
    // The currently-open conversation was deleted. Switch to the most
    // recent remaining one, or drop back to the welcome screen.
    currentConvId = null;
    await chrome.storage.local.remove("currentConvId");
    conversation = [];
    $messages.innerHTML = "";
    setFreshChat(true);
    if (filtered.length) await openConversation(filtered[0].id);
  }
}

/**
 * The single authoritative reset point for "start a new conversation".
 *
 * After this resolves the panel is guaranteed to be in this state:
 *   • no task running — any in-flight one is hard-stopped first so we
 *     never wipe the DOM out from under a streaming bubble
 *   • currentConvId === null; nothing persists in storage yet. A new
 *     conversation will be minted by ensureCurrentConv on first save.
 *   • streamingBubble === null so no stale reference points at a
 *     detached DOM node
 *   • conversation array, messages DOM, and welcome screen reset
 *   • pasted-image attachments cleared — they belonged to the previous
 *     chat's context, carrying them over would be confusing
 *   • floating scroll-to-bottom button hidden (empty list = nothing to
 *     scroll), followingBottom flag back to true
 *   • input text PRESERVED — "what I'm composing" is independent of
 *     which conversation is active (matches ChatGPT / Claude.ai)
 *   • send button state re-evaluated against that preserved text
 *   • history overlay closed
 *   • keyboard focus on the input, ready to type
 *
 * Idempotent: calling it twice in a row is a no-op on the second call
 * except for the focus, which is harmless.
 */
async function startNewConversation() {
  // 1. Stop any streaming task before we tear down its render target.
  if (isLoading) {
    hardStop("");
    await new Promise((r) => setTimeout(r, 150));
  }

  // 2. Chat state.
  currentConvId = null;
  await chrome.storage.local.remove("currentConvId");
  conversation = [];
  streamingBubble = null;

  // 3. DOM — empty message list, welcome panel back (fresh-chat layout
  //    centres the welcome + input block, handled by CSS).
  $messages.innerHTML = "";
  setFreshChat(true);

  // 4. Attachments belonged to the previous chat's context.
  if (pendingImages.length) {
    pendingImages = [];
    renderAttachments();
  }

  // 5. Scroll button — with no content there is nothing to scroll to.
  //    updateScrollBtn recomputes visibility from distanceFromBottom.
  followingBottom = true;
  updateScrollBtn();

  // 6. UX — close overlay, focus input, re-evaluate send button.
  closeHistory();
  try { $input.focus({ preventScroll: true }); } catch { $input.focus(); }
  updateSend();
}

function openHistory() {
  // Fresh open = fresh filter. Resetting here keeps the previous session's
  // query from lingering when the user comes back later.
  if ($historySearch) $historySearch.value = "";
  currentSearchQuery = "";
  renderHistoryList();
  $historyOverlay.hidden = false;
}
function closeHistory() { $historyOverlay.hidden = true; }

// Debounced search input. 180 ms is enough to coalesce fast typing
// without feeling laggy — the filter itself is instant at our scale.
$historySearch?.addEventListener("input", () => {
  currentSearchQuery = $historySearch.value;
  clearTimeout(historySearchTimer);
  historySearchTimer = setTimeout(() => {
    renderHistoryList(currentSearchQuery);
  }, 180);
});

$historyBtn?.addEventListener("click", openHistory);
$closeHistoryBtn?.addEventListener("click", closeHistory);
// The header + button is now the single entry point for a new chat —
// the duplicate one that used to live inside the history overlay has
// been removed to keep the overlay focused on "browse past chats".
$newChatBtn?.addEventListener("click", startNewConversation);

// ─────────────────────────────────────────────────────────────────────
// Voice (Web Speech API, Arabic)
// ─────────────────────────────────────────────────────────────────────
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null, recognizing = false, userWants = false;
let committed = "", baseline = "", maxListenTimer = null;
const MAX_LISTEN_MS = 60_000;

// Brave's build of Chromium exposes SpeechRecognition but ships it
// without the Google API key Chrome uses to authenticate. Every request
// to speech.googleapis.com fails with "network" regardless of what
// Shields settings the user toggles. It's not a block we can dodge —
// it's a feature Brave intentionally disabled. Hide the mic entirely
// in Brave instead of leaving the user to discover this via a dead
// button and a permission page that keeps promising "use Chrome".
async function detectBrave() {
  try { return !!(navigator.brave && await navigator.brave.isBrave()); }
  catch { return false; }
}

function initVoice() {
  if (!SpeechRec) {
    // Keep the button visually but make it clear it's a no-op.
    $mic.disabled = true;
    $mic.title = "المتصفح لا يدعم التعرّف الصوتي";
    return;
  }
  // Async Brave check: if Brave, remove the mic button from the flow.
  detectBrave().then((isBrave) => {
    if (isBrave) {
      $mic.style.display = "none";
    }
  });
  recog = new SpeechRec();
  recog.lang = "ar-SA";
  recog.continuous = true;
  recog.interimResults = true;
  recog.maxAlternatives = 1;
  recog.onstart = () => {
    recognizing = true;
    $mic.classList.add("listening");
    setTyping(true, "يستمع...");
  };
  recog.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) committed += r[0].transcript;
      else interim += r[0].transcript;
    }
    const prefix = baseline ? baseline + " " : "";
    $input.value = (prefix + committed + interim).trimStart();
    $input.dispatchEvent(new Event("input"));
  };
  // Two classes of speech errors:
  //   • PERMANENT — condition won't resolve without user action.
  //     Latch once, show notice, hard-disable the mic.
  //   • TRANSIENT (network) — could be a momentary Shields flicker, a
  //     WiFi blip, or the Google endpoint hiccuping. Show the notice
  //     (throttled) and stop the current session, BUT leave the button
  //     enabled so the user can try again. Previous iteration treated
  //     network as permanent and left users staring at a disabled mic
  //     after a single transient blip.
  let permanentErrorShown = false;
  let lastTransientNoticeAt = 0;
  const disableMic = (title) => {
    userWants = false;
    $mic.disabled = true;
    $mic.classList.remove("listening");
    $mic.title = title;
    if (maxListenTimer) { clearTimeout(maxListenTimer); maxListenTimer = null; }
  };

  recog.onerror = (e) => {
    const permanent = ["not-allowed", "service-not-allowed", "audio-capture"];
    const isPermanent = permanent.includes(e.error);
    const isTransient = e.error === "network";
    if (!isPermanent && !isTransient) return; // no-speech, aborted — silent

    // Stop whatever session is in flight so onend doesn't auto-restart.
    userWants = false;
    if (maxListenTimer) { clearTimeout(maxListenTimer); maxListenTimer = null; }

    if (isPermanent) {
      if (permanentErrorShown) { disableMic($mic.title); return; }
      permanentErrorShown = true;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        showNotice("إذن الميكروفون مرفوض");
        disableMic("الإذن مرفوض — فعّله من إعدادات المتصفح");
        try { chrome.tabs.create({ url: chrome.runtime.getURL("mic-permission.html") }); } catch {}
      } else {
        showNotice("لا يوجد ميكروفون متَّصل");
        disableMic("لا يوجد ميكروفون");
      }
      return;
    }

    // Transient network error — throttle the notice (once per 10 s) and
    // keep the mic button enabled so the user can retry. Full hint in
    // the tooltip for the curious.
    const now = Date.now();
    if (now - lastTransientNoticeAt >= 10_000) {
      lastTransientNoticeAt = now;
      showNotice("التعرّف الصوتي معطَّل الآن — جرّب مجدداً أو أوقِف Shields");
    }
    $mic.title = "التعرّف الصوتي يحتاج خدمة Google — في Brave أوقِف Shields";
  };
  recog.onend = () => {
    recognizing = false;
    if (userWants) {
      try { recog.start(); return; } catch {}
    }
    $mic.classList.remove("listening");
    setTyping(false);
    if (maxListenTimer) { clearTimeout(maxListenTimer); maxListenTimer = null; }
    updateSend();
  };
}

async function ensureMicPermission() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch (err) {
    chrome.tabs.create({ url: chrome.runtime.getURL("mic-permission.html") });
    showNotice("افتح صفحة الإذن وسمح، ثم عد هنا.");
    return false;
  }
}

$mic.addEventListener("click", async () => {
  if (!recog) { initVoice(); if (!recog) return; }
  if (userWants || recognizing) {
    userWants = false;
    try { recog.stop(); } catch {}
    return;
  }
  const ok = await ensureMicPermission();
  if (!ok) return;
  baseline = $input.value.trim();
  committed = "";
  userWants = true;
  try { recog.start(); } catch {}
  if (maxListenTimer) clearTimeout(maxListenTimer);
  maxListenTimer = setTimeout(() => {
    if (userWants) { userWants = false; try { recog.stop(); } catch {} }
  }, MAX_LISTEN_MS);
});

initVoice();
init();
