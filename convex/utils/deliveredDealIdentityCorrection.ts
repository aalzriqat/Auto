import { ConvexError } from "convex/values";
import { acquireVehicle, hasLiveCommitmentBasis, resolveOwnership } from "../commitments";
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
import { GAP_RESOLUTION_CLEARED, shortfallFieldsFor } from "./financingEconomics";
import { requireOwnedRow } from "./tenancy";
import { assertVehicleReadyForSale } from "./vehicleLiveness";
import { isConsignedAgentSale } from "./vehicleOwnership";

export function identityAgreement(app: Doc<"financeApplications">) {
  const agreement = readCorrectableAgreement(app);
  if (!agreement || !app.vehicleHandoverBy || app.pendingLenderCorrectionId !== undefined ||
      app.plannedCustody !== undefined || app.approvedDealerPurchaseAmountMinor === undefined) return null;
  return { ...agreement, handoverBy: app.vehicleHandoverBy, amountMinor: app.approvedDealerPurchaseAmountMinor };
}

export function substitutionKind(
  app: Doc<"financeApplications">, quote: Doc<"quotes">,
): "BUYER" | "VEHICLE" | null {
  const sameBuyer = quote.customerId === app.customerId;
  const sameVehicle = quote.vehicleId === app.vehicleId;
  if (sameBuyer === sameVehicle) return null;
  return sameVehicle ? "BUYER" : "VEHICLE";
}

export async function verifySubstitution(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
  replacement: Doc<"quotes">,
) {
  const kind = substitutionKind(app, replacement);
  if (!kind) throw new ConvexError("Select a quote changing one identity on the deal.");
  const [original, originalVehicle, vehicle, customer] = await Promise.all([
    requireOwnedRow(ctx, app.orgId, "quotes", app.quoteId),
    requireOwnedRow(ctx, app.orgId, "vehicles", app.vehicleId),
    requireOwnedRow(ctx, app.orgId, "vehicles", replacement.vehicleId),
    requireOwnedRow(ctx, app.orgId, "customers", replacement.customerId),
  ]);
  if (customer.isDeleted || vehicle.isDeleted || isConsignedAgentSale(vehicle) ||
      originalVehicle.branchId !== vehicle.branchId ||
      (kind === "VEHICLE" && vehicle.status !== "AVAILABLE")) {
    throw new ConvexError("Select an active buyer and an available dealership vehicle at the same branch.");
  }
  assertVehicleReadyForSale(vehicle);
  await assertNoCurrentAgreementMoney(ctx, { app, original });
  const root = await requireLenderCorrectionCommitment(ctx, app);
  const terms = await validateReplacementQuote(ctx, { app, original, replacement }, kind);
  if (!root.lineageRootId || root.originReservationId || app.currentCommitmentClaims?.length !== 1) {
    throw new ConvexError("This deal’s vehicle commitment needs review before replacement.");
  }
  if (kind === "VEHICLE" && (await resolveOwnership(ctx, app.orgId, vehicle._id)).kind !== "FREE") {
    throw new ConvexError("Choose a replacement vehicle without another active commitment.");
  }
  return { ...terms, kind, root, vehicle, customer };
}

export async function retireOriginalCommitment(
  ctx: MutationCtx,
  app: Doc<"financeApplications">,
  root: Doc<"commitmentRoots">,
  replacementVehicleId: Id<"vehicles">,
  actor: Id<"users">,
  now: number,
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
  await ctx.db.patch(root._id, { status: "RELEASED", closedAt: now, closedReason: "APPROVED_DEAL_SUBSTITUTION" });
}

export async function commitReplacementVehicle(
  ctx: MutationCtx,
  app: Doc<"financeApplications">,
  quote: Doc<"quotes">,
  vehicle: Doc<"vehicles">,
  actor: Id<"users">,
) {
  const root = await acquireVehicle(ctx, {
    orgId: app.orgId, vehicleId: vehicle._id, customerId: quote.customerId, createdBy: actor,
    evidence: { kind: "FINANCE", applicationId: app._id }, lineage: { quoteId: quote._id }, vehicle,
  });
  if (app.vehicleId !== vehicle._id) {
    await ctx.db.patch(app.vehicleId, { status: "IN_INSPECTION" });
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
    underwritingSnapshot: undefined,
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
