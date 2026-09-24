import { describe, expect, test } from "vitest";
import { buildWizardQuotePayload } from "./quotePayload";
import { OTHER_COMPANY_ID, WizardData } from "./types";

describe("buildWizardQuotePayload", () => {
  test("preserves manual finance mode and manual snapshot fields", () => {
    const wizardData: WizardData = {
      vehicleId: "vehicle_1",
      vehiclePrice: 30_000,
      desiredProfit: 1_500,
      downPayment: 7_000,
      termMonths: 48,
      selectedCompanyId: OTHER_COMPANY_ID,
      manualProfitRate: 6.25,
      manualInsuranceRate: 2.5,
      manualExecutionCommission: 300,
      manualExecutionFees: 150,
      manualIncludesCommissionInDebt: false,
      leadId: "lead_1",
    };

    const payload = buildWizardQuotePayload({
      orgId: "org_1",
      customerId: "customer_1",
      paymentType: "INSTALLMENT",
      wizardData,
      manualProviderName: "Other finance option",
      recipientName: "Customer",
      selectedResult: {
        companyName: "Other finance option",
        totalFinancedAmount: 24_950,
        monthlyInstallment: 602.5,
        profitRateApplied: 6.25,
        totalProfit: 3_970,
      },
    });

    expect(payload).toMatchObject({
      orgId: "org_1",
      customerId: "customer_1",
      vehicleId: "vehicle_1",
      leadId: "lead_1",
      companyId: undefined,
      mode: "MANUAL_FINANCE_COMPANY",
      vehiclePrice: 31_500,
      manualProviderName: "Other finance option",
      manualProfitRate: 6.25,
      manualInsuranceRate: 2.5,
      manualAdminFees: 150,
      manualCommission: 300,
      manualIncludesCommissionInDebt: false,
      totalFinancedAmount: 24_950,
      monthlyInstallment: 602.5,
      profitRateApplied: 6.25,
      totalProfit: 3_970,
      recipientName: "Customer",
    });
  });

  test("uses explicit cash mode for cash quotes", () => {
    const payload = buildWizardQuotePayload({
      orgId: "org_1",
      customerId: "customer_1",
      paymentType: "CASH",
      wizardData: {
        vehicleId: "vehicle_1",
        vehiclePrice: 20_000,
        desiredProfit: 500,
        downPayment: 20_500,
        termMonths: 0,
      },
      selectedResult: {
        totalFinancedAmount: 20_500,
        monthlyInstallment: 0,
        totalProfit: 0,
      },
    });

    expect(payload.mode).toBe("CASH");
    expect(payload.companyId).toBeUndefined();
    expect("manualProviderName" in payload).toBe(false);
  });

  test("populates customerEligibilityStatusIds for configured finance company quotes", () => {
    const payload = buildWizardQuotePayload({
      orgId: "org_1",
      customerId: "customer_1",
      paymentType: "INSTALLMENT",
      wizardData: {
        vehicleId: "vehicle_1",
        vehiclePrice: 20_000,
        desiredProfit: 500,
        downPayment: 5_000,
        termMonths: 48,
        selectedCompanyId: "company_1",
        customerStatuses: ["status_1", "status_2"],
      },
      selectedResult: {
        companyName: "Bank A",
        totalFinancedAmount: 15_500,
        monthlyInstallment: 380,
        profitRateApplied: 5,
        totalProfit: 2_740,
      },
    });

    expect(payload.mode).toBe("CONFIGURED_FINANCE_COMPANY");
    expect(payload.companyId).toBe("company_1");
    expect(payload.customerEligibilityStatusIds).toEqual(["status_1", "status_2"]);
  });
});
