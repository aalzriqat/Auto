// ─── Types ────────────────────────────────────────────────────────────────────

export type PaymentType = "CASH" | "INSTALLMENT";

interface WizardData {
  vehicleId: string;
  vehiclePrice: number;
  desiredProfit: number;
  downPayment: number;
  termMonths: number;
  selectedCompanyId?: string; // the company picked in step 1 (installment)
}

interface SalesWizardProps {
  paymentType: PaymentType;
  onClose: () => void;
}
