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
  manualIncludesCommissionInDebt?: boolean;
  recipientName?: string;
  /** Set when the wizard was launched from a lead's context, so the resulting quote links back to it. */
  leadId?: string;
  /** Seeds the vehicle picker's "source a vehicle" form when launched via a SOLD vehicle's "Source another like this" action. */
  sourceLikeVehicle?: {
    make: string;
    model: string;
    year: number;
    trim?: string;
    color: string;
    fuelType: string;
    transmission: string;
  };
}
export type PaymentType = "CASH" | "INSTALLMENT";

/** Sentinel selectedCompanyId for the "Others" manual-entry financing card. */
export const OTHER_COMPANY_ID = "OTHER";

