import { describe, expect, it } from "vitest";
import { resolveModel, DEFAULT_MODEL_SPEED, MODEL_BY_SPEED } from "./resolve-model.js";

describe("resolveModel", () => {
  it("maps each speed to its model alias", () => {
    expect(resolveModel("fast")).toBe("haiku");
    expect(resolveModel("balanced")).toBe("sonnet");
    expect(resolveModel("powerful")).toBe("opus");
  });

  it("falls back to the balanced default for unset/unknown values", () => {
    expect(resolveModel(undefined)).toBe(MODEL_BY_SPEED[DEFAULT_MODEL_SPEED]);
    expect(resolveModel(null)).toBe("sonnet");
    expect(resolveModel("")).toBe("sonnet");
    expect(resolveModel("turbo")).toBe("sonnet");
    expect(resolveModel(42)).toBe("sonnet");
  });

  it("defaults to the balanced speed/economy/quality point (sonnet)", () => {
    expect(DEFAULT_MODEL_SPEED).toBe("balanced");
    expect(MODEL_BY_SPEED[DEFAULT_MODEL_SPEED]).toBe("sonnet");
  });

  it("only ever emits allowlist-safe bare aliases", () => {
    for (const v of ["fast", "balanced", "powerful", "x", undefined]) {
      expect(resolveModel(v)).toMatch(/^[a-z]+$/);
    }
  });
});
