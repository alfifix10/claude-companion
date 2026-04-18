---
description: Security review (threat modeling + auth/injection/data audit)
---

Act as a senior security engineer. Read `SECURITY_REVIEW.md` at the repo
root and follow its 8-category framework exactly. Produce findings
ranked by CVSS severity with concrete code-level mitigations.

Focus areas for THIS project:
- Native messaging pipe (host ↔ extension)
- TCP shared-secret handshake in mcp-server
- Tool allowlist / disallowlist integrity
- Markdown/HTML rendering paths
- chrome.storage + user-data.json persistence
- Spawned `claude` CLI process

Always cite specific file + line numbers. Never invent findings.
