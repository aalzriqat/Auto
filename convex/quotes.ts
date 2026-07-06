import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { advanceLeadStage } from "./utils/leadStageHelpers";
import { notifyUser, getActorName } from "./utils/notifications";

const quoteModeValidator = v.optional(v.union(
  v.literal("CASH"),
  v.literal("CONFIGURED_FINANCE_COMPANY"),
  v.literal("MANUAL_FINANCE_COMPANY"),
  v.literal("INTERNAL_INSTALLMENT"),
  v.literal("LEASE"),
));

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
    // When set (2+ vehicles, or several units of the same model), this is the
    // authoritative source for which vehicles/prices are on the quote —
    // vehicleId/vehiclePrice below are derived server-side from it and the
    // client-supplied values for them are ignored.
    vehicleItems: v.optional(v.array(v.object({
      vehicleId: v.id("vehicles"),
      unitPrice: v.number(),
    }))),
    companyId: v.optional(v.id("financeCompanies")),
    mode: quoteModeValidator,
    leadId: v.optional(v.id("leads")),
    vehiclePrice: v.number(),
    downPayment: v.number(),
    termMonths: v.number(),
    totalFinancedAmount: v.optional(v.number()),
    monthlyInstallment: v.optional(v.number()),
    profitRateApplied: v.optional(v.number()),
    totalProfit: v.optional(v.number()),
    recipientName: v.optional(v.string()),
    manualProviderName: v.optional(v.string()),
    manualProfitRate: v.optional(v.number()),
    manualInsuranceRate: v.optional(v.number()),
    manualAdminFees: v.optional(v.number()),
    manualCommission: v.optional(v.number()),
    manualIncludesCommissionInDebt: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    // A quote is an informational financing draft, not a committed sale —
    // gated to VIEW_SALES (held by SALES/MANAGER/ACCOUNTANT/OWNER) rather
    // than CREATE_SALES, which is reserved for finalizing an actual sale.
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    const customer = await ctx.db.get(args.customerId);
    if (!customer || customer.orgId !== args.orgId) {
      throw new ConvexError("Customer not found in this organization.");
    }

    let vehicleId = args.vehicleId;
    let vehiclePrice = args.vehiclePrice;

    if (args.vehicleItems && args.vehicleItems.length > 0) {
      const seen = new Set<string>();
      for (const item of args.vehicleItems) {
        if (item.unitPrice <= 0) {
          throw new ConvexError("Each vehicle in the quote must have a positive price.");
        }
        if (seen.has(item.vehicleId)) {
          throw new ConvexError("The same vehicle cannot be added twice to a quote.");
        }
        seen.add(item.vehicleId);
        const lineVehicle = await ctx.db.get(item.vehicleId);
        if (!lineVehicle || lineVehicle.orgId !== args.orgId) {
          throw new ConvexError("Vehicle not found in this organization.");
        }
      }
      vehicleId = args.vehicleItems[0].vehicleId;
      vehiclePrice = args.vehicleItems.reduce((sum, item) => sum + item.unitPrice, 0);
    } else {
      const vehicle = await ctx.db.get(args.vehicleId);
      if (!vehicle || vehicle.orgId !== args.orgId) {
        throw new ConvexError("Vehicle not found in this organization.");
      }
    }

    if (args.mode === "CONFIGURED_FINANCE_COMPANY" && !args.companyId) {
      throw new ConvexError("Configured finance company quotes require a finance company.");
    }

    if (args.mode !== undefined && args.mode !== "CONFIGURED_FINANCE_COMPANY" && args.companyId) {
      throw new ConvexError("Finance company can only be set for configured finance company quotes.");
    }

    if (args.companyId) {
      const company = await ctx.db.get(args.companyId);
      if (!company || company.orgId !== args.orgId) {
        throw new ConvexError("Finance company not found in this organization.");
      }
    }

    if (args.leadId) {
      const lead = await ctx.db.get(args.leadId);
      if (!lead || lead.orgId !== args.orgId) {
        throw new ConvexError("Lead not found in this organization.");
      }
      if (lead.customerId !== args.customerId || (lead.vehicleId && lead.vehicleId !== vehicleId)) {
        throw new ConvexError("Lead does not match the quote customer and vehicle.");
      }
    }

    const {
      manualProviderName,
      manualProfitRate,
      manualInsuranceRate,
      manualAdminFees,
      manualCommission,
      manualIncludesCommissionInDebt,
      ...quoteArgs
    } = args;

    return await ctx.db.insert("quotes", {
      ...quoteArgs,
      vehicleId,
      vehiclePrice,
      ...(args.mode === "MANUAL_FINANCE_COMPANY" && manualProviderName !== undefined ? { manualProviderName } : {}),
      ...(args.mode === "MANUAL_FINANCE_COMPANY" && manualProfitRate !== undefined ? { manualProfitRate } : {}),
      ...(args.mode === "MANUAL_FINANCE_COMPANY" && manualInsuranceRate !== undefined ? { manualInsuranceRate } : {}),
      ...(args.mode === "MANUAL_FINANCE_COMPANY" && manualAdminFees !== undefined ? { manualAdminFees } : {}),
      ...(args.mode === "MANUAL_FINANCE_COMPANY" && manualCommission !== undefined ? { manualCommission } : {}),
      ...(args.mode === "MANUAL_FINANCE_COMPANY" && manualIncludesCommissionInDebt !== undefined ? { manualIncludesCommissionInDebt } : {}),
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
