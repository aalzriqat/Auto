"use client";

import { Loader2, Landmark, HandCoins } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  t,
  onOpenChange,
  onConfirm,
}: Readonly<DisbursementConfirmationDialogProps>) {
  const supplier = mode === "SUPPLIER" ? supplierName ?? t("TheSupplier") : "";
  const withSupplier = (key: string) => t(key).replace("{supplier}", supplier);

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
        <div className="rounded-md border bg-muted/50 p-3">
          <p className="text-xs text-muted-foreground">{copy.amountLabel}</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{amountLabel}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button
            onClick={onConfirm}
            disabled={submitting}
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
