import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  financeCompanyReceiptIdentity,
  hasUnindexedConfirmedReceipts,
  loadCustomerFinanceCompanyPayments,
  MAX_CUSTOMER_FINANCE_COMPANY_PAYMENT_ROWS,
  normalizedPaymentReference,
} from "./customerFinanceCompanyPayments";
import { activeDealUnwindFor } from "./dealUnwindGuard";
import {
  deriveForwardState,
  FORWARD_VERSIONS_ONLY,
  forwardIsLive,
} from "./financeCompanyForward";
import { dealSettlesDirect } from "./financedSaleRecognition";
import {
  firstPaymentAttribution,
  readFirstPaymentEvidence,
  type FirstPaymentEvidence,
} from "./firstPaymentEvidence";
import { isMinorAmount } from "./financingEconomics";
import { resolveDealCurrency } from "./settlementDeductions";
import { requireOwnedRow } from "./tenancy";

async function assertArchivedLenderReturn(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
  payment: Doc<"customerFinanceCompanyPayments">,
) {
  const proof = payment.lenderReturn;
  const corrections = await ctx.db.query("deliveredDealIdentityCorrections")
    .withIndex("by_org_returned_first_payment", (q) => q.eq("orgId", app.orgId).eq("returnedDirectFirstPaymentId", payment._id))
    .take(2);
  const [correction] = corrections;
  if (
    !proof || payment.status !== "VOIDED" || corrections.length !== 1 || !correction || correction.orgId !== app.orgId ||
    correction.applicationId !== app._id || correction.status !== "APPLIED_BEFORE_HANDOVER" ||
    correction.returnedDirectFirstPaymentId !== payment._id ||
    correction.originalValues.customerId !== proof.originalCustomerId ||
    proof.amountMinor !== payment.amountMinor || proof.verifiedSamePayer !== true ||
    !Number.isSafeInteger(proof.refundedAt) || proof.refundedAt < payment.paidAt ||
    payment.voidedAt !== correction.resolvedAt || proof.refundedAt > correction.resolvedAt ||
    payment.voidedBy !== correction.resolvedBy ||
    proof.normalizedReference !== normalizedPaymentReference(proof.reference)
  ) throw new ConvexError("The deal’s earlier first-payment return evidence needs review.");
}

export async function readOriginalLenderReturnReceipt(ctx: QueryCtx, app: Doc<"financeApplications">) {
  const payments = await loadCustomerFinanceCompanyPayments(ctx, app.orgId, app._id);
  if (payments.length > MAX_CUSTOMER_FINANCE_COMPANY_PAYMENT_ROWS) {
    throw new ConvexError("Review the deal’s existing payment records before changing the buyer or vehicle.");
  }
  const current: Doc<"customerFinanceCompanyPayments">[] = [];
  for (const payment of payments) {
    if (payment.lenderReturn) await assertArchivedLenderReturn(ctx, app, payment);
    else current.push(payment);
  }
  if (current.length === 0) return null;
  const [payment] = current;
  if (
    current.length !== 1 || !payment || payment.status !== "CONFIRMED" ||
    app.status !== "APPROVED" || app.approvedDealerPurchaseAmountMinor === undefined || !app.companyId ||
    payment.firstPayment?.attribution !== firstPaymentAttribution(app) ||
    payment.firstPayment.reapprovedForHandoverAt !== undefined ||
    payment.agreementResolvedAt !== undefined ||
    payment.sourceIdentity !== financeCompanyReceiptIdentity(app, payment.reference) ||
    payment.normalizedReference !== normalizedPaymentReference(payment.reference) ||
    !isMinorAmount(payment.amountMinor) || payment.amountMinor <= 0 ||
    payment.amountMinor !== app.customerFirstPaymentMinor ||
    !Number.isSafeInteger(payment.paidAt) || payment.paidAt <= 0 || payment.paidAt > Date.now() ||
    !Number.isSafeInteger(payment.confirmedAt) || payment.confirmedAt < payment.paidAt ||
    payment.currency !== await resolveDealCurrency(ctx, app, "verifying the original first payment")
  ) throw new ConvexError("Review the deal’s existing payment records before changing the buyer or vehicle.");
  await requireOwnedRow(ctx, app.orgId, "financeCompanies", app.companyId);
  return payment;
}

export function canCorrectDeliveredEvidence(
  app: Doc<"financeApplications">,
): boolean {
  const handoverAt = app.vehicleHandoverAt;
  return (
    app.status === "APPROVED" &&
    app.finalizedSaleId === undefined &&
    handoverAt !== undefined &&
    Number.isSafeInteger(handoverAt) &&
    handoverAt > 0 &&
    app.handoverStatus === "HANDED_OVER" &&
    app.firstPaymentEvidenceChecked === true &&
    app.disbursedAt === undefined &&
    app.supplierDisbursementConfirmedAt === undefined
  );
}

export function canAddCorrectionRecord(paymentCount: number): boolean {
  return paymentCount < MAX_CUSTOMER_FINANCE_COMPANY_PAYMENT_ROWS;
}

export function isCorrectionSource(
  app: Doc<"financeApplications">,
  row: Doc<"customerFinanceCompanyPayments">,
) {
  const handoverAt = app.vehicleHandoverAt;
  return (
    row.applicationId === app._id &&
    row.status === "CONFIRMED" &&
    row.firstPayment?.attribution === firstPaymentAttribution(app) &&
    handoverAt !== undefined &&
    Number.isSafeInteger(row.paidAt) &&
    row.paidAt > 0 &&
    row.paidAt <= handoverAt &&
    Number.isSafeInteger(row.confirmedAt) &&
    row.confirmedAt > 0 &&
    (row.confirmedAt <= handoverAt ||
      row.firstPayment.reapprovedForHandoverAt === handoverAt)
  );
}

export function isCurrentCorrection(
  app: Doc<"financeApplications">,
  correction: Doc<"firstPaymentEvidenceCorrections">,
): boolean {
  return (
    correction.status === "PENDING" &&
    app.pendingFirstPaymentEvidenceCorrectionId === correction._id &&
    app.vehicleHandoverAt === correction.handoverAt &&
    app.economicsRevision === correction.economicsRevision &&
    app.vehicleId === correction.vehicleId &&
    firstPaymentAttribution(app) === correction.attribution
  );
}

export async function readFirstPaymentRecords(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
  viewer: { userId: Id<"users">; closed: boolean; canChange: boolean },
) {
  const { userId, closed, canChange } = viewer;
  const { orgId } = app;
  const rows = await loadCustomerFinanceCompanyPayments(ctx, orgId, app._id);
  const pending =
    app.pendingFirstPaymentEvidenceCorrectionId === undefined
      ? null
      : await ctx.db.get(app.pendingFirstPaymentEvidenceCorrectionId);
  const canCorrect =
    canChange &&
    canCorrectDeliveredEvidence(app) &&
    canAddCorrectionRecord(rows.length) &&
    !(await hasUnindexedConfirmedReceipts(ctx, orgId)) &&
    (await activeDealUnwindFor(ctx, orgId, app._id)) === null &&
    !forwardIsLive(await deriveForwardState(ctx, app, FORWARD_VERSIONS_ONLY));

  let proof: FirstPaymentEvidence = { status: "UNAVAILABLE" };
  let canApprove = false;
  try {
    const currency = await resolveDealCurrency(
      ctx,
      app,
      "checking the first payment",
    );
    const options = {
      settlesDirect: await dealSettlesDirect(ctx, app),
      currency,
      now: Date.now(),
    };
    proof = await readFirstPaymentEvidence(ctx, app, {
      ...options,
      paymentRows: rows,
    });

    if (
      canCorrect &&
      pending?.orgId === orgId &&
      pending.applicationId === app._id &&
      userId !== pending.requestedBy &&
      pending.currency === currency &&
      isCurrentCorrection(app, pending)
    ) {
      const source = rows.find((row) => row._id === pending.paymentId);
      if (
        source &&
        source.currency === currency &&
        source.firstPayment?.kind === pending.kind &&
        isCorrectionSource(app, source)
      ) {
        // Preview the replacement with the same delivery cutoff as approval.
        const replacement = {
          ...source,
          amountMinor: pending.amountMinor,
          paidAt: pending.paidAt,
          reference: pending.reference,
          firstPayment: {
            ...source.firstPayment,
            kind: pending.kind,
            attribution: pending.attribution,
            reapprovedForHandoverAt: pending.handoverAt,
          },
          confirmedAt: options.now,
          confirmedBy: userId,
        };
        const prospective = await readFirstPaymentEvidence(
          ctx,
          { ...app, pendingFirstPaymentEvidenceCorrectionId: undefined },
          {
            ...options,
            paymentRows: rows.map((row) =>
              row._id === source._id ? replacement : row,
            ),
          },
        );
        canApprove = prospective.status === "READY";
      }
    }
  } catch (error) {
    if (!(error instanceof ConvexError))
      console.error("Unable to read first-payment evidence", error);
  }
  const attribution = firstPaymentAttribution(app);
  const canRequestCorrection = canCorrect && proof.status === "READY";
  return {
    proof,
    closed,
    canConfirm:
      canChange &&
      app.vehicleHandoverAt === undefined &&
      proof.status === "BLOCKED" &&
      !(await hasUnindexedConfirmedReceipts(ctx, orgId)),
    canVoid: canChange,
    correctionHandoverAt: canRequestCorrection
      ? app.vehicleHandoverAt
      : undefined,
    pendingCorrection:
      !closed &&
      pending?.orgId === orgId &&
      pending.applicationId === app._id &&
      pending.status === "PENDING"
        ? {
            _id: pending._id,
            paymentId: pending.paymentId,
            amountMinor: pending.amountMinor,
            currency: pending.currency,
            paidAt: pending.paidAt,
            reference: pending.reference,
            kind: pending.kind,
            reason: pending.reason,
            canApprove,
            canWithdraw: canChange,
          }
        : undefined,
    records: rows
      .slice(0, MAX_CUSTOMER_FINANCE_COMPANY_PAYMENT_ROWS)
      .flatMap((row) =>
        row.firstPayment === undefined
          ? []
          : [
              {
                _id: row._id,
                kind: row.firstPayment.kind,
                reference: row.reference,
                paidAt: row.paidAt,
                amountMinor: row.amountMinor,
                currency: row.currency,
                status: row.status,
                agreement:
                  row.firstPayment.attribution === attribution
                    ? ("CURRENT" as const)
                    : ("PRIOR" as const),
                voidReason: row.voidReason,
                lenderReturn: row.lenderReturn && {
                  reference: row.lenderReturn.reference,
                  refundedAt: row.lenderReturn.refundedAt,
                },
                canCorrectEvidence:
                  canRequestCorrection && isCorrectionSource(app, row)
                    ? true
                    : undefined,
              },
            ],
      ),
  };
}
