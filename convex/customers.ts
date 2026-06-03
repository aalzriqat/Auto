import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

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

    return await ctx.db.insert("customers", {
      orgId: args.orgId,
      firstName: args.firstName.trim(),
      lastName: args.lastName.trim(),
      phone: args.phone?.trim(),
      whatsapp: args.whatsapp?.trim(),
      email: normalizedEmail,
      nationalId: args.nationalId?.trim(),
      address: args.address?.trim(),
    });
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

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.customerId, patch);
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
  },
});
