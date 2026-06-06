/* Welcome / onboarding page logic.
 *
 * Auto-detects setup progress by polling the background's `diag` endpoint
 * (which round-trips to the native host). No host changes needed — diag
 * already reports host reachability, Node version, Claude CLI presence, and
 * MCP socket state. As the user runs the installer in a terminal, the ✓
 * marks here light up live.
 */
const $ = (id) => document.getElementById(id);

// ── OS-specific install command ───────────────────────────────────────────
const ua = navigator.userAgent;
const isWin = /Windows/i.test(ua);
const isMac = /Macintosh|Mac OS X/i.test(ua);
const osName = isWin ? "PowerShell" : isMac ? "Terminal (macOS)" : "Terminal";
// Primary: a double-clickable setup file. Fallback: the manual terminal command.
const setupFile = isWin ? "SETUP-Windows.bat" : "SETUP-Mac-Linux.command";
const installCmd = isWin
  ? "powershell -ExecutionPolicy Bypass -File .\\install.ps1"
  : "bash ./SETUP-Mac-Linux.command";

$("os-name").textContent = osName;
$("os-file").textContent = setupFile;
$("os-cmd").textContent = installCmd;
if (isWin) $("win-hint").hidden = false;

// ── Copy button (copies the manual fallback command) ───────────────────────
$("copy-cmd").addEventListener("click", async () => {
  const btn = $("copy-cmd");
  try {
    await navigator.clipboard.writeText(installCmd);
    btn.textContent = "✓ نُسخ";
  } catch {
    btn.textContent = "انسخ يدويّاً";
  }
  setTimeout(() => { btn.textContent = "نسخ الأمر"; }, 1600);
});

// ── Live detection ────────────────────────────────────────────────────────
function setRow(id, ok, value) {
  const li = $(id);
  if (!li) return;
  // Leave neutral (no data-ok) until we have a definite answer.
  if (ok === null) li.removeAttribute("data-ok");
  else li.dataset.ok = ok ? "true" : "false";
  const val = li.querySelector(".val");
  if (val) val.textContent = value || (ok ? "✓" : "—");
}

function setStep(id, state) {
  const el = $(id);
  if (el) el.dataset.state = state;
}

async function runDiag() {
  let diag;
  try {
    diag = await chrome.runtime.sendMessage({ type: "diag" });
  } catch {
    diag = { error: "NO_NATIVE_HOST" };
  }
  const hostUp = !!diag && !diag.error;
  const cliOk = hostUp && !!diag.claudeCli && !!diag.claudeCli.found;
  const mcpOk = hostUp && !!diag.mcpReachable;

  setRow("chk-host", hostUp, hostUp ? "متّصل" : "غير متّصل");
  setRow("chk-cli", hostUp ? cliOk : null, cliOk ? "موجود" : (hostUp ? "غير موجود" : "—"));
  setRow("chk-mcp", hostUp ? mcpOk : null, mcpOk ? "جاهز" : (hostUp ? "—" : "—"));

  const ready = hostUp && cliOk;
  setStep("step-2", ready ? "done" : "pending");
  setStep("step-3", ready ? "pending" : "idle");
  $("ready-banner").hidden = !ready;

  if (hostUp && diag.nodeVersion) {
    $("env-line").textContent =
      `${diag.platform || ""} · Node ${diag.nodeVersion}`.trim();
  }
}

$("recheck").addEventListener("click", runDiag);
runDiag();
// Poll while the user works in the terminal; checks flip to ✓ on success.
setInterval(runDiag, 2500);
