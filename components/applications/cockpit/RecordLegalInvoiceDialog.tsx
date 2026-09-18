"use client";

import { useState } from "react";
import { Loader2, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { dateInputToUtcMs, msToDateInput, todayDateInput } from "@/lib/dateInput";

function parseMajor(value: string, scale: number): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed * Math.pow(10, scale));
}

type IssuedTo = "CUSTOMER" | "FINANCE_COMPANY" | "OTHER";

export type RecordLegalInvoiceValues = {
  legalInvoiceAmountMinor: number;
  legalInvoiceNumber: string;
  legalInvoiceDate: number;
  issuedTo: IssuedTo;
  issuedToOther?: string;
};

type RecordLegalInvoiceDialogProps = {
  open: boolean;
  submitting: boolean;
  error: string | null;
  scale: number;
  currency: string;
  existing?: {
    amountMinor?: number;
    number?: string;
    date?: number;
    issuedTo?: string;
    issuedToOther?: string;
  };
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: RecordLegalInvoiceValues) => Promise<void>;
};

export function RecordLegalInvoiceDialog({
  open,
  submitting,
  error,
  scale,
  currency,
  existing,
  t,
  onOpenChange,
  onSubmit,
}: Readonly<RecordLegalInvoiceDialogProps>) {
  const [amount, setAmount] = useState(() =>
    existing?.amountMinor !== undefined ? String(existing.amountMinor / Math.pow(10, scale)) : ""
  );
  const [number, setNumber] = useState(() => existing?.number ?? "");
  const [date, setDate] = useState(() =>
    existing?.date ? msToDateInput(existing.date) : todayDateInput()
  );
  const [issuedTo, setIssuedTo] = useState<IssuedTo>(() =>
    existing?.issuedTo === "CUSTOMER" || existing?.issuedTo === "OTHER"
      ? existing.issuedTo
      : "FINANCE_COMPANY"
  );
  const [issuedToOther, setIssuedToOther] = useState(() => existing?.issuedToOther ?? "");
  const [localError, setLocalError] = useState<string | null>(null);

  const amountMinor = parseMajor(amount, scale);
  const isInvalid =
    amountMinor === null ||
    !number.trim() ||
    !date ||
    (issuedTo === "OTHER" && !issuedToOther.trim());

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting || isInvalid) return;

    setLocalError(null);
    try {
      await onSubmit({
        legalInvoiceAmountMinor: amountMinor,
        legalInvoiceNumber: number.trim(),
        legalInvoiceDate: dateInputToUtcMs(date),
        issuedTo,
        issuedToOther: issuedTo === "OTHER" ? issuedToOther.trim() : undefined,
      });
      onOpenChange(false);
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : t("UnexpectedError"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            {t("RecordLegalInvoice")}
          </DialogTitle>
          <DialogDescription>{t("RecordLegalInvoiceDesc")}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="legal-invoice-amount">
              {t("LegalInvoiceAmount")} (<bdi dir="ltr">{currency}</bdi>)
            </Label>
            <Input
              id="legal-invoice-amount"
              inputMode="decimal"
              className="tabular-nums"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="legal-invoice-number">{t("LegalInvoiceNumber")}</Label>
            <Input
              id="legal-invoice-number"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="INV-0001"
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="legal-invoice-date">{t("LegalInvoiceDate")}</Label>
            <Input
              id="legal-invoice-date"
              type="date"
              max={todayDateInput()}
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="legal-invoice-issued-to">{t("LegalInvoiceIssuedTo")}</Label>
            <Select value={issuedTo} onValueChange={(val: IssuedTo) => setIssuedTo(val)}>
              <SelectTrigger id="legal-invoice-issued-to">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="FINANCE_COMPANY">{t("PartyFinancier")}</SelectItem>
                <SelectItem value="CUSTOMER">{t("Customer")}</SelectItem>
                <SelectItem value="OTHER">{t("Other")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {issuedTo === "OTHER" && (
            <div className="space-y-1.5">
              <Label htmlFor="legal-invoice-other">{t("LegalInvoiceIssuedToOther")}</Label>
              <Input
                id="legal-invoice-other"
                value={issuedToOther}
                onChange={(e) => setIssuedToOther(e.target.value)}
                required
              />
            </div>
          )}

          {(error || localError) && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error || localError}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              {t("Cancel")}
            </Button>
            <Button type="submit" disabled={submitting || isInvalid}>
              {submitting && <Loader2 className="h-4 w-4 me-2 animate-spin" />}
              {t("SubmitLegalInvoice")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
