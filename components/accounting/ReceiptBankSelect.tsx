"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * SCRUM-54: the physical bank a bank transfer / card receipt reached. Read only while
 * `enabled`; no bank is ever preselected or inferred.
 */
export function useReceiptBankOptions(orgId: Id<"organizations"> | undefined, enabled: boolean, value: string) {
  const options = useQuery(api.collections.listReceiptBankOptions, enabled && orgId ? { orgId } : "skip");
  const banks = options?.banks;
  // Too many banks to list is its own state: never "no bank", and nothing can be chosen.
  const truncated = enabled && options?.truncated === true;
  const noEligible = enabled && banks !== undefined && !truncated && banks.length === 0;
  // A choice the server no longer offers (the list moved while the dialog was open) cannot be submitted.
  const chosenOffered = banks?.some((bank) => bank._id === value) === true;
  return { loading: enabled && options === undefined, banks, truncated, noEligible, chosenOffered };
}

export function ReceiptBankSelect({
  id,
  value,
  onChange,
  bankOptions,
  disabled = false,
}: Readonly<{
  id?: string;
  disabled?: boolean;
  value: string;
  onChange: (bankAccountId: string) => void;
  bankOptions: ReturnType<typeof useReceiptBankOptions>;
}>) {
  const { t } = useLanguage();
  const { loading, banks, truncated, noEligible, chosenOffered } = bankOptions;
  return (
    <div className="space-y-2">
      <Select value={chosenOffered ? value : ""} onValueChange={onChange} disabled={disabled || loading || noEligible || truncated}>
        <SelectTrigger id={id} aria-label={t("ReceiptBankAccount" as any)}>
          <SelectValue placeholder={t((loading ? "CashDrawerLoadingBanks" : "ReceiptSelectBank") as any)} />
        </SelectTrigger>
        <SelectContent className="max-h-72">
          {(banks ?? []).map((bank) => (
            <SelectItem key={bank._id} value={bank._id}>
              <bdi>{bank.name}</bdi>
              {" · "}
              <span className="text-xs text-muted-foreground">{bank.currency}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {noEligible && <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">{t("ReceiptNoBank" as any)}</p>}
      {truncated && <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">{t("ReceiptTooManyBanks" as any)}</p>}
    </div>
  );
}
