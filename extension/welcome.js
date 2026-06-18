/* Welcome page — auto-detecting, self-healing. One status card, one action.
 *
 * "Working?" is answered by max_probe (a lightweight host-reachable ping —
 * the SAME health signal the side panel trusts), not the heavier diag
 * round-trip that was timing out. Two outcomes:
 *   ready    → host reachable → "open the side panel"
 *   waiting  → not reachable  → "run SETUP, restart the browser"
 *
 * Self-heal: if THIS tab's extension context died (it was open across an
 * extension reload), chrome.runtime.* throws. Rather than make the user
 * press F5, the page reloads itself ONCE — the fresh page reconnects and
 * flips to green on its own. The one-reload guard (cleared on any successful
 * reply) stops a loop if the extension is genuinely gone.
 */
const $ = (id) => document.getElementById(id);
const card = $("card");
const icon = $("icon");
const title = $("title");
const msg = $("msg");
const recheck = $("recheck");

function setReady() {
  card.dataset.state = "ready";
  icon.textContent = "✓";
  title.textContent = "كل شيء جاهز!";
  msg.innerHTML = "افتح اللوحة الجانبية (أيقونة الإضافة في الشريط) وابدأ الدردشة.";
}
function setWaiting() {
  card.dataset.state = "waiting";
  icon.textContent = "⏳";
  title.textContent = "بقيت خطوة واحدة";
  msg.innerHTML = "انقر نقرًا مزدوجًا على <code>SETUP-Windows.bat</code> داخل المجلّد، ثمّ <strong>أغلق المتصفّح وأعد فتحه</strong>.";
}

async function check() {
  let res;
  try {
    res = await Promise.race([
      chrome.runtime.sendMessage({ type: "max_probe" }),
      new Promise((r) => setTimeout(() => r({ timeout: true }), 5000)),
    ]);
  } catch {
    // Dead context — this tab is stale after an extension reload. Self-heal
    // by reloading once; the fresh page reconnects.
    if (!sessionStorage.getItem("cc-reloaded")) {
      sessionStorage.setItem("cc-reloaded", "1");
      location.reload();
    } else {
      setWaiting(); // already retried and still no extension — show the step
    }
    recheck.hidden = false;
    return;
  }

  // Got a real reply → the context is alive; reset the self-heal budget so a
  // future reload gets its own one-shot recovery.
  if (res && !res.timeout) sessionStorage.removeItem("cc-reloaded");

  recheck.hidden = false;
  if (res && res.ok === true) setReady();
  else setWaiting();
}

recheck.addEventListener("click", check);
check();
// Poll so the card flips to ✓ on its own the moment setup completes.
setInterval(check, 3000);
