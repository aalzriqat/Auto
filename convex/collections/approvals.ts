import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { getOrgCurrency, hookCollectionRefund, hookReceivableCancelled } from "../accounting/workflowHooks";
import { requireActiveBankInCurrency } from "../utils/bankAccountGuards";
import { assertDifferentActors } from "../utils/financialGuards";
import { runWithIdempotency } from "../utils/idempotency";
import { assertLegacyCollectionRefundAllowed } from "../utils/legacyCollectionRefundContainment";
import { toMinorUnits } from "../utils/money";
import { getActorName, notifyManagers, notifyUser } from "../utils/notifications";
import { PERMISSIONS } from "../utils/permissions";
import { requireOwnedRow, requireTenantAuth } from "../utils/tenancy";
import { assertPositiveAmount, roundMoney } from "./amounts";
import {
  assertAllocationsInactive,
  ensureCanonicalReceivableForLegacy,
  findCanonicalReceivableForLegacy,
  insertLedgerTransaction,
  mirrorCollectionPaymentToCanonical,
} from "./canonicalReceivables";
import { customerName } from "./collectionReads";
import { assertOpeningReceivableChangeAllowed, nextStatus, type ReceivableStatus } from "./receivableState";
import { assertRefundDoesNotReallocateToSaleLinkedDoc, reverseAllocationsForRefund } from "./refundAllocations";
import type { disbursementMethodValidator } from "./validators";
import { ConvexError, type Infer } from "convex/values";

/**
 * A refund may only be issued against a receivable whose outstanding balance
 * still reflects real collections.
 *
 * CANCELLED receivables have had outstandingAmount zeroed by the write-off, so
 * the `originalAmount - outstandingAmount` formula used for refund eligibility
 * reads them as fully paid when nothing was ever collected. REFUNDED ones have
 * already been refunded once.
 */
function assertRefundableReceivableStatus(status: ReceivableStatus): void {
  if (status === "CANCELLED") {
    throw new ConvexError(
      "This receivable was cancelled, so nothing was collected against it. A cancelled receivable cannot be refunded."
    );
  }
  if (status === "REFUNDED") {
    throw new ConvexError("This receivable has already been refunded.");
  }
}

function assertReschedulableReceivable(receivable: Doc<"receivables">): void {
  const { status, outstandingAmount } = receivable;
  if (outstandingAmount <= 0 || status === "PAID" || status === "CANCELLED" || status === "REFUNDED") {
    throw new ConvexError("Only open receivables with an outstanding balance can be rescheduled.");
  }
}

export async function requestApprovalHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    receivableId: Id<"receivables">;
    requestType: Doc<"collectionApprovalRequests">["requestType"];
    requestedAmount?: number;
    requestedDueDate?: number;
    disbursementMethod?: Infer<typeof disbursementMethodValidator>;
    bankAccountId?: Id<"bankAccounts">;
    reason: string;
  },
) {
  const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
  const receivable = await requireOwnedRow(ctx, args.orgId, "receivables", args.receivableId, "Receivable not found.");
  await assertOpeningReceivableChangeAllowed(ctx, receivable);
  // SCRUM-760 ruling 11: a collection refund is not a pilot route. Refused before any write
  // (this mutation has not written yet). See utils/legacyCollectionRefundContainment.ts.
  if (args.requestType === "REFUND") assertLegacyCollectionRefundAllowed();
  if (!args.reason.trim()) throw new ConvexError("Reason is required.");
  if (args.requestType === "REFUND") {
    assertPositiveAmount(args.requestedAmount ?? 0, "Refund amount");
    if (!args.disbursementMethod) throw new ConvexError("Disbursement method is required for refund requests.");
    // Refund eligibility is derived as originalAmount - outstandingAmount.
    // Cancelling a receivable zeroes outstandingAmount, which makes a written
    // -off, never-collected receivable indistinguishable from a fully paid
    // one — so a refund against it would disburse real cash and post a GL
    // refund for money that was never received. Blocked here and again at
    // approval time, so neither gate alone is load-bearing.
    assertRefundableReceivableStatus(receivable.status);
  }
  if (args.requestType === "RESCHEDULE") {
    assertReschedulableReceivable(receivable);
    if (!args.requestedDueDate) throw new ConvexError("New due date is required for reschedule requests.");
  }

  const existing = await ctx.db
    .query("collectionApprovalRequests")
    .withIndex("by_receivable", (q) => q.eq("receivableId", args.receivableId))
    .collect();
  if (existing.some((request) => request.status === "PENDING" && request.requestType === args.requestType)) {
    throw new ConvexError("A pending request of this type already exists.");
  }

  const currency = await getOrgCurrency(ctx, args.orgId);
  const refundNeedsBank = args.requestType === "REFUND" && args.disbursementMethod !== "CASH";
  const bankAccountId = refundNeedsBank
    ? await requireActiveBankInCurrency(ctx, {
        orgId: args.orgId,
        bankAccountId: args.bankAccountId,
        currency,
        missingMessage: "Select the bank account that will pay this refund.",
        currencySubject: "organization",
      })
    : undefined;
  if (!refundNeedsBank && args.bankAccountId) throw new ConvexError("This request cannot name a bank account.");
  const now = Date.now();
  const requestId = await ctx.db.insert("collectionApprovalRequests", {
    orgId: args.orgId,
    receivableId: args.receivableId,
    customerId: receivable.customerId,
    requestedBy: user._id,
    requestType: args.requestType,
    status: "PENDING",
    requestedAmount: args.requestedAmount ? roundMoney(args.requestedAmount, currency) : undefined,
    requestedDueDate: args.requestedDueDate,
    disbursementMethod: args.requestType === "REFUND" ? args.disbursementMethod : undefined,
    bankAccountId,
    reason: args.reason.trim(),
    createdAt: now,
    updatedAt: now,
  });

  const actorName = await getActorName(ctx);
  await notifyManagers(ctx, args.orgId, "collection.approval_requested", {
    actorName,
    amount: String(args.requestedAmount ?? receivable.outstandingAmount),
  }, { link: `/${args.orgId}/accounting` });

  return requestId;
}

export async function listApprovalsHandler(
  ctx: QueryCtx,
  args: {
    orgId: Id<"organizations">;
    status?: "PENDING" | "APPROVED" | "REJECTED";
  },
) {
  await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_REQUESTS]);
  const status = args.status ?? "PENDING";
  const requests = await ctx.db
    .query("collectionApprovalRequests")
    .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", status))
    .order("desc")
    .take(100);

  return await Promise.all(requests.map(async (request) => {
    const [receivable, customer, requester] = await Promise.all([
      ctx.db.get(request.receivableId),
      ctx.db.get(request.customerId),
      ctx.db.get(request.requestedBy),
    ]);
    return {
      ...request,
      receivableTitle: receivable?.title ?? "Receivable",
      customerName: customerName(customer),
      requestedByName: requester?.name ?? requester?.email ?? "Unknown",
    };
  }));
}

export async function respondToApprovalHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    requestId: Id<"collectionApprovalRequests">;
    status: "APPROVED" | "REJECTED";
    decisionNotes?: string;
    idempotencyKey: string;
  },
) {
  const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_REQUESTS]);
  const request = await requireOwnedRow(ctx, args.orgId, "collectionApprovalRequests", args.requestId, "Approval request not found.");
  const receivable = await requireOwnedRow(ctx, args.orgId, "receivables", request.receivableId, "Receivable not found.");
  // This immutable source policy applies even to a retained replay identity.
  // Rejecting a stale request is still allowed; generic changes are not.
  if (args.status === "APPROVED") await assertOpeningReceivableChangeAllowed(ctx, receivable);
  // SCRUM-760 ruling 11: an APPROVED REFUND would pay out, reopen the receivable and post a
  // COLLECTION_REFUND journal. Refused before the idempotency wrapper and before any write, so a
  // request created before the switch is not payable and a stored replay is refused too.
  // REJECTED is never refused: rejecting spends nothing.
  if (args.status === "APPROVED" && request.requestType === "REFUND") assertLegacyCollectionRefundAllowed();
  return await runWithIdempotency(
    ctx,
    {
      orgId: args.orgId,
      operation: "collections.respondToApproval",
      economic: true,
      idempotencyKey: args.idempotencyKey,
      actorId: user._id,
      // The decision IS the economic instruction here: the same identity may
      // not be reused to flip an APPROVE into a REJECT (or onto a different
      // request) and be handed the first decision's stored result.
      fingerprint: JSON.stringify({
        requestId: args.requestId,
        status: args.status,
      }),
    },
    async () => {
      if (request.status !== "PENDING") throw new ConvexError("This request has already been resolved.");
      assertDifferentActors(
        user._id,
        request.requestedBy,
        "Requester cannot approve or reject their own collection approval request."
      );

      if (args.status === "APPROVED" && request.requestType === "RESCHEDULE") {
        assertReschedulableReceivable(receivable);
      }

      const currency = await getOrgCurrency(ctx, args.orgId);
      const now = Date.now();
      // Recheck a pending refund's physical bank before changing the approval.
      // A bank can become inactive after the requester selects it.
      const refundBankAccountId = args.status === "APPROVED" && request.requestType === "REFUND" && request.disbursementMethod && request.disbursementMethod !== "CASH"
        ? await requireActiveBankInCurrency(ctx, {
            orgId: args.orgId,
            bankAccountId: request.bankAccountId,
            currency,
            missingMessage: "This refund request has no bank account. Reject it and submit a new request.",
            currencySubject: "organization",
          })
        : undefined;
      await ctx.db.patch(args.requestId, {
        status: args.status,
        decisionNotes: args.decisionNotes,
        decidedBy: user._id,
        decidedAt: now,
        responseIdempotencyKey: args.idempotencyKey,
        updatedAt: now,
      });

      if (args.status === "APPROVED") {
        if (request.requestType === "RESCHEDULE") {
          if (!request.requestedDueDate) throw new ConvexError("Requested due date is missing.");
          await ctx.db.patch(receivable._id, {
            dueDate: request.requestedDueDate,
            status: request.requestedDueDate < now ? "OVERDUE" : "RESCHEDULED",
            updatedAt: now,
          });
          // Keep the canonical receivable document in step with the legacy
          // row — aging and dunning read the canonical dueDate.
          const rescheduledDocId = await ensureCanonicalReceivableForLegacy(
            ctx,
            receivable,
            user._id,
            currency
          );
          await ctx.db.patch(rescheduledDocId, { dueDate: request.requestedDueDate });
        } else if (request.requestType === "CANCEL_RECEIVABLE") {
          // Block if any payments have already been collected: cancelling a
          // financially-recognised receivable without a reversal GL event
          // leaves the subledger in an inconsistent state. Use the Refund
          // path to return collected funds first, then cancel.
          const paidAmount = roundMoney(receivable.originalAmount - receivable.outstandingAmount, currency);
          if (paidAmount > 0) {
            throw new ConvexError(
              "Cannot cancel a receivable that has already received payments. " +
              "Issue a refund for the collected amount first, then cancel."
            );
          }
          // Block if a post-dated cheque in HELD or DEPOSITED state is
          // linked to this receivable. Cancelling the receivable would leave
          // an active financial instrument with nowhere to post when cleared.
          // SCRUM-555: index read + in-memory narrowing (convex-lint cleanup, behaviour-preserving).
          const hasActiveCheque = (
            await ctx.db
              .query("postDatedCheques")
              .withIndex("by_receivable", (q) => q.eq("receivableId", receivable._id))
              .collect()
          ).some(
            (cheque) =>
              cheque.orgId === args.orgId && (cheque.status === "HELD" || cheque.status === "DEPOSITED")
          );
          if (hasActiveCheque) {
            throw new ConvexError(
              "Cannot cancel a receivable with an active cheque (HELD or DEPOSITED). " +
              "Return or cancel the cheque first, then cancel the receivable."
            );
          }
          // SCRUM-121A-PRE §5.1 — the canonical gate, evaluated before this
          // branch writes anything.
          //
          // The `paidAmount` check above is KEPT, not replaced: it asks a
          // different question, about the legacy row's own balance. It cannot
          // see a canonical allocation, because a document-only payment intent
          // never runs the legacy mirror — that mirror requires a
          // `receivableId` — so an intent settled against the canonical
          // document leaves `paidAmount` at zero while the subledger holds a
          // live allocation. That is a reachable CANCELLED + ACTIVE through
          // public mutations only, which is why the gate is here and not a
          // stronger version of the legacy check.
          const existingCanonical = await findCanonicalReceivableForLegacy(ctx, receivable);
          if (existingCanonical) {
            await assertAllocationsInactive(ctx, existingCanonical._id);
          }

          await ctx.db.patch(receivable._id, {
            outstandingAmount: 0,
            status: "CANCELLED",
            updatedAt: now,
          });
          const cancelledDocId = await ensureCanonicalReceivableForLegacy(
            ctx,
            receivable,
            user._id,
            currency
          );
          // SCRUM-121A-PRE §5.2 — cancel WITH the metadata, atomically.
          //
          // Patching `status` alone left `cancelledAt` undefined, and
          // `getReceivablesAsOf` excludes a cancelled document only when
          // `cancelledAt <= asOfDate`. A document with no `cancelledAt` is
          // therefore included at EVERY asOfDate, permanently — so this
          // transition reversed the GL while `arAging` went on counting the
          // debt at full value forever. `saleCancellation.ts` already writes
          // all four fields; this makes the second writer agree with it.
          //
          // The reason is never stored empty: the approver's notes when they
          // wrote any, otherwise the requester's mandatory reason.
          const cancellationReason = args.decisionNotes?.trim() || request.reason;
          await ctx.db.patch(cancelledDocId, {
            status: "CANCELLED",
            cancelledAt: now,
            cancelledBy: user._id,
            cancellationReason,
          });
          // Reverse the RECEIVABLE_CREATED entry (or cancel its pending post)
          // so AR and the credit account it hit (income/deposit liability/
          // expense reimbursement) don't stay overstated once the receivable
          // is gone operationally. No-op for sale-linked receivables, which
          // never post a RECEIVABLE_CREATED event in the first place.
          await hookReceivableCancelled(ctx, {
            orgId: args.orgId,
            receivableId: receivable._id,
            reason: args.decisionNotes ?? "Receivable cancelled",
            actorId: user._id,
            reversalDate: now,
          });
        } else if (request.requestType === "REFUND") {
          const refundAmount = roundMoney(request.requestedAmount ?? 0, currency);
          assertPositiveAmount(refundAmount, "Refund amount");
          // Re-checked at approval time, not just at request time: the
          // receivable can be cancelled while a refund request sits PENDING,
          // and paidAmount below would then read the full original amount as
          // "collected". See assertRefundableReceivableStatus.
          assertRefundableReceivableStatus(receivable.status);
          const paidAmount = roundMoney(receivable.originalAmount - receivable.outstandingAmount, currency);
          if (refundAmount > paidAmount) throw new ConvexError("Refund amount cannot exceed collected amount.");
          // SCRUM-571 S1 (D-20) R5: before the first write of this branch.
          await assertRefundDoesNotReallocateToSaleLinkedDoc(
            ctx,
            receivable,
            toMinorUnits(refundAmount, currency)
          );

          // Use the method captured at request time so the GL entry posts to
          // the correct cash account (bank vs. cash on hand vs. cheque).
          if (!request.disbursementMethod) {
            throw new ConvexError(
              "This legacy refund request has no disbursement method. Reject it and submit a new request."
            );
          }
          const refundDisbursementMethod = request.disbursementMethod;
          if (refundDisbursementMethod === "CASH" && request.bankAccountId) {
            throw new ConvexError("A cash refund request cannot name a bank account.");
          }

          const refundPaymentId = await ctx.db.insert("collectionPayments", {
            orgId: args.orgId,
            bankAccountId: refundBankAccountId,
            branchId: membership.branchId,
            receivableId: receivable._id,
            customerId: receivable.customerId,
            vehicleId: receivable.vehicleId,
            saleId: receivable.saleId,
            direction: "OUT",
            method: refundDisbursementMethod,
            amount: refundAmount,
            paymentDate: now,
            paymentDateKind: "instant",
            status: "POSTED",
            idempotencyKey: args.idempotencyKey,
            reference: `Refund approval ${args.requestId}`,
            cashierId: user._id,
            notes: args.decisionNotes,
            createdAt: now,
          });

          const refundPayment = await ctx.db.get(refundPaymentId);
          const canonicalReceivableDocumentId = await ensureCanonicalReceivableForLegacy(
            ctx,
            receivable,
            user._id,
            currency
          );
          if (refundPayment) {
            await mirrorCollectionPaymentToCanonical(ctx, {
              paymentId: refundPaymentId,
              payment: refundPayment,
              receivable,
              actorId: user._id,
              currency,
            });
          }

          // Unwind the original collections so the canonical receivable
          // reopens by exactly the refunded amount — without this the
          // canonical doc stays PAID while the legacy row shows a balance.
          const refundAmountMinor = toMinorUnits(refundAmount, currency);
          await reverseAllocationsForRefund(ctx, {
            orgId: args.orgId,
            receivableDocumentId: canonicalReceivableDocumentId,
            amountMinor: refundAmountMinor,
            actorId: user._id,
          });

          const newOutstanding = roundMoney(receivable.outstandingAmount + refundAmount, currency);
          await ctx.db.patch(receivable._id, {
            outstandingAmount: newOutstanding,
            status: refundAmount >= paidAmount ? "REFUNDED" : nextStatus(newOutstanding, receivable.dueDate),
            updatedAt: now,
          });

          await insertLedgerTransaction(ctx, {
            orgId: args.orgId,
            direction: "OUT",
            amount: refundAmount,
            date: now,
            description: `Refund for ${receivable.title}`,
            vehicleId: receivable.vehicleId,
            userId: user._id,
            category: "REFUND",
            idempotencyKey: args.idempotencyKey,
          });

          await hookCollectionRefund(ctx, {
            orgId: args.orgId,
            paymentId: refundPaymentId,
            customerId: receivable.customerId,
            amountMinor: refundAmountMinor,
            currency,
            paymentMethod: refundDisbursementMethod,
            bankAccountId: refundBankAccountId,
            actorId: user._id,
            occurredAt: now,
          });
        }
      }

      await notifyUser(ctx, args.orgId, request.requestedBy, "collection.approval_responded", {
        status: args.status,
        amount: String(request.requestedAmount ?? receivable.outstandingAmount),
      }, { link: `/${args.orgId}/accounting` });

      return args.requestId;
    }
  );
}
