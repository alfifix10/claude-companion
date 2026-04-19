/**
 * parse-tasks — parser for the user-defined repeated-task format.
 *
 * Users type a plain-text block in Settings → Repeated Tasks. Each
 * task has a short name and a prompt; tasks are separated by blank
 * lines. Two shapes are accepted:
 *
 *   (a) single-line:   name: the full prompt on one line
 *   (b) multi-line:    name:
 *                      the full prompt
 *                      across multiple lines
 *
 * Rules:
 *   • Blank line (or more) separates tasks.
 *   • Lines starting with `#` are comments (ignored inside blocks too).
 *   • Either `:` or legacy `=` is accepted as the name/prompt separator.
 *   • When both appear on the first line, the earlier one wins.
 *   • A task missing either name or prompt is silently dropped.
 */

export interface Task {
  name: string;
  prompt: string;
}

export function parseTasks(raw: string | null | undefined): Task[] {
  const out: Task[] = [];
  if (!raw) return out;

  // Blank line boundary — at least two consecutive line separators
  // with only whitespace between them.
  const blocks = raw.split(/\r?\n\s*\r?\n/);

  for (const block of blocks) {
    const lines = block
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    if (!lines.length) continue;

    const first = lines[0];
    if (!first) continue;

    // Detect separator: colon or legacy `=`. Whichever comes first wins.
    let idx = first.indexOf(":");
    const eqIdx = first.indexOf("=");
    if (idx === -1 || (eqIdx !== -1 && eqIdx < idx)) {
      idx = eqIdx;
    }
    if (idx <= 0) continue;

    const name = first.slice(0, idx).trim();
    const inlineRest = first.slice(idx + 1).trim();
    const restLines = lines.slice(1);
    const prompt = [inlineRest, ...restLines].filter(Boolean).join("\n").trim();
    if (name && prompt) out.push({ name, prompt });
  }

  return out;
}
