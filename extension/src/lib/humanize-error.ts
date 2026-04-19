/**
 * humanize-error — translate the most common English / technical error
 * strings that leak out of CDP, chrome.*, Chromium's networking stack,
 * and our own native host into short Arabic explanations the user can
 * actually act on.
 *
 * Strategy (order matters):
 *   1. Try every pattern first — even on mixed-language input. So a
 *      "خطأ: ERR_NAME_NOT_RESOLVED" still translates the English code.
 *   2. If nothing matched AND the string already contains Arabic, trust
 *      that one of our own layers produced it and pass through.
 *   3. Otherwise it's an untranslated English leak — prefix with
 *      "خطأ فنيّ:" so the user can't mistake the noise for the
 *      assistant's actual reply.
 *
 * This is a pure function — the single-call export keeps it a trivial
 * drop-in from the old panel.js copy. All patterns and their targets
 * are exported too so callers can inspect, log, or augment them.
 */

export type ErrorPattern = readonly [RegExp, string];

export const ERROR_PATTERNS: readonly ErrorPattern[] = [
  [
    /Cannot access a chrome:\/\/ URL|Cannot access contents of (?:url|the page)/i,
    "صفحة داخليّة — افتح موقعاً عادياً ثم حاول.",
  ],
  [/No tab with id/i, "التبويب أُغلِق — أعد فتحه."],
  [/Debugger is already attached/i, "المتصفّح متّصل بالفعل — أعد المحاولة."],
  [/Detached while handling command|Target closed/i, "التبويب أُغلِق أثناء التنفيذ."],
  [/Cannot navigate to invalid URL/i, "رابط غير صالح."],
  [/ERR_NAME_NOT_RESOLVED/i, "فشل حلّ عنوان الموقع."],
  [
    /ERR_INTERNET_DISCONNECTED|Failed to (?:fetch|connect)|NetworkError|ERR_NETWORK/i,
    "تعذّر الاتصال بالشبكة.",
  ],
  [/ERR_CONNECTION_REFUSED/i, "الخادم رفض الاتصال."],
  [/ERR_TIMED_OUT/i, "انتهت مهلة الاتصال."],
  [/ERR_CERT_|ERR_SSL_/i, "مشكلة في شهادة الموقع."],
  [/NO_NATIVE_HOST/i, "جسر الإضافة غير متّصل — أعد تحميل الإضافة."],
  [/POST_FAILED/i, "فشل إرسال الطلب للمضيف."],
  [/^TIMEOUT$|\bTIMEOUT\b/i, "انتهت المهلة دون ردّ."],
];

// Arabic-script range. If the caller handed us a string that already
// has Arabic in it AND no pattern matched, we assume one of our own
// layers produced it and return it verbatim.
const ARABIC_RE = /[\u0600-\u06FF]/;

const TECHNICAL_PREFIX = "خطأ فنيّ: ";
const UNKNOWN = "خطأ غير معروف";

/**
 * Convert a raw error string into a short Arabic message.
 * Always returns a non-empty string — never null / undefined.
 */
export function humanizeError(input: unknown): string {
  const s = String(input ?? "").trim();
  if (!s) return UNKNOWN;

  for (const [re, ar] of ERROR_PATTERNS) {
    if (re.test(s)) return ar;
  }

  if (ARABIC_RE.test(s)) return s;

  return TECHNICAL_PREFIX + s;
}
