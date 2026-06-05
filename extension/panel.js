/**
 * Side-panel controller.
 * Owns the visible chat UI and delegates everything else to the background.
 */

// ─────────────────────────────────────────────────────────────────────
// Typed modules (Strangler migration — see src/lib/)
// ─────────────────────────────────────────────────────────────────────
// humanizeError: pure error→Arabic translator. 13 regex patterns with
// 37 unit tests living next to the source in src/lib/humanize-error.ts.
// Extension runtime consumes the compiled .js emitted by `npm run build`.
import { humanizeError } from "./src/lib/humanize-error.js";
// renderMarkdown: hand-rolled MD → HTML with XSS-hardened links.
// 39 unit tests. src/lib/markdown.ts.
import { renderMarkdown, escapeHtml } from "./src/lib/markdown.js";
// Phase-5 leaf harvests: small pure functions lifted out of panel.js.
import { parseTasks } from "./src/lib/parse-tasks.js";
import { formatRelative } from "./src/lib/format-relative.js";
// Phase-6 leaf harvests: derive-title + search-snippet.
import { deriveTitle } from "./src/lib/derive-title.js";
import { buildSnippet } from "./src/lib/search-snippet.js";
// actionTrace: compact one-line summary of tools an assistant turn ran, so the
// model remembers what it did across turns (C1). 7 unit tests. src/lib.
import { actionTrace } from "./src/lib/action-trace.js";
import { capConversation } from "./src/lib/cap-conversation.js";
import { shouldAutoResume, MAX_AUTO_RESUMES } from "./src/lib/auto-resume.js";

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

// Full-resolution images keyed by user-message index in conversation[].
// Why this exists: conversation[i].images stores 400-px thumbnails for
// chrome.storage replay (quota-friendly). When the user clicks ✎ to
// edit a recent message and resend, we want to ship the ORIGINAL pixels
// to Claude — not a degraded thumbnail. This cache holds full-res copies
// for the last EDIT_FULL_RES_CACHE_MAX user messages of the active
// session. It is intentionally NOT persisted: surviving across reloads
// would push us back into the chrome.storage quota fight, and the
// degraded-thumbnail fallback is fine for old conversations the user
// probably isn't still iterating on.
const fullResImagesCache = new Map();
const EDIT_FULL_RES_CACHE_MAX = 10;
function cacheFullResImages(msgIdx, images) {
  if (!Number.isFinite(msgIdx) || !images || !images.length) return;
  // Delete-then-set to refresh insertion order (Map keeps LRU semantics).
  fullResImagesCache.delete(msgIdx);
  fullResImagesCache.set(msgIdx, images.map((im) => ({ ...im })));
  while (fullResImagesCache.size > EDIT_FULL_RES_CACHE_MAX) {
    const oldest = fullResImagesCache.keys().next().value;
    fullResImagesCache.delete(oldest);
  }
}
function getFullResImages(msgIdx) {
  const hit = fullResImagesCache.get(msgIdx);
  return hit ? hit.map((im) => ({ ...im })) : null;
}
function dropFullResImagesFrom(msgIdx) {
  // When the user truncates conversation[] at msgIdx (edit-resend), every
  // cached entry at or after that slot is stale — delete them so a later
  // edit at the same slot doesn't read the previous turn's images.
  for (const k of [...fullResImagesCache.keys()]) {
    if (k >= msgIdx) fullResImagesCache.delete(k);
  }
}

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

// Short window after hardStop where residual events from the dying
// subprocess are dropped. Without it, a buffered text_delta that
// reaches us after we set isLoading=false would re-flip the UI to
// "loading" via the resume-detection path below.
let stopBlackoutUntil = 0;

function hardStop(reason = "أوقفت العملية.") {
  // 1. Abort any in-flight local runLocal
  if (currentCancel) currentCancel.aborted = true;
  // 2. Tell the background to kill claude + blackout tool calls
  if (bgPort) { try { bgPort.postMessage({ type: "chat_stop" }); } catch {} }
  // 3. Close the streaming bubble cleanly
  streamingBubble = null;
  // 4. Tear down the live progress display
  endTaskStats();
  // 5. Reset all UI state
  setLoading(false);
  autoResumeCount = 0;
  autoResumeArmed = false; // a hard stop must never auto-resume
  stopBlackoutUntil = Date.now() + 3000;
  if (reason) appendError(reason);
}

const TOOL_LABELS = {
  // Browser core
  read_page: "قراءة العناصر", get_page_text: "استخراج النص",
  find: "بحث", click: "نقر", type_text: "كتابة",
  press_key: "ضغط مفتاح", form_input: "ملء حقل",
  screenshot: "لقطة شاشة", run_javascript: "JavaScript",
  scroll: "تمرير", navigate: "انتقال",
  hover: "تمرير الماوس", wait_for: "انتظار",
  select_option: "اختيار", list_tabs: "تبويبات",
  switch_tab: "تبديل تبويب", tabs_create: "تبويب جديد",
  tabs_context: "معلومات التبويب", tabs_overview: "عرض كلّ التبويبات",
  tabs_close: "إغلاق تبويب", drag: "سحب", file_upload: "رفع ملف",
  // DevTools
  read_console_messages: "قراءة Console",
  read_network_requests: "قراءة Network",
  read_page_errors: "قراءة الأخطاء",
  inspect_element: "فحص عنصر",
  read_storage: "قراءة Storage",
  read_performance: "قراءة Performance",
  clear_injected_scripts: "تنظيف السكربتات",
  // Pro Mode — Filesystem
  read_file: "قراءة ملف", write_file: "كتابة ملف", edit_file: "تعديل ملف",
  delete_file: "حذف ملف", list_directory: "قائمة المجلّد",
  find_files: "بحث عن ملفات", create_directory: "إنشاء مجلّد",
  get_working_directory: "مجلّد العمل",
  // Pro Mode — Shell + Docs
  run_command: "تنفيذ أمر",
  generate_pdf: "توليد PDF", save_json: "حفظ JSON", save_csv: "حفظ CSV",
  // Pro Mode — Git
  git_status: "حالة Git", git_diff: "Git diff", git_log: "Git log",
  git_blame: "Git blame", git_branches: "فروع Git",
  // Pro Mode — Code search
  grep_files: "بحث محتوى", find_symbol: "بحث رمز",
  find_references: "مراجع رمز", code_outline: "خريطة كود",
  // Pro Mode — HTTP
  http_fetch: "طلب HTTP", http_get_json: "GET JSON",
  // Pro Mode — Code Quality
  lint_file: "Lint", format_file: "Format", type_check: "فحص أنواع",
  // Pro Mode — SQLite
  sqlite_query: "استعلام SQLite", sqlite_schema: "Schema SQLite",
  // Pro Mode — Project memory
  update_project_state: "حفظ حالة المشروع",
};

let conversation = [];
// Cap for how many turns we keep in panel-side state (chat replay,
// edit-and-resend, history persistence). Independent of what the
// AGENT sees per-turn — that's governed by buildSmartHistory() in
// agent/max.js (first-2 + last-12 + marker). 100 here gives the user
// generous scrollback in marathon sessions without bloating
// chrome.storage. If you raise this, also revisit history.js
// chunking limits.
const MAX_HISTORY = 100;
let isLoading = false;
let streamingBubble = null;
// Smart-stop auto-resume (5.2): how many times the CURRENT task has
// auto-continued after hitting the benign action budget. Reset on every new
// user message, new chat, and normal completion. Bounded by MAX_AUTO_RESUMES
// so a task can extend itself for a long batch but never loop forever.
let autoResumeCount = 0;
// SAFETY (critical): auto-resume may ONLY fire as a direct continuation of a
// task the user actively started by sending a message in THIS live panel
// session. It is false on every fresh load — so a stale "resumable" result
// replayed via get_status after an extension reload can NEVER auto-run a task
// and open pages on its own. Armed only in send()/autoResume(); disarmed on
// done/stop/new-chat and whenever a stop is shown instead of resumed.
let autoResumeArmed = false;
// KILL SWITCH: auto-resume is DISABLED by default. It re-runs the agent
// without a fresh user message, which alarmed the user (pages opening after a
// reload). Off until it's been proven safe end-to-end; a long task simply
// stops at the budget and waits for the user to press "اكمل" — the known-safe
// behaviour. Flip to true (and reload) to re-enable the smart auto-continue.
const AUTO_RESUME_ENABLED = false;

// Token meter — cumulative tokens (input/context + output) across every turn
// of the CURRENT chat. Summed from each turn's `result` usage. Resets on a
// new chat (and on loading a stored one, whose historical usage we didn't
// persist). NOT a cost figure — the Max subscription is flat-rate; this is a
// "how heavy has this conversation gotten" gauge so the user knows when a
// fresh chat would run lighter.
const $tokenMeter = document.getElementById("tokenMeter");
let sessionInTok = 0;
let sessionOutTok = 0;
// Past this many cumulative tokens, nudge (amber) that a fresh chat is lighter.
const TOKEN_HEAVY_THRESHOLD = 150_000;

function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function resetTokenMeter() {
  sessionInTok = 0;
  sessionOutTok = 0;
  if ($tokenMeter) {
    $tokenMeter.hidden = true;
    $tokenMeter.classList.remove("is-heavy");
    $tokenMeter.textContent = "";
  }
}

// Add one completed turn's usage and refresh the meter. Defensive: any field
// may be absent depending on the CLI/runtime; missing usage → no-op.
function addTokenUsage(usage) {
  if (!usage || typeof usage !== "object" || !$tokenMeter) return;
  const inTok = (usage.input_tokens || 0)
    + (usage.cache_read_input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0);
  const outTok = usage.output_tokens || 0;
  if (inTok === 0 && outTok === 0) return;
  sessionInTok += inTok;
  sessionOutTok += outTok;
  const total = sessionInTok + sessionOutTok;
  $tokenMeter.textContent = `≈ ${formatTokens(total)} توكن`;
  $tokenMeter.classList.toggle("is-heavy", total >= TOKEN_HEAVY_THRESHOLD);
  $tokenMeter.hidden = false;
}

// ─────────────────────────────────────────────────────────────────────
// Live progress stats — surfaces real work during long agent runs.
//
// Without this, a 10-minute scrape session looked identical to a 5-
// second answer: just "Claude يفكّر...". The user lost trust ("is it
// stuck?", "did it crash?"). The stats line under the typing dots
// shows action count + last tool + elapsed seconds, updating once a
// second AND on every tool_start.
//
// Lifecycle:
//   • startTaskStats()    — called from send() AND from onBgMessage's
//                            resume path (panel reopened mid-task)
//   • bumpTaskStats(tool) — called from onBgMessage("tool_start")
//   • endTaskStats()      — called from done / error / hardStop
//
// Reset between tasks, hidden when not loading.
// ─────────────────────────────────────────────────────────────────────
const $typingStats = document.getElementById("typingStats");
let taskStats = null;

function startTaskStats() {
  // Cancel any leftover timer first — defensive against rapid
  // send → cancel → send sequences where end didn't fire cleanly.
  if (taskStats?.tickTimer) clearInterval(taskStats.tickTimer);
  taskStats = {
    startedAt: Date.now(),
    actionCount: 0,
    lastTool: null,
    tickTimer: setInterval(renderTaskStats, 1000),
  };
  renderTaskStats();
}

function bumpTaskStats(tool) {
  if (!taskStats) return;
  taskStats.actionCount++;
  if (typeof tool === "string" && tool) taskStats.lastTool = tool;
  renderTaskStats();
}

function endTaskStats() {
  if (taskStats?.tickTimer) clearInterval(taskStats.tickTimer);
  taskStats = null;
  if ($typingStats) {
    $typingStats.textContent = "";
    $typingStats.hidden = true;
  }
}

function renderTaskStats() {
  if (!$typingStats || !taskStats) return;
  const elapsedMs = Date.now() - taskStats.startedAt;
  const sec = Math.floor(elapsedMs / 1000);
  const elapsedStr = sec < 60
    ? `${sec}ث`
    : `${Math.floor(sec / 60)}د ${sec % 60}ث`;
  // Show a ticking elapsed counter after 3s even on a pure thinking turn
  // (no tools yet) — it's the clearest "I'm alive, not frozen" signal.
  // Below 3s the bouncing dots alone are enough; this avoids a stats row
  // flashing on every instant ("ما هو 2+2؟") answer.
  if (taskStats.actionCount === 0 && sec < 3) {
    $typingStats.hidden = true;
    return;
  }
  const toolLabel = taskStats.lastTool
    ? `📋 ${TOOL_LABELS[taskStats.lastTool] || taskStats.lastTool}`
    : "🤔 يفكّر…";
  const countPart = taskStats.actionCount > 0 ? ` • ${taskStats.actionCount} إجراء` : "";
  $typingStats.textContent = `${toolLabel}${countPart} • ${elapsedStr}`;
  $typingStats.hidden = false;
}

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
  // Three cases where !isLoading, each handled differently:
  //
  //   1. Post-stop residue. hardStop just fired; the dying subprocess
  //      may emit a few more text_delta / tool_results before it dies.
  //      Drop everything for 3 seconds so we don't resurrect the UI.
  //
  //   2. Panel resume. The user closed the panel (or the whole tab /
  //      browser) while a task was running, then reopened it. The bg
  //      replays the task's buffered messages via get_status. Outside
  //      the post-stop blackout, a live event arriving while idle is
  //      the resume signal — flip back to loading so the stop button
  //      works and incoming text_deltas render into a bubble.
  //
  //   3. no_task. Cheap signal that get_status found nothing. Keep.
  const postStopBlackout = Date.now() < stopBlackoutUntil;
  if (!isLoading && postStopBlackout && msg.type !== "no_task") return;
  if (!isLoading && !postStopBlackout &&
      (msg.type === "text_delta" || msg.type === "tool_start")) {
    // Resuming a task that started in a previous panel session.
    setLoading(true);
    removeWelcome();
    setTyping(true, "Claude يفكّر...");
    // Start the stats line fresh on resume — the original task's
    // counter is on the bg side and not synced; better to count
    // from now than show a misleading number.
    if (!taskStats) startTaskStats();
  }
  // After the resume path, idle + non-resume types still fall through
  // to the switch so `done` / `error` / `no_task` land correctly even
  // on a freshly-opened panel.

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
      bumpTaskStats(msg.tool);
      break;
    case "provider_info":
      // We don't display this anywhere — status header was removed.
      break;
    case "confirm_request":
      // Pro-Mode confirmation gate (1.3): the agent wants to run a
      // machine-modifying tool. Show a modal; the decision goes back over
      // the same port. No click within the timeout → host denies (fail-safe).
      showConfirmDialog(msg.confirmId, msg.summary, msg.tool);
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
      // Keep the turn's tool actions on the message so the next turn's history
      // can remind the model what it already did (C1 — see actionTrace).
      if (text) conversation.push({ role: "assistant", content: text, toolActions: msg.toolActions || [] });
      endTaskStats();
      addTokenUsage(msg.usage);
      setLoading(false);
      autoResumeCount = 0; // task completed normally — clear the resume budget
      autoResumeArmed = false;
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
      // Smart stop: a BENIGN budget hit (long task, still progressing) is
      // flagged resumable — continue it automatically instead of nagging.
      // Loops / error streaks / timeouts aren't resumable, so they fall
      // through and stop as before.
      // ONLY auto-resume a LIVE, in-session, user-initiated task (armed +
      // currently loading). This is what stops a stale resumable result —
      // replayed after an extension reload — from re-running a task and
      // opening pages unprompted.
      if (AUTO_RESUME_ENABLED && isLoading && autoResumeArmed && shouldAutoResume(msg, autoResumeCount)) {
        autoResumeCount++;
        endTaskStats();
        showNotice(`المهمة طويلة — أُكملها تلقائيّاً (${autoResumeCount}/${MAX_AUTO_RESUMES})…`,
          { variant: "info", ms: 3000 });
        autoResume();
        break;
      }
      appendError(msg.text || "خطأ غير معروف");
      endTaskStats();
      setLoading(false);
      autoResumeCount = 0;
      autoResumeArmed = false;
      break;
    case "no_task":
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Pro-Mode confirmation dialog (1.3)
//
// A modal that blocks on a human decision before a machine-modifying Pro
// tool (write_file / edit_file / delete_file / run_command) runs. The
// summary/tool come from the host; render them with textContent (never
// innerHTML) so a crafted path or command string can't inject markup.
// Deny is the safe default: it gets focus, Esc denies, and if the user
// never answers the host's gate times out and denies anyway.
// ─────────────────────────────────────────────────────────────────────
function showConfirmDialog(confirmId, summary, tool) {
  document.getElementById("confirmOverlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "confirmOverlay";
  overlay.className = "confirm-overlay";
  overlay.setAttribute("role", "alertdialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.innerHTML = `
    <div class="confirm-card">
      <div class="confirm-head">🔒 تأكيد إجراء Pro Mode</div>
      <div class="confirm-tool"></div>
      <div class="confirm-summary"></div>
      <div class="confirm-note">طلبت الإضافة تنفيذ إجراء يُعدّل جهازك. وافق فقط إذا كنت تتوقّعه.</div>
      <div class="confirm-actions">
        <button class="confirm-deny" type="button">رفض</button>
        <button class="confirm-approve" type="button">موافقة</button>
      </div>
    </div>`;
  overlay.querySelector(".confirm-tool").textContent = tool || "";
  overlay.querySelector(".confirm-summary").textContent = summary || "";

  let settled = false;
  const decide = (approved) => {
    if (settled) return;
    settled = true;
    try { bgPort?.postMessage({ type: "confirm_decision", confirmId, approved }); } catch {}
    overlay.remove();
  };
  overlay.querySelector(".confirm-approve").addEventListener("click", () => decide(true));
  overlay.querySelector(".confirm-deny").addEventListener("click", () => decide(false));
  overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") decide(false); });

  document.body.appendChild(overlay);
  overlay.querySelector(".confirm-deny").focus(); // focus the SAFE option
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
// parseTasks lives in src/lib/parse-tasks.ts — 27 unit tests cover
// both shapes, `:` vs `=`, comments, \r\n, malformed-input handling.

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

function appendUser(text, msgIdx, images = []) {
  appendUserMessage(text, images, msgIdx);
}

// ─────────────────────────────────────────────────────────────────────
// In-place editor for sent user messages (ChatGPT-style).
//
// Click ✎ → bubble transforms into textarea + [حفظ] [إلغاء].
// Save   → every subsequent DOM bubble is removed, conversation[] is
//          truncated to the edited slot, and send() fires the new
//          text. Claude sees a fresh context — the old assistant
//          reply is gone from both UI and future requests.
// Cancel → the bubble snaps back to its original rendered state.
//
// Images on the original bubble are dropped on save (pendingImages is
// always empty at edit time). The common edit-and-resend use case is
// text-only, so this is a simplification worth its weight.
// ─────────────────────────────────────────────────────────────────────
function attachEditButton(parent, msgIdx) {
  const btn = document.createElement("button");
  btn.className = "edit-ico";
  btn.title = "تعديل وإعادة الإرسال";
  btn.setAttribute("aria-label", "تعديل الرسالة");
  btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    // `parent` is the .msg-actions column — enterEditMode needs the
    // outer .msg-wrap (where .msg and .msg-text actually live).
    // Climb up at click time instead of closing over `parent`, which
    // would break if the DOM structure changes again later.
    const msgWrap = btn.closest(".msg-wrap");
    if (msgWrap) enterEditMode(msgWrap, msgIdx);
  });
  parent.appendChild(btn);
}

function enterEditMode(wrap, msgIdx) {
  const msgEl = wrap.querySelector(".msg");
  if (!msgEl) return;
  const textEl = wrap.querySelector(".msg-text");

  // Original text — empty string for image-only bubbles, which are now
  // editable too (user can add a caption or paste another image).
  const originalText = textEl ? textEl.textContent : "";

  // Pull the original full-resolution images if we still have them
  // (cached in-memory for the last EDIT_FULL_RES_CACHE_MAX user turns).
  // Older messages — or any message after a panel reload — fall back to
  // the 400-px thumbnails persisted in conversation[]. Both are valid
  // { mediaType, base64 } shapes, so the rest of this code stays uniform.
  // editImages is the LIVE list driving the UI: × removes, paste adds.
  const cached = getFullResImages(msgIdx);
  const fallback = (conversation[msgIdx]?.images || []).map((im) => ({ ...im }));
  let editImages = cached || fallback;

  // Build the editor UI.
  const editor = document.createElement("div");
  editor.className = "edit-box";

  // Image chip strip — shown above the textarea so the user sees what
  // attachments will ride along on resend. Each chip has its own ×
  // button that mutates editImages by reference and re-renders.
  const imagesRow = document.createElement("div");
  imagesRow.className = "edit-images";
  function renderEditImages() {
    imagesRow.innerHTML = "";
    if (!editImages.length) {
      imagesRow.style.display = "none";
      return;
    }
    imagesRow.style.display = "";
    for (const img of editImages) {
      const chip = document.createElement("div");
      chip.className = "edit-image-chip";
      const thumb = document.createElement("img");
      thumb.src = `data:${img.mediaType};base64,${img.base64}`;
      chip.appendChild(thumb);
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "edit-image-remove";
      rm.textContent = "×";
      rm.title = "إزالة";
      rm.addEventListener("click", (e) => {
        e.preventDefault();
        // Identity-based removal so a paste-mid-edit can't shift indices
        // and remove the wrong chip.
        const i = editImages.indexOf(img);
        if (i >= 0) editImages.splice(i, 1);
        renderEditImages();
      });
      chip.appendChild(rm);
      imagesRow.appendChild(chip);
    }
  }
  renderEditImages();
  editor.appendChild(imagesRow);

  const ta = document.createElement("textarea");
  ta.className = "edit-textarea";
  ta.value = originalText;
  ta.dir = "rtl";
  // image-only bubbles open with an empty textarea — placeholder gives
  // the user a hint that adding a caption is the natural next move.
  if (!originalText) ta.placeholder = "أضف نصّاً مع الصورة...";

  // Paste-to-attach inside the editor mirrors the main composer's
  // behaviour: clipboard images get pushed onto editImages, NOT the
  // global pendingImages, so cancelling the edit leaves no stray
  // attachments behind. The main composer's paste handler is bound
  // to $input only, so it doesn't fire here — we add our own.
  ta.addEventListener("paste", async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    let added = 0;
    for (const it of items) {
      if (!String(it.type || "").startsWith("image/")) continue;
      const mediaType = it.type || "image/png";
      const blob = it.getAsFile();
      if (!blob) continue;
      if (editImages.length + 1 > MAX_IMAGE_COUNT) {
        showNotice(`لا يمكن إرفاق أكثر من ${MAX_IMAGE_COUNT} صور.`);
        break;
      }
      if (blob.size > MAX_PER_IMAGE_BYTES) {
        showNotice("الصورة أكبر من 10MB — جرّب ضغطها أوّلاً.");
        continue;
      }
      try {
        const base64 = await blobToBase64(blob);
        editImages.push({ mediaType: mediaType || blob.type || "image/png", base64 });
        added++;
      } catch {}
    }
    if (added) renderEditImages();
  });
  const actions = document.createElement("div");
  actions.className = "edit-actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";   // default is "submit" — harmless standalone but clearer intent
  saveBtn.className = "edit-save";
  saveBtn.textContent = "إرسال";
  saveBtn.title = "Enter";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "edit-cancel";
  cancelBtn.textContent = "إلغاء";
  cancelBtn.title = "Escape";
  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);
  editor.appendChild(ta);
  editor.appendChild(actions);

  // Swap bubble for editor — keep the edit/copy icons out of the way.
  // .editing on the wrap makes it take the full panel width so the
  // editor isn't squeezed into the original bubble's silhouette.
  wrap.classList.add("editing");
  msgEl.style.display = "none";
  const editIco = wrap.querySelector(".edit-ico");
  const copyIco = wrap.querySelector(".copy-ico");
  if (editIco) editIco.style.display = "none";
  if (copyIco) copyIco.style.display = "none";
  wrap.appendChild(editor);

  // Professional edit-box sizing: measure the existing content ONCE
  // at open and lock the height there. Typing more falls back to
  // internal scroll instead of growing the box — this is the key to
  // keeping the [إلغاء] [إرسال] row in a fixed position while the
  // user edits. field-sizing: content (the earlier approach) made
  // the row jump every time a line wrapped.
  //
  // Floor 80 px so a one-word message doesn't produce a cramped
  // editor; ceiling 280 px so a giant paste doesn't eat the whole
  // chat column.
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  // Measure AFTER appending to DOM, otherwise scrollHeight is 0.
  // Cap raised from 280 to 480 after dogfood feedback — users want
  // to see the whole message at once when editing, not scroll inside
  // a peephole searching for the word they came to fix.
  ta.style.height = "auto";
  const measured = Math.max(80, Math.min(ta.scrollHeight + 2, 480));
  ta.style.height = measured + "px";

  const cancel = () => {
    editor.remove();
    wrap.classList.remove("editing");
    msgEl.style.display = "";
    if (editIco) editIco.style.display = "";
    if (copyIco) copyIco.style.display = "";
  };
  const save = () => {
    const newText = ta.value.trim();
    // Allow text-only OR image-only — only stay in edit mode when BOTH
    // are empty. Sending an image with no caption is a legitimate use
    // case (e.g. "describe this" follow-ups via the chip).
    if (!newText && !editImages.length) return;
    // إرسال always resends — even with no text change. That way the
    // button does exactly what its label says, and users who want a
    // fresh attempt on the same prompt get "regenerate" for free.
    commitEdit(wrap, msgIdx, newText, editImages);
  };

  saveBtn.addEventListener("click", save);
  cancelBtn.addEventListener("click", cancel);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); }
    else if (e.key === "Escape")          { e.preventDefault(); cancel(); }
  });
  // No input listener needed — field-sizing: content handles growth.
}

function commitEdit(wrap, msgIdx, newText, editImages) {
  // If a task is currently streaming, the user pressing save is
  // basically "forget that, here's my new question" — stop the task
  // first, same pattern send() uses for overlap.
  if (isLoading) {
    hardStop("");
    setTimeout(() => performEdit(wrap, msgIdx, newText, editImages), 150);
  } else {
    performEdit(wrap, msgIdx, newText, editImages);
  }
}

function performEdit(wrap, msgIdx, newText, editImages) {
  // 1. Peel every DOM node after the edited bubble (and the bubble
  //    itself) — includes tool-lines, screenshots, error bubbles,
  //    later user/assistant bubbles. send() below re-adds the
  //    current edited turn from scratch.
  let node = wrap.nextSibling;
  while (node) {
    const nxt = node.nextSibling;
    node.remove();
    node = nxt;
  }
  wrap.remove();

  // 2. Truncate conversation[] to everything BEFORE the edited slot.
  //    send() will push the new user message at exactly msgIdx, so
  //    the DOM data-msg-idx links stay stable for earlier bubbles.
  if (Number.isFinite(msgIdx) && msgIdx >= 0 && msgIdx <= conversation.length) {
    conversation = conversation.slice(0, msgIdx);
  }
  // Drop full-res cache entries at or after the edited slot — those
  // images belonged to turns that no longer exist. The fresh send()
  // below will re-cache the new turn at the same msgIdx.
  dropFullResImagesFrom(msgIdx);

  // 3. Persist the truncated state before firing the request — matches
  //    how send() saves on completion.
  saveHistory();

  // 4. Stage the images the user kept (or pasted in mid-edit) into the
  //    composer's pendingImages, then replay through the normal send
  //    path. send() reads pendingImages, resets it, and ships the
  //    images to Claude alongside the new text — same wire format as
  //    a fresh send. This is the whole point of the edit-with-images
  //    UI: previously this line set pendingImages to [] implicitly and
  //    Claude got a text-only retry.
  if (editImages && editImages.length) {
    pendingImages = editImages.map((im) => ({ ...im }));
    renderAttachments();
  }
  $input.value = newText;
  $input.dispatchEvent(new Event("input"));
  send();
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
function appendUserMessage(text, images, msgIdx) {
  if (!text && (!images || images.length === 0)) return;
  removeWelcome();
  const wrap = makeMessageWrap("user");
  // msgIdx links the DOM bubble back to its slot in conversation[] so
  // the edit button can truncate correctly. At send() time the push
  // into conversation happens AFTER this call, so conversation.length
  // IS the upcoming slot. When replaying history, the caller already
  // knows the index and passes it explicitly.
  const idx = (typeof msgIdx === "number") ? msgIdx : conversation.length;
  wrap.dataset.msgIdx = String(idx);
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
  // Action column: copy + edit. Edit is offered for any bubble — even
  // image-only — so the user can add a caption or replace the screenshot
  // and resend without starting over. Copy stays gated on text presence
  // (image clipboard is browser-clumsy; out of scope here).
  const hasMedia = !!(images && images.length);
  if (text || hasMedia) {
    const actions = document.createElement("div");
    actions.className = "msg-actions";
    if (text) attachCopyButton(actions, () => text);
    attachEditButton(actions, idx);
    wrap.appendChild(actions);
  }
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
  for (const a of actions) {
    const lbl = TOOL_LABELS[a.tool] || a.tool;
    const key = a.error ? `!${lbl}` : lbl;
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push({ label: lbl, error: !!a.error });
  }
  if (labels.length === 0) return;

  const line = document.createElement("div");
  line.className = "tool-line";
  line.innerHTML = labels
    .map((l) => `<span class="${l.error ? "t-bad" : "t-ok"}">${l.error ? "✗" : "✓"} ${l.label}</span>`)
    .join(`<span class="t-sep">·</span>`);
  $messages.appendChild(line);
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
// Continue a long task automatically after a benign budget stop (smart stop).
// Mirrors send()'s core minus the UI/input/image machinery: it appends an
// ephemeral "continue" instruction (NOT persisted, so reopening the chat stays
// clean) and re-issues the query against the existing conversation. The page
// is already in its advanced state, so the agent re-reads and picks up where
// it left off — exactly what a manual "اكمل" does, just without the nag.
function autoResume() {
  autoResumeArmed = true; // stay armed across the bounded continuation
  setLoading(true);
  setTyping(true, "أُكمل المهمة…");
  streamingBubble = null;
  startTaskStats();
  if (!bgPort) connectBg();
  const sent = conversation.map((m) => ({
    role: m.role,
    content: m.role === "assistant" && typeof m.content === "string"
      ? m.content + actionTrace(m.toolActions)
      : m.content,
  }));
  sent.push({ role: "user", content: "تابِع إكمال المهمة من حيث توقفت، دون إعادة ما أنجزته." });
  bgPort.postMessage({ type: "chat_send", messages: sent });
}

async function send() {
  const text = $input.value.trim();
  const hasImages = pendingImages.length > 0;
  if (!text && !hasImages) return;
  autoResumeCount = 0; // a real new user message starts a fresh task
  autoResumeArmed = true; // only NOW is auto-resume allowed (live user task)

  // Speech recognition cleanup. If the user hits send while the mic is
  // still listening, three things need to happen before we continue:
  //   • userWants = false  — so onend doesn't auto-restart the session
  //   • recog.stop()       — actually close the audio stream
  //   • reset prefix/suffix/committed — otherwise an in-flight onresult
  //     rebuilds $input.value from the old voice state and re-populates
  //     the box we're about to clear on send.
  // The listening class and typing indicator clear via onend shortly
  // after; that's fine because we re-set typing below.
  if (userWants || micActive()) {
    userWants = false;
    prefix = "";
    suffix = "";
    committed = "";
    if (micState !== "STOPPING" && micState !== "IDLE") setMicState("STOPPING");
    try { recog?.stop(); } catch {}
  }

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

  // Snapshot the upcoming user-message slot — populated AFTER we cache so
  // a later ✎ edit on this bubble can pull the original full-res pixels
  // instead of the 400-px thumbnails that conversation[] persists.
  const upcomingMsgIdx = conversation.length;
  if (images.length) cacheFullResImages(upcomingMsgIdx, images);

  // One unified bubble for text + attached images — matches mainstream
  // chat UX (WhatsApp/Telegram/ChatGPT).
  if (text || images.length) appendUserMessage(text, images);

  // Build the message we'll persist. Full-resolution images go to
  // Claude in the same turn via the separate `images` field below;
  // here we only store thumbnail-sized copies so reopening a saved
  // chat shows the user's screenshots again without exploding the
  // chrome.storage.local 10 MB quota. Awaited inline to guarantee
  // the previews land in this message's slot before saveHistory().
  const userMsg = { role: "user", content: text };
  if (images.length) {
    const previews = await Promise.all(
      images.map((im) => makeImagePreview(im.mediaType, im.base64)),
    );
    const thumbs = previews.filter(Boolean);
    if (thumbs.length) userMsg.images = thumbs;
  }
  conversation.push(userMsg);
  // Cap history but PIN the first turn (the goal). slice(-MAX_HISTORY) used to
  // drop the original objective once a chat passed 100 messages, so by msg 200
  // the model lost the "why". capConversation keeps the first 2 + the most
  // recent, so buildSmartHistory's first-2 stays the true goal even in a
  // marathon chat — no Pro Mode required.
  conversation = capConversation(conversation, MAX_HISTORY);
  $input.value = "";
  $input.style.height = "auto";
  updateSend();

  currentCancel = { aborted: false };

  // Text-pattern local shortcuts removed by user request. Every typed
  // prompt now goes to Claude. The quick-action chips in .quick-row
  // and the user-defined ⚡ tasks in .tasks-row still work — they're
  // button clicks that call runLocal() directly with a known action,
  // without guessing intent from text.

  setLoading(true);
  setTyping(true, "Claude يفكّر...");
  streamingBubble = null;
  startTaskStats();

  if (!bgPort) connectBg();
  bgPort.postMessage({
    type: "chat_send",
    // Strip the stored thumbnails from history before it goes to
    // Claude: they exist only for panel replay, and shipping them
    // would waste vision tokens on every subsequent turn AND
    // double-count images we already forwarded at full resolution
    // on the turn they were pasted.
    messages: conversation.map((m) => ({
      role: m.role,
      // Append a compact trace of the tools an assistant turn ran, so the
      // model remembers across turns what it already did (C1). UI bubbles are
      // unaffected — they render m.content; the trace only rides the history.
      content: m.role === "assistant" && typeof m.content === "string"
        ? m.content + actionTrace(m.toolActions)
        : m.content,
    })),
    images,  // current turn's full-resolution images go here
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
        // mediaType is now driven by what cdp.takeScreenshot actually
        // produced. Hardcoding "image/jpeg" used to ship PNG bytes with
        // a JPEG label — Claude vision tolerates it but sees a noisy
        // image, which is one of the suspects for the X.com → "Claude
        // logo" hallucination. We pass through whatever the host says.
        const mt = r.screenshotMediaType || "image/jpeg";
        if (pendingImages.length < MAX_IMAGE_COUNT) {
          pendingImages.push({ mediaType: mt, base64: r.screenshot });
          renderAttachments();
          // Update send button enable state — pendingImages now non-empty.
          $send.disabled = !$input.value.trim() && pendingImages.length === 0;
          // Visible diagnostic — proves to the user (no DevTools needed)
          // that a real image really did get attached, what format it is,
          // and how big it is. If they ever see "JPEG ~110KB" instead of
          // "PNG ~600KB" they know the high-quality path didn't run
          // (i.e. they need to reload the extension).
          const kb = Math.round((r.screenshot.length * 0.75) / 1024);  // base64 → bytes ≈ 0.75
          const fmt = mt.split("/")[1].toUpperCase();
          showNotice(`✓ التُقطت صورة: ${fmt} ~${kb}KB — مرفقة بالرسالة التالية`,
            { variant: "info", ms: 3500 });
        } else {
          showNotice(`لا يمكن إرفاق أكثر من ${MAX_IMAGE_COUNT} صور — أرسل الحالية أوّلاً.`);
        }
      }
      if (r?.text) {
        appendAssistantBubble(r.text);
        conversation.push({ role: "assistant", content: r.text, toolActions: r.toolActions || [] });
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
//   • mic active             → stop mic only (preserve text, don't send)
//   • empty input + loading  → stop the running Claude task
//   • empty input + idle     → (disabled, no-op)
//   • text present           → send (which auto-cancels any running task)
//
// The mic-first branch exists because the old behavior surprise-sent
// partial voice transcripts: user was speaking, pressed what looked
// like a stop button, and their mid-sentence interim text ("احجز لي
// طيران للـ...") shipped to Claude as a real question. Two-click
// model is cleaner: first click stops listening + keeps text for
// review; second click (with text) is an explicit send.
$send.addEventListener("click", () => {
  if (micActive() || userWants) {
    userWants = false;
    if (micState !== "STOPPING" && micState !== "IDLE") setMicState("STOPPING");
    try { recog?.stop(); } catch {}
    return;
  }
  const hasContent = $input.value.trim() || pendingImages.length > 0;
  if (!hasContent && isLoading) { hardStop(""); return; }
  if (!hasContent) return;
  send();
});
$input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    // Same mic-first rule as the button: Enter while the mic is
    // listening = stop listening, don't commit the partial transcript.
    if (micActive() || userWants) {
      userWants = false;
      if (micState !== "STOPPING" && micState !== "IDLE") setMicState("STOPPING");
      try { recog?.stop(); } catch {}
      return;
    }
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
      // Capture mediaType + blob SYNCHRONOUSLY before any await.
      // DataTransferItem objects are revoked the moment the paste
      // event handler returns, so reading `it.type` after the
      // `await blobToBase64` below silently yielded "" — the image
      // arrived at the native host with an empty mediaType, tripped
      // the /^image\/(png|jpeg|...)$/ filter, and got dropped.
      // blob.type is a safer fallback because Blob objects are
      // heap-allocated and survive the event.
      const mediaType = it.type || "";
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
        pendingImages.push({ mediaType: mediaType || blob.type || "image/png", base64 });
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

// Drag-and-drop image attach. Mirrors the paste handler: same caps,
// same target list, same render. Bound to the whole .app container
// (not just the input) so users can drop anywhere over the panel —
// the input's own drop area is too small to aim at confidently.
//
// Why we needed this on top of paste: pasting requires the file to
// already be on the clipboard, which means an extra "copy file" step
// before opening the panel. Drag-from-Files-Explorer is the natural
// gesture and was the gap callers were hitting.
const DROP_TARGET = $app || document.body;

function preventDefaultDrag(e) {
  // dragenter/dragover MUST preventDefault for the drop event to fire
  // at all — without it the browser default (load file in new tab)
  // wins and the user gets navigated away from the panel.
  if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) {
    e.preventDefault();
    e.stopPropagation();
  }
}
DROP_TARGET.addEventListener("dragenter", preventDefaultDrag);
DROP_TARGET.addEventListener("dragover", preventDefaultDrag);

DROP_TARGET.addEventListener("drop", async (e) => {
  const files = e.dataTransfer?.files;
  if (!files || !files.length) return;
  e.preventDefault();
  e.stopPropagation();
  let rejectedBig = 0;
  let rejectedFull = 0;
  let added = 0;
  for (const f of files) {
    if (!String(f.type || "").startsWith("image/")) continue;
    if (pendingImages.length >= MAX_IMAGE_COUNT) { rejectedFull++; continue; }
    if (f.size > MAX_PER_IMAGE_BYTES) { rejectedBig++; continue; }
    try {
      const base64 = await blobToBase64(f);
      pendingImages.push({ mediaType: f.type || "image/png", base64 });
      added++;
    } catch {}
  }
  if (added) {
    renderAttachments();
    $send.disabled = !$input.value.trim() && pendingImages.length === 0;
    showNotice(
      `✓ أُضيفت ${added} صورة من السحب — مرفقة بالرسالة التالية`,
      { variant: "info", ms: 3500 },
    );
  }
  if (rejectedBig)  showNotice(`تم تجاهل ${rejectedBig} صورة أكبر من 10MB.`);
  if (rejectedFull) showNotice(`الحد الأقصى ${MAX_IMAGE_COUNT} صور — أرسل الحالية أوّلاً.`);
});

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

// Shrink a pasted image down to a thumbnail-sized copy so we can
// persist it with the conversation. Full-resolution originals are
// still sent to Claude in the same turn — this copy is only for
// re-rendering past bubbles when the user reopens a saved chat.
//
// Why this exists: conversation[] is written to chrome.storage.local
// on every turn (quota ≈ 10 MB). Saving 8 × 10 MB full images would
// blow the quota on a single message. A 400-px JPEG is typically
// 15-30 KB, so a whole chat of screenshot-heavy turns fits easily.
//
// Best-effort: returns null on decode/encode failure. Callers drop
// null previews silently — the message still saves, just without
// that specific image's preview.
async function makeImagePreview(mediaType, base64, maxDim = 400, quality = 0.7) {
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = `data:${mediaType};base64,${base64}`;
    });
    const scale = Math.min(maxDim / img.width, maxDim / img.height, 1);
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    const b64 = dataUrl.split(",")[1] || "";
    if (!b64) return null;
    return { mediaType: "image/jpeg", base64: b64 };
  } catch {
    return null;
  }
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
const $modelSelect = document.getElementById("modelSelect");
const $tasksInput = document.getElementById("tasksInput");
const $saveSettingsBtn = document.getElementById("saveSettingsBtn");
const $settingsToast = document.getElementById("settingsToast");
// Pro Mode UI handles
const $proModeToggle = document.getElementById("proModeToggle");
const $workingDirInput = document.getElementById("workingDirInput");
const $proModeStatus = document.getElementById("proModeStatus");
const $proModeBadge = document.getElementById("proModeBadge");

async function openSettings() {
  // Pull the latest values at open time so edits made elsewhere (e.g. a
  // restore from the native-host backup that ran while the panel was open)
  // are reflected.
  const { memories = "", tasks = "", proMode = false, workingDirectory = "", modelSpeed = "powerful" } =
    await chrome.storage.local.get(["memories", "tasks", "proMode", "workingDirectory", "modelSpeed"]);
  $memoriesInput.value = memories;
  if ($modelSelect) $modelSelect.value = modelSpeed;
  $tasksInput.value = tasks;
  $proModeToggle.checked = !!proMode;
  $workingDirInput.value = workingDirectory;
  $proModeStatus.hidden = true;
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
  const proMode = !!$proModeToggle.checked;
  const workingDirectory = $workingDirInput.value.trim();
  const modelSpeed = $modelSelect?.value || "powerful";

  // ALWAYS save — never block on validation. The previous version
  // refused the save when Pro Mode was on without a working directory,
  // showed a small inline error, and returned. Users reported this as
  // "the save button is broken" because the toast never appeared and
  // the toggle silently bounced back to whatever was on disk before.
  //
  // New rule: persist what the user typed. If the configuration is
  // incomplete (Pro Mode on but no working dir, or relative path),
  // surface a WARNING in the status line — the actual tool calls will
  // refuse with a clear message anyway, so we can't end up in an
  // unsafe state. UX > silent rejections.
  await chrome.storage.local.set({ memories, tasks, proMode, workingDirectory, modelSpeed });
  // Mirror to native-host backup file so settings survive extension
  // uninstall AND so the MCP server can read them on each tool call.
  // The MCP server lives in a different process and consults
  // ~/.config/claude-companion/user-data.json on every Pro-Mode tool
  // invocation to validate the flag — that file IS this mirror.
  try {
    chrome.runtime.sendMessage({
      type: "mirror_user_data",
      data: { memories, tasks, proMode, workingDirectory },
    });
  } catch {}
  // Reload the task chips row since it's driven by `tasks`.
  try { await loadTasks(); } catch {}
  // Update header badge.
  refreshProModeBadge();

  // Surface configuration warnings — non-blocking.
  let warning = "";
  if (proMode) {
    if (!workingDirectory) {
      warning = "⚠ Pro Mode فعّال لكن مجلّد العمل فارغ — لن تعمل أدوات الملفّات حتّى تحدّده.";
    } else if (!/^([A-Za-z]:[\\\/]|\/)/.test(workingDirectory)) {
      warning = "⚠ مسار غير مطلق — استخدم مسارَ كاملاً مثل C:\\Users\\fix\\Desktop\\my-project.";
    } else if (/^([A-Za-z]:[\\\/]?$|\/$)/.test(workingDirectory)) {
      warning = "⚠ جذر القرص مرفوض لأمان — اختر مجلّداً فرعياً.";
    }
  }
  // The status line is for PROBLEMS only. On a clean save we stay
  // silent: the toast confirms persistence, the header badge + the
  // checked toggle show Pro Mode is on, and the path is right there in
  // the field above — echoing it again (with bidi-mangled Arabic+path)
  // added noise, not information.
  if (warning) {
    $proModeStatus.textContent = warning;
    $proModeStatus.style.color = "var(--accent)";
    $proModeStatus.hidden = false;
  } else {
    $proModeStatus.hidden = true;
  }

  // Toast confirmation — ALWAYS shows on save, regardless of warnings.
  // The toast confirms persistence; warnings (above) explain caveats.
  $settingsToast.hidden = false;
  setTimeout(() => { $settingsToast.hidden = true; }, 1800);
}

async function refreshProModeBadge() {
  const { proMode = false } = await chrome.storage.local.get("proMode");
  if ($proModeBadge) $proModeBadge.hidden = !proMode;
}

// Show / hide the badge on first load too.
refreshProModeBadge();

// Clicking the badge opens settings — fastest path to flip Pro Mode off.
$proModeBadge?.addEventListener("click", openSettings);

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
          : escapeHtml(raw).replace(/\n/g, "<br>");
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

// deriveTitle lives in src/lib/derive-title.ts — 21 unit tests cover
// every fallback branch, markdown noise stripping, whitespace
// collapsing, and the 40-char cap.

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
  // Per-turn usage isn't persisted, so a reopened/loaded chat starts the
  // meter fresh — it'll reflect tokens from the next turn onward rather than
  // show a misleading number.
  resetTokenMeter();
  // Pass the loop index as msgIdx so each replayed user bubble keeps
  // its link back to conversation[] (used by the edit button).
  // m.images (thumbnails generated by makeImagePreview at send time)
  // are passed through so reopened chats show the screenshots the
  // user pasted, not just bare text bubbles.
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user") appendUser(m.content, i, m.images || []);
    else appendAssistantBubble(m.content);
  }
}

// ─────────────────────────────────────────────────────────────────────
// History overlay — opens on 🕐, lists saved conversations
// ─────────────────────────────────────────────────────────────────────
// formatRelative lives in src/lib/format-relative.ts — 15 unit tests
// pin `now` to verify every bucket boundary (الآن / دقيقة / ساعة / يوم).

// buildSnippet lives in src/lib/search-snippet.ts — 21 unit tests
// cover fallbacks, context windowing, ellipsis rules, case-insensitive
// matching, and HTML-escaping edge cases including Arabic text.

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
  autoResumeCount = 0;
  autoResumeArmed = false;
  resetTokenMeter();

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
//
// State machine — exactly one of these at any moment:
//   IDLE       — mic off
//   STARTING   — clicked start, waiting for onstart (or async permission)
//   LISTENING  — onstart fired, actively transcribing
//   STOPPING   — clicked stop or send() ran, waiting for onend
//   DISABLED   — permanent error (no permission, no mic, no support)
//
// `userWants` is the auto-restart hint read in onend: if the recogniser
// times out the audio session itself (Chrome does this every ~60 s) and
// the user still wants to listen, onend kicks off a new session
// transparently. Without this the mic would silently stop every minute.
// ─────────────────────────────────────────────────────────────────────
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null;
let micState = "IDLE";        // IDLE | STARTING | LISTENING | STOPPING | DISABLED
let userWants = false;        // user pressed start and hasn't pressed stop
let committed = "";           // recogniser's accumulated final transcripts (since last cursor sync)
let prefix = "";              // text BEFORE the caret at the moment dictation last anchored
let suffix = "";              // text AFTER  the caret at the moment dictation last anchored
let maxListenTimer = null;
const MAX_LISTEN_MS = 60_000;
// Cursor model:
//   The recogniser doesn't know where the caret is. We capture the
//   user's current caret position into (prefix, suffix) on every event
//   that could move the caret (click, arrow key, focus, manual edit,
//   mic-start). Each onresult then renders as
//       prefix + (committed + interim) + suffix
//   with the caret pinned to the END OF THE INSERTION so subsequent
//   speech continues where it just left off.
//
// User's complaint that motivated this: "I delete a word in the middle,
// leave the cursor there to dictate the replacement, and the new speech
// gets appended to the END instead". Pre-fix: only `baseline` existed
// and onresult always wrote `baseline + committed + interim` — caret
// position was ignored entirely.
// Set briefly while onresult writes to $input.value so the manual-edit
// detector below can ignore that programmatic write. Real user keystrokes
// (delete, type, paste) go through the same input event but with
// voiceWriting=false, which is how we tell them apart.
let voiceWriting = false;
// Auto-retry budget for transient network errors. Resets on every
// successful onstart so a stable session doesn't burn the budget.
let networkRetriesLeft = 1;
function setMicState(next) {
  micState = next;
  $mic.classList.toggle("listening", next === "LISTENING");
  $mic.classList.toggle("starting",  next === "STARTING");
  $mic.classList.toggle("stopping",  next === "STOPPING");
  // DISABLED is the only state that hard-disables the click — the others
  // are all interactive (you can always click to toggle). Don't include
  // STARTING/STOPPING here: a click during those is "user changed their
  // mind", which we want to honour, not block.
  $mic.disabled = (next === "DISABLED");
}
function micActive() {
  // "is the mic in any active state?" — true for the whole STARTING →
  // LISTENING → STOPPING range. Used at the top of click + send flows
  // to decide between toggle-stop and toggle-start.
  return micState === "STARTING" || micState === "LISTENING" || micState === "STOPPING";
}

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
    setMicState("DISABLED");
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
    setMicState("LISTENING");
    setTyping(true, "يستمع...");
    // A successful start clears the per-session retry budget so a stable
    // multi-minute session won't accidentally fail-open to retry-loop
    // behaviour after the next blip.
    networkRetriesLeft = 1;
  };

  // Cursor-position sync. Every event that could MOVE the caret while
  // the mic is on (click, arrow key, focus, typed/deleted character)
  // re-anchors dictation: future speech inserts at the new caret
  // position instead of appending to the end.
  //
  //   • input    — user typed/pasted/deleted (also fires for our own
  //                programmatic value writes; we filter those with
  //                voiceWriting).
  //   • keyup    — covers arrow-key / Home / End / Ctrl+A — none of
  //                these fire input events.
  //   • mouseup  — click that places the caret elsewhere.
  //   • focus    — user tabbed back into the box; selectionStart/End
  //                already reflect the resumed caret position.
  //
  // selectionchange would be the "correct" Web API but it fires on
  // document and includes our own programmatic setSelectionRange,
  // which would feedback-loop. The four events above cover every
  // user-driven case without that risk.
  function syncVoiceCaret() {
    if (!micActive() && !userWants) return;
    if (voiceWriting) return;
    const start = $input.selectionStart ?? $input.value.length;
    const end   = $input.selectionEnd   ?? start;
    prefix = $input.value.slice(0, start);
    suffix = $input.value.slice(end);
    committed = "";
  }
  $input.addEventListener("input",   syncVoiceCaret);
  $input.addEventListener("keyup",   syncVoiceCaret);
  $input.addEventListener("mouseup", syncVoiceCaret);
  $input.addEventListener("focus",   syncVoiceCaret);

  recog.onresult = (e) => {
    // Discard any onresult that arrives after send() (or the user)
    // already turned userWants off. Web Speech sometimes fires a last
    // buffered frame between stop() and onend; without this guard that
    // frame writes the old transcript back into a freshly-cleared input.
    if (!userWants) return;
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) committed += r[0].transcript;
      else interim += r[0].transcript;
    }

    // Whitespace hygiene at the seams. The recogniser sometimes returns
    // text with leading/trailing whitespace and the user's prefix/suffix
    // may or may not end with a space. Normalise so we never produce
    // "hello  world" or "helloworld".
    const left  = prefix.replace(/\s+$/, "");
    const inner = (committed + interim).replace(/^\s+|\s+$/g, "");
    const right = suffix.replace(/^\s+/, "");
    const leftJoin  = (left  && inner) ? " " : "";
    const rightJoin = (inner && right) ? " " : "";

    const newValue = left + leftJoin + inner + rightJoin + right;
    // Caret pinned to the end of the just-inserted text so subsequent
    // speech continues from there naturally. (User can still re-aim by
    // clicking elsewhere — syncVoiceCaret picks that up.)
    const caret = (left + leftJoin + inner).length;

    voiceWriting = true;
    try {
      // CRITICAL: keep voiceWriting=true through the dispatchEvent — the
      // syncVoiceCaret listener runs synchronously inside dispatch and
      // reads the flag at that moment. If we reset before dispatch the
      // listener sees voiceWriting=false → treats our own write as a
      // manual edit → wipes `committed` → next frame duplicates the
      // whole transcript.
      $input.value = newValue;
      try { $input.setSelectionRange(caret, caret); } catch {}
      $input.dispatchEvent(new Event("input"));
    } finally {
      voiceWriting = false;
    }
    extendMaxListenWindow();
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
    setMicState("DISABLED");
    $mic.title = title;
    if (maxListenTimer) { clearTimeout(maxListenTimer); maxListenTimer = null; }
  };

  recog.onerror = (e) => {
    const permanent = ["not-allowed", "service-not-allowed", "audio-capture"];
    const isPermanent = permanent.includes(e.error);
    const isTransient = e.error === "network";
    if (!isPermanent && !isTransient) return; // no-speech, aborted — silent

    if (isPermanent) {
      userWants = false;
      if (maxListenTimer) { clearTimeout(maxListenTimer); maxListenTimer = null; }
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

    // Transient network error. We try ONE silent retry before bothering
    // the user with a notice — the network jitters that cause this
    // resolve in well under a second most of the time, and a successful
    // retry feels like the mic just kept working. Throttled notice only
    // surfaces if the retry also fails. budget resets on every clean
    // onstart so a stable multi-minute session keeps its credit.
    if (networkRetriesLeft > 0 && userWants) {
      networkRetriesLeft--;
      // Don't change userWants — onend will see it true and restart.
      // Don't change state machine — let onend transition us correctly.
      return;
    }
    userWants = false;
    if (maxListenTimer) { clearTimeout(maxListenTimer); maxListenTimer = null; }
    const now = Date.now();
    if (now - lastTransientNoticeAt >= 10_000) {
      lastTransientNoticeAt = now;
      showNotice("التعرّف الصوتي معطَّل الآن — جرّب مجدداً أو أوقِف Shields");
    }
    $mic.title = "التعرّف الصوتي يحتاج خدمة Google — في Brave أوقِف Shields";
  };
  recog.onend = () => {
    // Auto-restart path: Chrome's recogniser ends the session itself
    // every ~60 s even with continuous=true. If the user still wants to
    // listen we transparently start a new session so they don't notice
    // the boundary.
    if (userWants) {
      setMicState("STARTING");
      try { recog.start(); return; }
      catch (e) {
        // start() can throw "InvalidStateError" if a previous session
        // is still tearing down. Wait one tick and try once more —
        // that's almost always enough.
        setTimeout(() => {
          if (!userWants) return;
          try { recog.start(); }
          catch { userWants = false; finalizeMicEnd(); }
        }, 50);
        return;
      }
    }
    finalizeMicEnd();
  };

  function finalizeMicEnd() {
    setMicState("IDLE");
    // Preserve the typing indicator if a task already took over —
    // happens when the user hits send while the mic is still listening.
    // Without this, "Claude يفكّر..." gets wiped out as soon as onend
    // fires (~100 ms after our recog.stop in send()).
    if (!isLoading) setTyping(false);
    if (maxListenTimer) { clearTimeout(maxListenTimer); maxListenTimer = null; }
    updateSend();
  }
}

// Sliding window: every time the recogniser actually produces text,
// reset the cap. A user dictating a long paragraph won't get cut off
// at 60 s; a user who started the mic and walked away still gets
// auto-stopped because the timer doesn't extend without speech.
function extendMaxListenWindow() {
  if (maxListenTimer) clearTimeout(maxListenTimer);
  maxListenTimer = setTimeout(() => {
    if (userWants) {
      userWants = false;
      if (micState !== "STOPPING" && micState !== "IDLE") setMicState("STOPPING");
      try { recog?.stop(); } catch {}
    }
  }, MAX_LISTEN_MS);
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

  // STOP path. We toggle off the moment the user clicks — even if the
  // session is still STARTING (no onstart yet) or already STOPPING.
  // userWants=false ensures the auto-restart in onend doesn't fight us.
  if (userWants || micActive()) {
    userWants = false;
    if (micState !== "STOPPING" && micState !== "IDLE") setMicState("STOPPING");
    try { recog.stop(); } catch {}
    return;
  }

  // START path. We flip to STARTING IMMEDIATELY (before the async
  // permission check) so the button shows "starting" feedback right
  // away, AND so a rapid second click during the permission await
  // toggles us back off via the STOP path above instead of racing.
  setMicState("STARTING");
  userWants = true;
  // Anchor dictation at the user's current caret position. If they
  // hadn't focused the input yet (selection is null), insert at the
  // end — same effect as the old "append to existing text" behaviour.
  // If they had the caret at position 5 of "I am happy", suffix becomes
  // "am happy" and the next dictation slots itself between "I " and
  // "am happy" — exactly the user-asked-for behaviour the old code
  // (which only had a `baseline` and no concept of a caret) lacked.
  const start = $input.selectionStart ?? $input.value.length;
  const end   = $input.selectionEnd   ?? start;
  prefix = $input.value.slice(0, start);
  suffix = $input.value.slice(end);
  committed = "";
  networkRetriesLeft = 1;

  const ok = await ensureMicPermission();
  // The user (or a permission-failure error) may have already toggled
  // us off during the await above. Check before proceeding.
  if (!userWants) {
    if (micState !== "IDLE") setMicState("IDLE");
    return;
  }
  if (!ok) {
    userWants = false;
    setMicState("IDLE");
    return;
  }

  try {
    recog.start();
  } catch (err) {
    // start() throws InvalidStateError if a previous session is still
    // tearing down (e.g. user mashed the button). Surface this once
    // — silent failure here is the worst possible UX because the user
    // sees the button do nothing and has no idea why.
    userWants = false;
    setMicState("IDLE");
    showNotice("تعذّر بدء التسجيل — جرّب مرّة أخرى بعد لحظة.");
    return;
  }
  // Initial cap; recog.onresult slides this forward whenever speech
  // arrives. If no speech arrives within 60 s, mic auto-stops.
  extendMaxListenWindow();
});

// Keyboard shortcut: Ctrl+Shift+M (or Cmd+Shift+M on macOS) toggles
// the mic from anywhere in the panel. The combo avoids the common
// browser/OS reservations of plain Ctrl+M / F1.
document.addEventListener("keydown", (e) => {
  const meta = e.ctrlKey || e.metaKey;
  if (meta && e.shiftKey && (e.key === "m" || e.key === "M")) {
    e.preventDefault();
    $mic.click();
  }
});

initVoice();
init();
