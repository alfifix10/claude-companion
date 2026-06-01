/**
 * conversation-history — builds the bounded multi-turn transcript that gets
 * injected into each Claude Max query so the agent stays grounded in the
 * conversation without unbounded token growth.
 *
 * Strategy (survives long sessions):
 *   • Always keep the FIRST `keepFirst` turns — the opening message usually
 *     defines the goal ("اجمع التغريدات…", "اكتب سكربت…"). Losing it means
 *     the agent forgets WHY it's here once the chat runs long.
 *   • Always keep the LAST `keepLast` turns — the immediate working flow.
 *   • RESCUE "pivot" turns from the elided middle — user messages that
 *     redirect the goal ("بدل ذلك…", "actually focus on…"). Positional
 *     elision used to silently drop a mid-conversation course-correction;
 *     now those survive even when buried in the middle.
 *   • Enforce a CHARACTER budget over the whole block. A single huge pasted
 *     message is clipped to `maxPerMessage`; if the block is still over
 *     `maxChars`, the OLDEST tail turns are shed (most-recent kept). This
 *     bounds token cost even when one message is a giant blob — the old
 *     "fixed 14 turns regardless of size" could blow up on a paste.
 *   • Structured (non-string) content is summarised to a short tag
 *     ("[image]", "[used: read_page, click]") instead of the opaque
 *     "(structured content)" the old formatter emitted.
 */
export const DEFAULT_HISTORY_CONFIG = {
    keepFirst: 2,
    keepLast: 12,
    maxChars: 8000,
    maxPerMessage: 1500,
    maxPivots: 3,
};
// Heuristic: does this USER message redirect the task? Bilingual — Arabic
// script alternatives don't use \b (word boundaries don't apply to Arabic).
const PIVOT_RE = /\b(?:actually|instead|scratch that|ignore (?:the )?(?:previous|above)|forget (?:the )?(?:previous|above)|focus on)\b|تجاهل|بدل(?:\s|اً|ًا|ها)|بدّل|بدلًا|عوضًا|بالأحرى|ركّز على|الأهمّ|بدلَ ذلك/i;
export function isPivot(text) {
    return typeof text === "string" && PIVOT_RE.test(text);
}
// Flatten a message's content to a short, human/model-readable string.
function contentToText(content) {
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        const parts = [];
        const tools = [];
        for (const b of content) {
            if (!b || typeof b !== "object")
                continue;
            if (b.type === "text" && b.text)
                parts.push(String(b.text));
            else if (b.type === "image" || b.type === "image_url")
                parts.push("[image]");
            else if (b.type === "tool_use" && b.name)
                tools.push(String(b.name).replace(/^mcp__claude-companion__/, ""));
            else if (b.type === "tool_result")
                parts.push("[tool result]");
        }
        if (tools.length)
            parts.push(`[used: ${[...new Set(tools)].join(", ")}]`);
        return parts.length ? parts.join(" ") : "[structured content]";
    }
    return "[structured content]";
}
function clip(s, max) {
    return s.length <= max ? s : s.slice(0, max) + " …[clipped]";
}
export function buildSmartHistory(messages, config = {}) {
    const cfg = { ...DEFAULT_HISTORY_CONFIG, ...config };
    const fmt = (m) => `${m.role === "user" ? "USER" : "ASSISTANT"}: ${clip(contentToText(m.content), cfg.maxPerMessage)}`;
    const N = messages.length;
    let lines;
    let pinned = 0; // leading lines the budget must never shed
    if (N <= cfg.keepFirst + cfg.keepLast) {
        lines = messages.map(fmt);
        pinned = Math.min(cfg.keepFirst, lines.length);
    }
    else {
        const head = messages.slice(0, cfg.keepFirst);
        const tail = messages.slice(-cfg.keepLast);
        const middle = messages.slice(cfg.keepFirst, N - cfg.keepLast);
        const pivots = middle
            .filter((m) => m.role === "user" && isPivot(m.content))
            .slice(-cfg.maxPivots);
        const skipped = middle.length - pivots.length;
        const headLines = head.map(fmt);
        const pivotLines = pivots.map((m) => `USER: [earlier course-correction] ${clip(contentToText(m.content), cfg.maxPerMessage)}`);
        const markerLines = skipped > 0
            ? [
                `[ELIDED: ${skipped} earlier turn(s) folded for brevity. Read _STATE.md for the back-story if needed. — تمّ طيّ ${skipped} رسالة سابقة.]`,
            ]
            : [];
        lines = [...headLines, ...pivotLines, ...markerLines, ...tail.map(fmt)];
        pinned = headLines.length + pivotLines.length + markerLines.length;
    }
    // Character budget. Per-message clipping happened in fmt; if the whole
    // block is still over budget, shed the OLDEST sheddable turns (those right
    // after the pinned prefix), always keeping the most recent `minKeep`.
    const minKeep = Math.min(4, cfg.keepLast);
    let trimmed = false;
    while (lines.join("\n").length > cfg.maxChars && lines.length - pinned > minKeep) {
        lines.splice(pinned, 1);
        trimmed = true;
    }
    if (trimmed) {
        lines.splice(pinned, 0, "[…older turns trimmed to fit the context budget…]");
    }
    return lines.join("\n");
}
