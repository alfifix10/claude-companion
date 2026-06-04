import { describe, expect, it } from "vitest";
import { shouldAutoResume, MAX_AUTO_RESUMES } from "./auto-resume.js";

describe("shouldAutoResume", () => {
  it("resumes a resumable result while under the bound", () => {
    expect(shouldAutoResume({ resumable: true }, 0)).toBe(true);
    expect(shouldAutoResume({ resumable: true }, MAX_AUTO_RESUMES - 1)).toBe(true);
  });

  it("STOPS once the bound is reached (no infinite resume)", () => {
    expect(shouldAutoResume({ resumable: true }, MAX_AUTO_RESUMES)).toBe(false);
    expect(shouldAutoResume({ resumable: true }, MAX_AUTO_RESUMES + 1)).toBe(false);
  });

  it("never resumes a non-resumable stop (loop / error / timeout)", () => {
    expect(shouldAutoResume({ resumable: false }, 0)).toBe(false);
    expect(shouldAutoResume({}, 0)).toBe(false);
    expect(shouldAutoResume({ resumable: true as unknown as boolean, text: "x" } as never, 0)).toBe(true);
  });

  it("is safe on null / undefined results", () => {
    expect(shouldAutoResume(null, 0)).toBe(false);
    expect(shouldAutoResume(undefined, 0)).toBe(false);
  });

  it("honours a custom bound", () => {
    expect(shouldAutoResume({ resumable: true }, 4, 5)).toBe(true);
    expect(shouldAutoResume({ resumable: true }, 5, 5)).toBe(false);
  });
});
