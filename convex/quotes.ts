import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { advanceLeadStage } from "./utils/leadStageHelpers";
import { notifyUser, getActorName } from "./utils/notifications";

export const listQuotesByCustomer = query({
  args: { 
    orgId: v.id("organizations"),
    customerId: v.id("customers") 
  },
  handler: async (ctx, { orgId, customerId }) => {
    await requireTenantAuth(ctx, orgId, [PERMISSIONS.VIEW_CUSTOMERS]);
    return await ctx.db
      .query("quotes")
      .withIndex("by_customer", (q) => q.eq("customerId", customerId))
      .filter((q) => q.eq(q.field("orgId"), orgId))
      .collect();
  },
});

export const get = query({
  args: {
    orgId: v.id("organizations"),
    quoteId: v.id("quotes"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_CUSTOMERS]);
    const quote = await ctx.db.get(args.quoteId);
    if (!quote || quote.orgId !== args.orgId) {
      throw new ConvexError("Quote not found.");
    }
    return quote;
  },
});

export const saveQuote = mutation({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    vehicleId: v.id("vehicles"),
    companyId: v.optional(v.id("financeCompanies")),
    leadId: v.optional(v.id("leads")),
    vehiclePrice: v.number(),
    downPayment: v.number(),
    termMonths: v.number(),
    totalFinancedAmount: v.optional(v.number()),
    monthlyInstallment: v.optional(v.number()),
    profitRateApplied: v.optional(v.number()),
    totalProfit: v.optional(v.number()),
    recipientName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // A quote is an informational financing draft, not a committed sale —
    // gated to VIEW_SALES (held by SALES/MANAGER/ACCOUNTANT/OWNER) rather
    // than CREATE_SALES, which is reserved for finalizing an actual sale.
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    if (args.leadId) {
      const lead = await ctx.db.get(args.leadId);
      if (!lead || lead.orgId !== args.orgId) {
        throw new ConvexError("Lead not found in this organization.");
      }
    }

    return await ctx.db.insert("quotes", {
      ...args,
      status: "DRAFT",
      createdBy: user._id,
      createdAt: Date.now(),
    });
  },
});

export const updateQuoteStatus = mutation({
  args: {
    orgId: v.id("organizations"),
    quoteId: v.id("quotes"),
    status: v.union(v.literal("DRAFT"), v.literal("SHARED"), v.literal("ACCEPTED"), v.literal("EXPIRED")),
  },
  handler: async (ctx, { orgId, quoteId, status }) => {
    await requireTenantAuth(ctx, orgId, [PERMISSIONS.VIEW_SALES]);
    const existing = await ctx.db.get(quoteId);
    if (!existing || existing.orgId !== orgId) throw new ConvexError("Not found");

    await ctx.db.patch(quoteId, { status });

    if (status === "SHARED" && existing.leadId) {
      await advanceLeadStage(ctx, { leadId: existing.leadId, targetStage: "NEGOTIATION" });
    }

    if (status === "ACCEPTED") {
      const vehicle = await ctx.db.get(existing.vehicleId);
      const actorName = await getActorName(ctx);
      await notifyUser(
        ctx,
        orgId,
        existing.createdBy,
        "quote.accepted",
        {
          actorName,
          quoteLabel: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : "the quote",
        },
        { link: `/${orgId}/customers?highlightId=${existing.customerId}` }
      );
    }
  },
});
