"use client";

import { useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import { format } from "date-fns";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/sonner";
export { PaymentMethodSelect, type PaymentMethod, type Translate } from "@/components/payments/PaymentMethodSelect";

const CURRENCY_SCALES: Record<string, number> = {
  JOD: 3,
  KWD: 3,
  BHD: 3,
  OMR: 3,
  USD: 2,
  EUR: 2,
  GBP: 2,
  SAR: 2,
  AED: 2,
  QAR: 2,
  EGP: 2,
  JPY: 0,
};

export const todayInput = new Date().toISOString().slice(0, 10);

export type CurrencyFormatter = (amount: number, fractionDigits?: number) => string;

type ButtonVariant = ComponentProps<typeof Button>["variant"];

export function scaleForCurrency(currency: string): number {
  return CURRENCY_SCALES[currency.toUpperCase()] ?? 2;
}

export function dateInputToMs(value: string): number {
  return new Date(`${value}T00:00:00`).getTime();
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useAccountingSubmit() {
  const [submitting, setSubmitting] = useState(false);

  async function submitWithFeedback(action: () => Promise<void>): Promise<void> {
    setSubmitting(true);
    try {
      await action();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  return { submitting, submitWithFeedback };
}

export function LoadingAccountingState({ label }: Readonly<{ label: string }>) {
  return <div className="p-8 text-center text-slate-500">{label}</div>;
}

export function AccountingTableFrame({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="rounded-md border border-slate-200 overflow-x-auto">{children}</div>;
}

export function AccountingEmptyRow({ colSpan, label }: Readonly<{ colSpan: number; label: string }>) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="text-center text-slate-500 py-8">
        {label}
      </TableCell>
    </TableRow>
  );
}

export function AmountSummary({
  label,
  value,
}: Readonly<{
  label: string;
  value: string;
}>) {
  return (
    <p className="text-sm text-slate-500">
      {label}: <strong>{value}</strong>
    </p>
  );
}

export function CurrencyAmountInput({
  label,
  value,
  onChange,
  factor,
  min = 0,
}: Readonly<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  factor: number;
  min?: number;
}>) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        type="number"
        min={min}
        step={1 / factor}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function DialogFooterActions({
  cancelLabel,
  confirmLabel,
  onCancel,
  onConfirm,
  submitting,
  disabled,
  confirmVariant,
  confirmClassName,
}: Readonly<{
  cancelLabel: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  submitting: boolean;
  disabled?: boolean;
  confirmVariant?: ButtonVariant;
  confirmClassName?: string;
}>) {
  return (
    <>
      <Button variant="outline" onClick={onCancel}>
        {cancelLabel}
      </Button>
      <Button
        onClick={onConfirm}
        disabled={submitting || disabled}
        variant={confirmVariant}
        className={`gap-2 ${confirmClassName ?? ""}`}
      >
        {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
        {confirmLabel}
      </Button>
    </>
  );
}

export function AccountingHistoryTable<T extends { _id: string }>({
  rows,
  emptyLabel,
  getLabel,
  getDate,
  getAmountMinor,
  getAmountPrefix,
  getAmountClassName,
  factor,
  scale,
  formatCurrency,
}: Readonly<{
  rows: readonly T[];
  emptyLabel: string;
  getLabel: (row: T) => string;
  getDate: (row: T) => number;
  getAmountMinor: (row: T) => number;
  getAmountPrefix?: (row: T) => string;
  getAmountClassName?: (row: T) => string;
  factor: number;
  scale: number;
  formatCurrency: CurrencyFormatter;
}>) {
  if (rows.length === 0) {
    return <p className="text-sm text-slate-500 text-center py-8">{emptyLabel}</p>;
  }

  return (
    <Table>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row._id}>
            <TableCell className="text-sm">{getLabel(row)}</TableCell>
            <TableCell className="text-sm text-slate-500">
              {format(new Date(getDate(row)), "MMM d, yyyy")}
            </TableCell>
            <TableCell className={`text-sm text-right font-medium ${getAmountClassName?.(row) ?? ""}`}>
              {getAmountPrefix?.(row) ?? ""}
              {formatCurrency(getAmountMinor(row) / factor, scale)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
