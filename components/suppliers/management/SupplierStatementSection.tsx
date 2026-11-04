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
import { ammanDateString } from "@/convex/utils/supplierDueDates";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { usePermissions } from "@/hooks/use-permissions";
import { formatExactMinorAmount, moneyDisplayLabel } from "@/lib/moneyDisplay";
import { interpolate } from "@/lib/i18n/interpolate";
import { QueryErrorBoundary, useTranslate, type Translate } from "./shared";

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

function Money({ minor, currency }: Readonly<{ minor: number; currency: string }>) {
  const { locale } = useLanguage();
  return (
    <bdi>
      {formatExactMinorAmount(minor, currency)} {moneyDisplayLabel(currency, locale === "ar" ? "ar" : "en")}
    </bdi>
  );
}

function RowItem({ row, translate }: Readonly<{ row: StatementRow; translate: Translate }>) {
  const due = row.dueDate ?? translate("SuppliersStmtNoDueDate");
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-sm">
      <span className="font-medium">{translate(KIND_KEY[row.kind])}</span>
      <span className="text-muted-foreground">
        {translate("SuppliersStmtDue")}: <bdi>{due}</bdi>
        {row.daysOverdue !== null && row.daysOverdue > 0 && (
          <>
            {" "}
            ·{" "}
            {interpolate(translate("SuppliersStmtDaysOverdue"), {
              days: String(row.daysOverdue),
            })}
          </>
        )}
      </span>
      <span className="text-end">
        <Money minor={row.outstandingMinor} currency={row.currency} />
        {row.disputedMinor > 0 && (
          <span className="ms-2 text-xs text-amber-700 dark:text-amber-300">{translate("SuppliersStmtDisputed")}</span>
        )}
      </span>
    </li>
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
    <section aria-labelledby={id} className="space-y-2 rounded-lg border p-4">
      <h3 id={id} className="text-base font-semibold">
        {title}
      </h3>
      {data.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{translate(emptyKey)}</p>
      ) : (
        <ul className="divide-y">
          {data.rows.map((row) => (
            <RowItem key={`${row.kind}:${row.id}`} row={row} translate={translate} />
          ))}
        </ul>
      )}
      {!data.complete && (
        <p role="note" className="text-xs text-amber-700 dark:text-amber-300">
          {translate("SuppliersStmtIncomplete")}
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
      <p role="status" className="py-4 text-center text-sm text-muted-foreground">
        {translate("SuppliersStmtLoading")}
      </p>
    );
  }
  return (
    <section aria-labelledby="supplier-statement-title" className="space-y-3">
      <div>
        <h2 id="supplier-statement-title" className="text-lg font-semibold">
          {translate("SuppliersStmtTitle")}
        </h2>
        <p className="text-xs text-muted-foreground">{translate("SuppliersStmtNoNetNote")}</p>
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
  const inFull = row.settledMinor >= row.dueMinor;
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-sm">
      <span className="font-medium">{translate(KIND_KEY[row.kind])}</span>
      <span className="text-muted-foreground">
        <span>{translate(inFull ? "SuppliersStmtHistorySettled" : "SuppliersStmtHistoryPartly")}</span> ·{" "}
        {translate("SuppliersStmtHistoryLastChange")}: <bdi>{ammanDateString(row.lastChangedAt)}</bdi>
      </span>
      <span className="text-end">
        <Money minor={row.settledMinor} currency={row.currency} />
        {!inFull && (
          <span className="ms-2 text-xs text-muted-foreground">
            {translate("SuppliersStmtHistoryOf")} <Money minor={row.dueMinor} currency={row.currency} />
          </span>
        )}
      </span>
    </li>
  );
}

function SettledRegion({
  id,
  title,
  emptyKey,
  totalKey,
  data,
}: Readonly<{ id: string; title: string; emptyKey: string; totalKey: string; data: SettledSectionData }>) {
  const translate = useTranslate();
  return (
    <section aria-labelledby={id} className="space-y-2 rounded-lg border p-4">
      <h4 id={id} className="text-base font-semibold">
        {title}
      </h4>
      {data.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{translate(emptyKey)}</p>
      ) : (
        <ul className="divide-y">
          {data.rows.map((row) => (
            <SettledItem key={`${row.kind}:${row.id}`} row={row} translate={translate} />
          ))}
        </ul>
      )}
      {!data.complete && (
        <p role="note" className="text-xs text-amber-700 dark:text-amber-300">
          {translate("SuppliersStmtIncomplete")}
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
      <p role="status" className="py-4 text-center text-sm text-muted-foreground">
        {translate("SuppliersStmtLoading")}
      </p>
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
          data={settled.receivable}
        />
      </div>
    </section>
  );
}

function StatementBody({ orgId, supplierId }: Readonly<{ orgId: Id<"organizations">; supplierId: Id<"suppliers"> }>) {
  const { hasPermission, isLoading } = usePermissions();
  const allowed = !isLoading && hasPermission(PERMISSIONS.VIEW_FINANCE);
  // The server checks `nowMs` against its own clock (24 h window), so a tab left open must not keep
  // the mount-time value: refresh it hourly, which re-subscribes the query with a current window.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), NOW_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  const statement = useQuery(api.supplierStatement.outstanding, allowed ? { orgId, supplierId, nowMs } : "skip");
  const settled = useQuery(api.supplierStatement.settled, allowed ? { orgId, supplierId } : "skip");
  if (!allowed) return null;
  return (
    <div className="space-y-6">
      <SupplierStatementView statement={statement} />
      {statement !== undefined && <SupplierSettledView settled={settled} />}
    </div>
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
    <QueryErrorBoundary render={() => <SupplierStatementError />}>
      <StatementBody {...props} />
    </QueryErrorBoundary>
  );
}
