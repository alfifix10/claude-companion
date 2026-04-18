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
const $historyBtn = document.getElementById("historyBtn");
const $historyOverlay = document.getElementById("historyOverlay");
const $historyList = document.getElementById("historyList");
const $closeHistoryBtn = document.getElementById("closeHistoryBtn");
const $newConvBtn = document.getElementById("newConvBtn");

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
      streamingBubble.innerHTML = renderMarkdown(streamingBubble.dataset.raw);
      // Visual cue for "plan" responses: if Claude opens the message
      // with a "خطّتي:" line, decorate the bubble so the numbered list
      // reads as a proper plan card instead of plain prose.
      markPlanIfPresent(streamingBubble);
      // Only auto-follow if the user was already near the bottom — don't
      // yank them around while they're reading earlier content.
      scrollToBottomIfFollowing();
      break;
    case "tool_start":
      setTyping(true, `جارٍ: ${TOOL_LABELS[msg.tool] || msg.tool}...`);
      break;
    case "provider_info":
      // We don't display this anywhere — status header was removed.
      break;
    case "done": {
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
  try { await updateTabInfo(); } catch (e) { console.error("updateTabInfo:", e); }
  try { await loadTasks(); } catch (e) { console.error("loadTasks:", e); }
  try { connectBg(); } catch (e) { console.error("connectBg:", e); }
}

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
// Messages rendering
// ─────────────────────────────────────────────────────────────────────
function removeWelcome() { $welcome.style.display = "none"; }

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

  // Links [text](url) — validate scheme first to block javascript:/data:/vbscript:
  // XSS vectors. Claude's output could contain a malicious link via prompt
  // injection in page content it reads.
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => {
    const raw = String(u).trim();
    const safeScheme = /^(?:https?:|mailto:|tel:|#|\/|\.\.?\/)/i.test(raw);
    if (!safeScheme) return t; // render plain text, drop the dangerous link
    const url = raw.replace(/"/g, "&quot;");
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

function appendError(text) {
  const d = document.createElement("div");
  d.className = "msg error";
  d.textContent = text;
  $messages.appendChild(d);
  scrollToBottom();
}

// Single compact line below the assistant bubble summarizing what Claude did.
// Much cleaner than one box per tool. Screenshots render separately.
function appendToolActions(actions) {
  if (!actions?.length) return;

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
    appendError("خطأ: " + e.message);
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
    appendError(`تم تجاهل ${rejectedBig} صورة أكبر من 10MB — جرّب ضغطها أوّلاً.`);
  }
  if (rejectedFull) {
    appendError(`الحد الأقصى ${MAX_IMAGE_COUNT} صور في الرسالة — أرسل الحالية ثم ألصق الباقي.`);
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
// Settings + quick actions
// ─────────────────────────────────────────────────────────────────────
$settings.addEventListener("click", () => chrome.runtime.openOptionsPage());

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
  $welcome.style.display = "none";
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

async function renderHistoryList() {
  const index = await convLoadIndex();
  $historyList.innerHTML = "";
  if (!index.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "لا توجد محادثات سابقة. ابدأ بكتابة سؤال في الأسفل.";
    $historyList.appendChild(empty);
    return;
  }
  for (const meta of index) {
    const item = document.createElement("div");
    item.className = "conv-item";
    if (meta.id === currentConvId) item.classList.add("active");
    item.dataset.id = meta.id;

    const body = document.createElement("div");
    body.className = "conv-item-body";
    const title = document.createElement("div");
    title.className = "conv-title";
    title.textContent = meta.title || "محادثة";
    const info = document.createElement("div");
    info.className = "conv-meta";
    info.textContent = `${formatRelative(meta.updatedAt)} • ${meta.count} رسالة`;
    body.appendChild(title);
    body.appendChild(info);
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
      await renderHistoryList();
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
  $welcome.style.display = "none";
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
    $welcome.style.display = "block";
    $messages.appendChild($welcome);
    if (filtered.length) await openConversation(filtered[0].id);
  }
}

async function startNewConversation() {
  if (isLoading) {
    hardStop("");
    await new Promise((r) => setTimeout(r, 150));
  }
  // Don't orphan an empty conv in storage — just reset local state.
  // ensureCurrentConv will mint a new id on the first save.
  currentConvId = null;
  await chrome.storage.local.remove("currentConvId");
  conversation = [];
  $messages.innerHTML = "";
  $welcome.style.display = "block";
  $messages.appendChild($welcome);
  closeHistory();
}

function openHistory() { renderHistoryList(); $historyOverlay.hidden = false; }
function closeHistory() { $historyOverlay.hidden = true; }

$historyBtn?.addEventListener("click", openHistory);
$closeHistoryBtn?.addEventListener("click", closeHistory);
$newConvBtn?.addEventListener("click", startNewConversation);

// ─────────────────────────────────────────────────────────────────────
// Voice (Web Speech API, Arabic)
// ─────────────────────────────────────────────────────────────────────
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null, recognizing = false, userWants = false;
let committed = "", baseline = "", maxListenTimer = null;
const MAX_LISTEN_MS = 60_000;

function initVoice() {
  if (!SpeechRec) {
    $mic.disabled = true;
    $mic.title = "المتصفح لا يدعم التعرّف الصوتي";
    return;
  }
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
  let lastErrorAt = 0;
  recog.onerror = (e) => {
    // ANY hard error stops auto-restart — otherwise we loop forever when
    // offline and spam the chat with the same "network" message.
    const hardErrors = new Set(["not-allowed", "service-not-allowed", "network", "audio-capture"]);
    if (hardErrors.has(e.error)) {
      userWants = false;
      if (maxListenTimer) { clearTimeout(maxListenTimer); maxListenTimer = null; }
    }

    // Throttle: show the same error at most once every 5s
    const now = Date.now();
    if (now - lastErrorAt < 5000) return;
    lastErrorAt = now;

    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      appendError("رفض إذن الميكروفون. فعّله من إعدادات المتصفح.");
      chrome.tabs.create({ url: chrome.runtime.getURL("mic-permission.html") });
    } else if (e.error === "network") {
      appendError("التعرّف الصوتي يحتاج اتصال إنترنت.");
    } else if (e.error === "audio-capture") {
      appendError("لم يُعثر على ميكروفون. تأكد من توصيله.");
    }
    // "no-speech" / "aborted" are normal — silent
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
    appendError("افتح صفحة الإذن وسمح، ثم عد هنا.");
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
