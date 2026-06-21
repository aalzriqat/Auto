export interface WizardData {
  vehicleId: string;
  vehiclePrice: number;
  desiredProfit: number;
  downPayment: number;
  termMonths: number;
  selectedCompanyId?: string;
  manualProfitRate?: number;
  manualInsuranceRate?: number;
  manualExecutionCommission?: number;
  manualExecutionFees?: number;
  recipientName?: string;
  /** Set when the wizard was launched from a lead's context, so the resulting quote links back to it. */
  leadId?: string;
}
export type PaymentType = "CASH" | "INSTALLMENT";

/** Sentinel selectedCompanyId for the "Others" manual-entry financing card. */
export const OTHER_COMPANY_ID = "OTHER";

