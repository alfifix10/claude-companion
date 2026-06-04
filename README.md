# Claude Companion

**A Chromium browser extension that turns your Claude Max subscription into a full browser copilot — no API keys, no per-token billing, no vendor backend.**

> 🌍 [العربية](./README.ar.md) · **English**

---

## What it does

- Chat with Claude in a side panel of any Chromium browser (Chrome, Brave, Edge, Opera, Vivaldi, Arc).
- Claude can **read, click, type, navigate, and screenshot** the page on your behalf — 60 MCP tools, all routed through your Max subscription.
- **Zero API spend.** Every call goes through the `claude` CLI locally, which uses your Max plan.
- Ships with Arabic and English voice input (Web Speech API), plus one-tap quick-action chips (screenshot, read elements, extract text) that run locally without calling the model.

---

## Architecture

```
┌───────────────────┐         ┌──────────────────┐        ┌─────────────────┐
│  Side Panel (UI)  │◄───────►│ Service Worker   │◄──────►│ Native Host     │
│  panel.html/js    │         │ background.js    │  stdio │ (Node.js)       │
└───────────────────┘         └──────────────────┘        └────────┬────────┘
                                                                    │ TCP
                                                                    ▼
                                                           ┌─────────────────┐
                                                           │   MCP Server    │
                                                           │  (60 tools)     │
                                                           └────────┬────────┘
                                                                    │ stdio
                                                                    ▼
                                                           ┌─────────────────┐
                                                           │   claude CLI    │
                                                           │  (Max sub)      │
                                                           └─────────────────┘
```

**No third-party servers are involved.** Traffic flows: your browser → local Node host → local `claude` CLI → Anthropic (same endpoint your CLI already uses). The extension never phones home.

---

## Requirements

- **Claude Max subscription** ($100/mo or $200/mo plan) — required; there is no API-key fallback by design.
- **Node.js 18+**
- **Chromium-based browser** — Chrome, Brave, Edge, Opera, Vivaldi, Arc.
- Supported OS: Windows, macOS, Linux.

---

## Install

### Windows

```powershell
# 1. Install Claude Code CLI
npm install -g @anthropic-ai/claude-code
claude login

# 2. Clone or unzip this repo, then:
cd claude-companion\host
npm install
cd ..
.\install.ps1

# 3. Load the extension
#    Open chrome://extensions → enable "Developer mode"
#    → "Load unpacked" → select the `extension/` folder.
```

### macOS / Linux

```bash
npm install -g @anthropic-ai/claude-code
claude login

cd claude-companion/host
npm install
cd ..
./install.sh
```

The installer registers the native messaging host across every Chromium-based browser it finds, wires up the MCP server in Claude Code, and never touches anything outside `~/.config/claude-companion/` or the per-browser `NativeMessagingHosts` registry key.

---

## Usage

Click the toolbar icon to open the side panel, then try:

- `Summarize this page`
- `Open youtube and search for "lo-fi beats"`
- `Click "Sign in"` — Claude finds and clicks it (or use `act` under the hood, one call)
- `Read the article and translate to Arabic`
- `Fill this form with my details` — requires memories set in Settings

Most Arabic verbs work too: `افتح يوتيوب`, `اضغط على تسجيل الدخول`, `لخّص المقال`.

---

## Privacy

Short version: **all data stays local except the Claude API calls that `claude login` already makes.** See [PRIVACY.md](./PRIVACY.md) for the full breakdown (what's stored, what's sent, what permissions are used, and why).

Key points:
- No analytics, no telemetry, no phone-home.
- Extension settings mirror to `~/.config/claude-companion/user-data.json` so they survive uninstall.
- The TCP bridge between the native host and MCP server is protected by a locally-generated shared secret — nothing on your machine can impersonate the browser.

---

## Security model

Public-release hardening applied:

- The agent runs the CLI with `--dangerously-skip-permissions` — it runs headless, so there is no human to answer a permission prompt. Authorization is therefore enforced by a **denylist**: `Bash`, `Write`, `Edit`, `NotebookEdit` are passed to `--disallowedTools`, and `run_javascript` is added to that denylist unless **Pro Mode** is enabled.
- Be aware this is a denylist, not an allowlist: it **fails open** for any *new* built-in a future CLI version might add. Moving to an explicit allowlist is tracked in `ROADMAP.md` (Phase 1). Treat the working directory you point Pro Mode at as fully trusted.
- The image-Q&A path runs with `--tools ""` (no tools at all).
- Pro Mode tools (filesystem / shell / sqlite) are sandboxed to the configured working directory and gated behind an explicit user toggle.
- **Confirmation gate:** every machine-modifying Pro Mode action (`write_file`, `edit_file`, `delete_file`, `run_command`) requires explicit in-panel approval before it runs. It's fail-safe — no panel open, a timeout, or any non-approval denies the action — so the interpreters on the shell allowlist can't silently run code. The decision logic is unit-tested in `host/security.js`.
- JavaScript dialogs auto-dismiss `confirm()` and `prompt()` (cancel). `alert()` and `beforeunload` are accepted.
- Markdown links rendered in the UI are limited to safe URL schemes (`https`, `http`, `mailto`, `tel`, relative). `javascript:` and `data:` are stripped.
- Native messaging and TCP bridge enforce a 16 MB payload cap to block length-prefix DoS.

If you find a security issue, please open a private report rather than a public issue.

---

## Project layout

```
claude-companion/
├── host/
│   ├── native-host.js          # stdio ↔ TCP ↔ spawn claude
│   ├── mcp-server.js           # MCP server, 60 browser tools
│   └── package.json
├── extension/
│   ├── manifest.json           # Manifest V3
│   ├── background.js           # Service worker + keepalive + routing
│   ├── content.js              # Readability + A11y tree + DOM diff
│   ├── panel.html/css/js       # Side panel UI
│   ├── settings.html/js        # Memories + tasks + Export/Import
│   └── src/
│       ├── core/               # state, cdp, tabs, utils, user-data
│       ├── messaging/          # native, panel
│       ├── tools/              # executor, local shortcuts, native handlers
│       └── agent/              # max (Claude Code adapter)
├── install.ps1 / install.sh    # Cross-platform installers
├── README.md / README.ar.md    # English / Arabic docs
├── MIGRATE.md                  # Moving to a new machine
├── PRIVACY.md                  # Data flow + permissions
├── LICENSE                     # MIT
└── CLAUDE.md                   # Project memory (for Claude Code)
```

---

## Contributing

Before any non-trivial change, please run the adversarial review checklist in `ADVERSARIAL_REVIEW.md`. It's the house style: consider three failure modes (UX + concurrency + external dep) and write them down before writing code.

Pull requests welcome. CI runs syntax checks on every `.js` and validates `manifest.json`.

---

## License

MIT — see [LICENSE](./LICENSE).

Not affiliated with Anthropic. "Claude" is a trademark of Anthropic, PBC, used here only to describe interoperability.
