import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  hasUnindexedConfirmedReceipts,
  loadCustomerFinanceCompanyPayments,
  MAX_CUSTOMER_FINANCE_COMPANY_PAYMENT_ROWS,
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
                canCorrectEvidence:
                  canRequestCorrection && isCorrectionSource(app, row)
                    ? true
                    : undefined,
              },
            ],
      ),
  };
}
