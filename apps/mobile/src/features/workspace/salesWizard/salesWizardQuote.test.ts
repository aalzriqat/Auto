/**
 * Mobile sales wizard & QuoteSaveArgs contract tests (S1-R11-H1).
 *
 * Verifies that QuoteSaveArgs and api.quotes.saveQuote support
 * customerEligibilityStatusIds as required by server-side configured
 * finance company quotes.
 */
import { api, type QuoteSaveArgs } from "../../../convexApi";
import { manualExecutionFeeInputValue } from "./salesWizardQuote";

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
});

