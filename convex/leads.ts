import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyManagers, notifyUser, getActorName } from "./utils/notifications";
import { checkTenantWriteLimit } from "./rateLimit";
import {
  MAX_NOTE_LENGTH,
  recordLeadActivity,
  recordLeadCreated,
  recordLeadFieldChanges,
} from "./utils/leadActivity";

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

/** A lead panel is a summary, not an inbox — cap the fan-out. */
const MAX_CUSTOMER_MESSAGES = 25;

/**
 * Read-only digest of what the customer actually said, across Instagram and
 * Facebook, for the lead's customer. This is what a salesperson opening a
 * social-generated lead needs first: the lead's `notes` field only ever holds
 * the truncated *first* message, so everything the customer asked afterwards
 * was invisible from the lead.
 *
 * Deliberately separate from `socialInbox.listEventsForCustomer`: that one is
 * gated behind the `socialInbox` plan feature and would throw inside the lead
 * dialog for orgs that don't have it. Reading the messages attached to your
 * own lead is core lead context, not the Social Inbox product.
 *
 * There is no mutation counterpart — inbound customer messages are a record of
 * what was said and are not editable from anywhere in the app.
 */
export const customerMessages = query({
  args: {
    orgId: v.id("organizations"),
    leadId: v.id("leads"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_LEADS]);

    const lead = await requireOwnedRow(
      ctx, args.orgId, "leads", args.leadId, "Lead not found in this organization."
    );

    const [igEvents, fbEvents] = await Promise.all([
      ctx.db
        .query("instagramEvents")
        .withIndex("by_org_customer", (q) =>
          q.eq("orgId", args.orgId).eq("customerId", lead.customerId)
        )
        .collect(),
      ctx.db
        .query("facebookEvents")
        .withIndex("by_org_customer", (q) =>
          q.eq("orgId", args.orgId).eq("customerId", lead.customerId)
        )
        .collect(),
    ]);

    const merged = [
      ...igEvents.map((ev) => ({ platform: "instagram" as const, ev })),
      ...fbEvents.map((ev) => ({ platform: "facebook" as const, ev })),
    ]
      .filter(({ ev }) => Boolean(ev.text?.trim()))
      .sort((a, b) => b.ev._creationTime - a.ev._creationTime);

    return {
      total: merged.length,
      // An auto-reply is not an answer — a canned "thanks, we'll be in touch"
      // shouldn't make a question look handled, so only a manual reply counts.
      unansweredCount: merged.filter(({ ev }) => !ev.manualRepliedAt).length,
      messages: merged.slice(0, MAX_CUSTOMER_MESSAGES).map(({ platform, ev }) => ({
        id: ev._id,
        platform,
        kind: ev.kind,
        text: ev.text as string,
        createdAt: ev._creationTime,
        autoRepliedAt: ev.autoRepliedAt ?? null,
        manualRepliedAt: ev.manualRepliedAt ?? null,
      })),
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

    await recordLeadCreated(ctx, {
      orgId: args.orgId,
      leadId: id,
      actorUserId: user._id,
      stage: args.stage ?? "NEW",
      assignedUserId: args.assignedUserId,
      source: args.source.trim(),
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

    // Diff before patching, while `lead` still holds the old values. The count
    // is the number of fields that actually moved — the edit dialog resubmits
    // every field on every save, so `patch` being non-empty says nothing about
    // whether anything changed. Gating on real changes keeps both the audit
    // trail and the manager notification free of no-op saves.
    const changeCount = await recordLeadFieldChanges(ctx, {
      orgId: args.orgId,
      leadId: args.leadId,
      before: lead,
      patch,
      actorUserId: user._id,
    });

    if (changeCount > 0) {
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
 * Appends a salesperson's progress update to the lead's trail.
 *
 * This is the replacement for editing the single `notes` field over and over:
 * each update is its own immutable row, so "called twice, no answer" from
 * Tuesday is still there after Thursday's "customer wants a test drive". There
 * is intentionally no edit or delete counterpart — a follow-up log that can be
 * rewritten after the fact answers no question worth asking.
 */
export const addNote = mutation({
  args: {
    orgId: v.id("organizations"),
    leadId: v.id("leads"),
    note: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_LEADS]);

    const note = args.note.trim();
    if (!note) {
      throw new ConvexError("Update cannot be empty.");
    }
    if (note.length > MAX_NOTE_LENGTH) {
      throw new ConvexError(`Update must be ${MAX_NOTE_LENGTH} characters or fewer.`);
    }

    const lead = await requireOwnedRow(
      ctx, args.orgId, "leads", args.leadId, "Lead not found in this organization."
    );
    if (lead.isDeleted) {
      throw new ConvexError("Lead not found in this organization.");
    }

    const statusLimit = await checkTenantWriteLimit(ctx, "create", args.orgId);
    if (!statusLimit.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    await recordLeadActivity(ctx, {
      orgId: args.orgId,
      leadId: args.leadId,
      action: "NOTE",
      actorUserId: user._id,
      note,
    });

    // The lead's own timestamp moves too, so "last touched" on the list stays
    // honest for a rep who is following up without changing any field.
    await ctx.db.patch(args.leadId, { updatedAt: Date.now(), updatedBy: user._id });
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

    // Appended, not cleared: the trail outlives the lead so a restore brings
    // back the full history, and so a deletion is itself answerable for.
    await recordLeadActivity(ctx, {
      orgId: args.orgId,
      leadId: args.leadId,
      action: "DELETED",
      actorUserId: user._id,
      field: "stage",
      fromValue: lead.stage,
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
