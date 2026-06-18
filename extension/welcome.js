/* Welcome page — radically simple. One status card, one action.
 *
 * Polls the native host's diag endpoint and collapses the whole setup into
 * three states:
 *   ready    → host connected + CLI present  → "open the side panel"
 *   waiting  → host not connected yet         → "run SETUP, restart browser"
 *   reload   → this tab lost its link         → "press F5"
 * No per-component checklist, no multi-step list — just what to do next.
 */
const $ = (id) => document.getElementById(id);
const card = $("card");
const icon = $("icon");
const title = $("title");
const msg = $("msg");
const recheck = $("recheck");

async function check() {
  let diag;
  try {
    // Race against a timeout so a hung sendMessage can never freeze the card.
    diag = await Promise.race([
      chrome.runtime.sendMessage({ type: "diag" }),
      new Promise((r) => setTimeout(() => r({ error: "TIMEOUT" }), 4000)),
    ]);
  } catch {
    diag = { error: "DEAD" }; // context invalidated — this tab is stale
  }

  recheck.hidden = false;
  const ready = !!diag && !diag.error && !!(diag.claudeCli && diag.claudeCli.found);
  const lostLink = diag && (diag.error === "TIMEOUT" || diag.error === "DEAD");

  if (ready) {
    card.dataset.state = "ready";
    icon.textContent = "✓";
    title.textContent = "كل شيء جاهز!";
    msg.innerHTML = "افتح اللوحة الجانبية (أيقونة الإضافة في الشريط) وابدأ الدردشة.";
  } else if (lostLink) {
    card.dataset.state = "reload";
    icon.textContent = "↻";
    title.textContent = "أعِد تحميل هذه الصفحة";
    msg.innerHTML = "اضغط <strong>F5</strong>. وإن كنت تدردش مع الإضافة بنجاح فكلّ شيء يعمل — أغلق هذه الصفحة.";
  } else {
    card.dataset.state = "waiting";
    icon.textContent = "⏳";
    title.textContent = "بقيت خطوة واحدة";
    msg.innerHTML = "انقر نقرًا مزدوجًا على <code>SETUP-Windows.bat</code> داخل المجلّد، ثمّ <strong>أغلق المتصفّح وأعد فتحه</strong>.";
  }
}

recheck.addEventListener("click", check);
check();
// Keep polling so the card flips to ✓ on its own the moment setup completes.
setInterval(check, 3000);
