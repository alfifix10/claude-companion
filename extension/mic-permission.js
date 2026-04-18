const $ask = document.getElementById("ask");
const $close = document.getElementById("close");
const $status = document.getElementById("status");

$ask.addEventListener("click", async () => {
  $ask.disabled = true;
  $ask.textContent = "جارٍ الطلب...";
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    $status.className = "status ok";
    $status.textContent = "✓ تم منح الإذن. أغلق هذه الصفحة واستخدم 🎤 في الشريط الجانبي.";
    $close.className = "close";
    $ask.style.display = "none";
  } catch (err) {
    $status.className = "status err";
    $status.textContent = err?.name === "NotAllowedError"
      ? "رفضت الإذن. افتح إعدادات المتصفح واسمح يدوياً."
      : "خطأ: " + (err?.message || err);
    $ask.disabled = false;
    $ask.textContent = "إعادة المحاولة";
  }
});

$close.addEventListener("click", () => window.close());
