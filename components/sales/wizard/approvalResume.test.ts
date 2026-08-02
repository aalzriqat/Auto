import { describe, expect, it } from "vitest";
import {
  buildInitialDraftFromApproval,
  RESTORABLE_SNAPSHOT_FIELDS,
  type ApprovalWizardSnapshot,
} from "./approvalResume";

/**
 * A snapshot with every field set to a value distinguishable from the defaults
 * `Step1QuoteSetup` would otherwise apply (`|| 0` and `?? true`). If a field is
 * dropped on resume, the assertion fails rather than coincidentally matching
 * the default it was reset to — which is what made the original bug invisible.
 */
const FULL_SNAPSHOT: Required<ApprovalWizardSnapshot> = {
  paymentType: "INSTALLMENT",
  vehiclePrice: 25_000,
  desiredProfit: 100,
  downPayment: 5_000,
  termMonths: 60,
  selectedCompanyId: "company-1",
  manualProfitRate: 7.5,
  manualInsuranceRate: 2.25,
  manualExecutionCommission: 300,
  manualExecutionFees: 150,
  manualIncludesCommissionInDebt: false,
};

describe("buildInitialDraftFromApproval", () => {
  it("restores the headline deal figures", () => {
    const draft = buildInitialDraftFromApproval("vehicle-1", FULL_SNAPSHOT);

    expect(draft.vehicleId).toBe("vehicle-1");
    expect(draft.vehiclePrice).toBe(25_000);
    expect(draft.desiredProfit).toBe(100);
    expect(draft.downPayment).toBe(5_000);
    expect(draft.termMonths).toBe(60);
    expect(draft.selectedCompanyId).toBe("company-1");
  });

  it("restores every manual finance override", () => {
    const draft = buildInitialDraftFromApproval("vehicle-1", FULL_SNAPSHOT);

    expect(draft.manualProfitRate).toBe(7.5);
    expect(draft.manualInsuranceRate).toBe(2.25);
    expect(draft.manualExecutionCommission).toBe(300);
    expect(draft.manualExecutionFees).toBe(150);
    expect(draft.manualIncludesCommissionInDebt).toBe(false);
  });

  it("restores `manualIncludesCommissionInDebt: false` rather than letting it default to true", () => {
    // Step 1 seeds this with `?? true`, so a dropped `false` silently flips the
    // deal to including commission in the debt — changing the approved profit.
    const draft = buildInitialDraftFromApproval("vehicle-1", {
      ...FULL_SNAPSHOT,
      manualIncludesCommissionInDebt: false,
    });

    expect(draft.manualIncludesCommissionInDebt).toBe(false);
    expect(draft.manualIncludesCommissionInDebt).not.toBe(true);
  });

  it("restores a zero override rather than dropping it", () => {
    // `0` is meaningful — "no execution commission on this deal" — and is not
    // the same as leaving the field out for Step 1's `|| 0` to fill in, because
    // the value the manager approved must survive the round trip verbatim.
    const draft = buildInitialDraftFromApproval("vehicle-1", {
      ...FULL_SNAPSHOT,
      manualExecutionCommission: 0,
    });

    expect(draft.manualExecutionCommission).toBe(0);
  });

  it("carries every restorable snapshot field, so a new field cannot be silently dropped", () => {
    const draft = buildInitialDraftFromApproval("vehicle-1", FULL_SNAPSHOT);

    for (const field of RESTORABLE_SNAPSHOT_FIELDS) {
      expect(
        draft,
        `snapshot field "${field}" is not restored on resume`,
      ).toHaveProperty(field, FULL_SNAPSHOT[field]);
    }
  });

  it("does not seed paymentType into the wizard data", () => {
    // It selects which wizard opens; it is not a field inside one.
    const draft = buildInitialDraftFromApproval("vehicle-1", FULL_SNAPSHOT);

    expect(draft).not.toHaveProperty("paymentType");
  });

  it("leaves fields undefined when the snapshot never carried them", () => {
    const draft = buildInitialDraftFromApproval("vehicle-1", {
      vehiclePrice: 10_000,
      desiredProfit: 500,
    });

    expect(draft.vehiclePrice).toBe(10_000);
    expect(draft.manualProfitRate).toBeUndefined();
    expect(draft.manualIncludesCommissionInDebt).toBeUndefined();
  });
});
