"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { PaymentMethodSelect, type PaymentMethod, type Translate } from "@/components/payments/PaymentMethodSelect";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Id } from "@/convex/_generated/dataModel";

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
  bankAccountId,
  bankOptions,
  uncertain,
  retryBankName,
  t,
  onOpenChange,
  onPaymentMethodChange,
  onBankChange,
  onConfirm,
}: Readonly<{
  commission: CommissionPaymentDetails | null;
  open: boolean;
  isPaying: boolean;
  paymentMethod: PaymentMethod;
  bankAccountId: string;
  bankOptions: { banks: Array<{ _id: Id<"bankAccounts">; name: string; currency: string }>; truncated: boolean } | undefined;
  uncertain: boolean;
  retryBankName: string | null;
  t: Translate;
  onOpenChange: (open: boolean) => void;
  onPaymentMethodChange: (method: PaymentMethod) => void;
  onBankChange: (bankAccountId: string) => void;
  onConfirm: () => void;
}>) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!isPaying) onOpenChange(next); }}>
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
              {uncertain ? (
                <p className="rounded-md border border-input px-3 py-2 text-sm">{t(`PaymentMethod_${paymentMethod}` as any)}</p>
              ) : (
                <PaymentMethodSelect t={t} value={paymentMethod} onValueChange={onPaymentMethodChange} />
              )}
            </div>
            {paymentMethod !== "CASH" && (
              <div className="space-y-1.5">
                <Label htmlFor="commission-paying-bank">{t("DirectPaymentBankLabel" as any)}</Label>
                {uncertain ? (
                  <p id="commission-paying-bank" className="rounded-md border border-input px-3 py-2 text-sm" role="status">
                    {t("CommissionRetryOriginalBank" as any)} <bdi>{retryBankName ?? t("DirectPaymentBankChoose" as any)}</bdi>
                  </p>
                ) : (
                  <Select
                    value={bankOptions?.banks.some((bank) => bank._id === bankAccountId) ? bankAccountId : ""}
                    onValueChange={onBankChange}
                    disabled={isPaying || bankOptions === undefined || bankOptions.truncated || bankOptions.banks.length === 0}
                  >
                    <SelectTrigger id="commission-paying-bank" aria-label={t("DirectPaymentBankLabel" as any)}>
                      <SelectValue placeholder={t("DirectPaymentBankChoose" as any)} />
                    </SelectTrigger>
                    <SelectContent>
                      {(bankOptions?.banks ?? []).map((bank) => (
                        <SelectItem key={bank._id} value={bank._id}><bdi>{bank.name}</bdi> · {bank.currency}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {bankOptions?.truncated && !uncertain && <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">{t("DirectPaymentTooManyBanks" as any)}</p>}
                {bankOptions && bankOptions.banks.length === 0 && !bankOptions.truncated && !uncertain && <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">{t("DirectPaymentNoBank" as any)}</p>}
              </div>
            )}
            {uncertain && <p role="status" className="text-xs text-muted-foreground">{t("CommissionRetrySameDetails" as any)}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPaying}>
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
