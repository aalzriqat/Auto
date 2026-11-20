import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  hasUnindexedConfirmedReceipts,
  loadCustomerFinanceCompanyPayments,
  MAX_CUSTOMER_FINANCE_COMPANY_PAYMENT_ROWS,
} from "./customerFinanceCompanyPayments";
import { dealSettlesDirect } from "./financedSaleRecognition";
import {
  firstPaymentAttribution,
  readFirstPaymentEvidence,
  type FirstPaymentEvidence,
} from "./firstPaymentEvidence";
import { resolveDealCurrency } from "./settlementDeductions";

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
  let proof: FirstPaymentEvidence = { status: "UNAVAILABLE" };
  try {
    const currency = await resolveDealCurrency(
      ctx,
      app,
      "checking the first payment",
    );
    proof = await readFirstPaymentEvidence(ctx, app, {
      settlesDirect: await dealSettlesDirect(ctx, app),
      currency,
      now: Date.now(),
    });
  } catch (error) {
    if (!(error instanceof ConvexError))
      console.error("Unable to read first-payment evidence", error);
  }
  const rows = await loadCustomerFinanceCompanyPayments(ctx, orgId, app._id);
  const attribution = firstPaymentAttribution(app);
  const pending =
    app.pendingFirstPaymentEvidenceCorrectionId === undefined
      ? null
      : await ctx.db.get(app.pendingFirstPaymentEvidenceCorrectionId);
  const canRequestCorrection =
    canChange && proof.status === "READY" && canCorrectDeliveredEvidence(app);
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
            canApprove:
              canChange &&
              userId !== pending.requestedBy &&
              canCorrectDeliveredEvidence(app) &&
              isCurrentCorrection(app, pending),
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
                canCorrectEvidence:
                  canRequestCorrection && isCorrectionSource(app, row)
                    ? true
                    : undefined,
              },
            ],
      ),
  };
}
