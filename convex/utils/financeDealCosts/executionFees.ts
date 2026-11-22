import type { MutationCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  APPLICATION_NOT_FOUND,
  assertDealEconomicsOpen,
  assertMayPostCustody,
  assertNotFuture,
  assertTimestamp,
  FEE_NOT_FOUND,
} from "./dealCostGuards";
import {
  assertExpectedCurrency,
  assertRoomForAnotherLine,
  loadActiveFees,
  resolveDealCurrency,
} from "../settlementDeductions";
import { executionFeeBindRefusal, executionFeeExpectation } from "../executionFeePosition";
import { ConvexError } from "convex/values";
import type { DealCostAccounting } from "./dealCostAccounting";
import { requireOwnedRow, requireTenantAuth } from "../tenancy";
import { PERMISSIONS } from "../permissions";
import { assertMinorAmount } from "../financingEconomics";
import {
  assertFeeDocWithinBytes,
  assertFeeTextWithinCap,
  feeAfterPatch,
  MAX_FEE_RECEIPT_REFERENCE_CHARS,
  MAX_FEE_VOID_REASON_CHARS,
} from "../feeDocLimits";
import { runWithIdempotency } from "../idempotency";
import { resolveFeeCustody } from "./custodyRecords";
import { syncCustodyFeePosting } from "./custodyPosting";
import { writeAuditLog } from "../auditLog";
import { recomputeAfterSettlementInputChange } from "./feeRecords";

/**
 * The deal's execution-fee position, proven for a binding write: the fee
 * applies, the deal's economics are open, and NO live line is bound yet. The
 * live lines are read whole (`loadActiveFees` refuses an over-capacity deal
 * rather than return a partial list), so "no other bound line" is proven, not
 * sampled.
 */
async function requireUnboundExecutionFee(
  ctx: MutationCtx,
  app: Doc<"financeApplications">,
  action: string
): Promise<{ currency: string; expectedMinor: number | null; liveFees: Array<Doc<"financeDealFees">> }> {
  assertDealEconomicsOpen(app, action);
  const currency = await resolveDealCurrency(ctx, app, action);
  const expectation = executionFeeExpectation(app, currency);
  if (!expectation.applies) {
    throw new ConvexError(
      "This deal's finance company charged no execution fee when the deal was created, so there is no execution fee to record. Record the cost as an additional cost instead."
    );
  }
  const liveFees = await loadActiveFees(ctx, app._id);
  if (liveFees.some((fee) => fee.executionFeeBinding !== undefined)) {
    throw new ConvexError(
      "An actual is already linked as this deal's execution fee. Edit that cost to change the amount, or unlink it first."
    );
  }
  return { currency, expectedMinor: expectation.expectedMinor, liveFees };
}

/**
 * Records what the dealership actually paid the finance company for its
 * EXECUTION FEE (SCRUM-690 F-PNTR-1, c22113 / c22119) and links the new line
 * as that fee's actual in the same write. Zero is a valid actual — "the fee
 * was not charged" — and retires the expectation like any other amount.
 *
 * The line is an ordinary `financeDealFees` line with fixed shape: a
 * finance-company fee, paid by the dealership (or an employee from custody),
 * treated as a finance-company commission, NOT withheld from the settlement —
 * the fee is a separate payment to the finance company (c21888). Because it is
 * bound it is a handover cost: a positive actual must be paid from custody or
 * by a direct dealership payment before the deal finalizes.
 *
 * Identity: `runWithIdempotency` over the whole persisted input. A new intent
 * against a deal whose fee is already linked is refused inside the section.
 */
export async function recordExecutionFeeActualHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    applicationId: Id<"financeApplications">;
    actualAmountMinor: number;
    expectedCurrency: string;
    paidBy: "DEALER" | "EMPLOYEE";
    paidAt?: number;
    receiptReference?: string;
    custodyId?: Id<"financeDealCustody">;
    idempotencyKey: string;
  },
  accounting: DealCostAccounting
) {
  const auth = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_FINANCE_APPLICATION]);
  const user = auth.user;
  assertExpectedCurrency(args.expectedCurrency, "recording the execution fee");
  const app = await requireOwnedRow(ctx, args.orgId, "financeApplications", args.applicationId, APPLICATION_NOT_FOUND);
  assertMinorAmount(args.actualAmountMinor, "Actual amount");
  if (args.custodyId) assertMayPostCustody(auth, "Charging the execution fee to an employee's custody");
  assertFeeTextWithinCap(args.receiptReference?.trim(), MAX_FEE_RECEIPT_REFERENCE_CHARS, "The receipt reference", "recording the execution fee");
  assertTimestamp(args.paidAt, "The paid date");
  assertNotFuture(args.paidAt, Date.now(), "The paid date");

  return await runWithIdempotency(
    ctx,
    {
      orgId: args.orgId,
      operation: "financeDealCosts.recordExecutionFeeActual",
      economic: true,
      idempotencyKey: args.idempotencyKey,
      actorId: user._id,
      fingerprint: JSON.stringify({
        applicationId: args.applicationId,
        expectedCurrency: args.expectedCurrency,
        actualAmountMinor: args.actualAmountMinor,
        paidBy: args.paidBy,
        custodyId: args.custodyId ?? null,
        paidAt: args.paidAt ?? null,
        receiptReference: args.receiptReference?.trim() || null,
      }),
    },
    async () => {
      const { currency, expectedMinor, liveFees } = await requireUnboundExecutionFee(ctx, app, "recording the execution fee");
      if (args.expectedCurrency !== currency) {
        throw new ConvexError(
          `This cost was entered in ${args.expectedCurrency}, but the deal's costs are kept in ${currency}. Reload the deal and enter the amount in ${currency}.`
        );
      }
      assertRoomForAnotherLine(liveFees, "recording the execution fee");
      const shape = {
        feeType: "FINANCE_COMPANY_FEE" as const,
        paidBy: args.paidBy,
        paidTo: "FINANCE_COMPANY" as const,
        accountingTreatment: "FINANCE_COMPANY_COMMISSION" as const,
        includedInQuotation: true,
        deductedFromSettlement: false,
        refundable: false,
        currency,
      };
      let custodyId: Id<"financeDealCustody"> | undefined;
      if (args.custodyId) {
        custodyId = await resolveFeeCustody(ctx, args.orgId, args.applicationId, args.custodyId, shape, user._id, accounting);
      }
      const now = Date.now();
      const line = {
        orgId: args.orgId,
        applicationId: args.applicationId,
        ...shape,
        description: "Execution fee",
        estimatedAmountMinor: expectedMinor ?? undefined,
        actualAmountMinor: args.actualAmountMinor,
        custodyId,
        paidAt: args.paidAt,
        receiptReference: args.receiptReference?.trim() || undefined,
        source: "MANUAL" as const,
        executionFeeBinding: { boundAt: now, boundBy: user._id },
        createdBy: user._id,
        createdAt: now,
        updatedAt: now,
      };
      assertFeeDocWithinBytes(line, "recording the execution fee");
      const feeId = await ctx.db.insert("financeDealFees", line);
      if (custodyId) await syncCustodyFeePosting(ctx, feeId, user._id, "Execution fee recorded against custody.");
      await writeAuditLog(ctx, user, {
        action: "financeDealCosts.executionFee.recordAndBind",
        targetTable: "financeDealFees",
        targetId: feeId,
        orgId: args.orgId,
        after: { applicationId: args.applicationId, actualAmountMinor: args.actualAmountMinor, paidBy: args.paidBy, expectedMinor },
      });
      await recomputeAfterSettlementInputChange(ctx, args.applicationId, false, accounting);
      return feeId;
    }
  );
}

/**
 * Links an EXISTING cost line as the deal's execution-fee actual (c22119 Q2):
 * for a fee already recorded as an ordinary cost. Explicit, by line id —
 * never inferred — and only when exactly this line is compatible
 * (`executionFeeBindRefusal`) and no live line is linked yet. Audited.
 * Converges on a state: re-linking the line already linked returns it.
 */
export async function bindExecutionFeeLineHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    feeId: Id<"financeDealFees">;
  },
  accounting: DealCostAccounting
) {
  const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_FINANCE_APPLICATION]);
  const fee = await requireOwnedRow(ctx, args.orgId, "financeDealFees", args.feeId, FEE_NOT_FOUND);
  if (fee.voidedAt === undefined && fee.executionFeeBinding !== undefined) return args.feeId;
  const app = await requireOwnedRow(ctx, args.orgId, "financeApplications", fee.applicationId, APPLICATION_NOT_FOUND);
  const { currency } = await requireUnboundExecutionFee(ctx, app, "linking the execution fee");
  const refusal = executionFeeBindRefusal(fee, currency);
  if (refusal !== null) throw new ConvexError(`${refusal} Nothing has been changed.`);
  const now = Date.now();
  const patch = { executionFeeBinding: { boundAt: now, boundBy: user._id }, updatedAt: now };
  assertFeeDocWithinBytes(feeAfterPatch(fee, patch), "linking the execution fee");
  await ctx.db.patch(args.feeId, patch);
  await writeAuditLog(ctx, user, {
    action: "financeDealCosts.executionFee.bind",
    targetTable: "financeDealFees",
    targetId: args.feeId,
    orgId: args.orgId,
    after: { applicationId: fee.applicationId, actualAmountMinor: fee.actualAmountMinor },
  });
  await recomputeAfterSettlementInputChange(ctx, fee.applicationId, fee.deductedFromSettlement, accounting);
  return args.feeId;
}

/**
 * Unlinks the execution fee's actual: the fee is UNRECORDED again (c22119 Q4)
 * and the line returns to an ordinary cost. Refused while the line carries a
 * custody posting or a direct payment — that cash went to the finance company
 * for this fee; remove the line (which reverses the payment) instead. Audited,
 * with the reason.
 */
export async function unbindExecutionFeeLineHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    feeId: Id<"financeDealFees">;
    reason: string;
  },
  accounting: DealCostAccounting
) {
  const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_FINANCE_APPLICATION]);
  const fee = await requireOwnedRow(ctx, args.orgId, "financeDealFees", args.feeId, FEE_NOT_FOUND);
  const reason = args.reason.trim();
  if (!reason) throw new ConvexError("Say why this cost is no longer the execution fee.");
  assertFeeTextWithinCap(reason, MAX_FEE_VOID_REASON_CHARS, "The reason", "unlinking the execution fee");
  if (fee.executionFeeBinding === undefined) return args.feeId;
  const app = await requireOwnedRow(ctx, args.orgId, "financeApplications", fee.applicationId, APPLICATION_NOT_FOUND);
  assertDealEconomicsOpen(app, "unlinking the execution fee");
  if (fee.custodyPosted !== undefined || fee.directPayment !== undefined) {
    throw new ConvexError(
      "This execution fee has a payment recorded against it. Remove the cost instead (its payment is reversed) and record the fee again. Nothing has been changed."
    );
  }
  const patch = { executionFeeBinding: undefined, updatedAt: Date.now() };
  await ctx.db.patch(args.feeId, patch);
  await writeAuditLog(ctx, user, {
    action: "financeDealCosts.executionFee.unbind",
    targetTable: "financeDealFees",
    targetId: args.feeId,
    orgId: args.orgId,
    before: { executionFeeBinding: fee.executionFeeBinding },
    after: { reason },
  });
  await recomputeAfterSettlementInputChange(ctx, fee.applicationId, fee.deductedFromSettlement, accounting);
  return args.feeId;
}
