/**
 * SCRUM-628 F-10: the success screen is the wizard's fourth screen but not a
 * fourth step, and the header said "Step 4 of 3".
 */
import { describe, expect, test } from "vitest";
import { QUOTE_WIZARD_STEP_COUNT, quoteWizardStepCounter } from "./stepCounter";

describe("quoteWizardStepCounter", () => {
  test("counts the three input steps", () => {
    expect(QUOTE_WIZARD_STEP_COUNT).toBe(3);
    for (const step of [1, 2, 3]) {
      expect(quoteWizardStepCounter(step)).toEqual({ kind: "STEP", step, total: 3 });
    }
  });

  test("the success screen is reported as complete, never as a step past the total", () => {
    expect(quoteWizardStepCounter(4)).toEqual({ kind: "COMPLETE" });
  });
});
