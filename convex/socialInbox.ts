import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query, mutation } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

/**
 * Unifies `instagramEvents` and `facebookEvents` for the Social Inbox UI
 * without touching either platform's own (tested, live) engagement module.
 * Each platform's webhook ingestion stays separate — only the read side
 * merges here, tagging every row with which platform it came from so the
 * UI can dispatch replies to the right action.
 */
type NormalizedEvent = {
  _id: Id<"instagramEvents"> | Id<"facebookEvents">;
  platform: "instagram" | "facebook";
  _creationTime: number;
  kind: "comment" | "dm";
  externalId: string;
  text: string | undefined;
  customerId: Id<"customers"> | undefined;
  leadId: Id<"leads"> | undefined;
  vehicleId: Id<"vehicles"> | undefined;
  postId: string | undefined;
  autoRepliedAt: number | undefined;
  autoReplyText: string | undefined;
  manualReplyText: string | undefined;
  manualRepliedAt: number | undefined;
  manualRepliedByUserId: Id<"users"> | undefined;
  senderRawId: string;
  senderHandle: string | undefined;
};

const PLACEHOLDER_NAMES = new Set(["Instagram Contact", "Facebook Contact"]);

function normalizeInstagramEvent(ev: Doc<"instagramEvents">): NormalizedEvent {
  return {
    _id: ev._id,
    platform: "instagram",
    _creationTime: ev._creationTime,
    kind: ev.kind,
    externalId: ev.externalId,
    text: ev.text,
    customerId: ev.customerId,
    leadId: ev.leadId,
    vehicleId: ev.vehicleId,
    postId: ev.postId,
    autoRepliedAt: ev.autoRepliedAt,
    autoReplyText: ev.autoReplyText,
    manualReplyText: ev.manualReplyText,
    manualRepliedAt: ev.manualRepliedAt,
    manualRepliedByUserId: ev.manualRepliedByUserId,
    senderRawId: ev.senderInstagramId,
    senderHandle: ev.senderUsername,
  };
}

function normalizeFacebookEvent(ev: Doc<"facebookEvents">): NormalizedEvent {
  return {
    _id: ev._id,
    platform: "facebook",
    _creationTime: ev._creationTime,
    kind: ev.kind,
    externalId: ev.externalId,
    text: ev.text,
    customerId: ev.customerId,
    leadId: ev.leadId,
    vehicleId: ev.vehicleId,
    postId: ev.postId,
    autoRepliedAt: ev.autoRepliedAt,
    autoReplyText: ev.autoReplyText,
    manualReplyText: ev.manualReplyText,
    manualRepliedAt: ev.manualRepliedAt,
    manualRepliedByUserId: ev.manualRepliedByUserId,
    senderRawId: ev.senderFacebookId,
    senderHandle: ev.senderName,
  };
}

/** Same resolution order as each platform's own helper: handle, then resolved customer name, then raw ID. */
function resolveSenderDisplayName(event: NormalizedEvent, customer: Doc<"customers"> | null): string {
  if (event.senderHandle) return event.senderHandle;
  if (customer) {
    const name = `${customer.firstName} ${customer.lastName}`.trim();
    if (name && !PLACEHOLDER_NAMES.has(name)) return name;
  }
  return event.senderRawId;
}

/**
 * Paginated, org-wide list of social conversations (Instagram + Facebook)
 * for the Social Inbox page — one row per customer. Grouped by `customerId`
 * rather than `leadId`: lead creation is independently toggleable per
 * platform/event-kind (see `instagramLeadFromCommentsEnabled` etc.), so a
 * conversation may have no lead at all and still needs to show up here.
 */
export const listConversations = query({
  args: { orgId: v.id("organizations"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_LEADS]);

    const [igEvents, fbEvents] = await Promise.all([
      ctx.db
        .query("instagramEvents")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .collect(),
      ctx.db
        .query("facebookEvents")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .collect(),
    ]);
    const allEvents = [...igEvents.map(normalizeInstagramEvent), ...fbEvents.map(normalizeFacebookEvent)];

    const grouped = new Map<Id<"customers">, NormalizedEvent[]>();
    for (const ev of allEvents) {
      if (!ev.customerId) continue;
      const bucket = grouped.get(ev.customerId);
      if (bucket) bucket.push(ev);
      else grouped.set(ev.customerId, [ev]);
    }

    const conversations = Array.from(grouped.entries()).map(([customerId, evs]) => {
      const latest = evs.reduce((a, b) => (b._creationTime > a._creationTime ? b : a));
      const vehicleIds = new Set(evs.filter((e) => e.vehicleId).map((e) => e.vehicleId as Id<"vehicles">));
      const leadId = [...evs].reverse().find((e) => e.leadId)?.leadId;
      return {
        customerId,
        leadId,
        latest,
        eventCount: evs.length,
        needsReply: evs.some((e) => !e.autoRepliedAt && !e.manualRepliedAt),
        vehicleIds,
      };
    });
    conversations.sort((a, b) => b.latest._creationTime - a.latest._creationTime);

    const start = Number(args.paginationOpts.cursor ?? "0");
    const numItems = args.paginationOpts.numItems;
    const pageSlice = conversations.slice(start, start + numItems);

    const page = await Promise.all(
      pageSlice.map(async (c) => {
        const customer = await ctx.db.get(c.customerId);
        const lead = c.leadId ? await ctx.db.get(c.leadId) : null;
        const vehicle = c.latest.vehicleId ? await ctx.db.get(c.latest.vehicleId) : null;
        return {
          customerId: c.customerId,
          leadId: c.leadId ?? null,
          platform: c.latest.platform,
          senderDisplayName: resolveSenderDisplayName(c.latest, customer),
          latestText: c.latest.text,
          latestKind: c.latest.kind,
          latestCreationTime: c.latest._creationTime,
          latestPostId: c.latest.postId ?? null,
          latestSenderHandle: c.latest.senderHandle ?? null,
          vehicleSummary: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : null,
          vehicleCount: c.vehicleIds.size,
          eventCount: c.eventCount,
          needsReply: c.needsReply,
          leadStage: lead?.stage ?? null,
        };
      })
    );

    return {
      page,
      isDone: start + numItems >= conversations.length,
      continueCursor: String(start + numItems),
    };
  },
});

/** All Instagram + Facebook events tied to a single customer, oldest first, for the conversation dialog. */
export const listEventsForCustomer = query({
  args: { orgId: v.id("organizations"), customerId: v.id("customers") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_LEADS]);

    const [igEvents, fbEvents] = await Promise.all([
      ctx.db
        .query("instagramEvents")
        .withIndex("by_org_customer", (q) => q.eq("orgId", args.orgId).eq("customerId", args.customerId))
        .collect(),
      ctx.db
        .query("facebookEvents")
        .withIndex("by_org_customer", (q) => q.eq("orgId", args.orgId).eq("customerId", args.customerId))
        .collect(),
    ]);
    const merged = [...igEvents.map(normalizeInstagramEvent), ...fbEvents.map(normalizeFacebookEvent)].sort(
      (a, b) => a._creationTime - b._creationTime
    );

    return await Promise.all(
      merged.map(async (ev) => {
        const customer = ev.customerId ? await ctx.db.get(ev.customerId) : null;
        const vehicle = ev.vehicleId ? await ctx.db.get(ev.vehicleId) : null;
        const repliedByUser = ev.manualRepliedByUserId ? await ctx.db.get(ev.manualRepliedByUserId) : null;
        return {
          ...ev,
          senderDisplayName: resolveSenderDisplayName(ev, customer),
          vehicleSummary: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : null,
          manualRepliedByName: repliedByUser?.name ?? null,
        };
      })
    );
  },
});

/**
 * Sets vehicleId on all events for a customer that currently have no vehicle
 * linked. Also updates the lead's vehicleId if it is unset.
 * Manager-only (APPROVE_REQUESTS permission).
 */
export const setConversationVehicle = mutation({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_REQUESTS]);

    const [igEvents, fbEvents] = await Promise.all([
      ctx.db
        .query("instagramEvents")
        .withIndex("by_org_customer", (q) => q.eq("orgId", args.orgId).eq("customerId", args.customerId))
        .collect(),
      ctx.db
        .query("facebookEvents")
        .withIndex("by_org_customer", (q) => q.eq("orgId", args.orgId).eq("customerId", args.customerId))
        .collect(),
    ]);

    await Promise.all([
      ...igEvents.filter((e) => !e.vehicleId).map((e) => ctx.db.patch(e._id, { vehicleId: args.vehicleId })),
      ...fbEvents.filter((e) => !e.vehicleId).map((e) => ctx.db.patch(e._id, { vehicleId: args.vehicleId })),
    ]);

    // Also patch the linked lead if it has no vehicle yet
    const allLeadIds = new Set([
      ...igEvents.filter((e) => e.leadId).map((e) => e.leadId as Id<"leads">),
      ...fbEvents.filter((e) => e.leadId).map((e) => e.leadId as Id<"leads">),
    ]);
    await Promise.all(
      Array.from(allLeadIds).map(async (leadId) => {
        const lead = await ctx.db.get(leadId);
        if (lead && !lead.vehicleId) {
          await ctx.db.patch(leadId, { vehicleId: args.vehicleId });
        }
      })
    );
  },
});

/**
 * Platform analytics: count of received contacts broken down by platform
 * and event kind (comment vs DM) over the last N days.
 * Used by the Social Inbox analytics panel.
 */
export const platformStats = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_LEADS]);

    const [igEvents, fbEvents] = await Promise.all([
      ctx.db
        .query("instagramEvents")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .collect(),
      ctx.db
        .query("facebookEvents")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .collect(),
    ]);

    const igComments = igEvents.filter((e) => e.kind === "comment").length;
    const igDms = igEvents.filter((e) => e.kind === "dm").length;
    const fbComments = fbEvents.filter((e) => e.kind === "comment").length;
    const fbDms = fbEvents.filter((e) => e.kind === "dm").length;

    // Unique senders per platform
    const igUnique = new Set(igEvents.map((e) => e.senderInstagramId)).size;
    const fbUnique = new Set(fbEvents.map((e) => e.senderFacebookId)).size;

    return {
      instagram: { comments: igComments, dms: igDms, total: igEvents.length, uniqueContacts: igUnique },
      facebook: { comments: fbComments, dms: fbDms, total: fbEvents.length, uniqueContacts: fbUnique },
      total: igEvents.length + fbEvents.length,
    };
  },
});
