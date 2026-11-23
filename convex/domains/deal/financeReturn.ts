import { ConvexError } from "convex/values";
import { type MutationCtx } from "../../_generated/server";
import { type Doc, type Id } from "../../_generated/dataModel";
import { requireOwnedRow } from "../../utils/tenancy";
import { throwAppError, AppErrorCode } from "../../utils/errors";
import { assertNoActiveDealUnwind } from "../../utils/dealUnwindGuard";
import { notifyManagers, getActorName } from "../../utils/notifications";
import { MAX_IDEMPOTENCY_KEY_LENGTH } from "../../utils/idempotency";
import {
  hookFinanceCashReceivedReturned,
  isFinanceCashReceivedUndone,
} from "../../accounting/workflowHooks";
import {
  disbursementVersionOf,
  financeDisbursementKeys,
} from "../../utils/financeDisbursementKeys";
import { auditLog } from "../../utils/financialAuditWriter";
import {
  isFcLineage,
  FC_RETURN_MESSAGES,
  FC_RETURN_REASON_MAX_LENGTH,
} from "../../utils/fcCheque";
import { manualPayerOf } from "../../utils/manualFinancePayer";
import { FINANCE_APP_RECEIVABLE_SOURCE } from "./financeReceivables";

export function refuseFinanceReturn(
  code: keyof typeof FC_RETURN_MESSAGES,
): never {
  return throwAppError(AppErrorCode[code], FC_RETURN_MESSAGES[code]);
}

export function validateFinanceReturn(
  args: ReturnFinanceDisbursementChequeInput,
) {
  // The default idempotency refusals are plain strings; a dialog key that is
  // blank or too long is refused here, coded and translated, before any read.
  const keyLength = args.idempotencyKey.trim().length;
  if (keyLength === 0 || keyLength > MAX_IDEMPOTENCY_KEY_LENGTH) {
    refuseFinanceReturn("FINANCE_RETURN_KEY_INVALID");
  }
  const returnReason = args.returnReason.trim();
  if (returnReason === "")
    refuseFinanceReturn("FINANCE_RETURN_REASON_REQUIRED");
  if (returnReason.length > FC_RETURN_REASON_MAX_LENGTH) {
    // `max` rides beside the code so the dictionary's `{max}` is filled.
    throw new ConvexError({
      code: AppErrorCode.FINANCE_RETURN_REASON_TOO_LONG,
      message: FC_RETURN_MESSAGES.FINANCE_RETURN_REASON_TOO_LONG,
      max: FC_RETURN_REASON_MAX_LENGTH,
    });
  }
  return returnReason;
}

type ReturnFinanceDisbursementChequeInput = {
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  chequeId: Id<"postDatedCheques">;
  returnReason: string;
  idempotencyKey: string;
};

/**
 * SCRUM-239: the bank returned a finance-company cheque AFTER it cleared.
 *
 * INVARIANT: a CLEARED finance-company disbursement cheque becomes RETURNED only
 * through this one application-owned command, which in one transaction undoes
 * exactly that disbursement - the application's receipt fields, every ACTIVE
 * allocation of its canonical payment, the payment, and its own
 * FINANCE_CASH_RECEIVED occurrence - and nothing else. It never touches the
 * sale, the commission, the customer receivable, the forward rows, or another
 * disbursement's rows. The next `confirmDisbursement` runs at version + 1 and
 * mints fresh keys, so it cannot collide with what this reversed.
 *
 * Every refusal comes before the first write. There is deliberately NO forward
 * precondition: an open forward exception on the deal has its own path, and
 * refusing here would leave the operator with no way out (recordForward is the
 * only command it allows).
 */
export async function executeReturnFinanceDisbursementCheque(
  ctx: MutationCtx,
  args: ReturnFinanceDisbursementChequeInput,
  user: Doc<"users">,
  returnReason: string,
  reverseAllocation: (
    ctx: MutationCtx,
    args: {
      orgId: Id<"organizations">;
      allocationId: Id<"paymentAllocations">;
      actorId: Id<"users">;
    },
  ) => Promise<Id<"paymentAllocations">>,
  voidCanonicalPayment: (
    ctx: MutationCtx,
    args: {
      orgId: Id<"organizations">;
      paymentId: Id<"canonicalPayments">;
      actorId: Id<"users">;
    },
  ) => Promise<void>,
) {
  // A missing row and another organisation's row answer identically, so the
  // refusal never discloses that a foreign row exists.
  const app = await requireOwnedRow(
    ctx,
    args.orgId,
    "financeApplications",
    args.applicationId,
  ).catch(() => refuseFinanceReturn("FINANCE_RETURN_NOT_FOUND"));
  await assertNoActiveDealUnwind(ctx, args.orgId, args.applicationId);
  if (app.disbursedAt === undefined || app.disbursedAmountMinor === undefined) {
    refuseFinanceReturn("FINANCE_RETURN_NOT_DISBURSED");
  }
  const cheque = await requireOwnedRow(
    ctx,
    args.orgId,
    "postDatedCheques",
    args.chequeId,
  ).catch(() => refuseFinanceReturn("FINANCE_RETURN_NOT_FOUND"));
  if (cheque.status !== "CLEARED" || cheque.isDeleted === true) {
    refuseFinanceReturn("FINANCE_RETURN_CHEQUE_NOT_CLEARED");
  }

  // The cheque, the application and the payment must describe ONE
  // disbursement: the same version, the same instant, the same amount and
  // currency. The same binding `chequeLineageAudit` checks.
  const version = disbursementVersionOf(app);
  const keys = financeDisbursementKeys(args.applicationId, version);
  const anchorId = cheque.applicationId ?? cheque.originApplicationId;
  if (
    !isFcLineage(cheque) ||
    anchorId !== args.applicationId ||
    disbursementVersionOf(cheque) !== version ||
    cheque.clearedAt !== app.disbursedAt ||
    cheque.amountMinor !== app.disbursedAmountMinor ||
    cheque.currency === undefined
  ) {
    refuseFinanceReturn("FINANCE_RETURN_CHAIN_MISMATCH");
  }

  const payment = await ctx.db
    .query("canonicalPayments")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", args.orgId).eq("idempotencyKey", keys.paymentKey),
    )
    .unique();
  const expectedPayerType = app.companyId
    ? "FINANCE_COMPANY"
    : "MANUAL_FINANCE_COMPANY";
  const paymentCurrency = payment?.currency.toUpperCase();
  if (
    !payment ||
    payment.status !== "SETTLED" ||
    payment.direction !== "IN" ||
    payment.payerType !== expectedPayerType ||
    (app.companyId
      ? payment.financeCompanyId !== app.companyId
      : payment.payerNameSnapshot !== manualPayerOf(app)?.name) ||
    payment.amountMinor !== app.disbursedAmountMinor ||
    payment.receivedAt !== app.disbursedAt ||
    paymentCurrency !== cheque.currency.toUpperCase() ||
    (app.economicsCurrency !== undefined &&
      paymentCurrency !== app.economicsCurrency.toUpperCase())
  ) {
    refuseFinanceReturn("FINANCE_RETURN_CHAIN_MISMATCH");
  }

  // The remainder sentinel: the payment's ACTIVE allocations must be the
  // whole payment and all of them on THIS deal's finance-company
  // receivable. Anything else (a partial reversal by another path, an
  // allocation elsewhere) is refused rather than partly reversed.
  const receivable = await ctx.db
    .query("receivableDocuments")
    .withIndex("by_org_source", (q) =>
      q
        .eq("orgId", args.orgId)
        .eq("sourceType", FINANCE_APP_RECEIVABLE_SOURCE)
        .eq("sourceId", args.applicationId),
    )
    .unique();
  const activeAllocations = (
    await ctx.db
      .query("paymentAllocations")
      .withIndex("by_payment", (q) => q.eq("paymentId", payment._id))
      .collect()
  ).filter((allocation) => allocation.status === "ACTIVE");
  const allocatedMinor = activeAllocations.reduce(
    (sum, allocation) => sum + allocation.amountMinor,
    0,
  );
  if (
    !receivable ||
    activeAllocations.length === 0 ||
    allocatedMinor !== payment.amountMinor ||
    activeAllocations.some(
      (allocation) => allocation.receivableDocumentId !== receivable._id,
    )
  ) {
    refuseFinanceReturn("FINANCE_RETURN_ALLOCATION_SHAPE");
  }

  const now = Date.now();
  for (const allocation of activeAllocations) {
    await reverseAllocation(ctx, {
      orgId: args.orgId,
      allocationId: allocation._id,
      actorId: user._id,
    });
  }
  await voidCanonicalPayment(ctx, {
    orgId: args.orgId,
    paymentId: payment._id,
    actorId: user._id,
  });

  const reversal = await hookFinanceCashReceivedReturned(ctx, {
    orgId: args.orgId,
    applicationId: args.applicationId,
    disbursementVersion: version,
    reason: `Finance-company cheque returned after clearing: ${returnReason}`,
    actorId: user._id,
    reversalDate: now,
  });
  // The hook's string is not the evidence (it says REVERSED for any
  // reversal key it has seen). Read the books: a throw here rolls back
  // every write above.
  if (
    !(await isFinanceCashReceivedUndone(ctx, {
      orgId: args.orgId,
      applicationId: args.applicationId,
      disbursementVersion: version,
    }))
  ) {
    refuseFinanceReturn("FINANCE_RETURN_REVERSAL_UNPROVEN");
  }

  await ctx.db.patch(cheque._id, {
    status: "RETURNED",
    returnedAt: now,
    returnReason,
    returnedAfterClearing: true,
    disbursementVersion: version,
    updatedAt: now,
  });
  await ctx.db.patch(args.applicationId, {
    disbursedAt: undefined,
    disbursedAmountMinor: undefined,
    disbursementIdempotencyKey: undefined,
    settlementStatus: "EXPECTED",
    disbursementVersion: version + 1,
    updatedAt: now,
  });

  await auditLog(ctx, {
    orgId: args.orgId,
    actorId: user._id,
    actionType: "RETURN_FINANCE_DISBURSEMENT_CHEQUE",
    resourceType: "financeApplications",
    resourceId: args.applicationId,
    description: `Finance-company cheque returned after clearing: ${returnReason}`,
    before: {
      disbursedAt: app.disbursedAt,
      disbursedAmountMinor: app.disbursedAmountMinor,
      disbursementIdempotencyKey: app.disbursementIdempotencyKey,
      disbursementVersion: version,
      settlementStatus: app.settlementStatus,
    },
    after: {
      chequeId: cheque._id,
      paymentId: payment._id,
      reversedAllocationIds: activeAllocations.map(
        (allocation) => allocation._id,
      ),
      cashReceivedSourceId: keys.sourceId,
      reversalOutcome: reversal,
      disbursementVersion: version + 1,
    },
    idempotencyKey: args.idempotencyKey,
  });

  const actorName = await getActorName(ctx);
  await notifyManagers(
    ctx,
    args.orgId,
    "collection.cheque_returned",
    { actorName, amount: String(cheque.amount) }, // display figure the template expects, not the minor-unit face (1000x)
    { link: `/${args.orgId}/accounting` },
  );

  return {
    chequeId: cheque._id,
    returnedDisbursementVersion: version,
    nextDisbursementVersion: version + 1,
    reversal,
  };
}
