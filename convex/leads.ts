import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

// ─── Validators ──────────────────────────────────────────────────────────────

const leadStage = v.union(
  v.literal("NEW"),
  v.literal("CONTACTED"),
  v.literal("INTERESTED"),
  v.literal("TEST_DRIVE"),
  v.literal("NEGOTIATION"),
  v.literal("RESERVED"),
  v.literal("WON"),
  v.literal("LOST")
);

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * Lists leads for an organization.
 * Optionally filters by stage or assigned user.
 */
export const list = query({
  args: {
    orgId: v.id("organizations"),
    stage: v.optional(leadStage),
    assignedUserId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_LEADS]);

    let results;

    if (args.stage) {
      results = await ctx.db
        .query("leads")
        .withIndex("by_org_stage", (q) =>
          q.eq("orgId", args.orgId).eq("stage", args.stage!)
        )
        .collect();
    } else if (args.assignedUserId) {
      results = await ctx.db
        .query("leads")
        .withIndex("by_org_assigned", (q) =>
          q.eq("orgId", args.orgId).eq("assignedUserId", args.assignedUserId!)
        )
        .collect();
    } else {
      results = await ctx.db
        .query("leads")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .collect();
    }

    // Hydrate with customer and vehicle names
    return await Promise.all(
      results.map(async (lead) => {
        const customer = await ctx.db.get(lead.customerId);
        const vehicle = lead.vehicleId ? await ctx.db.get(lead.vehicleId) : null;
        const assignedUser = lead.assignedUserId
          ? await ctx.db.get(lead.assignedUserId)
          : null;

        return {
          ...lead,
          customerName: customer
            ? `${customer.firstName} ${customer.lastName}`
            : "Unknown",
          vehicleSummary: vehicle
            ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`
            : null,
          assignedUserName: assignedUser?.name ?? assignedUser?.email ?? null,
        };
      })
    );
  },
});

/**
 * Gets a single lead by ID, fully hydrated with related data.
 */
export const get = query({
  args: {
    orgId: v.id("organizations"),
    leadId: v.id("leads"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_LEADS]);

    const lead = await ctx.db.get(args.leadId);
    if (!lead || lead.orgId !== args.orgId) {
      throw new ConvexError("Lead not found in this organization.");
    }

    const customer = await ctx.db.get(lead.customerId);
    const vehicle = lead.vehicleId ? await ctx.db.get(lead.vehicleId) : null;
    const assignedUser = lead.assignedUserId
      ? await ctx.db.get(lead.assignedUserId)
      : null;

    return {
      ...lead,
      customer,
      vehicle,
      assignedUser: assignedUser
        ? { _id: assignedUser._id, name: assignedUser.name, email: assignedUser.email }
        : null,
    };
  },
});

// ─── Mutations ───────────────────────────────────────────────────────────────

/**
 * Creates a new lead. Validates that the customer and optional vehicle
 * belong to the same organization.
 */
export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    assignedUserId: v.optional(v.id("users")),
    vehicleId: v.optional(v.id("vehicles")),
    source: v.string(),
    stage: v.optional(leadStage),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_LEADS]);

    // Validate customer belongs to this org
    const customer = await ctx.db.get(args.customerId);
    if (!customer || customer.orgId !== args.orgId) {
      throw new ConvexError("Customer not found in this organization.");
    }

    // Validate vehicle belongs to this org (if provided)
    if (args.vehicleId) {
      const vehicle = await ctx.db.get(args.vehicleId);
      if (!vehicle || vehicle.orgId !== args.orgId) {
        throw new ConvexError("Vehicle not found in this organization.");
      }
    }

    // Validate assigned user is a member (if provided)
    if (args.assignedUserId) {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) =>
          q.eq("orgId", args.orgId).eq("userId", args.assignedUserId!)
        )
        .unique();

      if (!membership) {
        throw new ConvexError("Assigned user is not a member of this organization.");
      }
    }

    return await ctx.db.insert("leads", {
      orgId: args.orgId,
      customerId: args.customerId,
      assignedUserId: args.assignedUserId,
      vehicleId: args.vehicleId,
      source: args.source.trim(),
      stage: args.stage ?? "NEW",
      notes: args.notes,
    });
  },
});

/**
 * Updates a lead's details. Validates cross-references on change.
 */
export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    leadId: v.id("leads"),
    customerId: v.optional(v.id("customers")),
    assignedUserId: v.optional(v.id("users")),
    vehicleId: v.optional(v.id("vehicles")),
    source: v.optional(v.string()),
    stage: v.optional(leadStage),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_LEADS]);

    const lead = await ctx.db.get(args.leadId);
    if (!lead || lead.orgId !== args.orgId) {
      throw new ConvexError("Lead not found in this organization.");
    }

    // Validate new customer if changing
    if (args.customerId) {
      const customer = await ctx.db.get(args.customerId);
      if (!customer || customer.orgId !== args.orgId) {
        throw new ConvexError("Customer not found in this organization.");
      }
    }

    // Validate new vehicle if changing
    if (args.vehicleId) {
      const vehicle = await ctx.db.get(args.vehicleId);
      if (!vehicle || vehicle.orgId !== args.orgId) {
        throw new ConvexError("Vehicle not found in this organization.");
      }
    }

    // Validate new assigned user if changing
    if (args.assignedUserId) {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) =>
          q.eq("orgId", args.orgId).eq("userId", args.assignedUserId!)
        )
        .unique();

      if (!membership) {
        throw new ConvexError("Assigned user is not a member of this organization.");
      }
    }

    const patch: Record<string, unknown> = {};
    if (args.customerId !== undefined) patch.customerId = args.customerId;
    if (args.assignedUserId !== undefined) patch.assignedUserId = args.assignedUserId;
    if (args.vehicleId !== undefined) patch.vehicleId = args.vehicleId;
    if (args.source !== undefined) patch.source = args.source.trim();
    if (args.stage !== undefined) patch.stage = args.stage;
    if (args.notes !== undefined) patch.notes = args.notes;

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.leadId, patch);
    }
  },
});

/**
 * Deletes a lead.
 */
export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    leadId: v.id("leads"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.DELETE_LEADS]);

    const lead = await ctx.db.get(args.leadId);
    if (!lead || lead.orgId !== args.orgId) {
      throw new ConvexError("Lead not found in this organization.");
    }

    await ctx.db.delete(args.leadId);
  },
});
