import { describe, expect, it } from "vitest";
import { actionTrace } from "./action-trace.js";

describe("actionTrace", () => {
  it("returns empty for no actions", () => {
    expect(actionTrace([])).toBe("");
    expect(actionTrace(undefined)).toBe("");
  });

  it("summarises tools with their identifying arg", () => {
    const out = actionTrace([
      { tool: "read_page", input: {} },
      { tool: "click", input: { ref: "ref_5" } },
      { tool: "act", input: { text: "تسجيل الدخول" } },
    ]);
    expect(out).toBe('\n[did: read_page · click "ref_5" · act "تسجيل الدخول"]');
  });

  it("prefers text > query > url > value > ref", () => {
    expect(actionTrace([{ tool: "navigate", input: { url: "https://x.com" } }]))
      .toBe('\n[did: navigate "https://x.com"]');
    expect(actionTrace([{ tool: "find", input: { query: "عقار" } }]))
      .toBe('\n[did: find "عقار"]');
  });

  it("clips long args to 30 chars", () => {
    const out = actionTrace([{ tool: "type_text", input: { text: "x".repeat(100) } }]);
    expect(out).toContain('type_text "' + "x".repeat(30) + '"');
    expect(out).not.toContain("x".repeat(31));
  });

  it("never echoes a run_javascript body (no short arg → name only)", () => {
    const out = actionTrace([{ tool: "run_javascript", input: { code: "for(;;){}".repeat(50) } }]);
    expect(out).toBe("\n[did: run_javascript]");
  });

  it("caps the list and notes the remainder", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ tool: `scroll${i}`, input: {} }));
    const out = actionTrace(many, 8);
    expect(out).toContain("+4");
    expect((out.match(/scroll/g) || []).length).toBe(8);
  });

  it("drops malformed entries", () => {
    const out = actionTrace([{ tool: "", input: {} }, { tool: "click", input: { ref: "r1" } }]);
    expect(out).toBe('\n[did: click "r1"]');
  });
});
