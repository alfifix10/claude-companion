# Contributing

Thanks for looking. Short version: changes are welcome, but please read this page first — especially the **Adversarial Review** rule.

---

## Before you write code — Adversarial Review

For anything that isn't a one-line typo fix, apply the checklist in [`ADVERSARIAL_REVIEW.md`](./ADVERSARIAL_REVIEW.md) **before** opening a PR. You do not have to produce a 10-page document; you do have to be able to answer:

1. What are three realistic ways this could fail for a real user? (UX, concurrency, external dependency)
2. How does the patch handle each of those?

Most of the subtle bugs in this project came from skipping that step. A few moments of paranoia up front saves a week of chasing a ghost across three browsers.

Trivial changes that **skip** the review: colour/text/margin tweaks, typos, comment edits, single-line changes that can't affect behaviour. Everything else should show evidence of it in the PR description.

---

## Local setup

```bash
git clone https://github.com/<you>/claude-companion.git
cd claude-companion/host
npm install
cd ..
# Windows
.\install.ps1
# macOS / Linux
./install.sh
```

Load `extension/` from `chrome://extensions` with Developer Mode on.

---

## Project conventions

- **ES modules throughout.** No CommonJS inside `extension/src/`. Service worker is `type: "module"`.
- **No inline `<script>` tags.** Content Security Policy rejects them. External files only.
- **Prompts flow via stdin**, never CLI args. Windows shell quoting is a trap.
- **Absolute paths everywhere** in the native host — the launcher's `PATH` is stripped.
- **Comments explain `why`, not `what`.** If a line needs a comment to describe itself, rewrite the line.
- **No emojis in code.** The `README` and docs can have them; source files should not.
- **No new dependencies without a reason in the PR description.** Every `npm install` is a liability.

---

## Testing

There isn't a traditional test suite — the hot paths live inside Chrome APIs and the Claude CLI, neither of which is pleasant to mock. Instead:

- CI runs `node --check` on every `.js` file and validates `manifest.json`. Keep it green.
- Before asking for review, reload the extension and try at least one real prompt end-to-end.
- If your change touches cancellation, timeouts, tab locking, or the native-host bridge, **test reconnect scenarios**: close the browser mid-stream, kill the native host, pull a cable.

---

## Security-sensitive changes

If a PR touches any of these, please flag it as such in the description:

- `host/native-host.js` tool allowlist or process spawning
- TCP handshake in `host/mcp-server.js`
- Markdown or HTML rendering in `extension/panel.js`
- Native-messaging payload parsing
- Anything that changes what the extension stores or sends

Security review blocks merge for changes in those areas, even if CI is green.

---

## Commits and PRs

- Keep commits focused. A PR full of "fix typo" commits is fine; a single commit that does eight unrelated things is not.
- PR titles should read like release-note headlines: "Fix click ripple flicker on dark pages", not "stuff".
- Include screenshots/GIFs for UI changes.
- Reference the adversarial review outcome: what did you consider, what did you rule out, why.

---

## Code of conduct

Be direct, be kind, assume good faith. No rule-lawyering. If a review comment feels harsh, push back — this project was built under a self-imposed adversarial review rule, which sometimes makes reviewers sound more sceptical than they mean to.
