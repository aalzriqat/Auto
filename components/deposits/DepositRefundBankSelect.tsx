"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ReceiptBankSelect } from "@/components/accounting/ReceiptBankSelect";

/** Approval users may pick a refund bank without requiring the manage-finance permission. */
export function useDepositRefundBanks(
  orgId: Id<"organizations"> | undefined,
  currency: string | undefined,
  enabled: boolean,
  value: string,
) {
  const options = useQuery(api.deposits.listRefundBankOptions,
    enabled && orgId ? { orgId, ...(currency ? { currency } : {}) } : "skip");
  const banks = options?.banks;
  const truncated = enabled && options?.truncated === true;
  const noEligible = enabled && banks !== undefined && !truncated && banks.length === 0;
  const chosenOffered = banks?.some((bank) => bank._id === value) === true;
  return { loading: enabled && options === undefined, banks, truncated, noEligible, chosenOffered };
}

export function DepositRefundBankSelect({
  id, value, onChange, bankOptions, disabled,
}: Readonly<{
  id?: string;
  value: string;
  onChange: (bankAccountId: string) => void;
  bankOptions: ReturnType<typeof useDepositRefundBanks>;
  disabled?: boolean;
}>) {
  return <ReceiptBankSelect id={id} value={value} onChange={onChange}
    bankOptions={bankOptions} disabled={disabled} />;
}
