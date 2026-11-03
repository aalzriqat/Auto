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
import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { usePermissions } from "@/hooks/use-permissions";
import { formatExactMinorAmount, moneyDisplayLabel } from "@/lib/moneyDisplay";
import { interpolate } from "@/lib/i18n/interpolate";
import { QueryErrorBoundary, useTranslate, type Translate } from "./shared";

interface StatementRow {
  kind: "PAYABLE" | "RECEIVABLE" | "RECOVERY";
  id: string;
  currency: string;
  outstandingMinor: number;
  disputedMinor: number;
  dueDate: string | null;
  daysOverdue: number | null;
  bucket: string;
}
interface StatementTotal {
  currency: string;
  grossMinor: number;
  disputedMinor: number;
  overdueMinor: number;
}
interface StatementSectionData {
  rows: StatementRow[];
  totals: StatementTotal[];
  complete: boolean;
}

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
          <> · {interpolate(translate("SuppliersStmtDaysOverdue"), { days: String(row.daysOverdue) })}</>
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
}: Readonly<{ id: string; title: string; emptyKey: string; data: StatementSectionData }>) {
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
      {data.totals.length > 0 && <Totals totals={data.totals} translate={translate} />}
    </section>
  );
}

function StatementBody({ orgId, supplierId }: Readonly<{ orgId: Id<"organizations">; supplierId: Id<"suppliers"> }>) {
  const translate = useTranslate();
  const { hasPermission, isLoading } = usePermissions();
  const allowed = !isLoading && hasPermission(PERMISSIONS.VIEW_FINANCE);
  // Fixed at mount: the server checks it against its own clock and a new day is a new mount.
  const [nowMs] = useState(() => Date.now());
  const statement = useQuery(api.supplierStatement.outstanding, allowed ? { orgId, supplierId, nowMs } : "skip");

  if (!allowed) return null;
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
          data={statement.payable as StatementSectionData}
        />
        <StatementRegion
          id="supplier-statement-ar"
          title={translate("SuppliersStmtReceivableTitle")}
          emptyKey="SuppliersStmtReceivableEmpty"
          data={statement.receivable as StatementSectionData}
        />
      </div>
    </section>
  );
}

export function SupplierStatementSection(props: Readonly<{ orgId: Id<"organizations">; supplierId: Id<"suppliers"> }>) {
  const translate = useTranslate();
  return (
    <QueryErrorBoundary
      render={() => (
        <p role="alert" className="py-4 text-center text-sm text-destructive">
          {translate("SuppliersStmtLoadError")}
        </p>
      )}
    >
      <StatementBody {...props} />
    </QueryErrorBoundary>
  );
}
