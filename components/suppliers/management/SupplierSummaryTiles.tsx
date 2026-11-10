"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { ArrowDownLeft, ArrowUpRight, Scale, Clock, type LucideIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { usePermissions } from "@/hooks/use-permissions";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryErrorBoundary, useTranslate } from "./shared";
import { SupplierNet, type SupplierBalanceData } from "./SupplierBalancesScreen";
import { Money as SupplierMoney } from "./SupplierStatementMoney";

function Tile({ label, icon: Icon, className, children }: Readonly<{ label: string; icon: LucideIcon; className: string; children: ReactNode }>) {
  return <Card className="min-w-0 shadow-sm"><CardContent className="space-y-3 p-4">
    <div className="flex items-center justify-between gap-2"><span className="text-xs font-medium text-muted-foreground">{label}</span><Icon size={18} className={className} aria-hidden="true" /></div>
    <div className={`space-y-2 text-end font-semibold tabular-nums ${className}`}>{children}</div>
  </CardContent></Card>;
}

export function SupplierSummaryTilesView({ balance }: Readonly<{ balance: SupplierBalanceData | undefined }>) {
  const translate = useTranslate();
  if (!balance) return <output className="block space-y-2"><span className="sr-only">{translate("SuppliersStmtLoading")}</span><div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0,1,2,3].map(i => <Skeleton key={i} className="h-28 rounded-xl" />)}</div></output>;
  const unavailable = !balance.complete;
  const currencyAmounts = (side: "payableMinor" | "receivableMinor") => balance.currencies.map(c => <div key={c.currency}><SupplierMoney minor={c[side]} currency={c.currency} /></div>);
  const fallback = <span className="text-sm text-muted-foreground">{translate(unavailable ? "SuppliersStmtTotalUnavailable" : "SuppliersBalancesZero")}</span>;
  const noFigures = unavailable || balance.currencies.length === 0;
  return <section aria-label={translate("SuppliersBalances")} className="space-y-3">
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Tile label={translate("SuppliersBalancesYouOwe")} icon={ArrowUpRight} className="text-money-out">{noFigures ? fallback : currencyAmounts("payableMinor")}</Tile>
      <Tile label={translate("SuppliersBalancesOwesYou")} icon={ArrowDownLeft} className="text-profit-positive">{noFigures ? fallback : currencyAmounts("receivableMinor")}</Tile>
      <Tile label={translate("SuppliersBalancesNet")} icon={Scale} className="text-foreground">{noFigures ? fallback : balance.currencies.map(c => <div key={c.currency}><SupplierNet balance={c} /></div>)}</Tile>
      <Tile label={translate("SuppliersBalancesOverdue")} icon={Clock} className="text-money-out">{noFigures ? fallback : balance.currencies.map(c => <div key={c.currency} className="space-y-1 text-sm">
        <div><span className="text-xs font-normal text-muted-foreground">{translate("SuppliersBalancesYouOwe")}: </span><SupplierMoney minor={c.overduePayableMinor} currency={c.currency} /></div>
        <div><span className="text-xs font-normal text-muted-foreground">{translate("SuppliersBalancesOwesYou")}: </span><SupplierMoney minor={c.overdueReceivableMinor} currency={c.currency} /></div>
      </div>)}</Tile>
    </div>
    <p className="text-xs text-muted-foreground">{translate("SuppliersBalancesNetNote")}</p>
  </section>;
}

function TilesBody({ orgId, supplierId }: Readonly<{ orgId: Id<"organizations">; supplierId: Id<"suppliers"> }>) {
  const translate = useTranslate();
  const { hasPermission, isLoading } = usePermissions();
  const allowed = !isLoading && hasPermission(PERMISSIONS.VIEW_FINANCE) && hasPermission(PERMISSIONS.VIEW_COST_PRICE);
  const subscription = useQuery(api.subscriptions.getMySubscription, allowed ? { orgId } : "skip");
  const included = subscription?.planDetails?.gates?.accounting === true;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNowMs(Date.now()), 3_600_000); return () => clearInterval(timer); }, []);
  const balance = useQuery(api.supplierBalances.get, allowed && included ? { orgId, supplierId, nowMs } : "skip");
  // The statement below owns the plan message. Do not add a second plan refusal.
  if (!allowed || (subscription !== undefined && !included)) return null;
  return <div className="space-y-2"><SupplierSummaryTilesView balance={balance} /><p className="text-xs text-muted-foreground">{translate("SuppliersBalancesScope")}</p></div>;
}

export function SupplierSummaryTiles(props: Readonly<{ orgId: Id<"organizations">; supplierId: Id<"suppliers"> }>) {
  const translate = useTranslate();
  return <QueryErrorBoundary render={() => <p role="alert" className="rounded-lg border border-destructive/30 p-4 text-destructive">{translate("SuppliersStmtLoadError")}</p>}><TilesBody {...props} /></QueryErrorBoundary>;
}
