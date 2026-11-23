import { resolveFinancierLeg } from "../../utils/dealSettlementFigures";
import { ConvexError } from "convex/values";
import { type MutationCtx, type QueryCtx } from "../../_generated/server";
import { type Doc, type Id } from "../../_generated/dataModel";
import { requireOwnedRow } from "../../utils/tenancy";
import { assertNoActiveDealUnwind } from "../../utils/dealUnwindGuard";
import { notifyManagers, getActorName } from "../../utils/notifications";
import {
  isForwardPlanVersion,
  planVersionOf,
} from "../../utils/financedSalePostingPlan";
import { assertForwardSettledForTransfer } from "../../utils/financeCompanyForward";
import { dealModeOf } from "../../utils/financedSaleRecognition";
import { hookFinanceCashReceived } from "../../accounting/workflowHooks";
import { createCanonicalPayment } from "../../utils/canonicalPaymentWriter";
import {
  disbursementVersionOf,
  financeDisbursementKeys,
} from "../../utils/financeDisbursementKeys";
import { requireActiveBankInCurrency } from "../../utils/bankAccountGuards";
import {
  chequesForApplication,
  isLiveFcCheque,
  hasClearedLinkedCheque,
} from "../../utils/fcCheque";
import { manualPayerOf } from "../../utils/manualFinancePayer";
import { proveFinanceReceiptAuthority } from "./financeReceivables";
import { closedDealSettlesDirectToSupplier } from "./settlementRouting";
import { refuseFinanceReturn } from "./financeReturn";
import { loadDealRoute } from "./cockpitSettlement";

export async function readDisbursementVersion(
  ctx: QueryCtx,
  args: ConfirmDisbursementInput,
) {
  // SCRUM-239: a confirmation belongs to ONE disbursement version. A completed
  // key is replayed BEFORE the body reads the application, so without the
  // version in the fingerprint a key kept from version n (lost response) would
  // replay n's result after a return opened version n+1 - a success toast and
  // no payment, allocation or FINANCE_CASH_RECEIVED for the new disbursement.
  // Version 1 keeps the historical fingerprint byte for byte so existing rows
  // still replay. A missing or foreign row leaves the legacy shape; the body
  // refuses it exactly as before.
  const knownApp = await ctx.db.get(args.applicationId);
  const ownedApp = knownApp && knownApp.orgId === args.orgId ? knownApp : null;
  const version = ownedApp ? disbursementVersionOf(ownedApp) : 1;

  // SCRUM-239 round 3: a request is bound to the version the CONFIRMER SAW. A
  // fresh key from a screen that observed version n must not confirm version
  // n+1's replacement cheque it never saw, so the comparison cannot rest on the
  // idempotency fingerprint (a fresh key has no row). Only an application of
  // this organisation is compared: a missing or foreign row falls through and
  // the body refuses it as before, leaking nothing across tenants. A legacy
  // client (no expected version) may confirm only a first disbursement.
  if (ownedApp) {
    const observed = args.expectedDisbursementVersion;
    if (
      (observed !== undefined && observed !== version) ||
      (observed === undefined && version > 1)
    ) {
      refuseFinanceReturn("FINANCE_CONFIRM_STALE_REQUEST");
    }
  }
  return version;
}

type ConfirmDisbursementInput = {
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  disbursedAmountMinor: number;
  idempotencyKey: string;
  expectedDisbursementVersion?: number;
  bankAccountId?: Id<"bankAccounts">;
};

/**
 * Records actual receipt of disbursement funds from the finance company.
 * Only valid after finalizeDeal has been called and only once per application.
 */
// SCRUM-239 round 3: the disbursement version the confirmer OBSERVED. The
// server refuses a mismatch before the idempotency probe and any write.
// SCRUM-54: the physical bank a BANK_TRANSFER / CHEQUE receipt reached.
// Required for those methods, refused for CASH; never defaulted.
// The expected-amount comparison further down is skipped whenever the quote
// carries no totalFinancedAmount — a schema-legal state — so it cannot be
// relied on to reject NaN. Validate the input unconditionally.
// Only when named, so a historical (bank-less) fingerprint is unchanged.
// Only a later version can be stale; a version-1 conflict is a plain
// key reuse with different content and keeps the default refusal.
export async function executeConfirmDisbursement(
  ctx: MutationCtx,
  args: ConfirmDisbursementInput,
  user: Doc<"users">,
  version: number,
  markChequeClearedCore: (
    ctx: MutationCtx,
    args: {
      orgId: Id<"organizations">;
      chequeId: Id<"postDatedCheques">;
      clearedAt?: number;
      idempotencyKey?: string;
    },
  ) => Promise<Doc<"postDatedCheques">>,
  allocatePaymentToReceivable: (
    ctx: MutationCtx,
    args: {
      orgId: Id<"organizations">;
      paymentId: Id<"canonicalPayments">;
      receivableDocumentId: Id<"receivableDocuments">;
      amountMinor: number;
      actorId: Id<"users">;
    },
  ) => Promise<Id<"paymentAllocations">>,
) {
  const app = await requireOwnedRow(
    ctx,
    args.orgId,
    "financeApplications",
    args.applicationId,
    "Application not found.",
  );
  // SCRUM-693: no new disbursement while the deal is being unwound.
  await assertNoActiveDealUnwind(ctx, args.orgId, args.applicationId);
  if (app.status !== "CLOSED")
    throw new ConvexError(
      "Disbursement can only be confirmed on a closed application.",
    );
  if (app.disbursedAt) refuseFinanceReturn("FINANCE_CONFIRM_ALREADY_CONFIRMED");
  if (!app.companyId && manualPayerOf(app) === null) {
    // Same resolver as the cockpit, so the screen and this guard cannot
    // disagree about whether a finance company pays on this deal.
    const { sale, route } = await loadDealRoute(ctx, app);
    const leg = resolveFinancierLeg(
      app,
      route,
      sale,
      await dealModeOf(ctx, app),
    );
    // SCRUM-567: coded, so the screen shows the Arabic text and not the English one.
    refuseFinanceReturn(
      leg === "NONE"
        ? "FINANCE_CONFIRM_NO_FINANCIER_PAYS"
        : "FINANCE_CONFIRM_NO_FINANCE_COMPANY",
    );
  }
  if (args.disbursedAmountMinor <= 0)
    throw new ConvexError("Disbursement amount must be positive.");

  // This mutation books DR bank (cash on hand for a CASH receipt, SCRUM-599) / CR AR-Finance Companies: money that
  // arrived in the dealership's own account, settling a receivable it
  // holds. On the direct route neither exists — the cheque went to the
  // supplier and no finance-company receivable was ever opened. Running it
  // anyway would create bank cash out of nothing and drive AR-Finance
  // Companies negative.
  //
  // Refused rather than quietly redirected to the supplier confirmation.
  // The two record different facts about different money, and an operator
  // who reaches for the wrong one is telling us their understanding of the
  // deal disagrees with what was recorded — which is worth stopping on.
  if (await closedDealSettlesDirectToSupplier(ctx, app)) {
    throw new ConvexError(
      "This deal settles directly with the supplier, so the finance company's payment never reaches the dealership's account and there is nothing here to receive. Record the company's payment to the supplier instead, and collect the dealership's margin from the supplier when he pays it.",
    );
  }

  // SCRUM-447 B1: confirming consumes a REGISTERED tender, never an assumed
  // one. correctExpectedPayment clears the method and date; without this
  // guard the bank-transfer default below would settle the deal with no
  // tender on record. All refusals sit before the first write.
  if (!app.expectedPaymentMethod || !app.expectedPaymentDate) {
    throw new ConvexError(
      "Register the expected payment (method and date) before confirming disbursement.",
    );
  }
  if (app.expectedPaymentMethod !== "CHEQUE") {
    const stillLive = (
      await chequesForApplication(ctx, args.applicationId)
    ).some(isLiveFcCheque);
    if (stillLive) {
      throw new ConvexError(
        "This deal still has a live finance-company cheque. Correct the expected payment first.",
      );
    }
  }
  // SCRUM-435 (v2): the finance company transfers the FULL approved amount,
  // and the dealership owes it the deposit and its contribution onward.
  // The transfer is confirmed only once that forward is proven on the
  // books (or nothing is due) - by the ONE proof, never a second check.
  // The refusal names who acts next and never carries the forward amounts.
  if (isForwardPlanVersion(planVersionOf(app))) {
    await assertForwardSettledForTransfer(ctx, app);
  } else if (!app.companyId) {
    // SCRUM-27: a manual company only ever exists on the current plan. One
    // that does not carry it has no proven forward and must not receive.
    throw new ConvexError(
      "This deal was not finalized on the current sale plan, so the finance company's transfer cannot be confirmed here. A manager reviews the deal.",
    );
  }

  const quote = await ctx.db.get(app.quoteId);
  // Everything below settles exactly this figure in exactly this
  // currency, both proven from the deal's own records before the first
  // write. The caller's amount is checked against them; it never becomes
  // the amount, and the organisation's current currency is not consulted.
  const { receivable, receiptMinor, currency } =
    await proveFinanceReceiptAuthority(ctx, {
      app,
      quote,
      callerAmountMinor: args.disbursedAmountMinor,
    });

  // The method of record — registered before finalization
  // (registerExpectedPayment) instead of assuming bank transfer. ONE
  // value feeds the bank rule below, the posting (SCRUM-599: CASH debits
  // 1100, not 1110) and the canonical payment, so they cannot disagree.
  const disbursementMethod =
    app.expectedPaymentMethod === "CASH" ||
    app.expectedPaymentMethod === "CHEQUE"
      ? app.expectedPaymentMethod
      : "BANK_TRANSFER";

  // SCRUM-54: money that reached a bank names WHICH bank, explicitly -
  // never defaulted to the only one. CASH is cash on hand and names none.
  // Refused here, before the first write.
  let receiptBankAccountId: Id<"bankAccounts"> | undefined;
  if (disbursementMethod === "CASH") {
    if (args.bankAccountId) {
      throw new ConvexError(
        "A cash receipt is cash on hand and cannot name a bank account.",
      );
    }
  } else {
    receiptBankAccountId = await requireActiveBankInCurrency(ctx, {
      orgId: args.orgId,
      bankAccountId: args.bankAccountId,
      currency,
      missingMessage:
        "Select the bank account the finance company's payment was received into.",
      currencySubject: "disbursement",
    });
  }

  // registerExpectedPayment always opens a HELD postDatedCheques row when
  // the registered method is CHEQUE — link this confirmation to it so the
  // cheque doesn't stay HELD forever while the payment says settled.
  // (Not yet handled: a cheque that bounces AFTER this clears it — see
  // the note below, after the cheque is transitioned.)
  let chequeToClear: Doc<"postDatedCheques"> | null = null;
  if (app.expectedPaymentMethod === "CHEQUE") {
    // SCRUM-447 D0/D1: the LIVE finance-company cheque, never `.unique()`
    // (lineage is permanent, so retired rows stay linked and would make
    // a unique read throw). Exactly one live row must exist.
    const allRows = await chequesForApplication(ctx, args.applicationId);
    // N1-B: a CLEARED linked row is an accounting review whatever sits
    // beside it (live HELD, RETURNED), so it is named FIRST, before any
    // write and before the correct-the-payment refusal.
    if (hasClearedLinkedCheque(allRows)) {
      refuseFinanceReturn("FINANCE_CONFIRM_CHEQUE_ALREADY_CLEARED");
    }
    const liveRows = allRows.filter(isLiveFcCheque);
    if (liveRows.length === 0) {
      if (
        allRows.some(
          (row) => row.status === "RETURNED" || row.status === "CANCELLED",
        )
      ) {
        refuseFinanceReturn("FINANCE_CONFIRM_CHEQUE_RETURNED_OR_CANCELLED");
      }
      refuseFinanceReturn("FINANCE_CONFIRM_CHEQUE_NOT_FOUND");
    }
    if (liveRows.length > 1) {
      refuseFinanceReturn("FINANCE_CONFIRM_MULTIPLE_LIVE_CHEQUES");
    }
    const cheque = liveRows[0];
    // D1: the instrument's operator-recorded (or attested) face must equal
    // the receipt exactly, in the receipt's currency. A legacy row with no
    // recorded face is refused, never assumed equal. All before any write.
    if (cheque.amountMinor === undefined) {
      refuseFinanceReturn("FINANCE_CONFIRM_CHEQUE_FACE_UNRECORDED");
    }
    if (cheque.currency !== currency || cheque.amountMinor !== receiptMinor) {
      refuseFinanceReturn("FINANCE_CONFIRM_CHEQUE_FACE_MISMATCH");
    }
    chequeToClear = cheque;
  }

  // SCRUM-239: this disbursement's identity. Version 1 (an absent stamp) is
  // byte-identical to the keys that have always been used; after a bounced
  // cheque was undone the application is at version 2+, and every key here
  // is new, so nothing collides with the undone disbursement's rows.
  const disbursementVersion = disbursementVersionOf(app);
  const disbursementKeys = financeDisbursementKeys(
    args.applicationId,
    disbursementVersion,
  );
  const now = Date.now();
  await ctx.db.patch(args.applicationId, {
    disbursedAt: now,
    disbursedAmountMinor: receiptMinor,
    disbursementIdempotencyKey: args.idempotencyKey,
    updatedAt: now,
    // This mutation still accepts a single full receipt only, so
    // confirming it settles the deal outright. Partial and repeated
    // receipts, and the actualDealerReceiptTotalMinor they roll up into,
    // arrive with the settlement-line work.
    settlementStatus: "FULLY_SETTLED",
  });

  if (chequeToClear) {
    // Transitions the cheque only — deliberately not clearCheque's
    // legacy collectionPayments/GL posting, since this disbursement is
    // already posted through the canonical finance-company receivable
    // below. A cheque that bounces after this point (post-hoc reversal)
    // is not yet handled; see clearCheque's applicationId guard.
    await markChequeClearedCore(ctx, {
      orgId: args.orgId,
      chequeId: chequeToClear._id,
      clearedAt: now,
    });
    // Which disbursement this instrument cleared; the return command
    // refuses a cheque that is not the application's current one.
    await ctx.db.patch(chequeToClear._id, { disbursementVersion });
  }

  // Post the actual receipt of funds: DR bank or cash on hand / CR Accounts Receivable —
  // Finance Companies. Without this the finance-company receivable opened
  // at finalizeDeal stays open forever even after the money arrives.
  await hookFinanceCashReceived(ctx, {
    orgId: args.orgId,
    applicationId: args.applicationId,
    // Exactly one identity (SCRUM-27): the configured id, or the manual
    // company's name frozen on the application.
    ...(app.companyId
      ? { financeCompanyId: app.companyId }
      : { payerNameSnapshot: manualPayerOf(app)?.name }),
    customerId: app.customerId,
    amountMinor: receiptMinor,
    currency,
    actorId: user._id,
    occurredAt: now,
    disbursementVersion,
    paymentMethod: disbursementMethod,
    bankAccountId: receiptBankAccountId,
  });

  // Record the money in the canonical subledger and settle the
  // finance-company receivable the finalization opened — the one just
  // proven, never one created here to give the settlement something to
  // allocate against.
  const receivableDocumentId = receivable._id;
  const canonicalPaymentId = await createCanonicalPayment(ctx, {
    orgId: args.orgId,
    direction: "IN",
    payerType: app.companyId ? "FINANCE_COMPANY" : "MANUAL_FINANCE_COMPANY",
    financeCompanyId: app.companyId,
    payerNameSnapshot: app.companyId ? undefined : manualPayerOf(app)?.name,
    method: disbursementMethod,
    amountMinor: receiptMinor,
    currency,
    idempotencyKey: disbursementKeys.paymentKey,
    actorId: user._id,
    status: "SETTLED",
    externalReference: `Finance disbursement for application ${args.applicationId}`,
    receivedAt: now,
  });
  // The full proved figure, not min(outstanding, caller): the authority
  // check above already established that the receivable is open, whole
  // and equal to it, so anything else here would be a different amount
  // than the payment and the posting just recorded.
  await allocatePaymentToReceivable(ctx, {
    orgId: args.orgId,
    paymentId: canonicalPaymentId,
    receivableDocumentId,
    amountMinor: receiptMinor,
    actorId: user._id,
  });

  const actorName = await getActorName(ctx);
  await notifyManagers(
    ctx,
    args.orgId,
    "application.created" as const,
    {
      actorName,
      amount: String(receiptMinor),
    },
    { link: `/${args.orgId}/accounting` },
  );
}
