import { describe, expect, test } from "vitest";
import {
  DISBURSEMENT_DENOMINATION_REASON,
  FINALIZE_DENOMINATION_REASON,
  settlementDenominationRefusal,
} from "./settlementDenomination";

describe("settlementDenominationRefusal — SN3-1 containment gate", () => {
  test("a pin equal to the org currency is settleable", () => {
    expect(settlementDenominationRefusal("JOD", "JOD")).toBeUndefined();
    expect(settlementDenominationRefusal("USD", "USD")).toBeUndefined();
  });

  test("an ABSENT pin is settleable: the figure was built in the org currency by construction", () => {
    expect(settlementDenominationRefusal(undefined, "JOD")).toBeUndefined();
  });

  test("a supported pin that differs from the org currency is a MISMATCH", () => {
    expect(settlementDenominationRefusal("JOD", "USD")).toBe("MISMATCH");
    expect(settlementDenominationRefusal("USD", "JOD")).toBe("MISMATCH");
  });

  test("a present but unrecognised pin is UNSUPPORTED, never treated as the org currency", () => {
    // "JD" is what a JOD row looks like after a typo; "" survives `??`.
    expect(settlementDenominationRefusal("JD", "JOD")).toBe("UNSUPPORTED");
    expect(settlementDenominationRefusal("jod", "JOD")).toBe("UNSUPPORTED");
    expect(settlementDenominationRefusal("", "JOD")).toBe("UNSUPPORTED");
  });

  test("every refusal has a reason key on both surfaces", () => {
    for (const refusal of ["MISMATCH", "UNSUPPORTED"] as const) {
      expect(DISBURSEMENT_DENOMINATION_REASON[refusal]).toMatch(/^Disbursement/);
      expect(FINALIZE_DENOMINATION_REASON[refusal]).toMatch(/^Finalize/);
    }
  });
});
