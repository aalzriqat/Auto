import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx, QueryCtx } from "./_generated/server";
import { requireOrgMember, requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { AppErrorCode } from "./utils/errors";
import { runWithIdempotency } from "./utils/idempotency";
import { PERMISSIONS, isSystemOwnerRole } from "./utils/permissions";
import { getOrgCurrency } from "./accounting/workflowHooks";
import {
  assertConfiguredFeesRecorded,
  assertExpectedCurrency,
  assertRoomForAnotherLine,
  exactTemplateLine,
  loadActiveFees,
  resolveDealCurrency,
} from "./utils/settlementDeductions";
import { assertSupportedDenomination } from "./utils/money";
import { reconcileEmployeeCustody } from "../lib/financingEconomics";
import { recomputeEconomicsForApplication } from "./financingEconomics";
import {
  assertMinorAmount,
  feeAccountingTreatmentValidator,
  feePartyValidator,
  financeFeeTypeValidator,
} from "./utils/financingEconomics";

/**
 * What a financed deal actually cost, itemized — and who is still holding money.
 *
 * Two concerns, one module, because they are the same question asked twice: an
 * employee sent out with cash to pay a deal's transfer and licensing fees IS the
 * deal's cost lines, seen from the other side. Splitting them meant the fee
 * total and the custody balance could disagree with nothing to notice.
 *
 * ## What this module deliberately does NOT do
 *
 * It posts nothing. No journal entry, no receivable, no change to any existing
 * posting. The accounting treatment of a financed sale is undetermined until
 * the invoice, the purchase agreement and the settlement advice say how the
 * purchase amount and the dealer contribution are legally documented — so this
 * records the facts and refuses to draw the conclusion. `finalizeDeal` is
 * untouched.
 *
 * ## The rule every function here obeys
 *
 * Nothing is inferred from the gap between two other numbers. Not the expenses,
 * not the buffer, not a residual. A deal with nothing itemized reports nothing
 * itemized. Working backwards from a quotation to make the arithmetic close is
 * how a leftover becomes a business fact nobody stated.
 */

const APPLICATION_NOT_FOUND = "Finance application not found in this organization.";
const CUSTODY_NOT_FOUND = "Custody record not found in this organization.";
const FEE_NOT_FOUND = "Deal cost not found in this organization.";

/**
 * Refuses to change anything a closed custody record was balanced against.
 *
 * Closing is a claim that the money is accounted for. Nothing froze the fee
 * lines that determine that, so a late receipt recorded afterwards left the
 * record stored as RECONCILED while the arithmetic said the employee was out of
 * pocket — and `recordCustodyMovement` then refused the reimbursement, its
 * error naming a `reopenDealCustody` mutation that did not exist. Reopen it
 * deliberately instead.
 */
function assertCustodyOpen(custody: Doc<"financeDealCustody">): void {
  if (custody.status !== "OPEN") {
    throw new ConvexError(
      "This custody record is closed. Reopen it before changing the costs it was balanced against."
    );
  }
}

/**
 * Withdraws a deal's accounting classification when its basis changes.
 *
 * CLASSIFIED means somebody established the treatment against a specific set of
 * costs, custody balances and an invoice. Nothing re-checked it afterwards, so
 * adding an unquantified cost — or editing the invoice figure the treatment was
 * granted on — left a deal reading as settled while its own summary said
 * otherwise. This flag exists to be the gate a posting design reads; a gate
 * that silently stops representing its precondition is the whole hazard.
 *
 * Withdrawn with a row rather than silently: it is a human judgement, and
 * losing the fact that it was made and then invalidated is losing the audit.
 */
async function invalidateClassification(
  ctx: MutationCtx,
  app: Doc<"financeApplications">,
  actorId: Id<"users">,
  because: string
): Promise<void> {
  if (app.accountingClassification !== "CLASSIFIED") return;
  const now = Date.now();
  await ctx.db.insert("financeApplicationOverrides", {
    orgId: app.orgId,
    applicationId: app._id,
    field: "accountingClassification",
    previousValue: "CLASSIFIED",
    newValue: "PENDING_CLASSIFICATION",
    reason: because,
    changedBy: actorId,
    changedAt: now,
  });
  await ctx.db.patch(app._id, {
    accountingClassification: "PENDING_CLASSIFICATION",
    accountingClassifiedBy: undefined,
    accountingClassifiedAt: undefined,
    accountingClassificationNotes: undefined,
    updatedAt: now,
  });
}

/**
 * Refuses to let a CREATE-level caller destroy CONFIRM-level work.
 *
 * Reconciling a cost requires `CONFIRM_FINANCE_DISBURSEMENT`, which SALES does
 * not hold; recording and voting an amount requires only
 * `CREATE_FINANCE_APPLICATION`, which it does. So without this a salesperson
 * could overwrite an accountant's checked figure, identity and notes.
 *
 * Checked against the role already loaded rather than by calling
 * `requireTenantAuth` a second time: that helper is not side-effect-free in a
 * mutation — it writes an impersonation audit row — so re-calling it logged a
 * second `impersonated-write:` entry naming an operation that never happened.
 */
function assertMayUndoReconciliation(
  auth: { role: Doc<"roles"> },
  action: string
): void {
  if (isSystemOwnerRole(auth.role)) return;
  if (auth.role.permissions.includes(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT)) return;
  throw new ConvexError(
    `${action} needs the permission to confirm finance disbursements, because somebody has already reconciled it.`
  );
}

async function custodyFor(
  ctx: QueryCtx | MutationCtx,
  applicationId: Id<"financeApplications">
): Promise<Array<Doc<"financeDealCustody">>> {
  return await ctx.db
    .query("financeDealCustody")
    .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
    .collect();
}

/**
 * The state of one cost line, derived rather than stored.
 *
 * A stored status drifts from the fields it summarises the first time one is
 * patched without the other. Note that RECORDED and RECONCILED are genuinely
 * different claims: somebody typed a number, versus somebody checked it against
 * evidence. Only the second may close a deal.
 */
export function deriveFeeStatus(
  fee: Doc<"financeDealFees">
): "VOID" | "RECONCILED" | "ACTUAL_RECORDED" | "ESTIMATED_ONLY" | "UNQUANTIFIED" {
  if (fee.voidedAt !== undefined) return "VOID";
  if (fee.reconciledAt !== undefined) return "RECONCILED";
  if (fee.actualAmountMinor !== undefined) return "ACTUAL_RECORDED";
  if (fee.estimatedAmountMinor !== undefined) return "ESTIMATED_ONLY";
  // A line that names a cost without quantifying it. Legitimate while a deal is
  // in flight — "there will be a transfer fee, amount unknown" — and precisely
  // the state that must not be read as zero.
  return "UNQUANTIFIED";
}

/**
 * Totals for a deal's costs, with estimated and actual kept strictly apart.
 *
 * `actualTotalMinor` sums ONLY the lines that have an actual. It is never
 * topped up with estimates for the lines that do not, because a total that
 * silently mixes the two answers neither "what did this cost" nor "what did we
 * think it would cost" — and reads as complete when it is not. `linesAwaiting*`
 * is how a caller knows which one it is holding.
 */
export function summarizeFees(fees: Array<Doc<"financeDealFees">>) {
  // Every line carries its own `currency`, and the totals below are integers
  // in ONE of them. Summing fils with cents produces a number that looks like
  // a total and is not one, so a mixed set refuses here rather than at some
  // caller that forgot to check (SCRUM-319). `listDealCosts` pre-checks and
  // reports the condition instead of throwing; any other caller that reaches
  // this with mixed rows is a bug and should hear about it.
  const currencies = new Set(fees.filter((fee) => fee.voidedAt === undefined).map((fee) => fee.currency));
  if (currencies.size > 1) {
    throw new ConvexError(
      `Deal costs are recorded in more than one currency (${[...currencies].join(", ")}); their totals cannot be summed.`
    );
  }
  let estimatedTotalMinor = 0;
  let actualTotalMinor = 0;
  let dealerBorneActualMinor = 0;
  let linesAwaitingActual = 0;
  let linesAwaitingReconciliation = 0;

  for (const fee of fees) {
    // Belt as well as braces. Every caller filters first, but this function is
    // exported — and the first caller that passes raw rows would sum voided
    // actuals into the total and count voided lines as awaiting one.
    if (fee.voidedAt !== undefined) continue;
    if (fee.estimatedAmountMinor !== undefined) {
      estimatedTotalMinor += fee.estimatedAmountMinor;
    }
    if (fee.actualAmountMinor !== undefined) {
      actualTotalMinor += fee.actualAmountMinor;
      if (fee.paidBy === "DEALER" || fee.paidBy === "EMPLOYEE") {
        dealerBorneActualMinor += fee.actualAmountMinor;
      }
    } else {
      linesAwaitingActual += 1;
    }
    if (fee.actualAmountMinor !== undefined && fee.reconciledAt === undefined) {
      linesAwaitingReconciliation += 1;
    }
  }

  const liveCount = fees.filter((fee) => fee.voidedAt === undefined).length;
  return {
    lineCount: liveCount,
    estimatedTotalMinor,
    actualTotalMinor,
    /** What the dealership itself ended up out of pocket, on recorded actuals only. */
    dealerBorneActualMinor,
    linesAwaitingActual,
    linesAwaitingReconciliation,
    /** True only when every line has a checked actual. Estimates never satisfy this. */
    fullyReconciled:
      liveCount > 0 && linesAwaitingActual === 0 && linesAwaitingReconciliation === 0,
  };
}

// ---------------------------------------------------------------------------
// What the finance company's policy says this handover SHOULD cost
// ---------------------------------------------------------------------------

/** One configured fee, as the application's frozen rule snapshot carries it. */
type FeeTemplate = NonNullable<
  NonNullable<Doc<"financeApplications">["companyRuleSnapshot"]>["feeTemplates"]
>[number];

/** Display-only identity used to flag duplicate configured rows; never a match key. */
function templateIdentity(template: { feeType: string; description?: string }): string {
  return `${template.feeType}|${(template.description ?? "").trim().toLowerCase()}`;
}

export type ExpectedFeeRow = {
  /** Position in the frozen snapshot — the ONLY stable reference to this template. */
  templateIndex: number;
  feeType: FeeTemplate["feeType"];
  description: string | undefined;
  expectedAmountMinor: number;
  paidBy: FeeTemplate["paidBy"];
  paidTo: FeeTemplate["paidTo"];
  includedInQuotation: boolean;
  deductedFromSettlement: boolean;
  refundable: boolean;
  accountingTreatment: FeeTemplate["accountingTreatment"];
  /**
   * Another template in the same snapshot shares this one's feeType and
   * description. Addressing by position keeps the two distinct, so an actual
   * recorded against one never satisfies the other; the flag exists so a
   * screen can label the pair.
   */
  duplicateIdentity: boolean;
  /**
   * The live line that records this fee's actual — the one
   * `recordTemplateFeeActual` wrote against this position, and nothing else.
   */
  actual: {
    feeId: Id<"financeDealFees">;
    actualAmountMinor: number | undefined;
    currency: string;
    status: ReturnType<typeof deriveFeeStatus>;
  } | null;
};

/**
 * The expected side of the handover-cost checklist, derived READ-ONLY from
 * the application's frozen `companyRuleSnapshot.feeTemplates` (owner product
 * correction, #scrum-215 2026-09-12 21:05).
 *
 * The rules a deal was created under are the rules it is costed against. The
 * snapshot is written once at application creation and never re-read from the
 * live company, so editing the company's fees next month changes what FUTURE
 * deals expect and leaves this one exactly as it was — the same property the
 * LTV and tolerance rules already have. Nothing here reads `financeCompanies`.
 *
 * What is NOT invented:
 *   - a deal with no snapshot, or a snapshot with no templates, has no expected
 *     rows and a null expected total — "not configured" is reported as such,
 *     never as zero;
 *   - the expected total sums the configured template estimates only; the
 *     actual total sums recorded actuals only (every live line, template or
 *     unplanned); their difference is a COMPARISON and is never an amount
 *     assumed still payable;
 *   - an unplanned line (no template) leaves the expected total untouched.
 *
 * Denomination: the snapshot carries no currency. Template amounts were
 * entered under the organisation's currency, which the SCRUM-319 lock freezes
 * once any cost or custody row exists, and the deal's lines are kept in that
 * same currency — so the expected figures are stated in the deal currency the
 * caller passes. The comparison is withheld (null) whenever the actual total
 * is, i.e. over mixed-denomination lines.
 *
 * Matching an actual to its template is EXACT or nothing. A line written by
 * `recordTemplateFeeActual` carries the template's POSITION and is the only
 * line a configured row ever shows as its actual, duplicates or not. A
 * COMPANY_TEMPLATE line with no position — from before that writer, or
 * written to the table by anything else — is never attached to a configured
 * row, however well its feeType and description happen to match: attaching it
 * would show the fee as recorded and hide the exact record action while
 * closure (which trusts positions only) still refused, and once the exact
 * line was recorded both would count toward the actual total. Such a line
 * stays visible as an unplanned/history line instead. The same stable
 * reference governs the checklist and the closure gate.
 */
export function deriveExpectedFees(args: {
  snapshot: Doc<"financeApplications">["companyRuleSnapshot"];
  /** Live (non-void) lines on the deal. */
  fees: Array<Doc<"financeDealFees">>;
  /** The deal's currency, as `listDealCosts` resolves it. */
  currency: string;
  /** Null when the recorded actuals cannot be summed (mixed denomination). */
  actualTotalMinor: number | null;
}): {
  source: "COMPANY_RULE_SNAPSHOT" | "NO_SNAPSHOT" | "NO_TEMPLATES";
  currency: string;
  rows: ExpectedFeeRow[];
  /** Sum of the configured template estimates; null when nothing is configured. */
  expectedTotalMinor: number | null;
  /** Sum of recorded actuals over every live line, template or unplanned; null over mixed denomination. */
  actualTotalMinor: number | null;
  /** expected − actual, a comparison only; null whenever either side is. */
  differenceMinor: number | null;
  /** Live lines outside the checklist: unplanned costs, and template lines that carry no position (legacy or otherwise). */
  unplannedLineIds: Id<"financeDealFees">[];
} {
  const templates = args.snapshot?.feeTemplates;
  const source =
    args.snapshot === undefined
      ? ("NO_SNAPSHOT" as const)
      : !templates || templates.length === 0
        ? ("NO_TEMPLATES" as const)
        : ("COMPANY_RULE_SNAPSHOT" as const);
  const configured = source === "COMPANY_RULE_SNAPSHOT" && templates ? templates : [];

  const identityCounts = new Map<string, number>();
  for (const template of configured) {
    const key = templateIdentity(template);
    identityCounts.set(key, (identityCounts.get(key) ?? 0) + 1);
  }

  const claimed = new Set<Id<"financeDealFees">>();
  const rows: ExpectedFeeRow[] = configured.map((template, templateIndex) => {
    const duplicateIdentity = (identityCounts.get(templateIdentity(template)) ?? 0) > 1;

    // The line that names this position, or nothing — the same matcher the
    // closure gates use, so the checklist cannot show a row as recorded that
    // classification or finalization would refuse.
    const matched = exactTemplateLine(args.fees, templateIndex);
    if (matched) claimed.add(matched._id);

    return {
      templateIndex,
      feeType: template.feeType,
      description: template.description,
      expectedAmountMinor: template.estimatedAmountMinor,
      paidBy: template.paidBy,
      paidTo: template.paidTo,
      includedInQuotation: template.includedInQuotation,
      deductedFromSettlement: template.deductedFromSettlement,
      refundable: template.refundable,
      accountingTreatment: template.accountingTreatment,
      duplicateIdentity,
      actual: matched
        ? {
            feeId: matched._id,
            actualAmountMinor: matched.actualAmountMinor,
            currency: matched.currency,
            status: deriveFeeStatus(matched),
          }
        : null,
    };
  });

  const expectedTotalMinor =
    source === "COMPANY_RULE_SNAPSHOT"
      ? rows.reduce((total, row) => total + row.expectedAmountMinor, 0)
      : null;
  const differenceMinor =
    expectedTotalMinor !== null && args.actualTotalMinor !== null
      ? expectedTotalMinor - args.actualTotalMinor
      : null;

  return {
    source,
    currency: args.currency,
    rows,
    expectedTotalMinor,
    actualTotalMinor: args.actualTotalMinor,
    differenceMinor,
    unplannedLineIds: args.fees.filter((fee) => !claimed.has(fee._id)).map((fee) => fee._id),
  };
}

/**
 * Where one custody record stands, using the shared engine for the arithmetic.
 *
 * Closure needs BOTH directions settled, which the engine alone does not tell
 * you: it computes what is *due*, and a debt that is owed but unpaid is not
 * settled. So `settled` requires the employee to hold nothing AND the
 * dealership to have actually paid back everything it owes.
 */
export function summarizeCustody(
  custody: Doc<"financeDealCustody">,
  actualExpensesMinor: number
) {
  const reconciliation = reconcileEmployeeCustody({
    advanceIssuedMinor: custody.issuedMinor,
    actualExpensesMinor,
    employeeReturnedMinor: custody.returnedMinor,
    alreadyReimbursedMinor: custody.reimbursedMinor,
  });

  return {
    ...reconciliation,
    actualExpensesMinor,
    reimbursedMinor: custody.reimbursedMinor,
    // The engine decides `reconciled` across all three directions — money still
    // held, money still owed, and money paid twice. Recomputing it here is how
    // the two would drift.
    settled: reconciliation.reconciled,
  };
}

/**
 * Sum recorded actuals for one custody from the deal's already-bounded LIVE
 * fee set. Callers must pass the result of `loadActiveFees`: querying by
 * custody and filtering voids afterwards would read an unbounded add/void
 * history and could strand both reconciliation and classification at the
 * platform transaction limit even while the deal had fewer than 500 live
 * lines.
 */
function custodyActualExpensesMinor(
  liveFees: ReadonlyArray<Doc<"financeDealFees">>,
  custodyId: Id<"financeDealCustody">
): number {
  return liveFees
    .filter(
      (row) =>
        row.voidedAt === undefined &&
        row.custodyId === custodyId &&
        row.actualAmountMinor !== undefined
    )
    .reduce((sum, row) => sum + (row.actualAmountMinor ?? 0), 0);
}

/**
 * Recomputes a custody record's totals from its entries.
 *
 * The totals are a projection of the movement log, never a number a caller
 * hands in — so correcting a mistyped issuance means adding a correcting entry
 * that stays visible, rather than overwriting a figure and losing the fact that
 * it ever differed.
 */
/**
 * Resolves the custody record a fee line may be charged against.
 *
 * Shared by `recordDealFee` and `recordActualFeeAmount`, which had the same
 * four checks written out twice — and a divergence between two copies of a
 * money guard is the kind that survives review because both copies look right
 * on their own.
 */
async function resolveFeeCustody(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  applicationId: Id<"financeApplications">,
  custodyId: Id<"financeDealCustody">,
  paidBy: Doc<"financeDealFees">["paidBy"]
): Promise<Id<"financeDealCustody">> {
  const custody = await requireOwnedRow(
    ctx, orgId, "financeDealCustody", custodyId, CUSTODY_NOT_FOUND
  );
  if (custody.applicationId !== applicationId) {
    throw new ConvexError("That custody record belongs to a different deal.");
  }
  assertCustodyOpen(custody);
  // The custody balance is "what this person spent of the money they hold".
  // Charging it for a cost somebody ELSE paid drives that balance to zero while
  // the cash is still in their pocket, and the record then reconciles and
  // closes clean. An obvious mis-click once a UI offers the deal's custody in a
  // dropdown.
  if (paidBy !== "EMPLOYEE") {
    throw new ConvexError(
      "A cost charged to an employee's custody must be recorded as paid by that employee. Remove the custody link, or record who actually paid."
    );
  }
  return custody._id;
}

/**
 * Deletes the blobs a replacement attachment list drops.
 *
 * Replacing the attachments wholesale left the old blobs referenced by nothing
 * — and both deletion paths enumerate ROWS, so an orphan survives the org
 * hard-delete and the financial reset alike. `financeAppraisals`, the only
 * other storage carrier here, is append-only and never hit this.
 */
async function deleteDroppedAttachments(
  ctx: MutationCtx,
  previous: Array<Id<"_storage">> | undefined,
  next: Array<Id<"_storage">> | undefined
): Promise<void> {
  if (!next) return;
  for (const storageId of (previous ?? []).filter((id) => !next.includes(id))) {
    const metadata = await ctx.db.system.get("_storage", storageId);
    if (metadata) await ctx.storage.delete(storageId);
  }
}

/**
 * Whether a reversal may cancel the movement it names.
 *
 * Seven checks that all have to hold before an entry is admitted, lifted out of
 * the handler so the handler reads as: authorize, validate the amount, validate
 * the kind, insert.
 */
async function assertReversalAllowed(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  custodyId: Id<"financeDealCustody">,
  reversesEntryId: Id<"financeDealCustodyEntries"> | undefined,
  amountMinor: number
): Promise<void> {
  if (!reversesEntryId) {
    throw new ConvexError("Say which movement this reverses.");
  }
  const target = await requireOwnedRow(
    ctx, orgId, "financeDealCustodyEntries", reversesEntryId,
    "That movement was not found in this organization."
  );
  if (target.custodyId !== custodyId) {
    throw new ConvexError("That movement belongs to a different custody record.");
  }
  if (target.kind === "REVERSAL") {
    throw new ConvexError("A reversal cannot itself be reversed. Record the movement again.");
  }
  if (target.amountMinor !== amountMinor) {
    throw new ConvexError(
      `A reversal must cancel the whole movement. That one was ${target.amountMinor} minor units.`
    );
  }
  const already = await ctx.db
    .query("financeDealCustodyEntries")
    .withIndex("by_custody", (q) => q.eq("custodyId", custodyId))
    .collect();
  if (already.some((row) => row.reversesEntryId === reversesEntryId)) {
    throw new ConvexError("That movement has already been reversed.");
  }

  // A reimbursement is calculated against what the person was given: they spent
  // more than the advance, so the difference was paid back to them. Retracting
  // the issuance afterwards leaves that payment standing on a baseline that no
  // longer exists, and the outstanding figure silently re-derives the entire
  // advance as a fresh debt — a settled record turning into "700 still owed"
  // with nobody having moved any money.
  //
  // This is not the totals invariant and cannot be enforced there: zero issued
  // alongside a reimbursement is a perfectly true state on its own, it is what
  // paying out of pocket looks like. What is not true is reaching it by
  // withdrawing the issuance the reimbursement was measured from, so the guard
  // belongs on that dependency.
  if (target.kind !== "ISSUED") return;
  const reversed = new Set(
    already
      .filter((row) => row.kind === "REVERSAL" && row.reversesEntryId)
      .map((row) => row.reversesEntryId!)
  );
  const settledAgainst = already.filter(
    (row) => row.kind === "REIMBURSED" && !reversed.has(row._id)
  );
  if (settledAgainst.length > 0) {
    const paidMinor = settledAgainst.reduce((sum, row) => sum + row.amountMinor, 0);
    throw new ConvexError(
      `A reimbursement of ${paidMinor} minor units was already paid against this handover. Reverse that reimbursement first, otherwise the payment stays on the record measured against an issuance that no longer exists.`
    );
  }
}

async function recomputeCustodyTotals(
  ctx: MutationCtx,
  custodyId: Id<"financeDealCustody">
): Promise<void> {
  const entries = await ctx.db
    .query("financeDealCustodyEntries")
    .withIndex("by_custody", (q) => q.eq("custodyId", custodyId))
    .collect();

  const reversedIds = new Set(
    entries
      .filter((entry) => entry.kind === "REVERSAL" && entry.reversesEntryId)
      .map((entry) => entry.reversesEntryId!)
  );

  let issuedMinor = 0;
  let returnedMinor = 0;
  let reimbursedMinor = 0;
  const add = (kind: Doc<"financeDealCustodyEntries">["kind"], amount: number): void => {
    // No `else` fallback. A future kind falling through to "reimbursed" would
    // inflate what the dealership has paid back, drive the outstanding figure
    // to zero and report the record settled — the "unknown treated as fine"
    // shape, with the compiler silent because `else` accepts anything.
    switch (kind) {
      case "ISSUED":
        issuedMinor += amount;
        return;
      case "RETURNED":
        returnedMinor += amount;
        return;
      case "REIMBURSED":
        reimbursedMinor += amount;
        return;
      case "REVERSAL":
        return;
      default: {
        const unhandled: never = kind;
        throw new ConvexError(
          `Unhandled custody entry kind ${String(unhandled)}. Its effect on the balance has to be stated explicitly.`
        );
      }
    }
  };

  for (const entry of entries) {
    // A reversal and the entry it cancels contribute nothing between them, so
    // both are skipped rather than one being subtracted from the other —
    // netting a negative AND skipping the target applied the correction twice.
    // Both rows stay in the table; only their effect on the totals is removed.
    if (entry.kind === "REVERSAL") continue;
    if (reversedIds.has(entry._id)) continue;
    add(entry.kind, entry.amountMinor);
  }

  // The invariant, enforced once where every path converges rather than per
  // movement. Guarding only the RETURNED mutation left the reversal of an
  // ISSUED entry free to reach the same state from the other side: return the
  // whole advance, then reverse the issuance, and the log says more came back
  // than ever went out — after which the module reported a reimbursement due
  // and instructed somebody to pay it. A throw here rolls the entry insert back
  // with it, so no path can commit a log that cannot be true.
  if (returnedMinor > issuedMinor) {
    throw new ConvexError(
      `That would leave ${returnedMinor} minor units returned against ${issuedMinor} issued, which cannot both be true. Reverse the return as well, or record the issuance that is missing.`
    );
  }

  await ctx.db.patch(custodyId, {
    issuedMinor,
    returnedMinor,
    reimbursedMinor,
    updatedAt: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Every cost and custody record on a deal, with the totals a person reads. */
export const listDealCosts = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE_APPLICATIONS]);
    const app = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
      APPLICATION_NOT_FOUND
    );

    // The same bounded read the writers make, and the ONE thing this read
    // refuses on: past `MAX_LIVE_DEAL_FEE_LINES` the screen would be showing
    // a prefix of a deal's costs that reads like the whole of them.
    const fees = await loadActiveFees(ctx, args.applicationId);
    const custodyRows = await custodyFor(ctx, args.applicationId);

    // The deal's denomination as the WRITERS would resolve it. Short of that
    // row cap a read does not refuse (a query that throws blanks the screen),
    // so a contradiction is reported in the payload instead: the per-line
    // facts stay readable in their own currency, and every scalar total is
    // withheld with the reason.
    const currency = app.economicsCurrency ?? (await getOrgCurrency(ctx, args.orgId));
    const lineCurrencies = [...new Set(fees.map((fee) => fee.currency))];
    const foreignLineCurrencies = lineCurrencies.filter((code) => code !== currency);
    const summaryUnavailable =
      foreignLineCurrencies.length > 0
        ? {
            reason: "MIXED_DENOMINATION" as const,
            dealCurrency: currency,
            lineCurrencies,
            message: `Costs on this deal are recorded in ${lineCurrencies.join(", ")} while the deal is in ${currency}; totals are unavailable until the records agree.`,
          }
        : null;

    const custody = [];
    for (const row of custodyRows) {
      // A custody record is balanced against the actuals on the lines it paid
      // for. If any of those lines is in another currency the arithmetic is
      // meaningless, and the record is reported without a summary.
      const paidLines = fees.filter((fee) => fee.custodyId === row._id);
      const custodyMismatch =
        row.currency !== currency || paidLines.some((fee) => fee.currency !== row.currency);
      custody.push({
        ...row,
        summary: custodyMismatch
          ? null
          : summarizeCustody(row, custodyActualExpensesMinor(fees, row._id)),
        summaryUnavailable: custodyMismatch
          ? { reason: "MIXED_DENOMINATION" as const, custodyCurrency: row.currency, dealCurrency: currency }
          : null,
      });
    }

    const summary = summaryUnavailable === null ? summarizeFees(fees) : null;
    return {
      currency,
      fees: fees.map((fee) => ({ ...fee, status: deriveFeeStatus(fee) })),
      // Null, never a plausible number, when the lines do not share the deal's
      // currency. A client that renders `summary.actualTotalMinor` has to
      // handle the absence — that is the contract, not a hidden total.
      summary,
      summaryUnavailable,
      // The checklist the finance company's frozen policy implies — expected
      // rows and total derived from the application's own rule snapshot, each
      // matched to the live line that records its actual. Read-only: nothing
      // here is a line, and nothing here is written.
      expected: deriveExpectedFees({
        snapshot: app.companyRuleSnapshot,
        fees,
        currency,
        actualTotalMinor: summary ? summary.actualTotalMinor : null,
      }),
      custody,
      // Stated rather than derived: PENDING_CLASSIFICATION is what an unset
      // value means, and saying so beats every caller re-deriving it.
      accountingClassification: app.accountingClassification ?? "PENDING_CLASSIFICATION",
      legalInvoiceAmountMinor: app.legalInvoiceAmountMinor,
      legalInvoiceNumber: app.legalInvoiceNumber,
      legalInvoiceDate: app.legalInvoiceDate,
      legalInvoiceIssuedTo: app.legalInvoiceIssuedTo,
    };
  },
});

// ---------------------------------------------------------------------------
// Cost lines
// ---------------------------------------------------------------------------

export const recordDealFee = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    feeType: financeFeeTypeValidator,
    description: v.optional(v.string()),
    estimatedAmountMinor: v.optional(v.number()),
    actualAmountMinor: v.optional(v.number()),
    paidBy: feePartyValidator,
    paidTo: feePartyValidator,
    /** Required on purpose — see the schema note. Never inferred from paidBy. */
    accountingTreatment: feeAccountingTreatmentValidator,
    includedInQuotation: v.optional(v.boolean()),
    deductedFromSettlement: v.optional(v.boolean()),
    refundable: v.optional(v.boolean()),
    custodyId: v.optional(v.id("financeDealCustody")),
    paidAt: v.optional(v.number()),
    receiptReference: v.optional(v.string()),
    documentStorageIds: v.optional(v.array(v.id("_storage"))),
    source: v.optional(v.union(v.literal("COMPANY_TEMPLATE"), v.literal("MANUAL"))),
    /**
     * REQUIRED. The currency the caller entered the minor-unit amounts in
     * (SCRUM-319). The server never trusts it as the denomination — it proves
     * the deal's own and refuses when the two differ — but without it a form
     * rendered in USD could submit cents onto a deal whose lines are fils and
     * nothing would notice until settlement.
     */
    expectedCurrency: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CREATE_FINANCE_APPLICATION,
    ]);
    assertExpectedCurrency(args.expectedCurrency, "recording this cost");
    // A configured fee's line is written by `recordTemplateFeeActual` alone,
    // which copies the finance company's policy from the deal's frozen
    // snapshot. Minting the COMPANY_TEMPLATE source here would let a caller
    // author a line that reads exactly like one — feeType, description,
    // expectation and all — and have the checklist and the closure gate treat
    // a configured fee as recorded on the caller's say-so.
    if (args.source === "COMPANY_TEMPLATE") {
      throw new ConvexError(
        "A configured fee is recorded through the deal's checklist, against the finance company's own template — not as a typed line. Record the actual for the configured fee, or record this as an additional cost."
      );
    }
    // Inline rather than behind a helper: scripts/tenantWriteGuard only accepts
    // proof it can see inside the handler, and "the ownership check is
    // somewhere else" is the exact shape that shipped two Criticals.
    const app = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
      APPLICATION_NOT_FOUND
    );

    if (args.estimatedAmountMinor !== undefined) {
      assertMinorAmount(args.estimatedAmountMinor, "Estimated amount");
    }
    if (args.actualAmountMinor !== undefined) {
      assertMinorAmount(args.actualAmountMinor, "Actual amount");
    }
    // A line with neither figure is allowed — "there will be a transfer fee,
    // amount unknown" is a real state, and one worth recording rather than
    // leaving to memory. It just cannot close the deal; see requireCostsClosable.

    let custodyId: Id<"financeDealCustody"> | undefined;
    if (args.custodyId) {
      custodyId = await resolveFeeCustody(
        ctx, args.orgId, args.applicationId, args.custodyId, args.paidBy
      );
    }

    // The deal's denomination, proven BEFORE any write: the pin when there is
    // one, else the org's verified currency — which the first cost line then
    // fixes, because `orgSettings.upsert` refuses to change it once this row
    // exists. Recording a licensing estimate early does not need a quotation
    // or an approval first; it needs the caller to be entering the amount in
    // the currency the deal is actually kept in.
    const currency = await resolveDealCurrency(ctx, app, "recording this cost");
    if (args.expectedCurrency !== currency) {
      throw new ConvexError(
        `This cost was entered in ${args.expectedCurrency}, but the deal's costs are kept in ${currency}. Reload the deal and enter the amount in ${currency}.`
      );
    }

    // A cost line is additive: a retried submit does not overwrite anything, it
    // adds a second real charge, and `actualTotalMinor` rises by an amount
    // nobody spent. Every other money-recording surface in this codebase
    // (expenses, deposits, the cash drawer) already takes a key for exactly
    // this; there is no reason a deal's costs should be the one that does not.
    // Ownership and permission are checked above, outside the wrapper, so a
    // replay is still authorized rather than trusting the stored result.
    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "financeDealCosts.recordDealFee",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        // The command's WHOLE persisted input, normalised exactly as it is
        // stored below (SCRUM-319 / AF-215-02). The previous fingerprint
        // omitted description, paidAt, includedInQuotation, refundable, the
        // attachments and the source — so a retry carrying a different
        // description or payment date under the same key replayed the first
        // row's id and silently dropped the operator's second intent. Same
        // key + same intent replays; same key + any changed field refuses.
        fingerprint: JSON.stringify({
          applicationId: args.applicationId,
          feeType: args.feeType,
          expectedCurrency: args.expectedCurrency,
          description: args.description?.trim() || null,
          estimatedAmountMinor: args.estimatedAmountMinor ?? null,
          actualAmountMinor: args.actualAmountMinor ?? null,
          paidBy: args.paidBy,
          paidTo: args.paidTo,
          accountingTreatment: args.accountingTreatment,
          includedInQuotation: args.includedInQuotation ?? false,
          // Persisted below and summed by settlementDeductedTotalMinor, so it
          // changes the dealer remittance. Two fees identical except for this
          // flag are DIFFERENT economic instructions.
          deductedFromSettlement: args.deductedFromSettlement ?? false,
          refundable: args.refundable ?? false,
          custodyId: args.custodyId ?? null,
          paidAt: args.paidAt ?? null,
          receiptReference: args.receiptReference?.trim() || null,
          documentStorageIds: args.documentStorageIds?.map((id) => id.toString()) ?? null,
          source: args.source ?? "MANUAL",
        }),
      },
      async () => {
        // Inside the idempotent section, before anything is written: an
        // exact replay of a line already recorded returns it above this,
        // and a NEW line on a deal already at the live-line cap is refused
        // with the classification untouched and no command record kept.
        assertRoomForAnotherLine(await loadActiveFees(ctx, args.applicationId), "recording this cost");

        await invalidateClassification(
          ctx, app, user._id,
          "A new cost was added to the deal after its accounting was classified."
        );

        const now = Date.now();
        return await ctx.db.insert("financeDealFees", {
          orgId: args.orgId,
          applicationId: args.applicationId,
          feeType: args.feeType,
          description: args.description?.trim() || undefined,
          currency,
          estimatedAmountMinor: args.estimatedAmountMinor,
          actualAmountMinor: args.actualAmountMinor,
          paidBy: args.paidBy,
          paidTo: args.paidTo,
          accountingTreatment: args.accountingTreatment,
          includedInQuotation: args.includedInQuotation ?? false,
          deductedFromSettlement: args.deductedFromSettlement ?? false,
          refundable: args.refundable ?? false,
          custodyId,
          paidAt: args.paidAt,
          receiptReference: args.receiptReference?.trim() || undefined,
          documentStorageIds: args.documentStorageIds,
          source: args.source ?? "MANUAL",
          createdBy: user._id,
          createdAt: now,
          updatedAt: now,
        });
      }
    );
  },
});

/**
 * Records the ACTUAL paid for a fee the finance company's frozen policy
 * configures — the only thing an operator enters on a configured row (owner
 * product correction, #scrum-215 2026-09-12 21:05).
 *
 * The caller names WHICH configured fee, by its position in the application's
 * frozen `companyRuleSnapshot.feeTemplates`, and the amount they paid. Every
 * other field of the line — the expected amount, description, who pays, who is
 * paid, the quotation and settlement flags, the accounting treatment — is
 * copied from that snapshot entry HERE. The client restates none of the
 * company's policy and cannot author an expectation: the line's
 * `estimatedAmountMinor` is the template's, so a receipt that differs from it
 * is a comparison, never a rewrite.
 *
 * The position is the reference because the snapshot is immutable per
 * application, so it is exact even when two templates are identical — a name
 * would be ambiguous there; a position is not. It is validated the way
 * `v.number()` does not: a safe non-negative integer inside the array, and the
 * `feeType` the caller saw must be the one at that position (a stale reference
 * from an older render is refused, not silently re-pointed). Stored on the
 * line so the checklist can match it back exactly.
 *
 * One live line per position. A second recording against the same position
 * is refused and directed to `recordActualFeeAmount` on the existing line —
 * the same rule keeps a retry honest: the same key with the same intent
 * replays the first line's id; a new key against an existing line is refused
 * inside the idempotent section, so nothing is committed. Voiding the line
 * (audited) frees the position again.
 *
 * Not a new way to spend. The row it writes is an ordinary `financeDealFees`
 * line with the same fates as every other: re-recorded through
 * `recordActualFeeAmount`, checked through `reconcileDealFee`, voided through
 * `voidDealFee`, invalidating the classification like any other cost, summed
 * by `summarizeFees` and by `settlementDeductedTotalMinor` under the template's
 * own `deductedFromSettlement` flag.
 */
export const recordTemplateFeeActual = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    /** Position of the template in the application's frozen snapshot. */
    templateIndex: v.number(),
    /** The fee type the caller saw at that position — a cross-check, never a source of policy. */
    feeType: financeFeeTypeValidator,
    actualAmountMinor: v.number(),
    /** REQUIRED. The currency the caller counted `actualAmountMinor` in (SCRUM-319). */
    expectedCurrency: v.string(),
    paidAt: v.optional(v.number()),
    receiptReference: v.optional(v.string()),
    documentStorageIds: v.optional(v.array(v.id("_storage"))),
    custodyId: v.optional(v.id("financeDealCustody")),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CREATE_FINANCE_APPLICATION,
    ]);
    assertExpectedCurrency(args.expectedCurrency, "recording this cost");
    const app = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
      APPLICATION_NOT_FOUND
    );

    // The reference, validated positively. `v.number()` admits NaN, Infinity,
    // negatives and fractions, and every one of them indexes an array to
    // `undefined` without a word.
    if (!Number.isSafeInteger(args.templateIndex) || args.templateIndex < 0) {
      throw new ConvexError(
        `The configured fee reference must be a non-negative whole number (got ${args.templateIndex}).`
      );
    }
    const templates = app.companyRuleSnapshot?.feeTemplates ?? [];
    if (app.companyRuleSnapshot === undefined || templates.length === 0) {
      throw new ConvexError(
        "This deal's finance company configured no fees when the deal was created, so there is no configured fee to record an actual for. Record it as an additional cost instead."
      );
    }
    if (args.templateIndex >= templates.length) {
      throw new ConvexError(
        `This deal's finance company configured ${templates.length} fee(s); there is no configured fee at position ${args.templateIndex}. Reload the deal.`
      );
    }
    const template = templates[args.templateIndex];
    if (template.feeType !== args.feeType) {
      throw new ConvexError(
        "The configured fee at that position is not the one you were shown. Reload the deal and record the actual against the fee as it is now listed."
      );
    }
    assertMinorAmount(args.actualAmountMinor, "Actual amount");
    // A timestamp, not a number: `v.number()` admits NaN, Infinity and
    // negatives, and a stored NaN date is a row no report can order.
    if (
      args.paidAt !== undefined &&
      (!Number.isSafeInteger(args.paidAt) || args.paidAt < 0)
    ) {
      throw new ConvexError(`The paid date must be a real timestamp (got ${args.paidAt}).`);
    }

    let custodyId: Id<"financeDealCustody"> | undefined;
    if (args.custodyId) {
      custodyId = await resolveFeeCustody(
        ctx, args.orgId, args.applicationId, args.custodyId, template.paidBy
      );
    }

    // The deal's denomination, proven BEFORE any write, exactly as
    // `recordDealFee` proves it (SCRUM-319).
    const currency = await resolveDealCurrency(ctx, app, "recording this cost");
    if (args.expectedCurrency !== currency) {
      throw new ConvexError(
        `This cost was entered in ${args.expectedCurrency}, but the deal's costs are kept in ${currency}. Reload the deal and enter the amount in ${currency}.`
      );
    }

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "financeDealCosts.recordTemplateFeeActual",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        // The WHOLE persisted input, position included: the same key against a
        // different position, amount, date, reference, attachment or custody
        // is a different intent and is refused, not replayed.
        fingerprint: JSON.stringify({
          applicationId: args.applicationId,
          templateIndex: args.templateIndex,
          feeType: args.feeType,
          expectedCurrency: args.expectedCurrency,
          actualAmountMinor: args.actualAmountMinor,
          custodyId: args.custodyId ?? null,
          paidAt: args.paidAt ?? null,
          receiptReference: args.receiptReference?.trim() || null,
          documentStorageIds: args.documentStorageIds?.map((id) => id.toString()) ?? null,
        }),
      },
      async () => {
        // Inside the idempotent section on purpose: a replay of the SAME
        // intent returns the line it already wrote before reaching this, while
        // a NEW intent against a position that already has a live line is
        // refused here and rolls back with nothing committed. Proven on the
        // live-position index with every field an equality and `.unique()`:
        // a second live line at one position is a state this writer never
        // creates, and if one is ever found the read refuses rather than picks.
        const existing = await ctx.db
          .query("financeDealFees")
          .withIndex("by_application_source_templateIndex_voidedAt", (q) =>
            q
              .eq("applicationId", args.applicationId)
              .eq("source", "COMPANY_TEMPLATE")
              .eq("templateIndex", args.templateIndex)
              .eq("voidedAt", undefined)
          )
          .unique();
        if (existing) {
          throw new ConvexError(
            "An actual is already recorded for this configured fee. Edit that line to change the amount, or remove it first."
          );
        }
        // Same bound as `recordDealFee`, in the same place: before the
        // classification is touched or the line exists.
        assertRoomForAnotherLine(await loadActiveFees(ctx, args.applicationId), "recording this cost");

        await invalidateClassification(
          ctx, app, user._id,
          "A new cost was added to the deal after its accounting was classified."
        );

        const now = Date.now();
        return await ctx.db.insert("financeDealFees", {
          orgId: args.orgId,
          applicationId: args.applicationId,
          feeType: template.feeType,
          description: template.description?.trim() || undefined,
          currency,
          // The template's expectation, copied — never the caller's.
          estimatedAmountMinor: template.estimatedAmountMinor,
          actualAmountMinor: args.actualAmountMinor,
          paidBy: template.paidBy,
          paidTo: template.paidTo,
          accountingTreatment: template.accountingTreatment,
          includedInQuotation: template.includedInQuotation,
          deductedFromSettlement: template.deductedFromSettlement,
          refundable: template.refundable,
          custodyId,
          paidAt: args.paidAt,
          receiptReference: args.receiptReference?.trim() || undefined,
          documentStorageIds: args.documentStorageIds,
          source: "COMPANY_TEMPLATE",
          templateIndex: args.templateIndex,
          createdBy: user._id,
          createdAt: now,
          updatedAt: now,
        });
      }
    );
  },
});

/**
 * Records what a cost actually came to.
 *
 * Kept apart from the estimate rather than replacing it, so the comparison
 * survives. Re-recording a different actual is allowed — a receipt can be wrong
 * — but it clears any prior reconciliation, because a figure somebody checked
 * and a figure somebody then changed are not the same claim.
 *
 * No idempotency key, unlike its neighbours: this sets a named field on one
 * identified row to a value the caller supplies, so replaying it converges on
 * the same state instead of accumulating. The keys belong on the inserts, where
 * a retry adds a charge or a payment that nobody made.
 *
 * The amount is a bare integer, so the caller MUST say which currency it
 * counted it in (SCRUM-319). It is compared with the row's stored `currency` —
 * never with the org's current one, and never used to relabel the row: a form
 * still open from before a settings change sends its integer at the scale it
 * was rendered in, and that integer is refused rather than patched onto a
 * row denominated in something else.
 */
export const recordActualFeeAmount = mutation({
  args: {
    orgId: v.id("organizations"),
    feeId: v.id("financeDealFees"),
    actualAmountMinor: v.number(),
    /** REQUIRED. The currency the caller counted `actualAmountMinor` in. */
    expectedCurrency: v.string(),
    paidAt: v.optional(v.number()),
    receiptReference: v.optional(v.string()),
    documentStorageIds: v.optional(v.array(v.id("_storage"))),
    custodyId: v.optional(v.id("financeDealCustody")),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CREATE_FINANCE_APPLICATION,
    ]);
    const user = auth.user;
    const fee = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeDealFees",
      args.feeId,
      FEE_NOT_FOUND
    );
    if (fee.voidedAt !== undefined) {
      throw new ConvexError("This cost has been voided. Add a new line instead.");
    }
    assertExpectedCurrency(args.expectedCurrency, "recording this actual amount");
    // A stored denomination nobody can vouch for (a raw-edited "JD") is not one
    // the integer can be checked against; refuse rather than patch blind.
    assertSupportedDenomination(fee.currency, "recording this actual amount");
    if (args.expectedCurrency !== fee.currency) {
      throw new ConvexError(
        `This amount was entered in ${args.expectedCurrency}, but this cost line is recorded in ${fee.currency}. Reload the deal and enter the amount in ${fee.currency}.`
      );
    }
    assertMinorAmount(args.actualAmountMinor, "Actual amount");
    // The more destructive of the two siblings: voiding preserves the amount
    // and records a reason, while this replaces the figure, the checker's
    // identity and their notes outright. Escalating only `voidDealFee` left the
    // easier route wide open.
    if (fee.reconciledAt !== undefined) {
      assertMayUndoReconciliation(auth, "Changing an amount that has been reconciled");
      await ctx.db.insert("financeApplicationOverrides", {
        orgId: args.orgId,
        applicationId: fee.applicationId,
        field: "financeDealFees.actualAmountMinor",
        previousValue: `${fee.actualAmountMinor} (reconciled: ${fee.reconciliationNotes ?? "no note"})`,
        newValue: String(args.actualAmountMinor),
        reason: "A reconciled cost was re-recorded, withdrawing the reconciliation.",
        changedBy: user._id,
        changedAt: Date.now(),
      });
    }

    const custodyId = args.custodyId
      ? await resolveFeeCustody(ctx, args.orgId, fee.applicationId, args.custodyId, fee.paidBy)
      : fee.custodyId;
    // Editing the amount on a line that a CLOSED custody record was balanced
    // against would leave that record permanently wrong with no way to correct
    // it — `recordCustodyMovement` refuses once it is closed.
    if (fee.custodyId) {
      const existing = await ctx.db.get(fee.custodyId);
      if (existing) assertCustodyOpen(existing);
    }

    const nextStorageIds = args.documentStorageIds ?? fee.documentStorageIds;
    await deleteDroppedAttachments(ctx, fee.documentStorageIds, args.documentStorageIds);

    const parent = await ctx.db.get(fee.applicationId);
    if (parent) {
      await invalidateClassification(
        ctx, parent, user._id,
        "A recorded cost was changed after the deal's accounting was classified."
      );
    }

    await ctx.db.patch(args.feeId, {
      actualAmountMinor: args.actualAmountMinor,
      paidAt: args.paidAt ?? fee.paidAt,
      receiptReference: args.receiptReference?.trim() || fee.receiptReference,
      documentStorageIds: nextStorageIds,
      custodyId,
      // Changing the amount invalidates the check that was made against the old
      // one. Leaving the reconciliation in place would let an edit slip past
      // the only gate that stands between an estimate and a closed deal.
      reconciledAt: undefined,
      reconciledBy: undefined,
      reconciliationNotes: undefined,
      updatedAt: Date.now(),
    });
    return args.feeId;
  },
});

/**
 * Confirms an actual against its evidence.
 *
 * Separate from recording the amount because they are separate acts, usually by
 * separate people. This is the one that lets a deal close, so it demands a note
 * saying what was checked — a reconciliation with no record of what was looked
 * at is indistinguishable from a click.
 */
export const reconcileDealFee = mutation({
  args: {
    orgId: v.id("organizations"),
    feeId: v.id("financeDealFees"),
    notes: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
    ]);
    const fee = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeDealFees",
      args.feeId,
      FEE_NOT_FOUND
    );
    if (fee.voidedAt !== undefined) {
      throw new ConvexError("This cost has been voided and cannot be reconciled.");
    }
    if (fee.actualAmountMinor === undefined) {
      throw new ConvexError(
        "Record what this cost actually came to before reconciling it. An estimate is not evidence."
      );
    }
    // Re-reconciling silently replaced the first checker's identity and notes.
    // Same privilege on both sides, so this is attribution loss rather than
    // escalation — but the notes are the evidence that anybody looked.
    if (fee.reconciledAt !== undefined) {
      throw new ConvexError(
        "This cost has already been reconciled. Re-record its amount if the figure is wrong; that withdraws the reconciliation."
      );
    }
    const notes = args.notes.trim();
    if (!notes) {
      throw new ConvexError("Record what was checked before reconciling this cost.");
    }

    await ctx.db.patch(args.feeId, {
      reconciledAt: Date.now(),
      reconciledBy: user._id,
      reconciliationNotes: notes,
      updatedAt: Date.now(),
    });
    return args.feeId;
  },
});

/** Voids a cost line, keeping it visible. Deleting it would erase that it existed. */
export const voidDealFee = mutation({
  args: {
    orgId: v.id("organizations"),
    feeId: v.id("financeDealFees"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    // Voiding a RECONCILED line destroys work done under a higher permission —
    // it removes the amount from every total, which can unbalance a closed
    // custody record and turn a deal that failed the classification gate into
    // one that passes it. CREATE is held by SALES; confirming is not.
    const auth = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CREATE_FINANCE_APPLICATION,
    ]);
    const user = auth.user;
    const fee = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeDealFees",
      args.feeId,
      FEE_NOT_FOUND
    );
    const reason = args.reason.trim();
    if (!reason) {
      throw new ConvexError("Say why this cost is being removed.");
    }
    if (fee.voidedAt !== undefined) return args.feeId;
    if (fee.reconciledAt !== undefined) {
      assertMayUndoReconciliation(auth, "Removing a cost that has been reconciled");
    }
    if (fee.custodyId) {
      const custody = await ctx.db.get(fee.custodyId);
      if (custody) assertCustodyOpen(custody);
    }

    const voidParent = await ctx.db.get(fee.applicationId);
    if (voidParent) {
      await invalidateClassification(
        ctx, voidParent, user._id,
        "A cost was removed from the deal after its accounting was classified."
      );
    }

    await ctx.db.patch(args.feeId, {
      voidedAt: Date.now(),
      voidedBy: user._id,
      voidReason: reason,
      updatedAt: Date.now(),
    });
    return args.feeId;
  },
});

// ---------------------------------------------------------------------------
// Employee custody
// ---------------------------------------------------------------------------

/**
 * Opens a custody record for an employee sent out to pay a deal's costs.
 *
 * One open record per employee per deal: a second would let the same receipt be
 * reconciled twice and make "what is this person holding" ambiguous.
 */
export const openDealCustody = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    userId: v.id("users"),
    issuedMinor: v.number(),
    method: v.optional(
      v.union(
        v.literal("CASH"),
        v.literal("BANK_TRANSFER"),
        v.literal("CHEQUE"),
        v.literal("CARD")
      )
    ),
    reference: v.optional(v.string()),
    note: v.optional(v.string()),
    occurredAt: v.optional(v.number()),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
    ]);
    const app = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
      APPLICATION_NOT_FOUND
    );
    assertMinorAmount(args.issuedMinor, "Issued amount");
    if (args.issuedMinor <= 0) {
      throw new ConvexError("The amount handed over must be greater than zero.");
    }

    // The recipient must be a member of this organization. Without this a
    // caller could hand custody — and a reimbursement claim — to a user id from
    // another tenant. The shared helper rather than a local membership lookup:
    // it also rejects a membership that is mid-offboarding, which the local
    // version accepted because a row was present. `requireTenantAuth` refuses
    // to authenticate that person, so cash handed to them on the way out leaves
    // a balance they can never return, reconcile or claim against themselves.
    await requireOrgMember(
      ctx,
      args.orgId,
      args.userId,
      AppErrorCode.ASSIGNED_USER_NOT_MEMBER,
      "That person is not a member of this organization."
    );

    // The sole record of cash handed to a person. Letting the same someone
    // issue it to themselves, reimburse themselves and close the record is an
    // uncontrolled loop around the one control this table provides — the same
    // separation the approval path already enforces.
    if (args.userId === user._id) {
      throw new ConvexError(
        "Custody has to be issued by somebody other than the person receiving it."
      );
    }

    // The one-open-record rule stops a retry creating a second custody, so the
    // key is not what protects the money here — it is what makes the retry
    // return the record instead of an error about a record the caller's own
    // first attempt created.
    //
    // Which is why the rule lives INSIDE the callback. Checked before the
    // wrapper it ran on every replay, found the row the first attempt had just
    // inserted, and threw the exact error the key exists to prevent — the
    // comment here described behaviour the ordering made impossible. A replay
    // never reaches the callback, so it returns the stored id; a genuine second
    // request does reach it, and still fails.
    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "financeDealCosts.openDealCustody",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({
          applicationId: args.applicationId,
          userId: args.userId,
          issuedMinor: args.issuedMinor,
          method: args.method ?? null,
          reference: args.reference?.trim() || null,
          occurredAt: args.occurredAt ?? null,
        }),
      },
      async () => {
        const existing = (await custodyFor(ctx, args.applicationId)).find(
          (row) => row.userId === args.userId && row.status === "OPEN"
        );
        if (existing) {
          throw new ConvexError(
            "This person already holds an open custody record on this deal. Record the money against that one."
          );
        }

        await invalidateClassification(
          ctx, app, user._id,
          "Custody was opened on the deal after its accounting was classified."
        );

        const currency = await resolveDealCurrency(ctx, app, "opening custody on this deal");
        const now = Date.now();
        const custodyId = await ctx.db.insert("financeDealCustody", {
          orgId: args.orgId,
          applicationId: args.applicationId,
          userId: args.userId,
          currency,
          issuedMinor: 0,
          returnedMinor: 0,
          reimbursedMinor: 0,
          status: "OPEN",
          createdBy: user._id,
          createdAt: now,
          updatedAt: now,
        });

        await ctx.db.insert("financeDealCustodyEntries", {
          orgId: args.orgId,
          custodyId,
          kind: "ISSUED",
          amountMinor: args.issuedMinor,
          method: args.method,
          reference: args.reference?.trim() || undefined,
          note: args.note?.trim() || undefined,
          occurredAt: args.occurredAt ?? now,
          recordedBy: user._id,
          recordedAt: now,
        });
        await recomputeCustodyTotals(ctx, custodyId);
        return custodyId;
      }
    );
  },
});

/**
 * Records a movement on an open custody record.
 *
 * Every total on the record is the sum of these, so a correction is a further
 * entry rather than an overwrite — the movement that was wrong stays visible
 * alongside the one that fixed it.
 */
export const recordCustodyMovement = mutation({
  args: {
    orgId: v.id("organizations"),
    custodyId: v.id("financeDealCustody"),
    kind: v.union(
      v.literal("ISSUED"),
      v.literal("RETURNED"),
      v.literal("REIMBURSED"),
      v.literal("REVERSAL")
    ),
    /** Required on a REVERSAL, rejected otherwise. */
    reversesEntryId: v.optional(v.id("financeDealCustodyEntries")),
    amountMinor: v.number(),
    method: v.optional(
      v.union(
        v.literal("CASH"),
        v.literal("BANK_TRANSFER"),
        v.literal("CHEQUE"),
        v.literal("CARD")
      )
    ),
    reference: v.optional(v.string()),
    note: v.optional(v.string()),
    occurredAt: v.optional(v.number()),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
    ]);
    const custody = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeDealCustody",
      args.custodyId,
      CUSTODY_NOT_FOUND
    );
    if (custody.status !== "OPEN") {
      throw new ConvexError(
        "This custody record is already closed. Reopen it before recording more movement."
      );
    }
    assertMinorAmount(args.amountMinor, "Amount");
    if (args.amountMinor <= 0) {
      throw new ConvexError("The amount must be greater than zero.");
    }

    if (args.kind === "REVERSAL") {
      await assertReversalAllowed(ctx, args.orgId, args.custodyId, args.reversesEntryId, args.amountMinor);
    } else if (args.reversesEntryId) {
      throw new ConvexError("Only a reversal may name the movement it cancels.");
    }

    // A return larger than what was handed over is a typo, not a fact — and
    // left alone it drives the balance negative, so the module then instructs
    // somebody to pay a reimbursement that is not owed.
    if (args.kind === "RETURNED") {
      const projected = custody.returnedMinor + args.amountMinor;
      if (projected > custody.issuedMinor) {
        throw new ConvexError(
          `That would return ${projected} minor units against ${custody.issuedMinor} issued. Correct the issuance first, or reverse the movement that is wrong.`
        );
      }
    }

    // The one that matters most: a retried REIMBURSED records the dealership
    // paying the same person twice. The module surfaces that afterwards as
    // `reimbursementOverpaidMinor` rather than clamping it away, which is right
    // — but detecting a double payment is a worse outcome than not making one.
    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "financeDealCosts.recordCustodyMovement",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({
          custodyId: args.custodyId,
          kind: args.kind,
          reversesEntryId: args.reversesEntryId ?? null,
          amountMinor: args.amountMinor,
          method: args.method ?? null,
          reference: args.reference?.trim() || null,
          occurredAt: args.occurredAt ?? null,
        }),
      },
      async () => {
        const now = Date.now();
        await ctx.db.insert("financeDealCustodyEntries", {
          orgId: args.orgId,
          custodyId: args.custodyId,
          kind: args.kind,
          ...(args.reversesEntryId ? { reversesEntryId: args.reversesEntryId } : {}),
          amountMinor: args.amountMinor,
          method: args.method,
          reference: args.reference?.trim() || undefined,
          note: args.note?.trim() || undefined,
          occurredAt: args.occurredAt ?? now,
          recordedBy: user._id,
          recordedAt: now,
        });
        await recomputeCustodyTotals(ctx, args.custodyId);
        return args.custodyId;
      }
    );
  },
});

/**
 * Closes a custody record once nothing is outstanding in either direction.
 *
 * Refuses while the employee still holds money OR the dealership still owes
 * them. The second half is the one worth stating: a record where the dealership
 * owes 50 is not "reconciled with a small variance", it is an unpaid debt to a
 * person, and closing it would quietly write that debt off.
 */
export const reconcileDealCustody = mutation({
  args: {
    orgId: v.id("organizations"),
    custodyId: v.id("financeDealCustody"),
    notes: v.string(),
    /** Closes a genuinely unaccountable difference, recorded as a write-off. */
    writeOffReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
    ]);
    const custody = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeDealCustody",
      args.custodyId,
      CUSTODY_NOT_FOUND
    );
    if (custody.status !== "OPEN") {
      throw new ConvexError("This custody record is already closed.");
    }
    const notes = args.notes.trim();
    if (!notes) {
      throw new ConvexError("Record what was checked before closing this custody record.");
    }

    const summary = summarizeCustody(
      custody,
      custodyActualExpensesMinor(
        await loadActiveFees(ctx, custody.applicationId),
        args.custodyId
      )
    );
    const writeOffReason = args.writeOffReason?.trim();

    // A write-off is the dealership absorbing a loss. It is NOT a way to stop
    // owing somebody: money the dealership owes an employee, closed unpaid, is
    // just a decision not to pay a person — and the classification gate would
    // then wave the deal through as settled. That direction has to be paid or
    // explicitly reversed.
    if (summary.reimbursementOutstandingMinor > 0) {
      throw new ConvexError(
        `${summary.reimbursementOutstandingMinor} minor units are still owed to this person. Record the reimbursement before closing — a debt owed to an employee cannot be written off here.`
      );
    }
    if (summary.reimbursementOverpaidMinor > 0) {
      throw new ConvexError(
        `This person has been reimbursed ${summary.reimbursementOverpaidMinor} minor units more than they were owed. Reverse the duplicate movement before closing.`
      );
    }
    if (!summary.settled && !writeOffReason) {
      throw new ConvexError(
        `This custody record does not balance. ${summary.employeeOwesDealerMinor} minor units are still unaccounted for — record the receipts or the returned balance. To close it anyway, record a write-off reason.`
      );
    }

    const now = Date.now();
    await ctx.db.patch(args.custodyId, {
      status: writeOffReason && !summary.settled ? "WRITTEN_OFF" : "RECONCILED",
      reconciledAt: now,
      reconciledBy: user._id,
      reconciliationNotes: notes,
      writeOffReason: writeOffReason && !summary.settled ? writeOffReason : undefined,
      updatedAt: now,
    });
    return args.custodyId;
  },
});

/**
 * Reopens a closed custody record so it can be corrected.
 *
 * The mutation the closed path always needed. Without it, a late receipt
 * recorded against a reconciled record left it stored as balanced while the
 * arithmetic said the employee was out of pocket — and every route to fixing it
 * refused, with an error naming this function before it existed.
 */
export const reopenDealCustody = mutation({
  args: {
    orgId: v.id("organizations"),
    custodyId: v.id("financeDealCustody"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
    ]);
    const custody = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeDealCustody",
      args.custodyId,
      CUSTODY_NOT_FOUND
    );
    if (custody.status === "OPEN") return args.custodyId;
    const reason = args.reason.trim();
    if (!reason) {
      throw new ConvexError("Say why this custody record is being reopened.");
    }

    // Reopening undoes a reconciliation somebody signed off, so it leaves a row
    // — and it withdraws the deal's classification, which may have been granted
    // on the strength of this record being settled.
    await ctx.db.insert("financeApplicationOverrides", {
      orgId: args.orgId,
      applicationId: custody.applicationId,
      field: "financeDealCustody.status",
      // The whole of what the patch below erases, not just the status. A
      // write-off reason is the business justification for a loss the
      // dealership absorbed; losing it makes that loss unexplainable.
      previousValue: `${custody.status} (write-off: ${custody.writeOffReason ?? "none"}; notes: ${custody.reconciliationNotes ?? "none"})`,
      newValue: "OPEN",
      reason,
      changedBy: user._id,
      changedAt: Date.now(),
    });
    const app = await ctx.db.get(custody.applicationId);
    if (app) {
      await invalidateClassification(
        ctx, app, user._id,
        "A custody record was reopened after the deal's accounting was classified."
      );
    }

    await ctx.db.patch(args.custodyId, {
      status: "OPEN",
      reconciledAt: undefined,
      reconciledBy: undefined,
      reconciliationNotes: undefined,
      writeOffReason: undefined,
      updatedAt: Date.now(),
    });
    return args.custodyId;
  },
});

// ---------------------------------------------------------------------------
// The legal invoice, and accounting classification
// ---------------------------------------------------------------------------

/**
 * Records the deal's legally documented transaction price.
 *
 * This figure comes off the invoice and the purchase agreement. It is asked for
 * explicitly, and never derived from the dealer's target selling amount or the
 * finance company's approved purchase amount, because on a financed deal those
 * are three different numbers describing three different things — and only this
 * one is what the parties signed.
 */
export const recordLegalInvoice = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    legalInvoiceAmountMinor: v.number(),
    legalInvoiceNumber: v.string(),
    legalInvoiceDate: v.number(),
    issuedTo: v.union(
      v.literal("CUSTOMER"),
      v.literal("FINANCE_COMPANY"),
      v.literal("OTHER")
    ),
    issuedToOther: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
    ]);
    const app = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
      APPLICATION_NOT_FOUND
    );
    assertMinorAmount(args.legalInvoiceAmountMinor, "Legal invoice amount");
    if (args.legalInvoiceAmountMinor <= 0) {
      throw new ConvexError("The invoice amount must be greater than zero.");
    }
    const invoiceNumber = args.legalInvoiceNumber.trim();
    if (!invoiceNumber) {
      throw new ConvexError("Record the invoice number.");
    }
    const issuedToOther = args.issuedToOther?.trim();
    if (args.issuedTo === "OTHER" && !issuedToOther) {
      throw new ConvexError("Say who the invoice was issued to.");
    }

    const now = Date.now();
    // Any change to a recorded invoice is audited, whatever moved — and the
    // comparison has to cover every field the patch below writes, or the claim
    // is false for whichever field it forgot. It forgot two: the date, which
    // decides the period revenue lands in, and the free-text recipient, which
    // is the counterparty's whole identity when issuedTo is OTHER. Both could
    // be moved silently while the amount stood still.
    const nextIssuedToOther = args.issuedTo === "OTHER" ? issuedToOther : undefined;
    const describe = (
      amountMinor: number | undefined,
      number: string | undefined,
      date: number | undefined,
      issuedTo: string | undefined,
      other: string | undefined
    ): string =>
      `${amountMinor ?? "unrecorded"} (invoice ${number || "unrecorded"} dated ${date ?? "unrecorded"} to ${issuedTo ?? "unrecorded"}${other ? ` — ${other}` : ""})`;

    if (
      app.legalInvoiceAmountMinor !== undefined &&
      (app.legalInvoiceAmountMinor !== args.legalInvoiceAmountMinor ||
        (app.legalInvoiceNumber ?? "") !== invoiceNumber ||
        app.legalInvoiceDate !== args.legalInvoiceDate ||
        app.legalInvoiceIssuedTo !== args.issuedTo ||
        (app.legalInvoiceIssuedToOther ?? undefined) !== nextIssuedToOther)
    ) {
      await ctx.db.insert("financeApplicationOverrides", {
        orgId: args.orgId,
        applicationId: args.applicationId,
        field: "legalInvoiceAmountMinor",
        previousValue: describe(
          app.legalInvoiceAmountMinor, app.legalInvoiceNumber,
          app.legalInvoiceDate, app.legalInvoiceIssuedTo, app.legalInvoiceIssuedToOther
        ),
        newValue: describe(
          args.legalInvoiceAmountMinor, invoiceNumber,
          args.legalInvoiceDate, args.issuedTo, nextIssuedToOther
        ),
        reason: "The recorded legal invoice was replaced.",
        changedBy: user._id,
        changedAt: now,
      });
    }

    await invalidateClassification(
      ctx, app, user._id,
      "The legal invoice was re-recorded after the deal's accounting was classified."
    );

    await ctx.db.patch(args.applicationId, {
      legalInvoiceAmountMinor: args.legalInvoiceAmountMinor,
      legalInvoiceNumber: invoiceNumber,
      legalInvoiceDate: args.legalInvoiceDate,
      legalInvoiceIssuedTo: args.issuedTo,
      legalInvoiceIssuedToOther: nextIssuedToOther,
      legalInvoiceRecordedBy: user._id,
      legalInvoiceRecordedAt: now,
      updatedAt: now,
    });
    return args.applicationId;
  },
});

/**
 * Marks a deal's accounting treatment as established.
 *
 * The gate the user asked for: estimates are fine to work from operationally,
 * but closure requires reconciliation. So this refuses while any cost is
 * unquantified, unrecorded or unchecked, while any custody record is open, or
 * while the legal invoice — the only figure revenue may be posted from — is
 * missing.
 *
 * It sets a flag and nothing else. No journal entry follows from it yet; that
 * design is deliberately unwritten until real documents confirm how a financed
 * sale is legally structured.
 */
export const classifyDealAccounting = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    notes: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
    ]);
    const app = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
      APPLICATION_NOT_FOUND
    );
    const notes = args.notes.trim();
    if (!notes) {
      throw new ConvexError("Record how this deal's accounting was established.");
    }

    if (app.legalInvoiceAmountMinor === undefined) {
      throw new ConvexError(
        "Record the deal's legal invoice before classifying its accounting. The invoice amount is the only figure revenue may be posted from."
      );
    }

    const fees = await loadActiveFees(ctx, args.applicationId);
    const summary = summarizeFees(fees);
    // A deal with no live cost lines is the state "nobody itemized anything",
    // which `summarizeFees` deliberately reports as NOT fully reconciled —
    // nothing to have reconciled and everything checking out are different
    // claims. Reading only the awaiting-counts let it through, because both are
    // zero for an empty list, so a financed deal with an invoice and no costs
    // at all classified clean.
    if (summary.lineCount === 0) {
      throw new ConvexError(
        "No costs have been itemized on this deal. Record them, or record a zero-cost line saying the dealership bore none, before classifying its accounting."
      );
    }
    if (summary.linesAwaitingActual > 0) {
      throw new ConvexError(
        `${summary.linesAwaitingActual} cost(s) on this deal have no actual amount recorded. Estimates may be used to run the deal, but not to close it.`
      );
    }
    if (summary.linesAwaitingReconciliation > 0) {
      throw new ConvexError(
        `${summary.linesAwaitingReconciliation} cost(s) on this deal have an amount but nobody has checked it. Reconcile them before closing.`
      );
    }
    // Every fee the finance company's FROZEN policy configures needs an actual
    // on the record too — the counts above cannot see a configured fee nobody
    // recorded. One rule for this door and for finalization's, judged on the
    // rows already read above; see `assertConfiguredFeesRecorded`.
    assertConfiguredFeesRecorded(app.companyRuleSnapshot, fees, "closing");

    // Read the arithmetic, not the stored status. A record can be closed and
    // still be unbalanced — a late receipt against a RECONCILED record is
    // exactly the case — and a gate that trusts the flag it is meant to be
    // guarding is not a gate.
    const custodyRows = await custodyFor(ctx, args.applicationId);
    for (const row of custodyRows) {
      if (row.status === "OPEN") {
        throw new ConvexError(
          "A custody record on this deal is still open. Settle what that person holds or is owed before classifying."
        );
      }
      const custodySummary = summarizeCustody(
        row,
        custodyActualExpensesMinor(fees, row._id)
      );
      if (!custodySummary.settled && row.status !== "WRITTEN_OFF") {
        throw new ConvexError(
          "A closed custody record on this deal no longer balances — its costs changed after it was reconciled. Reopen it and settle it before classifying."
        );
      }
    }

    if (app.accountingClassification === "CLASSIFIED") {
      throw new ConvexError(
        "This deal's accounting has already been classified. Change what it was based on to reopen it."
      );
    }

    // Establishing a deal's accounting means establishing the figures that
    // follow from it, not just stamping a flag beside them. Every settlement
    // cost above now has a checked actual, so this is the first moment the
    // expected remittance can be derived from what the company actually
    // withholds — and the last moment before finalization reads it.
    //
    // Ordered after the refusals deliberately: a deal that cannot be classified
    // must not have its stored economics moved on the way to being told so.
    await recomputeEconomicsForApplication(ctx, args.applicationId);

    const now = Date.now();
    await ctx.db.patch(args.applicationId, {
      accountingClassification: "CLASSIFIED",
      accountingClassifiedBy: user._id,
      accountingClassifiedAt: now,
      accountingClassificationNotes: notes,
      updatedAt: now,
    });
    return args.applicationId;
  },
});
