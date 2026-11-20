import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type MutationCtx } from "./_generated/server";
import { mutation } from "./functions";
import { recomputeEconomicsForApplication } from "./financingEconomics";
import { runWithIdempotency } from "./utils/idempotency";
import { isSystemOwnerRole, PERMISSIONS } from "./utils/permissions";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { isMinorAmount } from "./utils/financingEconomics";
import { assertForwardAllowsContributionChange } from "./utils/financeCompanyForward";
import { resolveDealCurrency } from "./utils/settlementDeductions";
import { assertNoActiveDealUnwind } from "./utils/dealUnwindGuard";
import { dealSettlesDirect } from "./utils/financedSaleRecognition";
import { readFirstPaymentRecords } from "./utils/deliveredFirstPaymentEvidence";
import { firstPaymentAttribution, readFirstPaymentEvidence } from "./utils/firstPaymentEvidence";
import {
  CUSTOMER_FINANCE_APPLICATION_NOT_FOUND as APPLICATION_NOT_FOUND,
  CUSTOMER_FINANCE_PAYMENT_PERMISSIONS as NEEDS_CONFIRM_PERMS,
  MAX_CUSTOMER_FINANCE_COMPANY_PAYMENT_ROWS,
  MAX_CUSTOMER_FINANCE_PAYMENT_REASON_CHARS as MAX_REASON_CHARS,
  isCurrentAgreementPayment,
  loadCustomerFinanceCompanyPayments,
  firstPaymentKind,
  reserveReceiptIdentity,
  validatedReference,
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
    const reference = validatedReference(args);

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
        const receipt = await reserveReceiptIdentity(ctx, app, reference, { kind: "APPRAISAL_GAP", existing: rows });
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
          ...receipt,
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
    if (row.applicationId !== app._id || row.firstPayment !== undefined) {
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
    return rows.slice(0, MAX_CUSTOMER_FINANCE_COMPANY_PAYMENT_ROWS).filter((row) => row.firstPayment === undefined).map((row) => ({
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

export const confirmFirstPayment = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    amountMinor: v.number(),
    paidAt: v.number(),
    reference: v.string(),
    kind: firstPaymentKind,
    idempotencyKey: v.string(),
  },
  returns: v.id("customerFinanceCompanyPayments"),
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, NEEDS_CONFIRM_PERMS);
    const reference = validatedReference(args);
    if (args.paidAt === 0) throw new ConvexError("Enter the date on the finance company's receipt or confirmation.");
    const { orgId, applicationId, amountMinor, paidAt, kind } = args;
    return await runWithIdempotency(ctx, {
      orgId,
      operation: "customerFinanceCompanyPayments.confirmFirstPayment",
      economic: true,
      actorId: user._id,
      idempotencyKey: args.idempotencyKey,
      fingerprint: JSON.stringify({ applicationId, amountMinor, paidAt, reference, kind }),
    }, async () => {
      const app = await requireOwnedRow(ctx, orgId, "financeApplications", applicationId, APPLICATION_NOT_FOUND);
      assertOpenForEvidence(app);
      if (app.salespersonId === user._id) {
        throw new ConvexError("Ask a manager or the dealership owner to confirm the first payment on your deal.");
      }
      if (app.vehicleHandoverAt !== undefined) {
        throw new ConvexError("The finance company's evidence must be recorded before vehicle handover.");
      }
      await assertNoActiveDealUnwind(ctx, orgId, app._id);
      if (app.companyId) await requireOwnedRow(ctx, orgId, "financeCompanies", app.companyId);
      const currency = await resolveDealCurrency(ctx, app, "recording the first payment");
      const confirmedAt = Date.now();
      const proof = await readFirstPaymentEvidence(ctx, app, {
        settlesDirect: await dealSettlesDirect(ctx, app),
        currency,
        now: confirmedAt,
      });
      if (proof.status !== "BLOCKED" || amountMinor > proof.requiredMinor - proof.heldMinor - proof.directMinor) {
        throw new ConvexError("Verify the first-payment balance. The receipt must cover a positive amount still to be confirmed.");
      }
      const rows = await loadCustomerFinanceCompanyPayments(ctx, orgId, app._id);
      if (rows.length >= MAX_CUSTOMER_FINANCE_COMPANY_PAYMENT_ROWS) {
        throw new ConvexError("An accountant must review the deal's existing payment records before another can be confirmed.");
      }
      const receipt = await reserveReceiptIdentity(ctx, app, reference, { kind: "FIRST_PAYMENT" });
      return await ctx.db.insert("customerFinanceCompanyPayments", {
        orgId,
        applicationId,
        status: "CONFIRMED",
        amountMinor,
        currency,
        paidAt,
        reference,
        ...receipt,
        firstPayment: { kind, attribution: firstPaymentAttribution(app) },
        confirmedBy: user._id,
        confirmedAt,
      });
    });
  },
});

export const voidFirstPayment = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    paymentId: v.id("customerFinanceCompanyPayments"),
    reason: v.string(),
  },
  returns: v.id("customerFinanceCompanyPayments"),
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, NEEDS_CONFIRM_PERMS);
    const reason = args.reason.trim();
    if (!reason || reason.length > MAX_REASON_CHARS) {
      throw new ConvexError(`Give a reason of at most ${MAX_REASON_CHARS} characters for taking back the confirmation.`);
    }
    const app = await requireOwnedRow(ctx, args.orgId, "financeApplications", args.applicationId, APPLICATION_NOT_FOUND);
    assertOpenForEvidence(app);
    if (app.salespersonId === user._id) {
      throw new ConvexError("Ask a manager or the dealership owner to take back the confirmation on your deal.");
    }
    await assertNoActiveDealUnwind(ctx, args.orgId, app._id);
    const row = await requireOwnedRow(ctx, args.orgId, "customerFinanceCompanyPayments", args.paymentId);
    if (row.applicationId !== app._id || row.firstPayment === undefined || row.status !== "CONFIRMED") {
      throw new ConvexError("An active first-payment confirmation was not found on this deal.");
    }
    await ctx.db.patch(row._id, {
      status: "VOIDED",
      voidedBy: user._id,
      voidedAt: Date.now(),
      voidReason: reason,
    });
    return row._id;
  },
});

export const firstPayment = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
  },
  returns: v.object({
    proof: v.union(
      v.object({ status: v.union(v.literal("NOT_APPLICABLE"), v.literal("UNAVAILABLE")) }),
      v.object({
        status: v.union(v.literal("READY"), v.literal("BLOCKED")),
        requiredMinor: v.number(),
        heldMinor: v.number(),
        directMinor: v.number(),
      }),
    ),
    closed: v.boolean(),
    canConfirm: v.boolean(),
    canVoid: v.boolean(),
    correctionHandoverAt: v.optional(v.number()),
    pendingCorrection: v.optional(v.object({
      _id: v.id("firstPaymentEvidenceCorrections"),
      paymentId: v.id("customerFinanceCompanyPayments"),
      amountMinor: v.number(),
      currency: v.string(),
      paidAt: v.number(),
      reference: v.string(),
      kind: firstPaymentKind,
      reason: v.string(),
      canApprove: v.boolean(),
      canWithdraw: v.boolean(),
    })),
    records: v.array(v.object({
      _id: v.id("customerFinanceCompanyPayments"),
      kind: firstPaymentKind,
      reference: v.string(),
      paidAt: v.number(),
      amountMinor: v.number(),
      currency: v.string(),
      status: v.union(v.literal("CONFIRMED"), v.literal("VOIDED")),
      agreement: v.union(v.literal("CURRENT"), v.literal("PRIOR")),
      voidReason: v.optional(v.string()),
      canCorrectEvidence: v.optional(v.boolean()),
    })),
  }),
  handler: async (ctx, { orgId, applicationId }) => {
    const { role, user } = await requireTenantAuth(ctx, orgId, [PERMISSIONS.VIEW_FINANCE]);
    const app = await requireOwnedRow(ctx, orgId, "financeApplications", applicationId, APPLICATION_NOT_FOUND);
    const closed = app.status !== "APPROVED" || app.finalizedSaleId !== undefined;
    const canChange = !closed &&
      user._id !== app.salespersonId &&
      (isSystemOwnerRole(role) || role.permissions.includes(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT));
    return await readFirstPaymentRecords(ctx, app, { userId: user._id, closed, canChange });
  },
});
