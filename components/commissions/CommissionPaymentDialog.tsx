"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { PaymentMethodSelect, type PaymentMethod, type Translate } from "@/components/payments/PaymentMethodSelect";

type CommissionPaymentDetails = {
  salespersonName: string;
  vehicleSummary: string;
  amountLabel: string;
};

export function CommissionPaymentDialog({
  commission,
  open,
  isPaying,
  paymentMethod,
  t,
  onOpenChange,
  onPaymentMethodChange,
  onConfirm,
}: Readonly<{
  commission: CommissionPaymentDetails | null;
  open: boolean;
  isPaying: boolean;
  paymentMethod: PaymentMethod;
  t: Translate;
  onOpenChange: (open: boolean) => void;
  onPaymentMethodChange: (method: PaymentMethod) => void;
  onConfirm: () => void;
}>) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("ConfirmCommissionPayment" as any)}</DialogTitle>
        </DialogHeader>
        {commission && (
          <div className="space-y-4">
            <div className="rounded-lg bg-muted/50 p-3 text-sm space-y-1">
              <p><strong>{t("Salesperson" as any)}:</strong> {commission.salespersonName}</p>
              <p><strong>{t("Vehicle" as any)}:</strong> {commission.vehicleSummary}</p>
              <p><strong>{t("CommissionAmount" as any)}:</strong> {commission.amountLabel}</p>
            </div>
            <div className="space-y-1.5">
              <Label>{t("PaymentMethodLabel" as any)}</Label>
              <PaymentMethodSelect t={t} value={paymentMethod} onValueChange={onPaymentMethodChange} />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("Cancel" as any)}
              </Button>
              <Button className="bg-green-600 hover:bg-green-700 text-white" onClick={onConfirm} disabled={isPaying}>
                {isPaying ? `${t("Processing" as any)}...` : t("ConfirmPayment" as any)}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
