/**
 * `calculateFinancePreview` must agree with the canonical engine.
 *
 * It used to be a third hand-written copy of the Murabaha math — after
 * `lib/financing.ts` and the mobile `murabaha.ts` port, whose comment instructed
 * future readers to "keep the math identical to the web wizard". Nothing
 * enforced that, and this copy had already drifted: it clamped `financedAmount`
 * and `totalContractValue` with `Math.max(0, …)`, which the canonical engine
 * does not.
 *
 * It delegates now, so what is left to get wrong is the field mapping —
 * `adminFees` → `processingFees`, `profitRate` → `annualProfitRate`,
 * `insuranceRate` → `annualInsuranceRate`. Those names differ between the two
 * shapes, and swapping two of them still typechecks, since every field is a
 * `number`. This checks the mapping over a matrix rather than one happy path,
 * including the negative-financed-amount case the clamp used to hide.
 */
import { calculateUnifiedMurabaha } from "@autoflow/shared/financing";
import { calculateFinancePreview, type FinancePreviewInput } from "./moduleShared";

const CASES: Array<{ name: string; input: FinancePreviewInput }> = [
  {
    name: "standard financed deal",
    input: {
      vehiclePrice: 20000,
      downPayment: 4000,
      commission: 300,
      adminFees: 150,
      profitRate: 6.5,
      insuranceRate: 1.2,
      termMonths: 60,
      gracePeriodMonths: 0,
      includesCommissionInDebt: false,
    },
  },
  {
    name: "commission paid flat on top (Dar Al Tamweel shape)",
    input: {
      vehiclePrice: 20000,
      downPayment: 4000,
      commission: 300,
      adminFees: 150,
      profitRate: 6.5,
      insuranceRate: 1.2,
      termMonths: 60,
      gracePeriodMonths: 0,
      includesCommissionInDebt: true,
    },
  },
  {
    name: "grace period shortens the paying months",
    input: {
      vehiclePrice: 35000,
      downPayment: 5000,
      commission: 500,
      adminFees: 200,
      profitRate: 8,
      insuranceRate: 2,
      termMonths: 48,
      gracePeriodMonths: 3,
      includesCommissionInDebt: false,
    },
  },
  {
    name: "distinct rates, so swapping profit and insurance would show",
    input: {
      vehiclePrice: 18000,
      downPayment: 2000,
      commission: 100,
      adminFees: 900,
      profitRate: 3,
      insuranceRate: 11,
      termMonths: 36,
      gracePeriodMonths: 0,
      includesCommissionInDebt: false,
    },
  },
  {
    name: "down payment above the price — what the Math.max clamp used to hide",
    input: {
      vehiclePrice: 10000,
      downPayment: 15000,
      commission: 0,
      adminFees: 0,
      profitRate: 5,
      insuranceRate: 1,
      termMonths: 24,
      gracePeriodMonths: 0,
      includesCommissionInDebt: false,
    },
  },
  {
    name: "zero-length term returns the neutral state, not NaN",
    input: {
      vehiclePrice: 10000,
      downPayment: 1000,
      commission: 0,
      adminFees: 0,
      profitRate: 5,
      insuranceRate: 1,
      termMonths: 0,
      gracePeriodMonths: 0,
      includesCommissionInDebt: false,
    },
  },
];

describe("calculateFinancePreview delegates to the canonical engine", () => {
  it.each(CASES)("$name", ({ input }) => {
    const preview = calculateFinancePreview(input);
    const canonical = calculateUnifiedMurabaha({
      vehiclePrice: input.vehiclePrice,
      downPayment: input.downPayment,
      commission: input.commission,
      processingFees: input.adminFees,
      annualProfitRate: input.profitRate,
      annualInsuranceRate: input.insuranceRate,
      termMonths: input.termMonths,
      gracePeriodMonths: input.gracePeriodMonths,
      includesCommissionInDebt: input.includesCommissionInDebt,
    });

    expect(preview.financedAmount).toBe(canonical.financedAmount);
    expect(preview.totalProfit).toBe(canonical.totalProfit);
    expect(preview.totalContractValue).toBe(canonical.totalContractValue);
    expect(preview.monthlyInstallment).toBe(canonical.monthlyInstallment);
  });

  it("no longer floors a negative financed amount at zero", () => {
    // The old clamp reported 0 here, which made an impossible deal (down payment
    // above the vehicle price) look merely free rather than wrong.
    const preview = calculateFinancePreview({
      vehiclePrice: 10000,
      downPayment: 15000,
      commission: 0,
      adminFees: 0,
      profitRate: 5,
      insuranceRate: 1,
      termMonths: 24,
      gracePeriodMonths: 0,
      includesCommissionInDebt: false,
    });

    expect(preview.financedAmount).toBeLessThan(0);
  });
});
