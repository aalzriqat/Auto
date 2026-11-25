"use client";

import { useQuery } from "convex/react";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useMoneyDisplay } from "@/hooks/useMoneyDisplay";

export function CashQuoteReceiptSummary({ orgId, quoteId }: Readonly<{
  orgId: Id<"organizations">;
  quoteId: Id<"quotes">;
}>) {
  const { t, isRtl } = useLanguage();
  const money = useMoneyDisplay();
  const balance = useQuery(api.paymentVouchers.cashQuoteReceiptBalance, { orgId, quoteId });
  if (!balance) return null;

  const figures = [
    ["CashQuoteReceiptTotal", balance.totalMinor],
    ["CashQuoteReceiptReceived", balance.receivedMinor],
    ["CashQuoteReceiptRemaining", balance.remainingMinor],
  ] as const;
  return (
    <dl dir={isRtl ? "rtl" : "ltr"} className="grid gap-3 rounded-md border p-3 text-start sm:grid-cols-3">
      {figures.map(([label, minor]) => (
        <div key={label}>
          <dt className="text-sm text-muted-foreground">{t(label)}</dt>
          <dd className="font-semibold tabular-nums">
            <bdi>{money.format(minor / 10 ** balance.scale, balance.currency, balance.scale)}</bdi>
          </dd>
        </div>
      ))}
    </dl>
  );
}
