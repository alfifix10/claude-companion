import { describe, expect, it } from "vitest";
import { isNewerVersion } from "./version-compare.js";

describe("isNewerVersion", () => {
  it("detects a newer patch/minor/major", () => {
    expect(isNewerVersion("1.0.1", "1.0.0")).toBe(true);
    expect(isNewerVersion("1.1.0", "1.0.9")).toBe(true);
    expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true);
  });

  it("tolerates a leading v (GitHub tags)", () => {
    expect(isNewerVersion("v1.0.1", "1.0.0")).toBe(true);
    expect(isNewerVersion("v1.0.0", "1.0.0")).toBe(false);
  });

  it("returns false for equal or older", () => {
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "1.0.1")).toBe(false);
    expect(isNewerVersion("1.9.9", "2.0.0")).toBe(false);
  });

  it("handles uneven lengths and junk safely", () => {
    expect(isNewerVersion("1.2", "1.2.0")).toBe(false);
    expect(isNewerVersion("1.2.1", "1.2")).toBe(true);
    expect(isNewerVersion("", "1.0.0")).toBe(false);
    expect(isNewerVersion("abc", "1.0.0")).toBe(false);
    expect(isNewerVersion(undefined, "1.0.0")).toBe(false);
  });
});
