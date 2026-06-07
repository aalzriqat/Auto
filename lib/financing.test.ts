import { describe, it, expect } from "vitest";
import { calculateUnifiedMurabaha, calculateDBR } from "./financing";

describe("Financing Logic", () => {
  describe("calculateUnifiedMurabaha", () => {
    it("returns zeroed out results if vehiclePrice is 0 or termMonths is 0", () => {
      const res1 = calculateUnifiedMurabaha({
        vehiclePrice: 0,
        downPayment: 0,
        commission: 0,
        processingFees: 0,
        annualProfitRate: 5,
        annualInsuranceRate: 2,
        termMonths: 60,
      });
      expect(res1.financedAmount).toBe(0);

      const res2 = calculateUnifiedMurabaha({
        vehiclePrice: 10000,
        downPayment: 0,
        commission: 0,
        processingFees: 0,
        annualProfitRate: 5,
        annualInsuranceRate: 2,
        termMonths: 0,
      });
      expect(res2.monthlyInstallment).toBe(0);
    });

    it("calculates standard 5-year loan correctly without commission in debt", () => {
      const res = calculateUnifiedMurabaha({
        vehiclePrice: 20000,
        downPayment: 5000, // Financed = 15000
        commission: 0,
        processingFees: 100, // Financed = 15100
        annualProfitRate: 5, // 5% over 5 years = 25% = 3775 profit
        annualInsuranceRate: 2, // 2% over 5 years = 10% of debt before insurance
        termMonths: 60,
        includesCommissionInDebt: false,
      });

      expect(res.financedAmount).toBe(15100);
      expect(res.totalProfit).toBe(3775); // 15100 * 0.05 * 5
      
      const debtBeforeInsurance = 15100 + 3775; // 18875
      expect(res.takafulAmount).toBe(18875 * 0.02 * 5); // 1887.5
      
      const expectedTotalContract = 18875 + 1887.5; // 20762.5
      expect(res.totalContractValue).toBeCloseTo(expectedTotalContract);
      
      expect(res.monthlyInstallment).toBeCloseTo(expectedTotalContract / 60);
    });

    it("handles grace period correctly", () => {
      const res = calculateUnifiedMurabaha({
        vehiclePrice: 10000,
        downPayment: 0,
        commission: 0,
        processingFees: 0,
        annualProfitRate: 10,
        annualInsuranceRate: 0,
        termMonths: 12,
        gracePeriodMonths: 2, // Paying months = 10
      });

      // Financed = 10000, Profit = 1000 (10% over 1 year)
      // Total Debt = 11000
      expect(res.totalContractValue).toBe(11000);
      expect(res.monthlyInstallment).toBe(11000 / 10); // 1100
    });
  });

  describe("calculateDBR", () => {
    it("returns 0 if salary is 0", () => {
      expect(calculateDBR(0, 1000, 500)).toBe(0);
    });

    it("calculates DBR correctly", () => {
      // Salary 2000, Existing Debt 400, New 600 -> Total Debt 1000 -> DBR 50%
      expect(calculateDBR(2000, 400, 600)).toBe(50);
      
      // Salary 5000, Existing 2000, New 2000 -> Total Debt 4000 -> DBR 80%
      expect(calculateDBR(5000, 2000, 2000)).toBe(80);
    });
  });
});
