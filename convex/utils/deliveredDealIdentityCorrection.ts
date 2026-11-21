import { ConvexError } from "convex/values";
import {
  acquireVehicle, hasLiveCommitmentBasis, releaseRootForDeliveredIdentityCorrection, resolveOwnership,
} from "../commitments";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { beginUserRun, requireDecisionContext } from "./commitmentKernel";
import {
  assertNoCurrentAgreementMoney,
  readCorrectableAgreement,
  requireLenderCorrectionCommitment,
  validateReplacementQuote,
} from "./deliveredLenderCorrection";
import { syncVehicleHoldStatus } from "./depositHelpers";
import { IN_FLIGHT_FINANCE_STATUSES } from "./financeStatuses";
import { readFinanceUnderwritingSnapshot } from "./financeUnderwritingSnapshot";
import {
  creditDecisionForStatus,
  GAP_RESOLUTION_CLEARED,
  handoverStatusForFacts,
  shortfallFieldsFor,
} from "./financingEconomics";
import { PERMISSIONS } from "./permissions";
import { requireOwnedRow } from "./tenancy";
import { assertVehicleReadyForSale } from "./vehicleLiveness";
import { isConsignedAgentSale } from "./vehicleOwnership";

export const IDENTITY_CORRECTION_PERMISSIONS = [
  PERMISSIONS.APPROVE_FINANCE_APPLICATION,
  PERMISSIONS.VIEW_FINANCE,
  PERMISSIONS.VIEW_FINANCE_APPLICATIONS,
];

export function requiredCorrectionText(value: string) {
  const text = value.trim();
  if (text.length === 0 || text.length > 500) {
    throw new ConvexError("Enter a reference or reason of up to 500 characters.");
  }
  return text;
}

export function labelForIdentity(kind: "BUYER" | "VEHICLE", buyer: Doc<"customers">, vehicle: Doc<"vehicles">) {
  return kind === "BUYER"
    ? [buyer.firstName, buyer.lastName].filter(Boolean).join(" ")
    : [vehicle.make, vehicle.model, vehicle.year].filter(Boolean).join(" ");
}

export async function replacementIdentityOptions(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
  kind: "BUYER" | "VEHICLE",
  cursor: string | undefined,
  originalDeal: Awaited<ReturnType<typeof readOriginalIdentityDeal>>,
) {
  const { orgId } = app;
  const quotes = kind === "BUYER"
    ? ctx.db.query("quotes").withIndex("by_org_vehicle_status", (q) =>
      q.eq("orgId", orgId).eq("vehicleId", app.vehicleId).eq("status", "ACCEPTED"))
    : ctx.db.query("quotes").withIndex("by_org_customer_status", (q) =>
      q.eq("orgId", orgId).eq("customerId", app.customerId).eq("status", "ACCEPTED"));
  const page = await quotes.order("desc").paginate({ cursor: cursor ?? null, numItems: 8 });
  const options: { quoteId: Doc<"quotes">["_id"]; label: string; quotedAt: number }[] = [];
  for (const quote of page.page) {
    if (quote.supersededAt !== undefined || quote.companyId !== app.companyId ||
        (kind === "BUYER" ? quote.customerId === app.customerId : quote.vehicleId === app.vehicleId)) continue;
    try {
      const candidate = await verifySubstitution(ctx, app, quote, originalDeal);
      options.push({ quoteId: quote._id, label: labelForIdentity(candidate.kind, candidate.customer, candidate.vehicle),
        quotedAt: quote.createdAt });
    } catch (error) {
      if (!(error instanceof ConvexError)) throw error;
    }
  }
  return { options, nextCursor: page.isDone ? undefined : page.continueCursor };
}

export function identityAgreement(app: Doc<"financeApplications">) {
  const agreement = readCorrectableAgreement(app);
  if (!agreement || !app.vehicleHandoverBy || app.pendingLenderCorrectionId !== undefined ||
      app.plannedCustody !== undefined || app.approvedDealerPurchaseAmountMinor === undefined) return null;
  return { ...agreement, handoverBy: app.vehicleHandoverBy, amountMinor: app.approvedDealerPurchaseAmountMinor };
}

function hasConsistentPreHandoverTerms(app: Doc<"financeApplications">) {
  if (app.submittedQuotationMinor === undefined) {
    return app.appraisalStatus === "NOT_REQUESTED" && app.approvedDealerPurchaseAmountMinor === undefined &&
      app.submittedQuotationAt === undefined && app.submittedQuotationBy === undefined;
  }
  const { submittedQuotationMinor, submittedQuotationAt, submittedQuotationBy, appraisalStatus } = app;
  if (!Number.isSafeInteger(submittedQuotationMinor) || submittedQuotationMinor <= 0 || !submittedQuotationBy ||
      submittedQuotationAt === undefined || !Number.isSafeInteger(submittedQuotationAt) || submittedQuotationAt <= 0 ||
      (appraisalStatus !== "PENDING" && appraisalStatus !== "COMPLETED" && appraisalStatus !== "FINALIZED")) return false;

  const { approvedDealerPurchaseAmountMinor, approvedPurchaseApprovedAt, approvedPurchaseApprovedBy } = app;
  if (approvedDealerPurchaseAmountMinor === undefined) {
    return approvedPurchaseApprovedAt === undefined && approvedPurchaseApprovedBy === undefined && appraisalStatus !== "FINALIZED";
  }
  return Number.isSafeInteger(approvedDealerPurchaseAmountMinor) && approvedDealerPurchaseAmountMinor > 0 &&
    Boolean(app.approvedPurchaseBasis && approvedPurchaseApprovedBy) &&
    approvedPurchaseApprovedAt !== undefined && Number.isSafeInteger(approvedPurchaseApprovedAt) &&
    approvedPurchaseApprovedAt >= submittedQuotationAt;
}

export function canCorrectIdentityBeforeHandover(app: Doc<"financeApplications">) {
  const creditApproved = app.status === "APPROVED";
  const hasValidCreditHistory = creditApproved
    ? app.approvedBy !== undefined && app.approvedAt !== undefined &&
      Number.isSafeInteger(app.approvedAt) && app.approvedAt > 0
    : app.approvedBy === undefined && app.approvedAt === undefined;
  return (creditApproved || app.status === "PENDING_DOCS" || app.status === "UNDER_REVIEW") &&
    hasValidCreditHistory && app.creditDecision === creditDecisionForStatus(app.status) &&
    hasConsistentPreHandoverTerms(app) && app.settlementStatus === "NOT_READY" &&
    app.handoverStatus === handoverStatusForFacts(app) && app.vehicleHandoverAt === undefined &&
    app.vehicleHandoverBy === undefined && app.vehicleHandoverNotes === undefined &&
    app.firstPaymentEvidenceChecked === undefined && app.finalizedSaleId === undefined &&
    app.pendingIdentityCorrectionId === undefined && app.approvedIdentityCorrectionId === undefined &&
    app.pendingLenderCorrectionId === undefined && app.approvedLenderCorrectionId === undefined &&
    app.pendingFirstPaymentEvidenceCorrectionId === undefined && app.plannedCustody === undefined &&
    app.approvedPurchaseCorrectedAfterHandoverAt === undefined &&
    app.customerFirstPaymentMinor === 0 &&
    Boolean(app.dealId && app.dealNumber && app.companyId) &&
    app.quoteModeAtSubmission === "CONFIGURED_FINANCE_COMPANY" &&
    (app.vehicleItems?.length ?? 1) === 1 &&
    (app.vehicleItems?.[0] === undefined || app.vehicleItems[0].vehicleId === app.vehicleId);
}

export function substitutionKind(
  app: Doc<"financeApplications">, quote: Doc<"quotes">,
): "BUYER" | "VEHICLE" | null {
  const sameBuyer = quote.customerId === app.customerId;
  const sameVehicle = quote.vehicleId === app.vehicleId;
  if (sameBuyer === sameVehicle) return null;
  return sameVehicle ? "BUYER" : "VEHICLE";
}

export async function readOriginalIdentityDeal(ctx: QueryCtx, app: Doc<"financeApplications">) {
  const [original, originalVehicle, root] = await Promise.all([
    requireOwnedRow(ctx, app.orgId, "quotes", app.quoteId),
    requireOwnedRow(ctx, app.orgId, "vehicles", app.vehicleId),
    requireLenderCorrectionCommitment(ctx, app),
  ]);
  if (!root.lineageRootId || root.originReservationId || app.currentCommitmentClaims?.length !== 1) {
    throw new ConvexError("This deal’s vehicle commitment needs review before replacement.");
  }
  await assertNoCurrentAgreementMoney(ctx, { app, original });
  return { original, originalVehicle, root };
}

export async function verifySubstitution(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
  replacement: Doc<"quotes">,
  { original, originalVehicle, root }: Awaited<ReturnType<typeof readOriginalIdentityDeal>>,
) {
  const kind = substitutionKind(app, replacement);
  if (!kind) throw new ConvexError("Select a quote changing one identity on the deal.");
  const [vehicle, customer] = await Promise.all([
    requireOwnedRow(ctx, app.orgId, "vehicles", replacement.vehicleId),
    requireOwnedRow(ctx, app.orgId, "customers", replacement.customerId),
  ]);
  if (customer.isDeleted || vehicle.isDeleted || isConsignedAgentSale(vehicle) ||
      originalVehicle.branchId !== vehicle.branchId ||
      (kind === "VEHICLE" && vehicle.status !== "AVAILABLE")) {
    throw new ConvexError("Select an active buyer and an available dealership vehicle at the same branch.");
  }
  assertVehicleReadyForSale(vehicle);
  const terms = await validateReplacementQuote(ctx, { app, original, replacement }, kind);
  if (kind === "VEHICLE" && (await resolveOwnership(ctx, app.orgId, vehicle._id)).kind !== "FREE") {
    throw new ConvexError("Choose a replacement vehicle without another active commitment.");
  }
  return { ...terms, kind, root, vehicle, customer };
}

export async function replacementIdentityPatch(
  ctx: QueryCtx,
  quote: Doc<"quotes">,
  terms: Awaited<ReturnType<typeof verifySubstitution>>,
) {
  const version = terms.companyRuleSnapshot?.ruleVersion;
  const companyRule = version === undefined ? null : await ctx.db.query("financeCompanyRuleVersions")
    .withIndex("by_company_version", (q) => q.eq("companyId", terms.lender._id).eq("version", version)).first();
  const underwritingSnapshot = await readFinanceUnderwritingSnapshot(ctx, terms.customer, quote, terms.lender._id);
  return {
    quoteId: quote._id,
    customerId: terms.customer._id,
    vehicleId: terms.vehicle._id,
    vehicleItems: quote.vehicleItems,
    customerQuotePricingSnapshot: quote.customerQuotePricingSnapshot,
    underwritingSnapshot,
    companyRuleSnapshot: terms.companyRuleSnapshot,
    companyRuleVersionId: companyRule?._id,
    targetSellingAmountMinor: terms.economics.targetSellingAmountMinor,
    targetNetProceedsMinor: terms.economics.targetSellingAmountMinor,
    customerFirstPaymentMinor: terms.economics.customerFirstPaymentMinor,
    estimatedDealerBorneExpensesMinor: terms.economics.dealerBorneExpensesMinor,
    estimatedClosingExpensesMinor: terms.economics.dealerBorneExpensesMinor,
  } satisfies Partial<Doc<"financeApplications">>;
}

export async function retireOriginalCommitment(
  ctx: MutationCtx,
  { app, root, replacementVehicleId, actor, now }: {
    app: Doc<"financeApplications">;
    root: Doc<"commitmentRoots">;
    replacementVehicleId: Id<"vehicles">;
    actor: Id<"users">;
    now: number;
  },
) {
  const decision = await requireDecisionContext(ctx, beginUserRun(actor, now), app.orgId);
  const [claims, applications, otherBasis] = await Promise.all([
    ctx.db.query("vehicleCommitmentClaims").withIndex("by_root_status", (q) =>
      q.eq("rootId", root._id).eq("status", "ACTIVE")).take(2),
    ctx.db.query("financeApplications").withIndex("by_vehicle", (q) =>
      q.eq("vehicleId", app.vehicleId)).take(101),
    hasLiveCommitmentBasis(ctx, {
      orgId: app.orgId, vehicleId: app.vehicleId, decisionNow: now, decision,
      exactDepositReader: true, excludeKinds: ["FINANCE"],
    }),
  ]);
  if (otherBasis || claims.length !== 1 || claims[0]._id !== app.currentCommitmentClaims?.[0]?.claimId ||
      applications.length > 100 || applications.some((other) =>
        other.orgId === app.orgId && other._id !== app._id && IN_FLIGHT_FINANCE_STATUSES.includes(other.status))) {
    throw new ConvexError("Another commitment still holds the original vehicle.");
  }
  if (replacementVehicleId !== app.vehicleId && await hasLiveCommitmentBasis(ctx, {
    orgId: app.orgId, vehicleId: replacementVehicleId, decisionNow: now, decision, exactDepositReader: true,
  })) {
    throw new ConvexError("Another commitment still holds the replacement vehicle.");
  }
  await releaseRootForDeliveredIdentityCorrection(ctx, { app, root, now });
}

export async function commitReplacementVehicle(
  ctx: MutationCtx,
  { app, quote, vehicle, actor, originalWasDelivered }: {
    app: Doc<"financeApplications">;
    quote: Doc<"quotes">;
    vehicle: Doc<"vehicles">;
    actor: Id<"users">;
    originalWasDelivered: boolean;
  },
) {
  const root = await acquireVehicle(ctx, {
    orgId: app.orgId, vehicleId: vehicle._id, customerId: quote.customerId, createdBy: actor,
    evidence: { kind: "FINANCE", applicationId: app._id }, lineage: { quoteId: quote._id }, vehicle,
  });
  if (app.vehicleId !== vehicle._id) {
    if (originalWasDelivered) {
      await ctx.db.patch(app.vehicleId, { status: "IN_INSPECTION", preHoldStatus: undefined });
    } else {
      await syncVehicleHoldStatus(ctx, app.vehicleId, actor, { hasHold: false });
    }
  }
  await syncVehicleHoldStatus(ctx, vehicle._id, actor, { hasHold: true });
  return root.rootId;
}

export async function archiveIdentityEvidence(ctx: MutationCtx, app: Doc<"financeApplications">, now: number) {
  const [documents, appraisals] = await Promise.all([
    ctx.db.query("applicationDocuments").withIndex("by_application", (q) => q.eq("applicationId", app._id)).take(101),
    ctx.db.query("financeAppraisals").withIndex("by_application", (q) => q.eq("applicationId", app._id)).take(101),
  ]);
  if (documents.length > 100 || appraisals.length > 100 ||
      [...documents, ...appraisals].some((row) => row.orgId !== app.orgId)) {
    throw new ConvexError("The previous documents and appraisals need review before replacement.");
  }
  for (const document of documents) {
    if (document.supersededAt === undefined) await ctx.db.patch(document._id, { supersededAt: now });
  }
  for (const appraisal of appraisals) {
    if (appraisal.status === "RECORDED" || appraisal.status === "APPROVED") {
      await ctx.db.patch(appraisal._id, { status: "SUPERSEDED", supersededAt: now });
    }
  }
}

export function clearedIdentityEvidence() {
  return {
    approvedBy: undefined,
    approvedAt: undefined,
    vehiclePurchaseCostMinor: undefined,
    dealerEstimateMinor: undefined,
    quotationBufferMinor: undefined,
    appliedLtvPercent: undefined,
    submittedQuotationMinor: undefined,
    submittedQuotationSource: undefined,
    submittedQuotationOverrideReason: undefined,
    submittedQuotationAt: undefined,
    submittedQuotationBy: undefined,
    quotationCalculationSnapshot: undefined,
    quoteFirstPaymentCorrectedMinor: undefined,
    approvedDealerPurchaseAmountMinor: undefined,
    approvedPurchaseBasis: undefined,
    approvedPurchaseAppraisalId: undefined,
    approvedPurchaseExceptionRuleVersion: undefined,
    approvedPurchaseApprovedBy: undefined,
    approvedPurchaseApprovedAt: undefined,
    approvedPurchaseCorrectedAfterHandoverAt: undefined,
    approvedPurchaseNotes: undefined,
    financeCompanyFundedPortionMinor: undefined,
    unfinancedPortionMinor: undefined,
    dealerContributionMinor: undefined,
    dealerContributionSettlement: undefined,
    customerContributionToFinanceCompanyMinor: undefined,
    customerContributionSettlement: undefined,
    customerGapToFinanceCompanyAppliedMinor: undefined,
    customerGapToFinanceCompanyUnconfirmedMinor: undefined,
    customerFinancingPrincipalMinor: undefined,
    expectedDealerRemittanceMinor: undefined,
    rawAppraisalGapMinor: undefined,
    ...shortfallFieldsFor(undefined),
    gapResolution: undefined,
    ...GAP_RESOLUTION_CLEARED,
    vehicleHandoverAt: undefined,
    vehicleHandoverBy: undefined,
    vehicleHandoverNotes: undefined,
    firstPaymentEvidenceChecked: undefined,
  } satisfies Partial<Doc<"financeApplications">>;
}
