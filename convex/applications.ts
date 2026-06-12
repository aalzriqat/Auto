import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";

export const list = query({
  args: {
    orgId: v.id("organizations"),
    status: v.optional(v.string()), // DRAFT, PENDING_DOCS, etc.
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]); // Reusing sales permission for now

    let pageResult;
    if (args.status) {
      pageResult = await ctx.db
        .query("financeApplications")
        .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", args.status as any))
        .paginate(args.paginationOpts);
    } else {
      pageResult = await ctx.db
        .query("financeApplications")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .paginate(args.paginationOpts);
    }

    // Enrich
    const page = await Promise.all(
      pageResult.page.map(async (app) => {
        const customer = await ctx.db.get(app.customerId);
        const vehicle = await ctx.db.get(app.vehicleId);
        const company = app.companyId ? await ctx.db.get(app.companyId) : null;
        const salesperson = await ctx.db.get(app.salespersonId);
        const quote = await ctx.db.get(app.quoteId);

        return {
          ...app,
          customerName: customer ? `${customer.firstName} ${customer.lastName}` : "Unknown",
          vehicleDesc: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : "Unknown",
          companyName: company ? company.name : "Cash / Direct",
          salespersonName: salesperson && "name" in salesperson ? salesperson.name : "Unknown",
          financedAmount: quote?.totalFinancedAmount || 0,
          monthlyInstallment: quote?.monthlyInstallment || 0,
        };
      })
    );

    return { ...pageResult, page };
  },
});

export const get = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    const app = await ctx.db.get(args.applicationId);
    if (!app || app.orgId !== args.orgId) return null;

    const customer = await ctx.db.get(app.customerId);
    const vehicle = await ctx.db.get(app.vehicleId);
    const company = app.companyId ? await ctx.db.get(app.companyId) : null;
    const salesperson = await ctx.db.get(app.salespersonId);
    const quote = await ctx.db.get(app.quoteId);

    return {
      ...app,
      customer,
      vehicle,
      company,
      salesperson,
      quote,
    };
  },
});

export const createFromQuote = mutation({
  args: {
    orgId: v.id("organizations"),
    quoteId: v.id("quotes"),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_SALES]);

    const quote = await ctx.db.get(args.quoteId);
    if (!quote || quote.orgId !== args.orgId) {
      throw new ConvexError("Quote not found.");
    }

    // Check if application already exists for this quote
    const existing = await ctx.db
      .query("financeApplications")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("quoteId"), args.quoteId))
      .first();

    if (existing) {
      throw new ConvexError("An application already exists for this quote.");
    }

    const appId = await ctx.db.insert("financeApplications", {
      orgId: args.orgId,
      quoteId: quote._id,
      customerId: quote.customerId,
      vehicleId: quote.vehicleId,
      companyId: quote.companyId,
      salespersonId: auth.user._id,
      status: "PENDING_DOCS",
      notes: args.notes,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Automatically assign required documents based on rules
    const rules = await ctx.db
      .query("companyDocumentRules")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    for (const rule of rules) {
      // If rule applies to ALL companies, or exactly to this quote's company
      if (!rule.companyId || rule.companyId === quote.companyId) {
        await ctx.db.insert("applicationDocuments", {
          orgId: args.orgId,
          applicationId: appId,
          ruleId: rule._id,
          status: "MISSING",
        });
      }
    }

    const actorName = await getActorName(ctx);
    const customer = await ctx.db.get(quote.customerId);

    await notifyManagers(
      ctx,
      args.orgId,
      "New Finance Application",
      `${actorName} submitted a new finance application for ${customer?.firstName} ${customer?.lastName}`,
      `/applications/${appId}`
    );

    return appId;
  },
});

export const updateStatus = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    status: v.union(
      v.literal("DRAFT"),
      v.literal("PENDING_DOCS"),
      v.literal("UNDER_REVIEW"),
      v.literal("APPROVED"),
      v.literal("REJECTED")
    ),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId);
    const hasView = auth.role.permissions.includes(PERMISSIONS.VIEW_SALES);
    if (!hasView) {
      throw new ConvexError("Forbidden: Missing required permissions.");
    }

    const app = await ctx.db.get(args.applicationId);
    if (!app || app.orgId !== args.orgId) {
      throw new ConvexError("Application not found");
    }

    let approvedBy = app.approvedBy;
    let approvedAt = app.approvedAt;

    if (args.status === "APPROVED" && app.status !== "APPROVED") {
      // Verify permissions for approval
      await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_SETTINGS]); // Only managers can approve
      approvedBy = auth.user._id;
      approvedAt = Date.now();
    }

    await ctx.db.patch(args.applicationId, {
      status: args.status,
      updatedAt: Date.now(),
      approvedBy,
      approvedAt,
    });
  },
});

export const finalizeDeal = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId);
    const hasView = auth.role.permissions.includes(PERMISSIONS.VIEW_SALES);
    if (!hasView) {
      throw new ConvexError("Forbidden: Missing required permissions.");
    }

    const app = await ctx.db.get(args.applicationId);
    if (!app || app.orgId !== args.orgId) throw new ConvexError("Application not found");
    if (app.status !== "APPROVED") throw new ConvexError("Application must be APPROVED before finalizing");

    const quote = await ctx.db.get(app.quoteId);
    if (!quote) throw new ConvexError("Quote not found");

    const vehicle = await ctx.db.get(app.vehicleId);
    if (!vehicle) throw new ConvexError("Vehicle not found");

    // Close the application
    await ctx.db.patch(args.applicationId, {
      status: "CLOSED",
      updatedAt: Date.now(),
    });

    // Mark vehicle as sold
    await ctx.db.patch(app.vehicleId, {
      status: "SOLD",
      updatedAt: Date.now(),
      updatedBy: auth.user._id,
    });

    // Create the sale record
    await ctx.db.insert("sales", {
      orgId: args.orgId,
      branchId: vehicle.branchId, // Associate sale with the vehicle's branch
      vehicleId: app.vehicleId,
      customerId: app.customerId,
      salespersonId: app.salespersonId,
      salePrice: quote.vehiclePrice,
      saleDate: Date.now(),
      status: "COMPLETED",
      downPayment: quote.downPayment,
      financingType: app.companyId ? "FINANCED" : "CASH",
      loanAmount: quote.totalFinancedAmount,
      termMonths: quote.termMonths,
    });

    return true;
  },
});
