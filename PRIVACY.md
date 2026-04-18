# Privacy

**Last updated: 2026-04-18**

Claude Companion is designed to be **local-first and telemetry-free.** This document describes exactly what data exists, where it lives, and who — if anyone — sees it.

If anything below turns out to be inaccurate, that's a bug. Please open an issue.

---

## TL;DR

| What | Where | Leaves your machine? |
|------|-------|----------------------|
| Your chat messages | `chrome.storage.local` | **Yes** — to Anthropic, via the `claude` CLI, same as using Claude Code directly |
| Page content Claude reads | Not stored | **Yes** — same path as above, only when you invoke a tool that reads a page |
| Memories & recurring tasks | `chrome.storage.local` + `~/.config/claude-companion/user-data.json` | No — local files only |
| Screenshots taken by Claude | In-memory ring buffer (≤10, most recent) | **Yes** — sent to Claude as image blocks when a tool call includes a screenshot |
| Extension settings | `chrome.storage.local` | No |
| TCP shared secret | `~/.config/claude-companion/config.json` | No — used only inside your machine |
| Telemetry / analytics | **none** | — |
| Crash reports | **none** | — |

---

## Data flow

When you send a message in the side panel:

```
  You type "summarize this page"
       │
       ▼
  Side panel → Service Worker → Native Host (Node.js, local)
       │
       ▼
  Native Host spawns: claude -p --output-format stream-json
       │
       ▼
  claude CLI (authenticated to your Max account) ──► Anthropic API
       │                                              (same endpoint
       ▼                                               Claude Code uses)
  Response streamed back the same way.
```

Your prompts, the tab URL/title passed as context, and any page content Claude reads to satisfy the request all flow to Anthropic **through the same authenticated channel that `claude login` already uses.** The extension does not add any new destination.

We never pass your prompt through a third-party server, never proxy, never log.

---

## What is stored locally

### `chrome.storage.local` (inside the extension)
- `memories` — the free-form text you enter in Settings (e.g. "my name is X").
- `tasks` — recurring task chips you've defined in Settings.
- `chatHistory` — the last ~50 messages in the side panel.

This storage is wiped when you uninstall the extension.

### `~/.config/claude-companion/` (in your home directory)
- `config.json` — contains the TCP port and a random 32-byte hex secret that the native host and MCP server use to authenticate each other on `127.0.0.1`. Never sent anywhere.
- `user-data.json` — an automatic mirror of `memories` and `tasks` so those survive extension uninstall. Contains only those two fields + a version marker + a save timestamp.

### In-memory only (never persisted)
- Console messages and network requests per tab, capped at 1,000 entries each.
- Screenshot ring buffer (≤10 most recent).
- Open JavaScript dialog state per tab.

---

## Permissions requested

The extension requests these Manifest V3 permissions. Each is used only as described:

| Permission | Why it's needed |
|------------|-----------------|
| `debugger` | Drives the Chrome DevTools Protocol for click, type, scroll, screenshot, read-DOM. Chromium shows a persistent "is being debugged" banner on affected tabs — that's by design. |
| `tabs`, `activeTab`, `windows` | Identify the current tab, list tabs, switch/create tabs when the user asks. |
| `scripting`, `<all_urls>` host permissions | Inject the content script that extracts article text (Readability-style), maintains the accessibility tree, and shows the automation border. |
| `sidePanel` | Renders the chat UI in the side panel. |
| `storage` | Save memories/tasks/history locally. |
| `nativeMessaging` | Talk to the local Node.js host that in turn runs `claude`. |
| `alarms` | A 20-second heartbeat to keep the service worker alive during long Max queries. |
| `tabGroups` | Group the automation tab with a visual marker (optional). |

There are no `clipboardRead`, `cookies`, `history`, `browsingData`, `geolocation`, `notifications`, `bookmarks`, or `downloads` permissions. The extension cannot read any of those.

---

## Third parties

- **Anthropic (indirect, via `claude` CLI).** The CLI's normal traffic, same as running it from a terminal. The extension sends the CLI a prompt plus optional image data; the CLI handles authentication and transport.
- **No one else.** No Google Analytics, no Sentry, no bundlers that call home, no fonts fetched over the network.

---

## What you can do

- **Export your data:** Settings → ⬇ Export downloads a JSON with your memories and tasks.
- **Delete everything:** Remove the extension, then delete `~/.config/claude-companion/`. Nothing about you remains.
- **Inspect the traffic:** The extension's only network outputs are the native-messaging pipe (4-byte length-prefixed JSON over stdio) and the in-browser CDP calls your own browser initiates. Nothing else.

---

## Changes

Any change to how data is handled will bump the "Last updated" date at the top and appear in the release notes. If a future version ever wants to send telemetry, it will require an explicit opt-in; we will not flip a silent default.

---

## Contact

Security issues or privacy concerns → open a private report on GitHub.
