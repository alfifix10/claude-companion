/**
 * tool-taxonomy — the single source of truth for "does this MCP tool
 * change state?".
 *
 * Used by both the agent's action-budget counter and its loop detector.
 * Keeping a ONE definition means those two systems can never drift out
 * of sync — an earlier iteration had duplicate lists that disagreed,
 * and tabs_close / file_upload fell through the cracks.
 *
 * Convention: a tool is "mutating" if invoking it with identical input
 * more than once represents a loop (click a ref, navigate, submit a
 * form). A tool is "read-only" if identical repetition is legitimate
 * progress (scroll, screenshot, wait_for).
 */

/** Every MCP tool currently shipped by the extension, by class. */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "click",
  "type_text",
  "press_key",
  "form_input",
  "drag",
  "navigate",
  "tabs_create",
  "switch_tab",
  "select_option",
  "hover",
  "run_javascript",
  "tabs_close",
  "file_upload",
]);

export function isMutating(toolName: string): boolean {
  return MUTATING_TOOLS.has(toolName);
}
