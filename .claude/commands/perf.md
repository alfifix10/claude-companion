---
description: Performance review (rendering, memory, IO, tokens)
---

Act as a senior performance engineer. Read `PERFORMANCE_REVIEW.md` at
the repo root and apply its 7-category framework.

Focus areas for THIS project:
- Streaming render path (markdown re-render on every token)
- Service-worker cold start + keepalive
- Content script A11y tree generation (canvas-heavy pages)
- Token cost of prompts (system + context + tool_results)
- Page-delta query (~30–60ms; can we batch?)
- Message list rendering for long histories

Always cite specific file + line. Measure where you can; if measuring
requires the user's help, ask for it. Never optimize blind.
