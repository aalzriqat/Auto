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

  return {
    lineCount: fees.length,
    estimatedTotalMinor,
    actualTotalMinor,
    /** What the dealership itself ended up out of pocket, on recorded actuals only. */
    dealerBorneActualMinor,
    linesAwaitingActual,
    linesAwaitingReconciliation,
    /** True only when every line has a checked actual. Estimates never satisfy this. */
    fullyReconciled: fees.length > 0 && linesAwaitingActual === 0 && linesAwaitingReconciliation === 0,
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
  });

  const outstandingReimbursementMinor = Math.max(
    0,
    reconciliation.dealerReimbursementDueMinor - custody.reimbursedMinor
  );

  return {
    ...reconciliation,
    actualExpensesMinor,
    reimbursedMinor: custody.reimbursedMinor,
    outstandingReimbursementMinor,
    settled:
      reconciliation.employeeOwesDealerMinor === 0 && outstandingReimbursementMinor === 0,
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

  let issuedMinor = 0;
  let returnedMinor = 0;
  let reimbursedMinor = 0;
  for (const entry of entries) {
    if (entry.kind === "ISSUED") issuedMinor += entry.amountMinor;
    else if (entry.kind === "RETURNED") returnedMinor += entry.amountMinor;
    else reimbursedMinor += entry.amountMinor;
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
      custodyId = custody._id;
    }

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
    custodyId: v.optional(v.id("financeDealCustody")),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_FINANCE_APPLICATION]);
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
      custodyId = custody._id;
    }

    await ctx.db.patch(args.feeId, {
      actualAmountMinor: args.actualAmountMinor,
      paidAt: args.paidAt ?? fee.paidAt,
      receiptReference: args.receiptReference?.trim() || fee.receiptReference,
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
    if (fee.voidedAt !== undefined) return args.feeId;
    const reason = args.reason.trim();
    if (!reason) {
      throw new ConvexError("Say why this cost is being removed.");
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

    const existing = (await custodyFor(ctx, args.applicationId)).find(
      (row) => row.userId === args.userId && row.status === "OPEN"
    );
    if (existing) {
      throw new ConvexError(
        "This person already holds an open custody record on this deal. Record the money against that one."
      );
    }

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
      v.literal("REIMBURSED")
    ),
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

    const now = Date.now();
    await ctx.db.insert("financeDealCustodyEntries", {
      orgId: args.orgId,
      custodyId: args.custodyId,
      kind: args.kind,
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

    if (!summary.settled && !writeOffReason) {
      const detail =
        summary.employeeOwesDealerMinor > 0
          ? `${summary.employeeOwesDealerMinor} minor units are still unaccounted for — record the receipts or the returned balance.`
          : `${summary.outstandingReimbursementMinor} minor units are still owed to this person — record the reimbursement.`;
      throw new ConvexError(
        `This custody record does not balance. ${detail} To close it anyway, record a write-off reason.`
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

    const openCustody = (await custodyFor(ctx, args.applicationId)).filter(
      (row) => row.status === "OPEN"
    );
    if (openCustody.length > 0) {
      throw new ConvexError(
        `${openCustody.length} custody record(s) on this deal are still open. Settle what each person holds or is owed before closing.`
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
