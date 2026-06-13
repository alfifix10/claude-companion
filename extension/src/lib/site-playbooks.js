/**
 * site-playbooks (4.4) — short, per-site interaction hints injected ONLY when
 * the active tab is on a matching domain. They encode hard-won lessons about
 * the toughest sites (deep shadow DOM, cross-origin iframes, contenteditable
 * editors, infinite scroll) so the agent doesn't re-learn them every time.
 *
 * Hints are deliberately GENERAL (techniques, not brittle CSS selectors) so
 * they stay correct as sites re-skin. Each is short to keep the token cost
 * negligible, and a site with no playbook injects nothing.
 *
 * Pure + unit-tested. (The "auto-capture a playbook after a successful task"
 * half of the roadmap item is intentionally deferred — it needs a reliable
 * success signal and a writable store; these curated built-ins deliver the
 * value without that surface.)
 */
const PLAYBOOKS = [
    {
        match: ["youtube.com"],
        hints: "Video titles/channels live deep in shadow DOM — call read_page (it pierces shadow roots) then `act` by the visible title text. The search box is named \"Search\"; submit with Enter. Results load lazily, so scroll then read_page again if a title isn't listed yet.",
    },
    {
        match: ["mail.google.com"],
        hints: "The account switcher and Google-apps grid are CROSS-ORIGIN iframes — find/act can't see them; take a labelled screenshot and click by coordinates. Email rows open on click; Compose is labelled \"Compose\"/\"إنشاء\". Verify the active account by the page title before any destructive action, and delete to Trash (recoverable), not permanently. BULK CLEANUP — never open-and-delete row by row: type a filter in the search box (e.g. category:promotions, older_than:1y, from:sender, is:unread), press Enter, click the top-left select-all checkbox, then the \"Select all N conversations that match\" link that appears, then ONE Archive/Delete — a few actions for thousands of mails. State the matched count and confirm before a bulk delete.",
    },
    {
        match: ["twitter.com", "x.com"],
        hints: "Infinite-scroll feed with content in shadow DOM — use read_page (viewport-first) and scroll to load more. The compose box is a contenteditable editor, so `act` with action:\"fill\" works (it routes through the editing pipeline). Buttons are aria-labelled (Like, Repost, Reply).",
    },
    {
        match: ["reddit.com"],
        hints: "New Reddit nests posts in shadow DOM and lazy-loads on scroll — read_page then scroll+read again for more. Comment/post boxes are contenteditable: use `act` fill. Prefer old.reddit.com if a flow keeps failing — its plain DOM is far easier.",
    },
    {
        match: ["github.com"],
        hints: "Many toggles (star, watch, merge) are React buttons that ignore synthetic clicks — `act`/click already falls back to a real DOM click, so trust it and re-read rather than re-clicking. Code search and the command palette (press \"/\") are faster than hunting the tree.",
    },
    {
        match: ["docs.google.com", "notion.so"],
        hints: "The editing surface is a rich editor (Google Docs paints to a canvas; Notion is contenteditable blocks). For Notion, `act` fill works on a focused block. For Google Docs the document body has no addressable DOM text — use the menus/toolbar by their labels, and type into the focused canvas via type_text.",
    },
    {
        match: ["linkedin.com", "facebook.com"],
        hints: "Heavy shadow DOM + lazy loading + frequent modal overlays. read_page (viewport-first) after each scroll; dismiss \"see more\"/cookie/login modals first (look for a close \"×\" or \"Not now\"). Post composers are contenteditable — `act` fill.",
    },
];
function hostnameOf(url) {
    const s = String(url ?? "");
    try {
        return new URL(s).hostname.toLowerCase();
    }
    catch {
        // Bare hostname or junk — strip scheme/path heuristically.
        const m = s.toLowerCase().match(/^[a-z]+:\/\/([^/?#]+)/);
        if (m?.[1])
            return m[1];
        return s.toLowerCase().split(/[/?#]/)[0] ?? "";
    }
}
function matchesHost(host, suffix) {
    return host === suffix || host.endsWith("." + suffix);
}
/**
 * Return the playbook hints block for `url`, or "" when no playbook matches.
 */
export function getPlaybook(url) {
    const host = hostnameOf(url);
    if (!host)
        return "";
    const pb = PLAYBOOKS.find((p) => p.match.some((suffix) => matchesHost(host, suffix)));
    if (!pb)
        return "";
    return `[SITE PLAYBOOK — tips for ${host}:\n${pb.hints}]`;
}
