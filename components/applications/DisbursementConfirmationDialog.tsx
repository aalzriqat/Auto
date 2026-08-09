"use client";

import { useEffect, useState } from "react";
import { Loader2, Landmark, HandCoins } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * `DEALERSHIP` — the finance company paid the dealership. Money arrived in its
 * bank and settles a receivable it holds, so the action is styled as a receipt
 * and reads as one.
 *
 * `SUPPLIER` — the finance company paid the SUPPLIER, on a consigned deal whose
 * car was never the dealership's. No dealership money moves and no journal is
 * posted; the dealership is recording a fact from the settlement advice, and
 * what it is still owed remains a claim on the supplier.
 *
 * Two modes of one dialog rather than two components, because the shape of the
 * interaction is identical and only the claim being made differs. The emerald
 * "money in" treatment is deliberately NOT reused for `SUPPLIER`: nothing was
 * received, and dressing it as a receipt is the exact confusion this settlement
 * work exists to remove.
 */
type DisbursementConfirmationMode = "DEALERSHIP" | "SUPPLIER";

type DisbursementConfirmationDialogProps = {
  open: boolean;
  disabled: boolean;
  submitting: boolean;
  amountLabel: string;
  mode?: DisbursementConfirmationMode;
  /** Substituted into the SUPPLIER copy, which names him. */
  supplierName?: string;
  /**
   * SUPPLIER mode only. What the company paid the supplier is a transaction
   * between two other parties, so it is read off the settlement advice rather
   * than assumed — the operator types the amount, its reference and its date.
   * `amountLabel` is the dealership's own expectation, shown for comparison.
   */
  onConfirmSupplier?: (advice: { amountMajor: number; reference?: string; disbursedAt?: number }) => void;
  /** Prefill for the advice amount, in major units. */
  defaultAmountMajor?: number;
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
};

export function DisbursementConfirmationDialog({
  open,
  disabled,
  submitting,
  amountLabel,
  mode = "DEALERSHIP",
  supplierName,
  onConfirmSupplier,
  defaultAmountMajor,
  t,
  onOpenChange,
  onConfirm,
}: Readonly<DisbursementConfirmationDialogProps>) {
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [paidOn, setPaidOn] = useState("");

  // Reset to the prefill each time the dialog opens, so a corrected figure from
  // an abandoned attempt is never silently carried into the next one.
  useEffect(() => {
    if (!open) return;
    setAmount(defaultAmountMajor !== undefined ? String(defaultAmountMajor) : "");
    setReference("");
    setPaidOn("");
  }, [open, defaultAmountMajor]);

  const supplier = mode === "SUPPLIER" ? supplierName ?? t("TheSupplier") : "";
  // `replaceAll`, not `replace`. A string pattern replaces the FIRST match only,
  // and the description names the supplier twice in both locales — so the second
  // one rendered as the literal text `{supplier}` on a money confirmation.
  const withSupplier = (key: string) => t(key).replaceAll("{supplier}", supplier);

  const copy =
    mode === "SUPPLIER"
      ? {
          trigger: t("ConfirmSupplierDisbursement"),
          title: t("ConfirmSupplierDisbursement"),
          description: withSupplier("ConfirmSupplierDisbursementDesc"),
          amountLabel: withSupplier("SupplierDisbursementAmount"),
          confirm: t("ConfirmRecorded"),
        }
      : {
          trigger: t("ConfirmDisbursement"),
          title: t("ConfirmDisbursement"),
          description: t("ConfirmDisbursementDesc"),
          amountLabel: t("DisbursementAmount"),
          confirm: t("ConfirmReceipt"),
        };

  const isReceipt = mode === "DEALERSHIP";
  const accentClass = isReceipt
    ? "bg-emerald-600 hover:bg-emerald-700 text-white"
    : "border-amber-500/50 text-amber-700 hover:bg-amber-500/10 dark:text-amber-400";
  const Icon = isReceipt ? Landmark : HandCoins;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button
          className={isReceipt ? accentClass : undefined}
          variant={isReceipt ? "default" : "outline"}
          disabled={disabled}
        >
          <Icon className="h-4 w-4 me-2" />
          {copy.trigger}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        {isReceipt ? (
          <div className="rounded-md border bg-muted/50 p-3">
            <p className="text-xs text-muted-foreground">{copy.amountLabel}</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{amountLabel}</p>
          </div>
        ) : (
          /* The advice is a document about two other parties, so it is typed in
             rather than assumed. The dealership's own expectation is shown
             beside the field for comparison, never substituted for it: the two
             differ whenever there is a down payment, an LTV split, or a
             renegotiated purchase amount, and recording the expectation as the
             fact is wrong on every such deal. */
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="supplier-advice-amount">{copy.amountLabel}</Label>
              <Input
                id="supplier-advice-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="tabular-nums"
              />
              <p className="text-xs text-muted-foreground">
                {t("DealershipExpected")}: <span className="tabular-nums">{amountLabel}</span>
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="supplier-advice-reference">{t("AdviceReference")}</Label>
                <Input
                  id="supplier-advice-reference"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="supplier-advice-date">{t("AdviceDate")}</Label>
                <Input
                  id="supplier-advice-date"
                  type="date"
                  value={paidOn}
                  max={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => setPaidOn(e.target.value)}
                />
              </div>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button
            onClick={() => {
              if (isReceipt) return onConfirm();
              const amountMajor = Number(amount);
              if (!Number.isFinite(amountMajor) || amountMajor <= 0) return;
              onConfirmSupplier?.({
                amountMajor,
                reference: reference.trim() || undefined,
                // Parsed as UTC midday so a timezone offset cannot roll the
                // stated day backwards — and never sent as a future date, which
                // the server refuses.
                disbursedAt: paidOn ? Date.parse(`${paidOn}T12:00:00Z`) : undefined,
              });
            }}
            disabled={submitting || (!isReceipt && !(Number(amount) > 0))}
            variant={isReceipt ? "default" : "outline"}
            className={accentClass}
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {copy.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
