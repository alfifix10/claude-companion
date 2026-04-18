---
description: Frontend engineering review (CSS/HTML quality, perf, a11y, compat)
---

Act as a senior frontend engineer. Read `FRONTEND_REVIEW.md` at the
repo root and apply its 10-category framework.

Focus areas for THIS project:
- panel.css architecture (specificity, z-index system, keyframe
  duplication, !important usage)
- Animation performance (transform/opacity only? reduced-motion
  respected?)
- Focus management (`:focus-visible`, tab order, overlay focus traps)
- ARIA correctness on custom controls (mic button, chips, overlays)
- aria-live on the transient notice / toasts
- Responsive behaviour across side-panel widths (280 px to 500 px)
- Content-visibility on long message lists
- Semantic HTML in panel.html (button vs div-onclick)

Always cite file + line. Propose design tokens where literal values
are scattered. Distinguish issues from the Visual Designer lens —
this review is about how the frontend is BUILT, not how it LOOKS.
