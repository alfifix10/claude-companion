import { describe, expect, it } from "vitest";
import { parseTasks } from "./parse-tasks.js";

describe("parseTasks — fallback input", () => {
  it("null → []", () => {
    expect(parseTasks(null)).toEqual([]);
  });
  it("undefined → []", () => {
    expect(parseTasks(undefined)).toEqual([]);
  });
  it("empty string → []", () => {
    expect(parseTasks("")).toEqual([]);
  });
  it("only whitespace → []", () => {
    expect(parseTasks("   \n\n   \n")).toEqual([]);
  });
});

describe("parseTasks — single-line form", () => {
  it("basic task with colon", () => {
    expect(parseTasks("daily: summarize my inbox")).toEqual([
      { name: "daily", prompt: "summarize my inbox" },
    ]);
  });

  it("Arabic name + Arabic prompt", () => {
    expect(parseTasks("صباح: افتح جيميل ولخّص")).toEqual([
      { name: "صباح", prompt: "افتح جيميل ولخّص" },
    ]);
  });

  it("legacy `=` separator still works", () => {
    expect(parseTasks("old = legacy prompt")).toEqual([{ name: "old", prompt: "legacy prompt" }]);
  });

  it("both `:` and `=` in first line — earlier one wins (:)", () => {
    expect(parseTasks("name: the prompt = extra")).toEqual([
      { name: "name", prompt: "the prompt = extra" },
    ]);
  });

  it("both `:` and `=` in first line — earlier one wins (=)", () => {
    expect(parseTasks("name=prompt: extra")).toEqual([{ name: "name", prompt: "prompt: extra" }]);
  });
});

describe("parseTasks — multi-line form", () => {
  it("task with prompt on following lines", () => {
    const raw = "daily:\nopen Gmail\nsummarize top 5";
    expect(parseTasks(raw)).toEqual([{ name: "daily", prompt: "open Gmail\nsummarize top 5" }]);
  });

  it("multi-line joins preserving newlines", () => {
    const raw = "review:\nstep 1\nstep 2\nstep 3";
    expect(parseTasks(raw)).toEqual([{ name: "review", prompt: "step 1\nstep 2\nstep 3" }]);
  });

  it("inline-rest + following lines merge correctly", () => {
    const raw = "long: first bit\ncontinued here\nand here";
    expect(parseTasks(raw)).toEqual([
      { name: "long", prompt: "first bit\ncontinued here\nand here" },
    ]);
  });
});

describe("parseTasks — multiple tasks", () => {
  it("two tasks separated by blank line", () => {
    const raw = "a: first\n\nb: second";
    expect(parseTasks(raw)).toEqual([
      { name: "a", prompt: "first" },
      { name: "b", prompt: "second" },
    ]);
  });

  it("three tasks, mixed forms", () => {
    const raw = "one: quick\n\ntwo:\nmulti\nline\n\nthree = legacy";
    expect(parseTasks(raw)).toEqual([
      { name: "one", prompt: "quick" },
      { name: "two", prompt: "multi\nline" },
      { name: "three", prompt: "legacy" },
    ]);
  });

  it("tolerates multiple blank lines between tasks", () => {
    const raw = "a: first\n\n\n\nb: second";
    expect(parseTasks(raw)).toEqual([
      { name: "a", prompt: "first" },
      { name: "b", prompt: "second" },
    ]);
  });

  it("handles \\r\\n (Windows line endings)", () => {
    const raw = "a: first\r\n\r\nb: second";
    expect(parseTasks(raw)).toEqual([
      { name: "a", prompt: "first" },
      { name: "b", prompt: "second" },
    ]);
  });
});

describe("parseTasks — comments", () => {
  it("lines starting with # are ignored", () => {
    const raw = "# top note\ndaily: do thing";
    expect(parseTasks(raw)).toEqual([{ name: "daily", prompt: "do thing" }]);
  });

  it("# inside a multi-line task body is dropped", () => {
    const raw = "review:\n# internal note\nstep one";
    expect(parseTasks(raw)).toEqual([{ name: "review", prompt: "step one" }]);
  });

  it("block that is only comments produces no task", () => {
    const raw = "# a\n# b\n\ndaily: do thing";
    expect(parseTasks(raw)).toEqual([{ name: "daily", prompt: "do thing" }]);
  });
});

describe("parseTasks — separator-less tasks (card-UI rule: format optional)", () => {
  it("no separator → the text IS the task, chip name = the text", () => {
    expect(parseTasks("افتح البريد")).toEqual([
      { name: "افتح البريد", prompt: "افتح البريد" },
    ]);
  });

  it("long separator-less text → chip name truncated on a word boundary", () => {
    const raw = "افتح موقع الأخبار ولخص لي أهم خمسة عناوين اليوم";
    const [t] = parseTasks(raw);
    expect(t?.prompt).toBe(raw);
    expect(t?.name.endsWith("…")).toBe(true);
    expect(t?.name.length).toBeLessThanOrEqual(25);
  });

  it("multi-line separator-less block → first line names it, all lines prompt", () => {
    expect(parseTasks("open the mail\nthen summarize")).toEqual([
      { name: "open the mail", prompt: "open the mail\nthen summarize" },
    ]);
  });

  it("mixed named + separator-less blocks — both kept", () => {
    const raw = "good: ok\n\nbare task line\n\nalso: ok";
    expect(parseTasks(raw)).toEqual([
      { name: "good", prompt: "ok" },
      { name: "bare task line", prompt: "bare task line" },
      { name: "also", prompt: "ok" },
    ]);
  });
});

describe("parseTasks — degenerate separators still drop", () => {
  it("separator at column 0 (empty name) → dropped", () => {
    expect(parseTasks(":prompt-with-no-name")).toEqual([]);
  });

  it("separator but no prompt → dropped", () => {
    expect(parseTasks("name:")).toEqual([]);
    expect(parseTasks("name:   ")).toEqual([]);
  });
});

describe("parseTasks — whitespace trimming", () => {
  it("trims surrounding whitespace on name and prompt", () => {
    expect(parseTasks("  name  :   prompt   ")).toEqual([{ name: "name", prompt: "prompt" }]);
  });
});
