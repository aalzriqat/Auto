import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";

const wizardDataValidator = v.object({
  vehicleId: v.string(),
  vehiclePrice: v.number(),
  desiredProfit: v.number(),
  downPayment: v.number(),
  termMonths: v.number(),
  selectedCompanyId: v.optional(v.string()),
  manualProfitRate: v.optional(v.number()),
  manualInsuranceRate: v.optional(v.number()),
  manualExecutionCommission: v.optional(v.number()),
  manualExecutionFees: v.optional(v.number()),
  recipientName: v.optional(v.string()),
});

export const getMyDraft = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);
    return await ctx.db
      .query("wizardDrafts")
      .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", user._id))
      .first();
  },
});

export const saveDraft = mutation({
  args: {
    orgId: v.id("organizations"),
    paymentType: v.string(),
    currentStep: v.number(),
    wizardData: wizardDataValidator,
    selectedCustomerId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);
    const existing = await ctx.db
      .query("wizardDrafts")
      .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", user._id))
      .first();

    const data = {
      orgId: args.orgId,
      userId: user._id,
      paymentType: args.paymentType,
      currentStep: args.currentStep,
      wizardData: args.wizardData,
      selectedCustomerId: args.selectedCustomerId,
      savedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, data);
    } else {
      await ctx.db.insert("wizardDrafts", data);
    }
  },
});

export const clearDraft = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);
    const existing = await ctx.db
      .query("wizardDrafts")
      .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", user._id))
      .first();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
  },
});
