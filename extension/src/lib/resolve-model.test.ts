import { describe, expect, it } from "vitest";
import { resolveModel, DEFAULT_MODEL_SPEED, MODEL_BY_SPEED } from "./resolve-model.js";

describe("resolveModel", () => {
  it("maps each speed to its model alias", () => {
    expect(resolveModel("fast")).toBe("haiku");
    expect(resolveModel("balanced")).toBe("sonnet");
    expect(resolveModel("powerful")).toBe("opus");
  });

  it("falls back to the powerful default for unset/unknown values", () => {
    expect(resolveModel(undefined)).toBe(MODEL_BY_SPEED[DEFAULT_MODEL_SPEED]);
    expect(resolveModel(null)).toBe("opus");
    expect(resolveModel("")).toBe("opus");
    expect(resolveModel("turbo")).toBe("opus");
    expect(resolveModel(42)).toBe("opus");
  });

  it("the default never silently degrades intelligence (powerful/opus)", () => {
    expect(DEFAULT_MODEL_SPEED).toBe("powerful");
    expect(MODEL_BY_SPEED[DEFAULT_MODEL_SPEED]).toBe("opus");
  });

  it("only ever emits allowlist-safe bare aliases", () => {
    for (const v of ["fast", "balanced", "powerful", "x", undefined]) {
      expect(resolveModel(v)).toMatch(/^[a-z]+$/);
    }
  });
});
