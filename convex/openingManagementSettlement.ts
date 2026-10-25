import { loadOpeningSourceIdentity } from "./utils/openingSourceIdentity";
import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { requireFeature } from "./subscriptions";
import { getOrgCurrency } from "./accounting/workflowHooks";
import { denominationOf } from "./utils/money";
import { runWithIdempotency } from "./utils/idempotency";
import { managementInstallments, monthStart } from "./utils/openingManagementSchedule";
import { requireManagementOpening } from "./utils/openingManagementBasis";
import { computeIncomeStatement } from "./accountingReports";

const attestation = v.literal("CONSUMED_BEFORE_OPENING_NOT_PREPAID_NOT_CAPITAL");
async function requireCurrency(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">, expected: string) {
  const currency = denominationOf(await getOrgCurrency(ctx, orgId));
  if (currency?.code !== expected) throw new ConvexError("The management schedule currency is unavailable or has changed.");
  return currency.code;
}

export const draft = mutation({
  args: { orgId: v.id("organizations"), openingDraftId: v.id("openingBalanceDrafts"), totalMinor: v.number(),
    firstEffectiveMonth: v.number(), supportingReference: v.string(), classificationAttestation: attestation,
    expectedCurrency: v.string(), idempotencyKey: v.string() },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    const currency = await requireCurrency(ctx, args.orgId, args.expectedCurrency);
    const reference = args.supportingReference.trim();
    if (!reference || reference.length > 200) throw new ConvexError("Enter a bounded supporting reference for this management schedule.");
    const installments = managementInstallments(args.totalMinor, args.firstEffectiveMonth);
    return runWithIdempotency(ctx, { orgId: args.orgId, operation: "openingManagementSettlement.draft", economic: true,
      idempotencyKey: args.idempotencyKey, actorId: user._id,
      fingerprint: JSON.stringify({ openingDraftId: args.openingDraftId, totalMinor: args.totalMinor,
        firstEffectiveMonth: args.firstEffectiveMonth, supportingReference: reference,
        classificationAttestation: args.classificationAttestation, currency }) }, async () => {
      const { parent, resetGeneration } = await requireManagementOpening(ctx, args.orgId, args.openingDraftId, currency);
      if (args.firstEffectiveMonth < monthStart(parent.asOfDate)) throw new ConvexError("The management schedule cannot start before its opening.");
      for (const status of ["PENDING_APPROVAL", "APPROVED"] as const) {
        const existing = await ctx.db.query("openingManagementSettlementPlans").withIndex("by_org_opening_status", (q) =>
          q.eq("orgId", args.orgId).eq("openingDraftId", args.openingDraftId).eq("status", status)).first();
        if (existing) throw new ConvexError("This opening already has a management settlement plan.");
      }
      return ctx.db.insert("openingManagementSettlementPlans", { orgId: args.orgId, openingDraftId: args.openingDraftId,
        status: "PENDING_APPROVAL", currency, totalMinor: args.totalMinor, supportingReference: reference,
        classificationAttestation: args.classificationAttestation, installments, createdBy: user._id, createdAt: Date.now(), resetGeneration });
    });
  },
});

export const approve = mutation({
  args: { orgId: v.id("organizations"), planId: v.id("openingManagementSettlementPlans") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    const plan = await requireOwnedRow(ctx, args.orgId, "openingManagementSettlementPlans", args.planId, "Management schedule unavailable.");
    if (plan.status !== "PENDING_APPROVAL") throw new ConvexError("This management schedule has already been resolved.");
    if (plan.createdBy === user._id) throw new ConvexError("The management schedule approver must differ from its preparer.");
    await requireCurrency(ctx, args.orgId, plan.currency);
    const basis = await requireManagementOpening(ctx, args.orgId, plan.openingDraftId, plan.currency);
    if (basis.resetGeneration !== plan.resetGeneration) throw new ConvexError("This management schedule belongs to an earlier opening generation.");
    const first = plan.installments[0];
    if (!first || first.effectiveMonth < monthStart(basis.parent.asOfDate)) throw new ConvexError("The management schedule opening date is unavailable.");
    const expected = managementInstallments(plan.totalMinor, first.effectiveMonth);
    if (plan.installments.length !== 7 || !expected.every((row, index) => {
      const stored = plan.installments[index];
      return stored?.sequence === row.sequence && stored.effectiveMonth === row.effectiveMonth &&
        stored.amountMinor === row.amountMinor && stored.recognitionMonth === undefined;
    })) {
      throw new ConvexError("The management schedule economics are unavailable.");
    }
    const now = Date.now();
    const approvalMonth = monthStart(now);
    const periods = await ctx.db.query("accountingPeriods").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).collect();
    const installments = plan.installments.map((installment) => {
      const target = Math.max(installment.effectiveMonth, approvalMonth);
      const eligible = periods.filter((period) => (period.status === "OPEN" || period.status === "FUTURE") && period.endDate >= target)
        .sort((a, b) => a.startDate - b.startDate);
      const period = eligible[0];
      if (!period) throw new ConvexError("Create an open or future accounting period for every management installment.");
      return { ...installment, recognitionMonth: Math.max(target, monthStart(period.startDate)) };
    });
    await ctx.db.patch(plan._id, { status: "APPROVED", approvedBy: user._id, approvedAt: now, installments });
    return plan._id;
  },
});

export const reject = mutation({
  args: { orgId: v.id("organizations"), planId: v.id("openingManagementSettlementPlans") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const plan = await requireOwnedRow(ctx, args.orgId, "openingManagementSettlementPlans", args.planId, "Management schedule unavailable.");
    if (plan.status !== "PENDING_APPROVAL") throw new ConvexError("This management schedule has already been resolved.");
    await ctx.db.patch(plan._id, { status: "REJECTED", rejectedBy: user._id, rejectedAt: Date.now() });
  },
});

export const list = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    return ctx.db.query("openingManagementSettlementPlans").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).collect();
  },
});
export const report = query({
  args: { orgId: v.id("organizations"), planId: v.id("openingManagementSettlementPlans"), throughDate: v.number() },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    if (!Number.isSafeInteger(args.throughDate) || args.throughDate < 0 || args.throughDate > Date.now()) {
      throw new ConvexError("Choose a valid management report date no later than today.");
    }
    const plan = await requireOwnedRow(ctx, args.orgId, "openingManagementSettlementPlans", args.planId, "Management schedule unavailable.");
    if (plan.status !== "APPROVED" || plan.approvedAt === undefined || plan.installments.length !== 7) {
      throw new ConvexError("This management schedule is not approved.");
    }
    await requireCurrency(ctx, args.orgId, plan.currency);
    const { parent, resetGeneration } = await requireManagementOpening(ctx, args.orgId, plan.openingDraftId, plan.currency);
    if (resetGeneration !== plan.resetGeneration) throw new ConvexError("This management schedule belongs to an earlier opening generation.");
    const first = plan.installments[0];
    if (!first || first.effectiveMonth < monthStart(parent.asOfDate)) throw new ConvexError("The approved management schedule is unavailable.");
    const expected = managementInstallments(plan.totalMinor, first.effectiveMonth);
    const statement = args.throughDate < parent.asOfDate ? null : await computeIncomeStatement(ctx, {
      orgId: args.orgId, fromDate: parent.asOfDate, toDate: args.throughDate,
    });
    const officialNetIncomeMinor = statement?.netIncome ?? 0;
    let recognisedMinor = 0;
    let total = 0;
    const approvedAt = plan.approvedAt;
    const installments = plan.installments.map((row, index) => {
      if (row.sequence !== index + 1 || row.effectiveMonth !== expected[index].effectiveMonth || row.amountMinor !== expected[index].amountMinor ||
          !Number.isSafeInteger(row.amountMinor) || row.amountMinor < 0 ||
          row.recognitionMonth === undefined || !Number.isSafeInteger(row.recognitionMonth) || row.recognitionMonth < row.effectiveMonth) {
        throw new ConvexError("The approved management schedule is unavailable.");
      }
      total += row.amountMinor;
      const recognised = approvedAt <= args.throughDate && row.recognitionMonth <= args.throughDate;
      if (recognised) recognisedMinor += row.amountMinor;
      return { ...row, recognitionMonth: row.recognitionMonth, recognition: recognised ? "RECOGNISED" as const : "SCHEDULED" as const };
    });
    if (total !== plan.totalMinor || !Number.isSafeInteger(total) || !Number.isSafeInteger(officialNetIncomeMinor) ||
        !Number.isSafeInteger(officialNetIncomeMinor - recognisedMinor)) throw new ConvexError("The management reconciliation is unavailable.");
    return { currency: plan.currency, throughDate: args.throughDate, openingDate: parent.asOfDate,
      officialNetIncomeMinor, recognisedMinor, managementProfitMinor: officialNetIncomeMinor - recognisedMinor,
      installments, basis: "NATIVE_GL_INCOME_STATEMENT" as const, distributionAvailable: false as const };
  },
});
export const context = query({
  args: { orgId: v.id("organizations") },
  returns: v.object({
    actorId: v.id("users"),
    postedOpening: v.union(v.null(), v.object({
      id: v.id("openingBalanceDrafts"),
      asOfDate: v.number(),
      currency: v.string(),
    })),
  }),
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    const source = await loadOpeningSourceIdentity(ctx, args.orgId);
    const parent = source.parent;
    const currency = denominationOf(parent?.currency);
    if (!parent || !currency) return { actorId: user._id, postedOpening: null };
    try {
      await requireManagementOpening(ctx, args.orgId, parent._id, currency.code);
      return { actorId: user._id, postedOpening: { id: parent._id, asOfDate: parent.asOfDate, currency: currency.code } };
    } catch {
      // This query makes no writes. Missing proof is unavailable, never an opening certificate.
      return { actorId: user._id, postedOpening: null };
    }
  },
});
