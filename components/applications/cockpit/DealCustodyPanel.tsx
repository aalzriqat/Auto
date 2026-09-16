"use client";

import { useState } from "react";
import { HandCoins, Loader2, Lock, UserRound } from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  CustodyAttachDialog,
  CustodyCloseDialog,
  CustodyMovementDialog,
  CustodyPlanDialog,
  CustodyReasonDialog,
  type CustodyEligibleFee,
  type CustodyCloseValues,
  type CustodyMember,
  type CustodyMovementValues,
} from "./DealCustodyDialogs";

/**
 * عهدة الموظف — cash handed to an employee to pay a deal's handover costs,
 * read AND acted on from the Deal.
 *
 * Every figure here is the canonical `financeDealCustody` record as
 * `listDealCosts` serves it: the totals are projections of the movement log,
 * the balances come from the shared reconciliation engine, and nothing is
 * summed or netted on this side. The movement log itself is served by
 * `listCustodyMovements`, paginated per record, and rendered by whatever the
 * container hands in as `renderMovements` — so the summary read stays bounded
 * and this panel stays free of any query.
 *
 * The money actions POST. Each command clears through the employee custody
 * clearing account (`DEAL_CUSTODY_CLEARING`) and the server refuses outright
 * when the org's ledger cannot take the posting; `wiring.accounting` carries
 * that same predicate so a disabled button says WHY, in the server's words,
 * rather than failing on the round trip. Nothing here is offered when the
 * caller may not move money (`actions` undefined) — the balances stay
 * readable, the commands do not exist.
 */

export type CustodyRecordView = Readonly<{
  _id: Id<"financeDealCustody">;
  userId: Id<"users">;
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
  /**
   * Why `summary` is null, as `listDealCosts` says it: the custody and its
   * costs are not in one currency, or a stored total / linked cost is not a
   * readable figure. Absent on a payload that predates the second reason.
   */
  summaryUnavailable?: Readonly<{ reason: "MIXED_DENOMINATION" | "UNSAFE_AMOUNT" }> | null;
  /**
   * Opened before custody posted to the ledger: its movements are not on the
   * books, so the server refuses every money command on it until the custody
   * cutover. Absent on a payload that predates the flag — treated as not
   * legacy, which is what such a payload's server would also have said.
   */
  legacy?: boolean;
}>;

/** The server's readiness verdict for a custody posting, verbatim. */
export type CustodyAccountingState =
  | Readonly<{ ready: true }>
  | Readonly<{ ready: false; reason: "CHART_NOT_INITIALIZED" | "ACCOUNT_UNMAPPED" | "ACCOUNT_CODE_CONFLICT"; systemKey?: string }>;

export type CustodyPlanView = Readonly<{
  userId: Id<"users">;
  userName: string;
  amountMinor: number | null;
  note: string | null;
}>;

export type CustodyRecommendationView = Readonly<{
  recommendedMinor: number | null;
  reason: "NOT_CONFIGURED" | "NO_EMPLOYEE_PAID_FEES" | "UNSAFE_AMOUNT" | null;
  outstandingCount: number;
}>;

/** One movement row, as the container's list reports it back for a reversal. */
export type CustodyMovementRef = Readonly<{
  entryId: Id<"financeDealCustodyEntries">;
  kind: "ISSUED" | "RETURNED" | "REIMBURSED";
  amountMinor: number;
}>;

/**
 * The commands, present only for a caller who holds the money permission.
 *
 * Every id crossing this boundary is the server's own `Id<...>` — the row
 * ids come off `listDealCosts`, the member ids off `listCustodyCandidates`,
 * the movement ids off `listCustodyMovements` — so the container hands them
 * to the money mutations as they are, with no cast between a string and a
 * document reference (consolidated round, item 4).
 */
export type DealCustodyActions = Readonly<{
  /**
   * Org members the plan or an issuance may name; `undefined` while the
   * candidate read is loading. The plan and issue doors stay shut until it
   * has answered — an empty picker is a dead end, not a choice.
   */
  members: ReadonlyArray<CustodyMember> | undefined;
  /** Live employee-paid lines with an actual, not yet charged to any record. */
  eligibleFees: ReadonlyArray<CustodyEligibleFee>;
  scaleOf: (currency: string) => number;
  onPlan: (values: { userId: Id<"users">; amountMinor?: number; note?: string }) => Promise<void>;
  onClearPlan: () => Promise<void>;
  onOpen: (values: CustodyMovementValues & { userId: Id<"users"> }) => Promise<void>;
  onMove: (custodyId: Id<"financeDealCustody">, kind: "ISSUED" | "RETURNED" | "REIMBURSED", values: CustodyMovementValues) => Promise<void>;
  onReverse: (custodyId: Id<"financeDealCustody">, movement: CustodyMovementRef, reason: string) => Promise<void>;
  onAttach: (custodyId: Id<"financeDealCustody">, feeId: Id<"financeDealFees">) => Promise<void>;
  onClose: (custodyId: Id<"financeDealCustody">, values: CustodyCloseValues) => Promise<void>;
  onReopen: (custodyId: Id<"financeDealCustody">, reason: string) => Promise<void>;
  /**
   * The operator closed an issue / movement / closure dialog without its
   * command succeeding (R8). The container retires the attempt's identity so
   * it cannot be reused by a later, genuine command with the same figures —
   * a lost response replayed under a key it never minted reports a second
   * success for cash that moved once. Same lifecycle as `onAbandonAdd` on
   * the handover costs.
   */
  onAbandonOpen: (intentId: string) => void;
  onAbandonMove: (custodyId: Id<"financeDealCustody">, kind: "ISSUED" | "RETURNED" | "REIMBURSED", intentId: string) => void;
  onAbandonClose: (custodyId: Id<"financeDealCustody">, intentId: string) => void;
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
  renderMovements: (custodyId: Id<"financeDealCustody">, onReverse?: (movement: CustodyMovementRef) => void) => React.ReactNode;
  /** Absent on a payload that predates the money actions — treated as "not stated". */
  accounting?: CustodyAccountingState;
  plannedCustody?: CustodyPlanView | null;
  /** The caller's tier may not read the plan: say so, never "nobody assigned". */
  plannedCustodyWithheld?: boolean;
  recommended?: CustodyRecommendationView | null;
  /** Whether an accounting period covers today; false means postings queue. */
  openPeriodToday?: boolean;
  /** The deal is finalized, closed or stopped: nothing NEW is planned or issued on it; existing custody still settles. */
  dealStopped?: boolean;
  actions?: DealCustodyActions;
}>;

const STATUS_KEY: Record<CustodyRecordView["status"], string> = {
  OPEN: "CustodyStatusOpen",
  RECONCILED: "CustodyStatusReconciled",
  WRITTEN_OFF: "CustodyStatusWrittenOff",
};

type T = (key: string) => string;
type Formatter = (minor: number, currency: string) => string;

/** What a button asks to open. The commands that carry identity get theirs when the dialog opens. */
type DialogRequest =
  | { kind: "PLAN" }
  | { kind: "OPEN" }
  | { kind: "MOVE"; custodyId: Id<"financeDealCustody">; movement: "ISSUED" | "RETURNED" | "REIMBURSED" }
  | { kind: "ATTACH"; custodyId: Id<"financeDealCustody"> }
  | { kind: "CLOSE"; custodyId: Id<"financeDealCustody"> }
  | { kind: "REOPEN"; custodyId: Id<"financeDealCustody"> }
  | { kind: "REVERSE"; custodyId: Id<"financeDealCustody">; movement: CustodyMovementRef };

/**
 * The open dialog. An issue, movement or closure is an ATTEMPT with its own
 * `intentId`, minted once when it opened (R8): every submit while it stays
 * open is the same command, and the container's key is derived from the
 * attempt, never from the figures — so a lost response replays, a corrected
 * figure is refused by the server's fingerprint, and a dialog opened again
 * later for the same figures is a new command.
 */
type DialogState =
  | { kind: "PLAN" }
  | { kind: "OPEN"; intentId: string }
  | { kind: "MOVE"; custodyId: Id<"financeDealCustody">; movement: "ISSUED" | "RETURNED" | "REIMBURSED"; intentId: string }
  | { kind: "ATTACH"; custodyId: Id<"financeDealCustody"> }
  | { kind: "CLOSE"; custodyId: Id<"financeDealCustody">; intentId: string }
  | { kind: "REOPEN"; custodyId: Id<"financeDealCustody"> }
  | { kind: "REVERSE"; custodyId: Id<"financeDealCustody">; movement: CustodyMovementRef }
  | null;

/** The server's readiness reason, in the operator's language. */
export function accountingBlockMessage(state: CustodyAccountingState | undefined, t: T): string | null {
  if (!state || state.ready) return null;
  const withAccount = (key: string) => t(key).replaceAll("{account}", state.systemKey ?? "");
  switch (state.reason) {
    case "CHART_NOT_INITIALIZED":
      return t("CustodyAccountingChartNotInitialized");
    case "ACCOUNT_UNMAPPED":
      return withAccount("CustodyAccountingAccountUnmapped");
    case "ACCOUNT_CODE_CONFLICT":
      return withAccount("CustodyAccountingCodeConflict");
    default:
      return null;
  }
}

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

/**
 * The one line the operator reads first: who holds what, right now. Signed by
 * the engine, never here — a positive balance is cash in the employee's
 * pocket, an outstanding reimbursement is a debt the dealership owes them.
 */
function Position({ s, m, t }: Readonly<{ s: NonNullable<CustodyRecordView["summary"]>; m: (minor: number) => string; t: T }>) {
  if (s.settled) {
    return (
      <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400" data-testid="custody-balanced">
        {t("CustodyBalanced")}
      </p>
    );
  }
  const holds = s.employeeOwesDealerMinor > 0;
  const owed = s.reimbursementOutstandingMinor > 0;
  return (
    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm" data-testid="custody-position">
      {holds && (
        <span>
          <span className="text-muted-foreground">{t("CustodyPositionHolds")} </span>
          <bdi dir="ltr" className="text-base font-semibold tabular-nums">{m(s.employeeOwesDealerMinor)}</bdi>
        </span>
      )}
      {owed && (
        <span className="text-amber-700 dark:text-amber-400">
          <span>{t("CustodyPositionOwed")} </span>
          <bdi dir="ltr" className="text-base font-semibold tabular-nums">{m(s.reimbursementOutstandingMinor)}</bdi>
        </span>
      )}
    </p>
  );
}

function CustodyRecord({
  record,
  money,
  renderMovements,
  canAct,
  canStart,
  blocked,
  hasEligibleFees,
  openDialog,
  t,
}: Readonly<{
  record: CustodyRecordView;
  money: Formatter;
  renderMovements: DealCustodyWiring["renderMovements"];
  /** The caller holds the money permission. */
  canAct: boolean;
  /** ...and the deal still takes NEW cash (not finalized or stopped). */
  canStart: boolean;
  /** The ledger cannot take a posting right now — actions render disabled. */
  blocked: boolean;
  hasEligibleFees: boolean;
  openDialog: (request: DialogRequest) => void;
  t: T;
}>) {
  const [showMovements, setShowMovements] = useState(false);
  const cur = record.currency;
  const m = (minor: number) => money(minor, cur);
  const s = record.summary;
  const open = record.status === "OPEN";
  const id = record._id;
  const act = canAct && !blocked;

  return (
    <article className="space-y-3" data-testid={`custody-record-${record._id}`}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-medium">
          <UserRound className="h-4 w-4 text-muted-foreground" aria-hidden />
          <bdi>{record.userName || t("CustodyHandlerNone")}</bdi>
        </p>
        <Badge variant="outline">{t(STATUS_KEY[record.status])}</Badge>
      </header>

      {s === null ? (
        // No money paints at all — not the stored totals either, since a
        // corrupt one is exactly what withheld the balance.
        <p
          className="text-sm text-amber-700 dark:text-amber-400"
          data-testid={`custody-summary-unavailable-${record.summaryUnavailable?.reason ?? "MIXED_DENOMINATION"}`}
        >
          {t(record.summaryUnavailable?.reason === "UNSAFE_AMOUNT" ? "CustodySummaryUnreadable" : "CustodySummaryUnavailable")}
        </p>
      ) : (
        <>
          <Position s={s} m={m} t={t} />
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
          </dl>
        </>
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

      {record.legacy && (
        <p className="text-xs text-amber-700 dark:text-amber-400" data-testid={`custody-legacy-${id}`}>
          {t("CustodyLegacyNote")}
        </p>
      )}
      {canAct && !record.legacy && (
        <div className="flex flex-wrap gap-2" data-testid={`custody-actions-${id}`}>
          {open ? (
            <>
              {/* New cash, so it goes with the deal's own door — withheld once
                  the deal is finalized or stopped, exactly like the head's
                  issuance; settling below stays. */}
              {canStart && (
                <Button type="button" size="sm" variant="outline" disabled={!act} onClick={() => openDialog({ kind: "MOVE", custodyId: id, movement: "ISSUED" })}>
                  {t("CustodyIssueMore")}
                </Button>
              )}
              <Button type="button" size="sm" variant="outline" disabled={!act || record.issuedMinor <= record.returnedMinor} onClick={() => openDialog({ kind: "MOVE", custodyId: id, movement: "RETURNED" })}>
                {t("CustodyRecordReturn")}
              </Button>
              {s !== null && s.reimbursementOutstandingMinor > 0 && (
                <Button type="button" size="sm" variant="outline" disabled={!act} onClick={() => openDialog({ kind: "MOVE", custodyId: id, movement: "REIMBURSED" })}>
                  {t("CustodyReimburse")}
                </Button>
              )}
              {/* Moving a cost onto the record re-posts the deal's economics,
                  which `setFeeCustody` refuses once the deal is finalized or
                  stopped — so the door is withheld with the other
                  posting-bearing edits, while settling stays. */}
              {canStart && (
                <Button type="button" size="sm" variant="outline" disabled={!act || !hasEligibleFees} onClick={() => openDialog({ kind: "ATTACH", custodyId: id })} data-testid={`custody-attach-${id}`}>
                  {t("CustodyAttachCost")}
                </Button>
              )}
              <Button type="button" size="sm" disabled={!act || s === null} onClick={() => openDialog({ kind: "CLOSE", custodyId: id })}>
                {t("CustodyClose")}
              </Button>
            </>
          ) : (
            <Button type="button" size="sm" variant="outline" disabled={!act} onClick={() => openDialog({ kind: "REOPEN", custodyId: id })}>
              {t("CustodyReopen")}
            </Button>
          )}
        </div>
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
        {showMovements &&
          renderMovements(
            record._id,
            act && open && !record.legacy ? (movement) => openDialog({ kind: "REVERSE", custodyId: id, movement }) : undefined
          )}
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
  const { records, loading, actions } = wiring;
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blockMessage = accountingBlockMessage(wiring.accounting, t);
  const blocked = blockMessage !== null;
  // The money permission governs every command; a stopped or finalized deal
  // additionally takes NEW cash and a new plan off the table while settling
  // what an employee already holds (return, reimburse, reverse, close,
  // reopen) stays possible — the server draws the same line.
  const canAct = actions !== undefined;
  const canStart = canAct && !wiring.dealStopped;
  // Naming a person needs the candidate list; until it has answered, the
  // plan and issue doors are shut and say so, rather than opening onto an
  // empty picker (consolidated round, item 5).
  const membersLoading = canStart && actions?.members === undefined;
  const openRecord = records?.find((row) => row.status === "OPEN");
  const plan = wiring.plannedCustody ?? null;
  const recommended = wiring.recommended ?? null;
  const cur = wiring.currency;

  const openDialog = (request: DialogRequest) => {
    setError(null);
    setDialog(
      request.kind === "OPEN" || request.kind === "MOVE" || request.kind === "CLOSE"
        ? { ...request, intentId: crypto.randomUUID() }
        : request
    );
  };
  /**
   * The operator closed the dialog (Cancel, Escape, the overlay, the X) with
   * its command not having succeeded — success closes it through `run`
   * below. An attempt that carries identity hands it back so the container
   * retires it. A mounted dialog in flight is not closable by any route it
   * exposes: the dialogs refuse every close while `busy` (`busyCloseGuard`),
   * and this refuses too, so an in-flight attempt can never be retired by
   * the operator — its identity must survive for the retry of a lost
   * response (R9). An UNMOUNT (route change) is not a close: nothing here
   * runs and the identity dies with the tree — see `busyCloseGuard`.
   */
  const dismiss = () => {
    if (busy) return;
    if (dialog && actions) {
      if (dialog.kind === "OPEN") actions.onAbandonOpen(dialog.intentId);
      else if (dialog.kind === "MOVE") actions.onAbandonMove(dialog.custodyId, dialog.movement, dialog.intentId);
      else if (dialog.kind === "CLOSE") actions.onAbandonClose(dialog.custodyId, dialog.intentId);
    }
    setDialog(null);
  };
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      setDialog(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const recordFor = (custodyId: Id<"financeDealCustody">) => records?.find((row) => row._id === custodyId);
  const scale = (currency: string) => actions?.scaleOf(currency) ?? 3;
  // Who an ISSUANCE may name: everyone served except the operator issuing
  // it — the server refuses self-issuance, so the picker never offers it.
  // The plan keeps the whole list; a plan moves no money and may name anyone.
  const recipients = (actions?.members ?? []).filter((member) => !member.isActor);
  const plannedRecipient = plan && recipients.some((member) => member.userId === plan.userId) ? plan.userId : undefined;
  // The list has answered and offers nobody the server would accept — the
  // operator is the only member, say — so the issue door is shut with the
  // reason rather than opening onto an empty picker (follow-up audit, 4).
  // The plan door stays open: a plan moves no money and may name the operator.
  const noRecipient = canStart && actions?.members !== undefined && recipients.length === 0;

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
            {/* Why the money buttons are dead, in the server's own words —
                above everything, because it governs every action below. */}
            {blocked && canAct && (
              <p
                role="status"
                className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-800 dark:text-amber-300"
                data-testid="custody-accounting-blocked"
              >
                {blockMessage}
              </p>
            )}
            {!blocked && canAct && wiring.openPeriodToday === false && (
              <p className="text-xs text-muted-foreground" data-testid="custody-period-queued">
                {t("CustodyQueuedNote")}
              </p>
            )}

            {/* The handler and the money they will need: the plan, before any
                cash moves. `openRecord` supersedes it — once cash is out, the
                record is the fact and the plan is history. */}
            <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-dashed px-3 py-2" data-testid="custody-handler">
              <div className="min-w-0 space-y-1 text-sm">
                <p className="text-xs text-muted-foreground">{t("CustodyHandler")}</p>
                {openRecord ? (
                  <p className="font-medium">
                    <bdi>{openRecord.userName || t("CustodyHandlerNone")}</bdi>{" "}
                    <span className="text-xs font-normal text-muted-foreground">· {t("CustodyHandlerHolding")}</span>
                  </p>
                ) : wiring.plannedCustodyWithheld ? (
                  <p className="flex items-center gap-1.5 text-muted-foreground" data-testid="custody-plan-withheld">
                    <Lock className="h-3.5 w-3.5" aria-hidden />
                    {t("CustodyPlanWithheld")}
                  </p>
                ) : plan ? (
                  <p className="font-medium" data-testid="custody-planned">
                    <bdi>{plan.userName || t("CustodyHandlerNone")}</bdi>{" "}
                    <span className="text-xs font-normal text-muted-foreground">· {t("CustodyHandlerPlanned")}</span>
                    {plan.amountMinor !== null && (
                      <>
                        {" · "}
                        <bdi dir="ltr" className="tabular-nums">{money(plan.amountMinor, cur)}</bdi>
                      </>
                    )}
                  </p>
                ) : (
                  <p className="text-muted-foreground" data-testid="custody-unplanned">{t("CustodyHandlerNone")}</p>
                )}
                {recommended && (
                  <p className="text-xs text-muted-foreground" data-testid="custody-recommended">
                    {recommended.recommendedMinor !== null ? (
                      <>
                        {t("CustodyRecommended")}:{" "}
                        <bdi dir="ltr" className="font-medium tabular-nums text-foreground">{money(recommended.recommendedMinor, cur)}</bdi>{" "}
                        <span>({recommended.outstandingCount} · {t("CustodyRecommendedNote")})</span>
                      </>
                    ) : recommended.reason === "NOT_CONFIGURED" ? (
                      t("CustodyRecommendedNotConfigured")
                    ) : recommended.reason === "NO_EMPLOYEE_PAID_FEES" ? (
                      t("CustodyRecommendedNoEmployeeFees")
                    ) : (
                      t("CustodyRecommendedUnreadable")
                    )}
                  </p>
                )}
              </div>
              {canStart && !openRecord && (
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button type="button" size="sm" variant="outline" disabled={membersLoading} onClick={() => openDialog({ kind: "PLAN" })} data-testid="custody-plan-button">
                    {membersLoading && <Loader2 className="h-4 w-4 animate-spin me-1.5" aria-hidden />}
                    {t(plan ? "CustodyChangeHandler" : "CustodyAssignHandler")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={blocked || membersLoading || noRecipient}
                    aria-describedby={noRecipient ? "custody-no-recipient" : undefined}
                    onClick={() => openDialog({ kind: "OPEN" })}
                    data-testid="custody-issue-button"
                  >
                    <HandCoins className="h-4 w-4 me-1.5" aria-hidden />
                    {t("CustodyIssueCash")}
                  </Button>
                </div>
              )}
            </div>
            {noRecipient && !openRecord && (
              <p id="custody-no-recipient" className="text-xs text-muted-foreground" data-testid="custody-no-recipient">
                {t("CustodyNoRecipient")}
              </p>
            )}

            {/* The finance company's configured fee total for the DEAL — once,
                at panel level. A policy figure with no assignment to any
                person; the recommendation above is the employee-paid slice. */}
            {wiring.expectedTotalMinor !== null && (
              <div
                className="flex items-baseline justify-between gap-4 px-3 text-sm"
                data-testid="custody-expected"
              >
                <span className="min-w-0 text-muted-foreground">
                  {t("CustodyExpected")}
                  <span className="block text-xs">{t("CustodyExpectedNote")}</span>
                </span>
                <bdi dir="ltr" className="shrink-0 whitespace-nowrap font-medium tabular-nums">
                  {money(wiring.expectedTotalMinor, cur)}
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
                  canAct={canAct}
                  canStart={canStart}
                  blocked={blocked}
                  hasEligibleFees={(actions?.eligibleFees.length ?? 0) > 0}
                  openDialog={openDialog}
                  t={t}
                />
              </div>
            ))}
            {wiring.truncated && (
              <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="custody-truncated">
                {t("CustodyTruncated")}
              </p>
            )}
            <p className="text-xs text-muted-foreground" data-testid="custody-posted-note">
              {actions === undefined ? t("CustodyNoPermission") : t("CustodyPostedNote")}
            </p>
          </>
        )}
      </CardContent>

      {actions && (
        <>
          <CustodyPlanDialog
            open={dialog?.kind === "PLAN"}
            members={actions.members ?? []}
            currency={cur}
            scale={scale(cur)}
            current={plan}
            busy={busy}
            error={error}
            t={t}
            onOpenChange={(o) => !o && setDialog(null)}
            onSubmit={(values) => run(() => actions.onPlan(values))}
            onClear={() => run(() => actions.onClearPlan())}
          />
          <CustodyMovementDialog
            open={dialog?.kind === "OPEN"}
            intentId={dialog?.kind === "OPEN" ? dialog.intentId : ""}
            kind="ISSUED"
            currency={cur}
            scale={scale(cur)}
            busy={busy}
            error={error}
            members={recipients}
            defaultUserId={plannedRecipient}
            suggestedMinor={plan?.amountMinor ?? recommended?.recommendedMinor ?? null}
            money={money}
            t={t}
            onOpenChange={(o) => !o && dismiss()}
            onSubmit={(values) => {
              // The dialog only submits with a served member resolved; a
              // value without one never reaches the money command.
              const userId = values.userId;
              if (userId !== undefined) void run(() => actions.onOpen({ ...values, userId }));
            }}
          />
          {dialog?.kind === "MOVE" && (() => {
            const record = recordFor(dialog.custodyId);
            const s = record?.summary ?? null;
            const maxMinor =
              dialog.movement === "RETURNED" && record
                ? record.issuedMinor - record.returnedMinor
                : dialog.movement === "REIMBURSED" && s
                  ? s.reimbursementOutstandingMinor
                  : undefined;
            return (
              <CustodyMovementDialog
                open
                intentId={dialog.intentId}
                kind={dialog.movement}
                currency={record?.currency ?? cur}
                scale={scale(record?.currency ?? cur)}
                busy={busy}
                error={error}
                suggestedMinor={dialog.movement === "REIMBURSED" ? maxMinor ?? null : dialog.movement === "RETURNED" ? (s?.employeeOwesDealerMinor ?? null) : null}
                maxMinor={maxMinor}
                money={money}
                t={t}
                onOpenChange={(o) => !o && dismiss()}
                onSubmit={(values) => run(() => actions.onMove(dialog.custodyId, dialog.movement, values))}
              />
            );
          })()}
          {dialog?.kind === "ATTACH" && (
            <CustodyAttachDialog
              open
              fees={actions.eligibleFees}
              busy={busy}
              error={error}
              money={money}
              t={t}
              onOpenChange={(o) => !o && setDialog(null)}
              onSubmit={(feeId) => run(() => actions.onAttach(dialog.custodyId, feeId))}
            />
          )}
          {dialog?.kind === "CLOSE" && (() => {
            const record = recordFor(dialog.custodyId);
            return (
              <CustodyCloseDialog
                open
                intentId={dialog.intentId}
                settled={record?.summary?.settled ?? false}
                employeeOwesMinor={record?.summary?.employeeOwesDealerMinor ?? 0}
                currency={record?.currency ?? cur}
                busy={busy}
                error={error}
                money={money}
                t={t}
                onOpenChange={(o) => !o && dismiss()}
                onSubmit={(values) => run(() => actions.onClose(dialog.custodyId, values))}
              />
            );
          })()}
          {dialog?.kind === "REOPEN" && (
            <CustodyReasonDialog
              open
              variant="REOPEN"
              busy={busy}
              error={error}
              t={t}
              onOpenChange={(o) => !o && setDialog(null)}
              onSubmit={(reason) => run(() => actions.onReopen(dialog.custodyId, reason))}
            />
          )}
          {dialog?.kind === "REVERSE" && (
            <CustodyReasonDialog
              open
              variant="REVERSE"
              detail={`${t({ ISSUED: "CustodyKindIssued", RETURNED: "CustodyKindReturned", REIMBURSED: "CustodyKindReimbursed" }[dialog.movement.kind])} · ${money(dialog.movement.amountMinor, recordFor(dialog.custodyId)?.currency ?? cur)}`}
              busy={busy}
              error={error}
              t={t}
              onOpenChange={(o) => !o && setDialog(null)}
              onSubmit={(reason) => run(() => actions.onReverse(dialog.custodyId, dialog.movement, reason))}
            />
          )}
        </>
      )}
    </Card>
  );
}
