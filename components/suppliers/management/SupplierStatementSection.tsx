"use client";

/**
 * The supplier statement (SCRUM-869 slice 2): what the dealership owes this supplier (A/P) and what
 * the supplier owes the dealership (A/R), as two regions with their own per-currency totals. The
 * server returns no net figure and neither does this screen: the two are never added or subtracted
 * (ADR docs/adr/2026-11-03-supplier-statement-outstanding-query.md, invariants W1 and W7).
 *
 * RTL: logical utilities only; amounts, dates and currency codes sit in `<bdi>` so they keep their
 * order inside an Arabic sentence.
 */
import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { ammanDateString, msUntilAmmanMidnight } from "@/convex/utils/supplierDueDates";
import { usePermissions } from "@/hooks/use-permissions";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Money } from "./SupplierStatementMoney";
import { interpolate } from "@/lib/i18n/interpolate";
import { QueryErrorBoundary, useTranslate, SupplierDaysOverdue, type Translate } from "./shared";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { SupplierRowDetails } from "./SupplierRowDetails";
import { SupplierAttentionSection } from "./SupplierAttentionSection";

export type SupplierStatementData = FunctionReturnType<typeof api.supplierStatement.outstanding>;
type StatementSectionData = SupplierStatementData["payable"];
type StatementRow = StatementSectionData["rows"][number];
type StatementTotal = StatementSectionData["totals"][number];
const NOW_REFRESH_MS = 60 * 60 * 1000;

const KIND_KEY: Record<StatementRow["kind"], string> = {
  PAYABLE: "SuppliersStmtKindPayable",
  RECEIVABLE: "SuppliersStmtKindReceivable",
  RECOVERY: "SuppliersStmtKindRecovery",
};

function RowItem({ row, translate }: Readonly<{ row: StatementRow; translate: Translate }>) {
  const due = row.dueDate ?? translate("SuppliersStmtNoDueDate");
  return (
    <TableRow className="mb-3 block rounded-lg border p-3 sm:mb-0 sm:table-row sm:rounded-none sm:border-x-0 sm:p-0">
      <TableCell className="block p-1 font-medium sm:table-cell sm:p-3">{translate(KIND_KEY[row.kind])}<SupplierRowDetails context={row.context} /></TableCell>
      <TableCell className="block p-1 text-muted-foreground sm:table-cell sm:p-3">
        {translate("SuppliersStmtDue")}: <bdi>{due}</bdi>
        <SupplierDaysOverdue days={row.daysOverdue} badge />
      </TableCell>
      <TableCell className={`block p-1 text-end font-semibold sm:table-cell sm:p-3 ${row.kind === "PAYABLE" ? "text-money-out" : "text-profit-positive"}`}>
        <Money minor={row.outstandingMinor} currency={row.currency} />
        {row.disputedMinor > 0 && (
          <Badge variant="outline" className="ms-2 border-money-out/30 text-money-out">{translate("SuppliersStmtDisputed")}</Badge>
        )}
      </TableCell>
    </TableRow>
  );
}

function Totals({ totals, translate }: Readonly<{ totals: StatementTotal[]; translate: Translate }>) {
  return (
    <dl className="space-y-1 border-t pt-2 text-sm">
      {totals.map((total) => (
        <div key={total.currency} className="flex flex-wrap justify-between gap-x-4">
          <dt className="font-medium">{translate("SuppliersStmtTotal")}</dt>
          <dd className="text-end">
            <Money minor={total.grossMinor} currency={total.currency} />
            {total.overdueMinor > 0 && (
              <span className="ms-2 text-xs text-muted-foreground">
                {translate("SuppliersStmtOverdue")}: <Money minor={total.overdueMinor} currency={total.currency} />
              </span>
            )}
            {total.disputedMinor > 0 && (
              <span className="ms-2 text-xs text-muted-foreground">
                {translate("SuppliersStmtDisputed")}: <Money minor={total.disputedMinor} currency={total.currency} />
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function incompleteKey(reason: "ROW_LIMIT" | "READ_BUDGET" | undefined): string {
  return reason === "READ_BUDGET" ? "SuppliersStmtIncompleteBudget" : "SuppliersStmtIncomplete";
}

function StatementRegion({
  id,
  title,
  emptyKey,
  data,
}: Readonly<{
  id: string;
  title: string;
  emptyKey: string;
  data: StatementSectionData;
}>) {
  const translate = useTranslate();
  return (
    <section aria-labelledby={id} className="min-w-0 space-y-3 rounded-xl border bg-card p-4 shadow-sm">
      <h3 id={id} className="text-base font-semibold">
        {title}
      </h3>
      {data.rows.length === 0 ? (
        // An empty list means "none" only when the whole family was read; a cut section says why in the note below.
        data.complete && <p className="text-sm text-muted-foreground">{translate(emptyKey)}</p>
      ) : (
        <Table><TableHeader className="hidden bg-muted/60 sm:table-header-group"><TableRow>
          <TableHead scope="col">{translate("SuppliersStmtType")}</TableHead>
          <TableHead scope="col">{translate("SuppliersStmtDue")}</TableHead>
          <TableHead scope="col" className="text-end">{translate("SuppliersStmtAmount")}</TableHead>
        </TableRow></TableHeader><TableBody className="block sm:table-row-group">
          {data.rows.map((row) => (
            <RowItem key={`${row.kind}:${row.id}`} row={row} translate={translate} />
          ))}
        </TableBody></Table>
      )}
      {!data.complete && (
        <p role="note" className="text-xs text-money-out">
          {translate(incompleteKey(data.incompleteReason))}
        </p>
      )}
      {!data.complete ? (
        <p className="border-t pt-2 text-sm font-medium">{translate("SuppliersStmtTotalUnavailable")}</p>
      ) : (
        data.totals.length > 0 && <Totals totals={data.totals} translate={translate} />
      )}
    </section>
  );
}

/** The statement itself, free of data fetching so every state can be rendered from plain data. */
export function SupplierStatementView({ statement }: Readonly<{ statement: SupplierStatementData | undefined }>) {
  const translate = useTranslate();
  if (statement === undefined) {
    return (
      <output className="block py-4 text-center text-sm text-muted-foreground">
        {translate("SuppliersStmtLoading")}
        <Skeleton className="mt-3 h-32 w-full rounded-xl" />
      </output>
    );
  }
  return (
    <section aria-labelledby="supplier-statement-title" className="space-y-3">
      <div>
        <h2 id="supplier-statement-title" className="text-lg font-semibold">
          {translate("SuppliersStmtTitle")}
        </h2>
        <p className="text-xs text-muted-foreground">{translate("SuppliersStmtNoNetNote")}</p>
        <p className="text-xs text-muted-foreground">{translate("SuppliersStmtScopeNote")}</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <StatementRegion
          id="supplier-statement-ap"
          title={translate("SuppliersStmtPayableTitle")}
          emptyKey="SuppliersStmtPayableEmpty"
          data={statement.payable}
        />
        <StatementRegion
          id="supplier-statement-ar"
          title={translate("SuppliersStmtReceivableTitle")}
          emptyKey="SuppliersStmtReceivableEmpty"
          data={statement.receivable}
        />
      </div>
    </section>
  );
}

export type SupplierSettledData = FunctionReturnType<typeof api.supplierStatement.settled>;
type SettledSectionData = SupplierSettledData["payable"];
type SettledRowData = SettledSectionData["rows"][number];

function SettledItem({ row, translate }: Readonly<{ row: SettledRowData; translate: Translate }>) {
  // Completion is the server's fact about the obligation. It is not `settledMinor >= dueMinor`: that figure is the cash the
  // supplier moved, which for a margin claim leaves out the customer deposit applied to it.
  const inFull = row.settlement === "COMPLETE";
  const cashBelowClaim = row.settledMinor < row.dueMinor;
  return (
    <TableRow className="mb-3 block rounded-lg border p-3 sm:mb-0 sm:table-row sm:rounded-none sm:border-x-0 sm:p-0">
      <TableCell className="block p-1 sm:table-cell sm:p-3">
      <span className="font-medium">{translate(KIND_KEY[row.kind])}</span>
      <SupplierRowDetails context={row.context} />
      <Badge variant="secondary" className="ms-2">{translate(inFull ? "SuppliersStmtHistorySettled" : "SuppliersStmtHistoryPartly")}</Badge>
      </TableCell>
      <TableCell className="block p-1 text-muted-foreground sm:table-cell sm:p-3">
        {translate("SuppliersStmtHistoryLastChange")}: <bdi>{ammanDateString(row.lastChangedAt)}</bdi>
      </TableCell>
      <TableCell className="block p-1 text-end font-semibold sm:table-cell sm:p-3">
        <Money minor={row.settledMinor} currency={row.currency} />
        {!inFull && (
          <span className="ms-2 text-xs text-muted-foreground">
            {translate("SuppliersStmtHistoryOf")} <Money minor={row.dueMinor} currency={row.currency} />
          </span>
        )}
        {inFull && cashBelowClaim && (
          <span className="ms-2 text-xs text-muted-foreground">
            {translate("SuppliersStmtHistoryClaimTotal")}: <Money minor={row.dueMinor} currency={row.currency} />
          </span>
        )}
      {row.basis === "INFERRED_FROM_PAID_STATUS" && <p className="mt-1 text-xs font-normal text-muted-foreground">{translate("SuppliersStmtHistoryInferred")}</p>}
      </TableCell>
    </TableRow>
  );
}

function SettledRegion({
  id,
  title,
  emptyKey,
  totalKey,
  scopeKey,
  data,
}: Readonly<{ id: string; title: string; emptyKey: string; totalKey: string; scopeKey?: string; data: SettledSectionData }>) {
  const translate = useTranslate();
  return (
    <section aria-labelledby={id} className="min-w-0 space-y-3 rounded-xl border bg-card p-4 shadow-sm">
      <h4 id={id} className="text-base font-semibold">
        {title}
      </h4>
      {data.rows.length === 0 ? (
        // An empty list means "none" only when the whole family was read; a cut section says why in the note below.
        data.complete && <p className="text-sm text-muted-foreground">{translate(emptyKey)}</p>
      ) : (
        <Table><TableHeader className="hidden bg-muted/60 sm:table-header-group"><TableRow>
          <TableHead scope="col">{translate("SuppliersStmtType")}</TableHead>
          <TableHead scope="col">{translate("SuppliersStmtHistoryLastChange")}</TableHead>
          <TableHead scope="col" className="text-end">{translate("SuppliersStmtAmount")}</TableHead>
        </TableRow></TableHeader><TableBody className="block sm:table-row-group">
          {data.rows.map((row) => (
            <SettledItem key={`${row.kind}:${row.id}`} row={row} translate={translate} />
          ))}
        </TableBody></Table>
      )}
      {scopeKey !== undefined && <p className="text-xs text-muted-foreground">{translate(scopeKey)}</p>}
      {data.unverifiedCount > 0 && (
        <p role="note" className="text-xs text-money-out">
          {interpolate(translate("SuppliersStmtHistoryUnverified"), { count: String(data.unverifiedCount) })}
        </p>
      )}
      {!data.complete && (data.unverifiedCount === 0 || data.incompleteReason === "READ_BUDGET") && (
        <p role="note" className="text-xs text-money-out">
          {translate(incompleteKey(data.incompleteReason))}
        </p>
      )}
      {!data.complete ? (
        <p className="border-t pt-2 text-sm font-medium">{translate("SuppliersStmtTotalUnavailable")}</p>
      ) : (
        data.totals.length > 0 && (
          <dl className="space-y-1 border-t pt-2 text-sm">
            {data.totals.map((total) => (
              <div key={total.currency} className="flex flex-wrap justify-between gap-x-4">
                <dt className="font-medium">{translate(totalKey)}</dt>
                <dd className="text-end">
                  <Money minor={total.settledMinor} currency={total.currency} />
                </dd>
              </div>
            ))}
          </dl>
        )
      )}
    </section>
  );
}

/** Settled history (SCRUM-869 slice 4): cash paid and received, in two regions that are never combined. */
export function SupplierSettledView({ settled }: Readonly<{ settled: SupplierSettledData | undefined }>) {
  const translate = useTranslate();
  if (settled === undefined) {
    return (
      <output className="block py-4 text-center text-sm text-muted-foreground">
        {translate("SuppliersStmtLoading")}
      </output>
    );
  }
  return (
    <section aria-labelledby="supplier-settled-title" className="space-y-3">
      <h3 id="supplier-settled-title" className="text-lg font-semibold">
        {translate("SuppliersStmtHistoryTitle")}
      </h3>
      <div className="grid gap-4 lg:grid-cols-2">
        <SettledRegion
          id="supplier-settled-ap"
          title={translate("SuppliersStmtHistoryPaidTitle")}
          emptyKey="SuppliersStmtHistoryPaidEmpty"
          totalKey="SuppliersStmtHistoryTotalPaid"
          data={settled.payable}
        />
        <SettledRegion
          id="supplier-settled-ar"
          title={translate("SuppliersStmtHistoryReceivedTitle")}
          emptyKey="SuppliersStmtHistoryReceivedEmpty"
          totalKey="SuppliersStmtHistoryTotalReceived"
          scopeKey="SuppliersStmtHistoryReceivedScope"
          data={settled.receivable}
        />
      </div>
    </section>
  );
}

export type SupplierReconData = FunctionReturnType<typeof api.supplierStatement.paymentsReconciliation>;

const RECON_REASON_KEY: Record<NonNullable<SupplierReconData["unavailableReason"]>, string> = {
  OVER_LIMIT: "SuppliersStmtReconReasonOverLimit",
  PENDING_POSTINGS: "SuppliersStmtReconReasonPending",
  NO_CONTROL_ACCOUNT: "SuppliersStmtReconReasonNoAccount",
  INCONSISTENT_REFERENCE: "SuppliersStmtReconReasonInconsistent",
};

/** Payments check (SCRUM-869): subledger paid against GL 2400 for this supplier. Never claims the obligation side. */
export function SupplierReconView({ recon }: Readonly<{ recon: SupplierReconData | undefined }>) {
  const translate = useTranslate();
  if (recon === undefined) return null;
  let verdict: string;
  if (recon.status === "UNAVAILABLE") {
    // No reason given reads as the bare "unavailable" line, never as a guessed reason.
    const reason = recon.unavailableReason ? `: ${translate(RECON_REASON_KEY[recon.unavailableReason])}` : "";
    verdict = `${translate("SuppliersStmtReconUnavailable")}${reason}`;
  } else {
    verdict = translate(recon.isReconciled ? "SuppliersStmtReconOk" : "SuppliersStmtReconDiffers");
  }
  return (
    <section aria-labelledby="supplier-recon-title" className="space-y-2">
      <h3 id="supplier-recon-title" className="text-lg font-semibold">
        {translate("SuppliersStmtReconTitle")}
      </h3>
      <output className="block text-sm">
        {verdict}
      </output>
      {recon.status === "AVAILABLE" && (
        <dl className="space-y-1 text-sm">
          {recon.currencies.map((c) => (
            <div key={c.currency} className="flex flex-wrap justify-between gap-x-4">
              <dt className="font-medium">{translate("SuppliersStmtReconSubledger")}</dt>
              <dd>
                <Money minor={c.subledgerPaidMinor} currency={c.currency} />
                {" · "}
                {translate("SuppliersStmtReconLedger")}: <Money minor={c.glPaidMinor} currency={c.currency} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      <p className="text-xs text-muted-foreground">{translate("SuppliersStmtReconCreditNote")}</p>
      {recon.excludedOpeningRows > 0 && (
        <p className="text-xs text-muted-foreground">
          {interpolate(translate("SuppliersStmtReconOpeningNote"), { count: String(recon.excludedOpeningRows) })}
        </p>
      )}
    </section>
  );
}

function StatementBody({ orgId, supplierId }: Readonly<{ orgId: Id<"organizations">; supplierId: Id<"suppliers"> }>) {
  const translate = useTranslate();
  const { dir } = useLanguage();
  const { hasPermission, isLoading } = usePermissions();
  // The server requires the same pair (STATEMENT_PERMISSIONS): the amounts are a SOURCED car's cost (SCRUM-886 / ACC-10).
  const allowed = !isLoading && hasPermission(PERMISSIONS.VIEW_FINANCE) && hasPermission(PERMISSIONS.VIEW_COST_PRICE);
  // The supplier screen is not plan-gated but the statement is (accounting), so ask the plan first: a plan without
  // accounting gets a truthful note instead of the query's "upgrade required" error.
  const subscription = useQuery(api.subscriptions.getMySubscription, allowed ? { orgId } : "skip");
  const accountingIncluded = subscription?.planDetails?.gates?.accounting === true;
  // The server checks `nowMs` against its own clock (24 h window), so a tab left open must not keep
  // the mount-time value: refresh it hourly, which re-subscribes the query with a current window.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        setNowMs(Date.now());
        schedule();
      }, Math.min(NOW_REFRESH_MS, msUntilAmmanMidnight(Date.now())));
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);
  const visible = allowed && accountingIncluded;
  const statement = useQuery(api.supplierStatement.outstanding, visible ? { orgId, supplierId, nowMs } : "skip");
  const settled = useQuery(api.supplierStatement.settled, visible ? { orgId, supplierId } : "skip");
  const recon = useQuery(api.supplierStatement.paymentsReconciliation, visible ? { orgId, supplierId } : "skip");
  if (!allowed) return null;
  if (subscription !== undefined && !accountingIncluded) return <SupplierStatementPlanGate />;
  return (
    <Card dir={dir} className="min-w-0 shadow-sm"><CardHeader className="pb-3"><h2 className="text-lg font-semibold">{translate("SuppliersAccountActivity")}</h2></CardHeader><CardContent>
      <Tabs dir={dir} defaultValue="outstanding">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="outstanding">{translate("SuppliersTabOutstanding")}</TabsTrigger>
          <TabsTrigger value="settled">{translate("SuppliersTabSettled")}</TabsTrigger>
          <TabsTrigger value="payments">{translate("SuppliersTabPayments")}</TabsTrigger>
        </TabsList>
        <TabsContent value="outstanding" className="space-y-6"><SupplierAttentionSection orgId={orgId} supplierId={supplierId} enabled={visible} nowMs={nowMs} /><SupplierStatementView statement={statement} /></TabsContent>
        <TabsContent value="settled"><SupplierSettledView settled={settled} /></TabsContent>
        <TabsContent value="payments">{recon === undefined ? <output className="block py-4">{translate("SuppliersStmtLoading")}<Skeleton className="mt-3 h-24" /></output> : <SupplierReconView recon={recon} />}</TabsContent>
      </Tabs>
    </CardContent></Card>
  );
}

function SupplierStatementPlanGate() {
  const translate = useTranslate();
  return (
    <p role="note" className="py-4 text-center text-sm text-muted-foreground">
      {translate("SuppliersStmtPlanGate")}
    </p>
  );
}

export function SupplierStatementError() {
  const translate = useTranslate();
  return (
    <p role="alert" className="py-4 text-center text-sm text-destructive">
      {translate("SuppliersStmtLoadError")}
    </p>
  );
}

export function SupplierStatementSection(props: Readonly<{ orgId: Id<"organizations">; supplierId: Id<"suppliers"> }>) {
  return (
    <QueryErrorBoundary key={`${props.orgId}:${props.supplierId}`} render={() => <SupplierStatementError />}>
      <StatementBody {...props} />
    </QueryErrorBoundary>
  );
}
