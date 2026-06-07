import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * Lists all customers for an organization.
 */
export const list = query({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_CUSTOMERS]);

    return await ctx.db
      .query("customers")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
  },
});

/**
 * Gets a single customer by ID. Verifies they belong to the caller's org.
 */
export const get = query({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_CUSTOMERS]);

    const customer = await ctx.db.get(args.customerId);
    if (!customer || customer.orgId !== args.orgId) {
      throw new ConvexError("Customer not found in this organization.");
    }

    return customer;
  },
});

/**
 * Searches for a customer by email within the organization.
 */
export const getByEmail = query({
  args: {
    orgId: v.id("organizations"),
    email: v.string(),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_CUSTOMERS]);

    return await ctx.db
      .query("customers")
      .withIndex("by_org_email", (q) =>
        q.eq("orgId", args.orgId).eq("email", args.email.toLowerCase().trim())
      )
      .unique();
  },
});

// ─── Mutations ───────────────────────────────────────────────────────────────

/**
 * Creates a new customer record in the organization.
 */
export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    firstName: v.string(),
    lastName: v.string(),
    phone: v.optional(v.string()),
    whatsapp: v.optional(v.string()),
    email: v.optional(v.string()),
    nationalId: v.optional(v.string()),
    address: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_CUSTOMERS]);

    const normalizedEmail = args.email?.toLowerCase().trim() || undefined;

    // If email is provided, check for duplicates within the org
    if (normalizedEmail) {
      const existing = await ctx.db
        .query("customers")
        .withIndex("by_org_email", (q) =>
          q.eq("orgId", args.orgId).eq("email", normalizedEmail)
        )
        .unique();

      if (existing) {
        throw new ConvexError(
          `A customer with email "${normalizedEmail}" already exists in this organization.`
        );
      }
    }

    const id = await ctx.db.insert("customers", {
      orgId: args.orgId,
      firstName: args.firstName.trim(),
      lastName: args.lastName.trim(),
      phone: args.phone?.trim(),
      whatsapp: args.whatsapp?.trim(),
      email: normalizedEmail,
      nationalId: args.nationalId?.trim(),
      address: args.address?.trim(),
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "New Customer Added",
      `${actorName} added a new customer: ${args.firstName.trim()} ${args.lastName.trim()}`,
      `/customers?highlightId=${id}`
    );

    return id;
  },
});

/**
 * Updates an existing customer's details.
 */
export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    phone: v.optional(v.string()),
    whatsapp: v.optional(v.string()),
    email: v.optional(v.string()),
    nationalId: v.optional(v.string()),
    address: v.optional(v.string()),
    employment: v.optional(
      v.object({
        employer: v.string(),
        title: v.optional(v.string()),
        salary: v.number(),
        hireDate: v.optional(v.number()),
      })
    ),
    financials: v.optional(
      v.object({
        totalMonthlyDebt: v.number(),
        dbr: v.optional(v.number()),
      })
    ),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_CUSTOMERS]);

    const customer = await ctx.db.get(args.customerId);
    if (!customer || customer.orgId !== args.orgId) {
      throw new ConvexError("Customer not found in this organization.");
    }

    // If email is being changed, check for duplicates
    if (args.email !== undefined) {
      const normalizedEmail = args.email.toLowerCase().trim();
      if (normalizedEmail !== customer.email) {
        const existing = await ctx.db
          .query("customers")
          .withIndex("by_org_email", (q) =>
            q.eq("orgId", args.orgId).eq("email", normalizedEmail)
          )
          .unique();

        if (existing) {
          throw new ConvexError(
            `A customer with email "${normalizedEmail}" already exists in this organization.`
          );
        }
      }
    }

    const patch: Record<string, unknown> = {};
    if (args.firstName !== undefined) patch.firstName = args.firstName.trim();
    if (args.lastName !== undefined) patch.lastName = args.lastName.trim();
    if (args.phone !== undefined) patch.phone = args.phone.trim();
    if (args.whatsapp !== undefined) patch.whatsapp = args.whatsapp.trim();
    if (args.email !== undefined) patch.email = args.email.toLowerCase().trim();
    if (args.nationalId !== undefined) patch.nationalId = args.nationalId.trim();
    if (args.address !== undefined) patch.address = args.address.trim();
    if (args.employment !== undefined) patch.employment = args.employment;
    if (args.financials !== undefined) patch.financials = args.financials;

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.customerId, patch);
      
      const actorName = await getActorName(ctx);
      await notifyManagers(
        ctx,
        args.orgId,
        "Customer Updated",
        `${actorName} updated details for ${customer.firstName} ${customer.lastName}`,
        `/customers?highlightId=${args.customerId}`
      );
    }
  },
});

/**
 * Deletes a customer. Fails if the customer has any associated leads or sales.
 */
export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.DELETE_CUSTOMERS]);

    const customer = await ctx.db.get(args.customerId);
    if (!customer || customer.orgId !== args.orgId) {
      throw new ConvexError("Customer not found in this organization.");
    }

    // Check for associated leads
    const lead = await ctx.db
      .query("leads")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("customerId"), args.customerId))
      .first();

    if (lead) {
      throw new ConvexError(
        "Cannot delete this customer — they have associated leads. Delete the leads first."
      );
    }

    // Check for associated sales
    const sale = await ctx.db
      .query("sales")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("customerId"), args.customerId))
      .first();

    if (sale) {
      throw new ConvexError(
        "Cannot delete this customer — they have associated sales records."
      );
    }

    await ctx.db.delete(args.customerId);

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "Customer Deleted",
      `${actorName} deleted customer ${customer.firstName} ${customer.lastName}`
    );
  },
});

export const getRelations = query({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_CUSTOMERS]);

    // 1. Fetch Sales
    const sales = await ctx.db
      .query("sales")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("customerId"), args.customerId))
      .collect();

    const enrichedSales = await Promise.all(
      sales.map(async (sale) => {
        const vehicle = await ctx.db.get(sale.vehicleId);
        const salesperson = await ctx.db.get(sale.salespersonId as any);
        return {
          ...sale,
          vehicleDesc: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : "Unknown",
          salespersonName: salesperson && "name" in salesperson ? salesperson.name : "Unknown",
        };
      })
    );

    // 2. Fetch Leads
    const leads = await ctx.db
      .query("leads")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("customerId"), args.customerId))
      .collect();

    const enrichedLeads = await Promise.all(
      leads.map(async (lead) => {
        const vehicle = lead.vehicleId ? await ctx.db.get(lead.vehicleId) : null;
        const assignedUser = lead.assignedUserId ? await ctx.db.get(lead.assignedUserId as any) : null;
        return {
          ...lead,
          vehicleDesc: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : "Any",
          assignedUserName: assignedUser && "name" in assignedUser ? assignedUser.name : "Unassigned",
        };
      })
    );

    // 3. Fetch Tasks
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("customerId"), args.customerId))
      .collect();

    const enrichedTasks = await Promise.all(
      tasks.map(async (task) => {
        const assignedUser = await ctx.db.get(task.assignedTo as any);
        return {
          ...task,
          assignedUserName: assignedUser && "name" in assignedUser ? assignedUser.name : "Unknown",
        };
      })
    );

    // 4. Fetch Quotes
    const quotes = await ctx.db
      .query("quotes")
      .withIndex("by_customer", (q) => q.eq("customerId", args.customerId))
      .filter((q) => q.eq(q.field("orgId"), args.orgId))
      .collect();

    const enrichedQuotes = await Promise.all(
      quotes.map(async (quote) => {
        const vehicle = await ctx.db.get(quote.vehicleId);
        const company = quote.companyId ? await ctx.db.get(quote.companyId) : null;
        return {
          ...quote,
          vehicleDesc: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : "Unknown",
          companyName: company ? company.name : "Cash Deal",
        };
      })
    );

    return {
      sales: enrichedSales.sort((a, b) => b.saleDate - a.saleDate),
      leads: enrichedLeads.sort((a, b) => b._creationTime - a._creationTime),
      tasks: enrichedTasks.sort((a, b) => a.dueDate - b.dueDate),
      quotes: enrichedQuotes.sort((a, b) => b.createdAt - a.createdAt),
    };
  },
});
