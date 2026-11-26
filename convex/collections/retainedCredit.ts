import type { PaginationOptions } from "convex/server";
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { availableRetainedCreditMinor } from "../accounting/invoiceReceiptReservation";
import {
  computeApplicableMinor,
  loadRetainedPosition,
  receiptApplicationSourceId,
  recordRetainedApplication,
  requirePostedReceiptForMovement,
} from "../accounting/receiptMovement";
import { rehydrateReceiptOccurrence } from "../accounting/receiptOccurrence";
import { findPostedReceiptOccurrence, getOrgCurrency, hookReceiptCreditApplied } from "../accounting/workflowHooks";
import { assertValidAccountingDate } from "../utils/accountingDate";
import { allocatePaymentToReceivable, getReceivableOutstandingMinor } from "../utils/subledgerAllocations";
import { AppErrorCode, throwAppError } from "../utils/errors";
import { runWithIdempotency } from "../utils/idempotency";
import { fromMinorUnits, toMinorUnits } from "../utils/money";
import { PERMISSIONS } from "../utils/permissions";
import { RETAINED_CREDIT_MESSAGES } from "../utils/retainedCreditMessages";
import { assertReceiptTargetNotSaleLinked } from "../utils/saleDebtContainment";
import { requireTenantAuth } from "../utils/tenancy";
import { assertPositiveAmount, roundMoney } from "./amounts";
import { ensureCanonicalReceivableForLegacy } from "./canonicalReceivables";
import { applyPostedPayment, assertOpeningReceivableDate } from "./receivableState";

export async function listRetainedCreditsHandler(
  ctx: QueryCtx,
  args: {
    orgId: Id<"organizations">;
    customerId?: Id<"customers">;
    onlyRemaining?: boolean;
    paginationOpts: PaginationOptions;
  },
) {
  await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);

  // Tenant scoping is the INDEX, not a post-filter: both ranges are rooted at
  // this org, so a foreign row is unreachable rather than merely excluded.
  const result = args.customerId
    ? await ctx.db
        .query("receiptRetainedPositions")
        .withIndex("by_org_customer", (q) =>
          q.eq("orgId", args.orgId).eq("customerId", args.customerId!)
        )
        .order("desc")
        .paginate(args.paginationOpts)
    : await ctx.db
        .query("receiptRetainedPositions")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .order("desc")
        .paginate(args.paginationOpts);

  const page = await Promise.all(
    result.page.map(async (position) => {
      const movement = await ctx.db.get(position.receiptMovementId);
      const customer = await ctx.db.get(position.customerId);
      const { reservedMinor: reservedForSaleInvoicesMinor, openRefundMinor, availableMinor } =
        await availableRetainedCreditMinor(ctx, args.orgId, position);
      // SCRUM-724: lineage is read from the immutable position fields; whether
      // the originating sale is cancelled is derived NOW from the sale row.
      const lineageCheque = position.sourceChequeId ? await ctx.db.get(position.sourceChequeId) : null;
      const lineageSale = position.originatingSaleId ? await ctx.db.get(position.originatingSaleId) : null;
      return {
        sourceChequeId: position.sourceChequeId,
        sourceChequeLabel: lineageCheque && lineageCheque.orgId === args.orgId
          ? `${lineageCheque.bank} #${lineageCheque.chequeNumber}` : undefined,
        originatingSaleId: position.originatingSaleId,
        originatingSaleStatus: lineageSale && lineageSale.orgId === args.orgId ? lineageSale.status : undefined,
        receiptMovementId: position.receiptMovementId,
        customerId: position.customerId,
        customerName: customer ? `${customer.firstName} ${customer.lastName}`.trim() : undefined,
        currency: position.currency,
        initialUnappliedMinor: position.initialUnappliedMinor,
        remainingUnappliedMinor: position.remainingUnappliedMinor,
        reservedForSaleInvoicesMinor,
        openRefundRequestMinor: openRefundMinor,
        availableUnappliedMinor: availableMinor,
        applicationCount: position.applicationCount,
        // Whether `applyRetainedCredit` would currently accept it. The receipt
        // must be POSTED, so a credit whose own journal is still queued behind
        // an unmapped 2110 is visible but explicitly not yet applicable —
        // rather than failing at the point of use with no explanation.
        receiptPosted:
          movement !== null &&
          (await findPostedReceiptOccurrence(
            ctx,
            rehydrateReceiptOccurrence({ orgId: args.orgId, snapshot: movement.occurrence })
          )) !== null,
        collectionPaymentId: movement?.collectionPaymentId,
        createdAt: movement?.createdAt,
      };
    })
  );

  return {
    ...result,
    page: args.onlyRemaining ? page.filter((p) => p.remainingUnappliedMinor > 0) : page,
  };
}

export async function applyRetainedCreditHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    receiptMovementId: Id<"receiptMovements">;
    receivableId: Id<"receivables">;
    requestedAmount: number;
    appliedAt?: number;
    idempotencyKey: string;
  },
) {
  const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
  // ⚠️ BEFORE runWithIdempotency, AND BEFORE THE FIRST WRITE (Codex R01).
  //
  // `v.number()` admits NaN, ±Infinity and any finite double, including dates
  // outside the `Date` domain. Such a value matches no accounting period, so
  // the command ENQUEUES and every monetary write in this mutation COMMITS —
  // then the outbox drain throws `RangeError` formatting the date, retries,
  // and dead-letters. The money would have moved with no journal, and no
  // replay could repair it. Refusing here is the only point that helps.
  if (args.appliedAt !== undefined) {
    assertValidAccountingDate(args.appliedAt, "Application date");
  }
  await assertOpeningReceivableDate(ctx, args.orgId, args.receivableId, args.appliedAt ?? Date.now());
  // SCRUM-571 R2 (D-20): retained credit may not relieve a legacy receivable
  // that carries a saleId. Before the wrapper, so a stored replay is refused.
  await assertReceiptTargetNotSaleLinked(ctx, args.orgId, { receivableId: args.receivableId });
  return await runWithIdempotency(
    ctx,
    {
      orgId: args.orgId,
      operation: "collections.applyRetainedCredit",
      economic: true,
      idempotencyKey: args.idempotencyKey,
      actorId: user._id,
      // Every input that changes what money does. Replaying one key against a
      // different receipt, receivable or amount is a contradiction, not a
      // retry, and must not quietly return the first application's result.
      //
      // `appliedAt` is included because it selects the ACCOUNTING PERIOD, so
      // the same key with a different date is a different economic claim.
      // `null` — not `Date.now()` — encodes "omitted": folding in the server
      // clock would make every retry of an omitted-date call disagree with
      // itself and refuse a legitimate replay.
      fingerprint: JSON.stringify([
        args.receiptMovementId.toString(),
        args.receivableId.toString(),
        args.requestedAmount,
        args.appliedAt ?? null,
      ]),
    },
    async () => {
      assertPositiveAmount(args.requestedAmount);
      const currency = await getOrgCurrency(ctx, args.orgId);
      const appliedAt = args.appliedAt ?? Date.now();

      const movement = await ctx.db.get(args.receiptMovementId);
      if (!movement || movement.orgId !== args.orgId) {
        throw new ConvexError("Receipt movement not found.");
      }

      // Proves BOTH that the stored snapshot is structurally canonical (by
      // re-minting it through the sanctioned rehydration door) and that the
      // receipt's own journal is POSTED. Applying a credit whose receipt never
      // reached the ledger would relieve a receivable against a liability that
      // does not exist in the books.
      await requirePostedReceiptForMovement(ctx, movement);

      const position = await loadRetainedPosition(ctx, args.orgId, movement._id);
      const credit = await availableRetainedCreditMinor(ctx, args.orgId, position);
      // SCRUM-724: credit that exists but is held (reserved for a sale invoice or
      // asked back by the customer) is refused with a coded, localized reason.
      if (credit.availableMinor <= 0 && position.remainingUnappliedMinor > 0) {
        throwAppError(
          AppErrorCode.RETAINED_CREDIT_UNAVAILABLE,
          RETAINED_CREDIT_MESSAGES.RETAINED_CREDIT_UNAVAILABLE
        );
      }

      const receivable = await ctx.db.get(args.receivableId);
      if (!receivable || receivable.orgId !== args.orgId) {
        throw new ConvexError("Receivable not found.");
      }
      if (["PAID", "CANCELLED", "REFUNDED"].includes(receivable.status)) {
        throw new ConvexError("This receivable can no longer accept payments.");
      }
      // Same customer — retained credit belongs to the person who overpaid, and
      // applying it to a different customer's debt would move money between
      // two parties' accounts with no transaction behind it.
      if (receivable.customerId !== movement.customerId) {
        throw new ConvexError("This retained credit belongs to a different customer.");
      }
      // Same currency. The position, the receipt and the org must agree; there
      // is no conversion here and silently treating minor units of one currency
      // as another would misstate the amount outright.
      if (movement.currency.toUpperCase() !== currency.toUpperCase()) {
        throw new ConvexError("This retained credit is held in a different currency.");
      }

      // Resolved BEFORE the cap is computed, deliberately.
      //
      // `allocatePaymentToReceivable` refuses — it throws, it does not clamp —
      // when the amount exceeds the CANONICAL document's outstanding balance,
      // while the operator sees the LEGACY receivable. Those two can drift.
      // Capping only on the legacy figure would turn that drift into a hard
      // failure of a legitimate application; capping on the lower of the two
      // caps instead, which is the same safe direction from either side.
      const receivableDocumentId = await ensureCanonicalReceivableForLegacy(
        ctx,
        receivable,
        user._id,
        currency
      );
      const canonicalOutstandingMinor = await getReceivableOutstandingMinor(ctx, receivableDocumentId);

      const amountMinor = computeApplicableMinor({
        requestedMinor: toMinorUnits(roundMoney(args.requestedAmount, currency), currency),
        remainingUnappliedMinor: Math.max(0, credit.availableMinor),
        outstandingMinor: Math.min(
          toMinorUnits(roundMoney(receivable.outstandingAmount, currency), currency),
          canonicalOutstandingMinor
        ),
      });
      if (amountMinor <= 0) {
        throw new ConvexError(
          "There is nothing to apply — the retained credit or the receivable's outstanding balance is already zero."
        );
      }
      const allocationId = await allocatePaymentToReceivable(ctx, {
        orgId: args.orgId,
        paymentId: movement.canonicalPaymentId,
        receivableDocumentId,
        amountMinor,
        actorId: user._id,
      });

      const { applicationId, sequence, idempotencyKey } = await recordRetainedApplication(ctx, {
        orgId: args.orgId,
        movement,
        position,
        receivableId: receivable._id,
        receivableDocumentId,
        allocationId,
        amountMinor,
        actorId: user._id,
      });

      await applyPostedPayment(
        ctx,
        receivable,
        fromMinorUnits(amountMinor, currency),
        appliedAt,
        currency
      );

      // ⚠️ NOTHING MAY CATCH THIS. As in `recordPayment`, a caught exception in
      // Convex COMMITS every write above it — the allocation, the application
      // row and the drawn-down position would survive while the journal
      // refused, leaving the credit spent with no accounting behind it.
      await hookReceiptCreditApplied(ctx, {
        orgId: args.orgId,
        sourceId: receiptApplicationSourceId(movement._id, sequence),
        idempotencyKey,
        receiptMovementId: movement._id.toString(),
        applicationId: applicationId.toString(),
        sequence,
        amountMinor,
        currency,
        customerId: movement.customerId.toString(),
        receivableDocumentId: receivableDocumentId.toString(),
        occurredAt: appliedAt,
        actorId: user._id,
      });

      return {
        applicationId,
        sequence,
        appliedMinor: amountMinor,
        remainingUnappliedMinor: position.remainingUnappliedMinor - amountMinor,
      };
    }
  );
}
