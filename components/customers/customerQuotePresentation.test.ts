import { describe, expect, test } from "vitest";
import {
  customerQuotePaymentType,
  customerQuoteTotalAmount,
  isCashQuotePresentation,
  isFinancedQuotePresentation,
} from "./customerQuotePresentation";

describe("customer quote presentation authority", () => {
  test("uses vehicle price only for explicit or legacy cash quotes", () => {
    const cash = { mode: "CASH", vehiclePrice: 10_500, totalFinancedAmount: 99_999 };
    const legacyCash = { vehiclePrice: 9_500 };

    expect(isCashQuotePresentation(cash)).toBe(true);
    expect(customerQuoteTotalAmount(cash)).toBe(10_500);
    expect(customerQuotePaymentType(cash)).toBe("CASH");
    expect(customerQuoteTotalAmount(legacyCash)).toBe(9_500);
  });

  test("manual finance is installment even without a companyId", () => {
    const quote = {
      mode: "MANUAL_FINANCE_COMPANY",
      vehiclePrice: 10_500,
      totalFinancedAmount: 9_800,
    };

    expect(isFinancedQuotePresentation(quote)).toBe(true);
    expect(customerQuotePaymentType(quote)).toBe("INSTALLMENT");
    expect(customerQuoteTotalAmount(quote)).toBe(9_800);
  });

  test("never substitutes vehicle price for a missing financed total", () => {
    for (const mode of ["CONFIGURED_FINANCE_COMPANY", "INTERNAL_INSTALLMENT", "LEASE"]) {
      const quote = { mode, companyId: mode === "CONFIGURED_FINANCE_COMPANY" ? "fc_1" : undefined, vehiclePrice: 10_500 };
      expect(isFinancedQuotePresentation(quote)).toBe(true);
      expect(customerQuoteTotalAmount(quote)).toBeUndefined();
      expect(customerQuotePaymentType(quote)).toBe("INSTALLMENT");
    }
  });

  test("legacy company-backed quotes remain installment quotes", () => {
    const quote = { companyId: "fc_legacy", vehiclePrice: 10_500, totalFinancedAmount: 9_600 };
    expect(isFinancedQuotePresentation(quote)).toBe(true);
    expect(customerQuoteTotalAmount(quote)).toBe(9_600);
  });
});
