import { describe, expect, it } from "vitest";
import { add } from "./smoke";

describe("smoke", () => {
  it("add() works — proves vitest picks up src/**/*.test.ts", () => {
    expect(add(2, 3)).toBe(5);
  });

  it("add() handles negatives", () => {
    expect(add(-1, 1)).toBe(0);
  });
});
