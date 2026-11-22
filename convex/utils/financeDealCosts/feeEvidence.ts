import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import type { DealCostAccounting } from "./dealCostAccounting";
import { requireOwnedRow, requireTenantAuth } from "../tenancy";
import { PERMISSIONS } from "../permissions";
import {
  actualEvidenceRevisionOf,
  APPLICATION_NOT_FOUND,
  assertDealEconomicsOpen,
  assertMayPostCustody,
  assertMayUndoReconciliation,
  assertNotFuture,
  assertTimestamp,
  FEE_NOT_FOUND,
  nextActualEvidenceRevision,
} from "./dealCostGuards";
import { ConvexError } from "convex/values";
import { assertExpectedCurrency, assertFeeCustodyCurrency } from "../settlementDeductions";
import { assertSupportedDenomination } from "../money";
import { assertMinorAmount } from "../financingEconomics";
import {
  assertFeeAttachmentCount,
  assertFeeDocWithinBytes,
  assertFeeTextWithinCap,
  feeAfterPatch,
  MAX_FEE_RECEIPT_REFERENCE_CHARS,
  MAX_FEE_RECONCILIATION_NOTES_CHARS,
} from "../feeDocLimits";
import {
  assertActorNotCustodianOf,
  assertCustodyOnLedger,
  assertCustodyOpen,
  assertNotCustodian,
  requireLinkedCustody,
  resolveFeeCustody,
} from "./custodyRecords";
import {
  assertDirectPaymentCounterIntact,
  assertMayMoveDirectPayment,
  reverseDirectFeePayment,
} from "./directFeePayment";
import { syncCustodyFeePosting } from "./custodyPosting";
import { recomputeAfterSettlementInputChange } from "./feeRecords";

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
export async function recordActualFeeAmountHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    feeId: Id<"financeDealFees">;
    actualAmountMinor: number;
    expectedCurrency: string;
    paidAt?: number;
    receiptReference?: string;
    documentStorageIds?: Array<Id<"_storage">>;
    custodyId?: Id<"financeDealCustody">;
  },
  accounting: DealCostAccounting
) {
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
  assertFeeTextWithinCap(args.receiptReference?.trim(), MAX_FEE_RECEIPT_REFERENCE_CHARS, "The receipt reference", "recording this actual amount");
  assertTimestamp(args.paidAt, "The paid date");
  assertNotFuture(args.paidAt, Date.now(), "The paid date");
  // The parent must exist in this org (R6, F3): a line whose deal is gone or
  // another tenant's has no freeze to judge and is refused, never let through.
  const parent = await requireOwnedRow(ctx, args.orgId, "financeApplications", fee.applicationId, APPLICATION_NOT_FOUND);
  assertDealEconomicsOpen(parent, "changing a recorded cost");
  // The record the line already sits on, proven this org's on this deal
  // (R7, F3), and its holder never re-records the line (final round E) —
  // before the reconciliation override below is written.
  const existing = fee.custodyId
    ? await requireLinkedCustody(ctx, fee, fee.custodyId, "changing a cost charged to a custody record")
    : null;
  if (existing !== null) assertNotCustodian(existing, user._id, "Changing a cost charged to a custody record");
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

  // A line on custody re-posts its journal at the new figure; charging one
  // now posts it. Either way this is custody authority (AF-CUST-04).
  if (args.custodyId || fee.custodyId) {
    assertMayPostCustody(auth, "Changing a cost charged to an employee's custody");
  }
  // A line the dealership paid directly (SCRUM-443): a NEW amount takes the
  // recorded payment off the books and leaves the line unpaid, so it is the
  // disbursement authority's to do. An unchanged amount (a new receipt
  // reference, say) moves no money and needs nothing more. Never attached to
  // custody as well — that would put the one cost on the books twice.
  if (fee.directPayment !== undefined) {
    if (args.custodyId) {
      throw new ConvexError(
        "This cost was paid directly by the dealership, so it cannot also be charged to an employee's custody. Nothing has been changed."
      );
    }
    if (fee.directPayment.amountMinor !== args.actualAmountMinor) {
      assertMayMoveDirectPayment(auth, "Changing the amount of a cost the dealership paid directly");
      assertDirectPaymentCounterIntact(fee, "changing this amount");
    }
  }
  const custodyId = args.custodyId
    ? await resolveFeeCustody(ctx, args.orgId, fee.applicationId, args.custodyId, fee, user._id, accounting)
    : fee.custodyId;
  // Editing the amount on a line that a CLOSED custody record was balanced
  // against would leave that record permanently wrong with no way to correct
  // it — `recordCustodyMovement` refuses once it is closed. A legacy record
  // (no ledger behind it) refuses too: a new figure would post one leg.
  if (existing !== null) {
    assertCustodyOpen(existing);
    assertCustodyOnLedger(existing, "changing a cost charged to it");
    // A re-record re-posts the charge at the new figure against the
    // record's balance: a legacy link in another currency is refused
    // before the row or the ledger moves (R5, F4).
    assertFeeCustodyCurrency(fee, existing, "re-recording a cost charged to this custody record");
  }

  assertFeeAttachmentCount(args.documentStorageIds, "recording this actual amount");
  const nextStorageIds = args.documentStorageIds ?? fee.documentStorageIds;
  await deleteDroppedAttachments(ctx, fee.documentStorageIds, args.documentStorageIds);

  const amountPatch = {
    actualAmountMinor: args.actualAmountMinor,
    paidAt: args.paidAt ?? fee.paidAt,
    receiptReference: args.receiptReference?.trim() || fee.receiptReference,
    documentStorageIds: nextStorageIds,
    // Every re-record replaces the evidence a checker may be looking at, the
    // amount unchanged or not (SCRUM-834), so it always moves the revision.
    actualEvidenceRevision: nextActualEvidenceRevision(fee, "recording this actual amount"),
    custodyId,
    // Changing the amount invalidates the check that was made against the old
    // one. Leaving the reconciliation in place would let an edit slip past
    // the only gate that stands between an estimate and a closed deal.
    reconciledAt: undefined,
    reconciledBy: undefined,
    reconciliationNotes: undefined,
    updatedAt: Date.now(),
  };
  assertFeeDocWithinBytes(feeAfterPatch(fee, amountPatch), "recording this actual amount");
  await ctx.db.patch(args.feeId, amountPatch);
  // The ledger follows the row: a changed amount or custody reverses what
  // was posted and posts the line again at its new figure.
  if (custodyId || fee.custodyPosted) {
    await syncCustodyFeePosting(ctx, args.feeId, user._id, "Handover cost actual re-recorded.");
  }
  // The same for a direct payment (SCRUM-443): a payment recorded at the
  // OLD amount is reversed and the line is unpaid again until the operator
  // records it at the new one. An unchanged amount keeps it.
  if (fee.directPayment !== undefined && fee.directPayment.amountMinor !== args.actualAmountMinor) {
    await reverseDirectFeePayment(
      ctx, args.feeId, user._id,
      "Handover cost amount changed after its direct payment was recorded."
    );
  }
  // Always re-derive, even when the amount is unchanged: the recompute also
  // proves the deal's currency facts and company rules, and a drift there
  // must refuse (and roll back) this edit rather than slip through.
  await recomputeAfterSettlementInputChange(ctx, fee.applicationId, fee.deductedFromSettlement, accounting);
  return args.feeId;
}

/**
 * Confirms an actual against its evidence.
 *
 * Separate from recording the amount because they are separate acts, usually by
 * separate people. This is the one that lets a deal close, so it demands a note
 * saying what was checked — a reconciliation with no record of what was looked
 * at is indistinguishable from a click.
 */
export async function reconcileDealFeeHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    feeId: Id<"financeDealFees">;
    notes: string;
    expectedActualAmountMinor?: number;
    expectedActualEvidenceRevision?: number;
  }
) {
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
  // Both pins or neither (ROLLOUT BRIDGE). One without the other is not the
  // legacy call and not the pinned one, and silently reading it as either
  // would drop a protection the caller believed it had.
  const amountPin = args.expectedActualAmountMinor;
  const revisionPin = args.expectedActualEvidenceRevision;
  if ((amountPin === undefined) !== (revisionPin === undefined)) {
    throw new ConvexError(
      "A reconciliation pins both the amount and the evidence revision it was checked against, or neither; one without the other is refused. Reload the deal and try again. Nothing has been changed."
    );
  }
  if (fee.voidedAt !== undefined) {
    throw new ConvexError("This cost has been voided and cannot be reconciled.");
  }
  if (fee.actualAmountMinor === undefined) {
    throw new ConvexError(
      "Record what this cost actually came to before reconciling it. An estimate is not evidence."
    );
  }
  if (amountPin !== undefined && revisionPin !== undefined) {
    if (fee.actualAmountMinor !== amountPin) {
      throw new ConvexError(
        "The recorded amount of this cost has changed since you opened it, so your check no longer describes it. Reload the deal and check the current figure. Nothing has been changed."
      );
    }
    // The amount alone does not identify what was checked: a same-amount
    // re-record can replace the receipt reference, paid date or attachments.
    if (actualEvidenceRevisionOf(fee) !== revisionPin) {
      throw new ConvexError(
        "The receipt, paid date or attachments of this cost have been re-recorded since you opened it, so your check no longer describes them. Reload the deal and check the current evidence. Nothing has been changed."
      );
    }
  }
  // A line charged to custody is the evidence its holder is reimbursed
  // on; the holder does not certify it (final round E) — and the link is
  // proven this org's on this deal before it is trusted (R7, F3).
  if (fee.custodyId) {
    await assertActorNotCustodianOf(ctx, fee, fee.custodyId, user._id, "Reconciling a cost charged to a custody record");
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
  assertFeeTextWithinCap(notes, MAX_FEE_RECONCILIATION_NOTES_CHARS, "The reconciliation notes", "reconciling this cost");

  const reconcilePatch = {
    reconciledAt: Date.now(),
    reconciledBy: user._id,
    reconciliationNotes: notes,
    updatedAt: Date.now(),
  };
  assertFeeDocWithinBytes(feeAfterPatch(fee, reconcilePatch), "reconciling this cost");
  await ctx.db.patch(args.feeId, reconcilePatch);
  return args.feeId;
}
