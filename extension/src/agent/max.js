/**
 * Claude Max chat flow.
 *
 * The only provider. Routes user messages through Claude Code via the native
 * host (`claude -p --output-format stream-json`). Streams events back to the
 * side panel.
 *
 * Prompt design:
 *   • Current tab context always included so Claude starts grounded.
 *   • Arabic site aliases so "يوتيوب" maps to youtube.com correctly.
 *   • Short, strict rule block — no hedging, no fake success.
 */

import { activeTask, setActiveTask, broadcastToPanels } from "../core/state.js";
import {
  ensureHealthyPort, sendMaxQuery, cancelMaxQuery, cancelAllHost,
  registerResponseHandler, unregisterResponseHandler,
} from "../messaging/native.js";
import { getActiveTab, sendContentMessage, scheduleDetachAll } from "../core/cdp.js";
import { rejectToolsFor, clearToolRejection } from "../tools/native-tool-handlers.js";
import { isMutating } from "../lib/tool-taxonomy.js";
import { LoopDetector } from "../lib/loop-detector.js";

// Stable key for a tool-call input so we can detect exact repeats. Uses
// JSON with sorted keys; falls back to String() if the input is weird
// (circular references etc.).
function safeInputKey(input) {
  try {
    if (input === null || input === undefined) return "";
    if (typeof input !== "object") return String(input);
    const keys = Object.keys(input).sort();
    const obj = {};
    for (const k of keys) obj[k] = input[k];
    return JSON.stringify(obj);
  } catch {
    return String(input);
  }
}

// Toggle the task-level sticky border. Individual tool calls pulse it
// separately so there's always a visual even if this fails to reach the tab.
async function setBorder(tabId, show) {
  if (!tabId) return;
  try {
    await sendContentMessage(tabId, show
      ? { type: "showAutomationBorder", sticky: true }
      : { type: "hideAutomationBorder" }
    );
  } catch {}
}

let currentRunId = null;

export function cancelActiveMaxTask() {
  if (currentRunId) cancelMaxQuery(currentRunId);
  currentRunId = null;
  // finishTask won't run on a user-initiated stop, so remove the sticky
  // automation border here. Otherwise the orange frame lingers on the tab
  // forever after the user pressed stop.
  try {
    const tabId = activeTask?.tabId;
    if (tabId) setBorder(tabId, false);
  } catch {}
  // Same reasoning — user-initiated stop should also release the debugger
  // bar after a short idle, so the browser feels "clean" again.
  scheduleDetachAll();
}

// STATIC_SYSTEM is the portion of the prompt that doesn't change between
// turns — rules, aliases, budget, execution discipline. Passed via the
// CLI's --system flag so Anthropic's server-side prompt cache (5-minute
// TTL, ~90% discount on cached tokens) kicks in automatically on
// back-to-back turns. A ~900-token static block across a 10-turn
// conversation saves ≈ 8 k tokens.
//
// Dynamic context (ACTIVE TAB, memories, chat history) goes into the
// user message — we don't want a cache-miss every time the tab URL
// changes.
const STATIC_SYSTEM = `You control the user's already-open Chromium browser via the \`mcp__claude-companion__*\` tools. Fulfill the user's request autonomously. Reply in Arabic by default (unless the user writes in English). Be concise — 1-4 sentences unless more is clearly needed.

ARABIC SITE NAMES → URLs (use these, DO NOT translate the word into a domain):
  يوتيوب → https://www.youtube.com
  قوقل / جوجل → https://www.google.com
  تويتر / إكس → https://x.com
  فيسبوك → https://www.facebook.com
  انستقرام → https://www.instagram.com
  ويكيبيديا → https://ar.wikipedia.org
  أمازون → https://www.amazon.sa
  نون → https://www.noon.com
  جيميل / بريدي → https://mail.google.com
  خرائط → https://maps.google.com
  لينكدإن → https://www.linkedin.com
  ريديت → https://www.reddit.com
  تيك توك → https://www.tiktok.com
  جيتهاب → https://github.com

EXECUTION METHOD:
  • For tasks that take 3+ steps, START with a one-line plan in Arabic,
    e.g. "خطّتي: 1) افتح Gmail 2) بحث category:promotions 3) حذف كل النتائج".
    Then execute. This is a contract — the user can interrupt if the plan
    is wrong.
  • For single-step tasks ("افتح يوتيوب", "لخّص هذه الصفحة"), skip the
    plan and just execute. Over-planning is noise.
  • VERIFY after any step that changes page state: click, navigate,
    form_input, press_key that submits. Call read_page or get_page_text
    to confirm the expected outcome before the next step. Don't assume.
  • On failure, DIAGNOSE before retrying. Re-read the page and explain
    to yourself WHY it failed (ref expired, dialog appeared, layout
    changed, navigation didn't land). Then try a DIFFERENT approach —
    same action a second time only makes sense if you know what changed.

PARALLEL TOOL CALLS:
  When multiple INDEPENDENT read-only tools can run at once, call them
  in the same turn. Safe to parallelise:
    • tabs_context + get_page_text + screenshot (different concerns, no
      shared state)
    • list_tabs + tabs_context (pure reads)
    • multiple get_page_text calls on DIFFERENT tabs (research workflows)
  Never parallelise actions (click, type_text, form_input, drag, scroll,
  press_key, navigate) — they mutate page state and race with each other.
  When in doubt, serialise.

RULES:
  • ALWAYS END YOUR TURN WITH A TEXT ANSWER. Tool calls alone are not a
    reply — after your last tool returns, write the actual answer to the
    user's question. "لخّص هذه الصفحة" → call get_page_text, then write
    the summary. "افتح يوتيوب" → navigate, then confirm in one sentence
    ("فتحت يوتيوب في تبويب جديد."). Never finish with tool calls only.
  • ALL BROWSER TOOLS ARE PRE-AUTHORIZED. Never tell the user to "approve"
    or "grant permission" — there is no dialog for them to click. If a
    tool fails, report the ACTUAL failure (element missing, page wrong,
    timeout, ...) — never invent a permission issue.
  • For "لخّص"/"اقرأ" on the current tab, call get_page_text first,
    THEN produce the actual summary/reading as your text reply.
  • Never claim the page is empty if ACTIVE TAB shows a real URL.
  • If you get a Chromium error page, say so plainly and suggest a fix.
  • Prefer read_page over screenshot — it's 10× cheaper in tokens.
  • When DOM refs from read_page don't work (canvas apps like Google Docs,
    heavily styled sites, stale refs after re-render), call screenshot
    with labels=true. It returns the image plus a legend mapping each
    numbered badge to its ref + coordinates. Click by ref OR by (x,y).
  • Every mutating tool (click / drag / Enter-press) now returns a
    trailer showing what changed: "| → /new-url, +8 عناصر, ⚠ حوار ظهر".
    Read it FIRST — don't re-call read_page unless you need detail.
  • JS dialogs (confirm/prompt) are auto-dismissed for safety. If you need the
    action to go through, look for an in-page button or ask the user.

  CHOOSE THE RIGHT TOOL:
  • For Gmail tasks: if a Gmail MCP (mcp__*_Gmail__*) is available, USE IT.
    Do not UI-automate Gmail with click/type — Gmail's JS-heavy UI will
    fight you. The MCP calls the Gmail API directly.
  • Same principle for Slack, GitHub, Drive, Notion, any service whose
    MCP is present in the tool list.
  • Fall back to mcp__claude-companion__* browser tools only when no
    service-specific MCP exists.

  BUDGET:
  • You have a large budget for READS (read_page, get_page_text, find,
    screenshot, list_tabs, tabs_context, tabs_overview, wait_for, scroll).
    Use them freely to understand the page before acting.
  • You have a tighter budget for ACTIONS (click, type_text, press_key,
    form_input, drag, navigate, tabs_create, switch_tab, select_option,
    hover, run_javascript) — about 40 per task. Plan before you click.

  STOP CONDITIONS (do NOT keep burning tokens):
  • If the SAME tool call fails twice with the same input, STOP retrying.
    Explain the blocker in plain Arabic, propose ONE alternative, and wait.
  • If you've made 20+ actions on the same sub-goal without visible
    progress, STOP and ask the user to narrow the task.
  • When you change approach (e.g. click → find → keyboard shortcut), that
    is EXPECTED. Keep going. Only stop when you've exhausted plausible
    alternatives, not at the first failure.
  • Never call the exact same tool with the exact same input more than twice.`;

function buildDynamicUser({ history, tab, memories }) {
  const title = tab?.title || "";
  const url = tab?.url || "";
  let ctx = `ACTIVE TAB:\n  title: ${title}\n  url:   ${url}`;
  if (memories) ctx += `\n\nUSER MEMORIES:\n${memories.slice(0, 500)}`;
  ctx += `\n\nCONVERSATION:\n${history}`;
  return ctx;
}

export async function handleMaxChat(messages) {
  // A new task begins. Clear any lingering tool-rejection blackout
  // from a previous hardStop so edit-and-resend / send-while-streaming
  // patterns don't lose their first 10 s of tool calls to the dying
  // subprocess's window.
  clearToolRejection();

  const lastUser = messages[messages.length - 1]?.content || "";

  // Load user-saved memories (a freeform notes field in settings)
  const { memories } = await chrome.storage.local.get("memories");

  // Current tab context
  let tab = null;
  try { tab = await getActiveTab(); } catch {}

  // Short conversation tail so Claude can follow multi-turn context
  const history = messages.slice(-6).map((m) =>
    `${m.role === "user" ? "USER" : "ASSISTANT"}: ${typeof m.content === "string" ? m.content : "(structured content)"}`
  ).join("\n");

  const userPrompt = buildDynamicUser({ history, tab, memories });

  broadcastToPanels({ type: "provider_info", provider: "Claude Max" });

  // Ensure the native channel is alive before we send — catches stale ports.
  const healthy = await ensureHealthyPort(5000);
  if (!healthy) {
    finishTask({
      type: "error",
      text: "لا يمكنني التواصل مع Claude Code. تأكد من:\n• الإضافة مُفعَّلة وتمت إعادة تحميلها بعد install\n• Brave/Chrome أُعيد تشغيله بعد التسجيل\n• نُفِّذ `claude login` مرة واحدة",
    });
    return;
  }

  const id = `run_${Date.now()}`;
  currentRunId = id;
  if (activeTask) activeTask.runId = id;

  // Don't show the automation border at task start — only when Claude
  // actually invokes a browser tool. For pure text/image-analysis tasks
  // that don't touch the page, the border would be misleading.
  let borderShown = false;

  const toolActions = [];
  let assistantText = "";
  let firstEventSeen = false;
  let lastProgressAt = Date.now();

  // Anti-stuck guardrails so a wandering task doesn't silently burn the
  // Max quota for minutes on end. Tuned to tolerate legitimate exploration
  // of messy sites (Gmail, GitHub, dynamic SPAs) without capping Claude
  // at the first sign of turbulence.
  //
  // Key insight (learned from real usage): reads and actions are not
  // equivalent. A task that clicks twice and reads fifteen times is
  // making disciplined progress, not spinning. We now cap only the
  // MUTATING tools; exploration (read_page, find, screenshot, tabs_*,
  // get_page_text, wait_for, scroll) is uncapped. A MAX_TOTAL ceiling
  // stays as an absolute backstop against catastrophic loops.
  //
  //   • actionCount:       mutating-tool budget (catches endless
  //                        click/type/navigate storms)
  //   • totalCount:        absolute cap, very high — only for runaway
  //                        models that would otherwise never stop
  //   • consecutiveErrors: stops only after MANY same-tool failures; we
  //                        reset when Claude switches to a different
  //                        tool, because "the click failed, let me try
  //                        find" is exactly the adaptive behaviour we want.
  //   • recentCalls:       stops if the same (tool, input) repeats —
  //                        the classic "Claude keeps clicking a ref
  //                        that no longer exists" loop.
  // MUTATING_TOOLS + LoopDetector live in src/lib/ now — see their
  // source files for full rationale (single-source-of-truth, per-class
  // thresholds) plus 38 unit tests guarding the behaviour.
  let actionCount = 0;
  let totalCount = 0;
  let consecutiveErrors = 0;
  let lastErrorTool = null;
  const loopDetector = new LoopDetector();
  const MAX_ACTIONS = 40;
  const MAX_TOTAL = 150;       // absolute ceiling — reads + actions combined
  const MAX_CONSECUTIVE_ERRORS = 6;

  // Three safety nets so a misbehaving task can't run forever:
  //   1. No-first-event (20s):  the host never emitted a single event.
  //   2. Stuck detector (90s):  events stopped arriving mid-task.
  //   3. Hard ceiling (20 min): absolute max regardless of activity.
  //
  // T_MAX was 6 min originally — killed legitimate deep-research tasks
  // (e.g. "gather 50 films from Wikipedia + find their YouTube videos")
  // that were still actively making progress. T_STUCK + MAX_TOTAL + the
  // loop detectors already handle the real pathologies; 20 min gives
  // breathing room for honest long work while keeping a ceiling for the
  // truly pathological case that slips past the other guards.
  const T_FIRST = 20_000;
  const T_STUCK = 90_000;
  const T_MAX = 20 * 60_000;

  // Every timeout path MUST also kill lingering processes and arm a tool
  // blackout — otherwise a dying claude keeps emitting clicks/navigates.
  function timeoutCancel(reason) {
    if (currentRunId !== id) return;
    cancelAllHost();
    rejectToolsFor(10_000);
    finishTask({ type: "error", text: reason });
  }

  const timeoutTimer = setTimeout(() => {
    if (!firstEventSeen) {
      timeoutCancel("لم يصل رد من Claude خلال 20 ثانية. جرّب مجدداً.");
    }
  }, T_FIRST);

  const stuckTimer = setInterval(() => {
    if (currentRunId !== id) { clearInterval(stuckTimer); return; }
    if (!firstEventSeen) return;
    if (Date.now() - lastProgressAt > T_STUCK) {
      clearInterval(stuckTimer);
      timeoutCancel(`توقّفت المهمة دون تقدّم لأكثر من ${Math.round(T_STUCK / 1000)} ثانية — أُلغيَت.`);
    }
  }, 5000);

  const hardCeiling = setTimeout(() => {
    timeoutCancel(`بلغت المهمّة سقف الـ ${Math.round(T_MAX / 60000)} دقيقة. حفظت ما أُنجِز في المحادثة؛ أكملها بطلب تكميليّ لو شئت.`);
  }, T_MAX);

  registerResponseHandler(id, (msg) => {
    firstEventSeen = true;
    lastProgressAt = Date.now();
    if (activeTask?.stopped) { cancelMaxQuery(id); return; }

    if (msg.type === "max_event") {
      const ev = msg.event;
      if (!ev || typeof ev !== "object") return;

      if (ev.type === "assistant" && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type === "text" && block.text) {
            assistantText += block.text;
            broadcastToPanels({ type: "text_delta", text: block.text });
          } else if (block.type === "tool_use") {
            const fullName = String(block.name || "");
            if (!fullName.startsWith("mcp__claude-companion__")) continue;
            const name = fullName.replace(/^mcp__claude-companion__/, "");
            toolActions.push({ tool: name, input: block.input || {} });
            broadcastToPanels({ type: "tool_start", tool: name });
            // First browser tool call — now we can honestly show the border.
            if (!borderShown) {
              borderShown = true;
              setBorder(activeTask?.tabId, true);
            }

            // ── Anti-stuck: budget + loop detection ──
            totalCount++;
            if (isMutating(name)) actionCount++;
            if (actionCount > MAX_ACTIONS) {
              timeoutCancel(
                `بلغتُ حدّ ${MAX_ACTIONS} إجراء (نقر/كتابة/تنقّل) في هذه المهمّة. `
                + `لو تريد الاستمرار، أعد الطلب بخطوات أوضح أو حدّد الجزء المتبقّي.`
              );
              return;
            }
            if (totalCount > MAX_TOTAL) {
              // Belt-and-suspenders: Claude is mostly reading but still
              // hasn't finished. Unusual — stop just in case.
              timeoutCancel(
                `بلغتُ ${MAX_TOTAL} استدعاء أداة دون انتهاء. المهمّة أوسع من المتوقّع — قسّمها.`
              );
              return;
            }
            // Loop detection delegated to src/lib/loop-detector.ts —
            // per-class thresholds, 19 unit tests guarding behaviour.
            const inputKey = safeInputKey(block.input);
            const loopResult = loopDetector.record(name, inputKey);
            if (loopResult.loop) {
              timeoutCancel(
                `توقّفت: تكرّرت الأداة "${name}" بنفس المُدخلات ${loopResult.identical} مرّات — `
                + `حلقة واضحة. جرّب مقاربة مختلفة.`
              );
              return;
            }
          }
        }
      } else if (ev.type === "user" && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type === "tool_result") {
            const content = Array.isArray(block.content)
              ? block.content.map((c) => c.text || "").join("")
              : String(block.content || "");
            if (toolActions.length) {
              toolActions[toolActions.length - 1].result = content.slice(0, 200);
            }
            // ── Anti-stuck: consecutive-error detection ──
            // is_error is the authoritative signal from the MCP layer;
            // fall back to keyword heuristic for older runtimes.
            const isError = block.is_error === true
              || /^(error|failed|exception|timed? out)/i.test(content.trim());
            const errTool = toolActions[toolActions.length - 1]?.tool;
            if (isError) {
              // Reset the streak when Claude switches tools — that's
              // legitimate adaptation, not repeated failure. Only count
              // errors that come from the SAME tool as the previous error.
              if (lastErrorTool && errTool === lastErrorTool) {
                consecutiveErrors++;
              } else {
                consecutiveErrors = 1;
              }
              lastErrorTool = errTool || null;
              if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                timeoutCancel(
                  `توقّفت: الأداة "${errTool}" فشلت ${consecutiveErrors} مرّات متتالية. `
                  + `جرّب أداة أخرى أو غيّر الأسلوب — النقطة هنا محصَّنة.`
                );
                return;
              }
            } else {
              consecutiveErrors = 0;
              lastErrorTool = null;
            }
          }
        }
      } else if (ev.type === "result") {
        // If the model ended the turn after tool calls without emitting
        // any text, be honest about it — don't fake a "تم" reply.
        const emptyReplyMsg = toolActions.length
          ? "انتهت الأدوات لكن النموذج لم يكتب نصّاً. أعد الطلب بصياغة أوضح، مثل: «لخّص محتوى الصفحة في ٥ نقاط»."
          : "لم يُرجع النموذج نصّاً. أعد المحاولة.";
        finishTask({
          type: "done",
          text: assistantText || ev.result || emptyReplyMsg,
          toolActions,
          usage: ev.usage || null,
          cost: { total: 0 },  // Max subscription → user cost is $0
        });
      }
    } else if (msg.type === "max_text") {
      assistantText += msg.text;
      broadcastToPanels({ type: "text_delta", text: msg.text });
    } else if (msg.type === "max_done") {
      if (currentRunId === id) {
        const emptyReplyMsg = toolActions.length
          ? "انتهت الأدوات لكن النموذج لم يكتب نصّاً. أعد الطلب بصياغة أوضح."
          : "لم يُرجع النموذج نصّاً. أعد المحاولة.";
        finishTask({ type: "done", text: assistantText || emptyReplyMsg, toolActions });
      }
    } else if (msg.type === "max_error") {
      const friendly = msg.error === "NO_CLAUDE_CLI"
        ? "Claude CLI غير مُثبَّت. افتح دليل الإعداد."
        : msg.error === "EMPTY_PROMPT"
          ? "الرسالة فارغة."
          : msg.error;
      finishTask({ type: "error", text: friendly });
    }
  });

  const sent = sendMaxQuery(id, userPrompt, {
    images: activeTask?.images || [],
    system: STATIC_SYSTEM,
  });
  if (!sent) {
    clearTimeout(timeoutTimer);
    finishTask({ type: "error", text: "فشل إرسال الطلب للمضيف. أعد تحميل الإضافة." });
  }

  function finishTask(result) {
    // Idempotent — multiple timers may race to call this; honor the first.
    if (currentRunId !== id) return;
    currentRunId = null;

    clearTimeout(timeoutTimer);
    clearInterval(stuckTimer);
    clearTimeout(hardCeiling);

    unregisterResponseHandler(id);
    // Only hide if we actually showed one. Prevents an unnecessary content-
    // script ping on tabs we never touched.
    if (borderShown) setBorder(activeTask?.tabId, false);
    // Schedule debugger detach so Chromium's "is debugging this browser"
    // bar disappears after ~5s of idle. A new task arriving within that
    // window cancels the detach (see ensureAttached).
    scheduleDetachAll();
    if (activeTask) {
      activeTask.running = false;
      activeTask.finalResult = result;
      activeTask.messages = [];
    }
    broadcastToPanels(result);
    // 2-second grace before clearing activeTask so a panel opening mid-
    // completion can still read the final result via get_status. Guard
    // against clobbering: if the user started ANOTHER task in the
    // meantime, the new task has a different runId — don't touch it.
    const finishedRunId = id;
    setTimeout(() => {
      if (activeTask && !activeTask.running && activeTask.runId === finishedRunId) {
        setActiveTask(null);
      }
    }, 2000);
  }
}
