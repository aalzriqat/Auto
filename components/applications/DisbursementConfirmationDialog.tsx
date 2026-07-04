"use client";

import { Loader2, Landmark } from "lucide-react";
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

type DisbursementConfirmationDialogProps = {
  open: boolean;
  disabled: boolean;
  submitting: boolean;
  amountLabel: string;
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
};

export function DisbursementConfirmationDialog({
  open,
  disabled,
  submitting,
  amountLabel,
  t,
  onOpenChange,
  onConfirm,
}: Readonly<DisbursementConfirmationDialogProps>) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button className="bg-emerald-600 hover:bg-emerald-700 text-white" disabled={disabled}>
          <Landmark className="h-4 w-4 me-2" />
          {t("ConfirmDisbursement")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("ConfirmDisbursement")}</DialogTitle>
          <DialogDescription>{t("ConfirmDisbursementDesc")}</DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <p className="text-xs text-slate-500">{t("DisbursementAmount")}</p>
          <p className="mt-1 text-lg font-semibold text-slate-900">{amountLabel}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button onClick={onConfirm} disabled={submitting} className="bg-emerald-600 hover:bg-emerald-700 text-white">
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("ConfirmReceipt")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
