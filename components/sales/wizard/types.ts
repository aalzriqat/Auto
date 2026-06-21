export interface WizardData {
  vehicleId: string;
  vehiclePrice: number;
  desiredProfit: number;
  downPayment: number;
  termMonths: number;
  selectedCompanyId?: string;
  manualProfitRate?: number;
  manualInsuranceRate?: number;
  recipientName?: string;
}
export type PaymentType = "CASH" | "INSTALLMENT";

/** Sentinel selectedCompanyId for the "Others" manual-entry financing card. */
export const OTHER_COMPANY_ID = "OTHER";

