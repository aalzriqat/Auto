"use client";

import type { Id } from "@/convex/_generated/dataModel";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function PayrollBankPicker({ id, value, onChange, options, disabled, frozenName, t }: Readonly<{
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: { banks: Array<{ _id: Id<"bankAccounts">; name: string; currency: string }>; truncated: boolean } | undefined;
  disabled: boolean;
  frozenName?: string | null;
  t: (key: string) => string;
}>) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">{t("DirectPaymentBankLabel")}</Label>
      {disabled && frozenName ? (
        <p id={id} role="status" className="rounded-md border border-input px-3 py-2 text-sm">
          {t("PayrollRetryOriginalBank")} <bdi>{frozenName}</bdi>
        </p>
      ) : (
        <Select value={options?.banks.some((bank) => bank._id === value) ? value : ""}
          onValueChange={onChange} disabled={disabled || !options || options.truncated || options.banks.length === 0}>
          <SelectTrigger id={id} aria-label={t("DirectPaymentBankLabel")} className="w-48 h-9">
            <SelectValue placeholder={t("DirectPaymentBankChoose")} />
          </SelectTrigger>
          <SelectContent>
            {(options?.banks ?? []).map((bank) => <SelectItem key={bank._id} value={bank._id}>
              <bdi>{bank.name}</bdi> · {bank.currency}
            </SelectItem>)}
          </SelectContent>
        </Select>
      )}
      {!frozenName && options?.truncated && <p role="alert" className="text-xs text-amber-700">{t("DirectPaymentTooManyBanks")}</p>}
      {!frozenName && options && options.banks.length === 0 && !options.truncated &&
        <p role="alert" className="text-xs text-amber-700">{t("DirectPaymentNoBank")}</p>}
    </div>
  );
}
