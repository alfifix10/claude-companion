/**
 * derive-title — pick a short display title for a saved conversation.
 *
 * Rules:
 *   • First user message (if any) wins.
 *   • Strip light markdown noise (`*`, `_`, `` ` ``, `#`, `>`).
 *   • Collapse whitespace to single spaces.
 *   • Trim, then cap at 40 chars with an "…" elision marker.
 *   • Fallback labels for empty / image-only conversations.
 *
 * Pure function. Tested against every fallback branch.
 */
const MARKDOWN_NOISE_RE = /[*_`#>]/g;
const WHITESPACE_RE = /\s+/g;
const MAX_TITLE_LENGTH = 40;
export function deriveTitle(messages) {
    if (!messages?.length)
        return "محادثة جديدة";
    const first = messages.find((m) => m.role === "user");
    if (!first)
        return "محادثة جديدة";
    const raw = typeof first.content === "string" ? first.content : "";
    const cleaned = raw.replace(MARKDOWN_NOISE_RE, "").replace(WHITESPACE_RE, " ").trim();
    if (!cleaned)
        return "محادثة بصور";
    return cleaned.length > MAX_TITLE_LENGTH ? `${cleaned.slice(0, MAX_TITLE_LENGTH)}…` : cleaned;
}
