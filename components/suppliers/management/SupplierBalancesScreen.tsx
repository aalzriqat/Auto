"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArrowLeft } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { ammanDateString } from "@/convex/utils/supplierDueDates";
import { usePermissions } from "@/hooks/use-permissions";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { formatExactMinorAmount, moneyDisplayLabel } from "@/lib/moneyDisplay";
import { QueryErrorBoundary, supplierHref, useTranslate } from "./shared";

export type SupplierBalancesData = FunctionReturnType<typeof api.supplierBalances.list>;
export type SupplierBalanceData = FunctionReturnType<typeof api.supplierBalances.get>;
type CurrencyBalance = SupplierBalanceData["currencies"][number];

export function SupplierMoney({ minor, currency }: Readonly<{ minor: number; currency: string }>) {
  const { locale } = useLanguage();
  return <bdi className="tabular-nums">{formatExactMinorAmount(minor, currency)} {moneyDisplayLabel(currency, locale === "ar" ? "ar" : "en")}</bdi>;
}

export function SupplierNet({ balance }: Readonly<{ balance: CurrencyBalance }>) {
  const translate = useTranslate();
  const label = balance.netMinor < 0 ? "SuppliersBalancesNetYouOwe" : "SuppliersBalancesNetOwesYou";
  return <span className="inline-flex flex-col items-end gap-1">
    <span>{balance.netMinor > 0 && "+"}<SupplierMoney minor={balance.netMinor} currency={balance.currency} /></span>
    <span className="text-xs text-muted-foreground">{translate(balance.netMinor === 0 ? "SuppliersBalancesNetZero" : label)}</span>
  </span>;
}

/** Only formats server figures. No balances, overdue or net are calculated in the browser. */
export function SupplierBalancesView({ orgId, data }: Readonly<{ orgId: Id<"organizations">; data: SupplierBalancesData | undefined }>) {
  const translate = useTranslate();
  const { locale } = useLanguage();
  if (data === undefined) return <output className="block p-8 text-center text-muted-foreground">{translate("SuppliersLoading")}</output>;
  return <div dir={locale === "ar" ? "rtl" : "ltr"} className="space-y-4">
    {!data.complete && <p role="note" className="rounded-lg border bg-muted p-3 text-sm">{translate("SuppliersBalancesPartial")}</p>}
    {data.page.length === 0 ? <p className="p-8 text-center text-muted-foreground">{translate("SuppliersBalancesEmpty")}</p> : <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <caption className="sr-only">{translate("SuppliersBalances")}</caption>
        <thead className="bg-muted text-muted-foreground"><tr>
          {["SuppliersColName", "SuppliersBalancesYouOwe", "SuppliersBalancesOwesYou", "SuppliersBalancesNet", "SuppliersBalancesOverdue", "SuppliersBalancesOldest", "SuppliersBalancesCurrency"].map(key => <th scope="col" key={key} className="p-3 text-start">{translate(key)}</th>)}
        </tr></thead>
        <tbody>{data.page.map(row => <BalanceRows key={row.supplierId} orgId={orgId} row={row} />)}</tbody>
      </table>
    </div>}
  </div>;
}

function BalanceRows({ orgId, row }: Readonly<{ orgId: Id<"organizations">; row: SupplierBalanceData }>) {
  const translate = useTranslate();
  const name = <Link href={supplierHref(orgId, row.supplierId)} className="font-medium text-primary hover:underline"><bdi>{row.supplier}</bdi></Link>;
  if (!row.complete || row.currencies.length === 0) return <tr className="border-t"><th scope="row" className="p-3 text-start">{name}</th><td colSpan={6} className="p-3 text-muted-foreground">{translate(row.complete ? "SuppliersBalancesZero" : "SuppliersStmtTotalUnavailable")}</td></tr>;
  return row.currencies.map(c => <tr key={c.currency} className="border-t hover:bg-muted/50">
    <th scope="row" className="p-3 text-start">{name}</th>
    <td className="p-3 text-end"><SupplierMoney minor={c.payableMinor} currency={c.currency} /><Disputed minor={c.disputedPayableMinor} currency={c.currency} /></td>
    <td className="p-3 text-end"><SupplierMoney minor={c.receivableMinor} currency={c.currency} /><Disputed minor={c.disputedReceivableMinor} currency={c.currency} /></td>
    <td className="p-3 text-end"><SupplierNet balance={c} /></td>
    <td className="space-y-1 p-3 text-end">
      <div><span className="text-xs text-muted-foreground">{translate("SuppliersBalancesYouOwe")}: </span><SupplierMoney minor={c.overduePayableMinor} currency={c.currency} /></div>
      <div><span className="text-xs text-muted-foreground">{translate("SuppliersBalancesOwesYou")}: </span><SupplierMoney minor={c.overdueReceivableMinor} currency={c.currency} /></div>
    </td>
    <td className="p-3 text-end"><bdi>{c.oldestDueDate ?? translate("SuppliersStmtNoDueDate")}</bdi></td>
    <td className="p-3 text-end"><bdi>{c.currency}</bdi></td>
  </tr>);
}

function Disputed({ minor, currency }: Readonly<{ minor: number; currency: string }>) {
  const translate = useTranslate();
  return minor > 0 && <div className="mt-1 text-xs text-muted-foreground">{translate("SuppliersBalancesDisputed")}: <SupplierMoney minor={minor} currency={currency} /></div>;
}

function BalancesBody({ orgId }: Readonly<{ orgId: Id<"organizations"> }>) {
  const translate = useTranslate();
  const { hasPermission, isLoading } = usePermissions();
  const allowed = !isLoading && hasPermission(PERMISSIONS.VIEW_FINANCE) && hasPermission(PERMISSIONS.VIEW_COST_PRICE);
  const plan = useQuery(api.subscriptions.getMySubscription, allowed ? { orgId } : "skip");
  const included = plan?.planDetails?.gates?.accounting === true;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;
  useEffect(() => { const timer = setInterval(() => setNowMs(Date.now()), 3_600_000); return () => clearInterval(timer); }, []);
  const data = useQuery(api.supplierBalances.list, allowed && included ? { orgId, nowMs, cursor } : "skip");
  if (isLoading) return <SupplierBalancesView orgId={orgId} data={undefined} />;
  if (!allowed) return <p role="note" className="rounded-lg border bg-muted p-4">{translate("SuppliersBalancesWithheld")}</p>;
  if (plan !== undefined && !included) return <p role="note">{translate("SuppliersStmtPlanGate")}</p>;
  return <div className="space-y-4">
    <p className="text-xs text-muted-foreground">{translate("SuppliersBalancesAsOf")}: <bdi>{ammanDateString(nowMs)}</bdi></p>
    <SupplierBalancesView orgId={orgId} data={data} />
    <div className="flex flex-wrap justify-between gap-2">
      <Button variant="outline" disabled={cursors.length === 1 || data === undefined} onClick={() => setCursors(previous => previous.slice(0, -1))}>{translate("SuppliersBalancesPrevious")}</Button>
      <Button variant="outline" disabled={!data || data.isDone} onClick={() => data && setCursors(previous => [...previous, data.continueCursor])}>{translate("SuppliersBalancesNext")}</Button>
    </div>
  </div>;
}

export function SupplierBalancesScreen({ orgId }: Readonly<{ orgId: Id<"organizations"> }>) {
  const translate = useTranslate();
  return <div className="space-y-5 p-4 md:p-6">
    <Button asChild variant="ghost" size="sm"><Link href={`/${orgId}/suppliers`}><ArrowLeft className="rtl:rotate-180" aria-hidden="true" />{translate("SuppliersBack")}</Link></Button>
    <header className="space-y-2"><h1 className="text-2xl font-semibold">{translate("SuppliersBalances")}</h1><p className="text-muted-foreground">{translate("SuppliersBalancesSubtitle")}</p><p className="text-xs text-muted-foreground">{translate("SuppliersBalancesNetNote")}</p><p className="text-xs text-muted-foreground">{translate("SuppliersBalancesScope")}</p></header>
    <QueryErrorBoundary render={() => <p role="alert">{translate("SuppliersStmtLoadError")}</p>}><BalancesBody orgId={orgId} /></QueryErrorBoundary>
  </div>;
}
