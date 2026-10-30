"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PaymentMethodSelect, type PaymentMethod, type Translate } from "@/components/payments/PaymentMethodSelect";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLanguage } from "@/components/providers/LanguageProvider";
import type { Id } from "@/convex/_generated/dataModel";
import { formatExactMinorAmount } from "@/lib/moneyDisplay";

type SupplierPaymentDetails = {
  vehicleDesc: string;
  sourcedFromName: string;
  amountDue: number;
  settlementAmountMinor: number | null;
  currency: string;
};

export function SupplierPaymentDialog({
  payable,
  open,
  isPaying,
  notes,
  paymentMethod,
  bankAccountId,
  bankOptions,
  taxAmount,
  vatAllowed,
  t,
  onOpenChange,
  onNotesChange,
  onPaymentMethodChange,
  onBankAccountChange,
  onTaxAmountChange,
  onConfirm,
}: Readonly<{
  payable: SupplierPaymentDetails | null;
  open: boolean;
  isPaying: boolean;
  notes: string;
  paymentMethod: PaymentMethod;
  bankAccountId: Id<"bankAccounts"> | null;
  bankOptions: { banks: Array<{ _id: Id<"bankAccounts">; name: string; currency: string }>; truncated: boolean } | undefined;
  taxAmount: string;
  /** The server's verdict for this payable (`vatReclassAllowed`); false hides the VAT field. */
  vatAllowed: boolean;
  t: Translate;
  onOpenChange: (open: boolean) => void;
  onNotesChange: (notes: string) => void;
  onPaymentMethodChange: (method: PaymentMethod) => void;
  onBankAccountChange: (bankAccountId: Id<"bankAccounts"> | null) => void;
  onTaxAmountChange: (taxAmount: string) => void;
  onConfirm: () => void;
}>) {
  const { locale } = useLanguage();
  const bankMethod = paymentMethod === "BANK_TRANSFER" || paymentMethod === "CARD" || paymentMethod === "CHEQUE";
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
                <span data-testid="supplier-payment-amount" dir="ltr" className="font-semibold text-orange-600">{payable.settlementAmountMinor == null ? "—" : formatExactMinorAmount(payable.settlementAmountMinor, payable.currency)} {payable.currency}</span>
              </p>
            </div>
            <p className="text-sm text-muted-foreground">{t("MarkPaidWarning" as any)}</p>
            {payable.settlementAmountMinor == null ? (
              <p role="alert" className="text-sm text-destructive">{t("ServerError_SUPPLIER_AMOUNT_PRECISION")}</p>
            ) : null}
            <div className="space-y-1.5">
              <Label>{t("PaymentMethodLabel" as any)}</Label>
              <PaymentMethodSelect t={t} value={paymentMethod} onValueChange={onPaymentMethodChange} />
            </div>
            {bankMethod ? (
              <div className="space-y-1.5">
                <Label>{locale === "ar" ? "الحساب المصرفي المدفوع منه" : "Bank account paid from"}</Label>
                <Select value={bankAccountId ?? undefined} onValueChange={(value) => onBankAccountChange(value as Id<"bankAccounts">)}>
                  <SelectTrigger aria-label={locale === "ar" ? "الحساب المصرفي المدفوع منه" : "Bank account paid from"}>
                    <SelectValue placeholder={locale === "ar" ? "اختر الحساب المصرفي" : "Select a bank account"} />
                  </SelectTrigger>
                  <SelectContent>
                    {(bankOptions?.banks ?? []).map((bank) => (
                      <SelectItem key={bank._id} value={bank._id}>{bank.name} · {bank.currency}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!bankOptions ? <p className="text-sm text-muted-foreground">{locale === "ar" ? "جاري تحميل الحسابات المصرفية..." : "Loading bank accounts..."}</p> : null}
                {bankOptions?.truncated ? <p className="text-sm text-destructive">{locale === "ar" ? "عدد الحسابات المصرفية أكبر من أن يُعرض هنا." : "Too many active bank accounts to list."}</p> : null}
                {bankOptions && !bankOptions.truncated && bankOptions.banks.length === 0 ? <p className="text-sm text-destructive">{locale === "ar" ? "لا يوجد حساب مصرفي نشط بهذه العملة." : "No active bank account is available in this currency."}</p> : null}
              </div>
            ) : null}
            {vatAllowed ? (
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
            ) : (
              <p className="rounded-lg border bg-muted/50 p-3 text-sm text-muted-foreground" role="note">
                {t("PayableNoVatReclass" as any)}
              </p>
            )}
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
              <Button className="bg-green-600 hover:bg-green-700 text-white" onClick={onConfirm} disabled={isPaying || payable.settlementAmountMinor == null || (bankMethod && (!bankAccountId || !bankOptions || bankOptions.truncated || !bankOptions.banks.some((bank) => bank._id === bankAccountId)))}>
                {isPaying ? `${t("Processing" as any)}...` : t("ConfirmPayment" as any)}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
