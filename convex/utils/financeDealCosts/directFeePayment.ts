import type { Doc, Id } from "../../_generated/dataModel";
import { isSystemOwnerRole, PERMISSIONS } from "../permissions";
import { ConvexError, type Infer } from "convex/values";
import type { DealCostAccounting } from "./dealCostAccounting";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { SYSTEM_KEYS, type SystemKey } from "../defaultChart";
import { assertStoredVersion, isStoredVersion, nextStoredVersion } from "../custodySourceLedger";
import {
  hookHandoverCostPaidDirect,
  hookHandoverCostPaidDirectReversed,
  type ReversalOutcome,
} from "../../accounting/workflowHooks";
import {
  APPLICATION_NOT_FOUND,
  assertDealAcceptsNewCustodyCash,
  assertNotFuture,
  FEE_NOT_FOUND,
  isTimestamp,
} from "./dealCostGuards";
import { requireOwnedRow, requireTenantAuth } from "../tenancy";
import { listEligibleBanks, requireActiveBankInCurrency } from "../bankAccountGuards";
import { isMinorAmount } from "../financingEconomics";
import { assertFeeDocWithinBytes, feeAfterPatch, MAX_DIRECT_PAYMENT_REFERENCE_CHARS } from "../feeDocLimits";
import { disbursementAccountKey } from "../../accounting/postingRules";
import { runWithIdempotency } from "../idempotency";
import { directPaymentMethodValidator, directPaymentRefusal } from "../handoverCostPayment";
import { assertSupportedDenomination, fromMinorUnits } from "../money";
import { resolveDealCurrency } from "../settlementDeductions";
import { custodyFeeExpenseKey } from "../dealCustodyPosting";
import {
  MAX_DIRECT_PAID_LINES,
  MAX_DIRECT_PAYMENT_VERSIONS,
  readDirectPaymentFamily,
} from "../handoverDirectProof";

/**
 * A cost line that carries a DIRECT dealership payment (SCRUM-443) is a LEDGER
 * command the moment it is changed or removed — it reverses a posted journal —
 * so it carries the disbursement authority, not the cost-entry one. Only
 * managers and accountants move money (owner ruling R1). Judged on the role
 * already loaded, like `assertMayPostCustody`.
 */
export function assertMayMoveDirectPayment(auth: { role: Doc<"roles"> }, action: string): void {
  if (isSystemOwnerRole(auth.role)) return;
  if (auth.role.permissions.includes(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT)) return;
  throw new ConvexError(
    `${action} needs the permission to confirm finance disbursements, because the dealership's direct payment of this cost is already on the books and this reverses it. Ask a manager or an accountant.`
  );
}

/**
 * The ledger must be able to take a direct payment BEFORE the line says it was
 * paid: a payment recorded "operationally only" would let the deal finalize
 * with the cost nowhere in the books. Refuses when the org has no chart, or
 * when the treatment's expense account or the cash/bank account it is paid
 * from cannot be resolved — naming the next step. A period that is not open
 * yet is NOT a refusal: the posting queues to the outbox like every other
 * event dated into one.
 */
async function assertDirectPaymentAccountingReady(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">,
  expenseKey: SystemKey,
  cashKey: SystemKey,
  accounting: DealCostAccounting
): Promise<void> {
  if (!(await accounting.isChartInitialized(ctx, orgId))) {
    throw new ConvexError(
      "The chart of accounts has not been initialized for this organization, so the payment cannot be posted. Set up accounting (Accounting > Chart of Accounts) before recording it; nothing has been recorded."
    );
  }
  // The expense accounts self-heal exactly as they do for a custody-paid cost.
  await accounting.ensureFinancedSettlementAccounts(ctx, orgId, actorId);
  for (const key of [expenseKey, cashKey]) {
    if (!(await accounting.isSystemAccountMapped(ctx, orgId, key))) {
      throw new ConvexError(
        `The "${key}" system account is missing or inactive in the chart of accounts, so the payment cannot be posted. Restore it under Accounting > Chart of Accounts before recording the payment; nothing has been recorded.`
      );
    }
  }
}

/**
 * Refuses to CLEAR a live direct payment whose version counter is missing or
 * does not match it (SCRUM-443 v6, Sol F2). The closing proof enumerates paid
 * lines through `directPaymentVersion`; a row whose payment carries no valid
 * matching counter has a POSTED forward event the proof cannot see, and
 * clearing the row would hide that event for good. No writer produces this
 * state (a raw edit or a partial legacy import does); the repair is an
 * accountant's, not a screen's.
 */
export function assertDirectPaymentCounterIntact(
  fee: Pick<Doc<"financeDealFees">, "directPayment" | "directPaymentVersion">,
  action: string
): void {
  const paid = fee.directPayment;
  if (paid === undefined) return;
  if (!isStoredVersion(fee.directPaymentVersion) || fee.directPaymentVersion !== paid.version) {
    throw new ConvexError(
      `This cost carries a direct payment whose record is inconsistent (its payment counter is missing or does not match), so ${action} is refused: it would hide a posting from the closing checks. Nothing has been changed. Contact support or have an accountant repair the record.`
    );
  }
}

/**
 * Takes a line's live direct payment OFF the books and off the row: reverses
 * the stored version through the canonical reversal path (or cancels its
 * still-queued post) and clears `directPayment`, leaving the line UNPAID. There
 * is no automatic re-post — the operator records the payment again, at the
 * right amount, as a new version (`directPaymentVersion` is never reused).
 *
 * Called AFTER the row's own change has been written, on the row as it now
 * is. Returns what became of the reversal, or `undefined` when the line
 * carried no direct payment (so a caller may call it unconditionally).
 */
export async function reverseDirectFeePayment(
  ctx: MutationCtx,
  feeId: Id<"financeDealFees">,
  actorId: Id<"users">,
  reason: string
): Promise<ReversalOutcome | undefined> {
  const fee = await ctx.db.get(feeId);
  if (fee === null) throw new ConvexError(FEE_NOT_FOUND);
  const paid = fee.directPayment;
  if (paid === undefined) return undefined;
  assertDirectPaymentCounterIntact(fee, "reversing this direct payment");
  assertStoredVersion(paid.version, "This cost line's direct payment", "reversing this direct payment");
  const now = Date.now();
  const outcome = await hookHandoverCostPaidDirectReversed(ctx, {
    orgId: fee.orgId,
    feeId: fee._id,
    version: paid.version,
    reason,
    actorId,
    reversalDate: now,
  });
  await ctx.db.patch(fee._id, { directPayment: undefined, updatedAt: now });
  return outcome;
}

/**
 * SCRUM-54: the banks a direct payment of a cost in `currency` may name - this org's
 * active banks, id/name/currency only. Same permission as `recordDirectFeePayment`.
 */
export async function listDirectPaymentBankOptionsHandler(
  ctx: QueryCtx,
  args: {
    orgId: Id<"organizations">;
    currency: string;
  }
) {
  await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT]);
  return await listEligibleBanks(ctx, args.orgId, args.currency);
}

/**
 * Records that the DEALERSHIP itself paid a handover cost (SCRUM-443) — bank
 * transfer, e-payment, cash or an issued cheque — rather than an employee out
 * of custody cash. Posts `HANDOVER_COST_PAID_DIRECT`: DR the treatment's
 * expense / CR the outbound cash or bank account, at the line's recorded
 * actual, dated when it was paid.
 *
 * Why it exists: on an application-routed deal every dealer-borne handover
 * cost must reach the ledger exactly once, from the cash that paid it, and
 * the deal cannot finalize otherwise (`HANDOVER_COSTS_PAID`). Custody covers
 * the employee's cash; this covers the dealership's own.
 *
 * Money authority only: `CONFIRM_FINANCE_DISBURSEMENT` (managers,
 * accountants, owners). The method is REQUIRED — never defaulted — because it
 * picks the account the money left from. The AMOUNT is required too
 * (`expectedAmountMinor`): the figure the approver saw and PINNED when they
 * opened the form. The line's actual is paid only while it is still exactly
 * that; an edit in between is refused, never paid. Identity:
 * `runWithIdempotency`, fingerprinted on the whole payload including that
 * pinned figure, so a replay returns the first result and posts nothing
 * twice, and the same key for a different intent is refused. Atomic: the row
 * patch and the posting are one mutation.
 *
 * Admission envelope: a deal may carry at most `MAX_DIRECT_PAID_LINES` lines
 * that ever carried a direct payment, and a line at most
 * `MAX_DIRECT_PAYMENT_VERSIONS` payment versions — the numbers the closing
 * proof's read budget is derived from, so anything admitted here can always be
 * proven at closing.
 *
 * A line that has already been paid is refused (no second payment); an amount
 * edit or a void reverses it (see `recordActualFeeAmount`, `voidDealFee`), and
 * the operator records it again. Deal cancellation never reverses it — the cash
 * really left.
 */
export async function recordDirectFeePaymentHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    feeId: Id<"financeDealFees">;
    method: Infer<typeof directPaymentMethodValidator>;
    bankAccountId?: Id<"bankAccounts">;
    paidAt: number;
    expectedAmountMinor: number;
    reference?: string;
    idempotencyKey: string;
  },
  accounting: DealCostAccounting
) {
  const auth = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT]);
  const user = auth.user;
  const fee = await requireOwnedRow(ctx, args.orgId, "financeDealFees", args.feeId, FEE_NOT_FOUND);
  // `v.number()` admits NaN, ±Infinity and fractions: none is an amount
  // anybody saw, and none may be fingerprinted or compared below.
  if (!isMinorAmount(args.expectedAmountMinor)) {
    throw new ConvexError("The amount to pay must be a whole number of minor units. Nothing has been recorded.");
  }
  // The parent must exist in this org (R6, F3): a line whose deal is gone or
  // another tenant's is never put on the books.
  const app = await requireOwnedRow(ctx, args.orgId, "financeApplications", fee.applicationId, APPLICATION_NOT_FOUND);
  // A real, past-or-present instant: a NaN or a future date is refused before
  // it is fingerprinted or dated into a period.
  if (!isTimestamp(args.paidAt)) {
    throw new ConvexError(`The paid date must be a real timestamp (got ${args.paidAt}).`);
  }
  assertNotFuture(args.paidAt, Date.now(), "The paid date");
  const reference = args.reference?.trim() || undefined;
  if (reference !== undefined && reference.length > MAX_DIRECT_PAYMENT_REFERENCE_CHARS) {
    throw new ConvexError(
      `The payment reference is too long (${reference.length} characters; the most is ${MAX_DIRECT_PAYMENT_REFERENCE_CHARS}). Shorten it and try again. Nothing has been recorded.`
    );
  }
  const paidFromBank = disbursementAccountKey(args.method) === SYSTEM_KEYS.BANK_ACCOUNT;
  if (args.bankAccountId && !paidFromBank) {
    throw new ConvexError("A bank account applies only to a bank transfer, card or cheque payment. Nothing has been recorded.");
  }

  return await runWithIdempotency(
    ctx,
    {
      orgId: args.orgId,
      operation: "financeDealCosts.recordDirectFeePayment",
      economic: true,
      idempotencyKey: args.idempotencyKey,
      actorId: user._id,
      // The WHOLE intent: the line, how it was paid, when, the reference,
      // and the amount the approver saw — the same key for a different
      // amount is a different intent, refused, never replayed.
      fingerprint: JSON.stringify({
        feeId: args.feeId,
        method: args.method,
        // Present only when named, so a payment recorded before banks were named still replays.
        ...(args.bankAccountId ? { bankAccountId: args.bankAccountId } : {}),
        paidAt: args.paidAt,
        reference: reference ?? null,
        expectedAmountMinor: args.expectedAmountMinor,
      }),
    },
    async () => {
      // Mutable-state checks live inside the section: a replay of a payment
      // that was recorded returns it even if the deal froze or the line
      // changed since — those describe the world after the success.
      assertDealAcceptsNewCustodyCash(
        app,
        "recording a direct payment",
        "A direct payment already recorded can still be reversed.",
        "no handover left to pay for"
      );
      const refusal = directPaymentRefusal(fee);
      if (refusal !== null) throw new ConvexError(refusal);
      const amountMinor = fee.actualAmountMinor as number;
      // The line is paid in its OWN denomination, which must be the deal's:
      // a legacy line in another currency is never posted beside the rest.
      assertSupportedDenomination(fee.currency, "recording this payment");
      const dealCurrency = await resolveDealCurrency(ctx, app, "recording this payment");
      if (fee.currency !== dealCurrency) {
        throw new ConvexError(
          `This cost is recorded in ${fee.currency} while the deal's costs are kept in ${dealCurrency}, so it cannot be posted with them. Correct the line first; nothing has been recorded.`
        );
      }
      // Money authority (R1): what posts is the amount the approver SAW and
      // pinned. A cost edited at any time since the form opened is refused
      // with the new figure, so the payment is recorded again knowingly.
      if (amountMinor !== args.expectedAmountMinor) {
        throw new ConvexError(
          `The amount of this cost changed to ${fromMinorUnits(amountMinor, fee.currency)} ${fee.currency} since you opened the form (you were about to pay ${fromMinorUnits(args.expectedAmountMinor, fee.currency)} ${fee.currency}). Review the cost and record the payment again. Nothing has been recorded.`
        );
      }
      // Before the first write, so a refused bank leaves nothing behind.
      const bankAccountId = paidFromBank
        ? await requireActiveBankInCurrency(ctx, {
            orgId: args.orgId,
            bankAccountId: args.bankAccountId,
            currency: fee.currency,
            missingMessage: "Select the bank account this payment was made from. Nothing has been recorded.",
            currencySubject: "cost",
          })
        : undefined;
      const expense = custodyFeeExpenseKey(fee.accountingTreatment);
      if (expense.systemKey === null) throw new ConvexError(expense.refusal);
      const cashKey = disbursementAccountKey(args.method);
      await assertDirectPaymentAccountingReady(ctx, args.orgId, user._id, expense.systemKey, cashKey, accounting);

      // A replacement never overtakes the version it replaces: while an
      // earlier payment's reversal is still queued for a period that is not
      // open, that payment is STILL on the books and a second one beside it
      // would spend the cost twice. Judged on the LEDGER.
      const action = "recording this payment";
      const version = nextStoredVersion(fee.directPaymentVersion, "This cost line", action);
      // The admission envelope (see `MAX_DIRECT_PAYMENT_VERSIONS`): the
      // closing proof's budget is derived from these two caps, so a payment
      // that would leave the envelope is refused HERE, guided, and nothing is
      // written — never admitted and then unprovable at closing.
      if (version > MAX_DIRECT_PAYMENT_VERSIONS) {
        throw new ConvexError(
          `This cost has already been paid and corrected ${MAX_DIRECT_PAYMENT_VERSIONS} times, which is the most one cost line can carry. Remove it and add the cost again as a new line, then record the payment on that. Nothing has been recorded.`
        );
      }
      if (fee.directPaymentVersion === undefined) {
        const everPaid = await ctx.db
          .query("financeDealFees")
          .withIndex("by_application_directPaymentVersion", (q) =>
            q.eq("applicationId", fee.applicationId).gt("directPaymentVersion", 0)
          )
          .take(MAX_DIRECT_PAID_LINES);
        if (everPaid.length >= MAX_DIRECT_PAID_LINES) {
          throw new ConvexError(
            `This deal already has ${MAX_DIRECT_PAID_LINES} cost lines that have carried a direct payment (removed ones count), which is the most one deal can carry. Combine costs into fewer lines, or have the deal's accounting reviewed. Nothing has been recorded.`
          );
        }
      }
      if (version > 1) {
        // The SAME family reader the closing proof uses: canonical rows or a
        // guided refusal, never a guess.
        const family = await readDirectPaymentFamily(ctx, args.orgId, fee._id, version - 1);
        for (const [eventVersion, event] of family) {
          if (event.status === "POSTED") {
            throw new ConvexError(
              `An earlier payment of this cost (v${eventVersion}) is still on the books; its reversal is waiting for an accounting period to open (the reversal is dated the day the payment was taken back, so open the period that covers that date). Let the reversal post, then record the payment again. Nothing has been recorded.`
            );
          }
        }
      }

      const now = Date.now();
      const paidPatch = {
        directPayment: {
          version,
          amountMinor,
          method: args.method,
          paidAt: args.paidAt,
          reference,
          recordedBy: user._id,
          recordedAt: now,
        },
        directPaymentVersion: version,
        updatedAt: now,
      };
      // Judged BEFORE the posting: an oversize resulting line writes nothing.
      assertFeeDocWithinBytes(feeAfterPatch(fee, paidPatch), "recording this payment");
      await hookHandoverCostPaidDirect(ctx, {
        orgId: args.orgId,
        fee,
        vehicleId: app.vehicleId,
        version,
        amountMinor,
        paymentMethod: args.method,
        bankAccountId,
        expenseKey: expense.systemKey,
        cashKey,
        actorId: user._id,
        occurredAt: args.paidAt,
      });
      await ctx.db.patch(fee._id, paidPatch);
      return fee._id;
    }
  );
}
