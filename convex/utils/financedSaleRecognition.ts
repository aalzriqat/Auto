import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { computeExpectedRemittance } from "../../lib/financingEconomics";
import {
  buildFinancedSalePostingPlan,
  checkLegalInvoice,
  treatmentPosting,
  type FinancedSalePostingPlan,
  type SettlementComponentInput,
} from "./financedSalePostingPlan";
import {
  configuredFeesRefusal,
  custodyReadabilityRefusal,
  loadActiveFees,
  loadCustodyRecords,
  settlementDeductedActualMinor,
  settlementDeductedFees,
  summarizeReadableCustody,
} from "./settlementDeductions";
import { MAX_DEAL_CUSTODY_DECISION_RECORDS, MAX_LIVE_DEAL_FEE_LINES } from "./dealCostLimits";
import {
  reasonOf,
  redactClosingRefusal,
  type ClosingReadinessCheckKey,
  type TaggedClosingRefusal,
  type ClosingReadinessReason,
  type ClosingReadinessReasonCode,
  type ClosingReadinessReasonParams,
} from "../../lib/closingReadinessReasonCodes";
import type { AppErrorData } from "./errors";
import {
  custodyLedgerFamilyRefusal,
} from "./custodySourceLedger";
import { DirectProofBudget, directPaymentLedgerProof } from "./handoverDirectProof";
import { heldDepositRowsForVehicle } from "./saleCompletion";
import { liveAppliedMinorForDeposit } from "./depositApplications";
import { toMinorUnits } from "./money";
import { requireCustomerGapToDealer } from "./financingEconomics";
import { summarizeFees } from "./feeSummary";
import { consignedSettlementRoute, dealershipCollectsGross, isConsignedAgentSale } from "./vehicleOwnership";
import {
  blockingHandoverLines,
  handoverPaymentState,
  type HandoverPaymentState,
  type HandoverScope,
} from "./handoverCostPayment";

/**
 * Turns one finance application into the plan its sale will post from, or
 * refuses.
 *
 * Everything here is read from the record. No figure is supplied by a caller,
 * none is inferred from the gap between two others, and there is no partial
 * result: either the whole plan is derivable or finalization stops before it has
 * written anything.
 *
 * Several refusals here are NOT scoped to the deals the plan covers: a
 * configured fee with no actual recorded, and custody that is not on the books
 * or not settled, stop finalization on every route, before the coverage
 * question is asked. See `evaluateClosingReadiness`.
 */

/**
 * Whether this deal's money goes straight from the finance company to the
 * supplier, so nothing gross ever reaches the dealership's books — the pre-sale
 * reading (the live vehicle), shared by finalization and the cost screen so the
 * two cannot disagree about whether the plan covers the deal. Fails closed onto
 * the ordinary path: a route naming a supplier settlement on dealer-owned stock
 * is a contradiction, not a direct deal.
 */
// KEEP IN STEP with `settlesDirectToSupplier` in convex/applications.ts (a byte-pinned protected file that cannot import this without a pin renewal); a tripwire test compares the two bodies.
export async function dealSettlesDirect(ctx: QueryCtx | MutationCtx, app: Doc<"financeApplications">): Promise<boolean> {
  if (dealershipCollectsGross(consignedSettlementRoute(app))) return false;
  const vehicle = await ctx.db.get(app.vehicleId);
  return vehicle != null && isConsignedAgentSale(vehicle);
}

/** The deal modes a quote or application carries. */
export type DealMode = NonNullable<Doc<"financeApplications">["quoteModeAtSubmission"]>;

/**
 * The deal's mode as finalizeDeal reads it: frozen at submission, else the
 * quote's (same organization only).
 */
export async function dealModeOf(ctx: QueryCtx | MutationCtx, app: Doc<"financeApplications">): Promise<DealMode | undefined> {
  if (app.quoteModeAtSubmission !== undefined) return app.quoteModeAtSubmission;
  const quote = await ctx.db.get(app.quoteId);
  return quote && quote.orgId === app.orgId ? quote.mode : undefined;
}

/**
 * Whether COSTS_CLOSABLE applies (SCRUM-446): the deal settles through the
 * dealership AND either the plan covers it (a configured company) or its mode
 * is a financed one that names no configured company. CASH and an absent mode
 * stay out of scope (deferred to SCRUM-455). The ONE predicate both the
 * readiness query and finalization reach through `evaluateClosingReadiness`.
 */
export function costsGateApplies(
  app: Doc<"financeApplications">,
  opts: { settlesDirect: boolean; mode?: DealMode }
): boolean {
  if (opts.settlesDirect) return false;
  if (financedSaleRecognitionApplies(app, opts)) return true;
  return opts.mode === "MANUAL_FINANCE_COMPANY" || opts.mode === "LEASE" || opts.mode === "INTERNAL_INSTALLMENT";
}

/** Deals this model covers. Everything else posts the way it always did. */
export function financedSaleRecognitionApplies(
  app: Doc<"financeApplications">,
  opts: { settlesDirect: boolean }
): boolean {
  // On the direct route the financing company pays the supplier, so no
  // dealership-side finance receivable exists to recognise. Without a configured
  // company there is no counterparty to owe one.
  if (opts.settlesDirect) return false;
  return app.companyId !== undefined;
}

/**
 * What "this deal's costs are closable" means, asked of the live rows at the
 * moment of finalization: at least one live line; every live line in the
 * deal's currency; every live amount a readable figure (the summary's own
 * verdict, which also refuses an overflowing sum); every line carrying an
 * actual; every actual reconciled. An estimate-less line recorded against a
 * configured position passes — it carries a real, reconciled actual — and the
 * configured positions themselves are proven by `assertConfiguredFeesRecorded`.
 */
function costsClosableRefusal(liveFees: ReadonlyArray<Doc<"financeDealFees">>, currency: string): ClosingReadinessReason | null {
  if (liveFees.length === 0) {
    return reasonOf(
      "COSTS_NONE",
      "No costs are itemized on this deal, so its accounting cannot be finalized. Record them, or a zero-cost line saying the dealership bore none, before finalizing."
    );
  }
  const foreign = liveFees.filter((fee) => fee.currency !== currency);
  if (foreign.length > 0) {
    return reasonOf(
      "COSTS_FOREIGN_CURRENCY",
      `${foreign.length} cost line(s) on this deal are not in ${currency}, so its costs cannot be finalized until the records agree.`,
      { count: foreign.length, currency }
    );
  }
  const summary = summarizeFees([...liveFees]);
  if (summary.amountsUnreadable !== null) {
    return reasonOf(
      "COSTS_AMOUNT_UNREADABLE",
      "A cost amount on this deal is not a readable figure, so its accounting cannot be finalized until the line is corrected."
    );
  }
  if (summary.linesAwaitingActual > 0) {
    return reasonOf(
      "COSTS_AWAITING_ACTUAL",
      `${summary.linesAwaitingActual} cost(s) on this deal have no actual amount recorded, so its accounting cannot be finalized. Record them before finalizing.`,
      { count: summary.linesAwaitingActual }
    );
  }
  if (summary.linesAwaitingReconciliation > 0) {
    return reasonOf(
      "COSTS_AWAITING_RECONCILIATION",
      `${summary.linesAwaitingReconciliation} cost(s) on this deal have an amount nobody has checked, so its accounting cannot be finalized. Reconcile them before finalizing.`,
      { count: summary.linesAwaitingReconciliation }
    );
  }
  if (!summary.fullyReconciled) {
    return reasonOf("COSTS_NOT_RECONCILED", "This deal's costs are not fully reconciled, so its accounting cannot be finalized.");
  }
  // The plan posts every non-zero deducted line to its treatment's account and
  // refuses a treatment that has none (TREATMENT_UNMAPPED) — asked here too, so
  // the screen never reports READY for a deal the plan will refuse (Codex R407-2).
  const unmapped = settlementDeductedFees(liveFees).find(
    (fee) => fee.actualAmountMinor !== undefined && fee.actualAmountMinor !== 0 && treatmentPosting(fee.accountingTreatment) === null
  );
  if (unmapped !== undefined) {
    const feeLabel = unmapped.description?.trim() || humanizeFeeType(unmapped.feeType);
    return reasonOf(
      "COSTS_TREATMENT_UNMAPPED",
      `"${feeLabel}" is classified as ${unmapped.accountingTreatment}, which has no account to post to. Reclassify it before finalizing — it will not be posted to a general account instead.`,
      { feeLabel, treatment: unmapped.accountingTreatment }
    );
  }
  return null;
}

/**
 * Every custody record on the deal is settled: none still OPEN, and none
 * closed while its arithmetic says somebody still holds or is owed money
 * (SCRUM-407 P1.2). These are the two checks `classifyDealAccounting` made and
 * finalization did not — asked on EVERY route, because cash an employee holds
 * is a fact of the deal whatever the settlement route, and judged on the
 * readable balance (`summarizeReadableCustody`), never on the stored status: a
 * late cost against a RECONCILED record is exactly a closed record that no
 * longer balances. A WRITTEN_OFF record's residual is the loss the write-off
 * booked, so it is not asked to balance.
 */
function custodySettledRefusal(
  custodyRows: ReadonlyArray<Doc<"financeDealCustody">>,
  liveFees: ReadonlyArray<Doc<"financeDealFees">>
): ClosingReadinessReason | null {
  for (const row of custodyRows) {
    if (row.status === "OPEN") {
      return reasonOf(
        "CUSTODY_OPEN",
        "A custody record on this deal is still open. Settle what that person holds or is owed before finalizing."
      );
    }
    const unreadable = custodyReadabilityRefusal(row, liveFees, "finalizing this deal");
    if (unreadable !== null) return unreadable;
    const summary = summarizeReadableCustody(row, liveFees, "finalizing this deal");
    if (!summary.settled && row.status !== "WRITTEN_OFF") {
      return reasonOf(
        "CUSTODY_NO_LONGER_BALANCES",
        "A closed custody record on this deal no longer balances — its costs changed after it was reconciled. Reopen it and settle it before finalizing."
      );
    }
  }
  return null;
}

/**
 * Every live dealer-borne handover cost has a real payment on the books
 * (SCRUM-443): charged to the employee custody that paid it, or paid directly
 * by the dealership — `handoverCostPayment` is the one definition of both.
 * Asked on EVERY route, like `CUSTODY_SETTLED`: cash left the dealership
 * whatever the settlement route. A line with no actual is refused even off the
 * plan's routes (an unknown cost is not a paid one); a zero actual is exempt.
 * The first refusal names the most upstream problem — a line nobody has said
 * the cost of, then a line that is unpaid, then a contradictory one.
 */
function handoverCostsPaidRefusal(
  liveFees: ReadonlyArray<Doc<"financeDealFees">>,
  scope: HandoverScope
): ClosingReadinessReason | null {
  const states = liveFees.map((fee) => handoverPaymentState(fee, scope));
  const count = (state: HandoverPaymentState) => states.filter((s) => s === state).length;
  // A blocked line recorded from the finance company's legacy fee template is
  // counted apart from a manual one: nothing on the deal can correct it (a
  // manual replacement cannot satisfy CONFIGURED_FEES_RECORDED, and re-recording
  // the template copies the same frozen treatment), so the manual "remove and
  // add again" advice would be a loop (SCRUM-443 v7).
  const countBlockedBySource = (state: HandoverPaymentState, template: boolean) =>
    states.filter((s, i) => s === state && (liveFees[i].source === "COMPANY_TEMPLATE") === template).length;
  const legacyTemplate = countBlockedBySource("UNSUPPORTED_TREATMENT", true) + countBlockedBySource("DEDUCTION_NOT_RECOGNISED", true);
  const noActual = count("NO_ACTUAL");
  if (noActual > 0) {
    return reasonOf(
      "HANDOVER_COSTS_NO_ACTUAL",
      `${noActual} handover cost(s) on this deal have no actual amount recorded, so what was paid cannot be established. Record each one's actual (or zero if the dealership was charged nothing) before finalizing.`,
      { count: noActual }
    );
  }
  const unpaid = count("UNPAID");
  if (unpaid > 0) {
    return reasonOf(
      "HANDOVER_COSTS_UNPAID",
      `${unpaid} handover cost(s) on this deal have not been paid from a recorded source. Charge each to the employee custody that paid it, or record the dealership's direct payment, before finalizing.`,
      { count: unpaid }
    );
  }
  // A real cost no supported source can pay: it would reach no ledger account
  // (SCRUM-443 v6). Named with the door, in the deal's own words.
  if (legacyTemplate > 0) {
    return reasonOf(
      "HANDOVER_COSTS_LEGACY_TEMPLATE_REVIEW",
      `${legacyTemplate} handover cost(s) on this deal come from the finance company's older fee setup, and their accounting treatment cannot be paid or posted as recorded. They cannot be corrected from the deal. Ask an accountant or administrator to review them before finalizing.`,
      { count: legacyTemplate }
    );
  }
  const unsupported = countBlockedBySource("UNSUPPORTED_TREATMENT", false);
  if (unsupported > 0) {
    return reasonOf(
      "HANDOVER_COSTS_UNSUPPORTED_TREATMENT",
      `${unsupported} handover cost(s) on this deal are classified with a treatment no payment can be recorded against, so they would never reach the ledger. Remove each one and add it again as an ownership transfer, insurance or selling expense; each is then settled from the employee's custody or by a direct dealership payment, as applicable, before finalizing.`,
      { count: unsupported }
    );
  }
  const notRecognised = countBlockedBySource("DEDUCTION_NOT_RECOGNISED", false);
  if (notRecognised > 0) {
    return reasonOf(
      "HANDOVER_COSTS_DEDUCTION_NOT_RECOGNISED",
      `${notRecognised} handover cost(s) on this deal are marked as deducted from the finance company's settlement, but this deal has no configured financing plan to recognise a deduction, so they would never reach the ledger. Remove each one and record it again without the settlement deduction, then pay it directly or charge it to custody, before finalizing.`,
      { count: notRecognised }
    );
  }
  const conflict = count("CONFLICT");
  if (conflict > 0) {
    return reasonOf(
      "HANDOVER_COSTS_CONFLICT",
      `${conflict} handover cost(s) on this deal are recorded as paid both from employee custody and directly, which would count the cost twice. Have the line reviewed before finalizing.`,
      { count: conflict }
    );
  }
  return null;
}

/**
 * A direct payment is proven on the LEDGER, not on the row (SCRUM-443), for
 * EVERY line of the application that has ever carried one — live, zeroed or
 * voided — enumerated through `by_application_directPaymentVersion`, never
 * walked from the live lines alone. One rule, judged per line:
 *
 *   The only `HANDOVER_COST_PAID_DIRECT` version that may be POSTED is the
 *   live direct payment's own — and for a live PAID_DIRECT line that version
 *   MUST be POSTED. Every other version must not be POSTED.
 *
 * So (a) a live PAID_DIRECT line's forward event exists under its exact key
 * with status POSTED (queued in the outbox for a period that is not open,
 * PENDING, FAILED or absent all mean not on the books); and (b) every other
 * version is off the books — an earlier version of a live line whose reversal
 * has not landed, and ANY version of a line that is voided, zero-edited or
 * otherwise no longer paid directly, whose reversal was deferred while the
 * row was already cleared. (b) is `HANDOVER_DIRECT_REVERSAL_PENDING`: money
 * is still on the books that the row says was taken back, and the next step
 * is the accounting period, not the line.
 *
 * Read by `handoverDirectProof` (the line's event family by index, validated
 * canonical), every read charged to the proof's own budget, an expression of
 * the writers' caps (the evaluator's live-fee read is not charged to it); a ledger
 * that cannot be read completely, or a proof past its budget or caps, THROWS a
 * `ConvexError`, which the caller turns into UNAVAILABLE — never a pass.
 * `feeIds` name every line either refusal is about, so the screen can point at
 * the live ones.
 */
export async function handoverDirectLedgerRefusal(
  ctx: QueryCtx | MutationCtx,
  orgId: Doc<"financeApplications">["orgId"],
  applicationId: Doc<"financeApplications">["_id"],
  liveFees: ReadonlyArray<Doc<"financeDealFees">>,
  budget: DirectProofBudget = new DirectProofBudget()
): Promise<{ refusal: ClosingReadinessReason | null; feeIds: string[] }> {
  const { notOnLedger, reversalPending } = await directPaymentLedgerProof(ctx, orgId, applicationId, liveFees, budget);

  const feeIds = [...reversalPending, ...notOnLedger.filter((id) => !reversalPending.includes(id))];
  if (reversalPending.length > 0) {
    return {
      feeIds,
      refusal: reasonOf(
        "HANDOVER_DIRECT_REVERSAL_PENDING",
        `${reversalPending.length} direct handover payment(s) that were taken back on the cost line (removed, set to zero, or replaced) are still on the ledger: their reversal is waiting for an accounting period to open. A reversal is dated the day the payment was taken back (the void or amount change), not the payment date: open the accounting period that covers that date and let the accounting queue process, then finalize.`,
        { count: reversalPending.length }
      ),
    };
  }
  if (notOnLedger.length > 0) {
    return {
      feeIds,
      refusal: reasonOf(
        "HANDOVER_DIRECT_NOT_ON_LEDGER",
        `${notOnLedger.length} direct handover payment(s) are recorded but not on the ledger yet (the posting is queued because no accounting period is open for its date, or has not posted). Open the period and let the accounting queue process, then finalize.`,
        { count: notOnLedger.length }
      ),
    };
  }
  return { refusal: null, feeIds: [] };
}

/** One accounting condition a financed deal must meet before it can be finalized (the list lives beside the reason codes). */
export type { ClosingReadinessCheckKey };

/**
 * READY — met. BLOCKED — not met, with the reason. UNAVAILABLE — cannot be
 * judged because a required input is absent or unreadable; never read as met.
 * NOT_APPLICABLE — the condition does not exist on this deal's route.
 */
export type ClosingReadinessCheckStatus = "READY" | "BLOCKED" | "UNAVAILABLE" | "NOT_APPLICABLE";

export interface ClosingReadinessCheck {
  key: ClosingReadinessCheckKey;
  status: ClosingReadinessCheckStatus;
  /**
   * What is missing and what to do: the code the screen translates, its
   * params, and the English sentence kept as the diagnostic (SCRUM-414).
   * Null when READY or NOT_APPLICABLE.
   */
  reason: ClosingReadinessReason | null;
  /**
   * The cost lines a BLOCKED check is about, by id — only `HANDOVER_COSTS_PAID`
   * names any (SCRUM-443), so the screen can point at them. Ids, never amounts:
   * served whole to a caller below the finance tier, whose reasons are withheld.
   */
  feeIds?: string[];
}

export interface ClosingReadiness {
  /** UNAVAILABLE wins over BLOCKED: a verdict on missing inputs is not a verdict. */
  state: "READY" | "BLOCKED" | "UNAVAILABLE";
  /** In the order finalization asks them; finalization refuses on the first that is not met. */
  checks: ClosingReadinessCheck[];
}

/**
 * The evaluator's verdict. `ready` exactly when `readiness.state` is READY, and
 * only then does it carry the live cost lines the verdict was judged on.
 */
export type ClosingReadinessEvaluation =
  | { ready: true; readiness: ClosingReadiness; liveFees: Array<Doc<"financeDealFees">> }
  | { ready: false; readiness: ClosingReadiness };

/** UNAVAILABLE wins over BLOCKED; READY only when neither appears. */
function overallReadinessState(checks: ClosingReadinessCheck[]): ClosingReadiness["state"] {
  if (checks.some((check) => check.status === "UNAVAILABLE")) return "UNAVAILABLE";
  if (checks.some((check) => check.status === "BLOCKED")) return "BLOCKED";
  return "READY";
}

function messageOf(error: unknown): string {
  if (error instanceof ConvexError && typeof error.data === "string") return error.data;
  throw error;
}

/**
 * Why the one bounded read of the deal's rows failed, as a code: each of the
 * two reads refuses in exactly one way, its bound.
 */
function rowsUnavailableReason(read: "FEES" | "CUSTODY", error: unknown): ClosingReadinessReason {
  const message = messageOf(error);
  return read === "FEES"
    ? reasonOf("DEAL_ROWS_TOO_MANY_COST_LINES", message, { max: MAX_LIVE_DEAL_FEE_LINES })
    : reasonOf("DEAL_ROWS_TOO_MANY_CUSTODY_RECORDS", message, { max: MAX_DEAL_CUSTODY_DECISION_RECORDS });
}

/**
 * THE accounting readiness of a deal for finalization — one read-only
 * evaluator for the deal screen and the finalize door (SCRUM-407 P1.4).
 *
 * Accounting checks only: deposit treatment is an input to finalizing, not a
 * property of the deal's accounting, and is judged by the plan itself. Never
 * reads the retired `accountingClassification` stamp (P1.5). Every row is read
 * ONCE, bounded, and the checks and the plan are judged on those same rows.
 *
 * A refusal thrown by a shared predicate is caught ONLY to be reported as that
 * check's reason; nothing here writes, so catching commits nothing. Anything
 * other than a ConvexError is rethrown.
 */
export async function evaluateClosingReadiness(
  ctx: QueryCtx | MutationCtx,
  app: Doc<"financeApplications">,
  opts: { settlesDirect: boolean; currency: string }
): Promise<ClosingReadinessEvaluation> {
  const planCovered = financedSaleRecognitionApplies(app, opts);
  // The scope of the cost gate is decided HERE, once, for the readiness query
  // and for finalization alike (both reach this evaluator).
  const costsGateOn = costsGateApplies(app, { settlesDirect: opts.settlesDirect, mode: await dealModeOf(ctx, app) });
  const checks: ClosingReadinessCheck[] = [];
  const add = (key: ClosingReadinessCheckKey, status: ClosingReadinessCheckStatus, reason: ClosingReadinessReason | null) => {
    checks.push({ key, status, reason });
  };
  const planOnly = (key: ClosingReadinessCheckKey, judge: () => [ClosingReadinessCheckStatus, ClosingReadinessReason | null]) => {
    if (!planCovered) add(key, "NOT_APPLICABLE", null);
    else add(key, ...judge());
  };

  // The single figure the finance-company receivable is opened from. Unknown
  // means the server could not establish where the customer's money went, and
  // the honest answer is to refuse rather than fall back to the approved
  // amount, the quotation, or the customer's financing principal.
  planOnly("REMITTANCE_KNOWN", () => {
    if (app.expectedDealerRemittanceMinor !== undefined) return ["READY", null];
    if (app.approvedDealerPurchaseAmountMinor === undefined) {
      return [
        "UNAVAILABLE",
        reasonOf(
          "REMITTANCE_APPROVAL_MISSING",
          "The finance company's approved purchase amount is not recorded on this deal yet, so what it will actually remit to the dealership is not known. Record the approval before finalizing."
        ),
      ];
    }
    return [
      "BLOCKED",
      reasonOf(
        "REMITTANCE_UNKNOWN",
        "What this financing company will actually remit to the dealership is not known on this deal, so the amount it owes cannot be recorded. Resolve the reconciliation note on it before finalizing."
      ),
    ];
  });

  // ONE bounded read of the deal's live cost lines and custody records serves
  // every rule below; past the bound nothing can be judged, and that is
  // UNAVAILABLE, never a pass.
  // The two reads are independent; a failure of the cost-line read is reported
  // ahead of the custody read's, as when they ran one after the other.
  let rows: { fees: Array<Doc<"financeDealFees">>; custody: Array<Doc<"financeDealCustody">> } | null = null;
  let rowsUnavailable: ClosingReadinessReason | null = null;
  const [feesRead, custodyRead] = await Promise.allSettled([
    loadActiveFees(ctx, app._id),
    loadCustodyRecords(ctx, app._id, "finalizing this deal"),
  ]);
  if (feesRead.status === "rejected") rowsUnavailable = rowsUnavailableReason("FEES", feesRead.reason);
  else if (custodyRead.status === "rejected") rowsUnavailable = rowsUnavailableReason("CUSTODY", custodyRead.reason);
  else rows = { fees: feesRead.value, custody: custodyRead.value };

  /**
   * One check judged on the rows just read: UNAVAILABLE when they could not be
   * read; otherwise READY, or BLOCKED with the refusal. A ConvexError thrown
   * while judging becomes `onThrow` with its message, coded `throwCode` —
   * stated per check, since a refusal (BLOCKED) and an unreadable input
   * (UNAVAILABLE) are different verdicts. A check with `applies: false` is
   * NOT_APPLICABLE.
   */
  const onRows = async (
    key: ClosingReadinessCheckKey,
    spec: {
      onThrow: "BLOCKED" | "UNAVAILABLE";
      throwCode?: "CUSTODY_LEDGER_UNVERIFIABLE" | "HANDOVER_DIRECT_LEDGER_UNVERIFIABLE";
      /** false: NOT_APPLICABLE (wider than the plan's own coverage; see `costsGateApplies`). */
      applies?: boolean;
    },
    judge: (read: NonNullable<typeof rows>) => ClosingReadinessReason | null | Promise<ClosingReadinessReason | null>
  ) => {
    if (spec.applies === false) return add(key, "NOT_APPLICABLE", null);
    if (rows === null) return add(key, "UNAVAILABLE", rowsUnavailable);
    try {
      const refusal = await judge(rows);
      add(key, refusal === null ? "READY" : "BLOCKED", refusal);
    } catch (error) {
      add(key, spec.onThrow, reasonOf(spec.throwCode ?? "CHECK_REFUSED", messageOf(error)));
    }
  };

  // Every fee the finance company's FROZEN policy configures must have an
  // actual on the record — on EVERY route. A deal whose snapshot configures
  // nothing passes through untouched.
  await onRows("CONFIGURED_FEES_RECORDED", { onThrow: "BLOCKED" }, ({ fees }) =>
    configuredFeesRefusal(app.companyRuleSnapshot, fees, "finalizing")
  );

  // Every custody record and custody-paid line must be on the books as a
  // complete family — on EVERY route. Judged on the LEDGER as well as the rows;
  // a ledger that cannot be read is UNAVAILABLE, not a refusal.
  // The ledger proof has many refusals, whose detail (keys, versions, outbox
  // errors) stays in the English diagnostic: one code for "not on the books",
  // one for "could not be proven" (SCRUM-414).
  await onRows(
    "CUSTODY_ON_LEDGER",
    { onThrow: "UNAVAILABLE", throwCode: "CUSTODY_LEDGER_UNVERIFIABLE" },
    async ({ fees, custody }) => {
      const refusal = await custodyLedgerFamilyRefusal(ctx, app.orgId, app._id, custody, fees, "finalizing this deal");
      return refusal === null ? null : reasonOf("CUSTODY_NOT_ON_LEDGER", refusal);
    }
  );

  await onRows("CUSTODY_SETTLED", { onThrow: "BLOCKED" }, ({ fees, custody }) => custodySettledRefusal(custody, fees));

  // The CURRENT state of the deal's costs, judged on the rows just read.
  // Applies where `costsGateApplies` says (SCRUM-446): plan-covered deals, and
  // financed-mode deals that name no company. CASH and mode-less deals are out
  // of scope (SCRUM-455); the direct route is exempt.
  await onRows("COSTS_CLOSABLE", { onThrow: "BLOCKED", applies: costsGateOn }, ({ fees }) =>
    costsClosableRefusal(fees, opts.currency)
  );

  // Every dealer-borne handover cost is paid from a recorded source — on EVERY
  // route, NOT `planOnly` (SCRUM-443). The blocking lines travel with the
  // verdict so the screen can point at them.
  // Row verdicts first (a line with no source at all); only when every line
  // has one is each direct payment proven on the LEDGER — a ledger that cannot
  // be read is UNAVAILABLE, never READY.
  // Deductions are the plan's to recognise only where a plan covers the deal.
  const handoverScope: HandoverScope = { planRecognisesDeductions: planCovered };
  let ledgerFeeIds: string[] = [];
  await onRows(
    "HANDOVER_COSTS_PAID",
    { onThrow: "UNAVAILABLE", throwCode: "HANDOVER_DIRECT_LEDGER_UNVERIFIABLE" },
    async ({ fees }) => {
      const rowRefusal = handoverCostsPaidRefusal(fees, handoverScope);
      if (rowRefusal !== null) return rowRefusal;
      const proof = await handoverDirectLedgerRefusal(ctx, app.orgId, app._id, fees);
      ledgerFeeIds = proof.feeIds;
      return proof.refusal;
    }
  );
  const handoverCheck = checks[checks.length - 1];
  if (rows !== null && handoverCheck.status === "BLOCKED") {
    handoverCheck.feeIds =
      ledgerFeeIds.length > 0 ? ledgerFeeIds : blockingHandoverLines(rows.fees, handoverScope).map((fee) => fee._id as string);
  }

  // An unknown first payment is not zero (SCRUM-373): a quoted, approved deal
  // without one has no funding split to post from.
  planOnly("FIRST_PAYMENT_RECORDED", () =>
    app.submittedQuotationMinor !== undefined &&
    app.approvedDealerPurchaseAmountMinor !== undefined &&
    app.customerFirstPaymentMinor === undefined
      ? [
          "BLOCKED",
          reasonOf(
            "FIRST_PAYMENT_MISSING",
            "The customer's first payment is not recorded on this deal, so its funding split cannot be established. Record it before finalizing."
          ),
        ]
      : ["READY", null]
  );

  // Required while the v1 posting plan is in force: it posts revenue from the
  // legal invoice. Replacing that revenue source is SCRUM-411; until then the
  // invoice is a readiness item, and the panel offers the action that records it.
  planOnly("LEGAL_INVOICE_RECORDED", () => {
    const invoice = checkLegalInvoice({
      legalInvoiceConsiderationMinor: app.legalInvoiceAmountMinor,
      legalInvoiceIssuedTo: app.legalInvoiceIssuedTo,
      // Asked only on the plan's route, which requires a configured company.
      financierIsConfiguredExternal: true,
    });
    // The plan's own code tells absent, unusable and wrong-recipient apart.
    return invoice.ok ? ["READY", null] : ["BLOCKED", reasonOf(invoice.refusal.code, invoice.refusal.message)];
  });

  const state = overallReadinessState(checks);
  const readiness: ClosingReadiness = { state, checks };
  // A READY verdict is one every row check passed, so the rows were read.
  return state === "READY" && rows !== null
    ? { ready: true, readiness, liveFees: rows.fees }
    : { ready: false, readiness };
}

/**
 * What a refused finalize carries (SCRUM-414): the house `AppErrorData` shape —
 * the English sentence as `message`, which `getErrorMessage` shows — with the
 * readiness code, plus the params the deal screen translates it by.
 */
export type ClosingReadinessRefusalData = AppErrorData<ClosingReadinessReasonCode> & {
  params?: ClosingReadinessReasonParams;
};

/** A closing-readiness reason thrown as a finalize refusal, with the same data the readiness panel is served. */
export function closingRefusalError(reason: ClosingReadinessReason): ConvexError<ClosingReadinessRefusalData> {
  return new ConvexError<ClosingReadinessRefusalData>(reason);
}

/**
 * The first condition that is not met, tagged with its check key so the
 * refusal can be redacted to that check's WITHHELD code (SCRUM-414 R1). With
 * no unmet check to name, NOT_READY and no key.
 */
function firstUnmetRefusal(readiness: ClosingReadiness): TaggedClosingRefusal {
  const unmet = readiness.checks.find((check) => check.status === "BLOCKED" || check.status === "UNAVAILABLE");
  return {
    key: unmet?.key ?? null,
    reason: unmet?.reason ?? reasonOf("NOT_READY", "This deal is not ready to be finalized."),
  };
}

export async function resolveFinancedSalePlan(
  ctx: QueryCtx | MutationCtx,
  app: Doc<"financeApplications">,
  opts: {
    settlesDirect: boolean;
    currency: string;
    /**
     * What the operator said happens to any held deposit.
     *
     * Only an application to THIS purchase becomes `H` and reduces `N`. A
     * refund, a forfeiture or an offset against something the customer
     * separately owes each follows its own explicit accounting treatment,
     * exactly once — `ruleDepositRefunded` debits the liability and credits the
     * disbursement account, `ruleDepositForfeited` credits forfeiture income.
     * The money stays in `CUSTOMER_DEPOSITS_LIABILITY` only while no
     * disposition has executed yet.
     *
     * The shared property is narrower than "it stays a liability": these
     * dispositions do not become `H` and do not reduce what the financing
     * company owes.
     */
    depositTreatment?: string;
    /**
     * May the caller read the deal's money (`mayReadFinanceEconomics`)? A
     * readiness refusal is stated in full only when it may; below the finance
     * tier it is thrown as its check's WITHHELD code with no params, exactly
     * as `getClosingReadiness` serves it (SCRUM-414 R1). Required, so no
     * caller can forget to decide.
     */
    mayReadMoney: boolean;
  }
): Promise<FinancedSalePostingPlan | undefined> {
  // The finalize door re-runs the SAME evaluator the deal screen shows — never
  // a client's verdict, never the retired stamp — and refuses on the first
  // unmet condition, before anything is written (SCRUM-407 P1.4).
  const evaluation = await evaluateClosingReadiness(ctx, app, opts);
  // Thrown uncaught, before the first write, and redacted by the SAME pure
  // function the readiness query uses.
  if (!evaluation.ready) {
    throw closingRefusalError(redactClosingRefusal(firstUnmetRefusal(evaluation.readiness), opts.mayReadMoney));
  }

  if (!financedSaleRecognitionApplies(app, opts)) return undefined;
  // The plan is built from the same rows the READY verdict was judged on.
  const liveFees = evaluation.liveFees;

  const fees = settlementDeductedFees(liveFees);
  // The plan settles in `opts.currency` (the deal's pinned denomination at
  // finalize). A deducted line recorded in any other currency refuses here,
  // before the receivable is opened for a figure that mixed fils and cents.
  const feeDeductionsMinor = settlementDeductedActualMinor(fees, opts.currency);

  const snapshot = app.companyRuleSnapshot;
  const dealerContributionSettlement =
    app.dealerContributionSettlement ??
    snapshot?.dealerContributionSettlement ??
    "PAID_SEPARATELY";
  const customerContributionSettlement =
    app.customerContributionSettlement ??
    snapshot?.customerContributionSettlement ??
    "PASSED_THROUGH";
  const dealerContributionMinor = app.dealerContributionMinor ?? 0;

  // A contribution the company nets out of the settlement is part of what it
  // withholds, so it has to appear in the journal as its own classified line.
  // Nothing on the record says WHICH line: the twelve accounting treatments are
  // recorded per cost row, and a contribution is not a cost row. Guessing one —
  // a concession, an expense, a discount — would post real money to an account
  // nobody chose, and the three plausible answers land in different places on
  // the P&L.
  //
  // So this refuses, and says what is missing. It is the same rule the plan
  // builder applies to a fee whose treatment has no mapping; the only difference
  // is that here the treatment does not exist to be mapped.
  if (
    dealerContributionSettlement === "NETTED_FROM_REMITTANCE" &&
    dealerContributionMinor > 0
  ) {
    throw new ConvexError(
      "This financing company keeps the dealership's contribution out of what it transfers, and nothing on this deal records how that amount should be accounted for. Record it as a settlement-deducted cost with its own accounting treatment before finalizing."
    );
  }

  const grossDealerSettlementMinor =
    app.approvedDealerPurchaseAmountMinor === undefined
      ? undefined
      : computeExpectedRemittance({
          approvedDealerPurchaseAmountMinor: app.approvedDealerPurchaseAmountMinor,
          dealerContributionMinor,
          dealerContributionSettlement,
          customerContributionToFinanceCompanyMinor:
            app.customerContributionToFinanceCompanyMinor ?? 0,
          customerContributionSettlement,
          feeDeductionsMinor,
        }).grossRemittanceMinor;

  // A deducted line whose RECORDED actual is exactly zero withholds nothing and
  // is not a component: the company configured the fee and charged nothing for
  // it, which the handover-cost checklist records as a zero (a fact) rather
  // than leaving the line blank. `settlementDeductedActualMinor` already
  // contributes nothing for it; feeding it to the plan as a component would
  // have refused the deal for "no usable amount" — a refusal meant for a line
  // nobody quantified (`undefined`), which is still excluded here, and for a
  // corrupt negative, which still reaches the plan and is still refused.
  const components: SettlementComponentInput[] = fees
    .filter((fee) => fee.actualAmountMinor !== undefined && fee.actualAmountMinor !== 0)
    .map((fee) => ({
      sourceKind: "FEE" as const,
      sourceId: fee._id,
      label: fee.description?.trim() || humanizeFeeType(fee.feeType),
      amountMinor: fee.actualAmountMinor as number,
      treatment: fee.accountingTreatment,
    }));

  // What the customer independently owes the dealership on this deal — the gap
  // they are paying directly, in cash or by instalment. It is NOT the vehicle
  // consideration, which the financing company owes as the legal buyer.
  const customerReceivableMinor = requireCustomerGapToDealer(app, "building this sale's posting plan");

  // H — the deposit slice this sale actually consumes, read from the deposit
  // rows holding THIS car. Not `quote.downPayment`, which is an intention
  // recorded on a quote and may never have been paid; not
  // `customerFirstPaymentMinor`, which says what the customer owes toward the
  // purchase without saying who received it. A held deposit row is money that
  // moved, and it names the car it is holding — which is what makes this correct
  // on a quote covering several vehicles, where each sale must take its own
  // slice and no other.
  // A financed deal is single-vehicle, and `H` depends on it being so.
  //
  // `heldDepositRowsForVehicle` selects on `deposit.vehicleId`, which
  // `depositAllocation.ts` states plainly is "the quote's FIRST line item,
  // nothing more. Reading it as an allocation assigns the entire deposit to
  // whichever car was listed first, and leaves the others looking
  // undeposited." On a single-vehicle quote that is exactly right, and it is
  // the same predicate `resolveDepositsForQuote` applies when a deposit carries
  // no hold rows — so the plan and completion consume the identical slice.
  //
  // `applications.createFromQuote` refuses a multi-vehicle quote outright, so
  // no financed deal can be built on one today. That guard lives in another
  // file and could be relaxed by someone who never reads this one; if it were,
  // the first car would take the whole deposit as consideration while its
  // siblings took none, and the entry would still balance because `N` absorbs
  // the difference. The dealership would under-bill the financier by the other
  // cars' deposits and no assertion anywhere would fire.
  //
  // So refuse rather than inherit a guarantee from a distant precondition.
  // The correct multi-vehicle derivation is the stored allocation on
  // `depositVehicleHolds`, not this reader.
  const quote = await ctx.db.get(app.quoteId);
  if ((quote?.vehicleItems?.length ?? 1) > 1) {
    throw new ConvexError(
      "This financed deal is attached to a quote covering more than one vehicle, so how much of the reservation deposit belongs to this car is a stored allocation rather than the whole deposit. Finalizing cannot determine the settlement safely. Split the deal, or allocate the deposit per vehicle first."
    );
  }

  // H — the deposit slice this sale consumes, proved row by row.
  //
  // The quote index scopes the query to this deal, and the reader filters to the
  // rows still holding THIS vehicle. Everything else about a row is a separate
  // fact that has to be checked rather than assumed: a deposit belonging to
  // another organization, another customer, or denominated in another currency
  // is somebody else's money, and one already consumed by a live application
  // would be spent twice.
  const depositRows = await heldDepositRowsForVehicle(
    ctx as MutationCtx,
    app.quoteId,
    app.vehicleId
  );

  let depositHeldMajor = 0;
  for (const row of depositRows) {
    if (row.orgId !== app.orgId) {
      throw new ConvexError(
        "A deposit recorded against this deal belongs to a different organization. It cannot be applied to this sale."
      );
    }
    if (row.customerId !== app.customerId) {
      throw new ConvexError(
        "A deposit held on this vehicle was paid by a different customer, so it cannot be applied to this purchase. Resolve it separately before finalizing."
      );
    }
    if (row.currency !== undefined && row.currency !== opts.currency) {
      throw new ConvexError(
        "A deposit held on this vehicle is recorded in a different currency from the deal. Resolve it before finalizing rather than converting it here."
      );
    }
    const alreadyApplied = await liveAppliedMinorForDeposit(ctx, row.depositId);
    if (alreadyApplied > 0) {
      throw new ConvexError(
        "A deposit held on this vehicle has already been applied to a sale that still stands. It cannot be applied again."
      );
    }
    depositHeldMajor += row.amount;
  }

  // Only an application to THIS purchase becomes H. A refund, a forfeiture or an
  // offset against a separate customer obligation leaves the money where its
  // receipt put it — in the deposit liability — and the company still owes the
  // whole settlement.
  const depositIsApplied =
    opts.depositTreatment === undefined ||
    opts.depositTreatment === "APPLY_TO_TRANSACTION_SETTLEMENT";

  // `deposits.amount` is MAJOR units, stored the way an operator types it.
  // Passing it through unconverted made a 3,000 deposit reduce the settlement by
  // 3 — arithmetically balanced, and wrong by the whole currency scale.
  const depositLiabilityAppliedMinor =
    depositIsApplied && depositHeldMajor > 0
      ? toMinorUnits(depositHeldMajor, opts.currency)
      : 0;

  // The same customer money cannot be counted twice — once as a contribution the
  // financing company received and netted out of its transfer, and again as a
  // deposit the dealership holds. Whichever it actually was, it happened once.
  if (
    depositLiabilityAppliedMinor > 0 &&
    (app.customerContributionToFinanceCompanyMinor ?? 0) > 0
  ) {
    throw new ConvexError(
      "This deal records the customer's money both as a deposit held by the dealership and as a contribution paid to the financing company. Record which of the two actually happened before finalizing."
    );
  }

  const result = buildFinancedSalePostingPlan({
    currency: opts.currency,
    legalInvoiceConsiderationMinor: app.legalInvoiceAmountMinor,
    legalInvoiceIssuedTo: app.legalInvoiceIssuedTo,
    financierIsConfiguredExternal: true,
    grossDealerSettlementMinor,
    storedExpectedDealerRemittanceMinor: app.expectedDealerRemittanceMinor,
    components,
    customerReceivableMinor,
    depositLiabilityAppliedMinor,
  });

  // A net payable has a general-ledger account but no canonical subledger, and
  // c16206 requires the two to tie exactly. Reusing the receivable document with
  // a negative amount, or Supplier AP, or a generic account, are each the kind of
  // near-enough answer this whole change exists to remove — so a deal that owes
  // the financing company money refuses here rather than being posted half-
  // tracked. The ledger rule below it is complete and stays that way: the gap is
  // the subledger, not the accounting.
  if (result.ok && result.plan.financeCompanyPayableMinor > 0) {
    throw new ConvexError(
      "On this deal the costs the financing company withholds come to more than it owes the dealership, so the dealership owes the company the difference. Recording that is not supported yet — resolve the settlement costs with the company before finalizing."
    );
  }

  if (!result.ok) {
    // The refusal message is written for the operator and names what to do.
    // Thrown rather than returned so a caller cannot accidentally continue with
    // no plan and post the deal the old way.
    throw new ConvexError(result.refusal.message);
  }
  return result.plan;
}

/** "OWNERSHIP_TRANSFER" -> "Ownership transfer". Only for a line with no description. */
function humanizeFeeType(feeType: string): string {
  const words = feeType.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * THE date a financed sale is recognized on — and therefore the period its
 * revenue, its finance receivable, its deductions and its commission land in.
 *
 * The legal invoice's date, when one is recorded: the schema note on
 * `legalInvoiceDate` has always said it "decides the period revenue lands in",
 * and `recordLegalInvoice` audits a date-only change for exactly that reason —
 * yet `finalizeDeal` dated the sale at the wall clock, so an invoice issued in
 * March and finalized in April recognized March's sale in April while the
 * record said otherwise. One rule now, and one home for it: the invoice date
 * where there is one, the moment of finalization where there is not (a deal
 * this model does not cover — no invoice is required of it).
 *
 * A date inside a CLOSED period is not moved to an open one: the sale posting
 * queues to the outbox for that period exactly as every other event dated
 * there does, and a closed month is never rewritten. `recordLegalInvoice`
 * refuses a future date and a date that is not a timestamp, so what reaches
 * here is a real past instant or nothing — and the same rule is applied
 * again here, with NO tolerance window: an invoice date is a calendar date
 * sent as UTC midnight (or the current instant for today), so a value past
 * the moment of finalization is a day that has not happened.
 */
export function financedSaleRecognitionDate(
  app: Pick<Doc<"financeApplications">, "legalInvoiceDate">,
  finalizedAt: number
): number {
  const invoiceDate = app.legalInvoiceDate;
  if (invoiceDate === undefined) return finalizedAt;
  // A PRESENT date that is not usable is refused, never quietly replaced
  // (Codex AF-CUST-08): `recordLegalInvoice` validates what it writes, but a
  // row written before it did, or raw-edited since, carries whatever it
  // carries — and substituting the wall clock would move revenue into a
  // period nobody chose. A future date is equally refused: revenue is not
  // recognized in a period that has not happened. Correct the invoice first.
  if (!Number.isSafeInteger(invoiceDate) || invoiceDate < 0) {
    throw new ConvexError(
      `This deal's legal invoice date is not a real timestamp (${invoiceDate}), so the sale cannot be dated for recognition. Re-record the legal invoice before finalizing.`
    );
  }
  if (invoiceDate > finalizedAt) {
    throw new ConvexError(
      "This deal's legal invoice is dated in the future, so the sale cannot be recognized yet. Re-record the legal invoice with its real date before finalizing."
    );
  }
  return invoiceDate;
}
