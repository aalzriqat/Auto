"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PaymentMethodSelect, type PaymentMethod, type Translate } from "@/components/payments/PaymentMethodSelect";

type SupplierPaymentDetails = {
  vehicleDesc: string;
  sourcedFromName: string;
  amountDue: number;
};

export function SupplierPaymentDialog({
  payable,
  open,
  isPaying,
  notes,
  paymentMethod,
  taxAmount,
  t,
  onOpenChange,
  onNotesChange,
  onPaymentMethodChange,
  onTaxAmountChange,
  onConfirm,
}: Readonly<{
  payable: SupplierPaymentDetails | null;
  open: boolean;
  isPaying: boolean;
  notes: string;
  paymentMethod: PaymentMethod;
  taxAmount: string;
  t: Translate;
  onOpenChange: (open: boolean) => void;
  onNotesChange: (notes: string) => void;
  onPaymentMethodChange: (method: PaymentMethod) => void;
  onTaxAmountChange: (taxAmount: string) => void;
  onConfirm: () => void;
}>) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("ConfirmSupplierPayment" as any)}</DialogTitle>
        </DialogHeader>
        {payable && (
          <div className="space-y-4">
            <div className="rounded-lg bg-muted/50 p-3 text-sm space-y-1">
              <p><strong>{t("Vehicle" as any)}:</strong> {payable.vehicleDesc}</p>
              <p><strong>{t("SourceDealer" as any)}:</strong> {payable.sourcedFromName}</p>
              <p>
                <strong>{t("Amount" as any)}:</strong>{" "}
                <span className="font-semibold text-orange-600">{payable.amountDue.toLocaleString()} JOD</span>
              </p>
            </div>
            <p className="text-sm text-muted-foreground">{t("MarkPaidWarning" as any)}</p>
            <div className="space-y-1.5">
              <Label>{t("PaymentMethodLabel" as any)}</Label>
              <PaymentMethodSelect t={t} value={paymentMethod} onValueChange={onPaymentMethodChange} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("VatAmount" as any)} ({t("Optional" as any)})</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                max={payable.amountDue}
                placeholder="0"
                value={taxAmount}
                onChange={(event) => onTaxAmountChange(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("PaymentNotes" as any)} ({t("Optional" as any)})</Label>
              <Textarea
                value={notes}
                onChange={(event) => onNotesChange(event.target.value)}
                placeholder={t("PaymentNotesPlaceholder" as any)}
                rows={2}
              />
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
