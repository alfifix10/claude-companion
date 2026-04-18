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
import { getActiveTab, sendContentMessage } from "../core/cdp.js";
import { rejectToolsFor } from "../tools/native-tool-handlers.js";

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
}

function buildPrompt({ userMsg, history, tab, memories }) {
  const title = tab?.title || "";
  const url = tab?.url || "";

  let base = `You control the user's already-open Chromium browser via the \`mcp__claude-companion__*\` tools. Fulfill the user's request autonomously. Reply in Arabic by default (unless the user writes in English). Be concise — 1-4 sentences unless more is clearly needed.

ACTIVE TAB:
  title: ${title}
  url:   ${url}

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

RULES:
  • After navigate, ALWAYS call read_page or get_page_text to verify. Never assume success.
  • For "لخّص"/"اقرأ" on the current tab, call get_page_text first.
  • Never claim the page is empty if ACTIVE TAB shows a real URL.
  • If you get a Chromium error page, say so plainly and suggest a fix.
  • Prefer read_page over screenshot — it's 10× cheaper in tokens.
  • JS dialogs (confirm/prompt) are auto-dismissed for safety. If you need the
    action to go through, look for an in-page button or ask the user.`;

  if (memories) {
    base += `\n\nUSER MEMORIES:\n${memories.slice(0, 500)}`;
  }

  base += `\n\nCONVERSATION:\n${history}`;
  return base;
}

export async function handleMaxChat(messages) {
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

  const prompt = buildPrompt({ userMsg: lastUser, history, tab, memories });

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

  // Three safety nets so a misbehaving task can't run forever:
  //   1. No-first-event (20s):  the host never emitted a single event.
  //   2. Stuck detector (90s):  events stopped arriving mid-task.
  //   3. Hard ceiling (6 min):  absolute max regardless of activity.
  const T_FIRST = 20_000;
  const T_STUCK = 90_000;
  const T_MAX = 6 * 60_000;

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
    timeoutCancel(`تجاوزت المهمة الحد الأقصى (${Math.round(T_MAX / 60000)} دقائق) — أُلغيَت. قسّمها لمهام أصغر.`);
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
          }
        }
      } else if (ev.type === "result") {
        finishTask({
          type: "done",
          text: assistantText || ev.result || "تم",
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
        finishTask({ type: "done", text: assistantText || "تم", toolActions });
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

  const sent = sendMaxQuery(id, prompt, { images: activeTask?.images || [] });
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
    if (activeTask) {
      activeTask.running = false;
      activeTask.finalResult = result;
      activeTask.messages = [];
    }
    broadcastToPanels(result);
    setTimeout(() => {
      if (activeTask && !activeTask.running) setActiveTask(null);
    }, 2000);
  }
}
