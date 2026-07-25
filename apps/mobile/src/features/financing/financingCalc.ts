// Standard amortized monthly payment for a car loan/murabaha estimate.
// principal = price - down payment; a flat 0% rate falls back to even
// installments. Returns 0 for a non-positive principal or term so the UI can
// show a neutral state instead of NaN/Infinity.
export function estimateMonthlyPayment(
  price: number,
  downPayment: number,
  termMonths: number,
  annualRatePct: number,
): number {
  const principal = Math.max(price - downPayment, 0);
  if (principal <= 0 || termMonths <= 0) return 0;

  const monthlyRate = annualRatePct / 100 / 12;
  if (monthlyRate <= 0) return principal / termMonths;

  const growth = Math.pow(1 + monthlyRate, termMonths);
  return (principal * monthlyRate * growth) / (growth - 1);
}
