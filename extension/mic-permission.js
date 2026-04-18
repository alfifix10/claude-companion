const $ask = document.getElementById("ask");
const $close = document.getElementById("close");
const $status = document.getElementById("status");

// Detect Brave up front — speech recognition routes through Google's
// speech endpoint, which Brave's "Block cross-site trackers" default
// blocks network-level. Permission can be granted and the mic still
// won't transcribe. We tell the user this BEFORE they're frustrated.
async function isBrave() {
  try { return !!(navigator.brave && await navigator.brave.isBrave()); }
  catch { return false; }
}

function render(state, html) {
  $status.className = "status " + state;   // "ok" | "err"
  $status.innerHTML = html;
  $status.classList.remove("hide");
}

/**
 * Try a real SpeechRecognition session to see whether the Google
 * endpoint is actually reachable. Resolves to a plain string:
 *   "ok"           — mic AND speech API both work
 *   "network"      — speech API blocked (Brave Shields / firewall)
 *   "unsupported"  — browser doesn't expose Web Speech at all
 *   "other:<err>"  — something else failed
 */
function testRecognition() {
  return new Promise((resolve) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return resolve("unsupported");
    const r = new SR();
    r.lang = "ar-SA";
    r.continuous = false;
    r.interimResults = false;
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; try { r.abort(); } catch {} resolve(v); } };
    r.onstart = () => {
      // Give the endpoint ~1.5s to fail with a network error. If it
      // stays open (listening silently), we assume it works.
      setTimeout(() => done("ok"), 1500);
    };
    r.onerror = (e) => {
      if (e.error === "network") done("network");
      else if (e.error === "not-allowed" || e.error === "service-not-allowed") done("other:permission");
      else done("other:" + e.error);
    };
    r.onend = () => done("ok");
    try { r.start(); }
    catch (e) { done("other:" + (e?.message || "start_failed")); }
  });
}

$ask.addEventListener("click", async () => {
  $ask.disabled = true;
  $ask.textContent = "جارٍ الطلب...";
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  } catch (err) {
    render("err",
      err?.name === "NotAllowedError"
        ? "رفضت الإذن. افتح إعدادات المتصفح واسمح يدوياً."
        : "خطأ: " + (err?.message || err));
    $ask.disabled = false;
    $ask.textContent = "إعادة المحاولة";
    return;
  }

  // Permission granted. Now verify the speech endpoint is reachable.
  $ask.textContent = "جارٍ الاختبار...";
  const result = await testRecognition();
  const brave = await isBrave();

  if (result === "ok") {
    render("ok", "✓ الميكروفون جاهز. أغلق هذه الصفحة واستخدم 🎤 في الشريط الجانبي.");
    $ask.style.display = "none";
  } else if (result === "network") {
    // Known Brave/firewall case — be specific + actionable.
    const braveTip = brave
      ? `<b>Brave يحجب الخدمة افتراضياً.</b><br>
         الحل: <a style="color:#c2632f" href="brave://settings/shields" target="_blank">brave://settings/shields</a>
         → عطّل "Block cross-site trackers" — أو استخدم Chrome/Edge للإدخال الصوتي.`
      : `خدمة التعرّف الصوتي (Google) محجوبة على هذه الشبكة أو من المتصفح.
         جرّب شبكة مختلفة أو Chrome/Edge.`;
    render("err",
      `⚠️ الإذن مُنح، لكن <b>التعرّف الصوتي لا يعمل</b>.<br><br>${braveTip}<br><br>
       الكتابة اليدوية تعمل بشكل طبيعيّ.`);
    $ask.style.display = "none";
  } else if (result === "unsupported") {
    render("err", "متصفّحك لا يدعم التعرّف الصوتي (Web Speech API).");
    $ask.style.display = "none";
  } else {
    render("err", "تعذّر الاختبار: " + result.replace(/^other:/, ""));
    $ask.disabled = false;
    $ask.textContent = "إعادة المحاولة";
    return;
  }
  $close.className = "close";
});

$close.addEventListener("click", () => window.close());
