"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePermissions } from "@/hooks/use-permissions";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { getCodedErrorMessage } from "@/lib/errors";
import { interpolate } from "@/lib/i18n/interpolate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Money } from "./SupplierStatementMoney";
import { QueryErrorBoundary, useTranslate } from "./shared";

export type AttentionData = FunctionReturnType<typeof api.supplierStatement.attention>;
type Kind = "PAYABLE" | "RECEIVABLE" | "RECOVERY";
type Row = NonNullable<AttentionData>["page"][number];
type Scope = { orgId: Id<"organizations">; supplierId: Id<"suppliers"> };
const KIND_KEY = { PAYABLE: "SuppliersStmtKindPayable", RECEIVABLE: "SuppliersStmtKindReceivable", RECOVERY: "SuppliersStmtKindRecovery" } as const;
const STEP_KEY = { T_MINUS_3: "SuppliersStmtAttnStepT3", DUE_DAY: "SuppliersStmtAttnStepDue", OVERDUE_7: "SuppliersStmtAttnStepOverdue7", OVERDUE_WEEKLY: "SuppliersStmtAttnStepWeekly" } as const;
const HELD_KEY = { DISPUTED: "SuppliersStmtAttnHeldDisputed", NO_DUE_DATE: "SuppliersStmtAttnHeldNoDue" } as const;
const INCOMPLETE_KEY = { READ_BUDGET: "SuppliersStmtAttnBudget", SPLIT_REQUIRED: "SuppliersStmtAttnSplit" } as const;

function AttentionItem({ row }: Readonly<{ row: Row }>) {
  const translate = useTranslate();
  const label = row.status === "ALERTING" ? STEP_KEY[row.step] : HELD_KEY[row.heldReason];
  return <li className="min-w-0 space-y-2 border-b py-3 last:border-0">
    <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
      <Badge variant="outline" className="h-auto max-w-full whitespace-normal text-start">{translate(label)}</Badge>
      <span className={row.kind === "PAYABLE" ? "font-semibold text-money-out" : "font-semibold text-profit-positive"}>
        <Money minor={row.outstandingMinor} currency={row.currency} />
      </span>
    </div>
    <p className="break-words text-xs text-muted-foreground">{translate("SuppliersStmtDue")}: <bdi>{row.dueDate ?? translate("SuppliersStmtNoDueDate")}</bdi>
      {row.daysOverdue !== null && row.daysOverdue > 0 && <span className="ms-2">{interpolate(translate("SuppliersStmtDaysOverdue"), { days: String(row.daysOverdue) })}</span>}
    </p>
    <p className="break-all text-xs text-muted-foreground">{translate("SuppliersStmtAttnRecord")}: <bdi>{row.id}</bdi></p>
  </li>;
}

/** Ported attention labels and amounts. A page is never presented as a full count or total. */
export function SupplierAttentionView({ data, kind, hasPrevious, onNext, onPrevious }: Readonly<{
  data: AttentionData | undefined; kind: Kind; hasPrevious: boolean; onNext: () => void; onPrevious: () => void;
}>) {
  const translate = useTranslate();
  const title = translate(KIND_KEY[kind]);
  const rows = data?.page ?? [];
  return <section aria-label={title} className="min-w-0 space-y-3 rounded-xl border p-4">
    <h4 className="font-semibold">{title}</h4>
    {data === undefined && <output className="block text-sm text-muted-foreground">{translate("SuppliersStmtLoading")}</output>}
    {data === null && <p className="text-sm text-muted-foreground">{translate("SuppliersStmtAttnRestricted")}</p>}
    {data && <>
      <p className="text-xs text-muted-foreground">{translate("SuppliersStmtAttnAsOf")}: <bdi>{data.asOfDate}</bdi></p>
      {rows.length === 0 && data.complete && <p className="text-sm text-muted-foreground">{translate("SuppliersStmtAttnNone")}</p>}
      <ul>{rows.map(row => <AttentionItem key={`${row.kind}:${row.id}`} row={row} />)}</ul>
      {!data.complete && <output className="block text-xs text-money-out">{translate(data.incompleteReason ? INCOMPLETE_KEY[data.incompleteReason] : "SuppliersStmtAttnIncomplete")}</output>}
      {data.unlinked === "PRESENT" && <p role="note" className="text-xs text-money-out">{translate("SuppliersStmtAttnUnlinked")}</p>}
      {data.unlinked === "INCOMPLETE" && <output className="block text-xs text-money-out">{translate("SuppliersStmtAttnUnlinkedIncomplete")}</output>}
    </>}
    <div className="flex flex-wrap gap-2">
      {hasPrevious && <Button size="sm" variant="outline" onClick={onPrevious}>{translate("SuppliersStmtAttnPrevious")}</Button>}
      {data && !data.isDone && !data.incompleteReason && <Button size="sm" variant="outline" onClick={onNext}>{translate("SuppliersStmtAttnNext")}</Button>}
    </div>
  </section>;
}

function AttentionGroup({ orgId, supplierId, kind, nowMs }: Readonly<Scope & { kind: Kind; nowMs: number }>) {
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1) ?? null;
  const data = useQuery(api.supplierStatement.attention, { orgId, supplierId, kind, nowMs, paginationOpts: { numItems: 25, cursor } });
  return <SupplierAttentionView data={data} kind={kind} hasPrevious={cursors.length > 0}
    onPrevious={() => setCursors(previous => previous.slice(0, -1))}
    onNext={() => { if (data && !data.isDone && !data.incompleteReason) setCursors(previous => [...previous, data.continueCursor]); }} />;
}

export function SupplierAttentionError({ error }: Readonly<{ error: unknown }>) {
  const translate = useTranslate();
  return <p role="alert" className="py-3 text-sm text-destructive">{getCodedErrorMessage(error, translate) ?? translate("ServerError_SUPPLIER_ATTENTION_UNAVAILABLE")}</p>;
}

function refreshDelay(nowMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Amman", hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(nowMs);
  const part = (name: string) => Number(parts.find(entry => entry.type === name)?.value ?? 0);
  const elapsed = (part("hour") * 3600 + part("minute") * 60 + part("second")) * 1000 + new Date(nowMs).getMilliseconds();
  return Math.min(3_600_000, Math.max(1, 86_400_000 - elapsed));
}

function AttentionBody(props: Readonly<Scope>) {
  const translate = useTranslate();
  const { dir } = useLanguage();
  const { hasPermission, isLoading } = usePermissions();
  const allowed = !isLoading && hasPermission("view:finance") && hasPermission("view:cost_price");
  const subscription = useQuery(api.subscriptions.getMySubscription, allowed ? { orgId: props.orgId } : "skip");
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    // Refresh at the next Amman day boundary or within one hour, whichever comes first.
    const timer = setTimeout(() => setNowMs(Date.now()), refreshDelay(Date.now()));
    return () => clearTimeout(timer);
  }, [nowMs]);
  if (!allowed) return null;
  if (subscription === undefined) return <output className="block py-3">{translate("SuppliersStmtLoading")}</output>;
  if (subscription?.planDetails?.gates?.accounting !== true) return <p role="note">{translate("SuppliersStmtPlanGate")}</p>;
  const group = (kind: Kind) => <QueryErrorBoundary key={`${props.orgId}:${props.supplierId}:${kind}`} render={error => <SupplierAttentionError error={error} />}>
    <AttentionGroup {...props} kind={kind} nowMs={nowMs} />
  </QueryErrorBoundary>;
  return <Card dir={dir} className="min-w-0 shadow-sm">
    <CardHeader><h2 className="text-lg font-semibold">{translate("SuppliersStmtAttnTitle")}</h2>
      <p className="text-xs text-muted-foreground">{translate("SuppliersStmtAttnEligibility")}</p>
    </CardHeader>
    <CardContent className="grid min-w-0 gap-4 lg:grid-cols-2">
      <section aria-label={translate("SuppliersStmtAttnPayableTitle")} className="min-w-0 space-y-3">
        <h3 className="font-medium">{translate("SuppliersStmtAttnPayableTitle")}</h3>{group("PAYABLE")}
      </section>
      <section aria-label={translate("SuppliersStmtAttnReceivableTitle")} className="min-w-0 space-y-3">
        <h3 className="font-medium">{translate("SuppliersStmtAttnReceivableTitle")}</h3>{group("RECEIVABLE")}{group("RECOVERY")}
      </section>
    </CardContent>
  </Card>;
}

export function SupplierAttentionSection(props: Readonly<Scope>) {
  return <QueryErrorBoundary key={`${props.orgId}:${props.supplierId}`} render={error => <SupplierAttentionError error={error} />}><AttentionBody {...props} /></QueryErrorBoundary>;
}
