import { ConvexError, v } from "convex/values";
import { mutation } from "./functions";
import { query } from "./_generated/server";
import { postAccountingEvent } from "./accounting/postingEngine";
import { authorizeOpeningDepositRefund, OPENING_DEPOSIT_REFUND_SOURCE, OPENING_DEPOSIT_RETURN_JOURNAL_KEY, openingRefundTransferPaymentKey } from "./utils/openingDepositRefundPosting";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { assertDifferentActors } from "./utils/financialGuards";
import { runWithIdempotency } from "./utils/idempotency";
import { orgResetState } from "./utils/orgResetGeneration";
import { isRepresentableTimestamp, utcDay } from "./utils/ledgerCalendar";
import { checkPostingAllowed, getOpenPeriodForDate } from "./utils/postingPeriod";
import { fromMinorUnits, supportedCurrencyScale } from "./utils/money";
import { hasArchivedRefundAuthority } from "./utils/openingRefundAuthority";
import { assertOpeningRefundBankAllowed } from "./utils/openingDepositContainment";

function hasBankReference(description: string, reference: string) {
  const escapedReference = reference.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Z0-9_/\\-])${escapedReference}(?=$|[^A-Z0-9_/\\-])`).test(description.toUpperCase());
}

export const archivedRefundRecovery = query({
  args: { orgId: v.id("organizations"), statementLineId: v.id("bankStatementLines") },
  returns: v.union(v.null(), v.object({
    depositId: v.id("deposits"), currency: v.string(), amountMinor: v.number(), reserved: v.boolean(),
  })),
  handler: async (ctx, { orgId, statementLineId }) => {
    const { user, role, membership } = await requireTenantAuth(ctx, orgId, [PERMISSIONS.MANAGE_FINANCE, PERMISSIONS.APPROVE_REQUESTS]);
    if (membership.impersonationGrantId || !hasArchivedRefundAuthority(role, orgId) ||
        orgResetState(await ctx.db.get(orgId)).inProgress) return null;
    const statement = await requireOwnedRow(ctx, orgId, "bankStatementLines", statementLineId);
    if (statement.status !== "MATCHED" || !statement.openingDepositRefundReturnEventId || !statement.matchedJournalLineId) return null;
    const returned = await requireOwnedRow(ctx, orgId, "accountingEvents", statement.openingDepositRefundReturnEventId);
    if (returned.status !== "POSTED" || returned.eventType !== "DEPOSIT_REFUND_RETURNED" ||
        returned.sourceType !== OPENING_DEPOSIT_REFUND_SOURCE || !returned.journalEntryId) return null;
    const depositId = ctx.db.normalizeId("deposits", returned.sourceId);
    if (!depositId) return null;
    const deposit = await requireOwnedRow(ctx, orgId, "deposits", depositId);
    if (deposit.origin !== "OPENING" || deposit.status !== "HELD" || deposit.isDeleted ||
        !deposit.releaseCount || deposit.releaseCount !== returned.eventVersion || deposit.createdBy === user._id) return null;
    const customer = await requireOwnedRow(ctx, orgId, "customers", deposit.customerId);
    if (!customer.isDeleted) return null;
    const bankLine = await requireOwnedRow(ctx, orgId, "journalLines", statement.matchedJournalLineId);
    if (bankLine.journalEntryId !== returned.journalEntryId || bankLine.bankAccountId !== statement.bankAccountId ||
        bankLine.debitMinor !== deposit.amountMinor || statement.amountMinor !== deposit.amountMinor) return null;
    const { currency, amountMinor } = deposit;
    if (!currency || supportedCurrencyScale(currency) === null || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) return null;
    return { depositId, currency, amountMinor, reserved: !!deposit.openingRefundReservation };
  },
});

export const recordBankReturn = mutation({
  args: {
    orgId: v.id("organizations"),
    statementLineId: v.id("bankStatementLines"),
    originalRefundReference: v.string(),
    bankReturnReference: v.string(),
    confirmedIndependentBankEvidence: v.literal(true),
    bankEvidenceReference: v.string(),
    idempotencyKey: v.string(),
  },
  returns: v.object({ journalEntryId: v.id("journalEntries") }),
  handler: async (ctx, args) => {
    const { orgId, statementLineId } = args;
    const { user, membership } = await requireTenantAuth(ctx, orgId, [PERMISSIONS.MANAGE_FINANCE, PERMISSIONS.APPROVE_REQUESTS]);
    assertOpeningRefundBankAllowed();
    if (membership.impersonationGrantId || orgResetState(await ctx.db.get(orgId)).inProgress) {
      throw new ConvexError("Opening refund returns are unavailable for this session.");
    }
    const statement = await requireOwnedRow(ctx, orgId, "bankStatementLines", statementLineId);
    const originalReference = args.originalRefundReference.trim().toUpperCase();
    if (!originalReference || originalReference.length > 120 || !hasBankReference(statement.description, originalReference)) {
      throw new ConvexError("Enter the original refund reference as shown on the bank statement.");
    }
    const paymentKey = openingRefundTransferPaymentKey(statement.bankAccountId, originalReference);
    const payment = await ctx.db.query("canonicalPayments").withIndex("by_org_idempotency",
      q => q.eq("orgId", orgId).eq("idempotencyKey", paymentKey)).unique();
    if (!payment?.accountingEventId || payment.externalReference?.toUpperCase() !== originalReference) {
      throw new ConvexError("The original opening deposit refund could not be verified.");
    }
    const original = await requireOwnedRow(ctx, orgId, "accountingEvents", payment.accountingEventId);
    const depositId = ctx.db.normalizeId("deposits", original.sourceId);
    if (!depositId) throw new ConvexError("The original opening deposit refund could not be verified.");
    const deposit = await requireOwnedRow(ctx, orgId, "deposits", depositId);
    const refundPaymentId = payment._id;
    const reference = args.bankReturnReference.trim().toUpperCase();
    const bankEvidenceReference = args.bankEvidenceReference.trim();
    if (bankEvidenceReference.length < 3 || bankEvidenceReference.length > 120 ||
        [reference, originalReference].includes(bankEvidenceReference.toUpperCase())) {
      throw new ConvexError("Provide a reference to the independently checked bank evidence.");
    }
    if (!/^[A-Z0-9_\/-]{3,100}$/.test(reference) || !/[A-Z0-9]/.test(reference)) {
      throw new ConvexError("Enter the bank's return reference exactly as shown on the statement.");
    }
    return runWithIdempotency(ctx, {
      orgId, actorId: user._id, operation: "openingRefundReturns.recordBankReturn", economic: true,
      idempotencyKey: args.idempotencyKey, fingerprint: JSON.stringify([depositId, refundPaymentId, statementLineId, reference, bankEvidenceReference]),
    }, async () => {
      const now = Date.now();
      if (deposit.origin !== "OPENING" || deposit.status !== "REFUNDED" || deposit.isDeleted ||
          deposit.openingRefundReservation || !deposit.releaseCount || !payment.accountingEventId ||
          payment.status !== "SETTLED" || payment.direction !== "OUT" || payment.method !== "BANK_TRANSFER" ||
          payment.customerId !== deposit.customerId || payment.currency !== deposit.currency ||
          payment.amountMinor !== deposit.amountMinor || payment.amountMinor !== deposit.refundedAmountMinor ||
          payment.amountMinor !== deposit.releasedAmountMinor) {
        throw new ConvexError("The original opening deposit refund could not be verified.");
      }
      const bank = await requireOwnedRow(ctx, orgId, "bankAccounts", statement.bankAccountId);
      const customer = await requireOwnedRow(ctx, orgId, "customers", deposit.customerId);
      const refundPayload = original.payload as { bankAccountId?: string; payoutReference?: string } | undefined;
      if (original.status !== "POSTED" || original.sourceType !== OPENING_DEPOSIT_REFUND_SOURCE ||
          original.eventType !== "DEPOSIT_REFUNDED" || original.sourceId !== depositId ||
          original.eventVersion !== deposit.releaseCount || !original.journalEntryId ||
          refundPayload?.bankAccountId !== bank._id || bank.currency !== payment.currency ||
          refundPayload.payoutReference !== payment.externalReference || !payment.externalReference ||
          statement.status !== "UNMATCHED" || statement.openingDepositRefundReturnEventId ||
          statement.amountMinor !== payment.amountMinor || !isRepresentableTimestamp(statement.statementDate) ||
          utcDay(statement.statementDate) < utcDay(original.accountingDate) || statement.statementDate > now ||
          reference === payment.externalReference.toUpperCase() ||
          !hasBankReference(statement.description, reference) ||
          !hasBankReference(statement.description, payment.externalReference)) {
        throw new ConvexError("The bank statement credit could not be verified against the original refund.");
      }
      assertDifferentActors(user._id, statement.createdBy, "A different approver must verify the imported bank credit.");
      const statementPostingDate = Math.max(statement.statementDate, original.accountingDate);
      const statementPeriod = await checkPostingAllowed(ctx, orgId, statementPostingDate);
      let accountingDate = statementPostingDate;
      if (!statementPeriod.ok) {
        if (statementPeriod.waiting) throw new ConvexError(statementPeriod.reason);
        // Preserve the closed period and its snapshots. The original date stays on the matched statement.
        accountingDate = now;
        if (!(await getOpenPeriodForDate(ctx, orgId, accountingDate))) {
          throw new ConvexError("Open today's accounting period before recording this bank return.");
        }
      }
      const returnKey = `${OPENING_DEPOSIT_RETURN_JOURNAL_KEY}${bank._id}_${reference}`;
      const { eventId, journalEntryId, alreadyPosted } = await postAccountingEvent(ctx, authorizeOpeningDepositRefund({
        orgId, actorId: user._id, eventType: "DEPOSIT_REFUND_RETURNED", sourceType: OPENING_DEPOSIT_REFUND_SOURCE,
        sourceId: depositId, eventVersion: deposit.releaseCount, idempotencyKey: returnKey,
        accountingDate, occurredAt: now, currency: payment.currency,
        payload: {
          depositId, customerId: deposit.customerId, amountMinor: payment.amountMinor, bankAccountId: bank._id,
          currency: payment.currency, refundPaymentId, originalRefundEventId: original._id, statementLineId,
          bankReturnReference: reference, bankEvidenceReference, bankStatementDate: statement.statementDate, verifiedBy: user._id,
          statementImportedBy: statement.createdBy, customerWasArchived: customer.isDeleted === true,
        },
      }));
      if (!eventId || !journalEntryId || alreadyPosted) throw new ConvexError("This returned transfer is already recorded or could not be posted.");
      const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", q => q.eq("journalEntryId", journalEntryId)).take(3);
      const bankLine = lines.find(line => line.bankAccountId === bank._id && line.debitMinor === payment.amountMinor);
      if (!bankLine || lines.length !== 2) throw new ConvexError("The bank credit could not be reconciled.");
      await ctx.db.patch(statementLineId, {
        status: "MATCHED", matchedJournalLineId: bankLine._id, matchedBy: user._id, matchedAt: now,
        openingDepositRefundReturnEventId: eventId,
      });
      await ctx.db.insert("transactions", {
        orgId, depositId, vehicleId: deposit.vehicleId, type: "IN", amount: fromMinorUnits(payment.amountMinor, payment.currency),
        date: accountingDate, category: "DEPOSIT", description: "Returned opening deposit bank refund", idempotencyKey: returnKey,
      });
      await ctx.db.patch(depositId, {
        status: "HELD", releasedAmountMinor: 0, refundedAmountMinor: 0, resolvedAt: now,
      });
      return { journalEntryId };
    });
  },
});
