import { describe, expect, test } from "vitest";
import { DEPOSIT_OTHER_TREATMENT_PILOT_DISABLED } from "./utils/depositOtherContainment";
import { MANUAL_JOURNALS_PILOT_DISABLED } from "./utils/pilotSwitches";

/**
 * SCRUM-801: the deposit treatment OTHER leaves the customer-deposit liability "awaiting a manual
 * journal". While manual journals are off for the pilot there is nobody to post that journal, so
 * OTHER may only be re-enabled once manual journals are. One-way tie: manual journals off implies
 * OTHER off. The reverse is allowed (OTHER stays off after manual journals return).
 */
describe("SCRUM-801: OTHER stays refused while manual journals are off", () => {
  test("MANUAL_JOURNALS_PILOT_DISABLED implies DEPOSIT_OTHER_TREATMENT_PILOT_DISABLED", () => {
    if (MANUAL_JOURNALS_PILOT_DISABLED) {
      expect(DEPOSIT_OTHER_TREATMENT_PILOT_DISABLED).toBe(true);
    }
  });

  test("both switches are on in the pilot build", () => {
    expect(MANUAL_JOURNALS_PILOT_DISABLED).toBe(true);
    expect(DEPOSIT_OTHER_TREATMENT_PILOT_DISABLED).toBe(true);
  });
});
