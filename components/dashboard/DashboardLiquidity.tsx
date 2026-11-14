"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Skeleton } from "@/components/ui/skeleton";
import { formatExactMinorAmount, moneyDisplayLabel } from "@/lib/moneyDisplay";

export function DashboardLiquidity({ orgId }: { orgId: Id<"organizations"> }) {
  const { t, locale } = useLanguage();
  const data = useQuery(api.dashboard.liquidity, { orgId });

  if (data === undefined) return <Skeleton className="h-32 w-full rounded-2xl" />;
  if (data === null) return null;

  const unavailable = t("FigureUnavailable");
  const amount = (minor: number | null, currency: string) => minor === null
    ? unavailable
    : <bdi>{formatExactMinorAmount(minor, currency)} {moneyDisplayLabel(currency, locale)}</bdi>;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className="min-w-0 rounded-2xl border bg-card p-4 text-card-foreground">
        <h2 className="text-sm font-medium text-muted-foreground">{t("DashboardCashOnHand")}</h2>
        {data.cash.length ? (
          <ul className="mt-2 space-y-1 text-2xl font-semibold tabular-nums">
            {data.cash.map((row) => <li key={row.currency}>{amount(row.balanceMinor, row.currency)}</li>)}
          </ul>
        ) : <p className="mt-2">{unavailable}</p>}
      </section>
      <section className="min-w-0 rounded-2xl border bg-card p-4 text-card-foreground">
        <h2 className="text-sm font-medium text-muted-foreground">{t("DashboardBankAccounts")}</h2>
        {data.banks === null ? <p className="mt-2">{unavailable}</p> : data.banks.length ? (
          <ul className="mt-1 divide-y text-sm">
            {data.banks.map((bank) => (
              <li key={bank.id} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2">
                <span className="min-w-0 break-words">
                  {bank.name} <bdi className="text-muted-foreground">{bank.currency}</bdi>
                  {!bank.active && <span className="ms-2 text-muted-foreground">{t("DashboardBankInactive")}</span>}
                </span>
                <span className="font-medium tabular-nums">{amount(bank.balanceMinor, bank.currency)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="mt-2">{t("DashboardNoBankAccounts")}</p>}
      </section>
    </div>
  );
}
