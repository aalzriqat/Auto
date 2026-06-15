export interface WizardData {
  vehicleId: string;
  vehiclePrice: number;
  desiredProfit: number;
  downPayment: number;
  termMonths: number;
  selectedCompanyId?: string;
  recipientName?: string;
}
export type PaymentType = "CASH" | "INSTALLMENT";

