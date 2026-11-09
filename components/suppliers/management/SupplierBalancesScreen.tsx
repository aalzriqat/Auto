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
import { Card, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { Money as SupplierMoney } from "./SupplierStatementMoney";
import { QueryErrorBoundary, supplierHref, useTranslate } from "./shared";

export type SupplierBalancesData = FunctionReturnType<typeof api.supplierBalances.list>;
export type SupplierBalanceData = FunctionReturnType<typeof api.supplierBalances.get>;
type CurrencyBalance = SupplierBalanceData["currencies"][number];

export function SupplierNet({ balance }: Readonly<{ balance: CurrencyBalance }>) {
  const translate = useTranslate();
  const label = balance.netMinor < 0 ? "SuppliersBalancesNetYouOwe" : "SuppliersBalancesNetOwesYou";
  return <span className="inline-flex flex-col items-end gap-1">
    <bdi>{balance.netMinor > 0 && "+"}<SupplierMoney minor={balance.netMinor} currency={balance.currency} /></bdi>
    <span className="text-xs text-muted-foreground">{translate(balance.netMinor === 0 ? "SuppliersBalancesNetZero" : label)}</span>
  </span>;
}

/** Only formats server figures. No balances, overdue or net are calculated in the browser. */
export function SupplierBalancesView({ orgId, data }: Readonly<{ orgId: Id<"organizations">; data: SupplierBalancesData | undefined }>) {
  const translate = useTranslate();
  const { locale } = useLanguage();
  if (data === undefined) return <div className="space-y-3"><output className="block p-4 text-center text-muted-foreground">{translate("SuppliersLoading")}</output><Skeleton className="h-40 rounded-xl" /></div>;
  return <div dir={locale === "ar" ? "rtl" : "ltr"} className="space-y-4">
    {!data.complete && <p role="note" className="rounded-lg border bg-muted p-3 text-sm">{translate("SuppliersBalancesPartial")}</p>}
    {data.page.length === 0 ? data.complete && <p className="p-8 text-center text-muted-foreground">{translate("SuppliersBalancesEmpty")}</p> : <div className="min-w-0 rounded-xl border bg-card p-3 shadow-sm md:p-0">
      <Table className="block w-full text-sm md:table">
        <caption className="sr-only">{translate("SuppliersBalances")}</caption>
        <TableHeader className="hidden bg-muted text-muted-foreground md:table-header-group"><TableRow>
          {["SuppliersColName", "SuppliersBalancesYouOwe", "SuppliersBalancesOwesYou", "SuppliersBalancesNet", "SuppliersBalancesOverdue", "SuppliersBalancesOldest", "SuppliersBalancesCurrency"].map((key, i) => <TableHead scope="col" key={key} className={`p-3 ${i === 0 ? "text-start" : "text-end"}`}>{translate(key)}</TableHead>)}
        </TableRow></TableHeader>
        <TableBody className="block space-y-3 md:table-row-group md:space-y-0">{data.page.map(row => <BalanceRows key={row.supplierId} orgId={orgId} row={row} />)}</TableBody>
      </Table>
    </div>}
  </div>;
}

function BalanceRows({ orgId, row }: Readonly<{ orgId: Id<"organizations">; row: SupplierBalanceData }>) {
  const translate = useTranslate();
  const name = <Link href={supplierHref(orgId, row.supplierId)} className="font-medium text-primary hover:underline"><bdi>{row.supplier}</bdi></Link>;
  if (!row.complete || row.currencies.length === 0) return <TableRow className="block rounded-xl border p-3 md:table-row md:rounded-none md:p-0"><TableHead scope="row" className="block p-3 text-start md:table-cell">{name}</TableHead><TableCell colSpan={6} className="block p-3 text-muted-foreground md:table-cell">{translate(row.complete ? "SuppliersBalancesZero" : "SuppliersStmtTotalUnavailable")}</TableCell></TableRow>;
  return row.currencies.map(c => <TableRow key={c.currency} className="block rounded-xl border p-3 hover:bg-muted/50 md:table-row md:rounded-none md:border-x-0 md:p-0">
    <TableHead scope="row" className="block p-3 text-start md:table-cell">{name}</TableHead>
    <BalanceCell label={translate("SuppliersBalancesYouOwe")} className="text-money-out"><div><SupplierMoney minor={c.payableMinor} currency={c.currency} /><Disputed minor={c.disputedPayableMinor} currency={c.currency} /></div></BalanceCell>
    <BalanceCell label={translate("SuppliersBalancesOwesYou")} className="text-profit-positive"><div><SupplierMoney minor={c.receivableMinor} currency={c.currency} /><Disputed minor={c.disputedReceivableMinor} currency={c.currency} /></div></BalanceCell>
    <BalanceCell label={translate("SuppliersBalancesNet")}><SupplierNet balance={c} /></BalanceCell>
    <BalanceCell label={translate("SuppliersBalancesOverdue")}><div className="space-y-1">
      <div><span className="text-xs text-muted-foreground">{translate("SuppliersBalancesYouOwe")}: </span><SupplierMoney minor={c.overduePayableMinor} currency={c.currency} /></div>
      <div><span className="text-xs text-muted-foreground">{translate("SuppliersBalancesOwesYou")}: </span><SupplierMoney minor={c.overdueReceivableMinor} currency={c.currency} /></div>
    </div></BalanceCell>
    <BalanceCell label={translate("SuppliersBalancesOldest")}><bdi>{c.oldestDueDate ?? translate("SuppliersStmtNoDueDate")}</bdi></BalanceCell>
    <BalanceCell label={translate("SuppliersBalancesCurrency")}><bdi>{c.currency}</bdi></BalanceCell>
  </TableRow>);
}

function BalanceCell({ label, className = "", children }: Readonly<{ label: string; className?: string; children: React.ReactNode }>) {
  return <TableCell className={`flex min-w-0 items-start justify-between gap-3 p-3 text-end md:table-cell ${className}`}><span className="text-start text-xs text-muted-foreground md:hidden">{label}</span>{children}</TableCell>;
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
    <Card className="border-t-4 border-t-primary shadow-sm"><CardHeader className="space-y-2"><h1 className="text-2xl font-semibold">{translate("SuppliersBalances")}</h1><p className="text-muted-foreground">{translate("SuppliersBalancesSubtitle")}</p><p className="text-xs text-muted-foreground">{translate("SuppliersBalancesNetNote")}</p><p className="text-xs text-muted-foreground">{translate("SuppliersBalancesScope")}</p></CardHeader></Card>
    <QueryErrorBoundary key={orgId} render={() => <p role="alert">{translate("SuppliersStmtLoadError")}</p>}><BalancesBody orgId={orgId} /></QueryErrorBoundary>
  </div>;
}
