"use client";

import { useState } from "react";
import { Loader2, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

/**
 * عهدة الموظف — cash handed to an employee to pay a deal's handover costs,
 * READ on the Deal.
 *
 * Every figure here is the canonical `financeDealCustody` record as
 * `listDealCosts` serves it: the totals are projections of the movement log,
 * the balances come from the shared reconciliation engine, and nothing is
 * summed or netted on this side. The movement log itself is served by
 * `listCustodyMovements`, paginated per record, and rendered by whatever the
 * container hands in as `renderMovements` — so the summary read stays bounded
 * and this panel stays free of any query.
 *
 * ⚠️ DELIBERATELY READ-ONLY. The custody commands exist server-side
 * (`openDealCustody`, `recordCustodyMovement`, `reconcileDealCustody`,
 * `reopenDealCustody`) and are tested, but that module is explicitly
 * OFF-LEDGER: an issuance, a return, a reimbursement or a write-off posts no
 * cashbook or GL journal, and no reversal/cancellation/offboarding path
 * inspects a custody balance. Offering those as money actions from the deal
 * screen would present un-posted cash movements as accounted-for events. The
 * controls arrive with the canonical posting — until then the state is shown
 * honestly and nothing here writes.
 */

export type CustodyRecordView = Readonly<{
  _id: string;
  userId: string;
  userName: string;
  currency: string;
  status: "OPEN" | "RECONCILED" | "WRITTEN_OFF";
  issuedMinor: number;
  returnedMinor: number;
  reimbursedMinor: number;
  reconciliationNotes?: string;
  writeOffReason?: string;
  summary: Readonly<{
    actualExpensesMinor: number;
    employeeOwesDealerMinor: number;
    reimbursementOutstandingMinor: number;
    reimbursementOverpaidMinor: number;
    overReturnedMinor: number;
    settled: boolean;
  }> | null;
}>;

export type DealCustodyWiring = Readonly<{
  /** `undefined` while loading or when the caller may not read the cost rows. */
  records: ReadonlyArray<CustodyRecordView> | undefined;
  loading: boolean;
  /** More records exist than the bounded read hydrated — the list is a prefix. */
  truncated: boolean;
  /** The finance company's configured fee total for this deal, or null when none is configured. */
  expectedTotalMinor: number | null;
  /** The deal's denomination, for the expected total. */
  currency: string;
  /** Renders one record's paginated movement log; the container owns the query. */
  renderMovements: (custodyId: string) => React.ReactNode;
}>;

const STATUS_KEY: Record<CustodyRecordView["status"], string> = {
  OPEN: "CustodyStatusOpen",
  RECONCILED: "CustodyStatusReconciled",
  WRITTEN_OFF: "CustodyStatusWrittenOff",
};

type T = (key: string) => string;
type Formatter = (minor: number, currency: string) => string;

function BalanceRow({
  label,
  value,
  tone,
  testId,
}: Readonly<{ label: string; value: string; tone?: "warn"; testId?: string }>) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5" data-testid={testId}>
      <dt className="min-w-0 text-muted-foreground">{label}</dt>
      <dd className={`shrink-0 whitespace-nowrap ${tone === "warn" ? "font-medium text-amber-700 dark:text-amber-400" : ""}`}>
        <bdi dir="ltr" className="tabular-nums">
          {value}
        </bdi>
      </dd>
    </div>
  );
}

function CustodyRecord({
  record,
  money,
  renderMovements,
  t,
}: Readonly<{
  record: CustodyRecordView;
  money: Formatter;
  renderMovements: DealCustodyWiring["renderMovements"];
  t: T;
}>) {
  const [showMovements, setShowMovements] = useState(false);
  const cur = record.currency;
  const m = (minor: number) => money(minor, cur);
  const s = record.summary;
  const open = record.status === "OPEN";

  return (
    <article className="space-y-3" data-testid={`custody-record-${record._id}`}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          <bdi>{record.userName}</bdi>
        </p>
        <Badge variant="outline">{t(STATUS_KEY[record.status])}</Badge>
      </header>

      {s === null ? (
        <p className="text-sm text-muted-foreground">{t("CustodySummaryUnavailable")}</p>
      ) : (
        <dl className="divide-y divide-border text-sm">
          <BalanceRow label={t("CustodyIssued")} value={m(record.issuedMinor)} testId="custody-issued" />
          <BalanceRow label={t("CustodyExpensesPaid")} value={m(s.actualExpensesMinor)} testId="custody-expenses" />
          <BalanceRow label={t("CustodyReturned")} value={m(record.returnedMinor)} testId="custody-returned" />
          <BalanceRow label={t("CustodyReimbursed")} value={m(record.reimbursedMinor)} testId="custody-reimbursed" />
          {s.employeeOwesDealerMinor > 0 && (
            <BalanceRow label={t("CustodyEmployeeOwes")} value={m(s.employeeOwesDealerMinor)} tone="warn" testId="custody-employee-owes" />
          )}
          {s.reimbursementOutstandingMinor > 0 && (
            <BalanceRow label={t("CustodyDealershipOwes")} value={m(s.reimbursementOutstandingMinor)} tone="warn" testId="custody-dealership-owes" />
          )}
          {s.reimbursementOverpaidMinor > 0 && (
            <BalanceRow label={t("CustodyOverpaid")} value={m(s.reimbursementOverpaidMinor)} tone="warn" testId="custody-overpaid" />
          )}
          {s.overReturnedMinor > 0 && (
            <BalanceRow label={t("CustodyOverReturned")} value={m(s.overReturnedMinor)} tone="warn" testId="custody-over-returned" />
          )}
          {s.settled && open && (
            <div className="py-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-400" data-testid="custody-balanced">
              {t("CustodyBalanced")}
            </div>
          )}
        </dl>
      )}

      {!open && (record.reconciliationNotes || record.writeOffReason) && (
        <p className="text-xs text-muted-foreground">
          <bdi>{record.reconciliationNotes}</bdi>
          {record.writeOffReason && (
            <>
              {" · "}
              <bdi>{record.writeOffReason}</bdi>
            </>
          )}
        </p>
      )}

      <div className="space-y-1">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 px-2"
          aria-expanded={showMovements}
          onClick={() => setShowMovements((v) => !v)}
        >
          {t(showMovements ? "CustodyHideMovements" : "CustodyShowMovements")}
        </Button>
        {showMovements && renderMovements(record._id)}
      </div>
    </article>
  );
}

export function DealCustodyPanel({
  wiring,
  money,
  t,
}: Readonly<{
  wiring: DealCustodyWiring;
  money: Formatter;
  t: T;
}>) {
  const { records, loading } = wiring;

  return (
    <Card data-testid="deal-custody">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t("CustodyHeading")}</CardTitle>
        <p className="text-xs text-muted-foreground">{t("CustodyNote")}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {t("Loading")}
          </p>
        ) : records === undefined ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Lock className="h-4 w-4" aria-hidden />
            {t("MoneyPanelHidden")}
          </p>
        ) : (
          <>
            {/* The finance company's configured fee total for the DEAL — once,
                at panel level. It is a policy figure with no assignment to any
                person: nothing here says how much any one employee should be
                handed, because no such allocation exists on record. */}
            {wiring.expectedTotalMinor !== null && (
              <div
                className="flex items-baseline justify-between gap-4 rounded-md border border-dashed px-3 py-2 text-sm"
                data-testid="custody-expected"
              >
                <span className="min-w-0 text-muted-foreground">
                  {t("CustodyExpected")}
                  <span className="block text-xs">{t("CustodyExpectedNote")}</span>
                </span>
                <bdi dir="ltr" className="shrink-0 whitespace-nowrap font-medium tabular-nums">
                  {money(wiring.expectedTotalMinor, wiring.currency)}
                </bdi>
              </div>
            )}
            {records.length === 0 && <p className="text-sm text-muted-foreground">{t("CustodyNone")}</p>}
            {records.map((record, index) => (
              <div key={record._id}>
                {index > 0 && <Separator className="mb-4" />}
                <CustodyRecord
                  record={record}
                  money={money}
                  renderMovements={wiring.renderMovements}
                  t={t}
                />
              </div>
            ))}
            {wiring.truncated && (
              <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="custody-truncated">
                {t("CustodyTruncated")}
              </p>
            )}
            <p className="text-xs text-muted-foreground" data-testid="custody-read-only">
              {t("CustodyReadOnlyNote")}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
