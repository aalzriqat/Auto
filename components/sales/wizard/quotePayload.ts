import { OTHER_COMPANY_ID, PaymentType, WizardData } from "./types";

/** Autosave transports only the governed durable draft fields. */
export function buildWizardDraftData(data: WizardData) {
  return {
    vehicleId: data.vehicleId,
    vehiclePrice: data.vehiclePrice,
    desiredProfit: data.desiredProfit,
    downPayment: data.downPayment,
    termMonths: data.termMonths,
    selectedCompanyId: data.selectedCompanyId,
    manualProfitRate: data.manualProfitRate,
    manualInsuranceRate: data.manualInsuranceRate,
    manualExecutionCommission: data.manualExecutionCommission,
    manualExecutionFees: data.manualExecutionFees,
    manualIncludesCommissionInDebt: data.manualIncludesCommissionInDebt,
    recipientName: data.recipientName,
    customerStatuses: data.customerStatuses,
    leadId: data.leadId,
    vehicleItems: data.vehicleItems?.map(item => ({ vehicleId: item.vehicleId, unitPrice: item.unitPrice })),
  };
}

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
    customerEligibilityStatusIds:
      mode === "CONFIGURED_FINANCE_COMPANY" && wizardData.customerStatuses
        ? (wizardData.customerStatuses as any)
        : undefined,
    mode,
    vehiclePrice: wizardData.vehiclePrice + (wizardData.desiredProfit || 0),
    // Sent separately from the folded-in price so the backend can check it
    // against the vehicle's minimum profit — the price alone cannot be
    // decomposed once the user edits it.
    desiredProfit: wizardData.desiredProfit || 0,
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
          manualAdminFees: wizardData.manualExecutionFees,
          manualCommission: wizardData.manualExecutionCommission ?? 0,
          manualIncludesCommissionInDebt: wizardData.manualIncludesCommissionInDebt ?? true,
        }
      : {}),
  };
}
