/**
 * markdown — the extension's hand-rolled Markdown → HTML renderer.
 *
 * Pure function: `renderMarkdown(src)` takes a Markdown string and
 * returns safe HTML ready to drop into `element.innerHTML`.
 *
 * Why hand-rolled and not `marked` / `markdown-it`:
 *   • ~100 lines covers every pattern Claude actually emits
 *   • we own every security-sensitive path (link URL hardening)
 *
 * Supported syntax:
 *   • headings         # .. ####    → <h2> .. <h5>
 *   • bold / italic    **x** / *x*  → <strong> / <em>
 *   • inline code      `x`          → <code>
 *   • fenced code      ```lang\n… → <pre><code>
 *   • unordered lists  - / *        → <ul><li>
 *   • ordered lists    1.           → <ol><li>
 *   • tables           | … | … |    → <table>
 *   • links            [t](u)       → <a> (with XSS hardening)
 *   • paragraphs       \n\n         → <p>
 *   • soft breaks      \n           → <br>
 *
 * XSS defences (layered — both must fail for an attack to land):
 *   1. Our own escaping + URL hardening (this file's logic).
 *   2. DOMPurify as a final pass — vendored copy at ./dompurify.mjs.
 *      Defense-in-depth: tool_result text often originates from a
 *      hostile page (read_page on attacker-controlled site) and is
 *      summarised by Claude into the chat. If the markdown rules ever
 *      miss a vector (regex blind spot, future syntax addition),
 *      DOMPurify catches it before innerHTML.
 */
import DOMPurify from "./dompurify.mjs";
// Allowlist for sanitisation. We only emit a small fixed set of tags —
// listing them explicitly is safer than relying on the default profile,
// because the default permits things like <form>, <input>, <iframe>,
// <video>, etc. that our renderer never produces and which would only
// arrive via injection.
const PURIFY_CONFIG = {
    ALLOWED_TAGS: [
        "p", "br", "strong", "em", "code", "pre",
        "h2", "h3", "h4", "h5", "h6",
        "ul", "ol", "li",
        "table", "thead", "tbody", "tr", "th", "td",
        "a",
    ],
    ALLOWED_ATTR: ["href", "target", "rel"],
};
// DOMPurify strips `target` from <a> by default (its anti-clickjacking
// stance). We re-apply target=_blank + rel=noopener noreferrer for
// every surviving anchor. This is the pattern DOMPurify itself
// recommends (see "Hooks" in cure53/DOMPurify README) and matches
// what our hand-rolled renderer used to emit.
let hookInstalled = false;
function ensureLinkHook() {
    if (hookInstalled)
        return;
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
        if (node.tagName === "A") {
            node.setAttribute("target", "_blank");
            node.setAttribute("rel", "noopener noreferrer");
        }
    });
    hookInstalled = true;
}
// Built via `new RegExp` so the NUL sentinel sits in a plain string
// literal instead of the regex source — keeps Biome quiet about
// control characters in regexes, which for us is intentional.
const SENTINEL = "\x00CODEBLOCK";
const CODEBLOCK_SENTINEL_RE = new RegExp(`${SENTINEL}(\\d+)\x00`, "g");
// URL-hardening: reject control chars, whitespace, and a few markup
// smugglers before the link is emitted.
const UNSAFE_URL_CHARS_RE = new RegExp(`[${"\u0000"}-${"\u001f"}${"\u007f"} <>"\`\\\\]`);
/**
 * HTML-escape the five attribute-sensitive characters plus single
 * quote, matching what the extension has always used.
 */
export function escapeHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
/**
 * Render a Markdown string to HTML. Safe to inject via innerHTML.
 * Returns empty string for null / undefined / empty input.
 */
export function renderMarkdown(src) {
    if (!src)
        return "";
    let text = String(src);
    // Extract fenced code blocks so their contents aren't touched by
    // other rules. Empty language tag (```\n...```) is accepted too.
    const codeBlocks = [];
    text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
        codeBlocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
        return `${SENTINEL}${codeBlocks.length - 1}\x00`;
    });
    // Escape everything that's not a code block.
    text = escapeHtml(text);
    // Headings (#### → h5, ### → h4, ## → h3, # → h2). Start-of-line
    // anchoring (`^` with /gm) means we don't pick up `#` inside text.
    text = text
        .replace(/^#### (.*)$/gm, "<h5>$1</h5>")
        .replace(/^### (.*)$/gm, "<h4>$1</h4>")
        .replace(/^## (.*)$/gm, "<h3>$1</h3>")
        .replace(/^# (.*)$/gm, "<h2>$1</h2>");
    // Tables: | col1 | col2 | with a ---|---| separator row.
    text = text.replace(/^(\|[^\n]+\|\n\|[\s|:-]+\|\n(?:\|[^\n]+\|\n?)+)/gm, (block) => {
        const lines = block.trim().split(/\n/);
        const headParts = (lines[0] ?? "").split("|").slice(1, -1);
        const head = headParts.map((c) => c.trim());
        const rows = lines.slice(2).map((l) => l
            .split("|")
            .slice(1, -1)
            .map((c) => c.trim()));
        let html = "<table><thead><tr>";
        for (const h of head)
            html += `<th>${h}</th>`;
        html += "</tr></thead><tbody>";
        for (const r of rows) {
            html += "<tr>";
            for (const c of r)
                html += `<td>${c}</td>`;
            html += "</tr>";
        }
        return `${html}</tbody></table>`;
    });
    // Unordered lists (- item / * item). Consecutive lines collapse into
    // one <ul>.
    text = text.replace(/(?:^[-*] .*(?:\n|$))+/gm, (m) => {
        const items = m
            .trim()
            .split(/\n/)
            .map((l) => l.replace(/^[-*] /, "").trim());
        return `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
    });
    // Ordered lists (1. item).
    text = text.replace(/(?:^\d+\. .*(?:\n|$))+/gm, (m) => {
        const items = m
            .trim()
            .split(/\n/)
            .map((l) => l.replace(/^\d+\. /, "").trim());
        return `<ol>${items.map((i) => `<li>${i}</li>`).join("")}</ol>`;
    });
    // Inline: bold, italic, code.
    text = text
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
        .replace(/`([^`\n]+)`/g, "<code>$1</code>");
    // Links [text](url) — prompt-injection-hardened.
    //   1. Any whitespace/control char in URL → render as plain text.
    //   2. Relative/anchor/mailto/tel schemes pass through as-is.
    //   3. Absolute http(s) round-trips through new URL() so the
    //      browser's own parser normalises; unparseable → dropped.
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => {
        const raw = String(u).trim();
        // Constructed from a string so the control-char range doesn't
        // live in the regex literal (keeps Biome happy while still
        // fail-closing on whitespace + control chars that could smuggle
        // attributes into the emitted <a href="...">).
        if (UNSAFE_URL_CHARS_RE.test(raw))
            return t;
        const relOrAnchor = /^(?:#|\/|\.\.?\/|mailto:|tel:)/i.test(raw);
        let safe = null;
        if (relOrAnchor) {
            safe = raw;
        }
        else if (/^https?:/i.test(raw)) {
            try {
                safe = new URL(raw).href;
            }
            catch {
                safe = null;
            }
        }
        if (!safe)
            return t;
        const url = safe.replace(/"/g, "&quot;");
        return `<a href="${url}" target="_blank" rel="noopener noreferrer">${t}</a>`;
    });
    // Paragraphs: double newline = paragraph boundary, single = <br>.
    // Already-block content (h2..h6 / ul / ol / pre / table) passes
    // through unwrapped.
    const parts = text.split(/\n{2,}/).map((p) => {
        const trimmed = p.trim();
        if (!trimmed)
            return "";
        if (/^<(h[2-6]|ul|ol|pre|table)/i.test(trimmed))
            return trimmed;
        return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
    });
    text = parts.join("");
    // Restore code blocks.
    text = text.replace(CODEBLOCK_SENTINEL_RE, (_, i) => codeBlocks[Number(i)] ?? "");
    // Final defense-in-depth pass. Should be a no-op for well-formed
    // output of the renderer above, but catches anything our regex
    // pipeline failed to neutralise (e.g. an unescaped attribute payload
    // smuggled through a future syntax addition). Cost: ~0.1 ms per
    // chat bubble — invisible to humans.
    ensureLinkHook();
    return DOMPurify.sanitize(text, PURIFY_CONFIG);
}
