import { describe, expect, it } from "vitest";
import { ERROR_PATTERNS, humanizeError } from "./humanize-error.js";

describe("humanizeError — fallback branches", () => {
  it("null → 'خطأ غير معروف'", () => {
    expect(humanizeError(null)).toBe("خطأ غير معروف");
  });

  it("undefined → 'خطأ غير معروف'", () => {
    expect(humanizeError(undefined)).toBe("خطأ غير معروف");
  });

  it("empty string → 'خطأ غير معروف'", () => {
    expect(humanizeError("")).toBe("خطأ غير معروف");
  });

  it("whitespace-only → 'خطأ غير معروف'", () => {
    expect(humanizeError("   \n\t  ")).toBe("خطأ غير معروف");
  });

  it("Arabic string with no pattern match → passes through", () => {
    const arabic = "فشل شيء ما لا أعرف ما هو";
    expect(humanizeError(arabic)).toBe(arabic);
  });

  it("unknown English → 'خطأ فنيّ: …' prefix", () => {
    expect(humanizeError("RandomError: wat")).toBe("خطأ فنيّ: RandomError: wat");
  });

  it("object with .toString → handled via String()", () => {
    const obj = { toString: () => "TIMEOUT" };
    expect(humanizeError(obj)).toBe("انتهت المهلة دون ردّ.");
  });
});

describe("humanizeError — every documented pattern fires", () => {
  it("Cannot access a chrome:// URL", () => {
    expect(humanizeError("Cannot access a chrome:// URL")).toBe(
      "صفحة داخليّة — افتح موقعاً عادياً ثم حاول.",
    );
  });

  it("Cannot access contents of url", () => {
    expect(humanizeError("Cannot access contents of url https://x")).toBe(
      "صفحة داخليّة — افتح موقعاً عادياً ثم حاول.",
    );
  });

  it("Cannot access contents of the page", () => {
    expect(humanizeError("Cannot access contents of the page")).toBe(
      "صفحة داخليّة — افتح موقعاً عادياً ثم حاول.",
    );
  });

  it("No tab with id", () => {
    expect(humanizeError("No tab with id 42")).toBe("التبويب أُغلِق — أعد فتحه.");
  });

  it("Debugger is already attached", () => {
    expect(humanizeError("Debugger is already attached to this tab")).toBe(
      "المتصفّح متّصل بالفعل — أعد المحاولة.",
    );
  });

  it("Detached while handling command", () => {
    expect(humanizeError("Detached while handling command Input.dispatchMouseEvent")).toBe(
      "التبويب أُغلِق أثناء التنفيذ.",
    );
  });

  it("Target closed", () => {
    expect(humanizeError("Target closed")).toBe("التبويب أُغلِق أثناء التنفيذ.");
  });

  it("Cannot navigate to invalid URL", () => {
    expect(humanizeError("Cannot navigate to invalid URL 'ht tp://x'")).toBe("رابط غير صالح.");
  });

  it("ERR_NAME_NOT_RESOLVED", () => {
    expect(humanizeError("net::ERR_NAME_NOT_RESOLVED")).toBe("فشل حلّ عنوان الموقع.");
  });

  it("ERR_INTERNET_DISCONNECTED", () => {
    expect(humanizeError("ERR_INTERNET_DISCONNECTED")).toBe("تعذّر الاتصال بالشبكة.");
  });

  it("Failed to fetch", () => {
    expect(humanizeError("TypeError: Failed to fetch")).toBe("تعذّر الاتصال بالشبكة.");
  });

  it("Failed to connect", () => {
    expect(humanizeError("Failed to connect to endpoint")).toBe("تعذّر الاتصال بالشبكة.");
  });

  it("NetworkError", () => {
    expect(humanizeError("NetworkError when attempting to fetch")).toBe("تعذّر الاتصال بالشبكة.");
  });

  it("ERR_NETWORK", () => {
    expect(humanizeError("ERR_NETWORK_CHANGED")).toBe("تعذّر الاتصال بالشبكة.");
  });

  it("ERR_CONNECTION_REFUSED", () => {
    expect(humanizeError("net::ERR_CONNECTION_REFUSED")).toBe("الخادم رفض الاتصال.");
  });

  it("ERR_TIMED_OUT", () => {
    expect(humanizeError("net::ERR_TIMED_OUT")).toBe("انتهت مهلة الاتصال.");
  });

  it("ERR_CERT_DATE_INVALID", () => {
    expect(humanizeError("net::ERR_CERT_DATE_INVALID")).toBe("مشكلة في شهادة الموقع.");
  });

  it("ERR_SSL_PROTOCOL_ERROR", () => {
    expect(humanizeError("net::ERR_SSL_PROTOCOL_ERROR")).toBe("مشكلة في شهادة الموقع.");
  });

  it("NO_NATIVE_HOST", () => {
    expect(humanizeError("NO_NATIVE_HOST")).toBe("جسر الإضافة غير متّصل — أعد تحميل الإضافة.");
  });

  it("POST_FAILED", () => {
    expect(humanizeError("POST_FAILED")).toBe("فشل إرسال الطلب للمضيف.");
  });

  it("exact 'TIMEOUT'", () => {
    expect(humanizeError("TIMEOUT")).toBe("انتهت المهلة دون ردّ.");
  });

  it("bare word TIMEOUT inside a longer message", () => {
    expect(humanizeError("got a TIMEOUT from worker")).toBe("انتهت المهلة دون ردّ.");
  });
});

describe("humanizeError — mixed-language input still gets translated", () => {
  it("Arabic prefix + English ERR_ code → ERR_ wins", () => {
    expect(humanizeError("خطأ: ERR_NAME_NOT_RESOLVED في الطلب")).toBe("فشل حلّ عنوان الموقع.");
  });

  it("Arabic wrapper around 'Failed to fetch'", () => {
    expect(humanizeError("حدث خطأ Failed to fetch أثناء التنفيذ")).toBe("تعذّر الاتصال بالشبكة.");
  });
});

describe("humanizeError — doesn't mis-fire", () => {
  it("legitimate 'error without' keyword doesn't match any pattern", () => {
    expect(humanizeError("generic failure")).toBe("خطأ فنيّ: generic failure");
  });

  it("string containing 'TIMED_OUT' alone (not ERR_TIMED_OUT) still matches", () => {
    // documented behaviour: ERR_ prefix not required
    expect(humanizeError("ERR_TIMED_OUT somewhere")).toBe("انتهت مهلة الاتصال.");
  });

  it("'my_passwords.txt' type string passes through (not our concern)", () => {
    expect(humanizeError("my_passwords.txt")).toBe("خطأ فنيّ: my_passwords.txt");
  });
});

describe("ERROR_PATTERNS export sanity", () => {
  it("has exactly the documented number of patterns", () => {
    expect(ERROR_PATTERNS).toHaveLength(13);
  });

  it("every pattern is a [RegExp, string] tuple", () => {
    for (const [re, ar] of ERROR_PATTERNS) {
      expect(re).toBeInstanceOf(RegExp);
      expect(typeof ar).toBe("string");
      expect(ar.length).toBeGreaterThan(0);
    }
  });

  it("every translation contains at least one Arabic character", () => {
    const arabic = /[\u0600-\u06FF]/;
    for (const [, ar] of ERROR_PATTERNS) {
      expect(ar).toMatch(arabic);
    }
  });
});
