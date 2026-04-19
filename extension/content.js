/**
 * Content script for Claude Companion.
 *
 * Runs in every tab at document_idle. Exposes four DOM-level operations:
 *   • generateAccessibilityTree({filter, max_chars, diff})
 *   • getPageText()  — Readability-style extraction
 *   • findElements(query) — text or CSS
 *   • setFormValue(ref, value) / getRefCoordinates(ref) / scrollToRef(ref)
 *
 * Design goals:
 *   • Token efficiency first: selective refs, DOM diff, Readability, query-strip hrefs.
 *   • No dependencies — everything is hand-written.
 *   • Resilient to hostile DOMs (CSP, shadow roots, detached elements).
 */

(function () {
  // Guard against double injection
  if (window.__claudeCompanionLoaded) return;
  window.__claudeCompanionLoaded = true;

  // ─────────────────────────────────────────────────────────────────────
  // Automation visuals — border + click ripple
  // ─────────────────────────────────────────────────────────────────────
  const BORDER_ID = "__cc_automation_border__";
  const STYLE_ID = "__cc_overlay_style__";
  const CLAUDE_COLOR = "#c2632f";

  // Inject keyframes + classes once per page
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      @keyframes __cc_border_pulse {
        /* Outer-glow only — an inset shadow would eat up to 24 px of
           page content along every edge during each pulse, which users
           read as "part of the page is hidden" rather than "automation
           active". The 3 px solid border is already a strong cue. */
        0%, 100% { box-shadow: 0 0 0 2px rgba(194,99,47,.30); }
        50%      { box-shadow: 0 0 0 4px rgba(194,99,47,.55); }
      }
      @keyframes __cc_ripple {
        0%   { width: 0;    height: 0;    opacity: 1;   border-width: 3px; }
        60%  { opacity: .6; }
        100% { width: 90px; height: 90px; opacity: 0;   border-width: 1px; }
      }
      @keyframes __cc_fade_out {
        from { opacity: 1; } to { opacity: 0; }
      }
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  // Border lifecycle: sticky flag for task-level, auto-hide timer for activity-level
  let borderHideTimer = null;
  let borderSticky = false;

  function ensureBorderEl() {
    ensureStyle();
    let el = document.getElementById(BORDER_ID);
    if (el) return el;
    el = document.createElement("div");
    el.id = BORDER_ID;
    el.style.cssText = `
      position: fixed; inset: 0; z-index: 2147483647;
      pointer-events: none;
      border: 3px solid ${CLAUDE_COLOR};
      border-radius: 4px;
      /* No inset shadow — see keyframes comment above. The pulse adds
         the outer glow; the static border is just the 3 px line. */
      box-shadow: 0 0 0 2px rgba(194,99,47,.25);
      animation: __cc_border_pulse 2s ease-in-out infinite;
    `;
    (document.body || document.documentElement).appendChild(el);
    return el;
  }

  function showBorder(opts = {}) {
    ensureBorderEl();
    if (borderHideTimer) { clearTimeout(borderHideTimer); borderHideTimer = null; }
    if (opts.sticky) { borderSticky = true; return; }
    // Auto-hide after idle period (refreshed on every call)
    const ms = typeof opts.autoHideMs === "number" ? opts.autoHideMs : 2500;
    borderHideTimer = setTimeout(() => {
      if (!borderSticky) hideBorder(true);
    }, ms);
  }

  function hideBorder(force) {
    if (borderSticky && !force) return;
    borderSticky = false;
    if (borderHideTimer) { clearTimeout(borderHideTimer); borderHideTimer = null; }
    const el = document.getElementById(BORDER_ID);
    if (!el) return;
    // Graceful fade instead of abrupt removal
    el.style.animation = "__cc_fade_out 250ms ease-out forwards";
    setTimeout(() => { try { el.remove(); } catch {} }, 260);
  }

  // Click ripple — a briefly-expanding ring at the interaction point
  function showClickRipple(x, y, color = CLAUDE_COLOR) {
    ensureStyle();
    const r = document.createElement("div");
    r.style.cssText = `
      position: fixed; left: ${x}px; top: ${y}px;
      width: 0; height: 0;
      border: 3px solid ${color};
      border-radius: 50%;
      transform: translate(-50%, -50%);
      pointer-events: none; z-index: 2147483647;
      animation: __cc_ripple 650ms ease-out forwards;
    `;
    (document.body || document.documentElement).appendChild(r);
    setTimeout(() => { try { r.remove(); } catch {} }, 700);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Ref registry: stable string id → live Element
  // ─────────────────────────────────────────────────────────────────────
  const elementMap = new Map();
  let refCounter = 0;

  function getOrAssignRef(el) {
    if (!el.__ccRef) {
      el.__ccRef = `ref_${++refCounter}`;
      elementMap.set(el.__ccRef, el);
    }
    return el.__ccRef;
  }
  function resolveRef(ref) {
    const el = elementMap.get(ref);
    if (el && el.isConnected) return el;
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Visibility + role + accessible-name (ARIA-aware)
  // ─────────────────────────────────────────────────────────────────────
  const TAG_TO_ROLE = {
    a: "link", button: "button", input: "textbox", textarea: "textbox",
    select: "combobox", img: "img", h1: "heading", h2: "heading", h3: "heading",
    h4: "heading", h5: "heading", h6: "heading", nav: "navigation", main: "main",
    article: "article", section: "region", header: "banner", footer: "contentinfo",
    aside: "complementary", form: "form", label: "label", ul: "list", ol: "list",
    li: "listitem", table: "table", tr: "row", td: "cell", th: "columnheader",
  };

  function getRole(el) {
    const explicit = el.getAttribute?.("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const t = (el.type || "text").toLowerCase();
      const m = { checkbox: "checkbox", radio: "radio", range: "slider",
        button: "button", submit: "button", reset: "button",
        search: "searchbox", number: "spinbutton" };
      return m[t] || "textbox";
    }
    return TAG_TO_ROLE[tag] || null;
  }

  function getAccessibleName(el) {
    const al = el.getAttribute?.("aria-label");
    if (al) return al.trim();
    const lb = el.getAttribute?.("aria-labelledby");
    if (lb) {
      const names = lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim()).filter(Boolean);
      if (names.length) return names.join(" ");
    }
    if (el.placeholder) return el.placeholder.trim();
    if (el.alt) return el.alt.trim();
    if (el.title) return el.title.trim();
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return lbl.textContent?.trim() || "";
    }
    // For links/buttons the visible text is the best name
    const tag = el.tagName.toLowerCase();
    if (["a", "button", "summary"].includes(tag)) {
      return (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100);
    }
    return "";
  }

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (["a", "button", "input", "textarea", "select", "summary", "details"].includes(tag)) return true;
    const role = el.getAttribute?.("role");
    if (role && ["button", "link", "textbox", "checkbox", "radio", "tab", "menuitem",
      "switch", "combobox", "slider", "spinbutton", "searchbox", "option"].includes(role)) return true;
    if (el.tabIndex >= 0) return true;
    if (el.onclick || el.getAttribute?.("onclick")) return true;
    if (el.contentEditable === "true") return true;
    return false;
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    if (el.offsetParent === null && el.tagName.toLowerCase() !== "body") {
      const st = getComputedStyle(el);
      if (st.position !== "fixed") return false;
    }
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || parseFloat(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Accessibility tree generation (token-efficient)
  // ─────────────────────────────────────────────────────────────────────
  // Prune refs pointing at nodes that no longer live in the DOM.
  // Without this, SPA re-renders (Twitter, Gmail, Reddit) leak refs
  // indefinitely — the Map pins detached DOM trees forever, blocking GC.
  // Observed hundreds of MB retained after an hour on React-heavy sites.
  // Cheap enough to run at the top of every read_page: one Map walk,
  // typical size < a few hundred refs.
  function pruneDeadRefs() {
    for (const [ref, el] of elementMap) {
      if (!el || !el.isConnected) elementMap.delete(ref);
    }
  }

  function generateAccessibilityTree(options = {}) {
    pruneDeadRefs();
    const filter = options.filter || "interactive";
    const maxChars = options.max_chars || 12000;
    let out = "", chars = 0, truncated = false;

    function append(line) {
      if (truncated) return false;
      if (chars + line.length > maxChars) {
        out += line.substring(0, maxChars - chars) + "\n... (truncated)";
        truncated = true;
        return false;
      }
      out += line;
      chars += line.length;
      return true;
    }

    function walk(el, depth, indent) {
      if (truncated || depth > 15 || !el || el.nodeType !== 1) return;
      const tag = el.tagName.toLowerCase();
      if (["script", "style", "noscript", "template", "svg"].includes(tag)) return;

      const role = getRole(el);
      const name = getAccessibleName(el);
      const interactive = isInteractive(el);
      const visible = isVisible(el);
      const isContainer = el.children.length > 0;

      if (filter === "interactive" && !interactive && !isContainer) return;

      const show =
        (filter === "all" && (role || name)) ||
        (filter === "interactive" && interactive);

      if (show && visible) {
        const ref = getOrAssignRef(el);
        let line = indent;
        if (role) line += role;
        if (name) line += ` "${name.slice(0, 100)}"`;
        line += ` [${ref}]`;

        // Compact attributes — only what's useful for the agent
        if (tag === "input" && el.type && el.type !== "text") line += ` type=${el.type}`;
        if (["input", "textarea"].includes(tag) && el.value) line += ` value="${el.value.slice(0, 60)}"`;
        if (el.getAttribute?.("aria-expanded")) line += ` expanded=${el.getAttribute("aria-expanded")}`;
        if (el.getAttribute?.("aria-checked")) line += ` checked=${el.getAttribute("aria-checked")}`;
        if (el.getAttribute?.("aria-selected") === "true") line += ` selected`;
        if (el.disabled) line += " disabled";

        if (tag === "select") {
          const opts = Array.from(el.options);
          if (opts.length <= 20) {
            line += ` options=[${opts.map((o) => `${o.selected ? "*" : ""}${(o.textContent || "").trim().slice(0, 30)}`).join("|")}]`;
          } else {
            const sel = opts.find((o) => o.selected);
            line += ` options=${opts.length}, selected="${sel?.textContent?.trim() || ""}"`;
          }
        }
        if (options.include_href && tag === "a" && el.href) {
          const href = el.href.split("?")[0].slice(0, 60);
          line += ` href="${href}"`;
        }
        if (!append(line + "\n")) return;
      }

      const nextIndent = show && visible ? indent + "  " : indent;
      if (el.shadowRoot) {
        for (const child of el.shadowRoot.children) walk(child, depth + 1, nextIndent);
      }
      for (const child of el.children) walk(child, depth + 1, nextIndent);
    }

    walk(options.root || document.body, 0, "");
    return out;
  }

  // ─────────────────────────────────────────────────────────────────────
  // DOM diff — only send changes since the last read_page on this URL
  // ─────────────────────────────────────────────────────────────────────
  let lastSnapshot = null; // { url, lines, ts }

  function diffSnapshots(prev, curr) {
    const p = new Set(prev), c = new Set(curr);
    return {
      added: curr.filter((l) => !p.has(l)),
      removed: prev.filter((l) => !c.has(l)),
    };
  }

  function generateAccessibilityTreeDiff(options = {}) {
    const full = generateAccessibilityTree(options);
    const url = location.href;
    const lines = full.split("\n").filter((l) => l.length > 0);

    if (!lastSnapshot || lastSnapshot.url !== url || Date.now() - lastSnapshot.ts > 120_000) {
      lastSnapshot = { url, lines, ts: Date.now() };
      return { mode: "full", tree: full };
    }

    const { added, removed } = diffSnapshots(lastSnapshot.lines, lines);
    lastSnapshot = { url, lines, ts: Date.now() };

    if (added.length === 0 && removed.length === 0) {
      return { mode: "unchanged", tree: "" };
    }
    const diffSize = added.reduce((s, l) => s + l.length, 0) + removed.reduce((s, l) => s + l.length, 0);
    if (diffSize > full.length * 0.7) {
      return { mode: "full", tree: full };
    }
    let body = `DIFF (same URL, ${lines.length} elements total):\n`;
    if (added.length) body += `\n+ added (${added.length}):\n` + added.map((l) => "  " + l).join("\n");
    if (removed.length) body += `\n- removed (${removed.length}):\n` + removed.map((l) => "  " + l).join("\n");
    return { mode: "diff", tree: body };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Readability-style page text extraction
  // ─────────────────────────────────────────────────────────────────────
  const NEGATIVE_RE = /nav|header|footer|sidebar|comment|share|social|related|promo|banner|advert|cookie|newsletter|subscribe|breadcrumb|menu|widget/i;
  const POSITIVE_RE = /article|content|main|post|story|entry|body|text|prose/i;
  const JUNK_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "IFRAME", "NAV", "ASIDE", "FOOTER", "HEADER", "FORM", "BUTTON", "INPUT"]);

  function scoreBlock(el) {
    if (!el || el.nodeType !== 1 || JUNK_TAGS.has(el.tagName)) return -Infinity;
    const text = el.textContent || "";
    const textLen = text.trim().length;
    if (textLen < 140) return -Infinity;
    const linkText = Array.from(el.querySelectorAll("a")).reduce((s, a) => s + (a.textContent || "").length, 0);
    if (linkText / Math.max(textLen, 1) > 0.55) return -Infinity;
    let score = textLen + el.querySelectorAll("p").length * 30 + ((text.match(/[،,]/g) || []).length * 3) - linkText * 0.5;
    const cls = (el.className + " " + el.id).toString();
    if (POSITIVE_RE.test(cls)) score += 150;
    if (NEGATIVE_RE.test(cls)) score -= 250;
    if (el.tagName === "ARTICLE" || el.tagName === "MAIN") score += 200;
    if (el.getAttribute?.("role") === "main") score += 200;
    return score;
  }

  function findBestContent() {
    const explicit = document.querySelector("article, main, [role=main]");
    if (explicit && scoreBlock(explicit) > 0) return explicit;
    let best = null, bestScore = -Infinity;
    for (const el of document.querySelectorAll("article, main, section, div")) {
      const s = scoreBlock(el);
      if (s > bestScore) { bestScore = s; best = el; }
    }
    return best || document.body;
  }

  function extractCleanText(source) {
    const clone = source.cloneNode(true);
    clone.querySelectorAll("script,style,noscript,template,svg,iframe,nav,aside,footer,header,form,button,input,[role=navigation],[role=banner],[role=complementary],[aria-hidden=true]").forEach((el) => el.remove());
    clone.querySelectorAll("*").forEach((el) => {
      const cls = (el.className + " " + el.id).toString();
      if (NEGATIVE_RE.test(cls) && !POSITIVE_RE.test(cls)) el.remove();
    });
    return clone.textContent.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  function getPageText() {
    const title = document.title || "";
    const url = location.href;
    let source, mode;
    try { source = findBestContent(); mode = "readability"; }
    catch { source = document.body; mode = "fallback"; }
    let text;
    try { text = extractCleanText(source); }
    catch {
      const clone = (source || document.body).cloneNode(true);
      clone.querySelectorAll("script,style,noscript,template,svg").forEach((el) => el.remove());
      text = clone.textContent.replace(/\s+/g, " ").trim();
      mode = "fallback";
    }
    const MAX = 40000;
    if (text.length > MAX) text = text.slice(0, MAX) + "\n\n[truncated]";
    return JSON.stringify({ title, url, sourceTag: (source?.tagName || "BODY").toLowerCase(), mode, text });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Find elements (CSS selector first, then fuzzy text match)
  // ─────────────────────────────────────────────────────────────────────
  function findElements(query) {
    const results = [];
    // Try CSS first when query looks like a selector
    try {
      if (/^[#.\[\w]/.test(query) && /[#.\[>]/.test(query)) {
        for (const el of document.querySelectorAll(query)) {
          if (results.length >= 25) break;
          if (!isVisible(el)) continue;
          const ref = getOrAssignRef(el);
          const r = el.getBoundingClientRect();
          results.push({
            ref, tag: el.tagName.toLowerCase(), role: getRole(el) || el.tagName.toLowerCase(),
            name: getAccessibleName(el) || el.textContent?.trim()?.slice(0, 80) || "",
            interactive: isInteractive(el),
            coordinates: [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)],
            size: [Math.round(r.width), Math.round(r.height)],
          });
        }
        if (results.length) return results;
      }
    } catch {}

    // Fuzzy text search
    const q = query.toLowerCase();
    const all = document.querySelectorAll("a, button, input, textarea, select, [role]");
    for (const el of all) {
      if (results.length >= 25) break;
      if (!isVisible(el)) continue;
      const name = (getAccessibleName(el) + " " + (el.textContent || "")).toLowerCase();
      if (!name.includes(q)) continue;
      const ref = getOrAssignRef(el);
      const r = el.getBoundingClientRect();
      results.push({
        ref, tag: el.tagName.toLowerCase(), role: getRole(el) || el.tagName.toLowerCase(),
        name: getAccessibleName(el) || el.textContent?.trim()?.slice(0, 80) || "",
        interactive: isInteractive(el),
        coordinates: [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)],
        size: [Math.round(r.width), Math.round(r.height)],
      });
    }
    return results;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Form value setter (input/textarea/select/checkbox)
  // ─────────────────────────────────────────────────────────────────────
  function setFormValue(ref, value) {
    const el = resolveRef(ref);
    if (!el) return { error: `Element ${ref} not found` };
    const tag = el.tagName.toLowerCase();
    try {
      if (tag === "input" && (el.type === "checkbox" || el.type === "radio")) {
        el.checked = /^(true|1|on|yes)$/i.test(String(value));
      } else if (tag === "select") {
        for (const opt of el.options) {
          if (opt.value === value || opt.textContent.trim() === value) {
            el.value = opt.value;
            break;
          }
        }
      } else {
        el.focus();
        el.value = String(value);
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Highlight + scroll helpers
  // ─────────────────────────────────────────────────────────────────────
  function highlightElements(refs, ms = 1200) {
    const nodes = refs.map(resolveRef).filter(Boolean);
    for (const el of nodes) {
      const prev = el.style.outline;
      el.style.outline = "2px solid #4f8ff7";
      el.style.outlineOffset = "2px";
      setTimeout(() => { try { el.style.outline = prev; } catch {} }, ms);
    }
  }

  function getRefCoordinates(ref) {
    const el = resolveRef(ref);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }

  function scrollToRef(ref) {
    const el = resolveRef(ref);
    if (!el) return false;
    el.scrollIntoView({ behavior: "instant", block: "center" });
    return true;
  }

  // Tag the <input type=file> behind `ref` with a one-shot attribute so
  // the executor side can reach it via CDP DOM.querySelector without
  // needing to reimplement ref-resolution in the background context.
  // Returns a throwaway selector that matches ONLY this element; the
  // caller is responsible for removing the attribute afterward.
  function markRefForUpload(ref) {
    const el = resolveRef(ref);
    if (!el) return { error: `Element ${ref} not found` };
    const tag = (el.tagName || "").toLowerCase();
    if (tag !== "input" || el.type !== "file") {
      return { error: `Element ${ref} is not <input type="file"> (got <${tag} type="${el.type || ""}">)` };
    }
    const token = "cc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
    el.setAttribute("data-cc-upload-target", token);
    return { selector: `[data-cc-upload-target="${token}"]`, token };
  }
  // ─────────────────────────────────────────────────────────────────────
  // Click verification + JS fallback.
  //
  // Modern React / styled-component toggles (GitHub settings switches
  // are the paradigmatic example) rarely respond to CDP synthetic
  // mouse events — the element binding is a React onClick that often
  // checks `event.isTrusted`, and CDP events are untrusted. We solve
  // this with two helpers:
  //
  //   captureElementSnapshot(ref)
  //     Lightweight fingerprint of the target element — just the
  //     properties that flip on a successful toggle: outerHTML +
  //     selected attributes (aria-checked, aria-pressed, checked,
  //     data-state, class). Used before/after to detect whether the
  //     click actually did anything.
  //
  //   clickRefViaJS(ref)
  //     Calls `el.click()` directly. The trusted flag on the event is
  //     still false, but the React-registered handler runs on the
  //     DOM's click event and doesn't see it. Works for 90% of modern
  //     styled toggles.
  //
  // Combined with executor-side orchestration, the click flow becomes:
  //   1. try CDP mouse          (unchanged path, still works on
  //                              most real websites)
  //   2. capture snapshot before / after
  //   3. if no change → try clickRefViaJS
  //   4. capture snapshot again
  //   5. if still no change → surface a specific error
  // ─────────────────────────────────────────────────────────────────────

  const CLICK_ATTRS_OF_INTEREST = [
    "aria-checked",
    "aria-pressed",
    "aria-expanded",
    "aria-selected",
    "checked",
    "data-state",
    "class",
    "disabled",
    "hidden",
  ];

  function captureElementSnapshot(ref) {
    const el = resolveRef(ref);
    if (!el) return { error: `Element ${ref} not found` };
    const attrs = {};
    for (const name of CLICK_ATTRS_OF_INTEREST) {
      if (el.hasAttribute(name)) attrs[name] = el.getAttribute(name);
    }
    // outerHTML cap — 2 KB is plenty to catch attribute/child changes
    // while keeping the payload cheap over the content-script channel.
    const outer = el.outerHTML || "";
    return {
      attrs,
      outer: outer.length > 2048 ? outer.slice(0, 2048) : outer,
      hasFocus: document.activeElement === el,
    };
  }

  function clickRefViaJS(ref) {
    const el = resolveRef(ref);
    if (!el) return { error: `Element ${ref} not found` };
    // Prefer .click() when available — it dispatches a trusted-looking
    // click to ALL DOM event handlers, including React-registered ones.
    // Falls back to dispatching a synthetic MouseEvent for elements
    // without a native click method (rare: <svg>, some custom elements).
    try {
      if (typeof el.click === "function") {
        el.click();
      } else {
        const evt = new MouseEvent("click", { bubbles: true, cancelable: true, view: window });
        el.dispatchEvent(evt);
      }
      return { ok: true };
    } catch (e) {
      return { error: String(e?.message || e) };
    }
  }

  function clearUploadMark(token) {
    if (!token) return false;
    const el = document.querySelector(`[data-cc-upload-target="${token}"]`);
    if (el) el.removeAttribute("data-cc-upload-target");
    return !!el;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Set-of-Mark labels for screenshots
  //
  // Paints numbered badges on every visible interactive element before
  // a screenshot is taken, so Claude can look at the image and say
  // "click label 5" instead of guessing coordinates or hunting refs.
  // Same technique used by browser-use and OpenAI Operator.
  //
  // Returns a mapping { "1": { ref, role, name, x, y, w, h }, ... }
  // so the caller can resolve "label 5" back to a real interactable
  // element with its DOM ref.
  //
  // Labels are capped at 40 to keep the image readable and to bias
  // toward the most-interactable subset. Overlay is removed via
  // removeScreenshotLabels() or auto-expires after 8 s as a safety.
  // ─────────────────────────────────────────────────────────────────────
  const LABEL_CONTAINER_ID = "__cc_som_labels__";
  let labelAutoHideTimer = null;

  function addScreenshotLabels(maxLabels = 40) {
    removeScreenshotLabels();
    ensureStyle();
    const container = document.createElement("div");
    container.id = LABEL_CONTAINER_ID;
    container.style.cssText = `
      position: fixed; inset: 0; pointer-events: none;
      z-index: 2147483647;
    `;

    // Only label elements that are actually interactive + visible in viewport.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const candidates = [];
    // Use querySelectorAll for speed — only a handful of selectors.
    const sel = 'button, a[href], input:not([type="hidden"]), select, textarea, '
      + '[role="button"], [role="link"], [role="textbox"], [role="checkbox"], '
      + '[role="menuitem"], [role="tab"], [role="option"], [tabindex]:not([tabindex="-1"])';
    for (const el of document.querySelectorAll(sel)) {
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) continue;
      if (r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) continue;
      candidates.push({ el, r, area: r.width * r.height });
    }
    // Sort by area descending — bigger / more obvious elements get
    // lower label numbers, which reads nicer in the image.
    candidates.sort((a, b) => b.area - a.area);
    const chosen = candidates.slice(0, maxLabels);

    const mapping = {};
    const hues = ["#f97316", "#22c55e", "#3b82f6", "#a855f7", "#ec4899"];
    chosen.forEach((c, idx) => {
      const n = idx + 1;
      const ref = getOrAssignRef(c.el);
      const role = getRole(c.el) || "";
      const name = getAccessibleName(c.el) || "";
      const color = hues[idx % hues.length];

      // Ring around the element
      const ring = document.createElement("div");
      ring.style.cssText = `
        position: fixed;
        left: ${Math.max(0, c.r.left - 2)}px;
        top: ${Math.max(0, c.r.top - 2)}px;
        width: ${c.r.width + 4}px;
        height: ${c.r.height + 4}px;
        border: 2px solid ${color};
        border-radius: 4px;
        box-sizing: border-box;
      `;
      container.appendChild(ring);

      // Number badge — top-right corner of the element, clamped inside viewport
      const badgeSize = 18;
      let bx = c.r.right - badgeSize;
      let by = Math.max(0, c.r.top - badgeSize / 2);
      if (bx + badgeSize > vw) bx = vw - badgeSize;
      if (bx < 0) bx = 0;
      const badge = document.createElement("div");
      badge.textContent = String(n);
      badge.style.cssText = `
        position: fixed;
        left: ${bx}px; top: ${by}px;
        width: ${badgeSize}px; height: ${badgeSize}px;
        background: ${color}; color: #fff;
        font: bold 11px -apple-system, sans-serif;
        line-height: ${badgeSize}px; text-align: center;
        border-radius: 4px;
        box-shadow: 0 1px 3px rgba(0,0,0,.4);
      `;
      container.appendChild(badge);

      mapping[n] = {
        ref, role,
        name: name.slice(0, 60),
        x: Math.round(c.r.x + c.r.width / 2),
        y: Math.round(c.r.y + c.r.height / 2),
        w: Math.round(c.r.width),
        h: Math.round(c.r.height),
      };
    });

    (document.body || document.documentElement).appendChild(container);
    if (labelAutoHideTimer) clearTimeout(labelAutoHideTimer);
    labelAutoHideTimer = setTimeout(removeScreenshotLabels, 8000);
    return { labels: mapping, count: chosen.length, total: candidates.length };
  }

  function removeScreenshotLabels() {
    if (labelAutoHideTimer) { clearTimeout(labelAutoHideTimer); labelAutoHideTimer = null; }
    const el = document.getElementById(LABEL_CONTAINER_ID);
    if (el) el.remove();
  }

  // ─────────────────────────────────────────────────────────────────────
  // Message handler (bridge from service worker)
  // ─────────────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "generateAccessibilityTree") {
      const opts = msg.options || {};
      if (opts.diff !== false) {
        const { mode, tree } = generateAccessibilityTreeDiff(opts);
        sendResponse({ result: tree, mode });
      } else {
        sendResponse({ result: generateAccessibilityTree(opts), mode: "full" });
      }
      return true;
    }
    if (msg.type === "getPageText") { sendResponse({ result: getPageText() }); return true; }
    if (msg.type === "findElements") { sendResponse({ result: findElements(msg.query) }); return true; }
    if (msg.type === "setFormValue") { sendResponse({ result: setFormValue(msg.ref, msg.value) }); return true; }
    if (msg.type === "getRefCoordinates") { sendResponse({ result: getRefCoordinates(msg.ref) }); return true; }
    if (msg.type === "scrollToRef") { sendResponse({ result: scrollToRef(msg.ref) }); return true; }
    if (msg.type === "markRefForUpload") { sendResponse({ result: markRefForUpload(msg.ref) }); return true; }
    if (msg.type === "clearUploadMark") { sendResponse({ result: clearUploadMark(msg.token) }); return true; }
    if (msg.type === "captureElementSnapshot") { sendResponse({ result: captureElementSnapshot(msg.ref) }); return true; }
    if (msg.type === "clickRefViaJS") { sendResponse({ result: clickRefViaJS(msg.ref) }); return true; }
    if (msg.type === "highlightElements") { highlightElements(msg.refs || []); sendResponse({ result: true }); return true; }
    if (msg.type === "addScreenshotLabels") { sendResponse({ result: addScreenshotLabels(msg.max || 40) }); return true; }
    if (msg.type === "removeScreenshotLabels") { removeScreenshotLabels(); sendResponse({ result: true }); return true; }
    if (msg.type === "showAutomationBorder") {
      showBorder({ sticky: !!msg.sticky, autoHideMs: msg.autoHideMs });
      sendResponse({ result: true });
      return true;
    }
    if (msg.type === "hideAutomationBorder") {
      hideBorder(true);
      sendResponse({ result: true });
      return true;
    }
    if (msg.type === "showClickRipple") {
      showClickRipple(msg.x, msg.y, msg.color);
      sendResponse({ result: true });
      return true;
    }
  });

  // Expose for executeScript fallback
  window.__claudeCompanion = { generateAccessibilityTree, generateAccessibilityTreeDiff, getPageText, findElements, setFormValue, resolveRef, getRefCoordinates, scrollToRef, elementMap };
})();
