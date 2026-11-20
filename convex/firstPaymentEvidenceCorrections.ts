import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation } from "./functions";
import {
  CUSTOMER_FINANCE_APPLICATION_NOT_FOUND,
  CUSTOMER_FINANCE_PAYMENT_PERMISSIONS,
  MAX_CUSTOMER_FINANCE_PAYMENT_REASON_CHARS,
  firstPaymentKind,
  loadCustomerFinanceCompanyPayments,
  normalizedPaymentReference,
  reserveReceiptIdentity,
  validatedReference,
} from "./utils/customerFinanceCompanyPayments";
import { assertNoActiveDealUnwind } from "./utils/dealUnwindGuard";
import {
  canAddCorrectionRecord,
  canCorrectDeliveredEvidence,
  isCorrectionSource,
  isCurrentCorrection,
} from "./utils/deliveredFirstPaymentEvidence";
import { assertForwardAllowsContributionChange } from "./utils/financeCompanyForward";
import { dealSettlesDirect } from "./utils/financedSaleRecognition";
import {
  firstPaymentAttribution,
  readFirstPaymentEvidence,
} from "./utils/firstPaymentEvidence";
import { runWithIdempotency } from "./utils/idempotency";
import { resolveDealCurrency } from "./utils/settlementDeductions";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";

function assertDeliveredEvidenceContext(
  app: Doc<"financeApplications">,
  expectedHandoverAt: number,
): void {
  if (
    app.vehicleHandoverAt !== expectedHandoverAt ||
    !canCorrectDeliveredEvidence(app)
  ) {
    throw new ConvexError(
      "This deal cannot use the delivered first-payment correction. Review the current deal.",
    );
  }
}

async function correctionSource(
  ctx: MutationCtx,
  app: Doc<"financeApplications">,
  paymentId: Id<"customerFinanceCompanyPayments">,
) {
  const row = await requireOwnedRow(
    ctx,
    app.orgId,
    "customerFinanceCompanyPayments",
    paymentId,
  );
  if (!isCorrectionSource(app, row)) {
    throw new ConvexError(
      "The first-payment receipt is no longer eligible for this correction.",
    );
  }
  return row;
}

function assertCorrectionRecordCapacity(paymentCount: number): void {
  if (!canAddCorrectionRecord(paymentCount)) {
    throw new ConvexError(
      "Ask the finance team to review this deal’s existing payment records.",
    );
  }
}

export const requestFirstPaymentEvidenceCorrection = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    paymentId: v.id("customerFinanceCompanyPayments"),
    expectedHandoverAt: v.number(),
    amountMinor: v.number(),
    paidAt: v.number(),
    reference: v.string(),
    kind: firstPaymentKind,
    reason: v.string(),
    idempotencyKey: v.string(),
  },
  returns: v.id("firstPaymentEvidenceCorrections"),
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(
      ctx,
      args.orgId,
      CUSTOMER_FINANCE_PAYMENT_PERMISSIONS,
    );
    const reference = validatedReference(args);
    const reason = args.reason.trim();
    if (
      args.paidAt <= 0 ||
      args.paidAt > args.expectedHandoverAt ||
      reason.length === 0 ||
      reason.length > MAX_CUSTOMER_FINANCE_PAYMENT_REASON_CHARS
    ) {
      throw new ConvexError(
        "Record a reason and the date the customer paid before the original delivery.",
      );
    }
    const {
      orgId,
      applicationId,
      paymentId,
      expectedHandoverAt,
      amountMinor,
      paidAt,
      kind,
      idempotencyKey,
    } = args;
    return await runWithIdempotency(
      ctx,
      {
        orgId,
        idempotencyKey,
        actorId: user._id,
        economic: true,
        operation:
          "firstPaymentEvidenceCorrections.requestFirstPaymentEvidenceCorrection",
        fingerprint: JSON.stringify({
          applicationId,
          paymentId,
          expectedHandoverAt,
          amountMinor,
          paidAt,
          kind,
          reference,
          reason,
        }),
      },
      async () => {
        const app = await requireOwnedRow(
          ctx,
          orgId,
          "financeApplications",
          applicationId,
          CUSTOMER_FINANCE_APPLICATION_NOT_FOUND,
        );
        assertDeliveredEvidenceContext(app, expectedHandoverAt);
        await assertNoActiveDealUnwind(ctx, orgId, applicationId);
        if (user._id === app.salespersonId) {
          throw new ConvexError(
            "Ask a finance verifier to review the evidence on your deal.",
          );
        }
        if (app.pendingFirstPaymentEvidenceCorrectionId !== undefined) {
          throw new ConvexError(
            "Review the pending first-payment correction before requesting another.",
          );
        }
        await assertForwardAllowsContributionChange(ctx, app);
        const rows = await loadCustomerFinanceCompanyPayments(
          ctx,
          orgId,
          app._id,
        );
        assertCorrectionRecordCapacity(rows.length);
        const original = await correctionSource(ctx, app, paymentId);
        const currency = await resolveDealCurrency(
          ctx,
          app,
          "correcting the first-payment evidence",
        );
        const now = Date.now();
        const proof = await readFirstPaymentEvidence(ctx, app, {
          settlesDirect: await dealSettlesDirect(ctx, app),
          currency,
          now,
          paymentRows: rows,
        });
        if (
          proof.status !== "READY" ||
          original.currency !== currency ||
          normalizedPaymentReference(original.reference) !==
            normalizedPaymentReference(reference)
        ) {
          throw new ConvexError(
            "This correction requires eligible proof for the same lender receipt.",
          );
        }
        if (
          original.amountMinor === amountMinor &&
          original.paidAt === paidAt &&
          original.firstPayment?.kind === kind
        ) {
          throw new ConvexError(
            "Make a change to the proof before requesting a correction.",
          );
        }
        const correctionId = await ctx.db.insert(
          "firstPaymentEvidenceCorrections",
          {
            orgId,
            applicationId,
            paymentId,
            amountMinor,
            paidAt,
            kind,
            reference,
            reason,
            currency,
            status: "PENDING",
            handoverAt: expectedHandoverAt,
            economicsRevision: app.economicsRevision,
            vehicleId: app.vehicleId,
            attribution: firstPaymentAttribution(app),
            requestedBy: user._id,
            requestedAt: now,
          },
        );
        await ctx.db.patch(applicationId, {
          pendingFirstPaymentEvidenceCorrectionId: correctionId,
        });
        return correctionId;
      },
    );
  },
});

export const approveFirstPaymentEvidenceCorrection = mutation({
  args: {
    orgId: v.id("organizations"),
    correctionId: v.id("firstPaymentEvidenceCorrections"),
    idempotencyKey: v.string(),
  },
  returns: v.id("customerFinanceCompanyPayments"),
  handler: async (ctx, { orgId, correctionId, idempotencyKey }) => {
    const { user } = await requireTenantAuth(
      ctx,
      orgId,
      CUSTOMER_FINANCE_PAYMENT_PERMISSIONS,
    );
    return await runWithIdempotency(
      ctx,
      {
        orgId,
        idempotencyKey,
        actorId: user._id,
        economic: true,
        operation:
          "firstPaymentEvidenceCorrections.approveFirstPaymentEvidenceCorrection",
        fingerprint: JSON.stringify({ correctionId }),
      },
      async () => {
        const correction = await requireOwnedRow(
          ctx,
          orgId,
          "firstPaymentEvidenceCorrections",
          correctionId,
        );
        const app = await requireOwnedRow(
          ctx,
          orgId,
          "financeApplications",
          correction.applicationId,
          CUSTOMER_FINANCE_APPLICATION_NOT_FOUND,
        );
        assertDeliveredEvidenceContext(app, correction.handoverAt);
        if (
          user._id === correction.requestedBy ||
          user._id === app.salespersonId
        ) {
          throw new ConvexError(
            "Ask an independent finance verifier to approve the correction.",
          );
        }
        if (!isCurrentCorrection(app, correction)) {
          throw new ConvexError(
            "The first-payment correction no longer matches the current deal.",
          );
        }
        await assertNoActiveDealUnwind(ctx, orgId, app._id);
        await assertForwardAllowsContributionChange(ctx, app);
        const original = await correctionSource(ctx, app, correction.paymentId);
        const rows = await loadCustomerFinanceCompanyPayments(
          ctx,
          orgId,
          app._id,
        );
        assertCorrectionRecordCapacity(rows.length);
        const currency = await resolveDealCurrency(
          ctx,
          app,
          "approving the first-payment evidence correction",
        );
        if (
          currency !== correction.currency ||
          original.currency !== currency
        ) {
          throw new ConvexError(
            "The payment currency no longer matches this correction.",
          );
        }
        const now = Date.now();
        await ctx.db.patch(original._id, {
          status: "VOIDED",
          voidedBy: user._id,
          voidedAt: now,
          voidReason: correction.reason,
        });
        const identity = await reserveReceiptIdentity(
          ctx,
          app,
          correction.reference,
          { kind: "FIRST_PAYMENT" },
        );
        const replacementPaymentId = await ctx.db.insert(
          "customerFinanceCompanyPayments",
          {
            orgId,
            applicationId: app._id,
            status: "CONFIRMED",
            amountMinor: correction.amountMinor,
            currency,
            paidAt: correction.paidAt,
            reference: correction.reference,
            ...identity,
            firstPayment: {
              kind: correction.kind,
              attribution: correction.attribution,
              reapprovedForHandoverAt: correction.handoverAt,
            },
            confirmedBy: user._id,
            confirmedAt: now,
          },
        );
        const proof = await readFirstPaymentEvidence(
          ctx,
          { ...app, pendingFirstPaymentEvidenceCorrectionId: undefined },
          {
            settlesDirect: await dealSettlesDirect(ctx, app),
            currency,
            now,
          },
        );
        if (proof.status !== "READY") {
          throw new ConvexError(
            "The corrected receipt does not establish the agreed first payment.",
          );
        }
        await ctx.db.patch(correctionId, {
          status: "APPROVED",
          resolvedAt: now,
          resolvedBy: user._id,
          replacementPaymentId,
        });
        await ctx.db.patch(app._id, {
          pendingFirstPaymentEvidenceCorrectionId: undefined,
        });
        return replacementPaymentId;
      },
    );
  },
});

export const withdrawFirstPaymentEvidenceCorrection = mutation({
  args: {
    orgId: v.id("organizations"),
    correctionId: v.id("firstPaymentEvidenceCorrections"),
  },
  returns: v.id("firstPaymentEvidenceCorrections"),
  handler: async (ctx, { orgId, correctionId }) => {
    const { user } = await requireTenantAuth(
      ctx,
      orgId,
      CUSTOMER_FINANCE_PAYMENT_PERMISSIONS,
    );
    const correction = await requireOwnedRow(
      ctx,
      orgId,
      "firstPaymentEvidenceCorrections",
      correctionId,
    );
    const app = await requireOwnedRow(
      ctx,
      orgId,
      "financeApplications",
      correction.applicationId,
      CUSTOMER_FINANCE_APPLICATION_NOT_FOUND,
    );
    if (user._id === app.salespersonId) {
      throw new ConvexError(
        "Ask a finance verifier to withdraw this correction.",
      );
    }
    if (correction.status === "WITHDRAWN") return correctionId;
    if (
      correction.status !== "PENDING" ||
      app.pendingFirstPaymentEvidenceCorrectionId !== correctionId
    ) {
      throw new ConvexError("Only the pending correction can be withdrawn.");
    }
    await ctx.db.patch(correctionId, {
      status: "WITHDRAWN",
      resolvedAt: Date.now(),
      resolvedBy: user._id,
    });
    await ctx.db.patch(app._id, {
      pendingFirstPaymentEvidenceCorrectionId: undefined,
    });
    return correctionId;
  },
});
