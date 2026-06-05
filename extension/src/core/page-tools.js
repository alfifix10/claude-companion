/**
 * page-tools — which MCP tools actually act on the VISIBLE web page.
 *
 * The orange automation border means "your page is being driven". It must
 * appear only while a page/tab tool runs — never for a purely local task
 * (search the filesystem, run a shell command, query a DB). Both the sticky
 * border (src/agent/max.js) and the per-call pulse (src/tools/executor.js)
 * consult this list, so the rule lives in ONE place.
 *
 * NON_PAGE_TOOLS = the Pro-Mode local tools that touch the user's COMPUTER,
 * not the page. Everything NOT in this set is treated as a page tool (fails
 * safe: an unknown/new tool still shows the border).
 *
 * ⚠ When you add a new LOCAL (Pro) tool, add its name here too — otherwise
 * the page border will wrongly appear while it runs.
 */
export const NON_PAGE_TOOLS = new Set([
  // filesystem
  "read_file", "write_file", "edit_file", "delete_file",
  "list_directory", "find_files", "create_directory", "get_working_directory",
  // shell
  "run_command",
  // documents
  "generate_pdf", "save_json", "save_csv",
  // git (structured)
  "git_status", "git_diff", "git_log", "git_blame", "git_branches",
  // code search
  "grep_files", "find_symbol", "find_references", "code_outline",
  // http (host-side fetch, not the page)
  "http_fetch", "http_get_json",
  // code quality
  "lint_file", "format_file", "type_check",
  // sqlite
  "sqlite_query", "sqlite_schema",
  // project memory
  "update_project_state",
]);

/** True when the tool works on the user's computer, not the visible page. */
export function isNonPageTool(name) {
  return NON_PAGE_TOOLS.has(name);
}
