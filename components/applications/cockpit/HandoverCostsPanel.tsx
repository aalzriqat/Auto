"use client";

import { useEffect, useState } from "react";

/** A stopped deal: the server refuses new custody cash and direct payments on both (`dealAcceptsNewCustodyCash`). */
export type DealStopped = "CANCELLED" | "REJECTED" | null;
import { Loader2, Pencil, Plus, Trash2, CheckCheck, Receipt } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { economicDateInputToMs, economicTodayDateInput } from "@/lib/dateInput";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import {
  MAX_DIRECT_PAYMENT_REFERENCE_CHARS,
  MAX_FEE_DESCRIPTION_CHARS,
  MAX_FEE_RECEIPT_REFERENCE_CHARS,
  MAX_FEE_RECONCILIATION_NOTES_CHARS,
  MAX_FEE_VOID_REASON_CHARS,
} from "@/convex/utils/feeDocLimits";

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
 *
 * Only treatments the dealership expenses: a handover cost is always paid out
 * of an employee's custody cash (owner ruling 2026-09-28, SCRUM-439), and the
 * server posts only those against custody (`CUSTODY_POSTABLE_TREATMENTS`). A
 * customer-recoverable treatment could never be charged there, so it is not
 * offered.
 */
export const HANDOVER_TREATMENTS = [
  "OWNERSHIP_TRANSFER_EXPENSE",
  "SELLING_EXPENSE",
  "INSURANCE_EXPENSE",
] as const;
export type HandoverTreatment = (typeof HANDOVER_TREATMENTS)[number];

/**
 * An open custody record a new cost may be charged to in the same command
 * (SCRUM-439). The container offers only the records the server would accept
 * from THIS caller: open, on the ledger, in the deal's currency, held by
 * somebody other than the operator, to a caller who may post custody.
 */
export type HandoverCustodyPayer = Readonly<{ custodyId: Id<"financeDealCustody">; holderName: string }>;

/**
 * Where a new handover cost's cash comes from — always an employee's custody
 * (owner ruling 2026-09-28, SCRUM-439):
 *   CHARGE  — this caller may charge a record directly; the cost is written
 *             as the employee's and charged to the chosen record together.
 *   PENDING — custody is open on the deal but this caller may not charge it
 *             (no custody authority, or they hold the cash themselves): the
 *             cost is written as paid by the employee and waits under
 *             "Charge a cost" for somebody who may.
 *   NONE    — no custody is open yet. The cost is still written as the
 *             employee's (never the dealership's), and the form says to hand
 *             the cash over and charge it from "Charge a cost". Not a locked
 *             door: a deal with no handover costs at all records its zero line
 *             here, and an employee-paid line posts exactly as a dealer-borne
 *             one does until it is charged (`feeSummary`, `dealOverview`).
 */
export type HandoverCostSource =
  | Readonly<{ kind: "CHARGE"; payers: ReadonlyArray<HandoverCustodyPayer> }>
  | Readonly<{ kind: "PENDING" }>
  | Readonly<{ kind: "NONE" }>
  /** The caller may charge custody, but the read naming them has not answered. */
  | Readonly<{ kind: "LOADING" }>;

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
  /**
   * Who paid this cost and whether it is on the books (SCRUM-443), as the
   * server derives it from `convex/utils/handoverCostPayment` — the module the
   * closing check reads, so this screen cannot disagree with the verdict.
   * Absent on a payload that predates it: the line then shows no payment row.
   */
  handoverPayment?: HandoverPaymentView;
  /** Where the line came from: the finance company's (legacy) fee template, or typed in by hand. Served with the row. */
  source?: "COMPANY_TEMPLATE" | "MANUAL";
  /** Whether a direct dealership payment would be accepted on this line right now. */
  directPaymentEligible?: boolean;
  /** The live direct payment, when there is one. */
  directPayment?: {
    method: string;
    amountMinor: number;
    paidAt: number;
    reference?: string;
  };
};

export type HandoverPaymentView =
  | "NOT_HANDOVER_LINE"
  | "NO_ACTUAL"
  | "ZERO_ACTUAL"
  | "PAID_CUSTODY"
  | "PAID_DIRECT"
  | "UNPAID"
  | "UNSUPPORTED_TREATMENT"
  | "DEDUCTION_NOT_RECOGNISED"
  | "CONFLICT";

/** How the dealership itself paid — required, never defaulted (it decides which account the money left). */
export const DIRECT_PAYMENT_METHODS = ["BANK_TRANSFER", "CARD", "CASH", "CHEQUE"] as const;
export type DirectPaymentMethodChoice = (typeof DIRECT_PAYMENT_METHODS)[number];

export type DirectHandoverPayment = {
  /** Names THIS attempt — minted when the form opened, so a retry after a lost response replays it. */
  intentId: string;
  method: DirectPaymentMethodChoice;
  paidAt: number;
  reference: string | undefined;
  /**
   * The amount, in minor units, the operator SAW on the form when they chose to
   * pay (the line's rendered actual). The server pays the line's actual only
   * while it is still exactly this, so an edit between render and submit is
   * refused rather than paid at a figure nobody approved.
   */
  expectedAmountMinor: number;
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
  /** The frozen estimate, or null with `expectedAmountReason` when the stored value is not a readable figure. */
  expectedAmountMinor: number | null;
  expectedAmountReason: "UNSAFE_AMOUNT" | null;
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
  /** Sum of the configured expectations; null when nothing is configured, or with `expectedTotalReason` when it cannot be read. */
  expectedTotalMinor: number | null;
  expectedTotalReason: "UNSAFE_AMOUNT" | null;
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
    | "BLOCKED_DEAL_PROGRESSED"
    /** A stored company template amount is not readable; the mutation would refuse, so nothing is offered. */
    | "COMPANY_TEMPLATES_UNREADABLE"
    /** More templates than one policy may carry; the mutation would refuse, so nothing is offered. */
    | "COMPANY_TEMPLATES_OVER_LIMIT";
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
  /** The finance company's execution fee (SCRUM-690). Null when the deal expects none; absent on older payloads. */
  executionFee?: HandoverExecutionFee | null;
};

/**
 * The deal's single execution-fee position, as `listDealCosts` serves it — the
 * same verdict the finalization gate and the profit headlines read. The fee's
 * actual is one cost line, LINKED explicitly by id; nothing is matched by type.
 */
export type HandoverExecutionFee = {
  /** The frozen expectation; null when the stored figure is not readable. */
  expectedMinor: number | null;
  /** The linked line, or null while the fee has no actual. */
  boundFeeId: string | null;
  /** No actual linked yet: the deal cannot finalize until one is (0 when not charged). */
  unrecorded: boolean;
  /** The estimate is withheld (ambiguous link, or the frozen total disagrees with the fee). */
  withheld: boolean;
  /** Live lines the server would accept as the fee's actual. */
  eligibleFeeIds: ReadonlyArray<string>;
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
  /**
   * A handover cost is always paid by an employee out of custody cash (owner
   * ruling 2026-09-28, SCRUM-439). This names the record when the caller
   * charges it in the same command — the line is written as that employee's
   * and charged together, so the custody's expenses and the cost line can
   * never disagree. Undefined when the caller may not charge custody: the
   * line is still the employee's and waits under "Charge a cost".
   */
  custodyId: Id<"financeDealCustody"> | undefined;
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
  costSource,
  t,
  onAdd,
  onAbandonAdd,
  onRecordActual,
  onVoid,
  onReconcile,
  onRecordTemplateActual,
  onAbandonTemplateActual,
  canRecordDirectPayment = false,
  canReconcile = false,
  onRecordDirectPayment,
  onAbandonDirectPayment,
  postingHoldFeeIds = [],
  handoverCostsCheck,
  custodyLedgerCheck,
  dealStopped = null,
  onRecordExecutionFee,
  onAbandonExecutionFee,
  onLinkExecutionFee,
  onUnlinkExecutionFee,
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
  /** Where a new cost's cash comes from — always an employee's custody. */
  costSource: HandoverCostSource;
  t: (key: string) => string;
  onAdd: (values: NewHandoverCost) => Promise<void>;
  /** The operator cancelled a form that had already attempted once: its intent is over. */
  onAbandonAdd: (intentId: string) => void;
  onRecordActual: (feeId: string, values: ActualHandoverCost) => Promise<void>;
  onVoid: (feeId: string, reason: string) => Promise<void>;
  onReconcile?: (feeId: string, notes: string) => Promise<void>;
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
   * `confirm:finance_disbursement` — the only permission that records a direct
   * dealership payment (owner ruling R1: only managers and accountants move
   * money). Everyone else is told who can, never offered a button that refuses.
   */
  canRecordDirectPayment?: boolean;
  /**
   * `confirm:finance_disbursement` — the permission `reconcileDealFee` checks,
   * which is NOT the one that records the line (`create:finance_application`).
   * Without it a line awaiting reconciliation shows who can, never a button
   * that refuses (SCRUM-446).
   */
  canReconcile?: boolean;
  /** Records the dealership's own payment of a line. Rejects with `HandoverCostAttemptError`. */
  onRecordDirectPayment?: (feeId: string, values: DirectHandoverPayment) => Promise<void>;
  /** The form closed after an attempt whose result never arrived: that identity is over. */
  onAbandonDirectPayment?: (feeId: string, intentId: string) => void;
  /**
   * The lines the server's `HANDOVER_COSTS_PAID` check names as waiting on the
   * LEDGER (`feeIds` of that check while it is blocked): a direct payment
   * recorded but not yet posted (no open period for its date), or a payment
   * taken back whose reversal has not posted. The row alone cannot say so, and
   * a queued payment must never read as paid. Only lines already in a paid or
   * zero state are affected — a line the check names for having no payment
   * keeps its own row.
   */
  postingHoldFeeIds?: ReadonlyArray<string>;
  /**
   * The server's verdict on the `HANDOVER_COSTS_PAID` check, or undefined while
   * readiness is loading or unavailable. The green "paid" badge is shown ONLY
   * when this is READY — the one state in which the ledger proof has run over
   * every line and passed. Any other state cannot say a recorded payment is on
   * the books, so it is shown as recorded, not as paid.
   */
  handoverCostsCheck?: "READY" | "BLOCKED" | "UNAVAILABLE" | "NOT_APPLICABLE";
  /**
   * The server's verdict on the `CUSTODY_ON_LEDGER` check (SCRUM-443 v6). A
   * custody-paid line's emerald "Paid from custody" is shown ONLY when this is
   * READY (or the deal is closed): the row says a posting was made, the ledger
   * says whether it landed (a closed period queues it). Any other state, or none
   * while readiness loads, shows the neutral "Recorded — waiting for posting".
   */
  custodyLedgerCheck?: "READY" | "BLOCKED" | "UNAVAILABLE" | "NOT_APPLICABLE";
  /**
   * The deal is stopped: CANCELLED or REJECTED, derived by the cockpit from the
   * same app record the server's `dealAcceptsNewCustodyCash` reads (SCRUM-443).
   * A stopped deal is not closed by the normal path, so no closing check will
   * confirm its payments on the books: they are shown as recorded on a stopped
   * deal — no green claim of a settled cost — and no new payment is offered.
   * Labels follow the app status, not finalization: `cancelApplication` can leave
   * `finalizedSaleId` set on a CANCELLED deal, and `dealClosed` (the server's
   * economics-frozen verdict) still suppresses the edit notes on such a deal.
   * (A stop never reverses a direct payment: the money left.)
   */
  dealStopped?: DealStopped;
  /**
   * SCRUM-690: records the execution fee's actual as a new line, linked in the
   * same write (`recordExecutionFeeActual`). Rejects with `HandoverCostAttemptError`.
   */
  onRecordExecutionFee?: (values: ActualHandoverCost) => Promise<void>;
  /** The record form closed after an attempt whose result never arrived. */
  onAbandonExecutionFee?: () => void;
  /** Links an existing line as the execution fee's actual (`bindExecutionFeeLine`). */
  onLinkExecutionFee?: (feeId: string) => Promise<void>;
  /** Unlinks it, with a reason (`unbindExecutionFeeLine`). */
  onUnlinkExecutionFee?: (feeId: string, reason: string) => Promise<void>;
}>) {
  /** A direct-payment attempt is in flight or its outcome is UNKNOWN (lifted from the form). */
  const [paymentPending, setPaymentPending] = useState(false);
  /** The line whose direct-payment form is open. */
  const [payingId, setPayingId] = useState<string | null>(null);
  /** The configured row whose record form is open, by position. */
  const [recordingTemplateIndex, setRecordingTemplateIndex] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [reconcilingId, setReconcilingId] = useState<string | null>(null);
  /** The add form's intent while the form is open; null when it is not. */
  const [openIntent, setOpenIntent] = useState<AddIntent | null>(null);
  /** Every attempt that has gone out and is not yet resolved, by intentId. */
  const [attempts, setAttempts] = useState<Record<string, AddAttempt>>({});

  // A direct-payment form belongs to a line that is still payable. If the line
  // stops being payable the open-form marker is dropped, so the form can never
  // reappear later with a stale open state. While an attempt is in flight or its
  // outcome is UNKNOWN the edit / remove / reconcile openers are disabled
  // (`paymentPending`), so an opener can never unmount the form and lose the
  // notice or the frozen replay payload; an idle form still yields to them.
  // Eligibility lost while UNKNOWN: the server either committed the payment (the
  // line is re-served as PAID_DIRECT) or the deal stopped and refused it. Either
  // way the served row is authoritative and closing is correct; no replay is
  // needed, because a same-key replay could only return the stored result.
  const payingLine = payingId === null ? undefined : (costs?.lines ?? []).find((line) => line._id === payingId);
  const payingStale =
    payingId !== null &&
    (payingLine?.directPaymentEligible !== true ||
      (!paymentPending && (editingId !== null || voidingId !== null || reconcilingId !== null)));
  // Reset during render (React's derived-state pattern), not in an effect.
  if (payingStale) setPayingId(null);

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
  // Reconciling is its own permission, held by the accountant tier that may
  // not edit costs (`canManage`), so it is offered independently of editing —
  // and, like editing, never once the deal's economics are frozen.
  const mayReconcile = canReconcile && !dealClosed;
  const adding = openIntent !== null;
  /**
   * The payment state of one line (SCRUM-443), under the line's own row and
   * hidden while that line's edit/remove/reconcile form is open — changing the
   * amount reverses a direct payment, so the two are never offered together.
   */
  const paymentRow = (line: HandoverCostLine | undefined) =>
    line && editingId !== line._id && voidingId !== line._id && reconcilingId !== line._id ? (
      <HandoverPaymentRow
        line={line}
        money={money}
        denominationCode={denomination.code}
        dealClosed={dealClosed}
        dealStopped={dealStopped}
        canRecord={canRecordDirectPayment && onRecordDirectPayment !== undefined}
        postingHold={postingHoldFeeIds.includes(line._id)}
        proofConfirmed={handoverCostsCheck === "READY"}
        custodyConfirmed={custodyLedgerCheck === "READY"}
        paying={payingId === line._id && line.directPaymentEligible === true}
        busy={submittingAny || paymentPending}
        t={t}
        onOpen={() => {
          // An in-flight or UNKNOWN attempt keeps its form: no opener may swap it out.
          if (paymentPending) return;
          if (!closeAddForm()) return;
          setEditingId(null);
          setVoidingId(null);
          setReconcilingId(null);
          setRecordingTemplateIndex(null);
          setPayingId(line._id);
        }}
        onClose={(afterUnknown, intentId) => {
          if (afterUnknown && intentId) onAbandonDirectPayment?.(line._id, intentId);
          setPayingId(null);
        }}
        onPendingChange={setPaymentPending}
        onSubmit={async (values) => {
          await onRecordDirectPayment?.(line._id, values);
          setPayingId(null);
        }}
      />
    ) : null;

  return (
    <Card
      data-testid="deal-handover-costs"
      id="deal-handover-costs-panel"
      // Marks work in progress for the cockpit: a stage change that moves this
      // panel into the collapsed record must not hide an open form or an
      // attempt whose outcome is not known.
      data-active-task={
        adding ||
        unresolved.length > 0 ||
        payingId !== null ||
        recordingTemplateIndex !== null ||
        editingId !== null ||
        voidingId !== null ||
        reconcilingId !== null
          ? ""
          : undefined
      }
      tabIndex={-1}
      className="scroll-mt-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 pb-3">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Receipt className="h-4 w-4 shrink-0 text-money-out" aria-hidden />
            {t("HandoverCostsHeading")}
          </CardTitle>
          <p className="text-xs text-muted-foreground">{t("HandoverCostsNote")}</p>
          {/* Said at panel level, because the controls it explains are absent:
              once the sale is recognized the server refuses every edit that
              would move what was posted, so none is offered. */}
          {dealClosed && (
            <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="deal-handover-costs-frozen">
              {t("HandoverCostAfterCloseNote")}
            </p>
          )}
        </div>
        {canAdd && costs && !adding && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={submittingAny || costSource.kind === "LOADING"}
            onClick={openAdd}
          >
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
            costSource={costSource}
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

            {costs.executionFee && (
              <ExecutionFeeSection
                fee={costs.executionFee}
                lines={costs.lines}
                currency={denomination.code}
                scale={scaleOf(denomination.code)}
                money={money}
                canManage={canManage && !dealClosed}
                t={t}
                onRecord={onRecordExecutionFee}
                onAbandonRecord={onAbandonExecutionFee}
                onLink={onLinkExecutionFee}
                onUnlink={onUnlinkExecutionFee}
              />
            )}

            {/* The finance company's policy, as the deal froze it: one row per
                configured fee — what it says, what was actually paid, and the
                one action a row without an actual has. Nothing here is typed
                as an expectation. */}
            {expected && checklist && checklist.rows.length > 0 && (
              <section className="space-y-2" data-testid="deal-handover-expected">
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">{t("HandoverExpectedHeading")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("HandoverExpectedNote")}
                  </p>
                </div>
                <CostColumnHeadings expectedLabel={t("CostExpected")} t={t} />
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
                          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 md:grid md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
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
                              {/* A div, not a p: `Badge` renders a div, and a div inside a p is
                                  invalid HTML that the browser re-parents on hydration. */}
                              <div className="text-xs text-muted-foreground">
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
                              </div>
                            </div>
                            <div className="flex items-start gap-3 md:flex-row-reverse md:items-center">
                              <dl className="grid grid-cols-[auto_auto] gap-x-3 text-end text-xs md:w-56 md:grid-cols-2">
                                <dt className="text-muted-foreground md:sr-only">{t("CostExpected")}</dt>
                                <dd className="tabular-nums">
                                  {row.expectedAmountMinor === null ? (
                                    <span className="font-normal text-amber-700 dark:text-amber-400" data-testid={`deal-handover-expected-${row.templateIndex}-unreadable`}>
                                      {t("CostExpectedUnreadable")}
                                    </span>
                                  ) : (
                                    <bdi dir="ltr">{money(row.expectedAmountMinor, checklist.currency)}</bdi>
                                  )}
                                </dd>
                                <dt className="text-muted-foreground md:sr-only">{t("CostActual")}</dt>
                                <dd className="font-semibold tabular-nums text-money-out">
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
                                    setReconcilingId(null);
                                    setRecordingTemplateIndex(row.templateIndex);
                                  }}
                                >
                                  {t("RecordTemplateActual")}
                                </Button>
                              )}
                              {(canManage || mayReconcile) && row.actual !== null && row.actual.currency === denomination.code && lineFor(row) && (
                                <div className="flex gap-1">
                                  {canManage && row.actual.status !== "RECONCILED" && onReconcile && !canReconcile && (
                                    <span className="text-xs text-muted-foreground" data-testid={`deal-handover-reconcile-${row.actual.feeId}-waiting`}>
                                      {t("ReconcileNeedsAccountant")}
                                    </span>
                                  )}
                                  {mayReconcile && row.actual.status !== "RECONCILED" && onReconcile && (
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      className="h-7 w-7 text-emerald-600 hover:text-emerald-700"
                                      aria-label={t("ReconcileDealFee")}
                                      disabled={submittingAny || paymentPending}
                                      onClick={() => {
                                        if (!closeAddForm()) return;
                                        setRecordingTemplateIndex(null);
                                        setEditingId(null);
                                        setVoidingId(null);
                                        setReconcilingId(row.actual?.feeId ?? null);
                                      }}
                                    >
                                      <CheckCheck className="h-3.5 w-3.5" />
                                    </Button>
                                  )}
                                  {canManage && (
                                    <>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7"
                                        aria-label={t("RecordActualCost")}
                                        disabled={submittingAny || paymentPending}
                                        onClick={() => {
                                          if (!closeAddForm()) return;
                                          setRecordingTemplateIndex(null);
                                          setVoidingId(null);
                                          setReconcilingId(null);
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
                                        disabled={submittingAny || paymentPending}
                                        onClick={() => {
                                          if (!closeAddForm()) return;
                                          setRecordingTemplateIndex(null);
                                          setEditingId(null);
                                          setReconcilingId(null);
                                          setVoidingId(row.actual?.feeId ?? null);
                                        }}
                                      >
                                        <Trash2 className="h-3.5 w-3.5" />
                                      </Button>
                                    </>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                        {row.actual !== null && paymentRow(lineFor(row))}
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
                        {row.actual !== null && reconcilingId === row.actual.feeId && lineFor(row) && (
                          <div className="mt-3">
                            <ReconcileForm
                              t={t}
                              onCancel={() => setReconcilingId(null)}
                              onSubmit={async (notes) => {
                                if (onReconcile) {
                                  await onReconcile((lineFor(row) as HandoverCostLine)._id, notes);
                                }
                                setReconcilingId(null);
                              }}
                            />
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                <p className="pt-1 text-sm font-medium">{t("AdditionalCostsHeading")}</p>
              </section>
            )}

            {live.length === 0 && !adding && (
              <p className="text-sm text-muted-foreground">{t("NoHandoverCosts")}</p>
            )}

            {live.length > 0 && <CostColumnHeadings expectedLabel={t("CostEstimated")} t={t} />}
            <ul className="space-y-2">
              {live.map((line) => (
                <li
                  key={line._id}
                  className="rounded-md border p-3 text-sm"
                  data-testid={`deal-handover-cost-${line._id}`}
                >
                  {reconcilingId === line._id ? (
                    <ReconcileForm
                      t={t}
                      onCancel={() => setReconcilingId(null)}
                      onSubmit={async (notes) => {
                        if (onReconcile) {
                          await onReconcile(line._id, notes);
                        }
                        setReconcilingId(null);
                      }}
                    />
                  ) : editingId === line._id ? (
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
                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 md:grid md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
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
                        {/* A div, not a p — see the configured-fee row above. */}
                        <div className="text-xs text-muted-foreground">
                          <Badge variant="outline" className="me-1.5">
                            {t(STATUS_LABEL[line.status] ?? line.status)}
                          </Badge>
                          {line.receiptReference && (
                            <>
                              {t("ReceiptReferenceLabel")}: <bdi dir="ltr">{line.receiptReference}</bdi>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex items-start gap-3 md:flex-row-reverse md:items-center">
                        <dl className="grid grid-cols-[auto_auto] gap-x-3 text-end text-xs md:w-56 md:grid-cols-2">
                          <dt className="text-muted-foreground md:sr-only">{t("CostEstimated")}</dt>
                          <dd className="tabular-nums">
                            {line.estimatedAmountMinor === undefined ? (
                              <span className="text-muted-foreground">{t("FactUnavailable")}</span>
                            ) : (
                              <bdi dir="ltr">{money(line.estimatedAmountMinor, line.currency)}</bdi>
                            )}
                          </dd>
                          <dt className="text-muted-foreground md:sr-only">{t("CostActual")}</dt>
                          <dd className="font-semibold tabular-nums text-money-out">
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
                        {(canManage || mayReconcile) && isHandoverType(line.feeType) && line.currency === denomination.code && (
                          <div className="flex gap-1">
                            {canManage && line.actualAmountMinor !== undefined && line.status !== "RECONCILED" && onReconcile && !canReconcile && (
                              <span className="text-xs text-muted-foreground" data-testid={`deal-handover-reconcile-${line._id}-waiting`}>
                                {t("ReconcileNeedsAccountant")}
                              </span>
                            )}
                            {mayReconcile && line.actualAmountMinor !== undefined && line.status !== "RECONCILED" && onReconcile && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-emerald-600 hover:text-emerald-700"
                                aria-label={t("ReconcileDealFee")}
                                disabled={submittingAny || paymentPending}
                                onClick={() => {
                                  if (!closeAddForm()) return;
                                  setEditingId(null);
                                  setVoidingId(null);
                                  setReconcilingId(line._id);
                                }}
                              >
                                <CheckCheck className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            {canManage && (
                              <>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  aria-label={t("RecordActualCost")}
                                  disabled={submittingAny || paymentPending}
                                  onClick={() => {
                                    if (!closeAddForm()) return;
                                    setVoidingId(null);
                                    setReconcilingId(null);
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
                                  disabled={submittingAny || paymentPending}
                                  onClick={() => {
                                    if (!closeAddForm()) return;
                                    setEditingId(null);
                                    setReconcilingId(null);
                                    setVoidingId(line._id);
                                  }}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  {paymentRow(line)}
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
/**
 * Desktop column headings over a cost list (SCRUM-372). Hidden from assistive
 * technology because every row still carries its own (visually hidden) labels:
 * a screen reader hears "Expected · 250.000" per row, not a table it has to
 * map back. Below `md` the rows are cards with visible labels and this is gone.
 */
function CostColumnHeadings({ expectedLabel, t }: Readonly<{ expectedLabel: string; t: (key: string) => string }>) {
  return (
    <div
      aria-hidden
      className="hidden gap-x-4 px-3 text-xs font-medium text-muted-foreground md:grid md:grid-cols-[minmax(0,1fr)_auto]"
    >
      <span>{t("CostTypeLabel")}</span>
      <span className="grid w-56 grid-cols-2 gap-x-3 text-end">
        <span>{expectedLabel}</span>
        <span>{t("CostActual")}</span>
      </span>
    </div>
  );
}

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
    // "Not configured" and "configured but unreadable" are different facts;
    // only the second is a defect somebody has to fix.
    return expected.expectedTotalReason === "UNSAFE_AMOUNT" ? (
      <span className="font-normal text-amber-700 dark:text-amber-400" data-testid="deal-handover-expected-total-unreadable">
        {t("CostsExpectedTotalUnreadable")}
      </span>
    ) : (
      <span className="font-normal text-muted-foreground">{t("FactUnavailable")}</span>
    );
  }
  return (
    <bdi className="tabular-nums" dir="ltr">
      {money(expected.expectedTotalMinor, expected.currency)}
    </bdi>
  );
}

/** The add-cost form's "paid from custody" field: the payer choice and what it means now. */
function PaidBySection({
  costSource,
  payers,
  payer,
  payerGone,
  t,
  onChoose,
}: Readonly<{
  costSource: HandoverCostSource;
  payers: ReadonlyArray<HandoverCustodyPayer>;
  payer: HandoverCustodyPayer | null;
  payerGone: boolean;
  t: (key: string) => string;
  onChoose: (custodyId: Id<"financeDealCustody"> | null) => void;
}>) {
  return (
    <div className="space-y-1.5 sm:col-span-2">
      {costSource.kind === "CHARGE" && payers.length > 0 ? (
        <>
          <Label htmlFor="handover-cost-paid-by">{t("CostPaidFromCustodyLabel")}</Label>
          <select
            id="handover-cost-paid-by"
            className={selectClass}
            value={payer?.custodyId ?? ""}
            aria-invalid={payerGone}
            data-testid="deal-handover-cost-paid-by"
            onChange={(event) =>
              onChoose(payers.find((option) => option.custodyId === event.target.value)?.custodyId ?? null)
            }
          >
            {payer === null && (
              <option value="" disabled>
                {t("CostPaidByChoose")}
              </option>
            )}
            {payers.map((option) => (
              <option key={option.custodyId} value={option.custodyId}>
                {option.holderName}
              </option>
            ))}
          </select>
        </>
      ) : (
        <p className="text-sm font-medium" data-testid="deal-handover-cost-paid-by-fixed">
          {t("CostPaidFromCustodyHeading")}
        </p>
      )}
      <PaidByNotice costSource={costSource} payers={payers} payerGone={payerGone} t={t} onChoose={onChoose} />
    </div>
  );
}

function PaidByNotice({
  costSource,
  payers,
  payerGone,
  t,
  onChoose,
}: Readonly<{
  costSource: HandoverCostSource;
  payers: ReadonlyArray<HandoverCustodyPayer>;
  payerGone: boolean;
  t: (key: string) => string;
  onChoose: (custodyId: Id<"financeDealCustody"> | null) => void;
}>) {
  if (payerGone && payers.length === 0) {
    // Nothing is left to choose from: say where the cost goes now and
    // let the operator accept it explicitly, never by default.
    return (
      <div className="space-y-1.5" data-testid="deal-handover-cost-paid-by-gone">
        <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
          {t("CostPaidFromCustodyGoneNone")}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="deal-handover-cost-paid-by-release"
          onClick={() => onChoose(null)}
        >
          {t("CostPaidFromCustodyRelease")}
        </Button>
      </div>
    );
  }
  if (payerGone) {
    return (
      <p className="text-xs font-medium text-amber-700 dark:text-amber-400" data-testid="deal-handover-cost-paid-by-gone">
        {t("CostPaidFromCustodyGone")}
      </p>
    );
  }
  if (costSource.kind === "NONE") {
    return (
      <p className="text-xs font-medium text-amber-700 dark:text-amber-400" data-testid="deal-handover-cost-needs-custody">
        {t("HandoverCostNeedsCustody")}
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground" data-testid="deal-handover-cost-paid-by-note">
      {t(costSource.kind === "CHARGE" ? "CostPaidFromCustodyNote" : "CostPaidFromCustodyPendingNote")}
    </p>
  );
}

function AddForm({
  intent,
  attempt,
  dealClosed,
  costSource,
  t,
  onCancel,
  onSubmit,
}: Readonly<{
  /** Minted by the panel when the form opened; carries the captured denomination. */
  intent: AddIntent;
  /** The panel's record of this intent's attempt, or null before the first one. */
  attempt: AddAttempt | null;
  dealClosed: boolean;
  costSource: HandoverCostSource;
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
  /**
   * Whose custody the cash came out of, when this caller charges it directly.
   * The answer is what the operator SAW: the one record on offer when the
   * form opened, or their explicit pick. It is fixed at that moment, never
   * re-derived from the live read — a record swapped, closed or newly opened
   * under an open form would otherwise charge somebody else, or nobody,
   * without anyone choosing it. With several on offer, the form asks.
   */
  const payers = costSource.kind === "CHARGE" ? costSource.payers : [];
  const [chosenCustodyId, setChosenCustodyId] = useState<Id<"financeDealCustody"> | null>(() =>
    costSource.kind === "CHARGE" && costSource.payers.length === 1 ? costSource.payers[0].custodyId : null
  );
  const payer = payers.find((option) => option.custodyId === chosenCustodyId) ?? null;
  // The answered record stopped being offered while the form was open, or
  // custody stopped being open at all. Say so and let the operator decide.
  const payerGone = chosenCustodyId !== null && payer === null;
  const payerUnchosen = (costSource.kind === "CHARGE" && payer === null && !payerGone) || costSource.kind === "LOADING";
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
        if (payerGone) {
          setValidation(t("CostPaidFromCustodyGone"));
          return;
        }
        if (payerUnchosen) {
          setValidation(t("CostPaidByRequired"));
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
          paidAt: paidOn ? economicDateInputToMs(paidOn) : undefined,
          receiptReference: reference.trim() || undefined,
          custodyId: payer?.custodyId,
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
        <PaidBySection
          costSource={costSource}
          payers={payers}
          payer={payer}
          payerGone={payerGone}
          t={t}
          onChoose={setChosenCustodyId}
        />
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="handover-cost-description">{t("CostDescriptionLabel")}</Label>
          <Input
            id="handover-cost-description"
            maxLength={MAX_FEE_DESCRIPTION_CHARS}
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
            max={economicTodayDateInput()}
            value={paidOn}
            onChange={(event) => setPaidOn(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="handover-cost-reference">{t("ReceiptReferenceLabel")}</Label>
          <Input
            id="handover-cost-reference"
            maxLength={MAX_FEE_RECEIPT_REFERENCE_CHARS}
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
        <Button type="submit" size="sm" disabled={submitting || (!attempted && (amountMinor === null || payerGone || payerUnchosen))}>
          {submitting && <Loader2 className="h-4 w-4 me-1.5 animate-spin" />}
          {t(attempted ? "RetryHandoverCost" : "SaveHandoverCost")}
        </Button>
      </div>
    </form>
  );
}



/**
 * The one thing an operator enters on a configured row: what was actually
 * paid (with its date and receipt). The expectation on the row is the finance
 * company's and is shown, not typed; every other field of the resulting line
 * is copied server-side from the deal's frozen snapshot.
 */
/**
 * The finance company's execution fee (SCRUM-690 F-PNTR-1). It has ONE
 * expectation and ONE actual, and the actual is a cost line LINKED to it by id
 * — recorded here (zero when the company did not charge it), or an existing
 * finance-company fee line chosen from the server's eligible list. Until one is
 * linked the deal cannot finalize, and the profit estimate counts the expected
 * fee on top of what is recorded. The linked line itself is listed with the
 * other costs below, where its payment is recorded.
 */
function ExecutionFeeSection({
  fee,
  lines,
  currency,
  scale,
  money,
  canManage,
  t,
  onRecord,
  onAbandonRecord,
  onLink,
  onUnlink,
}: Readonly<{
  fee: HandoverExecutionFee;
  lines: ReadonlyArray<HandoverCostLine>;
  currency: string;
  scale: number;
  money: (minor: number, currency: string) => string;
  canManage: boolean;
  t: (key: string) => string;
  onRecord?: (values: ActualHandoverCost) => Promise<void>;
  onAbandonRecord?: () => void;
  onLink?: (feeId: string) => Promise<void>;
  onUnlink?: (feeId: string, reason: string) => Promise<void>;
}>) {
  const [mode, setMode] = useState<"IDLE" | "RECORD" | "UNLINK">("IDLE");
  const [linkId, setLinkId] = useState("");
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const bound = fee.boundFeeId === null ? undefined : lines.find((line) => line._id === fee.boundFeeId);
  const eligible = lines.filter((line) => fee.eligibleFeeIds.includes(line._id));
  const describe = (line: HandoverCostLine) =>
    `${line.description || t(FEE_TYPE_LABEL[line.feeType] ?? line.feeType)} · ${
      line.actualAmountMinor === undefined ? t("FactUnavailable") : money(line.actualAmountMinor, line.currency)
    }`;
  const row: ExpectedHandoverRow = {
    templateIndex: -1,
    feeType: "FINANCE_COMPANY_FEE",
    description: t("ExecutionFeeLabel"),
    expectedAmountMinor: fee.expectedMinor,
    expectedAmountReason: fee.expectedMinor === null ? "UNSAFE_AMOUNT" : null,
    duplicateIdentity: false,
    actual: null,
  };

  return (
    <section className="space-y-2 rounded-md border p-3 text-sm" data-testid="deal-execution-fee">
      {mode === "RECORD" && onRecord ? (
        <TemplateActualForm
          row={row}
          scale={scale}
          currency={currency}
          t={t}
          onCancel={(afterUnknown) => {
            if (afterUnknown) onAbandonRecord?.();
            setMode("IDLE");
          }}
          onSubmit={async (values) => {
            await onRecord(values);
            setMode("IDLE");
          }}
        />
      ) : mode === "UNLINK" && bound && onUnlink ? (
        <VoidForm
          t={t}
          copy={{ title: "ExecutionFeeUnlink", note: "ExecutionFeeUnlinkNote", confirm: "ExecutionFeeUnlink" }}
          onCancel={() => setMode("IDLE")}
          onSubmit={async (reason) => {
            await onUnlink(bound._id, reason);
            setMode("IDLE");
          }}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div className="min-w-0 space-y-1">
              <p className="font-medium">{t("ExecutionFeeLabel")}</p>
              <p className="text-xs text-muted-foreground">{t("ExecutionFeeNote")}</p>
            </div>
            <dl className="grid grid-cols-[auto_auto] gap-x-3 text-end text-xs">
              <dt className="text-muted-foreground">{t("CostExpected")}</dt>
              <dd className="tabular-nums">
                {fee.expectedMinor === null ? (
                  <span className="text-amber-700 dark:text-amber-400">{t("CostExpectedUnreadable")}</span>
                ) : (
                  <bdi dir="ltr">{money(fee.expectedMinor, currency)}</bdi>
                )}
              </dd>
              <dt className="text-muted-foreground">{t("CostActual")}</dt>
              <dd className="font-semibold tabular-nums text-money-out" data-testid="deal-execution-fee-actual">
                {bound?.actualAmountMinor === undefined ? (
                  <span className="font-normal text-muted-foreground">{t("CostNotRecorded")}</span>
                ) : (
                  <bdi dir="ltr">{money(bound.actualAmountMinor, bound.currency)}</bdi>
                )}
              </dd>
            </dl>
          </div>
          {fee.withheld && (
            <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="deal-execution-fee-withheld">
              {t("ProfitExecutionFeeUnclassified")}
            </p>
          )}
          {fee.unrecorded && (
            <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="deal-execution-fee-unrecorded">
              {t("ExecutionFeeUnrecorded")}
            </p>
          )}
          {canManage && fee.unrecorded && eligible.length === 0 && lines.length > 0 && (
            <p className="text-xs text-muted-foreground" data-testid="deal-execution-fee-recorded-elsewhere">
              {t("ExecutionFeeRecordedElsewhere")}
            </p>
          )}
          {bound && (
            <p className="text-xs text-muted-foreground" data-testid="deal-execution-fee-linked">
              {t("ExecutionFeeLinkedTo")}: <bdi>{describe(bound)}</bdi>
            </p>
          )}
          {canManage && fee.unrecorded && (
            <div className="flex flex-wrap items-end justify-end gap-2">
              {onLink && eligible.length > 0 && (
                <>
                  <div className="min-w-48 flex-1 space-y-1.5">
                    <Label htmlFor="deal-execution-fee-link">{t("ExecutionFeeLinkLabel")}</Label>
                    <select
                      id="deal-execution-fee-link"
                      className={selectClass}
                      value={linkId}
                      disabled={linking}
                      onChange={(event) => setLinkId(event.target.value)}
                    >
                      <option value="">{t("ExecutionFeeLinkPlaceholder")}</option>
                      {eligible.map((line) => (
                        <option key={line._id} value={line._id}>
                          {describe(line)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={linking || linkId === ""}
                    onClick={async () => {
                      setLinking(true);
                      setLinkError(null);
                      try {
                        await onLink(linkId);
                        setLinkId("");
                      } catch (caught) {
                        setLinkError(caught instanceof Error ? caught.message : t("UnexpectedError"));
                      } finally {
                        setLinking(false);
                      }
                    }}
                  >
                    {linking && <Loader2 className="h-4 w-4 me-1.5 animate-spin" />}
                    {t("ExecutionFeeLink")}
                  </Button>
                </>
              )}
              {onRecord && (
                <Button type="button" size="sm" disabled={linking} onClick={() => setMode("RECORD")}>
                  {t("ExecutionFeeRecord")}
                </Button>
              )}
            </div>
          )}
          {linkError && (
            <p role="alert" className="text-xs font-medium text-destructive">
              {linkError}
            </p>
          )}
          {canManage && bound && onUnlink && bound.directPayment === undefined && bound.handoverPayment !== "PAID_CUSTODY" && (
            <div className="flex justify-end">
              <Button type="button" size="sm" variant="ghost" onClick={() => setMode("UNLINK")}>
                {t("ExecutionFeeUnlink")}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

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
                paidAt: paidOn ? economicDateInputToMs(paidOn) : undefined,
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
        {t("CostExpected")}:{" "}
        {row.expectedAmountMinor === null ? (
          <span className="text-amber-700 dark:text-amber-400">{t("CostExpectedUnreadable")}</span>
        ) : (
          <bdi dir="ltr">{row.expectedAmountMinor / Math.pow(10, scale)} {currency}</bdi>
        )}
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
            max={economicTodayDateInput()}
            value={paidOn}
            onChange={(event) => setPaidOn(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${fieldId}-reference`}>{t("ReceiptReferenceLabel")}</Label>
          <Input
            id={`${fieldId}-reference`}
            maxLength={MAX_FEE_RECEIPT_REFERENCE_CHARS}
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
            paidAt: paidOn ? economicDateInputToMs(paidOn) : undefined,
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
            max={economicTodayDateInput()}
            value={paidOn}
            onChange={(event) => setPaidOn(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`actual-reference-${line._id}`}>{t("ReceiptReferenceLabel")}</Label>
          <Input
            id={`actual-reference-${line._id}`}
            maxLength={MAX_FEE_RECEIPT_REFERENCE_CHARS}
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
  copy = { title: "RemoveHandoverCost", note: "VoidCostNote", confirm: "ConfirmRemoveCost" },
}: Readonly<{
  t: (key: string) => string;
  onCancel: () => void;
  onSubmit: (reason: string) => Promise<void>;
  /** Translation keys, for a reasoned action that is not removing the cost. */
  copy?: { title: string; note: string; confirm: string };
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
      <p className="font-medium text-destructive">{t(copy.title)}</p>
      <p className="text-xs text-muted-foreground">{t(copy.note)}</p>
      <div className="space-y-1.5">
        <Label htmlFor="void-reason">{t("VoidReasonLabel")}</Label>
        <Input
          id="void-reason"
          maxLength={MAX_FEE_VOID_REASON_CHARS}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
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
          {t(copy.confirm)}
        </Button>
      </div>
    </form>
  );
}

function ReconcileForm({
  t,
  onCancel,
  onSubmit,
}: Readonly<{
  t: (key: string) => string;
  onCancel: () => void;
  onSubmit: (notes: string) => Promise<void>;
}>) {
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!notes.trim()) {
          setError(t("ReconcileNotesRequired"));
          return;
        }
        setSubmitting(true);
        setError(null);
        try {
          await onSubmit(notes.trim());
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : t("UnexpectedError"));
        } finally {
          setSubmitting(false);
        }
      }}
    >
      <p className="font-medium text-emerald-600">{t("ReconcileDealFee")}</p>
      <p className="text-xs text-muted-foreground">{t("ReconcileFeeNote")}</p>
      <div className="space-y-1.5">
        <Label htmlFor="reconcile-notes">{t("ReconcileNotes")}</Label>
        <Input
          id="reconcile-notes"
          maxLength={MAX_FEE_RECONCILIATION_NOTES_CHARS}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder={t("ReconcileNotesPlaceholder")}
          required
        />
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
        <Button type="submit" size="sm" disabled={submitting || !notes.trim()}>
          {submitting && <Loader2 className="h-4 w-4 me-1.5 animate-spin" />}
          {t("ConfirmReconcile")}
        </Button>
      </div>
    </form>
  );
}

/**
 * One line's payment state (SCRUM-443): who paid it and whether it is on the
 * books, and — for the one state that blocks the deal and that this caller may
 * fix — the action. Every sentence is next-step copy (R6, no dead ends):
 *   - unpaid, dealership's own: a manager/accountant records the payment here;
 *     anyone else is told exactly that;
 *   - unpaid, employee's: charge it to that employee's custody;
 *   - no actual: record the amount first.
 */
function HandoverPaymentRow({
  line,
  money,
  denominationCode,
  dealClosed,
  dealStopped,
  canRecord,
  postingHold,
  proofConfirmed,
  custodyConfirmed,
  paying,
  busy,
  t,
  onOpen,
  onClose,
  onPendingChange,
  onSubmit,
}: Readonly<{
  line: HandoverCostLine;
  money: (minor: number, currency: string) => string;
  denominationCode: string;
  dealClosed: boolean;
  /** The deal is stopped (cancelled or rejected): its payments are recorded, never settled, and none is offered. */
  dealStopped: DealStopped;
  canRecord: boolean;
  /** The server's closing check names this line as waiting on the ledger. */
  postingHold: boolean;
  /** `HANDOVER_COSTS_PAID` is READY: every direct payment is proven on the ledger. */
  proofConfirmed: boolean;
  /** `CUSTODY_ON_LEDGER` is READY: every custody-paid line is proven on the ledger. */
  custodyConfirmed: boolean;
  paying: boolean;
  busy: boolean;
  t: (key: string) => string;
  onOpen: () => void;
  onClose: (afterUnknown: boolean, intentId: string | null) => void;
  onPendingChange: (pending: boolean) => void;
  onSubmit: (values: DirectHandoverPayment) => Promise<void>;
}>) {
  const state = line.handoverPayment;
  const stoppedLabel = dealStopped === "REJECTED" ? "HandoverPaymentRecordedRejected" : "HandoverPaymentRecordedCancelled";
  if (state === undefined || state === "NOT_HANDOVER_LINE") return null;
  const testId = `deal-handover-payment-${line._id}`;

  // A zero actual is exempt from payment — unless an earlier payment of it is
  // still on the books because its reversal is waiting for a period to open.
  if (state === "ZERO_ACTUAL") {
    if (!postingHold) return null;
    return (
      <p className="mt-2 text-xs text-amber-700 dark:text-amber-400" data-testid={testId} data-state="REVERSAL_PENDING">
        {t("HandoverPaymentReversalPending")}
      </p>
    );
  }

  if (state === "PAID_CUSTODY") {
    // The row says a custody posting was made; only the ledger check says it
    // landed. A stopped deal is shown by its app status (a cancel can leave
    // `finalizedSaleId` set, so finalization is not the test), so its cost is recorded, not
    // settled; a CLOSED deal was proven before it could close (SCRUM-443 v6).
    const settled = dealStopped === null && (dealClosed || custodyConfirmed);
    const shown = dealStopped !== null ? `PAID_CUSTODY_${dealStopped}` : settled ? state : "PAID_CUSTODY_UNCONFIRMED";
    return (
      <div className="mt-2 text-xs" data-testid={testId} data-state={shown}>
        <Badge
          variant="outline"
          className={
            settled
              ? "border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-400"
              : "text-muted-foreground"
          }
        >
          {t(dealStopped !== null ? stoppedLabel : settled ? "HandoverPaymentPaidCustody" : "HandoverPaymentCustodyRecorded")}
        </Badge>
      </div>
    );
  }
  if (state === "PAID_DIRECT") {
    const paid = line.directPayment;
    // A stopped deal is labelled by its app status, whatever `finalizedSaleId`
    // says: its payments are shown as recorded on a stopped deal (the cash did
    // leave), never as paid or settled. A CLOSED
    // deal is finalized — the closing check proved every payment on the books
    // before it could close — and shows the settled state whatever a later read
    // of readiness says. Open deals keep the ledger-proof rules below.
    const shown = dealStopped !== null ? `PAID_DIRECT_${dealStopped}` : dealClosed ? state : postingHold ? "PAID_DIRECT_QUEUED" : proofConfirmed ? state : "PAID_DIRECT_UNCONFIRMED";
    const settled = dealStopped === null && (dealClosed || (!postingHold && proofConfirmed));
    const queued = dealStopped === null && !dealClosed && postingHold;
    // Recorded on the row is not on the books: while the server says the
    // posting has not landed (no open period for its date, not yet processed),
    // the line is shown as waiting, never as paid.
    return (
      <div className="mt-2 space-y-1 text-xs" data-testid={testId} data-state={shown}>
        <Badge
          variant="outline"
          className={
            queued
              ? "border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400"
              : settled
                ? "border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-400"
                : "text-muted-foreground"
          }
        >
          {t(dealStopped !== null ? stoppedLabel : queued ? "HandoverPaymentQueued" : settled ? "HandoverPaymentPaidDirect" : "HandoverPaymentRecordedUnconfirmed")}
        </Badge>
        {paid && (
          <span className="ms-2 text-muted-foreground">
            {t(`PaymentMethod_${paid.method}`)}
            {" · "}
            <bdi dir="ltr" className="tabular-nums">
              {new Date(paid.paidAt).toISOString().slice(0, 10)}
            </bdi>
            {paid.reference && (
              <>
                {" · "}
                <bdi dir="ltr">{paid.reference}</bdi>
              </>
            )}
          </span>
        )}
        {queued && <p className="text-amber-700 dark:text-amber-400">{t("HandoverPaymentQueuedNote")}</p>}
        {!dealClosed && (
          <p className="text-muted-foreground">{t(dealStopped !== null ? "DirectPaymentChangeNoteStopped" : "DirectPaymentChangeNote")}</p>
        )}
      </div>
    );
  }
  if (state === "NO_ACTUAL") {
    return (
      <p className="mt-2 text-xs text-amber-700 dark:text-amber-400" data-testid={testId} data-state={state}>
        {t("HandoverPaymentNoActual")}
      </p>
    );
  }
  if (state === "UNSUPPORTED_TREATMENT" || state === "DEDUCTION_NOT_RECOGNISED") {
    return (
      <p role="alert" className="mt-2 text-xs font-medium text-destructive" data-testid={testId} data-state={state}>
        {t(
          line.source === "COMPANY_TEMPLATE"
            ? "HandoverPaymentLegacyTemplateReview"
            : dealStopped !== null
              ? dealClosed
                ? "HandoverPaymentUntreatableStopped"
                : line.paidBy === "EMPLOYEE"
                  ? "HandoverPaymentUntreatableStoppedEmployee"
                  : "HandoverPaymentUntreatableStoppedRemove"
              : state === "UNSUPPORTED_TREATMENT"
              ? "HandoverPaymentUnsupportedTreatment"
              : "HandoverPaymentDeductionNotRecognised"
        )}
      </p>
    );
  }
  if (state === "CONFLICT") {
    return (
      <p role="alert" className="mt-2 text-xs font-medium text-destructive" data-testid={testId} data-state={state}>
        {t("HandoverPaymentConflict")}
      </p>
    );
  }

  // UNPAID — the state that blocks the deal.
  // A stopped deal (cancelled or rejected) offers no NEW payment whatever the
  // separately-fetched `directPaymentEligible` says: that read can lag the app
  // status during the transition, and the server refuses the payment anyway.
  const payable = line.directPaymentEligible === true && line.currency === denominationCode && dealStopped === null;
  return (
    <div className="mt-2 space-y-2 text-xs" data-testid={testId} data-state={state}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Badge variant="outline" className="border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400">
          {t("HandoverPaymentUnpaid")}
        </Badge>
        {payable && !dealClosed && canRecord && !paying && (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onOpen} data-testid={`${testId}-record`}>
            {t("RecordDirectPayment")}
          </Button>
        )}
        {payable && !dealClosed && !canRecord && (
          <span className="text-muted-foreground" data-testid={`${testId}-waiting`}>
            {t("DirectPaymentWaiting")}
          </span>
        )}
        {!payable && line.paidBy === "EMPLOYEE" && (
          <span className="text-muted-foreground" data-testid={`${testId}-custody`}>
            {t("HandoverPaymentNeedsCustody")}
          </span>
        )}
        {dealStopped !== null && line.paidBy !== "EMPLOYEE" && (
          <span className="text-muted-foreground" data-testid={`${testId}-stopped`}>
            {t("HandoverPaymentStoppedNoNewPayment")}
          </span>
        )}
      </div>
      {paying && payable && canRecord && (
        <DirectPaymentForm line={line} money={money} t={t} onCancel={onClose} onPendingChange={onPendingChange} onSubmit={onSubmit} />
      )}
    </div>
  );
}

function DirectPaymentForm({
  line,
  money,
  t,
  onCancel,
  onPendingChange,
  onSubmit,
}: Readonly<{
  line: HandoverCostLine;
  money: (minor: number, currency: string) => string;
  t: (key: string) => string;
  onCancel: (afterUnknown: boolean, intentId: string | null) => void;
  onPendingChange: (pending: boolean) => void;
  onSubmit: (values: DirectHandoverPayment) => Promise<void>;
}>) {
  const [intentId, setIntentId] = useState(() => crypto.randomUUID());
  const [method, setMethod] = useState<DirectPaymentMethodChoice | "">("");
  const [paidOn, setPaidOn] = useState(economicTodayDateInput());
  const [reference, setReference] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The exact payload of an attempt whose response was lost — replayed verbatim, never re-read from the fields. */
  const [unknownSent, setUnknownSent] = useState<DirectHandoverPayment | null>(null);
  /**
   * The amount the operator is approving, PINNED when the form opened. It is
   * what the header shows and what is sent; an edit by somebody else while the
   * form is open is never adopted silently — it raises a notice, and only the
   * operator's explicit re-pin changes what Save approves. The server refuses a
   * pinned figure that no longer matches the line.
   */
  const [pinnedMinor, setPinnedMinor] = useState<number | undefined>(() => line.actualAmountMinor);
  const changedTo = line.actualAmountMinor !== pinnedMinor ? line.actualAmountMinor : undefined;
  const frozen = unknownSent !== null;
  const id = `direct-payment-${line._id}`;
  // Tell the panel while an attempt is in flight or its outcome is UNKNOWN, so it
  // can keep other openers from unmounting this form; cleared on unmount.
  useEffect(() => {
    onPendingChange(submitting || frozen);
    return () => onPendingChange(false);
  }, [submitting, frozen, onPendingChange]);

  const submit = async () => {
    let values = unknownSent;
    if (values === null) {
      if (method === "") {
        setError(t("DirectPaymentMethodRequired"));
        return;
      }
      if (!paidOn) {
        setError(t("DirectPaymentDateRequired"));
        return;
      }
      // The PINNED figure is the one being approved, never the live one.
      if (pinnedMinor === undefined) {
        setError(t("HandoverPaymentNoActual"));
        return;
      }
      values = {
        intentId,
        method,
        paidAt: economicDateInputToMs(paidOn),
        reference: reference.trim() || undefined,
        expectedAmountMinor: pinnedMinor,
      };
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(values);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : t("UnexpectedError");
      if (caught instanceof HandoverCostAttemptError && caught.outcome === "UNKNOWN") {
        // The payment may already be recorded: keep the identity, freeze the fields.
        setUnknownSent(values);
      } else {
        // The server's own answer — nothing committed; the next attempt is a new command.
        setUnknownSent(null);
        setIntentId(crypto.randomUUID());
      }
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className="space-y-3 rounded-md border bg-muted/30 p-3"
      data-testid={`${id}-form`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="text-sm font-medium">
        {t("RecordDirectPayment")} · {t(FEE_TYPE_LABEL[line.feeType] ?? line.feeType)}
        {pinnedMinor !== undefined && (
          <>
            {" · "}
            <bdi dir="ltr" className="tabular-nums" data-testid={`${id}-pinned`}>
              {money(pinnedMinor, line.currency)}
            </bdi>
          </>
        )}
      </p>
      {changedTo !== undefined && !frozen && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
          data-testid={`${id}-changed`}
        >
          <span>
            {t("DirectPaymentAmountChanged")} <bdi dir="ltr">{money(changedTo, line.currency)}</bdi>
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={submitting}
            data-testid={`${id}-repin`}
            onClick={() => setPinnedMinor(changedTo)}
          >
            {t("DirectPaymentUseNewAmount")}
          </Button>
        </div>
      )}
      <p className="text-muted-foreground">{t("DirectPaymentNote")}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-method`}>{t("DirectPaymentMethodLabel")}</Label>
          <select
            id={`${id}-method`}
            className={selectClass}
            value={method}
            disabled={frozen || submitting}
            required
            onChange={(event) => setMethod(event.target.value as DirectPaymentMethodChoice | "")}
          >
            <option value="">{t("DirectPaymentMethodChoose")}</option>
            {DIRECT_PAYMENT_METHODS.map((option) => (
              <option key={option} value={option}>
                {t(`PaymentMethod_${option}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-date`}>{t("CostPaidOnLabel")}</Label>
          <Input
            id={`${id}-date`}
            type="date"
            max={economicTodayDateInput()}
            value={paidOn}
            disabled={frozen || submitting}
            required
            onChange={(event) => setPaidOn(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-reference`}>{t("ReceiptReferenceLabel")}</Label>
          <Input
            id={`${id}-reference`}
            maxLength={MAX_DIRECT_PAYMENT_REFERENCE_CHARS}
            value={reference}
            disabled={frozen || submitting}
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
        <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={() => onCancel(frozen, frozen ? intentId : null)}>
          {t("Cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={submitting || (!frozen && method === "")}>
          {submitting && <Loader2 className="h-4 w-4 me-1.5 animate-spin" />}
          {t(frozen ? "RetryHandoverCost" : "SaveDirectPayment")}
        </Button>
      </div>
    </form>
  );
}