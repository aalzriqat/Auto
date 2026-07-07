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

    it("should handle includesCommissionInDebt logic correctly (commission excluded from financed base, added flat)", () => {
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

      // Commission is excluded from the financed base (no profit/insurance accrues on it)
      // and added once, flat, to the total contract value at the end.
      const financedAmount = 10000 - 2000 + 50; // 8050
      const totalProfit = 8050 * 0.05 * 5; // 2012.5
      const debtBeforeInsurance = 8050 + 2012.5; // 10062.5
      const takafulAmount = 0.015 * 5 * debtBeforeInsurance; // 754.6875
      const totalContractValue = 10062.5 + 754.6875 + 500; // 11317.1875

      expect(result.financedAmount).toBeCloseTo(financedAmount);
      expect(result.totalContractValue).toBeCloseTo(totalContractValue);
      expect(result.monthlyInstallment).toBeCloseTo(totalContractValue / 60);
    });

    it("matches the Dar Al Tamweel sheet from blom cars.xlsx exactly", () => {
      // السماحة... no, دار التمويل sheet: price 11300, down 1000, commission 275,
      // processing fees 500, annual rate 8.8%, insurance 0.65%, 60 months, no grace.
      const result = calculateUnifiedMurabaha({
        vehiclePrice: 11300,
        downPayment: 1000,
        commission: 275,
        processingFees: 500,
        annualProfitRate: 8.8,
        annualInsuranceRate: 0.65,
        termMonths: 60,
        includesCommissionInDebt: true,
      });

      expect(result.financedAmount).toBeCloseTo(10800); // E16
      expect(result.totalProfit).toBeCloseTo(4752); // E18
      expect(result.takafulAmount).toBeCloseTo(505.44); // E19
      expect(result.totalContractValue).toBeCloseTo(16332.44); // I19
      expect(result.monthlyInstallment).toBeCloseTo(272.2073333, 5); // I18
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

    it("returns a zero monthlyInstallment when the grace period consumes the whole term", () => {
      const result = calculateUnifiedMurabaha({
        vehiclePrice: 10000,
        downPayment: 2000,
        commission: 100,
        processingFees: 50,
        annualProfitRate: 5,
        annualInsuranceRate: 1.5,
        termMonths: 12,
        gracePeriodMonths: 12,
      });

      expect(result.monthlyInstallment).toBe(0);
      // Everything else still computes normally — only the division is guarded.
      expect(result.totalContractValue).toBeGreaterThan(0);
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
