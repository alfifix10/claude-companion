/**
 * cap-text — bound a tool result's size so a huge payload can't blow up the
 * model's context (and token bill). Truncates with a clear marker that says
 * how much was dropped and how to get the full data instead.
 *
 * Used for tool outputs that are otherwise unbounded — chiefly run_javascript,
 * which JSON.stringifies whatever the page script returns (a scrape can dump
 * megabytes). get_page_text / run_command already cap themselves.
 */
export function capText(text, max = 20000, hint = "") {
    const s = String(text ?? "");
    if (s.length <= max)
        return s;
    const dropped = s.length - max;
    const tail = `\n…[truncated ${dropped} of ${s.length} chars.${hint ? " " + hint : ""}]`;
    return s.slice(0, max) + tail;
}
