"use client";

import { useState } from "react";
import { Loader2, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type ExpectedPaymentMethod = "CASH" | "INTERNAL_INSTALLMENT" | "CHEQUE" | "BANK_TRANSFER";

type RegisterExpectedPaymentDialogProps = {
  open: boolean;
  disabled: boolean;
  submitting: boolean;
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (values: {
    method: ExpectedPaymentMethod;
    expectedDate: number;
    chequeDetails?: { bank: string; chequeNumber: string };
  }) => void;
};

/** Registers cash/in-house-installment/cheque/bank-transfer as the expected settlement, before finalizeDeal. */
export function RegisterExpectedPaymentDialog({
  open,
  disabled,
  submitting,
  t,
  onOpenChange,
  onConfirm,
}: Readonly<RegisterExpectedPaymentDialogProps>) {
  const [method, setMethod] = useState<ExpectedPaymentMethod>("BANK_TRANSFER");
  const [dateStr, setDateStr] = useState(() => new Date().toISOString().slice(0, 10));
  const [bank, setBank] = useState("");
  const [chequeNumber, setChequeNumber] = useState("");

  const canSubmit = method !== "CHEQUE" || (bank.trim().length > 0 && chequeNumber.trim().length > 0);

  const handleConfirm = () => {
    onConfirm({
      method,
      expectedDate: new Date(dateStr).getTime(),
      chequeDetails: method === "CHEQUE" ? { bank, chequeNumber } : undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" className="border-indigo-500/40 text-indigo-600 hover:bg-indigo-500/10" disabled={disabled}>
          <Wallet className="h-4 w-4 me-2" />
          {t("RegisterExpectedPayment")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("RegisterExpectedPayment")}</DialogTitle>
          <DialogDescription>{t("RegisterExpectedPaymentDesc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("PaymentMethodLabel")}</label>
            <Select value={method} onValueChange={(value) => setMethod(value as ExpectedPaymentMethod)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="CASH">{t("PaymentMethodCash")}</SelectItem>
                <SelectItem value="INTERNAL_INSTALLMENT">{t("PaymentMethodInternalInstallment")}</SelectItem>
                <SelectItem value="CHEQUE">{t("PaymentMethodCheque")}</SelectItem>
                <SelectItem value="BANK_TRANSFER">{t("PaymentMethodBankTransfer")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("ExpectedPaymentDateLabel")}</label>
            <Input type="date" value={dateStr} onChange={(e) => setDateStr(e.target.value)} />
          </div>

          {method === "CHEQUE" && (
            <>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t("Bank")}</label>
                <Input value={bank} onChange={(e) => setBank(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t("ChequeNumber")}</label>
                <Input value={chequeNumber} onChange={(e) => setChequeNumber(e.target.value)} />
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={submitting || !canSubmit}
            className="bg-indigo-600 hover:bg-indigo-700 text-white"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("Confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
