/**
 * action-trace — renders a compact, one-line summary of the tools an
 * assistant turn ran, so the model REMEMBERS what it already did across turns.
 *
 * Why: the panel stores each assistant turn as final text only; the tools it
 * called are shown in the UI but never sent back to the model next turn. So on
 * turn N the agent can't see that on turn N-2 it already read the page, found
 * 10 links, or clicked "Sign in" — it re-does work and loses findings. This
 * appends e.g.  [did: read_page · click "Sign in" · find "عقار"]  to the
 * assistant message that goes into the conversation history.
 *
 * Token-frugal: caps at `max` actions, clips each arg to 30 chars, and never
 * echoes big payloads (a run_javascript body is shown as just the tool name).
 */

export interface ToolAction {
  tool: string;
  input?: Record<string, unknown>;
}

export function actionTrace(toolActions: ToolAction[] | undefined, max = 8): string {
  if (!Array.isArray(toolActions) || toolActions.length === 0) return "";
  const fmt = (a: ToolAction): string => {
    const t = String(a?.tool || "").trim();
    if (!t) return "";
    const inp = a.input || {};
    // Most identifying SHORT arg; deliberately skip script/code bodies.
    const arg = inp.text ?? inp.query ?? inp.url ?? inp.value ?? inp.ref ?? "";
    const s = typeof arg === "string" ? arg.trim() : "";
    return s ? `${t} "${s.slice(0, 30)}"` : t;
  };
  const labels = toolActions.map(fmt).filter(Boolean);
  if (labels.length === 0) return "";
  const shown = labels.slice(0, max);
  const more = labels.length > max ? ` +${labels.length - max}` : "";
  return `\n[did: ${shown.join(" · ")}${more}]`;
}
