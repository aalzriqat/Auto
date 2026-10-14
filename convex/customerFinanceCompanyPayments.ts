import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type MutationCtx } from "./_generated/server";
import { mutation } from "./functions";
import { recomputeEconomicsForApplication } from "./financingEconomics";
import { runWithIdempotency } from "./utils/idempotency";
import { PERMISSIONS } from "./utils/permissions";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { isMinorAmount } from "./utils/financingEconomics";
import { resolveDealCurrency } from "./utils/settlementDeductions";
import { MAX_DIRECT_PAYMENT_REFERENCE_CHARS } from "./utils/feeDocLimits";
import {
  MAX_CUSTOMER_FINANCE_COMPANY_PAYMENT_ROWS,
  confirmedCustomerPaymentTotalMinor,
  loadCustomerFinanceCompanyPayments,
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

async function confirmableRemainder(
  ctx: MutationCtx,
  app: Doc<"financeApplications">,
  currency: string
): Promise<{ rows: Array<Doc<"customerFinanceCompanyPayments">>; remainingMinor: number }> {
  const agreedMinor = app.customerGapToFinanceCompanyMinor ?? 0;
  const settled = app.gapResolution === "CUSTOMER_ABSORBS" || app.gapResolution === "SPLIT";
  if (!settled || !isMinorAmount(agreedMinor) || agreedMinor <= 0) {
    throw new ConvexError(
      "The customer has not agreed to pay part of the shortfall to the finance company on this deal, so there is no payment to record. Nothing has been recorded."
    );
  }
  const rows = await loadCustomerFinanceCompanyPayments(ctx, app.orgId, app._id);
  return { rows, remainingMinor: agreedMinor - confirmedCustomerPaymentTotalMinor(rows, currency) };
}

/**
 * Records that the customer paid the finance company `amountMinor` toward the
 * shortfall, with the payment's reference. Capped by what is still unconfirmed
 * of the agreement; credits the contribution by exactly that much.
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
        const currency = await resolveDealCurrency(ctx, app, "recording this payment");
        const { rows, remainingMinor } = await confirmableRemainder(ctx, app, currency);
        if (rows.length >= MAX_CUSTOMER_FINANCE_COMPANY_PAYMENT_ROWS) {
          throw new ConvexError("This deal has too many payment records. An accountant reviews the deal. Nothing has been recorded.");
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

/** The deal's payment evidence, newest last, for the finance tier. */
export const listPayments = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const app = await ctx.db.get(args.applicationId);
    if (!app || app.orgId !== args.orgId) return [];
    const rows = await loadCustomerFinanceCompanyPayments(ctx, args.orgId, args.applicationId);
    return rows.slice(0, MAX_CUSTOMER_FINANCE_COMPANY_PAYMENT_ROWS).map((row: Doc<"customerFinanceCompanyPayments">) => ({
      _id: row._id as Id<"customerFinanceCompanyPayments">,
      status: row.status,
      amountMinor: row.amountMinor,
      currency: row.currency,
      paidAt: row.paidAt,
      reference: row.reference,
      confirmedAt: row.confirmedAt,
      voidReason: row.voidReason,
    }));
  },
});
