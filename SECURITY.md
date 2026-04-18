# Security Policy

## Supported versions

This project follows a rolling-main model. Only the latest commit on `main` is supported. If you are running an older build, please update before reporting.

| Version | Supported |
|---------|-----------|
| `main` (latest) | ✅ |
| Anything older | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private reporting feature:

1. Go to the repository's **Security** tab
2. Click **Report a vulnerability**
3. Describe the issue, with reproduction steps if possible

If that isn't available, email the maintainer directly (address on the GitHub profile).

Expect an initial response within 72 hours. A disclosure timeline will be agreed with the reporter — typically public disclosure 14–30 days after a fix ships, unless the issue is being actively exploited.

## Scope

In scope:

- **Code execution** from a crafted prompt, page content, or MCP response.
- **Local privilege escalation** via the native host or installer scripts.
- **Bypass of the tool allowlist** in `host/native-host.js` (e.g. getting `Bash`, `Write`, or any non-MCP tool to run).
- **TCP bridge authentication bypass** — impersonating the browser to the MCP server, or impersonating the MCP server to the browser, without knowing the shared secret.
- **Exfiltration** of memories, tasks, chat history, or the shared secret through a page, a malicious MCP, or an extension-to-extension vector.
- **XSS / HTML injection** in the side panel rendering path (Markdown, tool output, notifications).
- **Payload-size DoS** that crashes the service worker or native host beyond the 16 MB guards.

Out of scope:

- Attacks that require the user to voluntarily paste their private key (`.extension-private-key.pem`) into a third party.
- Issues in upstream dependencies (Node.js, `@modelcontextprotocol/sdk`, Chromium) — please report those upstream. We are happy to coordinate.
- Missing security headers on hypothetical third-party services; this project runs entirely on `localhost`.
- Phishing landing pages impersonating the extension.

## Hardening already in place

The project ships with defense-in-depth measures documented here so that you don't have to re-derive them when auditing:

- **TCP shared secret.** The native host and MCP server each generate or load a 32-byte hex secret from `~/.config/claude-companion/config.json` at startup. Every connection over the localhost TCP bridge must present the secret in its first line; mismatches are dropped silently. Comparison uses `crypto.timingSafeEqual`.
- **Hard-coded tool allowlist.** `host/native-host.js` forces `--allowedTools mcp__claude-companion__* Read Grep Glob WebFetch WebSearch` on every `claude` spawn and ignores any caller-supplied list. `Bash`, `Write`, `Edit`, `NotebookEdit` are on an explicit disallowlist. The `--dangerously-skip-permissions` flag is **not** used.
- **Payload size caps.** Both the native messaging stream and the TCP bridge reject any frame larger than 16 MB. TCP clients that buffer more than 64 KB of unframed bytes before sending their hello are dropped.
- **URL scheme filter for Markdown links.** Only `https:`, `http:`, `mailto:`, `tel:`, fragment-only, and relative links render as anchors; `javascript:` and `data:` links are stripped to plain text.
- **Dialog policy.** `confirm()` and `prompt()` auto-dismiss. `alert()` and `beforeunload` auto-accept. The side panel tells Claude the disposition so it does not assume the underlying action ran.
- **Stable extension ID.** `manifest.json` embeds the RSA public key so the ID is deterministic across machines, preventing accidental impersonation by a differently-named unpacked load.
- **Origin-locked native messaging.** The manifest's `allowed_origins` field restricts which extension may connect to the native host.
- **Handler race guards.** Response handlers check for presence before invoking, and stale session entries in the `hostsBySession` map only delete when the entry still points at the closing socket.

If you find a gap in any of the above — or a category we missed — that's exactly the kind of report we want.

## Key management

The `.extension-private-key.pem` file is listed in `.gitignore` and checked by CI. Anyone who obtains this file can publish an impostor extension with the same stable ID. Treat it the way you would treat an SSH private key:

- Do not commit it.
- Do not upload it to cloud sync that is not end-to-end encrypted.
- If it leaks, rotate: generate a new key, update `manifest.json`, and re-install in every browser.

The shared TCP secret (`~/.config/claude-companion/config.json`) is less sensitive — it only grants access to the local loopback bridge — but the same hygiene applies.

## Credit

Valid security reports will be credited in the release notes unless the reporter prefers otherwise.
