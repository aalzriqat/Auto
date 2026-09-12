import { describe, expect, test } from "vitest";
import {
  DISBURSEMENT_DENOMINATION_REASON,
  FINALIZE_DENOMINATION_REASON,
  disbursementDenominationRefusal,
  finalizeDenominationRefusal,
} from "./settlementDenomination";

describe("finalizeDenominationRefusal — mirrors finalizeDeal's pre-sale currency rule", () => {
  test("a pin equal to the org currency closes", () => {
    expect(finalizeDenominationRefusal("JOD", "JOD")).toBeUndefined();
    expect(finalizeDenominationRefusal("USD", "USD")).toBeUndefined();
  });

  test("an ABSENT pin closes: the figure was built in the org currency by construction", () => {
    expect(finalizeDenominationRefusal(undefined, "JOD")).toBeUndefined();
  });

  test("a supported pin that differs from the org's CURRENT currency is a MISMATCH", () => {
    expect(finalizeDenominationRefusal("JOD", "USD")).toBe("MISMATCH");
    expect(finalizeDenominationRefusal("USD", "JOD")).toBe("MISMATCH");
  });

  test("a present but unrecognised pin is UNSUPPORTED, never treated as the org currency", () => {
    // "JD" is what a JOD row looks like after a typo; "" survives `??`.
    expect(finalizeDenominationRefusal("JD", "JOD")).toBe("UNSUPPORTED");
    expect(finalizeDenominationRefusal("jod", "JOD")).toBe("UNSUPPORTED");
    expect(finalizeDenominationRefusal("", "JOD")).toBe("UNSUPPORTED");
  });
});

describe("disbursementDenominationRefusal — the receipt settles in the receivable's own denomination", () => {
  test("a supported pin is settleable whatever the org's current currency is (SCRUM-241)", () => {
    expect(disbursementDenominationRefusal("JOD")).toBeUndefined();
    expect(disbursementDenominationRefusal("USD")).toBeUndefined();
  });

  test("an ABSENT pin is settleable", () => {
    expect(disbursementDenominationRefusal(undefined)).toBeUndefined();
  });

  test("an unrecognised pin is the one refusal that survives on the receipt", () => {
    expect(disbursementDenominationRefusal("JD")).toBe("UNSUPPORTED");
    expect(disbursementDenominationRefusal("")).toBe("UNSUPPORTED");
  });
});

describe("reason keys", () => {
  test("every refusal has a reason key on its surface, and the retired MISMATCH receipt reason is gone", () => {
    for (const refusal of ["MISMATCH", "UNSUPPORTED"] as const) {
      expect(FINALIZE_DENOMINATION_REASON[refusal]).toMatch(/^Finalize/);
    }
    expect(DISBURSEMENT_DENOMINATION_REASON.UNSUPPORTED).toBe("DisbursementCurrencyUnsupported");
    expect(Object.keys(DISBURSEMENT_DENOMINATION_REASON)).toEqual(["UNSUPPORTED"]);
  });
});
