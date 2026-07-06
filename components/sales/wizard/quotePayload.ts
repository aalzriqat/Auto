import { OTHER_COMPANY_ID, PaymentType, WizardData } from "./types";

export type QuoteMode =
  | "CASH"
  | "CONFIGURED_FINANCE_COMPANY"
  | "MANUAL_FINANCE_COMPANY";

type SelectedResult = {
  totalFinancedAmount?: number;
  monthlyInstallment?: number;
  profitRateApplied?: number;
  totalProfit?: number;
  companyName?: string;
};

export function buildWizardQuotePayload({
  orgId,
  customerId,
  paymentType,
  wizardData,
  selectedResult,
  recipientName,
  manualProviderName,
}: {
  orgId: string;
  customerId: string;
  paymentType: PaymentType;
  wizardData: WizardData;
  selectedResult: SelectedResult;
  recipientName?: string;
  manualProviderName?: string;
}) {
  const isManualFinance = wizardData.selectedCompanyId === OTHER_COMPANY_ID;
  const mode: QuoteMode =
    paymentType === "CASH"
      ? "CASH"
      : isManualFinance
        ? "MANUAL_FINANCE_COMPANY"
        : "CONFIGURED_FINANCE_COMPANY";
  const trimmedRecipientName = recipientName?.trim();
  const providerName = (manualProviderName ?? selectedResult.companyName ?? "Other finance option").trim();

  return {
    orgId,
    vehicleId: wizardData.vehicleId,
    vehicleItems: wizardData.vehicleItems,
    customerId,
    leadId: wizardData.leadId || undefined,
    companyId:
      paymentType === "CASH" || isManualFinance
        ? undefined
        : wizardData.selectedCompanyId,
    mode,
    vehiclePrice: wizardData.vehiclePrice + (wizardData.desiredProfit || 0),
    downPayment: wizardData.downPayment,
    termMonths: wizardData.termMonths,
    totalFinancedAmount: selectedResult.totalFinancedAmount,
    monthlyInstallment: selectedResult.monthlyInstallment,
    profitRateApplied: selectedResult.profitRateApplied,
    totalProfit: selectedResult.totalProfit,
    recipientName: trimmedRecipientName || undefined,
    ...(isManualFinance
      ? {
          manualProviderName: providerName || "Other finance option",
          manualProfitRate: wizardData.manualProfitRate ?? 0,
          manualInsuranceRate: wizardData.manualInsuranceRate ?? 0,
          manualAdminFees: wizardData.manualExecutionFees ?? 0,
          manualCommission: wizardData.manualExecutionCommission ?? 0,
          manualIncludesCommissionInDebt: wizardData.manualIncludesCommissionInDebt ?? true,
        }
      : {}),
  };
}
