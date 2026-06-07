import { calculateUnifiedMurabaha, calculateDBR } from "./financing";
import { describe, it, expect } from "vitest";

describe("Financing Logic", () => {
  describe("calculateUnifiedMurabaha", () => {
    it("should correctly calculate values for a standard loan", () => {
      const result = calculateUnifiedMurabaha({
        vehiclePrice: 10000,
        downPayment: 2000,
        commission: 100,
        processingFees: 50,
        annualProfitRate: 5,
        annualInsuranceRate: 1.5,
        termMonths: 60,
      });

      expect(result.financedAmount).toBe(10000 - 2000 + 100 + 50); // 8150
      expect(result.totalProfit).toBe(8150 * 0.05 * 5); // 2037.5
      
      const debtBeforeInsurance = 8150 + 2037.5; // 10187.5
      expect(result.takafulAmount).toBe(0.015 * 5 * debtBeforeInsurance); // 764.0625

      const totalContractValue = 10187.5 + 764.0625; // 10951.5625
      expect(result.totalContractValue).toBeCloseTo(10951.5625);

      expect(result.monthlyInstallment).toBeCloseTo(10951.5625 / 60);
    });

    it("should return zeros if vehiclePrice or termMonths is zero or negative", () => {
      const result = calculateUnifiedMurabaha({
        vehiclePrice: 0,
        downPayment: 2000,
        commission: 100,
        processingFees: 50,
        annualProfitRate: 5,
        annualInsuranceRate: 1.5,
        termMonths: 60,
      });

      expect(result.financedAmount).toBe(0);
      expect(result.totalProfit).toBe(0);
      expect(result.takafulAmount).toBe(0);
      expect(result.totalContractValue).toBe(0);
      expect(result.monthlyInstallment).toBe(0);

      const result2 = calculateUnifiedMurabaha({
        vehiclePrice: 10000,
        downPayment: 2000,
        commission: 100,
        processingFees: 50,
        annualProfitRate: 5,
        annualInsuranceRate: 1.5,
        termMonths: 0,
      });

      expect(result2.financedAmount).toBe(0);
    });

    it("should handle includesCommissionInDebt logic correctly", () => {
      const result = calculateUnifiedMurabaha({
        vehiclePrice: 10000,
        downPayment: 2000,
        commission: 500, // higher commission
        processingFees: 50,
        annualProfitRate: 5,
        annualInsuranceRate: 1.5,
        termMonths: 60,
        includesCommissionInDebt: true,
      });

      // Same logic, but totalContractValue is increased by 500 at the end
      const financedAmount = 10000 - 2000 + 500 + 50; // 8550
      const totalProfit = 8550 * 0.05 * 5; // 2137.5
      const debtBeforeInsurance = 8550 + 2137.5; // 10687.5
      const takafulAmount = 0.015 * 5 * debtBeforeInsurance; // 801.5625
      const totalContractValue = 10687.5 + 801.5625 + 500; // 11989.0625

      expect(result.totalContractValue).toBeCloseTo(totalContractValue);
      expect(result.monthlyInstallment).toBeCloseTo(totalContractValue / 60);
    });

    it("should correctly handle grace periods", () => {
      const result = calculateUnifiedMurabaha({
        vehiclePrice: 10000,
        downPayment: 2000,
        commission: 100,
        processingFees: 50,
        annualProfitRate: 5,
        annualInsuranceRate: 1.5,
        termMonths: 60,
        gracePeriodMonths: 3,
      });

      const financedAmount = 10000 - 2000 + 100 + 50; // 8150
      const totalProfit = 8150 * 0.05 * 5; // 2037.5
      const debtBeforeInsurance = 8150 + 2037.5; // 10187.5
      const takafulAmount = 0.015 * 5 * debtBeforeInsurance; // 764.0625
      const totalContractValue = 10187.5 + 764.0625; // 10951.5625

      expect(result.monthlyInstallment).toBeCloseTo(10951.5625 / 57); // 60 - 3
    });
  });

  describe("calculateDBR", () => {
    it("should correctly calculate DBR", () => {
      const dbr = calculateDBR(5000, 1000, 500);
      expect(dbr).toBe(((1000 + 500) / 5000) * 100); // 30
    });

    it("should return 0 if salary is zero or negative", () => {
      expect(calculateDBR(0, 1000, 500)).toBe(0);
      expect(calculateDBR(-100, 1000, 500)).toBe(0);
    });
  });
});
