// Native port of the unified Murabaha calculation from lib/financing.ts.
// Keep the math identical to the web wizard — any change must land in both.

export interface UnifiedMurabahaInput {
  vehiclePrice: number;
  downPayment: number;
  commission: number;
  processingFees: number;
  annualProfitRate: number;
  annualInsuranceRate: number;
  termMonths: number;
  gracePeriodMonths?: number;
  includesCommissionInDebt?: boolean;
}

export interface UnifiedMurabahaResult {
  financedAmount: number;
  totalProfit: number;
  takafulAmount: number;
  totalContractValue: number;
  monthlyInstallment: number;
}

export function calculateUnifiedMurabaha({
  vehiclePrice,
  downPayment,
  commission,
  processingFees,
  annualProfitRate,
  annualInsuranceRate,
  termMonths,
  gracePeriodMonths = 0,
  includesCommissionInDebt = false,
}: UnifiedMurabahaInput): UnifiedMurabahaResult {
  if (vehiclePrice <= 0 || termMonths <= 0) {
    return {
      financedAmount: 0,
      totalProfit: 0,
      takafulAmount: 0,
      totalContractValue: 0,
      monthlyInstallment: 0,
    };
  }

  const years = termMonths / 12;
  const profitRateDecimal = annualProfitRate / 100;
  const insuranceRateDecimal = annualInsuranceRate / 100;

  // Commission stays out of the financed base when includesCommissionInDebt is
  // set (Dar Al Tamweel logic) so profit/insurance don't accrue on it; it is
  // added flat to the total instead.
  const financedAmount = includesCommissionInDebt
    ? vehiclePrice - downPayment + processingFees
    : vehiclePrice - downPayment + commission + processingFees;

  const totalProfit = financedAmount * profitRateDecimal * years;
  const debtBeforeInsurance = financedAmount + totalProfit;
  const takafulAmount = insuranceRateDecimal * years * debtBeforeInsurance;

  let totalContractValue = debtBeforeInsurance + takafulAmount;
  if (includesCommissionInDebt) {
    totalContractValue += commission;
  }

  const payingMonths = termMonths - gracePeriodMonths;
  const monthlyInstallment = payingMonths > 0 ? totalContractValue / payingMonths : 0;

  return {
    financedAmount,
    totalProfit,
    takafulAmount,
    totalContractValue,
    monthlyInstallment,
  };
}
