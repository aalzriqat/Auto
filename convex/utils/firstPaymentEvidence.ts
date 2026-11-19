import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { ClosingReadinessReason } from "../../lib/closingReadinessReasonCodes";
import { liveAppliedMinorForDeposit } from "./depositApplications";
import {
  financeCompanyReceiptIdentity,
  financeCompanyReceiptIssuer,
  loadCustomerFinanceCompanyPayments,
  MAX_CUSTOMER_FINANCE_COMPANY_PAYMENT_ROWS,
} from "./customerFinanceCompanyPayments";
import { isMinorAmount } from "./financingEconomics";
import { isManualFinanceApplication } from "./manualFinancePayer";

type Ctx = QueryCtx | MutationCtx;
type Application = Doc<"financeApplications">;

const MAX_QUOTE_DEPOSITS = 50;

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

export function firstPaymentAttribution(app: Application): string {
  return JSON.stringify([app.quoteId, app.customerId, financeCompanyReceiptIssuer(app)]);
}

function isTimely(timestamp: number | undefined, cutoff: number): boolean {
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
  return journal?.orgId === app.orgId && journal.accountingEventId === event._id && journal.status === "POSTED"
    ? deposit.amountMinor
    : null;
}

/** Shared by readiness and the handover mutation. Any close after an enforced
 * handover reads the same proof with the actual handover as its cutoff. */
export async function readFirstPaymentEvidence(
  ctx: Ctx,
  app: Application,
  { settlesDirect, currency, now }: { settlesDirect: boolean; currency: string; now: number },
): Promise<FirstPaymentEvidence> {
  const requiredMinor = app.customerFirstPaymentMinor;
  if (
    settlesDirect ||
    (!app.companyId && !isManualFinanceApplication(app)) ||
    app.finalizedSaleId !== undefined ||
    app.status === "CLOSED" ||
    app.status === "CANCELLED" ||
    app.status === "REJECTED" ||
    (app.approvedDealerPurchaseAmountMinor === undefined && !app.firstPaymentEvidenceChecked) ||
    (app.vehicleHandoverAt !== undefined && !app.firstPaymentEvidenceChecked)
  ) return { status: "NOT_APPLICABLE" };
  if (requiredMinor === undefined) {
    return { status: app.submittedQuotationMinor === undefined ? "NOT_APPLICABLE" : "UNAVAILABLE" };
  }
  if (!isMinorAmount(requiredMinor)) return { status: "UNAVAILABLE" };
  if (requiredMinor === 0) return { status: "READY", requiredMinor, heldMinor: 0, directMinor: 0 };
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
  const [deposits, payments] = await Promise.all([
    ctx.db
      .query("deposits")
      .withIndex("by_quote", (q) => q.eq("quoteId", app.quoteId))
      .take(MAX_QUOTE_DEPOSITS + 1),
    loadCustomerFinanceCompanyPayments(ctx, app.orgId, app._id),
  ]);
  if (deposits.length > MAX_QUOTE_DEPOSITS || payments.length > MAX_CUSTOMER_FINANCE_COMPANY_PAYMENT_ROWS) {
    return { status: "UNAVAILABLE" };
  }

  let heldMinor = 0;
  for (const deposit of deposits) {
    const amount = await postedDepositMinor(ctx, app, deposit, currency, cutoff);
    if (amount === null) return { status: "UNAVAILABLE" };
    heldMinor += amount;
  }
  const attribution = firstPaymentAttribution(app);
  const usedPayments = new Set<string>();
  let directMinor = 0;
  for (const payment of payments) {
    if (
      payment.status !== "CONFIRMED" ||
      payment.firstPayment?.attribution !== attribution ||
      !isTimely(payment.paidAt, cutoff) ||
      !isTimely(payment.confirmedAt, cutoff)
    ) continue;
    if (
      payment.currency !== currency ||
      !isMinorAmount(payment.amountMinor) ||
      !payment.sourceIdentity ||
      payment.sourceIdentity !== financeCompanyReceiptIdentity(app, payment.reference) ||
      usedPayments.has(payment.sourceIdentity)
    ) return { status: "UNAVAILABLE" };
    usedPayments.add(payment.sourceIdentity);
    directMinor += payment.amountMinor;
  }
  const totalMinor = heldMinor + directMinor;
  if (!isMinorAmount(totalMinor)) return { status: "UNAVAILABLE" };
  return { status: totalMinor >= requiredMinor ? "READY" : "BLOCKED", requiredMinor, heldMinor, directMinor };
}
