import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { planActiveInvoiceReceiptReversal, reverseActiveInvoiceReceiptApplications } from "../accounting/invoiceReceiptActivation";
import { cancelOpenRefundRequestsForMovement, cancelPendingInvoiceReceiptsForMovement } from "../accounting/invoiceReceiptReservation";
import { planReceiptRevocation, retireReceiptRevocationState } from "../accounting/receiptMovement";
import { rehydrateReceiptOccurrence } from "../accounting/receiptOccurrence";
import { getOrgCurrency, hookExpensePosted, revokeReceiptApplicationOccurrence, revokeReceiptOccurrence } from "../accounting/workflowHooks";
import { reverseAllocation } from "../utils/subledgerAllocations";
import { requireActiveBankInCurrency } from "../utils/bankAccountGuards";
import { AppErrorCode, throwAppError } from "../utils/errors";
import { FC_RETURN_MESSAGES, isFcLineage } from "../utils/fcCheque";
import { runWithIdempotency } from "../utils/idempotency";
import { fromMinorUnits } from "../utils/money";
import { getActorName, notifyManagers } from "../utils/notifications";
import { PERMISSIONS } from "../utils/permissions";
import { assertClearedChequeReturnAllowed } from "../utils/postDeliveryDoorContainment";
import { RETAINED_CREDIT_MESSAGES } from "../utils/retainedCreditMessages";
import { requireTenantAuth } from "../utils/tenancy";
import { roundMoney } from "./amounts";
import type { ReceivableStatus } from "./receivableState";

export async function returnClearedChequeHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    chequeId: Id<"postDatedCheques">;
    returnReason?: string;
    bankFeeMinor?: number;
    bankFeeBankAccountId?: Id<"bankAccounts">;
    idempotencyKey: string;
  },
) {
  const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
  // SCRUM-760 decision B: reversing a cheque after the bank cleared it is a post-delivery money
  // reversal excluded from the narrow pilot. Refused right after tenant auth, before any read or
  // write and before the idempotency wrapper (a stored replay is refused too).
  // See utils/postDeliveryDoorContainment.ts.
  assertClearedChequeReturnAllowed();
  if (
    args.bankFeeMinor !== undefined &&
    (!Number.isSafeInteger(args.bankFeeMinor) || args.bankFeeMinor < 0)
  ) {
    throwAppError(AppErrorCode.CHEQUE_BANK_FEE_INVALID, FC_RETURN_MESSAGES.CHEQUE_BANK_FEE_INVALID);
  }
  if ((args.bankFeeMinor ?? 0) > 0 && !args.bankFeeBankAccountId) {
    throwAppError(AppErrorCode.CHEQUE_RETURN_FEE_BANK_INVALID, "Select the bank account that paid the return fee.");
  }
  if ((args.bankFeeMinor ?? 0) === 0 && args.bankFeeBankAccountId) {
    throwAppError(AppErrorCode.CHEQUE_RETURN_FEE_BANK_INVALID, "A fee bank account applies only when a return fee is charged.");
  }

  return await runWithIdempotency(
    ctx,
    {
      orgId: args.orgId,
      operation: "collections.returnClearedCheque",
      economic: true,
      idempotencyKey: args.idempotencyKey,
      actorId: user._id,
      fingerprint: JSON.stringify({
        chequeId: args.chequeId,
        bankFeeMinor: args.bankFeeMinor ?? 0,
        returnReason: args.returnReason ?? null,
        ...(args.bankFeeBankAccountId ? { bankFeeBankAccountId: args.bankFeeBankAccountId } : {}),
      }),
      // Coded, so the operator reads it in their language instead of the
      // default English key-reuse text.
      onFingerprintConflict: (): never =>
        throwAppError(AppErrorCode.CHEQUE_RETURN_KEY_CONFLICT, FC_RETURN_MESSAGES.CHEQUE_RETURN_KEY_CONFLICT),
    },
    async () => {
      const cheque = await ctx.db.get(args.chequeId);
      if (!cheque || cheque.orgId !== args.orgId) {
        throwAppError(AppErrorCode.CHEQUE_NOT_FOUND, FC_RETURN_MESSAGES.CHEQUE_NOT_FOUND);
      }
      if (cheque.status !== "CLEARED") {
        throwAppError(AppErrorCode.CHEQUE_NOT_CLEARED, FC_RETURN_MESSAGES.CHEQUE_NOT_CLEARED);
      }

      const now = Date.now();

      // ⚠️ SCRUM-239 BOUNDARY — REFUSED BEFORE THE FIRST WRITE.
      //
      // `applications.confirmDisbursement` clears an application-owned cheque
      // through `markChequeClearedInTransaction` alone: no `collectionPayments` mirror,
      // no customer `receivableId`, and a FINANCE_COMPANY canonical
      // payment/allocation with `FINANCE_CASH_RECEIVED` accounting. Its own
      // comment says a bounce after that point "is not yet handled".
      //
      // Without this guard the handler ran to completion on such a cheque: the
      // mirror lookup found nothing, every reversal branch was skipped, the
      // reopen was skipped, and the cheque was stamped RETURNED while the GL
      // and the canonical subledger still showed the finance company's payment
      // SETTLED and ACTIVE-allocated — permanently, with no throw, log or
      // signal. Reproduced against this code (§F2 of the lifecycle suite).
      //
      // ⚠️ THIS IS A ROUTE, NOT THE FIX. `c17525` split that lineage to
      // SCRUM-239 precisely so it is not made to pretend it is a customer
      // receipt, and permits a refusal as an intermediate guard while that
      // source work is incomplete. Do NOT manufacture a `collectionPayments`
      // mirror or a customer receivable here to reuse the machinery below;
      // the two clearing paths originate different economic lineages.
      // SCRUM-447 D9: FC LINEAGE, not applicationId presence.
      if (isFcLineage(cheque)) {
        // SCRUM-239: the route now exists - `applications.returnFinanceDisbursementCheque`.
        // This door still refuses (it must not learn a finance lineage), but with
        // a stable code and a message that names where to go.
        throwAppError(AppErrorCode.FINANCE_CHEQUE_RETURN_FROM_DEAL, FC_RETURN_MESSAGES.FINANCE_CHEQUE_RETURN_FROM_DEAL);
      }

      // Find the collection payment created when this cheque cleared
      // SCRUM-555: index read + in-memory narrowing (convex-lint cleanup, behaviour-preserving).
      const chequePayments = await ctx.db
        .query("collectionPayments")
        .withIndex("by_cheque", (q) => q.eq("chequeId", args.chequeId))
        .collect();
      const clearedPayment = chequePayments.find((payment) => payment.status === "POSTED") ?? null;

      const reason = args.returnReason ?? "Cheque returned after clearing";
      const currency = await getOrgCurrency(ctx, args.orgId);
      const feeBankAccountId = args.bankFeeMinor && args.bankFeeMinor > 0
        ? await requireActiveBankInCurrency(ctx, {
            orgId: args.orgId,
            bankAccountId: args.bankFeeBankAccountId,
            currency,
            missingMessage: "Select the bank account that paid the return fee.",
            currencySubject: "organization",
            errorCode: AppErrorCode.CHEQUE_RETURN_FEE_BANK_INVALID,
          })
        : undefined;

      /**
       * Reopen ONE legacy debt by ONE exact amount.
       *
       * ⚠️ EVERY CALLER PASSES A PERSISTED AMOUNT. `cheque.amount` is never a
       * source here: the cheque's own debt reopens by the movement's sealed
       * `initialAppliedMinor`, and each other debt reopens by ITS OWN
       * application's `amountMinor`. The aggregate is a conservation check,
       * never the write amount for any individual receivable — reversing 800
       * against one row because two applications of 300 and 500 happened is
       * the amount-wrong-one-level-up defect Codex found in r2 (`c17522`).
       *
       * ⚠️ STATUS IS DERIVED FROM THE DEBT'S OWN DUE DATE, never hardcoded.
       *
       * The handler used to write `status: "OVERDUE"` unconditionally. That
       * was survivable while it touched only the cheque's OWN receivable;
       * extending the same helper to every later application target would
       * brand THIRD-PARTY debts — which merely received retained credit and
       * may not be due for a month — as past due. A tender bouncing says
       * nothing about another debt's calendar.
       *
       * It is not a cosmetic label. `collections.summary` counts a row whose
       * status is OVERDUE into `overdueOutstanding` regardless of `dueDate`,
       * and the reminder cron scans only OPEN / PARTIALLY_PAID / RESCHEDULED
       * — while NOTHING transitions a row back out of OVERDUE. A wrongly
       * branded debt therefore misstates the ageing and then receives neither
       * a due-soon nor an overdue reminder, permanently.
       *
       * ⚠️ DERIVED LOCALLY, NOT THROUGH THE SHARED `nextStatus`.
       *
       * `nextStatus` has no OPEN branch: its positive, not-yet-due case always
       * returns PARTIALLY_PAID, which is true for its own callers because
       * they only reach it when a payment genuinely remains. A cheque return
       * restores the ENTIRE original balance, so borrowing that helper made
       * the row assert a partial payment that never happened, while canonical
       * `reverseAllocation` independently recorded OPEN from
       * `outstanding >= originalAmountMinor` — the two projections disagreeing
       * about the same debt. Codex R3-STATUS-01, reproduced by C3 and C4.
       *
       * The correction stays LOCAL on purpose. `nextStatus` has other payment
       * and refund callers whose contract is correct as it stands; widening it
       * to teach every caller about full restoration would change behaviour
       * nobody asked to change, for one caller's benefit. Owner ruling
       * `c17783`.
       *
       * Precedence, and why: PAID first because a non-positive balance is
       * settled whatever the calendar says; then OVERDUE, because a late debt
       * is late whether or not anything was ever paid against it; then OPEN
       * when the full original amount is back; PARTIALLY_PAID only when a real
       * payment survives the return. C5 is the control that stops "always
       * OPEN" — a surviving cash payment must still read PARTIALLY_PAID.
       */
      const reopenLegacyReceivable = async (
        receivableId: Id<"receivables">,
        amountMinor: number
      ) => {
        const receivable = await ctx.db.get(receivableId);
        if (!receivable || receivable.orgId !== args.orgId) return;
        const outstandingAmount = roundMoney(
          (receivable.outstandingAmount ?? 0) + fromMinorUnits(amountMinor, currency),
          currency
        );
        const reopenedStatus: ReceivableStatus =
          outstandingAmount <= 0
            ? "PAID"
            : receivable.dueDate < now
              ? "OVERDUE"
              : outstandingAmount >= receivable.originalAmount
                ? "OPEN"
                : "PARTIALLY_PAID";
        await ctx.db.patch(receivable._id, {
          outstandingAmount,
          status: reopenedStatus,
          updatedAt: now,
        });
      };

      if (clearedPayment) {
        // ── 1. PROVE THE WHOLE UNWIND BEFORE WRITING ANY OF IT ──────────────
        //
        // A cheque cleared through `clearCheque` always seals a movement
        // (SCRUM-218-C), so an absent one means a lineage this code cannot
        // enumerate — pre-218-C data, or something that wrote a mirror row
        // without one. Refusing is the only safe answer: the alternative is the
        // guard asymmetry this ticket exists to remove, where the reversal is
        // conditional and the debt reopens anyway.
        const movement = await ctx.db
          .query("receiptMovements")
          .withIndex("by_org_payment", (q) =>
            q.eq("orgId", args.orgId).eq("collectionPaymentId", clearedPayment._id)
          )
          .unique();
        if (!movement) {
          throwAppError(
            AppErrorCode.CHEQUE_RETURN_NO_RECEIPT_LINEAGE,
            FC_RETURN_MESSAGES.CHEQUE_RETURN_NO_RECEIPT_LINEAGE
          );
        }

        // SCRUM-724 (DA-01): credit already paid back to the customer through a
        // standalone refund cannot be unwound by returning the cheque - the
        // payout would be left unrecovered. Refused before the first write;
        // refund reversal / payout recovery is out of scope and handled by an
        // accountant.
        // Status-precise: an EXECUTED row is found however many other requests
        // the movement has, so the guard cannot be outrun by the request cap.
        const executedRefund = await ctx.db
          .query("retainedCreditRefundRequests")
          .withIndex("by_org_movement_status", (q) =>
            q.eq("orgId", args.orgId).eq("receiptMovementId", movement._id).eq("status", "EXECUTED")
          )
          .first();
        if (executedRefund) {
          throwAppError(
            AppErrorCode.CHEQUE_RETURN_AFTER_CREDIT_REFUND,
            RETAINED_CREDIT_MESSAGES.CHEQUE_RETURN_AFTER_CREDIT_REFUND
          );
        }

        // SCRUM-724 Sol 6 Q3: an OPEN (PENDING/APPROVED) refund request holds
        // credit from a source that is about to be reversed. Invalidate it with
        // an audited reason BEFORE the source reversal so no approved payout can
        // outlive its money. Same transaction: any later refusal rolls it back.
        await cancelOpenRefundRequestsForMovement(ctx, {
          orgId: args.orgId,
          receiptMovementId: movement._id,
          actorId: user._id,
          reason: "Cancelled automatically: the source cheque was returned by the bank.",
        });

        // Throws the named refusals — refund interaction, missing allocation,
        // conservation violation — and writes nothing.
        const plan = await planReceiptRevocation(ctx, { orgId: args.orgId, movement });
        const invoicePlan = await planActiveInvoiceReceiptReversal(ctx, args.orgId, movement);
        if (
          plan.applications.length + invoicePlan.applications.length > 100 ||
          plan.totalApplicationMinor + invoicePlan.totalMinor > movement.initialUnappliedMinor
        ) {
          throw new ConvexError("This receipt has more applied credit than one return can safely unwind.");
        }

        // ── 2. EVERY LATER APPLICATION, NEWEST FIRST ───────────────────────
        //
        // Each application is its own accounting occurrence with its own
        // identity, its own allocation and its own debt. `c17522` R2-01: a
        // truth table that stops at the initial receipt is not exhaustive over
        // the actual return.
        for (const unwind of plan.applications) {
          await revokeReceiptApplicationOccurrence(ctx, {
            orgId: args.orgId,
            application: unwind.application,
            reason,
            actorId: user._id,
            reversalDate: now,
          });
          await reverseAllocation(ctx, {
            orgId: args.orgId,
            allocationId: unwind.allocationId,
            actorId: user._id,
          });
          await reopenLegacyReceivable(unwind.receivableId, unwind.amountMinor);
        }

        await reverseActiveInvoiceReceiptApplications(ctx, {
          orgId: args.orgId,
          applications: invoicePlan.applications,
          actorId: user._id,
          reason,
          reversalDate: now,
        });

        // ── 3. THE INITIAL RECEIPT OCCURRENCE ──────────────────────────────
        //
        // Through the sanctioned facade, which derives the forward key, the
        // reversal key and the exact row address from ONE rehydrated identity.
        // The ad-hoc `cheque_return_after_clear_<chequeId>` reversal this
        // handler used before is what `reversals.ts` records as "an open
        // boundary belonging to SCRUM-130": it addressed the event with
        // `by_org_source` + `.first()` — no `eventType`, no `eventVersion`, no
        // cardinality refusal — and reversed it under a key outside SCRUM-249's
        // reserved namespace.
        //
        // ⚠️ `revokeReceiptOccurrence`, NOT `reverseReceiptOccurrence`. The
        // cancel of the canonical forward obligation must happen whether or not
        // a posted row was found — `c17763`. Reversing a posted sibling while
        // leaving the canonical PENDING row alive is exactly how a stale drain
        // resurrects receipt GL for a returned tender.
        const identity = rehydrateReceiptOccurrence({
          orgId: args.orgId,
          snapshot: movement.occurrence,
        });
        await revokeReceiptOccurrence(ctx, {
          identity,
          reversalDate: now,
          reason,
          actorId: user._id,
        });

        // ── 4. THE RECEIPT'S OWN ALLOCATIONS AND ITS OWN DEBT ──────────────
        //
        // Driven by the sealed lineage, not by `clearedPayment.paymentAllocationId`
        // — the mirror row holds a single stale snapshot, and `c17504` R3 is
        // explicit that the persisted movement is the authority.
        for (const allocationId of plan.initialAllocationIds) {
          await reverseAllocation(ctx, {
            orgId: args.orgId,
            allocationId,
            actorId: user._id,
          });
        }
        if (cheque.receivableId && plan.initialAppliedMinor > 0) {
          await reopenLegacyReceivable(cheque.receivableId, plan.initialAppliedMinor);
        }

        // ── 5. RETIRE THE PERSISTED STATE ──────────────────────────────────
        //
        // Applications marked REVERSED and the retained position taken to zero,
        // together, so no 2110 residue survives a tender that no longer exists
        // and no future application can be drawn from it.
        await cancelPendingInvoiceReceiptsForMovement(ctx, args.orgId, movement._id);
        await retireReceiptRevocationState(ctx, { orgId: args.orgId, plan });

        if (clearedPayment.canonicalPaymentId) {
          await ctx.db.patch(clearedPayment.canonicalPaymentId, { status: "VOIDED" });
        }
        // Mark the payment as voided
        await ctx.db.patch(clearedPayment._id, { status: "VOIDED" });
      } else if (cheque.receivableId) {
        // No mirror row at all. The pre-existing code reopened the debt here
        // ANYWAY, outside the reversal guard — the ticket's Defect 1, where a
        // reopening outlives its reversal and the same money is simultaneously
        // owed on one row and collected on its canonical twin. The reversal and
        // the reopening are two halves of one movement: either both happen or
        // the mutation fails closed.
        throwAppError(
          AppErrorCode.CHEQUE_RETURN_NO_PAYMENT_TO_REVERSE,
          FC_RETURN_MESSAGES.CHEQUE_RETURN_NO_PAYMENT_TO_REVERSE
        );
      }

      // Post bank fee as expense if provided. Convert minor→major units with
      // the central currency-aware helper (the old `JOD ? 3 : 2` was wrong for
      // KWD/BHD/OMR/JPY) and route it through the posting engine so it hits the
      // GL (DR Professional Fees / CR Bank) instead of only the legacy tables.
      if (args.bankFeeMinor && args.bankFeeMinor > 0) {
        const currency = await getOrgCurrency(ctx, args.orgId);
        const feeAmount = fromMinorUnits(args.bankFeeMinor, currency);
        const feeExpenseId = await ctx.db.insert("expenses", {
          orgId: args.orgId,
          title: `Bank return fee — cheque ${cheque.bank} #${cheque.chequeNumber}`,
          amount: feeAmount,
          date: now,
          category: "FEES",
          status: "PAID",
        });
        await ctx.db.insert("transactions", {
          orgId: args.orgId,
          type: "OUT",
          amount: feeAmount,
          date: now,
          category: "EXPENSE",
          description: `Bank return fee — cheque ${cheque.bank} #${cheque.chequeNumber}`,
          expenseId: feeExpenseId,
        });
        await hookExpensePosted(ctx, {
          orgId: args.orgId,
          expenseId: feeExpenseId,
          amountMinor: args.bankFeeMinor,
          currency,
          category: "FEES",
          paymentMethod: "BANK_TRANSFER",
          bankAccountId: feeBankAccountId,
          actorId: user._id,
          occurredAt: now,
        });
      }

      // Mark cheque as RETURNED (after clearing)
      await ctx.db.patch(args.chequeId, {
        status: "RETURNED",
        returnedAt: now,
        returnReason: args.returnReason,
        returnedAfterClearing: true,
        bankFeeMinor: args.bankFeeMinor,
        updatedAt: now,
      });

      const actorName = await getActorName(ctx);
      await notifyManagers(ctx, args.orgId, "collection.cheque_returned", {
        actorName,
        amount: String(cheque.amount),
      }, { link: `/${args.orgId}/accounting` });
    }
  );
}
