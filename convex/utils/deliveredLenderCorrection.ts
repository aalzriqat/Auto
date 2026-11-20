import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { resolveOwnership } from "../commitments";
import {
  resolveCreationEconomicsInputs,
  resolveCreationRuleSnapshot,
} from "./creationEconomics";
import { assertNoActiveDealUnwind } from "./dealUnwindGuard";
import {
  assertNoPendingDepositRequest,
  assertNoQuoteLinkedReservationDeposit,
} from "./depositRequestGuards";
import { assertCurrentQuote } from "./quotedCommercialDeal";
import { requireOwnedRow } from "./tenancy";
import { assertQuotableVehicle } from "./vehicleLiveness";
import { isConsignedAgentSale } from "./vehicleOwnership";

export function readCorrectableAgreement(app: Doc<"financeApplications">) {
  if (
    app.status !== "APPROVED" ||
    app.finalizedSaleId !== undefined ||
    !app.dealId ||
    !app.dealNumber ||
    !app.companyId ||
    app.quoteModeAtSubmission !== "CONFIGURED_FINANCE_COMPANY" ||
    app.vehicleHandoverAt === undefined ||
    !app.vehicleHandoverBy ||
    app.handoverStatus !== "HANDED_OVER" ||
    !app.firstPaymentEvidenceChecked ||
    app.approvedDealerPurchaseAmountMinor === undefined ||
    app.customerFirstPaymentMinor !== 0 ||
    app.gapResolution !== "NOT_REQUIRED" ||
    app.needsFinancingReconciliation ||
    app.pendingFirstPaymentEvidenceCorrectionId !== undefined ||
    app.approvedLenderCorrectionId !== undefined
  )
    return null;
  return { companyId: app.companyId, handoverAt: app.vehicleHandoverAt };
}

type AgreementQuotes = {
  app: Doc<"financeApplications">,
  original: Doc<"quotes">,
  replacement: Doc<"quotes">,
};

export async function assertNoAgreementMoney(
  ctx: QueryCtx,
  { app, original, replacement }: AgreementQuotes,
): Promise<void> {
  if (
    app.expectedPaymentRegisteredAt !== undefined ||
    app.expectedPaymentMethod !== undefined ||
    app.disbursedAt !== undefined ||
    app.disbursedAmountMinor !== undefined ||
    app.supplierDisbursementConfirmedAt !== undefined ||
    app.supplierDisbursedAmountMinor !== undefined ||
    app.legalInvoiceRecordedAt !== undefined ||
    app.legalInvoiceAmountMinor !== undefined
  ) {
    throw new ConvexError(
      "Review the invoice or payment already recorded on this deal before changing its lender.",
    );
  }
  await assertNoActiveDealUnwind(ctx, app.orgId, app._id);
  for (const quote of [original, replacement]) {
    await assertNoPendingDepositRequest(ctx, {
      orgId: app.orgId,
      quoteId: quote._id,
      action: "change the lender",
    });
    await assertNoQuoteLinkedReservationDeposit(ctx, quote);
  }
  const [originalDeposit, replacementDeposit, payment, forward, fee, custody, originalSale, replacementSale] =
    await Promise.all([
      ctx.db
        .query("deposits")
        .withIndex("by_quote", (q) => q.eq("quoteId", original._id))
        .first(),
      ctx.db
        .query("deposits")
        .withIndex("by_quote", (q) => q.eq("quoteId", replacement._id))
        .first(),
      ctx.db
        .query("customerFinanceCompanyPayments")
        .withIndex("by_org_application", (q) =>
          q.eq("orgId", app.orgId).eq("applicationId", app._id),
        )
        .first(),
      ctx.db
        .query("financeCompanyForwards")
        .withIndex("by_org_application", (q) =>
          q.eq("orgId", app.orgId).eq("applicationId", app._id),
        )
        .first(),
      ctx.db
        .query("financeDealFees")
        .withIndex("by_application", (q) => q.eq("applicationId", app._id))
        .first(),
      ctx.db
        .query("financeDealCustody")
        .withIndex("by_application", (q) => q.eq("applicationId", app._id))
        .first(),
      ctx.db
        .query("sales")
        .withIndex("by_quote", (q) => q.eq("quoteId", original._id))
        .first(),
      ctx.db
        .query("sales")
        .withIndex("by_quote", (q) => q.eq("quoteId", replacement._id))
        .first(),
    ]);
  if (
    originalDeposit ||
    replacementDeposit ||
    payment ||
    forward ||
    fee ||
    custody ||
    originalSale ||
    replacementSale
  ) {
    throw new ConvexError(
      "Review the deal’s existing payment records before changing its lender.",
    );
  }
}

export async function validateReplacementQuote(
  ctx: QueryCtx,
  { app, original, replacement }: AgreementQuotes,
) {
  assertCurrentQuote(replacement);
  if (
    !replacement.companyId ||
    replacement.companyId === app.companyId ||
    replacement._id === app.quoteId ||
    replacement.mode !== "CONFIGURED_FINANCE_COMPANY" ||
    replacement.status !== "ACCEPTED" ||
    replacement.vehicleId !== app.vehicleId ||
    replacement.customerId !== app.customerId ||
    replacement.downPayment !== 0 ||
    (replacement.vehicleItems?.length ?? 1) !== 1 ||
    (replacement.vehicleItems?.[0] &&
      replacement.vehicleItems[0].vehicleId !== app.vehicleId)
  ) {
    throw new ConvexError(
      "Select an accepted quote from the new lender for the same customer and vehicle, with no first payment.",
    );
  }
  const lender = await requireOwnedRow(
    ctx,
    app.orgId,
    "financeCompanies",
    replacement.companyId,
  );
  const vehicle = await requireOwnedRow(
    ctx,
    app.orgId,
    "vehicles",
    app.vehicleId,
  );
  if (!lender.isActive)
    throw new ConvexError("Choose an active finance company.");
  assertQuotableVehicle(vehicle);
  if (isConsignedAgentSale(vehicle)) {
    throw new ConvexError(
      "A supplier-financed vehicle requires separate settlement review before changing the lender.",
    );
  }
  const usedQuote = await ctx.db
    .query("financeApplications")
    .withIndex("by_org_quote", (q) =>
      q.eq("orgId", app.orgId).eq("quoteId", replacement._id),
    )
    .first();
  if (usedQuote)
    throw new ConvexError(
      "This quote is already attached to a finance application.",
    );
  assertCurrentQuote(original);
  const currency = app.economicsCurrency;
  if (
    original.customerId !== app.customerId ||
    original.vehicleId !== app.vehicleId ||
    original.companyId !== app.companyId ||
    !currency ||
    replacement.customerQuotePricingSnapshot?.currency !== currency
  )
    throw new ConvexError(
      "The quotes do not match this deal’s recorded customer, vehicle and currency.",
    );
  const companyRuleSnapshot = resolveCreationRuleSnapshot(replacement, lender);
  const economics = resolveCreationEconomicsInputs({
    quote: replacement,
    companyRuleSnapshot,
    currency,
  });
  if (economics.targetSellingAmountMinor !== app.targetSellingAmountMinor) {
    throw new ConvexError(
      "The replacement lender quote must keep the agreed vehicle price.",
    );
  }
  return { lender, companyRuleSnapshot, economics };
}

export async function refreshLenderEvidence(
  ctx: MutationCtx,
  app: Doc<"financeApplications">,
  lender: Doc<"financeCompanies">,
  now: number,
) {
  const [appraisals, rules, documents] = await Promise.all([
    ctx.db
      .query("financeAppraisals")
      .withIndex("by_application", (q) => q.eq("applicationId", app._id))
      .take(101),
    ctx.db
      .query("companyDocumentRules")
      .withIndex("by_company", (q) => q.eq("companyId", lender._id))
      .take(101),
    ctx.db
      .query("applicationDocuments")
      .withIndex("by_application", (q) => q.eq("applicationId", app._id))
      .take(101),
  ]);
  if (
    appraisals.length > 100 ||
    rules.length > 100 ||
    documents.length > 100 ||
    [...appraisals, ...rules, ...documents].some(
      (row) => row.orgId !== app.orgId,
    )
  ) {
    throw new ConvexError(
      "Review the deal’s appraisal and document records before changing its lender.",
    );
  }
  const assigned = new Set(documents.map((document) => document.ruleId));
  for (const rule of rules) {
    if (assigned.has(rule._id)) {
      throw new ConvexError(
        "A document from the replacement lender is already on this deal and needs review.",
      );
    }
    await ctx.db.insert("applicationDocuments", {
      orgId: app.orgId,
      applicationId: app._id,
      ruleId: rule._id,
      status: "MISSING",
    });
  }
  for (const appraisal of appraisals) {
    if (
      appraisal.providerType !== "DEALER_ESTIMATE" &&
      (appraisal.status === "RECORDED" || appraisal.status === "APPROVED")
    ) {
      await ctx.db.patch(appraisal._id, {
        status: "SUPERSEDED",
        supersededAt: now,
      });
    }
  }
}

/** Advance the quote on the current root, retaining its original finance claim. */
export async function adoptLenderCorrectionQuote(
  ctx: MutationCtx,
  app: Doc<"financeApplications">,
  replacement: Doc<"quotes">,
): Promise<void> {
  const ownership = await resolveOwnership(ctx, app.orgId, app.vehicleId);
  const root = ownership.kind === "OWNED" ? ownership.root : null;
  const pointer = app.currentCommitmentClaims?.find(
    ({ vehicleId }) => vehicleId === app.vehicleId,
  );
  const claim = pointer && (await ctx.db.get(pointer.claimId));
  if (
    !root ||
    root.orgId !== app.orgId ||
    root.vehicleId !== app.vehicleId ||
    root.headQuoteId !== app.quoteId ||
    root.customerId !== app.customerId ||
    !claim ||
    claim.orgId !== app.orgId ||
    claim.rootId !== root._id ||
    claim.vehicleId !== app.vehicleId ||
    claim.applicationId !== app._id ||
    claim.evidenceKind !== "FINANCE" ||
    claim.status !== "ACTIVE" ||
    replacement.orgId !== app.orgId ||
    replacement.vehicleId !== app.vehicleId ||
    replacement.customerId !== app.customerId ||
    replacement.supersededAt !== undefined
  ) {
    throw new ConvexError(
      "The vehicle commitment cannot be verified for this correction.",
    );
  }
  await ctx.db.patch(root._id, { headQuoteId: replacement._id });
}
