"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { FunctionReturnType } from "convex/server";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Skeleton } from "@/components/ui/skeleton";
import { formatExactMinorAmount, moneyDisplayLabel } from "@/lib/moneyDisplay";

const BANK_PAGE_SIZE = 12;
type DashboardBank = FunctionReturnType<typeof api.dashboardLiquidity.bankInventory>["page"][number];

function DashboardBankRows({ orgId, asOf, banks, verifiedBalances, inactiveLabel, amount }: {
  orgId: Id<"organizations">;
  asOf: number;
  banks: DashboardBank[];
  verifiedBalances: ReadonlyMap<Id<"bankAccounts">, number>;
  inactiveLabel: string;
  amount: (minor: number | null, currency: string) => ReactNode;
}) {
  const bankIds = banks.filter(bank => !verifiedBalances.has(bank.id)).map(bank => bank.id);
  const extraBalances = useQuery(api.dashboardLiquidity.bankBalancesForPage,
    bankIds.length ? { orgId, asOf, bankIds } : "skip");
  const balancesById = new Map(extraBalances?.map(bank => [bank.id, bank.balanceMinor]));
  return banks.map(bank => (
    <li key={bank.id} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2">
      <span className="min-w-0 break-words">
        {bank.name} <bdi className="text-muted-foreground">{bank.currency}</bdi>
        {!bank.active && <span className="ms-2 text-muted-foreground">{inactiveLabel}</span>}
      </span>
      <span className="font-medium tabular-nums">
        {!verifiedBalances.has(bank.id) && extraBalances === undefined
          ? <Skeleton className="h-4 w-16" />
          : amount(verifiedBalances.get(bank.id) ?? balancesById.get(bank.id) ?? null, bank.currency)}
      </span>
    </li>
  ));
}

export function DashboardLiquidity({ orgId }: { orgId: Id<"organizations"> }) {
  const { t, locale } = useLanguage();
  const [asOf, setAsOf] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setAsOf(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);
  const banks = usePaginatedQuery(api.dashboardLiquidity.bankInventory, { orgId }, { initialNumItems: BANK_PAGE_SIZE });
  const data = useQuery(api.dashboardLiquidity.liquidity, { orgId, asOf });

  if (data === undefined) return <Skeleton className="h-32 w-full rounded-2xl" />;
  if (data === null) return null;

  const byBank = new Map(data.banks?.map((bank) => [bank.id, bank.balanceMinor]));
  const bankPages = Array.from({ length: Math.ceil(banks.results.length / BANK_PAGE_SIZE) }, (_, index) => {
    const start = index * BANK_PAGE_SIZE;
    return banks.results.slice(start, start + BANK_PAGE_SIZE);
  });
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
        {banks.status === "LoadingFirstPage" ? <Skeleton className="mt-2 h-12 w-full" /> : banks.results.length ? (
          <ul className="mt-1 divide-y text-sm">
            {bankPages.map(page => (
              <DashboardBankRows key={page[0].id} orgId={orgId} asOf={asOf} banks={page}
                verifiedBalances={byBank} inactiveLabel={t("DashboardBankInactive")} amount={amount} />
            ))}
          </ul>
        ) : banks.status === "Exhausted" && <p className="mt-2">{t("DashboardNoBankAccounts")}</p>}
        {(banks.status === "CanLoadMore" || banks.status === "LoadingMore") && (
          <button type="button" className="mt-2 text-sm font-medium underline" disabled={banks.status === "LoadingMore"}
            onClick={() => banks.loadMore(BANK_PAGE_SIZE)}>{t("DashboardLoadMoreBanks")}</button>
        )}
      </section>
    </div>
  );
}
