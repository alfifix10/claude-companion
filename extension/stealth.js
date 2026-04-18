/**
 * Anti-automation fingerprint neutraliser.
 *
 * Runs in the page's MAIN world at document_start — BEFORE any of the
 * page's own scripts touch these globals. Standard technique ported
 * from puppeteer-extra-plugin-stealth; patches only the signals that
 * mainstream bot detectors (Cloudflare Turnstile, Datadome-lite,
 * most DIY anti-scrape) actually check, while staying conservative
 * enough to avoid breaking real sites.
 *
 * Why these specific patches:
 *   • navigator.webdriver → Chromium sets this to true for ANY
 *     chrome.debugger attach. It's THE single flag bot detectors
 *     check first.
 *   • navigator.plugins length → headless/automated Chromium often
 *     ships empty plugin arrays. Regular Chromium has a PDF viewer.
 *   • window.chrome.runtime → missing in some automated contexts.
 *   • navigator.permissions.query for "notifications" → the classic
 *     "permission says prompt but Notification.permission says
 *     granted" mismatch is a well-known automation tell.
 *
 * Deliberately NOT patched:
 *   • Canvas / WebGL fingerprint noise — breaks chart libraries,
 *     Pixi, Three.js, tldraw, Figma. Sites that check these are
 *     generally anti-bot enterprises we can't beat anyway.
 *   • User-Agent spoofing — UA is already correct in extensions;
 *     changing it breaks server-side detection of "real Chrome".
 */
(() => {
  try {
    // --- 1. navigator.webdriver ---
    if (navigator.webdriver !== undefined) {
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined,
        configurable: true,
      });
    }

    // --- 2. navigator.plugins — realistic default set ---
    if (!navigator.plugins || navigator.plugins.length === 0) {
      const makePlugin = (name, filename, description) => {
        const p = Object.create(Plugin.prototype);
        Object.defineProperties(p, {
          name:        { value: name,        enumerable: true },
          filename:    { value: filename,    enumerable: true },
          description: { value: description, enumerable: true },
          length:      { value: 1,           enumerable: true },
        });
        return p;
      };
      const plugins = [
        makePlugin("PDF Viewer",          "internal-pdf-viewer", "Portable Document Format"),
        makePlugin("Chrome PDF Viewer",   "internal-pdf-viewer", ""),
        makePlugin("Chromium PDF Viewer", "internal-pdf-viewer", ""),
        makePlugin("Microsoft Edge PDF Viewer", "internal-pdf-viewer", ""),
        makePlugin("WebKit built-in PDF", "internal-pdf-viewer", ""),
      ];
      Object.defineProperty(navigator, "plugins", {
        get: () => plugins,
        configurable: true,
      });
    }

    // --- 3. window.chrome.runtime — some sites look for the object ---
    if (!window.chrome) {
      window.chrome = {};
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {};
    }

    // --- 4. Permissions API consistency for notifications ---
    if (navigator.permissions && navigator.permissions.query) {
      const origQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (params) => {
        if (params && params.name === "notifications") {
          return Promise.resolve({ state: Notification.permission });
        }
        return origQuery(params);
      };
    }

    // --- 5. Languages — prefer user's apparent locale over empty ---
    if (!navigator.languages || navigator.languages.length === 0) {
      Object.defineProperty(navigator, "languages", {
        get: () => ["ar-SA", "ar", "en-US", "en"],
        configurable: true,
      });
    }
  } catch {
    // Silent: any failure here is better than a page-load error.
  }
})();
