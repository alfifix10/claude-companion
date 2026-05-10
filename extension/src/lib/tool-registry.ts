/**
 * tool-registry — canonical metadata for every MCP tool the extension
 * ships.
 *
 * ONE place declares:
 *   • the tool name (as Claude sees it)
 *   • whether it mutates browser state (loop-detector + action-budget)
 *   • a category (for future UI grouping, docs, perms)
 *   • a short description (human reference — mcp-server.js is still
 *     the source of truth for what Claude actually reads; these are
 *     here for module documentation and future use)
 *
 * Before the registry: three separate files each knew the tool list:
 *   • host/mcp-server.js     — schemas + descriptions
 *   • native-tool-handlers.js — pass() dispatch
 *   • tool-taxonomy.ts        — mutating flag
 * The last two were manually kept in sync and had drifted (tabs_close
 * and file_upload fell through the cracks when they were added). Now
 * this file is the source; the others derive from it.
 *
 * When you add a new MCP tool:
 *   1. Register it below.
 *   2. Implement its case in extension/src/tools/executor.js.
 *   3. Declare it in host/mcp-server.js with a Zod schema (unlocked by
 *      a future Phase that shares types across processes).
 *
 * Steps 2 and 3 will fuse with step 1 when the executor migration
 * lands in a later Phase.
 */

export type ToolCategory =
  | "tabs" // list_tabs, switch_tab, tabs_create, tabs_close, ...
  | "navigation" // navigate
  | "reading" // read_page, get_page_text, screenshot, find
  | "interaction" // click, type_text, drag, hover, ...
  | "scripting" // run_javascript
  | "waiting" // wait_for
  | "upload" // file_upload
  | "devtools"; // read_console_messages, read_network_requests, ...

export interface ToolMetadata {
  /** Tool name as Claude sees it (matches mcp-server.js registration). */
  readonly name: string;
  /** True when identical-input repetition is a loop, not progress. */
  readonly mutating: boolean;
  /**
   * Per-tool override of the loop-detector threshold. When set, the
   * detector uses this number instead of the mutating-vs-readonly
   * default. Use cases:
   *   • `run_javascript`: same script with same args is LEGITIMATELY
   *     repeated during scrape workflows (collect tweets after each
   *     scroll). Default mutating=3 fires too eagerly.
   *   • Could be 0 / -1 in future to fully disable loop detection
   *     for a tool — not used yet.
   */
  readonly loopThreshold?: number;
  /** Coarse grouping for future UI / perms / docs. */
  readonly category: ToolCategory;
  /** One-line summary — documentation only, not consumed at runtime. */
  readonly description: string;
}

/**
 * The canonical tool list. Key = tool name. Alphabetical.
 *
 * Keep in sync with host/mcp-server.js — the mcp-server is still the
 * schema authority today. Drift here means Claude could try to call a
 * tool we don't handle locally (or vice versa).
 */
export const TOOL_REGISTRY: Record<string, ToolMetadata> = {
  click: {
    name: "click",
    mutating: true,
    category: "interaction",
    description: "Click an element by ref or (x, y). Supports modifiers + middle/right buttons.",
  },
  drag: {
    name: "drag",
    mutating: true,
    category: "interaction",
    description: "Drag from a source to a destination (ref or coordinate).",
  },
  file_upload: {
    name: "file_upload",
    mutating: true,
    category: "upload",
    description: 'Upload local file(s) to an <input type="file"> element.',
  },
  find: {
    name: "find",
    mutating: false,
    category: "reading",
    description: "Find elements by text or CSS selector.",
  },
  form_input: {
    name: "form_input",
    mutating: true,
    category: "interaction",
    description: "Set the value of a form field by ref.",
  },
  get_page_text: {
    name: "get_page_text",
    mutating: false,
    category: "reading",
    description: "Extract the main article/body text (Readability-style).",
  },
  hover: {
    name: "hover",
    mutating: true,
    category: "interaction",
    description: "Hover over an element.",
  },
  list_tabs: {
    name: "list_tabs",
    mutating: false,
    category: "tabs",
    description: "List all tabs in the focused window (IDs + titles + URLs).",
  },
  navigate: {
    name: "navigate",
    mutating: true,
    category: "navigation",
    description: "Navigate the current tab to a URL, go back, or go forward.",
  },
  press_key: {
    name: "press_key",
    mutating: true,
    category: "interaction",
    description: "Press a keyboard key/shortcut (Enter, Tab, Ctrl+A, ...).",
  },
  read_page: {
    name: "read_page",
    mutating: false,
    category: "reading",
    description: "Get the accessibility tree with interactive element refs.",
  },
  run_javascript: {
    name: "run_javascript",
    mutating: true,
    // Pro-Mode workflows (scraping, pagination, polling) call the same
    // script repeatedly by design — the page state changes between
    // calls even though the script source doesn't. The default 3-repeat
    // threshold for mutating tools fired prematurely on the legitimate
    // "scroll → collect → scroll → collect" pattern. Bump to 12 so we
    // still catch genuine infinite loops without crippling scrapers.
    loopThreshold: 12,
    category: "scripting",
    description:
      "Execute JavaScript in the page context. DISABLED in default mode; unlocked when Pro Mode is on.",
  },
  screenshot: {
    name: "screenshot",
    mutating: false,
    category: "reading",
    description: "Capture a JPEG of the viewport. Optional Set-of-Mark labels.",
  },
  scroll: {
    name: "scroll",
    mutating: false,
    category: "reading",
    description: "Scroll the page up or down.",
  },
  select_option: {
    name: "select_option",
    mutating: true,
    category: "interaction",
    description: "Pick an option in a dropdown by ref.",
  },
  switch_tab: {
    name: "switch_tab",
    mutating: true,
    category: "tabs",
    description: "Switch to a tab by ID.",
  },
  tabs_close: {
    name: "tabs_close",
    mutating: true,
    category: "tabs",
    description: "Close one or more tabs by ID. Refuses to close the active task's tab mid-run.",
  },
  tabs_context: {
    name: "tabs_context",
    mutating: false,
    category: "tabs",
    description: "Current active tab info (url, title, tab id, window id).",
  },
  tabs_create: {
    name: "tabs_create",
    mutating: true,
    category: "tabs",
    description: "Open a new tab with optional URL.",
  },
  tabs_overview: {
    name: "tabs_overview",
    mutating: false,
    category: "tabs",
    description: "List all tabs plus a short content snippet from each.",
  },
  type_text: {
    name: "type_text",
    mutating: true,
    category: "interaction",
    description: "Type text at the current keyboard focus.",
  },
  wait_for: {
    name: "wait_for",
    mutating: false,
    category: "waiting",
    description: "Wait for text / selector / DOM stability (max 10 s).",
  },

  // ───── DevTools — read-only browser internals ─────
  // All non-mutating: they read state the browser already collected
  // (console messages, network log, exception trace) or call read-only
  // APIs (window.localStorage, performance.timing). The repeat-call
  // detector treats them as "reads" so a debugging task that polls
  // console output every few seconds isn't flagged as a loop.
  read_console_messages: {
    name: "read_console_messages",
    mutating: false,
    category: "devtools",
    description: "Read console.log / warn / error / info messages collected from the active tab.",
  },
  read_network_requests: {
    name: "read_network_requests",
    mutating: false,
    category: "devtools",
    description: "Read HTTP requests captured for the active tab — URL, method, status, type.",
  },
  read_page_errors: {
    name: "read_page_errors",
    mutating: false,
    category: "devtools",
    description: "Read uncaught JavaScript exceptions thrown on the active tab.",
  },
  inspect_element: {
    name: "inspect_element",
    mutating: false,
    category: "devtools",
    description: "Get tag name, attributes, computed style, and bounding rect for one element.",
  },
  read_storage: {
    name: "read_storage",
    mutating: false,
    category: "devtools",
    description: "Read localStorage or sessionStorage entries for the active tab. Pro Mode required (auth tokens often live there).",
  },
  read_performance: {
    name: "read_performance",
    mutating: false,
    category: "devtools",
    description: "Read the active tab's performance timing — navigation, paint, memory.",
  },
  clear_injected_scripts: {
    name: "clear_injected_scripts",
    // Mutating: it removes window properties + clears intervals/
    // timeouts. Loop detector should treat it as an action so a
    // misbehaving agent that calls it repeatedly gets caught.
    mutating: true,
    category: "devtools",
    description: "Recovery tool. Strip auto-loop scripts the agent injected into a tab (window.__autoX, intervals, timeouts).",
  },
};

/** Alphabetically-sorted list of every tool name. */
export function getAllToolNames(): string[] {
  return Object.keys(TOOL_REGISTRY).sort();
}

/** All mutating tools, as a read-only Set — matches the old MUTATING_TOOLS shape. */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set(
  Object.values(TOOL_REGISTRY)
    .filter((t) => t.mutating)
    .map((t) => t.name),
);

/** True when the tool changes state — mirrors MUTATING_TOOLS.has(name). */
export function isMutating(name: string): boolean {
  return TOOL_REGISTRY[name]?.mutating === true;
}

/**
 * Per-tool loop threshold override, or undefined when no override is
 * configured. The loop detector falls back to its mutating/readonly
 * default in the undefined case.
 */
export function getLoopThreshold(name: string): number | undefined {
  return TOOL_REGISTRY[name]?.loopThreshold;
}

/** All tools matching a category. */
export function toolsByCategory(category: ToolCategory): ToolMetadata[] {
  return Object.values(TOOL_REGISTRY).filter((t) => t.category === category);
}
