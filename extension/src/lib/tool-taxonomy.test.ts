import { describe, expect, it } from "vitest";
import { MUTATING_TOOLS, isMutating } from "./tool-taxonomy";

describe("MUTATING_TOOLS", () => {
  it("is a Set", () => {
    expect(MUTATING_TOOLS).toBeInstanceOf(Set);
  });

  it("covers the 13 mutating tools we ship today", () => {
    expect(MUTATING_TOOLS.size).toBe(13);
  });

  it("every entry is a non-empty string", () => {
    for (const name of MUTATING_TOOLS) {
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    }
  });
});

describe("isMutating", () => {
  // The canonical mutating set — if any of these flip to read-only,
  // the loop detector will stop catching dead-ref loops on them.
  it.each([
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
  ])("recognises %s as mutating", (name) => {
    expect(isMutating(name)).toBe(true);
  });

  // Known read-only tools must NOT fire loop detection at the mutating
  // threshold, so they have to be not-in the set.
  it.each([
    "read_page",
    "get_page_text",
    "screenshot",
    "scroll",
    "wait_for",
    "find",
    "list_tabs",
    "tabs_context",
    "tabs_overview",
  ])("recognises %s as read-only", (name) => {
    expect(isMutating(name)).toBe(false);
  });

  it("unknown tool name → read-only (safe default)", () => {
    expect(isMutating("nonexistent_tool_xyz")).toBe(false);
  });

  it("empty string → false", () => {
    expect(isMutating("")).toBe(false);
  });
});
