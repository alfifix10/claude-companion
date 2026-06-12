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
 *   • The separator is OPTIONAL: a block without one is a task whose
 *     prompt is the whole text and whose chip name derives from it
 *     (truncated). The card UI removed the placeholder that used to
 *     TEACH the "name: prompt" format, so silently dropping separator-
 *     less tasks became a trap — the user adds a card and no chip
 *     appears. Mandatory format → optional nicety.
 *   • A separator with an empty side (":prompt" / "name:") is still
 *     dropped — degenerate, not expressible as a sensible chip.
 */

export interface Task {
  name: string;
  prompt: string;
}

/**
 * Chip label for a separator-less task: the text itself, cut on a word
 * boundary past 24 chars so the chip row stays compact.
 */
function deriveChipName(text: string): string {
  const t = text.trim();
  if (t.length <= 24) return t;
  const cut = t.slice(0, 24);
  const sp = cut.lastIndexOf(" ");
  return (sp > 12 ? cut.slice(0, sp) : cut) + "…";
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
    if (idx === -1) {
      // No separator: the whole block IS the prompt; the chip name is a
      // truncated preview of it.
      const prompt = lines.join("\n").trim();
      if (prompt) out.push({ name: deriveChipName(first), prompt });
      continue;
    }
    if (idx === 0) continue; // ":prompt" — empty name, not a usable chip

    const name = first.slice(0, idx).trim();
    const inlineRest = first.slice(idx + 1).trim();
    const restLines = lines.slice(1);
    const prompt = [inlineRest, ...restLines].filter(Boolean).join("\n").trim();
    if (name && prompt) out.push({ name, prompt });
  }

  return out;
}
