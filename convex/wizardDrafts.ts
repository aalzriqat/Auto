import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { wizardDraftDataValidator } from "./wizardDraftData";

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
    wizardData: wizardDraftDataValidator,
    selectedCustomerId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);
    const vehicleReferences = args.wizardData.vehicleItems?.map(item => item.vehicleId) ?? [];
    if (args.wizardData.vehicleId) vehicleReferences.push(args.wizardData.vehicleId);
    for (const reference of vehicleReferences) {
      const id = ctx.db.normalizeId("vehicles", reference);
      if (!id) throw new ConvexError("Record not found in this organization.");
      await requireOwnedRow(ctx, args.orgId, "vehicles", id);
    }
    if (args.wizardData.leadId) {
      const id = ctx.db.normalizeId("leads", args.wizardData.leadId);
      if (!id) throw new ConvexError("Record not found in this organization.");
      await requireOwnedRow(ctx, args.orgId, "leads", id);
    }
    if (args.selectedCustomerId) {
      const id = ctx.db.normalizeId("customers", args.selectedCustomerId);
      if (!id) throw new ConvexError("Record not found in this organization.");
      await requireOwnedRow(ctx, args.orgId, "customers", id);
    }
    if (args.wizardData.selectedCompanyId && args.wizardData.selectedCompanyId !== "OTHER") {
      const id = ctx.db.normalizeId("financeCompanies", args.wizardData.selectedCompanyId);
      if (!id) throw new ConvexError("Record not found in this organization.");
      await requireOwnedRow(ctx, args.orgId, "financeCompanies", id);
    }
    for (const reference of args.wizardData.customerStatuses ?? []) {
      const id = ctx.db.normalizeId("orgCustomerStatuses", reference);
      if (!id) throw new ConvexError("Record not found in this organization.");
      await requireOwnedRow(ctx, args.orgId, "orgCustomerStatuses", id);
    }
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
