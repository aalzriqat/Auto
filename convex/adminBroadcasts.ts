import { v } from "convex/values";
import { query } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { paginationOptsValidator } from "convex/server";
import { internal } from "./_generated/api";
import { requireSuperAdmin } from "./utils/tenancy";
import { notifyAllMembers } from "./utils/notifications";
import { logAdminAction } from "./adminAudit";

/**
 * Sends a platform-wide or single-org announcement. Super-admin-authored
 * text bypasses the bilingual registry (lib/notifications/types.ts) — see
 * the "system.announcement" special case in lib/notifications/render.ts —
 * since this is free-form content typed by an operator, not a translated
 * template.
 */
export const create = mutation({
  args: {
    audience: v.union(v.literal("all_orgs"), v.literal("one_org")),
    orgId: v.optional(v.id("organizations")),
    title: v.string(),
    message: v.string(),
    link: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);

    if (args.audience === "one_org" && !args.orgId) {
      throw new Error("orgId is required when audience is one_org.");
    }

    // `one_org` fans out inline — one org's membership list is bounded by its
    // seat cap, and the caller gets an exact recipient count straight back.
    //
    // `all_orgs` used to do the same thing across every organization in one
    // mutation: collect all orgs, then per org collect all memberships and write
    // a notification per member. That is a hard cliff rather than a slow query —
    // once the platform outgrows a single mutation's budget the mutation throws
    // and every write rolls back, so the feature stops working entirely and no
    // partial broadcast survives to show it was tried. It fans out through a
    // self-paginating scheduled mutation instead, the shape
    // changelog.broadcastNewEntry already uses (and whose comment named this
    // handler as the one still doing it the unbounded way).
    const recipientCount = args.audience === "one_org"
      ? await notifyAllMembers(ctx, args.orgId!, "system.announcement", {
          title: args.title,
          message: args.message,
        }, { link: args.link })
      : 0;

    const broadcastId = await ctx.db.insert("notificationBroadcasts", {
      orgId: args.audience === "one_org" ? args.orgId : undefined,
      title: args.title,
      message: args.message,
      link: args.link,
      createdBy: admin._id,
      createdAt: Date.now(),
      recipientCount,
    });

    if (args.audience === "all_orgs") {
      // Scheduled from inside this mutation, so it is part of the same
      // transaction: if anything below throws, the fan-out never runs either.
      await ctx.scheduler.runAfter(0, internal.adminBroadcasts.fanOutToAllOrgs, {
        broadcastId,
        title: args.title,
        message: args.message,
        link: args.link,
      });
    }

    await logAdminAction(ctx, admin, {
      action: "broadcast:create",
      targetTable: "notificationBroadcasts",
      targetId: broadcastId,
      orgId: args.audience === "one_org" ? args.orgId : undefined,
      after: { audience: args.audience, title: args.title, recipientCount },
    });

    return broadcastId;
  },
});

const BROADCAST_ORG_BATCH_SIZE = 25;

/**
 * Notifies every org's members about a platform-wide broadcast, one page of orgs
 * at a time, self-rescheduling until done. Each page accumulates onto the
 * broadcast row's `recipientCount`, so the admin list shows the count climbing
 * rather than jumping from nothing to a final number — and a run that dies
 * halfway leaves an honest partial figure instead of a silent zero.
 */
export const fanOutToAllOrgs = internalMutation({
  args: {
    broadcastId: v.id("notificationBroadcasts"),
    title: v.string(),
    message: v.string(),
    link: v.optional(v.string()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const broadcast = await ctx.db.get(args.broadcastId);
    // Deleted mid-fan-out: stop rather than keep notifying for a broadcast that
    // no longer exists and has nothing left to accumulate onto.
    if (!broadcast) return { notified: 0, isDone: true };

    const page = await ctx.db
      .query("organizations")
      .paginate({ cursor: args.cursor ?? null, numItems: BROADCAST_ORG_BATCH_SIZE });

    let notified = 0;
    for (const org of page.page) {
      notified += await notifyAllMembers(ctx, org._id, "system.announcement", {
        title: args.title,
        message: args.message,
      }, { link: args.link });
    }

    await ctx.db.patch(args.broadcastId, {
      recipientCount: (broadcast.recipientCount ?? 0) + notified,
    });

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.adminBroadcasts.fanOutToAllOrgs, {
        broadcastId: args.broadcastId,
        title: args.title,
        message: args.message,
        link: args.link,
        cursor: page.continueCursor,
      });
    }

    return { notified, isDone: page.isDone };
  },
});

export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    return await ctx.db
      .query("notificationBroadcasts")
      .withIndex("by_createdAt")
      .order("desc")
      .paginate(args.paginationOpts);
  },
});
