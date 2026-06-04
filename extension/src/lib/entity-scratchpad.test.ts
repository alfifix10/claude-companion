import { describe, expect, it } from "vitest";
import { extractEntities, formatScratchpad, buildScratchpad } from "./entity-scratchpad.js";

const u = (content: unknown) => ({ role: "user", content });
const a = (content: unknown) => ({ role: "assistant", content });

describe("extractEntities", () => {
  it("pulls emails, urls, windows + unix paths, and refs from user text", () => {
    const ents = extractEntities([
      u("my email is sam@example.com and the repo is https://github.com/x/y"),
      u("the file is at C:\\Users\\sam\\notes.txt or /home/sam/data.csv"),
      u("see issue #42 and PR 99"),
    ]);
    const byType = (t: string) => ents.filter((e) => e.type === t).map((e) => e.value);
    expect(byType("email")).toContain("sam@example.com");
    expect(byType("url")).toContain("https://github.com/x/y");
    expect(byType("path")).toContain("C:\\Users\\sam\\notes.txt");
    expect(byType("path")).toContain("/home/sam/data.csv");
    expect(byType("ref")).toEqual(expect.arrayContaining(["issue #42", "PR 99"]));
  });

  it("ignores assistant / tool messages (user-sourced only)", () => {
    const ents = extractEntities([
      a("I found evil@attacker.com on the page"),
      a([{ type: "text", text: "https://malware.test/x" }]),
      u("hello"),
    ]);
    expect(ents).toHaveLength(0);
  });

  it("never captures bare numbers (passwords / PINs stay out)", () => {
    const ents = extractEntities([u("my password is 110110110 and pin 4827")]);
    expect(ents).toHaveLength(0);
  });

  it("de-duplicates and keeps the most-recent mention", () => {
    const ents = extractEntities([
      u("email a@x.com"),
      u("email a@x.com again"),
    ]);
    expect(ents.filter((e) => e.type === "email")).toHaveLength(1);
  });

  it("caps to maxEntities, keeping the most recent", () => {
    const msgs = Array.from({ length: 10 }, (_, i) => u(`ref #${i}`));
    const ents = extractEntities(msgs, { maxEntities: 3 });
    expect(ents).toHaveLength(3);
    expect(ents.map((e) => e.value)).toEqual(["#7", "#8", "#9"]); // freshest three
  });

  it("reads entities out of structured (array) user content", () => {
    const ents = extractEntities([u([{ type: "text", text: "ping me at jo@a.io" }, { type: "image" }])]);
    expect(ents.map((e) => e.value)).toContain("jo@a.io");
  });
});

describe("formatScratchpad", () => {
  it("returns empty string when there are no entities", () => {
    expect(formatScratchpad([])).toBe("");
  });

  it("renders a labelled block", () => {
    const out = formatScratchpad([
      { type: "email", value: "sam@x.com" },
      { type: "ref", value: "#42" },
    ]);
    expect(out).toContain("KNOWN ENTITIES");
    expect(out).toContain("• email: sam@x.com");
    expect(out).toContain("• ref: #42");
  });
});

describe("buildScratchpad", () => {
  it("extracts and formats in one call", () => {
    const out = buildScratchpad([u("reach me at sam@x.com")]);
    expect(out).toContain("• email: sam@x.com");
  });
  it("is empty for a chat with no structured entities", () => {
    expect(buildScratchpad([u("just chatting, no details here")])).toBe("");
  });
});
