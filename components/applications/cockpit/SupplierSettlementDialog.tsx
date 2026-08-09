"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, HandCoins } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { dateInputToUtcMs, todayDateInput } from "@/lib/dateInput";
import { PaymentMethodSelect, type PaymentMethod } from "@/components/payments/PaymentMethodSelect";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * `تسوية المورد` — recording money the SUPPLIER pays BACK to the dealership.
 *
 * This is the collection path on a consigned deal that settled
 * DIRECT_TO_SUPPLIER. The finance company paid the supplier the gross, so the
 * car's proceeds never touched the dealership; what remains is the dealership's
 * agency margin, and the supplier owes it. Until this existed, that claim could
 * be opened and never collected — `supplierReceivables.recordReceipt` had no
 * caller outside tests, which is why enabling the direct route was held back.
 *
 * Deliberately NOT styled as a disbursement confirmation. The disbursement
 * dialog records a fact about a payment between two OTHER parties; this records
 * money actually arriving in the dealership's account, which posts a journal.
 * The two look similar and mean opposite things, and conflating them is the
 * confusion this whole settlement track exists to remove.
 */
type SupplierSettlementDialogProps = {
  open: boolean;
  submitting: boolean;
  supplierName: string;
  /** What the supplier still owes, in MAJOR units — the server refuses more. */
  outstandingMajor: number;
  outstandingLabel: string;
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (receipt: {
    amount: number;
    receiptMethod?: PaymentMethod;
    receiptReference?: string;
    receivedAt?: number;
  }) => void;
};

export function SupplierSettlementDialog({
  open,
  submitting,
  supplierName,
  outstandingMajor,
  outstandingLabel,
  t,
  onOpenChange,
  onConfirm,
}: Readonly<SupplierSettlementDialogProps>) {
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [receivedOn, setReceivedOn] = useState("");
  // A supplier repaying a margin does it by transfer or cheque far more often
  // than in cash, so the default is the common case rather than the first
  // alphabetically.
  const [method, setMethod] = useState<PaymentMethod>("BANK_TRANSFER");

  // Reset on the closed -> open TRANSITION, reading the current outstanding
  // figure in the same render. Not on `open` alone: the outstanding amount comes
  // from a live query, and resetting whenever it changed would wipe what the
  // operator had typed off a cheque mid-entry. One effect, so correctness never
  // depends on the order two hooks happen to be declared in.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened) return;
    // Deliberately NOT prefilled with the outstanding balance. A supplier
    // paying in instalments is the normal case, and a prefilled "full amount"
    // is the one number an operator is most likely to accept without reading —
    // recording a settlement in full that never happened.
    setAmount("");
    setReference("");
    setReceivedOn("");
    setMethod("BANK_TRANSFER");
  }, [open]);

  const parsed = Number(amount);
  const entered = amount.trim() !== "";
  // `!(x > 0)` rather than `x <= 0`: they differ on NaN, and a non-numeric entry
  // must count as invalid. `NaN <= 0` is false, which would let it through.
  const amountInvalid = entered && !(parsed > 0);
  const exceedsClaim = entered && parsed > 0 && parsed > outstandingMajor;
  const canSubmit = entered && parsed > 0 && !exceedsClaim && !submitting;

  const withSupplier = (key: string) => t(key).replaceAll("{supplier}", supplierName);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("SettleSupplierTitle")}</DialogTitle>
          <DialogDescription>{withSupplier("SettleSupplierDesc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="supplier-receipt-amount">{t("SupplierReceiptAmount")}</Label>
            <Input
              id="supplier-receipt-amount"
              inputMode="decimal"
              value={amount}
              aria-invalid={amountInvalid || exceedsClaim}
              onChange={(e) => setAmount(e.target.value)}
              className="tabular-nums"
            />
            {/* Otherwise the confirm button sits dead on a money screen with
                nothing saying why. The server refuses an overpayment too — this
                only says so before the round trip. */}
            {amountInvalid && (
              <p role="alert" className="text-xs font-medium text-destructive">
                {t("ReceiptAmountInvalid")}
              </p>
            )}
            {exceedsClaim && (
              <p role="alert" className="text-xs font-medium text-destructive">
                {t("ReceiptExceedsClaim")}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {t("SupplierStillOwed")}: <span className="tabular-nums">{outstandingLabel}</span>
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="supplier-receipt-method">{t("SupplierReceiptAccount")}</Label>
            <PaymentMethodSelect
              t={t}
              value={method}
              onValueChange={setMethod}
              ariaLabel={t("SupplierReceiptAccount")}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="supplier-receipt-reference">{t("SupplierReceiptReference")}</Label>
              <Input
                id="supplier-receipt-reference"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="supplier-receipt-date">{t("SupplierReceiptDate")}</Label>
              <Input
                id="supplier-receipt-date"
                type="date"
                value={receivedOn}
                max={todayDateInput()}
                onChange={(e) => setReceivedOn(e.target.value)}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
            disabled={!canSubmit}
            onClick={() =>
              onConfirm({
                amount: parsed,
                receiptMethod: method,
                receiptReference: reference.trim() || undefined,
                // Money in, so the emerald treatment is correct here — unlike
                // the supplier-disbursement dialog, this really is a receipt.
                //
                // TODAY is sent as the current instant rather than as UTC
                // midnight, because only this side knows the operator's local
                // day. East of UTC, UTC-midnight-of-today is still in the
                // future for the first hours of the morning, and a backdated
                // day must arrive exactly as entered rather than clamped to
                // now — that would file a receipt under a date nobody typed.
                receivedAt: receivedOn
                  ? receivedOn === todayDateInput()
                    ? Date.now()
                    : dateInputToUtcMs(receivedOn)
                  : undefined,
              })
            }
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <HandCoins className="h-4 w-4 me-2" />
            )}
            {t("RecordReceipt")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
