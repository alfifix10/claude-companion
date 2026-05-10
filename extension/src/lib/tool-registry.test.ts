import { describe, expect, it } from "vitest";
import {
  MUTATING_TOOLS,
  TOOL_REGISTRY,
  getAllToolNames,
  isMutating,
  toolsByCategory,
} from "./tool-registry.js";

describe("TOOL_REGISTRY — shape invariants", () => {
  it("exposes exactly the 29 tools we ship today (22 browser + 7 devtools)", () => {
    // 22 original (interaction + reading + tabs + nav + scripting + waiting + upload)
    // + 7 DevTools (read_console_messages, read_network_requests, read_page_errors,
    //                inspect_element, read_storage, read_performance, clear_injected_scripts)
    expect(Object.keys(TOOL_REGISTRY)).toHaveLength(29);
  });

  it("every entry's key matches its `name` field", () => {
    for (const [key, meta] of Object.entries(TOOL_REGISTRY)) {
      expect(meta.name).toBe(key);
    }
  });

  it("every entry has a non-empty description", () => {
    for (const meta of Object.values(TOOL_REGISTRY)) {
      expect(meta.description.length).toBeGreaterThan(0);
    }
  });

  it("every entry declares a mutating flag (no undefined)", () => {
    for (const meta of Object.values(TOOL_REGISTRY)) {
      expect(typeof meta.mutating).toBe("boolean");
    }
  });

  it("every entry declares a category", () => {
    for (const meta of Object.values(TOOL_REGISTRY)) {
      expect(meta.category).toBeTruthy();
    }
  });
});

describe("isMutating — mutating tools", () => {
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
});

describe("isMutating — read-only tools", () => {
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
});

describe("isMutating — unknown input", () => {
  it("unknown tool → false (safe default)", () => {
    expect(isMutating("nonexistent_tool_xyz")).toBe(false);
  });

  it("empty string → false", () => {
    expect(isMutating("")).toBe(false);
  });
});

describe("MUTATING_TOOLS derived set", () => {
  it("is a Set", () => {
    expect(MUTATING_TOOLS).toBeInstanceOf(Set);
  });

  it("contains exactly the 14 mutating tools (13 original + clear_injected_scripts)", () => {
    expect(MUTATING_TOOLS.size).toBe(14);
  });

  it("is consistent with per-entry mutating flags", () => {
    for (const meta of Object.values(TOOL_REGISTRY)) {
      expect(MUTATING_TOOLS.has(meta.name)).toBe(meta.mutating);
    }
  });
});

describe("getAllToolNames", () => {
  it("returns 29 names", () => {
    expect(getAllToolNames()).toHaveLength(29);
  });

  it("returns the names sorted alphabetically", () => {
    const names = getAllToolNames();
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  it("returns every registered tool", () => {
    const names = getAllToolNames();
    for (const key of Object.keys(TOOL_REGISTRY)) {
      expect(names).toContain(key);
    }
  });
});

describe("toolsByCategory", () => {
  it("reading → 5 tools (scroll belongs here: read more of the page)", () => {
    const names = toolsByCategory("reading").map((t) => t.name);
    expect(names.sort()).toEqual(["find", "get_page_text", "read_page", "screenshot", "scroll"]);
  });

  it("tabs → 6 tools", () => {
    const tabs = toolsByCategory("tabs");
    expect(tabs).toHaveLength(6);
    for (const t of tabs) {
      expect(t.name).toMatch(
        /^(list_tabs|switch_tab|tabs_create|tabs_close|tabs_context|tabs_overview)$/,
      );
    }
  });

  it("scripting → just run_javascript", () => {
    expect(toolsByCategory("scripting")).toHaveLength(1);
    expect(toolsByCategory("scripting")[0]?.name).toBe("run_javascript");
  });

  it("upload → just file_upload", () => {
    expect(toolsByCategory("upload")).toHaveLength(1);
    expect(toolsByCategory("upload")[0]?.name).toBe("file_upload");
  });

  it("unknown category → empty array", () => {
    // @ts-expect-error — testing runtime safety of a bad category
    expect(toolsByCategory("does_not_exist")).toEqual([]);
  });
});
