import { describe, expect, it } from "vitest";
import { safeInputKey } from "./safe-input-key";

describe("safeInputKey — primitives", () => {
  it("null → empty string", () => {
    expect(safeInputKey(null)).toBe("");
  });
  it("undefined → empty string", () => {
    expect(safeInputKey(undefined)).toBe("");
  });
  it("number → String(n)", () => {
    expect(safeInputKey(42)).toBe("42");
  });
  it("string → the string", () => {
    expect(safeInputKey("hello")).toBe("hello");
  });
  it("boolean → 'true' / 'false'", () => {
    expect(safeInputKey(true)).toBe("true");
    expect(safeInputKey(false)).toBe("false");
  });
});

describe("safeInputKey — objects (determinism)", () => {
  it("same object → same key", () => {
    const o = { a: 1, b: 2 };
    expect(safeInputKey(o)).toBe(safeInputKey(o));
  });

  it("different key insertion orders → same key", () => {
    const a = { ref: "42", x: 5, y: 7 };
    const b = { y: 7, ref: "42", x: 5 };
    expect(safeInputKey(a)).toBe(safeInputKey(b));
  });

  it("same values, different keys → different keys", () => {
    expect(safeInputKey({ a: 1 })).not.toBe(safeInputKey({ b: 1 }));
  });

  it("same keys, different values → different keys", () => {
    expect(safeInputKey({ x: 1 })).not.toBe(safeInputKey({ x: 2 }));
  });
});

describe("safeInputKey — nested / weird / edge cases", () => {
  it("nested object is stringified", () => {
    const key = safeInputKey({ outer: { inner: 42 } });
    expect(key).toContain("inner");
    expect(key).toContain("42");
  });

  it("array is stringified (not treated as object keys)", () => {
    const key = safeInputKey({ list: [1, 2, 3] });
    expect(key).toContain("[1,2,3]");
  });

  it("circular reference does NOT throw", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => safeInputKey(circular)).not.toThrow();
    // Falls back to String(obj) — just needs to return a string
    expect(typeof safeInputKey(circular)).toBe("string");
  });

  it("empty object → {}", () => {
    expect(safeInputKey({})).toBe("{}");
  });
});

describe("safeInputKey — realistic tool-call inputs", () => {
  it("click by ref", () => {
    expect(safeInputKey({ ref: "ref_42" })).toBe('{"ref":"ref_42"}');
  });

  it("click by coordinates, key order independent", () => {
    expect(safeInputKey({ x: 100, y: 200 })).toBe(safeInputKey({ y: 200, x: 100 }));
  });

  it("navigate with URL", () => {
    expect(safeInputKey({ url: "https://example.com" })).toBe('{"url":"https://example.com"}');
  });
});
