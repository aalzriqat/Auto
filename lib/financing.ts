// lib/financing.ts

/**
 * Calculates profit and installment based on the Unified Murabaha Engine.
 *
 * Commission can be treated two ways, matching the two patterns in the source
 * spreadsheet (most companies vs. Dar Al Tamweel):
 *
 * - includesCommissionInDebt = false (default): commission is capitalized into
 *   the financed amount, so profit and insurance accrue on it.
 *     1. Financed Amount = Vehicle Price - Down Payment + Commission + Processing Fees
 *     2. Profit = Financed Amount * Annual Rate * Years
 *     3. Debt Before Insurance = Financed Amount + Profit
 *     4. Insurance = Insurance Rate * Years * Debt Before Insurance
 *     5. Total Debt = Debt Before Insurance + Insurance
 *
 * - includesCommissionInDebt = true (Dar Al Tamweel logic): commission is paid
 *   as a flat amount on top of the contract value, excluded from the financed
 *   base so no profit or insurance accrues on it.
 *     1. Financed Amount = Vehicle Price - Down Payment + Processing Fees
 *     2. Profit = Financed Amount * Annual Rate * Years
 *     3. Debt Before Insurance = Financed Amount + Profit
 *     4. Insurance = Insurance Rate * Years * Debt Before Insurance
 *     5. Total Debt = Debt Before Insurance + Insurance + Commission
 *
 * 6. Monthly Installment = Total Debt / (Months - Grace Period)
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

  // 1. Determine Financing Amount. When includesCommissionInDebt is set
  // (Dar Al Tamweel logic), commission is kept out of the financed base so
  // profit/insurance don't accrue on it, and is added flat in step 5 instead.
  const financedAmount = includesCommissionInDebt
    ? vehiclePrice - downPayment + processingFees
    : vehiclePrice - downPayment + commission + processingFees;

  // 2. Calculate Total Profit
  const totalProfit = financedAmount * profitRateDecimal * years;

  // 3. Debt Before Insurance
  const debtBeforeInsurance = financedAmount + totalProfit;

  // 4. Calculate Insurance
  const takafulAmount = insuranceRateDecimal * years * debtBeforeInsurance;

  // 5. Produce Total Debt
  let totalContractValue = debtBeforeInsurance + takafulAmount;
  if (includesCommissionInDebt) {
    totalContractValue += commission;
  }

  // 6. Divide By Repayment Months
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

// Above any realistic vehicle price in this market; bounds the bisection.
const AFFORDABLE_PRICE_SEARCH_CEILING = 500_000;

/**
 * Inverse of calculateUnifiedMurabaha: the highest vehicle price whose
 * computed monthly installment stays within the buyer's budget, under one
 * finance company's terms.
 *
 * Implemented as a bisection over the forward engine itself — never a second
 * closed-form formula — so the two can never drift apart if the engine's
 * commission/insurance handling changes. monthlyInstallment is monotonically
 * nondecreasing in vehiclePrice, which is all bisection needs.
 */
export function calculateMaximumAffordableVehiclePrice({
  maximumMonthlyPayment,
  downPayment,
  termMonths,
  financeTerms,
}: {
  maximumMonthlyPayment: number;
  downPayment: number;
  termMonths: number;
  financeTerms: {
    annualProfitRate: number;
    annualInsuranceRate: number;
    commission: number;
    processingFees: number;
    gracePeriodMonths?: number;
    includesCommissionInDebt?: boolean;
  };
}): number {
  const gracePeriodMonths = financeTerms.gracePeriodMonths ?? 0;
  if (maximumMonthlyPayment <= 0 || termMonths <= 0 || termMonths - gracePeriodMonths <= 0) {
    return 0;
  }

  const monthlyFor = (vehiclePrice: number) =>
    calculateUnifiedMurabaha({
      vehiclePrice,
      downPayment,
      commission: financeTerms.commission,
      processingFees: financeTerms.processingFees,
      annualProfitRate: financeTerms.annualProfitRate,
      annualInsuranceRate: financeTerms.annualInsuranceRate,
      termMonths,
      gracePeriodMonths,
      includesCommissionInDebt: financeTerms.includesCommissionInDebt ?? false,
    }).monthlyInstallment;

  let low = 0;
  let high = AFFORDABLE_PRICE_SEARCH_CEILING;
  if (monthlyFor(high) <= maximumMonthlyPayment) return high;

  for (let iteration = 0; iteration < 40; iteration += 1) {
    const mid = (low + high) / 2;
    if (monthlyFor(mid) <= maximumMonthlyPayment) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return Math.floor(low);
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

