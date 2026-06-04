/**
 * entity-scratchpad (C3) — a compact, persistent memory of the concrete
 * entities the USER has mentioned this chat (emails, URLs, file paths, issue
 * refs). Injected each turn so the agent doesn't forget "my email is X" or
 * "the file is at Y" once older turns are folded out of the history window.
 *
 * Design choices that matter:
 *   • USER messages only. Assistant/tool/page text is NOT scanned — a hostile
 *     page could otherwise smuggle a fake "entity" through an assistant echo
 *     and have it re-injected as trusted context.
 *   • STRUCTURED entities only (email/url/path/ref). We never capture bare
 *     numbers, so passwords / PINs / OTPs the user typed don't get pinned into
 *     every subsequent prompt.
 *   • Bounded: most-recently-mentioned wins, capped to `maxEntities`.
 *
 * Pure + fully unit-tested.
 */
export const DEFAULT_SCRATCHPAD_CONFIG = {
    maxEntities: 12,
};
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const URL_RE = /https?:\/\/[^\s)<>"'\]}]+/g;
// Windows absolute path: C:\foo\bar . Stop at quotes / whitespace / pipe.
const WINPATH_RE = /[A-Za-z]:\\[^\s"'<>|*?\n]+/g;
// Unix-ish path with at least two segments and a real-looking leaf.
const UNIXPATH_RE = /(?:^|[\s("'])(\/[\w.-]+\/[\w./-]+)/g;
// Issue/PR/ticket/order refs, or a bare #123.
const REF_RE = /(?:\b(?:PR|issue|ticket|order|bug)\s+#?\d+|#\d+)/gi;
function toText(content) {
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        return content
            .map((b) => (b && b.type === "text" && typeof b.text === "string" ? b.text : ""))
            .join(" ");
    }
    return "";
}
function pushMatches(text, re, type, out) {
    const matches = text.match(re);
    if (!matches)
        return;
    for (const m of matches) {
        const value = type === "path" ? m.trim() : m;
        if (value)
            out.push({ type, value });
    }
}
/**
 * Extract the user's structured entities, most-recently-mentioned first,
 * de-duplicated and capped. Scans USER messages only.
 */
export function extractEntities(messages, config = {}) {
    const cfg = { ...DEFAULT_SCRATCHPAD_CONFIG, ...config };
    // Insertion-ordered map keyed by type+value; re-inserting moves an entity to
    // the end (most-recent), so the last N entries are the freshest mentions.
    const seen = new Map();
    for (const msg of messages) {
        if (!msg || msg.role !== "user")
            continue;
        const text = toText(msg.content);
        if (!text)
            continue;
        const found = [];
        pushMatches(text, EMAIL_RE, "email", found);
        pushMatches(text, URL_RE, "url", found);
        pushMatches(text, WINPATH_RE, "path", found);
        pushMatches(text, UNIXPATH_RE, "path", found);
        pushMatches(text, REF_RE, "ref", found);
        for (const e of found) {
            const key = `${e.type}|${e.value.toLowerCase()}`;
            seen.delete(key); // move to most-recent position
            seen.set(key, e);
        }
    }
    const all = [...seen.values()];
    // Keep the most-recently-mentioned `maxEntities`, then present oldest→newest.
    return all.slice(Math.max(0, all.length - cfg.maxEntities));
}
const TYPE_LABEL = {
    email: "email",
    url: "url",
    path: "path",
    ref: "ref",
};
/** Render the scratchpad block, or "" when there's nothing to show. */
export function formatScratchpad(entities) {
    if (entities.length === 0)
        return "";
    const lines = entities.map((e) => `• ${TYPE_LABEL[e.type]}: ${e.value}`);
    return ("[KNOWN ENTITIES — concrete details the user mentioned this chat; reuse them " +
        "instead of asking again:\n" +
        lines.join("\n") +
        "]");
}
/** Convenience: extract + format in one call. */
export function buildScratchpad(messages, config = {}) {
    return formatScratchpad(extractEntities(messages, config));
}
