import { describe, expect, it } from "vitest";
import { getPlaybook } from "./site-playbooks.js";

describe("getPlaybook", () => {
  it("returns a hint block for a known site", () => {
    const out = getPlaybook("https://www.youtube.com/watch?v=abc");
    expect(out).toContain("SITE PLAYBOOK");
    expect(out).toContain("shadow DOM");
  });

  it("matches subdomains via hostname suffix", () => {
    expect(getPlaybook("https://mail.google.com/mail/u/0")).toContain("CROSS-ORIGIN");
    expect(getPlaybook("https://m.youtube.com/")).toContain("SITE PLAYBOOK");
  });

  it("treats x.com and twitter.com as the same playbook", () => {
    expect(getPlaybook("https://x.com/home")).toContain("contenteditable");
    expect(getPlaybook("https://twitter.com/home")).toContain("contenteditable");
  });

  it("returns empty string for an unknown site", () => {
    expect(getPlaybook("https://example.com/")).toBe("");
    expect(getPlaybook("https://some-random-shop.test/cart")).toBe("");
  });

  it("does not false-match a lookalike host", () => {
    // "notyoutube.com" must NOT match "youtube.com"
    expect(getPlaybook("https://notyoutube.com/")).toBe("");
    expect(getPlaybook("https://youtube.com.evil.test/")).toBe("");
  });

  it("handles junk / empty / non-string input safely", () => {
    expect(getPlaybook("")).toBe("");
    expect(getPlaybook(null)).toBe("");
    expect(getPlaybook(undefined)).toBe("");
    expect(getPlaybook("not a url")).toBe("");
  });

  it("falls back to parsing a bare hostname", () => {
    expect(getPlaybook("github.com")).toContain("SITE PLAYBOOK");
  });
});
