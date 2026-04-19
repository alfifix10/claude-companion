# src/lib — TypeScript-first modules

New, typed, testable modules land here during the Strangler migration.

Each file should be:
- **Pure-ish**: as stateless as possible
- **Tested**: has a `.test.ts` sibling
- **Leaf**: depends on other lib/ modules only — never on `panel.js`,
  DOM globals (unless explicitly), or the in-browser `chrome.*` APIs
  (those go in `src/core/` or `src/messaging/`)

Current inhabitants:

| Module | Migrated from | Tests |
|---|---|---|
| `humanize-error.ts` | inline `humanizeError()` in `panel.js` | 37 cases |
| `tool-taxonomy.ts` | inline `MUTATING_TOOLS` set in `max.js` | 27 cases |
| `loop-detector.ts` | inline `recentCalls` loop check in `max.js` | 19 cases |
| `file-upload-denylist.ts` | inline `SENSITIVE_PATTERNS` in `executor.js` | 35 cases |

## Adding a new lib module

1. Write `name.ts` + `name.test.ts` in this folder.
2. `npm run test` to see it green.
3. `npm run typecheck` — must pass with `strict: true`.
4. Import from the legacy JS that used to host this code; delete the
   old inline copy.
