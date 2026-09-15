"use client";

import { useState } from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { dateInputToUtcMs, todayDateInput } from "@/lib/dateInput";
import type { Doc } from "@/convex/_generated/dataModel";

/** The fee-type union the server validates — the row carries it as such, so no cast is needed to send it back. */
export type ServedFeeType = Doc<"financeDealFees">["feeType"];

/**
 * رسوم ومصاريف تسليم السيارة — the costs of handing THIS car to THIS customer,
 * managed on the Deal (owner requirement, SCRUM-215 c19384).
 *
 * Everything here is the canonical `financeDealCosts` record, read through
 * `listDealCosts` and written through four commands — nothing is a vehicle
 * expense, nothing is a second ledger:
 *
 *   RECORD → `recordTemplateFeeActual` (the ACTUAL for a fee the finance
 *                                     company's frozen policy configures;
 *                                     every other field is copied server-side
 *                                     from the deal's rule snapshot)
 *   ADD    → `recordDealFee`         (an ADDITIONAL, unplanned cost — actual
 *                                     only; retained command identity, the
 *                                     form's own intent, minted when it opens)
 *   EDIT   → `recordActualFeeAmount` (the ACTUAL figure, its date and its
 *                                     receipt reference; the estimate on the
 *                                     line is preserved beside it)
 *   REMOVE → `voidDealFee`           (audited void with a reason; the record
 *                                     and its figures survive as VOID)
 *
 * Every write names the currency its integer was counted in (SCRUM-319):
 * ADD sends the deal's server-served denomination as it was when the form
 * OPENED, captured with the intent and replayed unchanged on a retry; EDIT
 * sends the LINE's stored currency. The server proves each against its own
 * record and refuses a mismatch with nothing committed — the form is never
 * reinterpreted against whatever the settings say later.
 *
 * What the section deliberately does NOT claim: a line's amount being
 * recorded is not the same as it being paid or reconciled — the server derives
 * one status per line and it is shown as such; totals keep estimated and
 * actual strictly apart, exactly as `summarizeFees` returns them; nothing is
 * summed here. Costs of buying, importing, preparing or repairing the car are
 * not offered — the add form is restricted to the handover fee types.
 *
 * Every write can be refused server-side (a voided line, a closed custody
 * record, a reconciled figure without the permission to withdraw it); the
 * refusal is shown in the form that attempted it.
 */

/** The fee types that are costs of the HANDOVER, and nothing else. */
export const HANDOVER_FEE_TYPES = [
  "OWNERSHIP_TRANSFER",
  "LICENSING",
  "STAMPS",
  "LIEN_REGISTRATION",
  "INSPECTION",
  "INSURANCE",
  "OTHER_CLOSING_EXPENSE",
] as const;
export type HandoverFeeType = (typeof HANDOVER_FEE_TYPES)[number];

/**
 * The accounting treatment the server REQUIRES to be stated (it refuses to
 * infer one). Offered pre-selected per type, and visible, so a different one
 * can be chosen deliberately.
 */
export const HANDOVER_TREATMENTS = [
  "OWNERSHIP_TRANSFER_EXPENSE",
  "SELLING_EXPENSE",
  "INSURANCE_EXPENSE",
  "CUSTOMER_RECEIVABLE",
] as const;
export type HandoverTreatment = (typeof HANDOVER_TREATMENTS)[number];

export const HANDOVER_PAYEES = ["GOVERNMENT", "INSURER", "OTHER"] as const;
export type HandoverPayee = (typeof HANDOVER_PAYEES)[number];

export function defaultTreatmentFor(feeType: HandoverFeeType): HandoverTreatment {
  switch (feeType) {
    case "OWNERSHIP_TRANSFER":
    case "LIEN_REGISTRATION":
      return "OWNERSHIP_TRANSFER_EXPENSE";
    case "INSURANCE":
      return "INSURANCE_EXPENSE";
    default:
      return "SELLING_EXPENSE";
  }
}

export const FEE_TYPE_LABEL: Record<string, string> = {
  FINANCE_COMPANY_FEE: "FeeTypeFinanceCompany",
  APPRAISAL_FEE: "FeeTypeAppraisal",
  INSURANCE: "FeeTypeInsurance",
  STAMPS: "FeeTypeStamps",
  LICENSING: "FeeTypeLicensing",
  OWNERSHIP_TRANSFER: "FeeTypeOwnershipTransfer",
  LIEN_REGISTRATION: "FeeTypeLienRegistration",
  LIEN_RELEASE: "FeeTypeLienRelease",
  INSPECTION: "FeeTypeInspection",
  ADMINISTRATIVE_FEE: "FeeTypeAdministrative",
  COMMISSION: "FeeTypeCommission",
  OTHER_CLOSING_EXPENSE: "FeeTypeOtherClosing",
};

const TREATMENT_LABEL: Record<HandoverTreatment, string> = {
  OWNERSHIP_TRANSFER_EXPENSE: "TreatmentOwnershipTransferExpense",
  SELLING_EXPENSE: "TreatmentSellingExpense",
  INSURANCE_EXPENSE: "TreatmentInsuranceExpense",
  CUSTOMER_RECEIVABLE: "TreatmentCustomerReceivable",
};

const PAYEE_LABEL: Record<HandoverPayee, string> = {
  GOVERNMENT: "PayeeGovernment",
  INSURER: "PayeeInsurer",
  OTHER: "PayeeOther",
};

const STATUS_LABEL: Record<string, string> = {
  UNQUANTIFIED: "CostStatusUnquantified",
  ESTIMATED_ONLY: "CostStatusEstimated",
  ACTUAL_RECORDED: "CostStatusActual",
  RECONCILED: "CostStatusReconciled",
  VOID: "CostStatusVoid",
};

/** One cost line as `listDealCosts` serves it, with the server-derived status. */
export type HandoverCostLine = {
  _id: string;
  feeType: string;
  /**
   * The denomination the row was RECORDED in. Every figure on the line is
   * spelled in this, never in the deal's current denomination. Since
   * SCRUM-319 the first cost fixes the deal's currency and the org lock
   * counts these rows, so a live deal's lines agree with it; a line that
   * does not is a legacy/raw-edited record and is shown as such.
   */
  currency: string;
  description?: string;
  estimatedAmountMinor?: number;
  actualAmountMinor?: number;
  paidBy: string;
  paidTo: string;
  status: string;
  paidAt?: number;
  receiptReference?: string;
};

export type HandoverCostsSummary = {
  lineCount: number;
  estimatedTotalMinor: number;
  actualTotalMinor: number;
  linesAwaitingActual: number;
  linesAwaitingReconciliation: number;
};

/**
 * Why the server withheld the totals. `listDealCosts` serves `summary: null`
 * together with this whenever the lines do not all share the deal's currency
 * — a sum across denominations is not a number, so none is served, and this
 * section says why instead of showing one. `UNSAFE_AMOUNT` is the other way a
 * total is not a number: a line carrying an amount nobody can read.
 */
export type HandoverCostsSummaryUnavailable = {
  reason: "MIXED_DENOMINATION" | "UNSAFE_AMOUNT";
  dealCurrency: string;
  lineCurrencies: ReadonlyArray<string>;
};

/**
 * One fee the finance company's FROZEN policy configures, as `listDealCosts`
 * derives it from the application's own rule snapshot (owner product
 * correction, #scrum-215 2026-09-12 21:05). Read-only: the expectation is the
 * company's, never typed here, and `actual` is EXACTLY the line
 * `recordTemplateFeeActual` wrote against this position — nothing is matched
 * by name.
 */
export type ExpectedHandoverRow = {
  templateIndex: number;
  feeType: ServedFeeType;
  description: string | undefined;
  expectedAmountMinor: number;
  /** Another configured fee shares this one's type and description. */
  duplicateIdentity: boolean;
  actual: {
    feeId: string;
    actualAmountMinor: number | undefined;
    currency: string;
    status: string;
  } | null;
};

export type HandoverExpectedCosts = {
  source: "COMPANY_RULE_SNAPSHOT" | "NO_SNAPSHOT" | "NO_TEMPLATES";
  currency: string;
  rows: ReadonlyArray<ExpectedHandoverRow>;
  /** Sum of the configured expectations; null when nothing is configured. */
  expectedTotalMinor: number | null;
  /** Recorded actuals over every live line; null over mixed denomination. */
  actualTotalMinor: number | null;
  /** expected − actual — a comparison, never an amount still payable. */
  differenceMinor: number | null;
  /** Live lines outside the checklist: unplanned costs and position-less template lines. */
  unplannedLineIds: ReadonlyArray<string>;
  /**
   * Whether "not configured" is the whole story. Served by the same read that
   * serves the checklist: the frozen snapshot is NEVER read live, but the
   * screen says when the company has since configured fees an owner may
   * adopt onto a deal that has not yet been costed. Absent on older payloads.
   */
  adoption?: HandoverFeeAdoption;
};

export type HandoverFeeAdoption = {
  state:
    | "NOT_NEEDED"
    | "AVAILABLE"
    | "COMPANY_HAS_NO_TEMPLATES"
    | "NO_COMPANY_SNAPSHOT"
    | "COMPANY_INACTIVE"
    | "BLOCKED_COSTS_RECORDED"
    | "BLOCKED_DEAL_PROGRESSED";
  liveTemplateCount: number;
  liveRuleVersion: number | null;
  adopted: { at: number; fromRuleVersion: number } | null;
};


export type HandoverCostsData = {
  lines: ReadonlyArray<HandoverCostLine>;
  /** Null exactly when `summaryUnavailable` says why. Never a plausible number over mixed rows. */
  summary: HandoverCostsSummary | null;
  summaryUnavailable: HandoverCostsSummaryUnavailable | null;
  /** The policy checklist. Absent on a payload that predates it; the section then renders lines only. */
  expected?: HandoverExpectedCosts | null;
};

/**
 * The denomination a NEW line is recorded in, as `listDealCosts` SERVES it:
 * the deal's pin when there is one, else the org's verified currency, which
 * the first cost then fixes (the org lock refuses to move it once an
 * application, cost or custody row exists — SCRUM-319). An early cost on an
 * unpinned deal is therefore server-safe in this currency; the add form
 * captures it when it opens and sends it with every attempt.
 */
export type HandoverCostsDenomination = { code: string };

export type NewHandoverCost = {
  /**
   * Names THIS attempt's intent — minted once when the add form opened, so the
   * container's retained command identity survives a retry of the same form
   * and a later, genuinely new line is a new command.
   */
  intentId: string;
  /** The denomination the amount was counted in — captured with the intent, not re-read at submit. */
  currency: string;
  feeType: HandoverFeeType;
  description: string | undefined;
  /**
   * Always undefined from this form. An ADDITIONAL cost is what was actually
   * paid; expectations come from the finance company's policy and are never
   * authored here. Kept in the shape so the container's payload and its
   * retry fingerprint are unchanged for older intents.
   */
  estimatedAmountMinor: undefined;
  actualAmountMinor: number;
  paidTo: HandoverPayee;
  accountingTreatment: HandoverTreatment;
  paidAt: number | undefined;
  receiptReference: string | undefined;
};

export type ActualHandoverCost = {
  actualAmountMinor: number;
  paidAt: number | undefined;
  receiptReference: string | undefined;
  /** The line's own denomination the amount was scaled at — for the audit trail. */
  currency: string;
};

/**
 * What an ADD attempt's failure tells the operator. A REFUSED attempt is the
 * server's own answer (a `ConvexError`): it was thrown inside the mutation,
 * so nothing was committed. UNKNOWN is everything else — the response was
 * lost, and the cost may or may not have been recorded. The container
 * classifies; this section only ever repeats what it was told.
 */
export class HandoverCostAttemptError extends Error {
  readonly outcome: "REFUSED" | "UNKNOWN";
  constructor(message: string, outcome: "REFUSED" | "UNKNOWN") {
    super(message);
    this.name = "HandoverCostAttemptError";
    this.outcome = outcome;
  }
}

/**
 * One ADD intent: minted by the PANEL when the form opens, with the deal's
 * served denomination captured at that moment (SCRUM-319). The form renders
 * it; it does not own it — so hiding the form (Cancel, switching to another
 * line, a loading flicker) cannot lose it.
 */
type AddIntent = { intentId: string; currency: string; scale: number };

/**
 * What has happened to an intent that has gone out at least once. Owned by
 * the panel, keyed by intentId, so a late result is matched to THE attempt
 * it belongs to and never to whatever form happens to be open by then.
 *   SUBMITTING — in flight: nothing may dismiss or replace it;
 *   REFUSED    — the server's own answer (ConvexError), nothing committed;
 *   UNKNOWN    — the response was lost; the cost may already be recorded.
 * `values` is the exact payload that went out; a retry replays it verbatim
 * under the same intent (same idempotency key), never a re-parse of the form.
 */
type AddAttempt = {
  intent: AddIntent;
  values: NewHandoverCost;
  status: "SUBMITTING" | "REFUSED" | "UNKNOWN";
  message: string | null;
};

function isHandoverType(feeType: string): feeType is HandoverFeeType {
  return (HANDOVER_FEE_TYPES as ReadonlyArray<string>).includes(feeType);
}

/** Majors typed by the operator → minor units at the deal's scale, or null when not a positive amount. */
function parseMajor(value: string, scale: number): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const major = Number(trimmed);
  if (!Number.isFinite(major) || major < 0) return null;
  return Math.round(major * Math.pow(10, scale));
}

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

export function HandoverCostsPanel({
  costs,
  loading,
  denomination,
  scaleOf,
  money,
  canManage,
  dealClosed,
  t,
  onAdd,
  onAbandonAdd,
  onRecordActual,
  onVoid,
  onRecordTemplateActual,
  onAbandonTemplateActual,
  onAdoptCompanyFees,
}: Readonly<{
  /** `undefined` while loading or when this caller may not read the cost rows. */
  costs: HandoverCostsData | undefined;
  /**
   * Whether `costs` being undefined means "not yet" rather than "not for you".
   * The two are different sentences; saying "not readable with your
   * permissions" to an authorised caller for the first render is a lie.
   */
  loading: boolean;
  denomination: HandoverCostsDenomination;
  /** Minor-unit scale of a denomination code. */
  scaleOf: (currency: string) => number;
  /** Spells a minor amount IN THE GIVEN currency. */
  money: (minor: number, currency: string) => string;
  /** `create:finance_application` — the permission RECORD, ADD, EDIT and REMOVE all check. */
  canManage: boolean;
  /** Informational only; the server decides what a closed deal still accepts. */
  dealClosed: boolean;
  t: (key: string) => string;
  onAdd: (values: NewHandoverCost) => Promise<void>;
  /** The operator cancelled a form that had already attempted once: its intent is over. */
  onAbandonAdd: (intentId: string) => void;
  onRecordActual: (feeId: string, values: ActualHandoverCost) => Promise<void>;
  onVoid: (feeId: string, reason: string) => Promise<void>;
  /**
   * Records the ACTUAL for a configured fee, by its position in the deal's
   * frozen snapshot. Every other field is the server's. Absent when the
   * container predates the checklist; the rows then render without an action.
   *
   * Rejects with `HandoverCostAttemptError` so the form can tell a REFUSED
   * attempt (the server's answer, nothing committed) from an UNKNOWN one (the
   * response was lost; the line may exist).
   */
  onRecordTemplateActual?: (row: ExpectedHandoverRow, values: ActualHandoverCost) => Promise<void>;
  /**
   * The operator closed a configured row's form after an attempt whose result
   * never arrived: that recording's retained identity is over. Safe by the
   * server's one-live-line-per-position rule — a later attempt under a NEW
   * identity is either the first to land, or refused because the lost one did.
   */
  onAbandonTemplateActual?: (row: ExpectedHandoverRow) => void;
  /**
   * Adopts the company's configured fees onto a deal frozen without any —
   * owner-only, audited, refused by the server outside the AVAILABLE state.
   * Absent for a caller who may not, so the notice renders without an action.
   */
  onAdoptCompanyFees?: (reason: string) => Promise<void>;
}>) {
  /** The configured row whose record form is open, by position. */
  const [recordingTemplateIndex, setRecordingTemplateIndex] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [voidingId, setVoidingId] = useState<string | null>(null);
  /** The add form's intent while the form is open; null when it is not. */
  const [openIntent, setOpenIntent] = useState<AddIntent | null>(null);
  /** Every attempt that has gone out and is not yet resolved, by intentId. */
  const [attempts, setAttempts] = useState<Record<string, AddAttempt>>({});

  const openAttempt = openIntent ? (attempts[openIntent.intentId] ?? null) : null;
  const submittingAny = Object.values(attempts).some((attempt) => attempt.status === "SUBMITTING");
  /**
   * Attempts whose result never arrived and whose form is no longer open.
   * Each stays visible, scoped to ITS intent, until the operator either
   * replays that same intent successfully or states that the lines were
   * checked. Neither a different cost's success nor closing the form clears
   * it, and nothing here ever calls the original "cancelled": hiding a form
   * does not undo a fee the server may have committed before the response
   * was lost.
   */
  const unresolved = Object.values(attempts).filter(
    (attempt) => attempt.status === "UNKNOWN" && attempt.intent.intentId !== openIntent?.intentId
  );

  const openAdd = () => {
    setEditingId(null);
    setVoidingId(null);
    setOpenIntent({ intentId: crypto.randomUUID(), currency: denomination.code, scale: scaleOf(denomination.code) });
  };

  /**
   * THE one way the add form is hidden — explicit Cancel, switching to another
   * line's Edit/Remove, or anything else that must close it. An attempt in
   * flight is not safely cancelled, so it refuses (returns false) and the
   * caller must not proceed. A REFUSED attempt, or no attempt, ends the
   * intent (nothing was committed). An UNKNOWN attempt is kept: its notice
   * takes over from the form, and its intent — and idempotency key — stay
   * retained for a same-request replay.
   */
  const closeAddForm = (): boolean => {
    if (!openIntent) return true;
    const attempt = attempts[openIntent.intentId];
    if (attempt?.status === "SUBMITTING") return false;
    if (attempt?.status !== "UNKNOWN") {
      if (attempt) {
        setAttempts((prev) => {
          const next = { ...prev };
          delete next[openIntent.intentId];
          return next;
        });
      }
      if (attempt) onAbandonAdd(openIntent.intentId);
    }
    setOpenIntent(null);
    return true;
  };

  /**
   * Sends (or replays) exactly `values` under its intent. The outcome is
   * written back by intentId, so a late answer to an attempt whose form has
   * since been hidden still lands on that attempt — it is never dropped and
   * never attributed to a newer form.
   */
  const submitAdd = async (intent: AddIntent, values: NewHandoverCost) => {
    setAttempts((prev) => ({ ...prev, [intent.intentId]: { intent, values, status: "SUBMITTING", message: null } }));
    try {
      await onAdd(values);
      setAttempts((prev) => {
        const next = { ...prev };
        delete next[intent.intentId];
        return next;
      });
      setOpenIntent((current) => (current?.intentId === intent.intentId ? null : current));
    } catch (caught) {
      const outcome = caught instanceof HandoverCostAttemptError ? caught.outcome : "UNKNOWN";
      const message = caught instanceof Error ? caught.message : t("UnexpectedError");
      setAttempts((prev) => ({ ...prev, [intent.intentId]: { intent, values, status: outcome, message } }));
    }
  };

  /** The operator states the lines were checked: that intent is over. Not "cancelled". */
  const acknowledge = (intentId: string) => {
    setAttempts((prev) => {
      const next = { ...prev };
      delete next[intentId];
      return next;
    });
    onAbandonAdd(intentId);
  };

  // `listDealCosts` serves live lines only; a voided line leaves the section
  // (its record survives server-side with reason, actor and time). With a
  // checklist present, the lines it accounts for are shown IN it; the list
  // below carries what is outside it — additional costs, and template lines
  // that carry no position.
  const expected = costs?.expected ?? null;
  const checklist = expected && expected.source === "COMPANY_RULE_SNAPSHOT" ? expected : null;
  const live = (costs?.lines ?? []).filter(
    (line) => !expected || expected.unplannedLineIds.includes(line._id)
  );
  /**
   * The served line a configured row's actual points at — EXACT lookup, or
   * nothing. The shared edit/void forms act on a LINE, so a row whose line is
   * not in the served payload (a moment between two query results, a legacy
   * payload) gets no edit/void controls rather than a fabricated target.
   */
  const lineFor = (row: ExpectedHandoverRow): HandoverCostLine | undefined =>
    row.actual === null ? undefined : costs?.lines.find((line) => line._id === row.actual?.feeId);
  const canAdd = canManage;
  const adding = openIntent !== null;

  return (
    <Card data-testid="deal-handover-costs">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 pb-3">
        <div className="space-y-1">
          <CardTitle className="text-base">{t("HandoverCostsHeading")}</CardTitle>
          <p className="text-xs text-muted-foreground">{t("HandoverCostsNote")}</p>
        </div>
        {canAdd && costs && !adding && (
          <Button type="button" size="sm" variant="outline" disabled={submittingAny} onClick={openAdd}>
            <Plus className="h-4 w-4 me-1.5" />
            {t("AddHandoverCost")}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Unresolved attempts and the open form live OUTSIDE the rows branch:
            a loading flicker or an unreadable moment must not hide either. */}
        {unresolved.map((attempt) => (
          <div
            key={attempt.intent.intentId}
            role="status"
            className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
            data-testid="deal-handover-costs-uncertain"
            data-intent={attempt.intent.intentId}
          >
            <p>{t("HandoverCostOutcomeUnknown")}</p>
            <p className="font-medium">
              {t(FEE_TYPE_LABEL[attempt.values.feeType])}
              {" · "}
              <bdi dir="ltr">
                {money(attempt.values.actualAmountMinor ?? attempt.values.estimatedAmountMinor ?? 0, attempt.intent.currency)}
              </bdi>
              {attempt.values.description && (
                <>
                  {" · "}
                  <bdi>{attempt.values.description}</bdi>
                </>
              )}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={submittingAny}
                onClick={() => acknowledge(attempt.intent.intentId)}
              >
                {t("HandoverCostAcknowledgeChecked")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={submittingAny}
                onClick={() => void submitAdd(attempt.intent, attempt.values)}
              >
                {t("RetryHandoverCost")}
              </Button>
            </div>
          </div>
        ))}
        {openIntent && (
          <AddForm
            intent={openIntent}
            attempt={openAttempt}
            dealClosed={dealClosed}
            t={t}
            onCancel={() => void closeAddForm()}
            onSubmit={(values) => submitAdd(openIntent, values)}
          />
        )}
        {costs === undefined ? (
          <p className="text-sm text-muted-foreground">
            {t(loading ? "HandoverCostsLoading" : "HandoverCostsUnavailable")}
          </p>
        ) : (
          <>
            {/* Compact totals first: estimated and actual are different facts
                and are never combined — and never summed across currencies:
                the server serves no summary over mixed rows, only the reason. */}
            {costs.summary === null ? (
              <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="deal-handover-costs-mixed">
                {t(costs.summaryUnavailable?.reason === "UNSAFE_AMOUNT" ? "HandoverCostsUnreadableAmount" : "HandoverCostsMixedCurrency")}
                {costs.summaryUnavailable && costs.summaryUnavailable.reason === "MIXED_DENOMINATION" && (
                  <>
                    {" "}
                    (<bdi dir="ltr">{costs.summaryUnavailable.lineCurrencies.join(", ")}</bdi>
                    {" / "}
                    <bdi dir="ltr">{costs.summaryUnavailable.dealCurrency}</bdi>)
                  </>
                )}
              </p>
            ) : (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3" data-testid="deal-handover-costs-totals">
              <div>
                <dt className="text-xs text-muted-foreground">{t("CostsExpectedTotal")}</dt>
                <dd className="font-medium">
                  <ExpectedTotal
                    expected={expected}
                    estimatedTotalMinor={costs.summary.estimatedTotalMinor}
                    denominationCode={denomination.code}
                    money={money}
                    t={t}
                  />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("CostsActualTotal")}</dt>
                <dd className="font-medium">
                  <bdi className="tabular-nums" dir="ltr">
                    {money(costs.summary.actualTotalMinor, denomination.code)}
                  </bdi>
                </dd>
              </div>
              {expected?.differenceMinor !== null && expected?.differenceMinor !== undefined && (
                <div data-testid="deal-handover-costs-difference">
                  <dt className="text-xs text-muted-foreground">{t("CostsDifference")}</dt>
                  <dd className="font-medium">
                    <bdi className="tabular-nums" dir="ltr">
                      {money(expected.differenceMinor, expected.currency)}
                    </bdi>
                    <span className="ms-1.5 text-xs font-normal text-muted-foreground">{t("CostsDifferenceNote")}</span>
                  </dd>
                </div>
              )}
              {costs.summary.linesAwaitingActual > 0 && (
                <div>
                  <dt className="text-xs text-muted-foreground">{t("CostsAwaitingActual")}</dt>
                  <dd className="font-medium text-amber-700 dark:text-amber-400">
                    <bdi>{costs.summary.linesAwaitingActual}</bdi>
                  </dd>
                </div>
              )}
            </dl>
            )}
            <Separator />

            {/* The finance company's policy, as the deal froze it: one row per
                configured fee — what it says, what was actually paid, and the
                one action a row without an actual has. Nothing here is typed
                as an expectation. */}
            {expected && (
              <section className="space-y-2" data-testid="deal-handover-expected">
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">{t("HandoverExpectedHeading")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t(
                      checklist
                        ? "HandoverExpectedNote"
                        : expected.source === "NO_SNAPSHOT"
                          ? "HandoverExpectedNoSnapshot"
                          : "HandoverExpectedNotConfigured"
                    )}
                  </p>
                </div>
                {expected.adoption && (
                  <FeeAdoptionNotice adoption={expected.adoption} t={t} onAdopt={onAdoptCompanyFees} />
                )}
                {checklist && (
                  <ul className="space-y-1.5">
                    {checklist.rows.map((row) => (
                      <li
                        key={row.templateIndex}
                        className="rounded-md border p-3 text-sm"
                        data-testid={`deal-handover-expected-${row.templateIndex}`}
                      >
                        {recordingTemplateIndex === row.templateIndex && onRecordTemplateActual ? (
                          <TemplateActualForm
                            row={row}
                            scale={scaleOf(checklist.currency)}
                            currency={checklist.currency}
                            t={t}
                            onCancel={(afterUnknown) => {
                              if (afterUnknown) onAbandonTemplateActual?.(row);
                              setRecordingTemplateIndex(null);
                            }}
                            onSubmit={async (values) => {
                              await onRecordTemplateActual(row, values);
                              setRecordingTemplateIndex(null);
                            }}
                          />
                        ) : (
                          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                            <div className="min-w-0 space-y-1">
                              <p className="font-medium">
                                {t(FEE_TYPE_LABEL[row.feeType] ?? row.feeType)}
                                {row.description && (
                                  <span className="text-muted-foreground">
                                    {" · "}
                                    <bdi>{row.description}</bdi>
                                  </span>
                                )}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                <Badge variant="outline" className="me-1.5">
                                  {row.actual
                                    ? t(STATUS_LABEL[row.actual.status] ?? row.actual.status)
                                    : t("CostNotRecorded")}
                                </Badge>
                                {row.duplicateIdentity && (
                                  <Badge variant="outline" className="me-1.5">
                                    {t("TemplateConfiguredTwice")}
                                  </Badge>
                                )}
                              </p>
                            </div>
                            <div className="flex items-start gap-3">
                              <dl className="grid grid-cols-[auto_auto] gap-x-3 text-end text-xs">
                                <dt className="text-muted-foreground">{t("CostExpected")}</dt>
                                <dd className="tabular-nums">
                                  <bdi dir="ltr">{money(row.expectedAmountMinor, checklist.currency)}</bdi>
                                </dd>
                                <dt className="text-muted-foreground">{t("CostActual")}</dt>
                                <dd className="font-semibold tabular-nums">
                                  {row.actual?.actualAmountMinor === undefined ? (
                                    <span className="font-normal text-muted-foreground">{t("FactUnavailable")}</span>
                                  ) : (
                                    <bdi dir="ltr">{money(row.actual.actualAmountMinor, row.actual.currency)}</bdi>
                                  )}
                                </dd>
                              </dl>
                              {canManage && row.actual === null && onRecordTemplateActual && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  disabled={submittingAny}
                                  onClick={() => {
                                    if (!closeAddForm()) return;
                                    setEditingId(null);
                                    setVoidingId(null);
                                    setRecordingTemplateIndex(row.templateIndex);
                                  }}
                                >
                                  {t("RecordTemplateActual")}
                                </Button>
                              )}
                              {canManage && row.actual !== null && row.actual.currency === denomination.code && lineFor(row) && (
                                <div className="flex gap-1">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7"
                                    aria-label={t("RecordActualCost")}
                                    disabled={submittingAny}
                                    onClick={() => {
                                      if (!closeAddForm()) return;
                                      setRecordingTemplateIndex(null);
                                      setVoidingId(null);
                                      setEditingId(row.actual?.feeId ?? null);
                                    }}
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7 text-destructive hover:text-destructive"
                                    aria-label={t("RemoveHandoverCost")}
                                    disabled={submittingAny}
                                    onClick={() => {
                                      if (!closeAddForm()) return;
                                      setRecordingTemplateIndex(null);
                                      setEditingId(null);
                                      setVoidingId(row.actual?.feeId ?? null);
                                    }}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                        {row.actual !== null && editingId === row.actual.feeId && lineFor(row) && (
                          <div className="mt-3">
                            <ActualForm
                              line={lineFor(row) as HandoverCostLine}
                              scale={scaleOf(row.actual.currency)}
                              t={t}
                              onCancel={() => setEditingId(null)}
                              onSubmit={async (values) => {
                                await onRecordActual((lineFor(row) as HandoverCostLine)._id, values);
                                setEditingId(null);
                              }}
                            />
                          </div>
                        )}
                        {row.actual !== null && voidingId === row.actual.feeId && lineFor(row) && (
                          <div className="mt-3">
                            <VoidForm
                              t={t}
                              onCancel={() => setVoidingId(null)}
                              onSubmit={async (reason) => {
                                await onVoid((lineFor(row) as HandoverCostLine)._id, reason);
                                setVoidingId(null);
                              }}
                            />
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="pt-1 text-sm font-medium">{t("AdditionalCostsHeading")}</p>
              </section>
            )}

            {live.length === 0 && !adding && (
              <p className="text-sm text-muted-foreground">{t("NoHandoverCosts")}</p>
            )}

            <ul className="space-y-2">
              {live.map((line) => (
                <li
                  key={line._id}
                  className="rounded-md border p-3 text-sm"
                  data-testid={`deal-handover-cost-${line._id}`}
                >
                  {editingId === line._id ? (
                    <ActualForm
                      line={line}
                      scale={scaleOf(line.currency)}
                      t={t}
                      onCancel={() => setEditingId(null)}
                      onSubmit={async (values) => {
                        await onRecordActual(line._id, values);
                        setEditingId(null);
                      }}
                    />
                  ) : voidingId === line._id ? (
                    <VoidForm
                      t={t}
                      onCancel={() => setVoidingId(null)}
                      onSubmit={async (reason) => {
                        await onVoid(line._id, reason);
                        setVoidingId(null);
                      }}
                    />
                  ) : (
                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                      <div className="min-w-0 space-y-1">
                        <p className="font-medium">
                          {t(FEE_TYPE_LABEL[line.feeType] ?? line.feeType)}
                          {line.description && (
                            <span className="text-muted-foreground">
                              {" · "}
                              <bdi>{line.description}</bdi>
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          <Badge variant="outline" className="me-1.5">
                            {t(STATUS_LABEL[line.status] ?? line.status)}
                          </Badge>
                          {line.receiptReference && (
                            <>
                              {t("ReceiptReferenceLabel")}: <bdi dir="ltr">{line.receiptReference}</bdi>
                            </>
                          )}
                        </p>
                      </div>
                      <div className="flex items-start gap-3">
                        <dl className="grid grid-cols-[auto_auto] gap-x-3 text-end text-xs">
                          <dt className="text-muted-foreground">{t("CostEstimated")}</dt>
                          <dd className="tabular-nums">
                            {line.estimatedAmountMinor === undefined ? (
                              <span className="text-muted-foreground">{t("FactUnavailable")}</span>
                            ) : (
                              <bdi dir="ltr">{money(line.estimatedAmountMinor, line.currency)}</bdi>
                            )}
                          </dd>
                          <dt className="text-muted-foreground">{t("CostActual")}</dt>
                          <dd className="font-semibold tabular-nums">
                            {line.actualAmountMinor === undefined ? (
                              <span className="font-normal text-muted-foreground">{t("FactUnavailable")}</span>
                            ) : (
                              <bdi dir="ltr">{money(line.actualAmountMinor, line.currency)}</bdi>
                            )}
                          </dd>
                        </dl>
                        {canManage && isHandoverType(line.feeType) && line.currency !== denomination.code && (
                          <span className="text-xs text-amber-700 dark:text-amber-400" data-testid={`deal-handover-cost-${line._id}-currency`}>
                            {t("HandoverCostCurrencyDiffers")}
                          </span>
                        )}
                        {canManage && isHandoverType(line.feeType) && line.currency === denomination.code && (
                          <div className="flex gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              aria-label={t("RecordActualCost")}
                              disabled={submittingAny}
                              onClick={() => {
                                if (!closeAddForm()) return;
                                setVoidingId(null);
                                setEditingId(line._id);
                              }}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-destructive hover:text-destructive"
                              aria-label={t("RemoveHandoverCost")}
                              disabled={submittingAny}
                              onClick={() => {
                                if (!closeAddForm()) return;
                                setEditingId(null);
                                setVoidingId(line._id);
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>

          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The "expected" figure of the totals row. From the finance company's frozen
 * policy when the deal carries one — a deal that configures nothing says so
 * rather than showing a zero. Without a checklist (older payloads) the lines'
 * own estimates stand in, in the deal's denomination.
 *
 * Its own component only so the panel stays inside Sonar's cognitive-
 * complexity budget (S3776, 20 > 15 on the nested ternary this replaces);
 * what is shown, and when, did not move.
 */
function ExpectedTotal({
  expected,
  estimatedTotalMinor,
  denominationCode,
  money,
  t,
}: Readonly<{
  expected: HandoverExpectedCosts | null;
  /** `summary.estimatedTotalMinor` — the lines' own estimates, summed server-side. */
  estimatedTotalMinor: number;
  denominationCode: string;
  money: (minor: number, currency: string) => string;
  t: (key: string) => string;
}>) {
  if (!expected) {
    return (
      <bdi className="tabular-nums" dir="ltr">
        {money(estimatedTotalMinor, denominationCode)}
      </bdi>
    );
  }
  if (expected.expectedTotalMinor === null) {
    return <span className="font-normal text-muted-foreground">{t("FactUnavailable")}</span>;
  }
  return (
    <bdi className="tabular-nums" dir="ltr">
      {money(expected.expectedTotalMinor, expected.currency)}
    </bdi>
  );
}

function AddForm({
  intent,
  attempt,
  dealClosed,
  t,
  onCancel,
  onSubmit,
}: Readonly<{
  /** Minted by the panel when the form opened; carries the captured denomination. */
  intent: AddIntent;
  /** The panel's record of this intent's attempt, or null before the first one. */
  attempt: AddAttempt | null;
  dealClosed: boolean;
  t: (key: string) => string;
  onCancel: () => void;
  onSubmit: (values: NewHandoverCost) => Promise<void>;
}>) {
  const [feeType, setFeeType] = useState<HandoverFeeType>("OWNERSHIP_TRANSFER");
  const [treatment, setTreatment] = useState<HandoverTreatment>(defaultTreatmentFor("OWNERSHIP_TRANSFER"));
  const [payee, setPayee] = useState<HandoverPayee>("GOVERNMENT");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState("");
  const [reference, setReference] = useState("");
  const [validation, setValidation] = useState<string | null>(null);
  /**
   * The denomination this form was OPENED under — captured by the panel with
   * the intent (SCRUM-319). The amount is parsed at this scale and sent with
   * this code on every attempt, including a retry — never re-read from the
   * deal at submit time, so a settings change while the form is open cannot
   * silently reinterpret what the operator typed. If it no longer matches
   * the deal, the server refuses with nothing committed and says so here.
   */
  const { currency, scale } = intent;
  /**
   * Once an attempt has gone out under this intent, the fields FREEZE. The
   * server deduplicates a retry by the command identity and a fingerprint of
   * the WHOLE persisted payload, so a retry that changed anything at all
   * would be refused as a different intent under the same key. Retry
   * therefore replays the panel's stored payload verbatim; changing anything
   * means cancelling this intent and opening a new form (a new command).
   */
  const submitting = attempt?.status === "SUBMITTING";
  const attempted = attempt !== null;
  const lastOutcome = attempt && attempt.status !== "SUBMITTING" ? attempt.status : null;
  const error = validation ?? (lastOutcome !== null ? attempt?.message ?? null : null);

  const amountMinor = parseMajor(amount, scale);
  const amountInvalid = amount.trim() !== "" && amountMinor === null;

  return (
    <form
      className="space-y-3 rounded-md border border-dashed p-3"
      data-testid="deal-handover-cost-add"
      data-intent={intent.intentId}
      onSubmit={(event) => {
        event.preventDefault();
        if (submitting) return;
        // A retry replays exactly what went out the first time.
        if (attempt) {
          void onSubmit(attempt.values);
          return;
        }
        if (amountMinor === null) {
          setValidation(t("CostAmountRequired"));
          return;
        }
        setValidation(null);
        // An ADDITIONAL cost is what was actually paid. There is no expected
        // figure to type: expectations are the finance company's, read from
        // the deal's frozen snapshot, and this form never authors one.
        void onSubmit({
          intentId: intent.intentId,
          currency,
          feeType,
          description: description.trim() || undefined,
          estimatedAmountMinor: undefined,
          actualAmountMinor: amountMinor,
          paidTo: payee,
          accountingTreatment: treatment,
          paidAt: paidOn ? dateInputToUtcMs(paidOn) : undefined,
          receiptReference: reference.trim() || undefined,
        });
      }}
    >
      <p className="text-sm font-medium">{t("AddHandoverCost")}</p>
      <p className="text-xs text-muted-foreground">{t("AdditionalCostNote")}</p>
      {dealClosed && <p className="text-xs text-muted-foreground">{t("HandoverCostAfterCloseNote")}</p>}
      {attempted && (
        <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="deal-handover-cost-add-frozen">
          {t(lastOutcome === "UNKNOWN" ? "HandoverCostRetryFrozenUnknown" : "HandoverCostRetryFrozen")}
        </p>
      )}
      <fieldset disabled={attempted || submitting} className="contents">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="handover-cost-type">{t("CostTypeLabel")}</Label>
          <select
            id="handover-cost-type"
            className={selectClass}
            value={feeType}
            onChange={(event) => {
              const next = event.target.value as HandoverFeeType;
              setFeeType(next);
              setTreatment(defaultTreatmentFor(next));
              setPayee(next === "INSURANCE" ? "INSURER" : next === "OTHER_CLOSING_EXPENSE" ? "OTHER" : "GOVERNMENT");
            }}
          >
            {HANDOVER_FEE_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(FEE_TYPE_LABEL[type])}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="handover-cost-payee">{t("CostPayeeLabel")}</Label>
          <select
            id="handover-cost-payee"
            className={selectClass}
            value={payee}
            onChange={(event) => setPayee(event.target.value as HandoverPayee)}
          >
            {HANDOVER_PAYEES.map((option) => (
              <option key={option} value={option}>
                {t(PAYEE_LABEL[option])}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="handover-cost-description">{t("CostDescriptionLabel")}</Label>
          <Input
            id="handover-cost-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="handover-cost-amount">
            {t("CostActual")} · {t("CostAmountLabel")} (<bdi dir="ltr">{currency}</bdi>)
          </Label>
          <Input
            id="handover-cost-amount"
            inputMode="decimal"
            className="tabular-nums"
            value={amount}
            aria-invalid={amountInvalid}
            onChange={(event) => setAmount(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="handover-cost-paid-on">{t("CostPaidOnLabel")}</Label>
          <Input
            id="handover-cost-paid-on"
            type="date"
            max={todayDateInput()}
            value={paidOn}
            onChange={(event) => setPaidOn(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="handover-cost-reference">{t("ReceiptReferenceLabel")}</Label>
          <Input
            id="handover-cost-reference"
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="handover-cost-treatment">{t("CostTreatmentLabel")}</Label>
          <select
            id="handover-cost-treatment"
            className={selectClass}
            value={treatment}
            onChange={(event) => setTreatment(event.target.value as HandoverTreatment)}
          >
            {HANDOVER_TREATMENTS.map((option) => (
              <option key={option} value={option}>
                {t(TREATMENT_LABEL[option])}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">{t("CostTreatmentNote")}</p>
        </div>
      </div>
      </fieldset>
      {error && (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={onCancel}>
          {t("Cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={submitting || (!attempted && amountMinor === null)}>
          {submitting && <Loader2 className="h-4 w-4 me-1.5 animate-spin" />}
          {t(attempted ? "RetryHandoverCost" : "SaveHandoverCost")}
        </Button>
      </div>
    </form>
  );
}

/**
 * What the server says about adopting the company's since-configured fees:
 * a sentence for every non-trivial state, and the owner's action only in
 * the one state the server would accept it.
 */
function FeeAdoptionNotice({
  adoption,
  t,
  onAdopt,
}: Readonly<{
  adoption: HandoverFeeAdoption;
  t: (key: string) => string;
  onAdopt: ((reason: string) => Promise<void>) | undefined;
}>) {
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  if (adoption.state === "NOT_NEEDED") {
    return adoption.adopted ? (
      <p className="text-xs text-muted-foreground" data-testid="deal-handover-fees-adopted">
        {t("HandoverExpectedAdopted")} <bdi dir="ltr">{adoption.adopted.fromRuleVersion}</bdi>
      </p>
    ) : null;
  }
  const noticeKey =
    adoption.state === "AVAILABLE"
      ? "HandoverExpectedAdoptable"
      : adoption.state === "BLOCKED_COSTS_RECORDED"
        ? "HandoverExpectedAdoptBlockedCosts"
        : adoption.state === "BLOCKED_DEAL_PROGRESSED"
          ? "HandoverExpectedAdoptBlockedProgressed"
          : adoption.state === "COMPANY_INACTIVE"
            ? "HandoverExpectedAdoptCompanyInactive"
            : null;
  if (noticeKey === null) return null;
  return (
    <div className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm" data-testid="deal-handover-fee-adoption">
      <p className="text-amber-800 dark:text-amber-300">
        {t(noticeKey)} (<bdi dir="ltr">{adoption.liveTemplateCount}</bdi>)
      </p>
      {adoption.state === "AVAILABLE" && onAdopt && !open && (
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
          {t("AdoptCompanyFees")}
        </Button>
      )}
      {open && onAdopt && (
        <form
          className="space-y-2"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!reason.trim()) return;
            setSubmitting(true);
            setError(null);
            try {
              await onAdopt(reason.trim());
              setOpen(false);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <Label htmlFor="handover-adopt-reason">{t("AdoptCompanyFeesReason")}</Label>
          <Input id="handover-adopt-reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
          {error && (
            <p role="alert" className="text-xs font-medium text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={submitting || !reason.trim()}>
              {submitting && <Loader2 className="h-4 w-4 me-1.5 animate-spin" />}
              {t("AdoptCompanyFeesConfirm")}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={submitting} onClick={() => setOpen(false)}>
              {t("Cancel")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * The one thing an operator enters on a configured row: what was actually
 * paid (with its date and receipt). The expectation on the row is the finance
 * company's and is shown, not typed; every other field of the resulting line
 * is copied server-side from the deal's frozen snapshot.
 */
function TemplateActualForm({
  row,
  scale,
  currency,
  t,
  onCancel,
  onSubmit,
}: Readonly<{
  row: ExpectedHandoverRow;
  /** The scale of the deal's denomination — the amount is recorded in it. */
  scale: number;
  currency: string;
  t: (key: string) => string;
  /** `afterUnknown`: the form is closing on an attempt whose result never arrived. */
  onCancel: (afterUnknown: boolean) => void;
  onSubmit: (values: ActualHandoverCost) => Promise<void>;
}>) {
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState("");
  const [reference, setReference] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The exact payload of an attempt whose result was LOST. From then on the
   * fields freeze and Retry replays this verbatim under the same retained
   * identity: the server deduplicates by identity plus a fingerprint of the
   * whole payload, so a changed amount under that identity would be refused as
   * a different intent. A REFUSED attempt (the server's own answer, nothing
   * committed) does not freeze anything — the identity is released by the
   * container and the next submit is a new command.
   *
   * What makes the simpler lifecycle SAFE here, unlike the additional-cost
   * form: the server keeps ONE live line per (deal, position). Whatever the
   * operator does after a lost response — replay, cancel and record again
   * under a new identity — at most one actual can ever land on this row; the
   * second attempt is either the first to commit or is refused because the
   * lost one did.
   */
  const [frozen, setFrozen] = useState<ActualHandoverCost | null>(null);
  const amountMinor = parseMajor(amount, scale);
  const amountInvalid = amount.trim() !== "" && amountMinor === null;
  const fieldId = `handover-expected-${row.templateIndex}`;

  return (
    <form
      className="space-y-3"
      data-testid={`deal-handover-expected-record-${row.templateIndex}`}
      onSubmit={async (event) => {
        event.preventDefault();
        if (submitting) return;
        const values: ActualHandoverCost | null =
          frozen ??
          (amountMinor === null
            ? null
            : {
                actualAmountMinor: amountMinor,
                paidAt: paidOn ? dateInputToUtcMs(paidOn) : undefined,
                receiptReference: reference.trim() || undefined,
                currency,
              });
        if (values === null) {
          setError(t("CostAmountRequired"));
          return;
        }
        setSubmitting(true);
        setError(null);
        try {
          await onSubmit(values);
        } catch (caught) {
          const outcome = caught instanceof HandoverCostAttemptError ? caught.outcome : "UNKNOWN";
          if (outcome === "UNKNOWN") setFrozen(values);
          setError(caught instanceof Error ? caught.message : t("UnexpectedError"));
        } finally {
          setSubmitting(false);
        }
      }}
    >
      <p className="text-sm font-medium">
        {t(FEE_TYPE_LABEL[row.feeType] ?? row.feeType)}
        {row.description && (
          <span className="text-muted-foreground">
            {" · "}
            <bdi>{row.description}</bdi>
          </span>
        )}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("CostExpected")}: <bdi dir="ltr">{row.expectedAmountMinor / Math.pow(10, scale)} {currency}</bdi>
      </p>
      {frozen && (
        <p className="text-xs text-amber-700 dark:text-amber-400" data-testid={`deal-handover-expected-record-${row.templateIndex}-frozen`}>
          {t("HandoverCostRetryFrozenUnknown")}
        </p>
      )}
      <fieldset disabled={frozen !== null || submitting} className="contents">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${fieldId}-amount`}>
            {t("CostActual")} · {t("CostAmountLabel")} (<bdi dir="ltr">{currency}</bdi>)
          </Label>
          <Input
            id={`${fieldId}-amount`}
            inputMode="decimal"
            className="tabular-nums"
            value={amount}
            aria-invalid={amountInvalid}
            onChange={(event) => setAmount(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${fieldId}-paid-on`}>{t("CostPaidOnLabel")}</Label>
          <Input
            id={`${fieldId}-paid-on`}
            type="date"
            max={todayDateInput()}
            value={paidOn}
            onChange={(event) => setPaidOn(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${fieldId}-reference`}>{t("ReceiptReferenceLabel")}</Label>
          <Input
            id={`${fieldId}-reference`}
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          />
        </div>
      </div>
      </fieldset>
      {error && (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={() => onCancel(frozen !== null)}>
          {t("Cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={submitting || (frozen === null && amountMinor === null)}>
          {submitting && <Loader2 className="h-4 w-4 me-1.5 animate-spin" />}
          {t(frozen ? "RetryHandoverCost" : "SaveActualCost")}
        </Button>
      </div>
    </form>
  );
}

function ActualForm({
  line,
  scale,
  t,
  onCancel,
  onSubmit,
}: Readonly<{
  line: HandoverCostLine;
  /** The scale of the LINE's own currency — the amount is patched onto that row. */
  scale: number;
  t: (key: string) => string;
  onCancel: () => void;
  onSubmit: (values: ActualHandoverCost) => Promise<void>;
}>) {
  const [amount, setAmount] = useState(
    line.actualAmountMinor === undefined ? "" : String(line.actualAmountMinor / Math.pow(10, scale))
  );
  const [paidOn, setPaidOn] = useState("");
  const [reference, setReference] = useState(line.receiptReference ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amountMinor = parseMajor(amount, scale);

  return (
    <form
      className="space-y-3"
      data-testid={`deal-handover-cost-edit-${line._id}`}
      onSubmit={async (event) => {
        event.preventDefault();
        if (amountMinor === null) {
          setError(t("CostAmountRequired"));
          return;
        }
        setSubmitting(true);
        setError(null);
        try {
          await onSubmit({
            actualAmountMinor: amountMinor,
            paidAt: paidOn ? dateInputToUtcMs(paidOn) : undefined,
            receiptReference: reference.trim() || undefined,
            currency: line.currency,
          });
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : t("UnexpectedError"));
        } finally {
          setSubmitting(false);
        }
      }}
    >
      <p className="font-medium">
        {t("RecordActualCost")} · {t(FEE_TYPE_LABEL[line.feeType] ?? line.feeType)}
      </p>
      {line.estimatedAmountMinor !== undefined && (
        <p className="text-xs text-muted-foreground">
          {t("CostEstimated")}:{" "}
          <bdi dir="ltr" className="tabular-nums">
            {line.estimatedAmountMinor / Math.pow(10, scale)} {line.currency}
          </bdi>{" "}
          — {t("CostEstimatePreservedNote")}
        </p>
      )}
      {line.status === "RECONCILED" && (
        <p className="text-xs text-amber-700 dark:text-amber-400">{t("CostReconciledEditNote")}</p>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor={`actual-amount-${line._id}`}>
            {t("CostActual")} (<bdi dir="ltr">{line.currency}</bdi>)
          </Label>
          <Input
            id={`actual-amount-${line._id}`}
            inputMode="decimal"
            className="tabular-nums"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`actual-paid-on-${line._id}`}>{t("CostPaidOnLabel")}</Label>
          <Input
            id={`actual-paid-on-${line._id}`}
            type="date"
            max={todayDateInput()}
            value={paidOn}
            onChange={(event) => setPaidOn(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`actual-reference-${line._id}`}>{t("ReceiptReferenceLabel")}</Label>
          <Input
            id={`actual-reference-${line._id}`}
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          />
        </div>
      </div>
      {error && (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={onCancel}>
          {t("Cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={submitting || amountMinor === null}>
          {submitting && <Loader2 className="h-4 w-4 me-1.5 animate-spin" />}
          {t("SaveActualCost")}
        </Button>
      </div>
    </form>
  );
}

function VoidForm({
  t,
  onCancel,
  onSubmit,
}: Readonly<{
  t: (key: string) => string;
  onCancel: () => void;
  onSubmit: (reason: string) => Promise<void>;
}>) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!reason.trim()) {
          setError(t("VoidReasonRequired"));
          return;
        }
        setSubmitting(true);
        setError(null);
        try {
          await onSubmit(reason.trim());
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : t("UnexpectedError"));
        } finally {
          setSubmitting(false);
        }
      }}
    >
      <p className="font-medium text-destructive">{t("RemoveHandoverCost")}</p>
      <p className="text-xs text-muted-foreground">{t("VoidCostNote")}</p>
      <div className="space-y-1.5">
        <Label htmlFor="void-reason">{t("VoidReasonLabel")}</Label>
        <Input id="void-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
      </div>
      {error && (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={onCancel}>
          {t("Cancel")}
        </Button>
        <Button type="submit" size="sm" variant="destructive" disabled={submitting || !reason.trim()}>
          {submitting && <Loader2 className="h-4 w-4 me-1.5 animate-spin" />}
          {t("ConfirmRemoveCost")}
        </Button>
      </div>
    </form>
  );
}
