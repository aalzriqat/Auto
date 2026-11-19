import type { SaleFormValues } from "./sale.schema";

export function estimateSalePayment(values: SaleFormValues): number {
  if (values.financingType !== "FINANCED") return 0;

  const price = Number(values.salePrice) || 0;
  const taxes = Number(values.taxAmount) || 0;
  const fees = Number(values.dealerFees) || 0;
  const warranty = Number(values.warrantySold) || 0;
  const gap = Number(values.gapSold) || 0;
  const downPayment = Number(values.downPayment) || 0;
  const tradeIn = Number(values.tradeInValue) || 0;

  const principal = price + taxes + fees + warranty + gap - downPayment - tradeIn;
  const apr = Number(values.apr) || 0;
  const months = Number(values.termMonths) || 1;

  if (principal <= 0) return 0;
  if (apr === 0) return principal / months;

  const r = (apr / 100) / 12;
  const payment = (principal * r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1);
  return payment;
}
