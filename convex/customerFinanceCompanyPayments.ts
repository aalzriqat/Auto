import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type MutationCtx } from "./_generated/server";
import { mutation } from "./functions";
import { recomputeEconomicsForApplication } from "./financingEconomics";
import { runWithIdempotency } from "./utils/idempotency";
import { PERMISSIONS } from "./utils/permissions";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { isMinorAmount } from "./utils/financingEconomics";
import { assertForwardAllowsContributionChange } from "./utils/financeCompanyForward";
import { resolveDealCurrency } from "./utils/settlementDeductions";
import { MAX_DIRECT_PAYMENT_REFERENCE_CHARS } from "./utils/feeDocLimits";
import {
  MAX_CUSTOMER_FINANCE_COMPANY_PAYMENT_ROWS,
  isCurrentAgreementPayment,
  loadCustomerFinanceCompanyPayments,
  normalizedPaymentReference,
} from "./utils/customerFinanceCompanyPayments";

/**
 * SCRUM-766 PR-B - the evidence that the customer paid the finance company.
 *
 * When the customer agrees to pay part of the shortfall straight to the finance
 * company, that is a PROMISE. It lowers the showroom's contribution only once a
 * person with finance authority records that the money was actually paid, with
 * its reference. Until then the showroom still owes the company the full
 * contribution, the profit is the unreduced figure, and the deal cannot close
 * (`CUSTOMER_FINANCE_COMPANY_PAYMENT_CONFIRMED`, `financedSaleRecognition.ts`).
 *
 * The money never passes through the dealership, so nothing posts here: the row
 * is the audit trail and `recomputeEconomicsForApplication` re-derives the
 * contribution from the rows. Rows are voided, never deleted, and neither is
 * possible once the deal is closed - the contribution is then frozen into the
 * finalized plan and a later change would silently disagree with the ledger.
 *
 * The same holds from the moment the showroom pays the finance company its
 * share (SCRUM-411 P2-01): that payment is H + the contribution as it stood, so
 * both commands refuse while any version of it is on the books or unsettled
 * (`assertForwardAllowsContributionChange`) until it is taken back or returned.
 */

const APPLICATION_NOT_FOUND = "Finance application not found in this organization.";
const NEEDS_CONFIRM_PERMS = [PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT, PERMISSIONS.VIEW_FINANCE];
const MAX_REASON_CHARS = 500;
const CLOSED_REFUSAL =
  "This deal has already been closed, so its figures are sealed and the customer's payment to the finance company can no longer be changed here.";

function assertOpenForEvidence(app: Doc<"financeApplications">): void {
  if (app.status !== "APPROVED") {
    throw new ConvexError("Only an approved deal can have the customer's payment to the finance company recorded. Nothing has been changed.");
  }
  if (app.finalizedSaleId !== undefined) throw new ConvexError(CLOSED_REFUSAL);
}

/**
 * What may still be confirmed: the deal's ONE stored balance of what the
 * agreement leaves to confirm (`customerGapToFinanceCompanyUnconfirmedMinor`,
 * written by the economics recompute). It is the creditable part - the
 * agreement capped by the customer's share and by the contribution - minus what
 * is confirmed, so a confirmation can never record more than would credit, and
 * the closing gate and the card read the same figure.
 */
async function confirmableRemainder(
  ctx: MutationCtx,
  app: Doc<"financeApplications">
): Promise<{ rows: Array<Doc<"customerFinanceCompanyPayments">>; remainingMinor: number }> {
  const agreedMinor = app.customerGapToFinanceCompanyMinor ?? 0;
  const settled = app.gapResolution === "CUSTOMER_ABSORBS" || app.gapResolution === "SPLIT";
  if (!settled || !isMinorAmount(agreedMinor) || agreedMinor <= 0 || app.gapResolvedAt === undefined) {
    throw new ConvexError(
      "The customer has not agreed to pay part of the shortfall to the finance company on this deal, so there is no payment to record. Nothing has been recorded."
    );
  }
  const remainingMinor = app.customerGapToFinanceCompanyUnconfirmedMinor;
  if (remainingMinor === undefined || !isMinorAmount(remainingMinor)) {
    throw new ConvexError(
      "This deal's figures have not been worked out since the customer's payment was agreed, so what is still to be confirmed is not known. Nothing has been recorded."
    );
  }
  return { rows: await loadCustomerFinanceCompanyPayments(ctx, app.orgId, app._id), remainingMinor };
}

/**
 * Records that the customer paid the finance company `amountMinor` toward the
 * shortfall, with the payment's reference. Capped by what is still unconfirmed
 * of the agreement; credits the contribution by exactly that much.
 *
 * One transfer is one confirmation: the idempotency key says "this click", not
 * "this transfer", so the bank's reference is what refuses the same transfer
 * confirmed twice. Taking a confirmation back frees only its transfer reference,
 * so the same transfer can be recorded again - under a NEW command and key: the
 * old key still replays the stored result.
 */
export const confirmPayment = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    amountMinor: v.number(),
    paidAt: v.number(),
    reference: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId, NEEDS_CONFIRM_PERMS);
    if (!isMinorAmount(args.amountMinor) || args.amountMinor <= 0) {
      throw new ConvexError("The amount must be a positive whole number of minor units. Nothing has been recorded.");
    }
    if (!Number.isSafeInteger(args.paidAt) || args.paidAt < 0 || args.paidAt > Date.now()) {
      throw new ConvexError("The payment date must be a real date that is not in the future. Nothing has been recorded.");
    }
    const reference = args.reference.trim();
    if (reference.length === 0) {
      throw new ConvexError("The payment's reference is required: it is the evidence that the customer paid. Nothing has been recorded.");
    }
    if (reference.length > MAX_DIRECT_PAYMENT_REFERENCE_CHARS) {
      throw new ConvexError(`The payment reference is too long (the most is ${MAX_DIRECT_PAYMENT_REFERENCE_CHARS} characters). Shorten it and try again. Nothing has been recorded.`);
    }

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "customerFinanceCompanyPayments.confirmPayment",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: auth.user._id,
        fingerprint: JSON.stringify({
          applicationId: args.applicationId,
          amountMinor: args.amountMinor,
          paidAt: args.paidAt,
          reference,
        }),
      },
      async () => {
        // Judged inside the section: a replay returns the first result even if the deal has moved on.
        const app = await requireOwnedRow(ctx, args.orgId, "financeApplications", args.applicationId, APPLICATION_NOT_FOUND);
        assertOpenForEvidence(app);
        // Deciding that the customer's money has arrived moves the owner-facing profit, so the
        // person who sold the deal does not get to decide it on their own deal (as `resolveAppraisalGap`).
        if (auth.user._id === app.salespersonId) {
          throw new ConvexError("You cannot confirm the customer's payment on your own deal. A manager or the dealership owner records it. Nothing has been recorded.");
        }
        // The contribution this credits may already have been paid to the finance company.
        await assertForwardAllowsContributionChange(ctx, app);
        const currency = await resolveDealCurrency(ctx, app, "recording this payment");
        const { rows, remainingMinor } = await confirmableRemainder(ctx, app);
        if (rows.length >= MAX_CUSTOMER_FINANCE_COMPANY_PAYMENT_ROWS) {
          throw new ConvexError("This deal has too many payment records. An accountant reviews the deal. Nothing has been recorded.");
        }
        const wanted = normalizedPaymentReference(reference);
        if (rows.some((row) => row.status === "CONFIRMED" && normalizedPaymentReference(row.reference) === wanted)) {
          throw new ConvexError(
            "A payment with that reference is already recorded as confirmed on this deal, and one transfer is confirmed once. If the earlier record is wrong, take it back with a reason first. Nothing has been recorded."
          );
        }
        if (args.amountMinor > remainingMinor) {
          throw new ConvexError("That is more than the customer agreed to pay the finance company and has not yet been confirmed. Check the amount. Nothing has been recorded.");
        }
        const paymentId = await ctx.db.insert("customerFinanceCompanyPayments", {
          orgId: args.orgId,
          applicationId: app._id,
          status: "CONFIRMED",
          amountMinor: args.amountMinor,
          currency,
          paidAt: args.paidAt,
          reference,
          // The agreement this payment is evidence for (set: `confirmableRemainder` refused without one).
          agreementResolvedAt: app.gapResolvedAt as number,
          confirmedBy: auth.user._id,
          confirmedAt: Date.now(),
        });
        await recomputeEconomicsForApplication(ctx, app._id);
        return paymentId;
      }
    );
  },
});

/**
 * Takes a confirmation back (recorded in error, or the transfer bounced) before
 * the deal closes. The contribution rises again by that amount and the deal
 * cannot close until the agreement is confirmed in full. Reason required.
 */
export const voidPayment = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    paymentId: v.id("customerFinanceCompanyPayments"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId, NEEDS_CONFIRM_PERMS);
    const reason = args.reason.trim();
    if (reason.length === 0) {
      throw new ConvexError("A reason is required. Say why the confirmation is being taken back. Nothing has been changed.");
    }
    if (reason.length > MAX_REASON_CHARS) {
      throw new ConvexError(`The reason is too long (the most is ${MAX_REASON_CHARS} characters). Shorten it and try again. Nothing has been changed.`);
    }
    const app = await requireOwnedRow(ctx, args.orgId, "financeApplications", args.applicationId, APPLICATION_NOT_FOUND);
    assertOpenForEvidence(app);
    if (auth.user._id === app.salespersonId) {
      throw new ConvexError("You cannot change the customer's payment on your own deal. A manager or the dealership owner records it. Nothing has been changed.");
    }
    const row = await requireOwnedRow(ctx, args.orgId, "customerFinanceCompanyPayments", args.paymentId, "Payment record not found in this organization.");
    if (row.applicationId !== app._id) {
      throw new ConvexError("That payment record belongs to a different deal. Nothing has been changed.");
    }
    if (row.status !== "CONFIRMED") {
      throw new ConvexError("That payment confirmation has already been taken back. Nothing has been changed.");
    }
    // Only a row of the current agreement credits the contribution that may already have been paid. A
    // withdrawn agreement's row credits nothing, and closing requires it taken back; the recompute below
    // still refuses any contribution change this misses.
    if (isCurrentAgreementPayment(row, app)) await assertForwardAllowsContributionChange(ctx, app);
    await ctx.db.patch(row._id, {
      status: "VOIDED",
      voidedBy: auth.user._id,
      voidedAt: Date.now(),
      voidReason: reason,
    });
    await recomputeEconomicsForApplication(ctx, app._id);
    return row._id;
  },
});

/**
 * The deal's payment evidence, newest last, for the finance tier. Every row is
 * served, voided and earlier-agreement ones included: evidence that no longer
 * credits is still evidence, and a person has to be able to see it to correct it.
 * `agreement` says whether the row backs the agreement the deal holds now.
 */
export const listPayments = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const app = await requireOwnedRow(ctx, args.orgId, "financeApplications", args.applicationId, APPLICATION_NOT_FOUND);
    const rows = await loadCustomerFinanceCompanyPayments(ctx, args.orgId, app._id);
    return rows.slice(0, MAX_CUSTOMER_FINANCE_COMPANY_PAYMENT_ROWS).map((row: Doc<"customerFinanceCompanyPayments">) => ({
      _id: row._id as Id<"customerFinanceCompanyPayments">,
      status: row.status,
      agreement: isCurrentAgreementPayment(row, app) ? ("CURRENT" as const) : ("PRIOR" as const),
      amountMinor: row.amountMinor,
      currency: row.currency,
      paidAt: row.paidAt,
      reference: row.reference,
      confirmedAt: row.confirmedAt,
      voidReason: row.voidReason,
    }));
  },
});
