/**
 * Mobile sales wizard & QuoteSaveArgs contract tests (S1-R11-H1).
 *
 * Verifies that QuoteSaveArgs and api.quotes.saveQuote support
 * customerEligibilityStatusIds as required by server-side configured
 * finance company quotes.
 */
import { api, type QuoteSaveArgs } from "../../../convexApi";
import {
  effectiveMobileQuoteVehiclePrice,
  manualExecutionFeeInputValue,
  mobileFinancingTermIsValid,
  priceUpliftNeedsApproval,
  priceUpliftOverList,
  profitApprovalGate,
} from "./salesWizardQuote";

describe("Mobile Quote Contract & Wizard (S1-R11-H1)", () => {
  test("QuoteSaveArgs includes customerEligibilityStatusIds", () => {
    const configuredQuotePayload: QuoteSaveArgs = {
      orgId: "org_1",
      customerId: "cust_1",
      vehicleId: "veh_1",
      companyId: "comp_1",
      customerEligibilityStatusIds: ["status_1", "status_2"],
      mode: "CONFIGURED_FINANCE_COMPANY",
      vehiclePrice: 20000,
      downPayment: 5000,
      termMonths: 48,
    };

    expect(configuredQuotePayload.customerEligibilityStatusIds).toEqual(["status_1", "status_2"]);
    expect(configuredQuotePayload.mode).toBe("CONFIGURED_FINANCE_COMPANY");
  });

  test("configured quote call with customerEligibilityStatusIds conforms to api.quotes.saveQuote type", () => {
    // Type-level assertion: ensures the function reference accepts customerEligibilityStatusIds
    type SaveQuoteArgs = typeof api.quotes.saveQuote extends {
      _args: infer Args;
    }
      ? Args
      : QuoteSaveArgs;

    const callArgs: SaveQuoteArgs = {
      orgId: "org_1",
      customerId: "cust_1",
      vehicleId: "veh_1",
      companyId: "comp_1",
      customerEligibilityStatusIds: ["status_1"],
      mode: "CONFIGURED_FINANCE_COMPANY",
      vehiclePrice: 20000,
      downPayment: 0,
      termMonths: 60,
    };

    expect(callArgs.customerEligibilityStatusIds).toEqual(["status_1"]);
  });

  test("cash and manual quotes omit or provide undefined customerEligibilityStatusIds", () => {
    const cashQuote: QuoteSaveArgs = {
      orgId: "org_1",
      customerId: "cust_1",
      vehicleId: "veh_1",
      mode: "CASH",
      vehiclePrice: 15000,
      downPayment: 15000,
      termMonths: 0,
    };
    expect(cashQuote.customerEligibilityStatusIds).toBeUndefined();

    const manualQuote: QuoteSaveArgs = {
      orgId: "org_1",
      customerId: "cust_1",
      vehicleId: "veh_1",
      mode: "MANUAL_FINANCE_COMPANY",
      vehiclePrice: 15000,
      downPayment: 3000,
      termMonths: 36,
      manualProviderName: "Custom Bank",
      manualProfitRate: 5,
      customerEligibilityStatusIds: undefined,
    };
    expect(manualQuote.customerEligibilityStatusIds).toBeUndefined();
  });

  describe("manualExecutionFeeInputValue (S1-R14-M1)", () => {
    test("preserves undefined as unconfigured empty string", () => {
      expect(manualExecutionFeeInputValue(undefined)).toBe("");
    });

    test("preserves explicit zero as '0'", () => {
      expect(manualExecutionFeeInputValue(0)).toBe("0");
    });

    test("formats positive fee number as string", () => {
      expect(manualExecutionFeeInputValue(150)).toBe("150");
      expect(manualExecutionFeeInputValue(25.5)).toBe("25.5");
    });
  });
  describe("mobile quote pricing and financing-term authority", () => {
    test("folds desired dealer profit into the authoritative vehicle price", () => {
      expect(effectiveMobileQuoteVehiclePrice(9_500, 1_000)).toBe(10_500);
      expect(effectiveMobileQuoteVehiclePrice(9_500, 0)).toBe(9_500);
    });

    test("rejects non-integer, over-max, and grace-only financing terms", () => {
      expect(mobileFinancingTermIsValid({ termMonths: 48, maxTermMonths: 60 })).toBe(true);
      expect(mobileFinancingTermIsValid({ termMonths: 61, maxTermMonths: 60 })).toBe(false);
      expect(mobileFinancingTermIsValid({ termMonths: 12.5, maxTermMonths: 60 })).toBe(false);
      expect(mobileFinancingTermIsValid({ termMonths: 3, gracePeriodMonths: 3 })).toBe(false);
      expect(mobileFinancingTermIsValid({ termMonths: 4, gracePeriodMonths: 3 })).toBe(true);
    });
  });

});

describe("SCRUM-260 price uplift is final price minus list price", () => {
  test("an edited base price moves the uplift, so the markup input alone is not the figure", () => {
    // list 20000, base lowered to 19000, markup 1500: final 20500, uplift 500 (not 1500).
    expect(priceUpliftOverList(19000, 1500, 20000)).toBe(500);
  });

  test("a price below list gives a negative uplift", () => {
    expect(priceUpliftOverList(19000, 0, 20000)).toBe(-1000);
  });

  test("approval is needed only when the minimum is above 0 and the uplift is below it", () => {
    expect(priceUpliftNeedsApproval(500, 1000)).toBe(true);
    expect(priceUpliftNeedsApproval(1000, 1000)).toBe(false);
    expect(priceUpliftNeedsApproval(-5, 0)).toBe(false);
    expect(priceUpliftNeedsApproval(-5, 1000)).toBe(true);
    // The shared gate uses the same rule as the helper.
    expect(profitApprovalGate({ isCash: false, hasVehicle: true, minimum: 1000, uplift: 500, approval: null }).needsApproval).toBe(
      priceUpliftNeedsApproval(500, 1000)
    );
  });
});

describe("SCRUM-260 mobile approval gate follows the server's exact-terms rule", () => {
  const base = { isCash: false, hasVehicle: true, minimum: 1000 };
  const approved = (requestedProfit: number, minimumProfit = 1000) => ({ status: "APPROVED" as const, requestedProfit, minimumProfit });

  test("an approval for exactly the current uplift and minimum unblocks", () => {
    const gate = profitApprovalGate({ ...base, uplift: 200, approval: approved(200) });
    expect(gate).toMatchObject({ needsApproval: true, approvalValid: true, blocked: false });
  });

  test("stale approval: +200 was approved, the price moved to +500, so it is blocked again", () => {
    const gate = profitApprovalGate({ ...base, uplift: 500, approval: approved(200) });
    expect(gate).toMatchObject({ needsApproval: true, approvalValid: false, blocked: true });
  });

  test("an approval does not carry over to a higher price that now clears the minimum either way", () => {
    expect(profitApprovalGate({ ...base, uplift: 1500, approval: approved(200) })).toMatchObject({ needsApproval: false, blocked: false });
  });

  test("an approval recorded against a different minimum is stale", () => {
    const gate = profitApprovalGate({ ...base, uplift: 200, approval: approved(200, 800) });
    expect(gate).toMatchObject({ approvalValid: false, blocked: true });
  });

  test("fails closed: an approval that names no minimum never matches", () => {
    const noMinimum = { status: "APPROVED" as const, requestedProfit: 200 };
    expect(profitApprovalGate({ ...base, uplift: 200, approval: noMinimum })).toMatchObject({ approvalValid: false, blocked: true });
  });

  test("pending and rejected requests only apply to the exact uplift", () => {
    expect(profitApprovalGate({ ...base, uplift: 200, approval: { status: "PENDING", requestedProfit: 200, minimumProfit: 1000 } })).toMatchObject({ pending: true, blocked: true });
    expect(profitApprovalGate({ ...base, uplift: 300, approval: { status: "PENDING", requestedProfit: 200, minimumProfit: 1000 } })).toMatchObject({ pending: false, blocked: true });
    expect(profitApprovalGate({ ...base, uplift: 200, approval: { status: "REJECTED", requestedProfit: 200, minimumProfit: 1000 } })).toMatchObject({ rejected: true, blocked: true });
  });

  test("minimum 0 never needs approval, whatever the uplift", () => {
    expect(profitApprovalGate({ ...base, minimum: 0, uplift: -50, approval: null })).toMatchObject({ needsApproval: false, blocked: false });
  });

  test("a price below list needs approval when a minimum is set", () => {
    expect(profitApprovalGate({ ...base, uplift: -1000, approval: null })).toMatchObject({ needsApproval: true, blocked: true });
  });

  test("cash is exempt, and so is no vehicle", () => {
    expect(profitApprovalGate({ ...base, isCash: true, uplift: -1000, approval: null }).blocked).toBe(false);
    expect(profitApprovalGate({ ...base, hasVehicle: false, uplift: -1000, approval: null }).blocked).toBe(false);
  });
});
