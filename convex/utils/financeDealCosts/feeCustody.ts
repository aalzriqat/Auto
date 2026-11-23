import type { DealCostAccounting } from "./dealCostAccounting";
import { requireOwnedRow, requireTenantAuth } from "../tenancy";
import { PERMISSIONS } from "../permissions";
import {
  APPLICATION_NOT_FOUND,
  assertDealEconomicsOpen,
  assertMayPostCustody,
  assertMayUndoReconciliation,
  FEE_NOT_FOUND,
} from "./dealCostGuards";
import { ConvexError } from "convex/values";
import {
  assertFeeDocWithinBytes,
  assertFeeTextWithinCap,
  feeAfterPatch,
  MAX_FEE_VOID_REASON_CHARS,
} from "../feeDocLimits";
import {
  assertDirectPaymentCounterIntact,
  assertMayMoveDirectPayment,
  reverseDirectFeePayment,
} from "./directFeePayment";
import { assertCustodyOpen, assertNotCustodian, requireLinkedCustody, resolveFeeCustody } from "./custodyRecords";
import { syncCustodyFeePosting } from "./custodyPosting";
import { recomputeAfterSettlementInputChange } from "./feeRecords";
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";

/** Voids a cost line, keeping it visible. Deleting it would erase that it existed. */
export async function voidDealFeeHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    feeId: Id<"financeDealFees">;
    reason: string;
  },
  accounting: DealCostAccounting
) {
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
  assertFeeTextWithinCap(reason, MAX_FEE_VOID_REASON_CHARS, "The reason", "removing this cost");
  if (fee.voidedAt !== undefined) return args.feeId;
  // The parent must exist in this org (R6, F3); see recordActualFeeAmount.
  const parent = await requireOwnedRow(ctx, args.orgId, "financeApplications", fee.applicationId, APPLICATION_NOT_FOUND);
  assertDealEconomicsOpen(parent, "removing a cost");
  if (fee.reconciledAt !== undefined) {
    assertMayUndoReconciliation(auth, "Removing a cost that has been reconciled");
  }
  // Voiding a custody-charged line reverses its journal (AF-CUST-04).
  if (fee.custodyId) assertMayPostCustody(auth, "Removing a cost charged to an employee's custody");
  // So does voiding a line the dealership paid directly (SCRUM-443).
  if (fee.directPayment !== undefined) {
    assertMayMoveDirectPayment(auth, "Removing a cost the dealership paid directly");
    assertDirectPaymentCounterIntact(fee, "removing this cost");
  }
  // The record the line sits on, proven this org's on this deal (R7, F3)
  // — a link nobody can load is refused, never skipped past.
  if (fee.custodyId) {
    const custody = await requireLinkedCustody(ctx, fee, fee.custodyId, "removing a cost charged to a custody record");
    assertNotCustodian(custody, user._id, "Removing a cost charged to a custody record");
    assertCustodyOpen(custody);
  }

  const voidPatch = {
    voidedAt: Date.now(),
    voidedBy: user._id,
    voidReason: reason,
    updatedAt: Date.now(),
  };
  assertFeeDocWithinBytes(feeAfterPatch(fee, voidPatch), "removing this cost");
  await ctx.db.patch(args.feeId, voidPatch);
  // A voided line is no longer a custody-paid cost: its posting is reversed
  // (or its queued post cancelled) and the employee's clearing balance rises
  // back by the amount — the same arithmetic the summary performs.
  if (fee.custodyPosted) {
    await syncCustodyFeePosting(ctx, args.feeId, user._id, `Handover cost removed: ${reason}`);
  }
  // And a directly paid line's payment is reversed exactly once (SCRUM-443):
  // the second void returns above on `voidedAt`, and the helper is a no-op
  // once `directPayment` is cleared.
  if (fee.directPayment !== undefined) {
    await reverseDirectFeePayment(ctx, args.feeId, user._id, `Handover cost removed: ${reason}`);
  }
  await recomputeAfterSettlementInputChange(ctx, fee.applicationId, fee.deductedFromSettlement, accounting);
  return args.feeId;
}

/**
 * Charges an existing cost line to an employee's custody, or releases it.
 *
 * The attach action the deal screen offers beside a custody record: a
 * handover cost recorded as paid by the employee, with its actual on file,
 * moves onto (or off) the record and posts through `syncCustodyFeePosting`.
 * Same preconditions as recording a line against custody in the first place
 * (`resolveFeeCustody`); releasing needs the record open, since the line was
 * part of what it balanced against.
 *
 * Converges on a state rather than accumulating, so it takes no idempotency
 * key: a replay after a lost response finds `custodyPosted` already matching
 * and posts nothing.
 */
export async function setFeeCustodyHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    feeId: Id<"financeDealFees">;
    custodyId?: Id<"financeDealCustody">;
  },
  accounting: DealCostAccounting
) {
  const { user } = await requireTenantAuth(ctx, args.orgId, [
    PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
  ]);
  const fee = await requireOwnedRow(ctx, args.orgId, "financeDealFees", args.feeId, FEE_NOT_FOUND);
  if (fee.voidedAt !== undefined) {
    throw new ConvexError("This cost has been voided and cannot be charged to custody.");
  }
  if (fee.custodyId === args.custodyId) return args.feeId;
  // A line the dealership paid directly is never also charged to custody
  // (SCRUM-443): the one cost would reach the ledger twice.
  if (args.custodyId !== undefined && fee.directPayment !== undefined) {
    throw new ConvexError(
      "This cost was paid directly by the dealership, so it cannot also be charged to an employee's custody. Change its amount or remove it first if that payment was wrong. Nothing has been changed."
    );
  }
  // The parent must exist in this org (R6, F3); see recordActualFeeAmount.
  const app = await requireOwnedRow(ctx, args.orgId, "financeApplications", fee.applicationId, APPLICATION_NOT_FOUND);
  assertDealEconomicsOpen(app, "moving a cost onto or off custody");
  // The record the line leaves, proven this org's on this deal (R7, F3).
  if (fee.custodyId) {
    const current = await requireLinkedCustody(ctx, fee, fee.custodyId, "releasing a cost from a custody record");
    assertNotCustodian(current, user._id, "Releasing a cost from a custody record");
    assertCustodyOpen(current);
  }
  const custodyId = args.custodyId
    ? await resolveFeeCustody(ctx, args.orgId, fee.applicationId, args.custodyId, fee, user._id, accounting)
    : undefined;
  // `reconcileDealFee` refuses the holder of a record a line already sits on;
  // this is the same separation from the other side. Whoever certified the
  // figure is not the person the charge then reimburses (SCRUM-834 F2).
  if (custodyId !== undefined && fee.reconciledBy !== undefined) {
    const target = await requireLinkedCustody(ctx, fee, custodyId, "charging a reconciled cost to a custody record");
    if (target.userId === fee.reconciledBy) {
      throw new ConvexError(
        "This cost was reconciled by the person holding that custody record, who cannot then be reimbursed for it. Charge it to a different record, or have somebody else re-record and reconcile it. Nothing has been changed."
      );
    }
  }
  const now = Date.now();
  // The link patch is judged on its own, BEFORE it is written. The posting
  // that follows judges the line with its posting record, but returns early
  // (nothing to post: no actual, a zero actual, an unchanged target) without
  // reaching that judgement, so this patch would otherwise land unchecked
  // (SCRUM-443 v6, Sol F3).
  const linkPatch = { custodyId, updatedAt: now };
  assertFeeDocWithinBytes(feeAfterPatch(fee, linkPatch), "moving this cost onto or off custody");
  await ctx.db.patch(args.feeId, linkPatch);
  await syncCustodyFeePosting(
    ctx, args.feeId, user._id,
    custodyId ? "Handover cost charged to employee custody." : "Handover cost released from employee custody."
  );
  return args.feeId;
}
