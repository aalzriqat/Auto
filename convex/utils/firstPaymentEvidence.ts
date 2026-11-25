import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { ClosingReadinessReason } from "../../lib/closingReadinessReasonCodes";
import { liveAppliedMinorForDeposit } from "./depositApplications";
import {
  financeCompanyReceiptIdentity,
  financeCompanyReceiptIssuer,
  loadCustomerFinanceCompanyPayments,
  MAX_CUSTOMER_FINANCE_COMPANY_PAYMENT_ROWS,
  normalizedPaymentReference,
} from "./customerFinanceCompanyPayments";
import { isMinorAmount } from "./financingEconomics";
import { isManualFinanceApplication } from "./manualFinancePayer";

type Ctx = QueryCtx | MutationCtx;
type Application = Doc<"financeApplications">;

export const MAX_QUOTE_DEPOSITS = 50;

export type FirstPaymentEvidence =
  | { status: "NOT_APPLICABLE" | "UNAVAILABLE" }
  | {
      status: "READY" | "BLOCKED";
      requiredMinor: number;
      heldMinor: number;
      directMinor: number;
    };

export function firstPaymentRefusal(status: FirstPaymentEvidence["status"]): ClosingReadinessReason | null {
  if (status === "BLOCKED") {
    return {
      code: "FIRST_PAYMENT_PROOF_MISSING",
      message: "Verify the customer's agreed first payment before handing over the vehicle.",
    };
  }
  if (status === "UNAVAILABLE") {
    return {
      code: "FIRST_PAYMENT_PROOF_UNAVAILABLE",
      message: "The first-payment evidence cannot be verified. Ask the finance team to review the receipts.",
    };
  }
  return null;
}

function hasHandoverEvidenceRequirement(app: Application): boolean {
  return Boolean(app.firstPaymentEvidenceChecked || app.approvedLenderCorrectionId !== undefined ||
    app.identityFinanceTermsRequiredSince !== undefined);
}

export async function readDeliveredFirstPaymentEvidence(
  ctx: Ctx,
  app: Application,
  opts: { settlesDirect: boolean; currency: string },
): Promise<FirstPaymentEvidence | undefined> {
  if (app.vehicleHandoverAt === undefined || !hasHandoverEvidenceRequirement(app)) {
    return undefined;
  }
  return await readFirstPaymentEvidence(ctx, app, { ...opts, now: Date.now() });
}

export function firstPaymentAttribution(app: Application): string {
  return JSON.stringify([app.quoteId, app.customerId, financeCompanyReceiptIssuer(app)]);
}

function isTimely(timestamp: number | undefined, cutoff: number): timestamp is number {
  return timestamp !== undefined && Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp <= cutoff;
}

async function postedDepositMinor(
  ctx: Ctx,
  app: Application,
  deposit: Doc<"deposits">,
  currency: string,
  cutoff: number,
): Promise<number | null> {
  if (!deposit.holdActive || deposit.isDeleted || deposit.status !== "HELD") return 0;
  if (
    deposit.orgId !== app.orgId ||
    deposit.customerId !== app.customerId ||
    deposit.vehicleId !== app.vehicleId ||
    deposit.currency !== currency ||
    deposit.amountMinor === undefined ||
    !isMinorAmount(deposit.amountMinor) ||
    deposit.amountMinor === 0 ||
    !deposit.canonicalPaymentId
  ) return null;

  // The existing single-vehicle settlement consumes a whole held deposit.
  // A divided or partly paid-out row cannot prove that whole slice.
  if ((deposit.releasedAmountMinor ?? 0) !== 0 || (await liveAppliedMinorForDeposit(ctx, deposit._id)) !== 0) {
    return null;
  }
  if (!isTimely(deposit.createdAt, cutoff)) return 0;

  const postingKey = `deposit_received_${deposit._id}`;
  const [payment, events] = await Promise.all([
    ctx.db.get(deposit.canonicalPaymentId),
    ctx.db
      .query("accountingEvents")
      .withIndex("by_org_idempotency", (q) => q.eq("orgId", app.orgId).eq("idempotencyKey", postingKey))
      .take(2),
  ]);
  const [event] = events;
  if (
    payment?.orgId !== app.orgId ||
    payment.customerId !== app.customerId ||
    payment.direction !== "IN" ||
    payment.payerType !== "CUSTOMER" ||
    payment.status !== "SETTLED" ||
    payment.amountMinor !== deposit.amountMinor ||
    payment.currency !== currency ||
    payment.idempotencyKey !== postingKey ||
    !isTimely(payment.receivedAt, cutoff) ||
    events.length !== 1 ||
    event?.eventType !== "DEPOSIT_RECEIVED" ||
    event.sourceType !== "deposits" ||
    event.sourceId !== String(deposit._id) ||
    event.status !== "POSTED" ||
    event.currency !== currency ||
    !isTimely(event.occurredAt, cutoff) ||
    !event.journalEntryId
  ) return null;

  const payload: unknown = event.payload;
  if (
    typeof payload !== "object" || payload === null ||
    !("amountMinor" in payload) || payload.amountMinor !== deposit.amountMinor ||
    !("customerId" in payload) || payload.customerId !== String(app.customerId)
  ) return null;
  const journal = await ctx.db.get(event.journalEntryId);
  const lenderReturnCorrectionAt = app.identityLenderReturnCorrectionAt;
  if (lenderReturnCorrectionAt !== undefined &&
      (deposit.createdAt < lenderReturnCorrectionAt || payment.receivedAt < lenderReturnCorrectionAt)) return 0;
  return journal?.orgId === app.orgId && journal.accountingEventId === event._id && journal.status === "POSTED"
    ? deposit.amountMinor
    : null;
}

export async function readPostedQuoteDepositMinor(
  ctx: Ctx,
  { app, deposits, currency, cutoff }: {
    app: Application;
    deposits: readonly Doc<"deposits">[];
    currency: string;
    cutoff: number;
  },
): Promise<number | null> {
  let heldMinor = 0;
  for (const deposit of deposits) {
    const amount = await postedDepositMinor(ctx, app, deposit, currency, cutoff);
    if (amount === null) return null;
    heldMinor += amount;
  }
  return heldMinor;
}

/** Shared by readiness and the handover mutation. Any close after an enforced
 * handover reads the same proof with the actual handover as its cutoff. */
export async function readFirstPaymentEvidence(
  ctx: Ctx,
  app: Application,
  { settlesDirect, currency, now, paymentRows, depositRows }: {
    settlesDirect: boolean;
    currency: string;
    now: number;
    paymentRows?: readonly Doc<"customerFinanceCompanyPayments">[];
    depositRows?: readonly Doc<"deposits">[];
  },
): Promise<FirstPaymentEvidence> {
  if ((app.pendingFirstPaymentEvidenceCorrectionId !== undefined || app.pendingLenderCorrectionId !== undefined ||
      app.pendingIdentityCorrectionId !== undefined) &&
    app.status === "APPROVED" && app.finalizedSaleId === undefined) {
    return { status: "UNAVAILABLE" };
  }
  // Withdrawing recorded terms clears the fields that otherwise distinguish legacy agreements.
  const requiredSince = app.identityFinanceTermsRequiredSince;
  if (requiredSince !== undefined && app.status === "APPROVED" && app.finalizedSaleId === undefined &&
      (!isTimely(requiredSince, now) || app.submittedQuotationMinor === undefined ||
        app.approvedDealerPurchaseAmountMinor === undefined || !isTimely(app.submittedQuotationAt, now) ||
        !isTimely(app.approvedPurchaseApprovedAt, now) || (app.submittedQuotationAt ?? 0) < requiredSince ||
        (app.approvedPurchaseApprovedAt ?? 0) < (app.submittedQuotationAt ?? 0))) {
    return { status: "UNAVAILABLE" };
  }
  const requiredMinor = app.customerFirstPaymentMinor;
  if (app.approvedIdentityCorrectionId !== undefined && app.status === "APPROVED" &&
      app.finalizedSaleId === undefined) {
    const correction = await ctx.db.get(app.approvedIdentityCorrectionId);
    if (!correction || correction.orgId !== app.orgId || correction.applicationId !== app._id ||
        correction.status !== "APPROVED" || correction.replacementQuoteId !== app.quoteId ||
        correction.replacementCustomerId !== app.customerId || correction.replacementVehicleId !== app.vehicleId ||
        !isTimely(correction.resolvedAt, now) || !isTimely(correction.returnedAt, correction.resolvedAt) ||
        correction.returnedAt < correction.handoverAt ||
        !correction.returnReference || requiredMinor !== 0 || app.submittedQuotationMinor === undefined ||
        app.approvedDealerPurchaseAmountMinor === undefined ||
        (app.submittedQuotationAt ?? 0) < correction.resolvedAt ||
        (app.approvedPurchaseApprovedAt ?? 0) < correction.resolvedAt) {
      return { status: "UNAVAILABLE" };
    }
  }
  if (
    settlesDirect ||
    (!app.companyId && !isManualFinanceApplication(app)) ||
    app.finalizedSaleId !== undefined ||
    app.status === "CLOSED" ||
    app.status === "CANCELLED" ||
    app.status === "REJECTED" ||
    (app.vehicleHandoverAt !== undefined && !hasHandoverEvidenceRequirement(app))
  ) return { status: "NOT_APPLICABLE" };
  if (app.approvedLenderCorrectionId !== undefined) {
    const correction = await ctx.db.get(app.approvedLenderCorrectionId);
    if (
      !app.firstPaymentEvidenceChecked || !correction || correction.orgId !== app.orgId || correction.applicationId !== app._id ||
      correction.status !== "APPROVED" || correction.replacementQuoteId !== app.quoteId ||
      correction.replacementCompanyId !== app.companyId || correction.handoverAt !== app.vehicleHandoverAt ||
      !isTimely(correction.resolvedAt, now) || !correction.lenderApprovalReference ||
      requiredMinor !== 0 || app.submittedQuotationMinor === undefined ||
      app.approvedDealerPurchaseAmountMinor === undefined ||
      (app.submittedQuotationAt ?? 0) < (correction.resolvedAt ?? 0) ||
      (app.approvedPurchaseApprovedAt ?? 0) < (correction.resolvedAt ?? 0)
    ) return { status: "UNAVAILABLE" };
  }
  if (requiredMinor === undefined) {
    return { status: app.submittedQuotationMinor === undefined ? "NOT_APPLICABLE" : "UNAVAILABLE" };
  }
  if (!isMinorAmount(requiredMinor)) return { status: "UNAVAILABLE" };
  // No agreed first payment means no receipt can prove one. Earlier reservation
  // money remains subject to its explicit disposition at settlement.
  if (requiredMinor === 0) return { status: "READY", requiredMinor, heldMinor: 0, directMinor: 0 };
  if (app.approvedDealerPurchaseAmountMinor === undefined) return { status: "UNAVAILABLE" };
  if (!financeCompanyReceiptIssuer(app)) return { status: "UNAVAILABLE" };

  const quote = await ctx.db.get(app.quoteId);
  if (
    !quote ||
    quote.orgId !== app.orgId ||
    quote.customerId !== app.customerId ||
    quote.vehicleId !== app.vehicleId ||
    (quote.vehicleItems?.length ?? 1) > 1
  ) return { status: "UNAVAILABLE" };

  const cutoff = app.vehicleHandoverAt ?? now;
  const lenderReturnCorrectionAt = app.identityLenderReturnCorrectionAt;
  if (lenderReturnCorrectionAt !== undefined && !isTimely(lenderReturnCorrectionAt, cutoff)) {
    return { status: "UNAVAILABLE" };
  }
  const [deposits, payments] = await Promise.all([
    depositRows ?? ctx.db
      .query("deposits")
      .withIndex("by_quote", (q) => q.eq("quoteId", app.quoteId))
      .take(MAX_QUOTE_DEPOSITS + 1),
    paymentRows ?? loadCustomerFinanceCompanyPayments(ctx, app.orgId, app._id),
  ]);
  if (deposits.length > MAX_QUOTE_DEPOSITS || payments.length > MAX_CUSTOMER_FINANCE_COMPANY_PAYMENT_ROWS) {
    return { status: "UNAVAILABLE" };
  }

  const heldMinor = await readPostedQuoteDepositMinor(ctx, { app, deposits, currency, cutoff });
  if (heldMinor === null) return { status: "UNAVAILABLE" };
  const attribution = firstPaymentAttribution(app);
  const usedPayments = new Set<string>();
  let directMinor = 0;
  for (const payment of payments) {
    const reapproved = app.vehicleHandoverAt !== undefined &&
      payment.firstPayment?.reapprovedForHandoverAt === app.vehicleHandoverAt;
    if (
      payment.status !== "CONFIRMED" ||
      payment.firstPayment?.attribution !== attribution ||
      (lenderReturnCorrectionAt !== undefined &&
        (payment.paidAt < lenderReturnCorrectionAt ||
          payment.firstPayment.verifiedForLenderReturnCorrectionAt !== lenderReturnCorrectionAt)) ||
      !isTimely(payment.paidAt, cutoff) ||
      !isTimely(payment.confirmedAt, reapproved ? now : cutoff)
    ) continue;
    if (
      payment.currency !== currency ||
      !isMinorAmount(payment.amountMinor) ||
      !payment.sourceIdentity ||
      payment.normalizedReference !== normalizedPaymentReference(payment.reference) ||
      payment.sourceIdentity !== financeCompanyReceiptIdentity(app, payment.reference) ||
      usedPayments.has(payment.sourceIdentity)
    ) return { status: "UNAVAILABLE" };
    usedPayments.add(payment.sourceIdentity);
    directMinor += payment.amountMinor;
  }
  const totalMinor = heldMinor + directMinor;
  if (!isMinorAmount(totalMinor) ||
    (app.vehicleHandoverAt === undefined && totalMinor > requiredMinor)) return { status: "UNAVAILABLE" };
  return { status: totalMinor >= requiredMinor ? "READY" : "BLOCKED", requiredMinor, heldMinor, directMinor };
}
