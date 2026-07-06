import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyManagers, notifyUser, getActorName } from "./utils/notifications";
import { checkTenantWriteLimit } from "./rateLimit";

// ─── Validators ──────────────────────────────────────────────────────────────

import { LEAD_STAGES } from "./constants";

const leadStage = v.union(
  v.literal(LEAD_STAGES[0]),
  v.literal(LEAD_STAGES[1]),
  v.literal(LEAD_STAGES[2]),
  v.literal(LEAD_STAGES[3]),
  v.literal(LEAD_STAGES[4]),
  v.literal(LEAD_STAGES[5]),
  v.literal(LEAD_STAGES[6]),
  v.literal(LEAD_STAGES[7])
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
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_LEADS]);

    let pageResult;

    if (args.stage) {
      pageResult = await ctx.db
        .query("leads")
        .withIndex("by_org_stage", (q) =>
          q.eq("orgId", args.orgId).eq("stage", args.stage!)
        )
        .filter((q) => q.neq(q.field("isDeleted"), true))
        .paginate(args.paginationOpts);
    } else if (args.assignedUserId) {
      pageResult = await ctx.db
        .query("leads")
        .withIndex("by_org_assigned", (q) =>
          q.eq("orgId", args.orgId).eq("assignedUserId", args.assignedUserId!)
        )
        .filter((q) => q.neq(q.field("isDeleted"), true))
        .paginate(args.paginationOpts);
    } else {
      pageResult = await ctx.db
        .query("leads")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .filter((q) => q.neq(q.field("isDeleted"), true))
        .paginate(args.paginationOpts);
    }

    // Hydrate with customer and vehicle names
    const page = await Promise.all(
      pageResult.page.map(async (lead) => {
        const customer = await ctx.db.get(lead.customerId);
        const vehicle = lead.vehicleId ? await ctx.db.get(lead.vehicleId) : null;
        const assignedUser = lead.assignedUserId
          ? await ctx.db.get(lead.assignedUserId)
          : null;
        const createdByUser = lead.createdBy ? await ctx.db.get(lead.createdBy) : null;
        const updatedByUser = lead.updatedBy ? await ctx.db.get(lead.updatedBy) : null;

        return {
          ...lead,
          customerName: customer
            ? `${customer.firstName} ${customer.lastName}`
            : "Unknown",
          email: customer?.email,
          phone: customer?.phone,
          vehicleSummary: vehicle
            ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`
            : null,
          vehiclePrice: vehicle?.sellingPrice ?? null,
          assignedUserName: assignedUser?.name ?? assignedUser?.email ?? null,
          createdByName: createdByUser?.name ?? createdByUser?.email ?? null,
          updatedByName: updatedByUser?.name ?? updatedByUser?.email ?? null,
        };
      })
    );
    
    return { ...pageResult, page };
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
    if (!lead || lead.isDeleted || lead.orgId !== args.orgId) {
      throw new ConvexError("Lead not found in this organization.");
    }

    const customer = await ctx.db.get(lead.customerId);
    const vehicle = lead.vehicleId ? await ctx.db.get(lead.vehicleId) : null;
    const assignedUser = lead.assignedUserId
      ? await ctx.db.get(lead.assignedUserId)
      : null;
    const createdByUser = lead.createdBy ? await ctx.db.get(lead.createdBy) : null;
    const updatedByUser = lead.updatedBy ? await ctx.db.get(lead.updatedBy) : null;

    return {
      ...lead,
      customer,
      vehicle,
      assignedUser: assignedUser
        ? { _id: assignedUser._id, name: assignedUser.name, email: assignedUser.email }
        : null,
      createdByName: createdByUser?.name ?? createdByUser?.email ?? null,
      updatedByName: updatedByUser?.name ?? updatedByUser?.email ?? null,
    };
  },
});

/**
 * Pre-submit check for an existing open lead for the same customer (and,
 * if given, the same vehicle). Non-blocking — a returning customer or a
 * re-engagement after LOST is legitimate, so this only powers a UI nudge,
 * never a hard block.
 */
export const checkExistingOpenLead = query({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    vehicleId: v.optional(v.id("vehicles")),
    excludeLeadId: v.optional(v.id("leads")),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_LEADS]);

    const candidates = await ctx.db
      .query("leads")
      .withIndex("by_org_customer", (q) => q.eq("orgId", args.orgId).eq("customerId", args.customerId))
      .filter((q) => q.neq(q.field("isDeleted"), true))
      .collect();

    const openLead = candidates.find(
      (lead) =>
        lead._id !== args.excludeLeadId &&
        lead.stage !== "WON" &&
        lead.stage !== "LOST" &&
        (args.vehicleId ? lead.vehicleId === args.vehicleId : true)
    );

    return openLead ?? null;
  },
});

/**
 * For a WON lead, finds the sale that closed it. Sales created since the
 * quote/lead FK threading was added stamp `leadId` directly, so this is
 * looked up via the `by_lead` index first. Sales that predate that change
 * (or were created without ever going through a quote) fall back to the
 * older customerId+vehicleId match that `closeLeadsAsWon` also used to rely on.
 */
export const getLinkedSale = query({
  args: { orgId: v.id("organizations"), leadId: v.id("leads") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_LEADS]);

    const lead = await ctx.db.get(args.leadId);
    if (!lead || lead.orgId !== args.orgId) {
      throw new ConvexError("Lead not found in this organization.");
    }
    if (lead.stage !== "WON" || !lead.vehicleId) return null;

    const linkedSale = await ctx.db
      .query("sales")
      .withIndex("by_lead", (q) => q.eq("leadId", args.leadId))
      .filter((q) => q.neq(q.field("isDeleted"), true))
      .first();
    if (linkedSale) return linkedSale;

    const sale = await ctx.db
      .query("sales")
      .withIndex("by_org_customer", (q) => q.eq("orgId", args.orgId).eq("customerId", lead.customerId))
      .filter((q) =>
        q.and(
          q.eq(q.field("vehicleId"), lead.vehicleId),
          q.neq(q.field("isDeleted"), true)
        )
      )
      .first();

    return sale;
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
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_LEADS]);

    const statusLimit = await checkTenantWriteLimit(ctx, "create", args.orgId);
    if (!statusLimit.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

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

    const id = await ctx.db.insert("leads", {
      orgId: args.orgId,
      customerId: args.customerId,
      assignedUserId: args.assignedUserId,
      vehicleId: args.vehicleId,
      source: args.source.trim(),
      stage: args.stage ?? "NEW",
      notes: args.notes,
      createdBy: user._id,
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "lead.created",
      { actorName },
      { link: `/${args.orgId}/leads?highlightId=${id}` }
    );

    if (args.assignedUserId) {
      await notifyUser(
        ctx,
        args.orgId,
        args.assignedUserId,
        "lead.assigned",
        { actorName },
        { link: `/${args.orgId}/leads?highlightId=${id}` }
      );
    }

    return id;
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
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_LEADS]);

    const lead = await ctx.db.get(args.leadId);
    if (!lead || lead.isDeleted || lead.orgId !== args.orgId) {
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
      patch.updatedAt = Date.now();
      patch.updatedBy = user._id;
      await ctx.db.patch(args.leadId, patch);

      const actorName = await getActorName(ctx);
      await notifyManagers(
        ctx,
        args.orgId,
        "lead.updated",
        { actorName },
        { link: `/${args.orgId}/leads?highlightId=${args.leadId}` }
      );

      // If re-assigned to a new user
      if (args.assignedUserId && args.assignedUserId !== lead.assignedUserId) {
        await notifyUser(
          ctx,
          args.orgId,
          args.assignedUserId,
          "lead.assigned",
          { actorName },
          { link: `/${args.orgId}/leads?highlightId=${args.leadId}` }
        );
      }
    }
  },
});

/**
 * Soft deletes a lead.
 */
// TODO: Add admin recovery endpoint if needed
export const softDelete = mutation({
  args: {
    orgId: v.id("organizations"),
    leadId: v.id("leads"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.DELETE_LEADS]);
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Unauthenticated");

    const lead = await ctx.db.get(args.leadId);
    if (!lead || lead.isDeleted || lead.orgId !== args.orgId) {
      throw new ConvexError("Lead not found in this organization.");
    }

    await ctx.db.patch(args.leadId, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: identity.subject
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "lead.deleted",
      { actorName }
    );
  },
});
