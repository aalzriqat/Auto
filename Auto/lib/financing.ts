// lib/financing.ts

/**
 * Calculates profit and installment based on the Unified Murabaha Engine.
 * 
 * 1. Financed Amount = Vehicle Price - Down Payment + Commission + Processing Fees
 * 2. Profit = Financed Amount * Annual Rate * Years
 * 3. Debt Before Insurance = Financed Amount + Profit
 * 4. Insurance = Insurance Rate * Years * Debt Before Insurance
 * 5. Total Debt = Debt Before Insurance + Insurance
 * 6. If includesCommissionInDebt: Total Debt += Commission
 * 7. Monthly Installment = Total Debt / (Months - Grace Period)
 */
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
}: {
  vehiclePrice: number;
  downPayment: number;
  commission: number;
  processingFees: number;
  annualProfitRate: number;
  annualInsuranceRate: number;
  termMonths: number;
  gracePeriodMonths?: number;
  includesCommissionInDebt?: boolean;
}) {
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

  // 1. Determine Financing Amount
  const financedAmount = vehiclePrice - downPayment + commission + processingFees;

  // 2. Calculate Total Profit
  const totalProfit = financedAmount * profitRateDecimal * years;

  // 3. Debt Before Insurance
  const debtBeforeInsurance = financedAmount + totalProfit;

  // 4. Calculate Insurance
  const takafulAmount = insuranceRateDecimal * years * debtBeforeInsurance;

  // 5. Produce Total Debt
  let totalContractValue = debtBeforeInsurance + takafulAmount;

  // 6. Commission Handling (Dar Al Tamweel logic)
  if (includesCommissionInDebt) {
    totalContractValue += commission;
  }

  // 7. Divide By Repayment Months
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

/**
 * Calculates the Debt Burden Ratio (DBR) to ensure a customer is eligible for the loan.
 * 
 * @param salary The customer's monthly salary
 * @param existingDebt The total of their current monthly debt obligations
 * @param proposedInstallment The monthly installment of the new proposed loan
 * @returns The new DBR percentage (e.g. 45.5 for 45.5%)
 */
export function calculateDBR(
  salary: number,
  existingDebt: number,
  proposedInstallment: number
) {
  if (salary <= 0) return 0;

  const totalDebt = existingDebt + proposedInstallment;
  const dbr = (totalDebt / salary) * 100;

  return dbr;
}

