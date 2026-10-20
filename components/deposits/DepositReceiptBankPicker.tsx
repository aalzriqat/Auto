"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { PaymentMethod } from "@/components/payments/PaymentMethodSelect";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function depositNeedsPhysicalBank(method: PaymentMethod | undefined): boolean {
  return method === "BANK_TRANSFER" || method === "CARD";
}

export function useDepositReceiptBankOptions(
  orgId: Id<"organizations"> | undefined,
  method: PaymentMethod | undefined,
  currency: string,
) {
  const required = depositNeedsPhysicalBank(method);
  const options = useQuery(api.deposits.listReceiptBankOptions,
    orgId && required ? { orgId, currency } : "skip");
  return { required, options };
}

export function DepositReceiptBankPicker({ id, options, value, onChange }: Readonly<{
  id: string;
  options: { banks: Array<{ _id: Id<"bankAccounts">; name: string; currency: string }>; truncated: boolean } | undefined;
  value: Id<"bankAccounts"> | undefined;
  onChange: (id: Id<"bankAccounts">) => void;
}>) {
  const { t } = useLanguage();
  const eligible = options?.banks.some((bank) => bank._id === value) ?? false;
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium" htmlFor={id}>{t("DepositBankLabel")}</label>
      <Select value={eligible ? value : ""} onValueChange={(id) => onChange(id as Id<"bankAccounts">)}
        disabled={!options || options.truncated || options.banks.length === 0}>
        <SelectTrigger id={id} aria-label={t("DepositBankLabel")}>
          <SelectValue placeholder={t("DepositBankChoose")} />
        </SelectTrigger>
        <SelectContent>
          {(options?.banks ?? []).map((bank) => (
            <SelectItem key={bank._id} value={bank._id}><bdi>{bank.name}</bdi> · {bank.currency}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {options?.truncated && <p role="alert" className="text-xs text-amber-700">{t("DepositTooManyBanks")}</p>}
      {options && !options.truncated && options.banks.length === 0 &&
        <p role="alert" className="text-xs text-amber-700">{t("DepositNoBank")}</p>}
    </div>
  );
}
