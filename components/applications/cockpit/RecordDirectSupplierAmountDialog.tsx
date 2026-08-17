"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * What the manual finance provider will pay the supplier directly.
 *
 * A SEPARATE dialog from `RecordApprovedPurchaseDialog`, deliberately. That one
 * carries an approval BASIS, an appraisal to approve against, an applied LTV and
 * an outlier acknowledgement — every one of which belongs to a configured
 * finance company's lending rules. A manual provider has none of them, and
 * offering those controls here would ask the operator to characterise a decision
 * the deal never had.
 *
 * What this deal does have is a figure somebody agreed and a document it came
 * from, so that is what this asks for. The source is REQUIRED because the server
 * requires it: an amount nobody can trace is not evidence, and this is the row
 * a reader reaches for months later when the supplier's payment is questioned.
 */
export interface RecordDirectSupplierAmountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  submitting: boolean;
  /** The supplier this money reaches, named so the operator can check it. */
  supplierName: string | null;
  /** The provider paying him, for the same reason. */
  providerName: string | null;
  /** Formats a minor-unit figure in the deal's own currency. */
  money: (minor: number) => string;
  /** The vehicle's agreed price, shown as a reference point, never prefilled. */
  referenceMinor: number | null;
  toMinor: (input: string) => number | null;
  onSubmit: (values: { approvedAmountMinor: number; source: string; notes?: string }) => Promise<void>;
  t: (key: string) => string;
}

export function RecordDirectSupplierAmountDialog({
  open,
  onOpenChange,
  submitting,
  supplierName,
  providerName,
  money,
  referenceMinor,
  toMinor,
  onSubmit,
  t,
}: Readonly<RecordDirectSupplierAmountDialogProps>) {
  const [amount, setAmount] = useState("");
  const [source, setSource] = useState("");
  const [notes, setNotes] = useState("");
  const wasOpen = useRef(false);

  // Cleared on OPEN, not on close. A dialog that keeps the last figure would
  // offer the previous deal's number to the next one, and the operator would
  // have to notice in order not to record it.
  useEffect(() => {
    if (open && !wasOpen.current) {
      setAmount("");
      setSource("");
      setNotes("");
    }
    wasOpen.current = open;
  }, [open]);

  const amountMinor = amount.trim() === "" ? null : toMinor(amount);
  // Blank is NOT invalid — it is unanswered, and colouring an untouched field
  // red is how a form teaches the operator to ignore its own warnings. Only a
  // typed value that cannot be a positive amount is wrong.
  const amountInvalid = amount.trim() !== "" && (amountMinor === null || amountMinor <= 0);
  const sourceMissing = source.trim() === "";
  const canSubmit = !submitting && amountMinor !== null && amountMinor > 0 && !sourceMissing;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Truck className="h-4 w-4 shrink-0" aria-hidden="true" />
            {t("DirectSupplierAmountTitle")}
          </DialogTitle>
          <DialogDescription>{t("DirectSupplierAmountDescription")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Who is paying whom. Both names come from the deal, so the operator
              is checking a figure against parties rather than against memory. */}
          {(providerName || supplierName) && (
            <dl className="grid gap-1.5 text-sm">
              {providerName && (
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-foreground">{t("DirectSupplierAmountPayer")}</dt>
                  <dd className="font-medium">{providerName}</dd>
                </div>
              )}
              {supplierName && (
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-foreground">{t("DirectSupplierAmountPayee")}</dt>
                  <dd className="font-medium">{supplierName}</dd>
                </div>
              )}
              {referenceMinor !== null && (
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-foreground">{t("DirectSupplierAmountReference")}</dt>
                  <dd>
                    <bdi className="tabular-nums font-medium">{money(referenceMinor)}</bdi>
                  </dd>
                </div>
              )}
            </dl>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="direct-supplier-amount">{t("DirectSupplierAmountLabel")}</Label>
            <Input
              id="direct-supplier-amount"
              inputMode="decimal"
              value={amount}
              aria-invalid={amountInvalid}
              onChange={(event) => setAmount(event.target.value)}
              className="tabular-nums"
            />
            {amountInvalid && (
              <p role="alert" className="text-xs font-medium text-destructive">
                {t("DirectSupplierAmountInvalid")}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="direct-supplier-source">{t("DirectSupplierAmountSourceLabel")}</Label>
            <Input
              id="direct-supplier-source"
              value={source}
              onChange={(event) => setSource(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t("DirectSupplierAmountSourceHelp")}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="direct-supplier-notes">{t("DirectSupplierAmountNotesLabel")}</Label>
            <Textarea
              id="direct-supplier-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={2}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("Cancel")}
          </Button>
          <Button
            disabled={!canSubmit}
            onClick={async () => {
              if (amountMinor === null) return;
              await onSubmit({
                approvedAmountMinor: amountMinor,
                source: source.trim(),
                notes: notes.trim() ? notes.trim() : undefined,
              });
            }}
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {t("DirectSupplierAmountAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
