import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx, QueryCtx } from "./_generated/server";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { getOrgCurrency } from "./accounting/workflowHooks";
import { reconcileEmployeeCustody } from "../lib/financingEconomics";
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

/** Live cost lines: everything not voided. */
async function activeFeesFor(
  ctx: QueryCtx | MutationCtx,
  applicationId: Id<"financeApplications">
): Promise<Array<Doc<"financeDealFees">>> {
  const rows = await ctx.db
    .query("financeDealFees")
    .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
    .collect();
  return rows.filter((row) => row.voidedAt === undefined);
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

/** Sum of recorded actuals on the lines this custody paid for. */
async function custodyActualExpensesMinor(
  ctx: QueryCtx | MutationCtx,
  custodyId: Id<"financeDealCustody">
): Promise<number> {
  const rows = await ctx.db
    .query("financeDealFees")
    .withIndex("by_custody", (q) => q.eq("custodyId", custodyId))
    .collect();
  return rows
    .filter((row) => row.voidedAt === undefined && row.actualAmountMinor !== undefined)
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

    const fees = await activeFeesFor(ctx, args.applicationId);
    const custodyRows = await custodyFor(ctx, args.applicationId);

    const custody = [];
    for (const row of custodyRows) {
      custody.push({
        ...row,
        summary: summarizeCustody(row, await custodyActualExpensesMinor(ctx, row._id)),
      });
    }

    return {
      currency: app.economicsCurrency ?? (await getOrgCurrency(ctx, args.orgId)),
      fees: fees.map((fee) => ({ ...fee, status: deriveFeeStatus(fee) })),
      summary: summarizeFees(fees),
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
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CREATE_FINANCE_APPLICATION,
    ]);
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
      const custody = await requireOwnedRow(
        ctx,
        args.orgId,
        "financeDealCustody",
        args.custodyId,
        CUSTODY_NOT_FOUND
      );
      if (custody.applicationId !== args.applicationId) {
        throw new ConvexError("That custody record belongs to a different deal.");
      }
      assertCustodyOpen(custody);
      // F3: the custody balance is "what this person spent of the money they
      // hold". Charging it for a cost somebody ELSE paid drives that balance to
      // zero while the cash is still in their pocket, and the record then
      // reconciles and closes clean. An obvious mis-click once a UI offers the
      // deal's custody in a dropdown.
      if (args.paidBy !== "EMPLOYEE") {
        throw new ConvexError(
          "A cost charged to an employee's custody must be recorded as paid by that employee. Remove the custody link, or record who actually paid."
        );
      }
      custodyId = custody._id;
    }

    await invalidateClassification(
      ctx, app, user._id,
      "A new cost was added to the deal after its accounting was classified."
    );

    const currency = app.economicsCurrency ?? (await getOrgCurrency(ctx, args.orgId));
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
  },
});

/**
 * Records what a cost actually came to.
 *
 * Kept apart from the estimate rather than replacing it, so the comparison
 * survives. Re-recording a different actual is allowed — a receipt can be wrong
 * — but it clears any prior reconciliation, because a figure somebody checked
 * and a figure somebody then changed are not the same claim.
 */
export const recordActualFeeAmount = mutation({
  args: {
    orgId: v.id("organizations"),
    feeId: v.id("financeDealFees"),
    actualAmountMinor: v.number(),
    paidAt: v.optional(v.number()),
    receiptReference: v.optional(v.string()),
    documentStorageIds: v.optional(v.array(v.id("_storage"))),
    custodyId: v.optional(v.id("financeDealCustody")),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CREATE_FINANCE_APPLICATION,
    ]);
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
    assertMinorAmount(args.actualAmountMinor, "Actual amount");

    let custodyId = fee.custodyId;
    if (args.custodyId) {
      const custody = await requireOwnedRow(
        ctx,
        args.orgId,
        "financeDealCustody",
        args.custodyId,
        CUSTODY_NOT_FOUND
      );
      if (custody.applicationId !== fee.applicationId) {
        throw new ConvexError("That custody record belongs to a different deal.");
      }
      assertCustodyOpen(custody);
      if (fee.paidBy !== "EMPLOYEE") {
        throw new ConvexError(
          "A cost charged to an employee's custody must be recorded as paid by that employee."
        );
      }
      custodyId = custody._id;
    }
    // Editing the amount on a line that a CLOSED custody record was balanced
    // against would leave that record permanently wrong with no way to correct
    // it — `recordCustodyMovement` refuses once it is closed.
    if (fee.custodyId) {
      const existing = await ctx.db.get(fee.custodyId);
      if (existing) assertCustodyOpen(existing);
    }

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
      documentStorageIds: args.documentStorageIds ?? fee.documentStorageIds,
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
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CREATE_FINANCE_APPLICATION,
    ]);
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
      await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT]);
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
    // another tenant.
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", args.userId))
      .unique();
    if (!membership) {
      throw new ConvexError("That person is not a member of this organization.");
    }

    // The sole record of cash handed to a person. Letting the same someone
    // issue it to themselves, reimburse themselves and close the record is an
    // uncontrolled loop around the one control this table provides — the same
    // separation the approval path already enforces.
    if (args.userId === user._id) {
      throw new ConvexError(
        "Custody has to be issued by somebody other than the person receiving it."
      );
    }

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

    const currency = app.economicsCurrency ?? (await getOrgCurrency(ctx, args.orgId));
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
      if (!args.reversesEntryId) {
        throw new ConvexError("Say which movement this reverses.");
      }
      const target = await requireOwnedRow(
        ctx,
        args.orgId,
        "financeDealCustodyEntries",
        args.reversesEntryId,
        "That movement was not found in this organization."
      );
      if (target.custodyId !== args.custodyId) {
        throw new ConvexError("That movement belongs to a different custody record.");
      }
      if (target.kind === "REVERSAL") {
        throw new ConvexError("A reversal cannot itself be reversed. Record the movement again.");
      }
      if (target.amountMinor !== args.amountMinor) {
        throw new ConvexError(
          `A reversal must cancel the whole movement. That one was ${target.amountMinor} minor units.`
        );
      }
      const already = await ctx.db
        .query("financeDealCustodyEntries")
        .withIndex("by_custody", (q) => q.eq("custodyId", args.custodyId))
        .collect();
      if (already.some((row) => row.reversesEntryId === args.reversesEntryId)) {
        throw new ConvexError("That movement has already been reversed.");
      }
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
      await custodyActualExpensesMinor(ctx, args.custodyId)
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
      previousValue: custody.status,
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
    // Any change to a recorded invoice is audited, whatever moved. This figure
    // is the one revenue may be posted from, so a silent edit to it is the most
    // consequential silent edit on the deal.
    if (
      app.legalInvoiceAmountMinor !== undefined &&
      (app.legalInvoiceAmountMinor !== args.legalInvoiceAmountMinor ||
        (app.legalInvoiceNumber ?? "") !== invoiceNumber ||
        app.legalInvoiceIssuedTo !== args.issuedTo)
    ) {
      await ctx.db.insert("financeApplicationOverrides", {
        orgId: args.orgId,
        applicationId: args.applicationId,
        field: "legalInvoiceAmountMinor",
        previousValue: `${app.legalInvoiceAmountMinor} (invoice ${app.legalInvoiceNumber ?? "unrecorded"} to ${app.legalInvoiceIssuedTo ?? "unrecorded"})`,
        newValue: `${args.legalInvoiceAmountMinor} (invoice ${invoiceNumber} to ${args.issuedTo})`,
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
      legalInvoiceIssuedToOther: args.issuedTo === "OTHER" ? issuedToOther : undefined,
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

    const fees = await activeFeesFor(ctx, args.applicationId);
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
        await custodyActualExpensesMinor(ctx, row._id)
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
