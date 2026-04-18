/**
 * Wizard UI controller.
 * Polls the backend for status, reacts to user actions, updates the rail.
 */

const STEPS = ["node", "claude", "login", "extension", "register", "done"];
let currentStepIdx = 0;

function $(q) { return document.querySelector(q); }
function $$(q) { return document.querySelectorAll(q); }

function setStatus(stepName, text, cls = "") {
  const el = document.getElementById("st-" + stepName);
  if (el) { el.textContent = text; el.className = "status " + cls; }
}

function markStepDone(stepName) {
  const section = $(`.step[data-step="${stepName}"]`);
  if (section) { section.classList.remove("active"); section.classList.add("done"); }
  const dot = $(`.dot[data-step="${stepName}"]`);
  if (dot) { dot.classList.remove("active"); dot.classList.add("done"); }
  // Move to next
  const idx = STEPS.indexOf(stepName);
  if (idx >= 0 && idx < STEPS.length - 1) {
    const next = STEPS[idx + 1];
    const nSec = $(`.step[data-step="${next}"]`);
    const nDot = $(`.dot[data-step="${next}"]`);
    if (nSec) nSec.classList.add("active");
    if (nDot) nDot.classList.add("active");
    currentStepIdx = idx + 1;
    updateRail();
    // Scroll to next step
    setTimeout(() => { nSec?.scrollIntoView({ behavior: "smooth", block: "center" }); }, 200);
  }
}

function updateRail() {
  const pct = (currentStepIdx / (STEPS.length - 1)) * 100;
  $("#railFill").style.width = pct + "%";
}

function activateStep(stepName) {
  // Clear all active/done
  $$(".step").forEach((s) => s.classList.remove("active"));
  $$(".dot").forEach((d) => d.classList.remove("active"));
  const sec = $(`.step[data-step="${stepName}"]`);
  const dot = $(`.dot[data-step="${stepName}"]`);
  if (sec) sec.classList.add("active");
  if (dot) dot.classList.add("active");
  currentStepIdx = STEPS.indexOf(stepName);
  updateRail();
}

// ──────────────────────────────────────────────────────────────────────────
// Live log stream (SSE)
// ──────────────────────────────────────────────────────────────────────────
const logEl = $("#log");
function appendLog(level, msg) {
  const d = document.createElement("div");
  d.className = "log-line " + level;
  d.textContent = msg;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}
const es = new EventSource("/api/events");
es.addEventListener("log", (e) => {
  const { level, msg } = JSON.parse(e.data);
  appendLog(level || "info", msg || "");
});

// ──────────────────────────────────────────────────────────────────────────
// Probe (detect current state)
// ──────────────────────────────────────────────────────────────────────────
async function probe() {
  const r = await fetch("/api/probe").then((x) => x.json());

  // Step 1: Node
  if (r.node?.ok) {
    setStatus("node", `✓ ${r.node.version}`, "ok");
    if (currentStepIdx === 0) markStepDone("node");
  } else {
    setStatus("node", "✗ غير مُثبَّت — حمّله ثم أعد الفحص", "bad");
  }

  // Step 2: Claude CLI
  if (r.claude?.ok) {
    setStatus("claude", `✓ ${r.claude.version || "مُثبَّت"}`, "ok");
    if (currentStepIdx === 1) markStepDone("claude");
  } else {
    setStatus("claude", "✗ غير مُثبَّت", "bad");
  }

  // Step 3: Login (we can't easily verify; assume ok if CLI exists and user has clicked)
  // Leave this one to manual progression.

  // Step 4: Extension
  if (r.extension?.ok) {
    setStatus("extension", `✓ اكتُشفت (${r.extension.ids.length} معرّف)`, "ok");
  } else {
    setStatus("extension", "⏳ في انتظار التحميل", "warn");
  }

  // Step 5: Host + MCP
  const regOk = r.hostRegistered && r.mcpRegistered;
  if (regOk) {
    setStatus("register", "✓ تم الربط", "ok");
  } else if (r.hostRegistered) {
    setStatus("register", "⚠ MCP غير مربوط", "warn");
  } else {
    setStatus("register", "—", "");
  }

  return r;
}

// ──────────────────────────────────────────────────────────────────────────
// Actions
// ──────────────────────────────────────────────────────────────────────────
$("#recheck-node").addEventListener("click", probe);

$("#install-claude").addEventListener("click", async () => {
  const btn = $("#install-claude");
  btn.disabled = true; btn.textContent = "جارٍ التثبيت...";
  setStatus("claude", "⏳ جارٍ التثبيت...", "working");
  const r = await fetch("/api/install-claude", { method: "POST" }).then((x) => x.json());
  if (r.ok) {
    setStatus("claude", "✓ مُثبَّت", "ok");
    markStepDone("claude");
  } else {
    setStatus("claude", "✗ فشل — راجع السجل", "bad");
  }
  btn.disabled = false; btn.textContent = "إعادة المحاولة";
  await probe();
});

$("#do-login").addEventListener("click", async () => {
  const btn = $("#do-login");
  btn.disabled = true; btn.textContent = "جارٍ الفتح...";
  setStatus("login", "⏳ افتح المتصفح وسجّل الدخول", "working");
  const r = await fetch("/api/login", { method: "POST" }).then((x) => x.json());
  if (r.ok) {
    setStatus("login", "✓ افتح المتصفح الآن — اختر حساب Max", "ok");
    // Give the user time to complete login, then move forward
    setTimeout(() => { markStepDone("login"); btn.textContent = "نعم، دخلت"; btn.disabled = false; }, 3000);
  } else {
    setStatus("login", "✗ " + (r.error || "فشل"), "bad");
    btn.disabled = false; btn.textContent = "إعادة المحاولة";
  }
});
$("#skip-login").addEventListener("click", () => markStepDone("login"));

$("#open-ext").addEventListener("click", async () => {
  const r = await fetch("/api/open-ext-page", { method: "POST" }).then((x) => x.json());
  if (r.ok) {
    setStatus("extension", `⏳ فتحت ${r.browser} — حمّل الإضافة من مجلد extension/`, "working");
    startExtensionPolling();
  } else {
    setStatus("extension", "✗ " + (r.error || "فشل"), "bad");
  }
});

$("#recheck-ext").addEventListener("click", probe);

let extPolling = null;
function startExtensionPolling() {
  if (extPolling) return;
  extPolling = setInterval(async () => {
    const r = await fetch("/api/probe").then((x) => x.json());
    if (r.extension?.ok) {
      clearInterval(extPolling); extPolling = null;
      setStatus("extension", `✓ اكتُشفت الإضافة!`, "ok");
      markStepDone("extension");
    }
  }, 2000);
}

$("#do-register").addEventListener("click", async () => {
  const btn = $("#do-register");
  btn.disabled = true; btn.textContent = "جارٍ الربط...";
  setStatus("register", "⏳ تسجيل Native Host...", "working");
  const host = await fetch("/api/register-host", { method: "POST" }).then((x) => x.json());
  if (!host.ok) {
    setStatus("register", "✗ " + (host.error || "فشل تسجيل host"), "bad");
    btn.disabled = false; btn.textContent = "إعادة المحاولة";
    return;
  }
  setStatus("register", "⏳ ربط MCP بـ Claude Code...", "working");
  const mcp = await fetch("/api/register-mcp", { method: "POST" }).then((x) => x.json());
  if (!mcp.ok) {
    setStatus("register", "⚠ Host نجح لكن MCP فشل: " + (mcp.error || ""), "warn");
  } else {
    setStatus("register", "✓ تم الربط بالكامل", "ok");
  }
  markStepDone("register");
  btn.disabled = false; btn.textContent = "تم";
  await probe();
});

$("#restart-browser").addEventListener("click", async () => {
  const r = await fetch("/api/restart-browser", { method: "POST" }).then((x) => x.json());
  if (r.ok) {
    alert("تم إغلاق المتصفحات. افتح المتصفح من جديد ثم انقر أيقونة الإضافة.");
  }
});

$("#close-wizard").addEventListener("click", async () => {
  await fetch("/api/shutdown", { method: "POST" }).catch(() => {});
  window.close();
});

// ──────────────────────────────────────────────────────────────────────────
// Init: on first load, figure out where to drop the user
// ──────────────────────────────────────────────────────────────────────────
(async function init() {
  const r = await probe();

  // Determine the current step based on state
  if (!r.node?.ok) {
    activateStep("node");
  } else if (!r.claude?.ok) {
    activateStep("claude");
  } else if (!r.extension?.ok) {
    // Jump past login to extension load (user may already be logged in)
    markStepDone("node");
    setTimeout(() => markStepDone("claude"), 300);
    setTimeout(() => markStepDone("login"), 600);
    startExtensionPolling();
  } else if (!r.hostRegistered || !r.mcpRegistered) {
    markStepDone("node");
    setTimeout(() => markStepDone("claude"), 300);
    setTimeout(() => markStepDone("login"), 600);
    setTimeout(() => markStepDone("extension"), 900);
  } else {
    // Everything done
    STEPS.forEach((s, i) => setTimeout(() => markStepDone(s), i * 200));
  }
})();
