import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query, mutation } from "./_generated/server";
import { QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { suggestVehiclesFromText } from "./utils/vehicleTextMatch";

/**
 * Unifies `instagramEvents` and `facebookEvents` for the Social Inbox UI.
 *
 * Conversations are grouped by (platform × customer × post) for comments,
 * and (platform × customer) for DMs. This means a customer who comments on
 * three different car posts produces three separate conversation rows, each
 * linked to its own vehicle and post. A customer who DMs on both Instagram
 * and Facebook produces two separate DM threads.
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
  vehicleMatchHintText: string | undefined;
  vehicleMatchHintSource: "message" | "post" | undefined;
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
    vehicleMatchHintText: ev.vehicleMatchHintText,
    vehicleMatchHintSource: ev.vehicleMatchHintSource,
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
    vehicleMatchHintText: ev.vehicleMatchHintText,
    vehicleMatchHintSource: ev.vehicleMatchHintSource,
    autoRepliedAt: ev.autoRepliedAt,
    autoReplyText: ev.autoReplyText,
    manualReplyText: ev.manualReplyText,
    manualRepliedAt: ev.manualRepliedAt,
    manualRepliedByUserId: ev.manualRepliedByUserId,
    senderRawId: ev.senderFacebookId,
    senderHandle: ev.senderName,
  };
}

function resolveSenderDisplayName(event: NormalizedEvent, customer: Doc<"customers"> | null): string {
  if (event.senderHandle) return event.senderHandle;
  if (customer) {
    const name = `${customer.firstName} ${customer.lastName}`.trim();
    if (name && !PLACEHOLDER_NAMES.has(name)) return name;
  }
  return event.senderRawId;
}

function buildVehicleSuggestion(
  event: NormalizedEvent,
  vehicles: Doc<"vehicles">[]
) {
  if (event.vehicleId) return null;
  const hintText = event.vehicleMatchHintText ?? event.text;
  if (!hintText) return null;

  const source = event.vehicleMatchHintText ? (event.vehicleMatchHintSource ?? "post") : "message";
  const candidates = suggestVehiclesFromText(hintText, vehicles, 3);
  if (candidates.length === 0) return null;

  const detectedDetails = Array.from(new Set(candidates.flatMap((candidate) => candidate.matchedDetails)));
  const missingDetails = Array.from(new Set(candidates.flatMap((candidate) => candidate.missingDetails)));

  return {
    source,
    detectedDetails,
    missingDetails,
    candidates,
  };
}

async function loadVehiclesForSuggestions(ctx: QueryCtx, orgId: Id<"organizations">) {
  return await ctx.db
    .query("vehicles")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .order("desc")
    .take(200);
}

/**
 * Stable key that groups events into a single conversation thread.
 * - Comments: one thread per (platform, customer, postId). Events with no postId
 *   are grouped into a "__none__" bucket until a resync can fill in the postId.
 * - DMs: one thread per (platform, customer) — all DMs in one inbox thread.
 */
function getConversationKey(ev: NormalizedEvent): string {
  if (ev.kind === "dm") return `${ev.platform}:${ev.customerId}:dm`;
  return `${ev.platform}:${ev.customerId}:comment:${ev.postId ?? "__none__"}`;
}

/**
 * Paginated list of conversations for the Social Inbox — one row per
 * (platform × customer × post) for comments, one row per (platform × customer)
 * for DMs. Sorted by most-recent activity.
 *
 * Optional filters (all server-side):
 *   platform   — exact platform match
 *   kind       — "comment" or "dm"
 *   hasVehicle — true = at least one linked vehicle; false = none
 *   needsReply — true = any event in the thread is unanswered; false = all answered
 */
export const listConversations = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
    platform: v.optional(v.union(v.literal("instagram"), v.literal("facebook"))),
    kind: v.optional(v.union(v.literal("comment"), v.literal("dm"))),
    hasVehicle: v.optional(v.boolean()),
    needsReply: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_LEADS]);

    const [igEvents, fbEvents] = await Promise.all([
      ctx.db.query("instagramEvents").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).collect(),
      ctx.db.query("facebookEvents").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).collect(),
    ]);
    const allEvents = [
      ...igEvents.map(normalizeInstagramEvent),
      ...fbEvents.map(normalizeFacebookEvent),
    ];

    // Group events into conversation threads
    const grouped = new Map<
      string,
      {
        events: NormalizedEvent[];
        platform: "instagram" | "facebook";
        kind: "comment" | "dm";
        conversationPostId: string | null;
      }
    >();
    for (const ev of allEvents) {
      if (!ev.customerId) continue;
      const key = getConversationKey(ev);
      const existing = grouped.get(key);
      if (existing) {
        existing.events.push(ev);
      } else {
        grouped.set(key, {
          events: [ev],
          platform: ev.platform,
          kind: ev.kind,
          conversationPostId: ev.kind === "comment" ? (ev.postId ?? null) : null,
        });
      }
    }

    let conversations = Array.from(grouped.values()).map((g) => {
      const latest = g.events.reduce((a, b) => (b._creationTime > a._creationTime ? b : a));
      const vehicleIds = new Set(g.events.filter((e) => e.vehicleId).map((e) => e.vehicleId as Id<"vehicles">));
      const leadId = [...g.events].reverse().find((e) => e.leadId)?.leadId;
      return {
        customerId: latest.customerId!,
        platform: g.platform,
        conversationKind: g.kind,
        conversationPostId: g.conversationPostId,
        latest,
        eventCount: g.events.length,
        needsReply: g.events.some((e) => !e.autoRepliedAt && !e.manualRepliedAt),
        vehicleIds,
        leadId,
      };
    });
    conversations.sort((a, b) => b.latest._creationTime - a.latest._creationTime);

    // Apply filters
    if (args.platform) {
      const p = args.platform;
      conversations = conversations.filter((c) => c.platform === p);
    }
    if (args.kind) {
      const k = args.kind;
      conversations = conversations.filter((c) => c.conversationKind === k);
    }
    if (args.hasVehicle === true) conversations = conversations.filter((c) => c.vehicleIds.size > 0);
    if (args.hasVehicle === false) conversations = conversations.filter((c) => c.vehicleIds.size === 0);
    if (args.needsReply === true) conversations = conversations.filter((c) => c.needsReply);
    if (args.needsReply === false) conversations = conversations.filter((c) => !c.needsReply);

    const start = Number(args.paginationOpts.cursor ?? "0");
    const numItems = args.paginationOpts.numItems;
    const pageSlice = conversations.slice(start, start + numItems);

    const page = await Promise.all(
      pageSlice.map(async (c) => {
        const customer = await ctx.db.get(c.customerId);
        const lead = c.leadId ? await ctx.db.get(c.leadId) : null;
        const vehicleId = [...c.vehicleIds][0];
        const vehicle = vehicleId ? await ctx.db.get(vehicleId) : null;
        return {
          customerId: c.customerId,
          leadId: c.leadId ?? null,
          platform: c.platform,
          conversationKind: c.conversationKind,
          conversationPostId: c.conversationPostId,
          senderDisplayName: resolveSenderDisplayName(c.latest, customer),
          latestText: c.latest.text,
          latestCreationTime: c.latest._creationTime,
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

/**
 * All events for a specific conversation thread — used by the Social Inbox
 * dialog when opened from a conversation row.
 *
 * For comment threads: filters by platform + customerId + postId (or no-postId
 * bucket). For DM threads: filters by platform + customerId + kind="dm".
 *
 * Events are returned oldest-first, enriched with vehicle/sender info.
 */
export const listEventsForConversation = query({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    platform: v.union(v.literal("instagram"), v.literal("facebook")),
    conversationKind: v.union(v.literal("comment"), v.literal("dm")),
    conversationPostId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_LEADS]);

    const matchesConversation = (kind: string, postId: string | undefined): boolean => {
      if (kind !== args.conversationKind) return false;
      if (args.conversationKind === "comment") {
        return (postId ?? null) === (args.conversationPostId ?? null);
      }
      return true;
    };
    const suggestionVehicles = await loadVehiclesForSuggestions(ctx, args.orgId);

    if (args.platform === "instagram") {
      const events = await ctx.db
        .query("instagramEvents")
        .withIndex("by_org_customer", (q) => q.eq("orgId", args.orgId).eq("customerId", args.customerId))
        .collect();
      const normalized = events
        .filter((e) => matchesConversation(e.kind, e.postId))
        .map(normalizeInstagramEvent)
        .sort((a, b) => a._creationTime - b._creationTime);
      return await Promise.all(
        normalized.map(async (ev) => {
          const customer = ev.customerId ? await ctx.db.get(ev.customerId) : null;
          const vehicle = ev.vehicleId ? await ctx.db.get(ev.vehicleId) : null;
          const repliedByUser = ev.manualRepliedByUserId ? await ctx.db.get(ev.manualRepliedByUserId) : null;
          return {
            ...ev,
            senderDisplayName: resolveSenderDisplayName(ev, customer),
            vehicleSummary: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : null,
            vehicleSuggestion: buildVehicleSuggestion(ev, suggestionVehicles),
            manualRepliedByName: repliedByUser?.name ?? null,
          };
        })
      );
    }

    // Facebook
    const events = await ctx.db
      .query("facebookEvents")
      .withIndex("by_org_customer", (q) => q.eq("orgId", args.orgId).eq("customerId", args.customerId))
      .collect();
    const normalized = events
      .filter((e) => matchesConversation(e.kind, e.postId))
      .map(normalizeFacebookEvent)
      .sort((a, b) => a._creationTime - b._creationTime);
    return await Promise.all(
      normalized.map(async (ev) => {
        const customer = ev.customerId ? await ctx.db.get(ev.customerId) : null;
        const vehicle = ev.vehicleId ? await ctx.db.get(ev.vehicleId) : null;
        const repliedByUser = ev.manualRepliedByUserId ? await ctx.db.get(ev.manualRepliedByUserId) : null;
        return {
          ...ev,
          senderDisplayName: resolveSenderDisplayName(ev, customer),
          vehicleSummary: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : null,
          vehicleSuggestion: buildVehicleSuggestion(ev, suggestionVehicles),
          manualRepliedByName: repliedByUser?.name ?? null,
        };
      })
    );
  },
});

/**
 * All Instagram + Facebook events tied to a single customer, oldest first.
 * Used by the leads page to show the customer's full cross-platform history.
 */
export const listEventsForCustomer = query({
  args: { orgId: v.id("organizations"), customerId: v.id("customers") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_LEADS]);
    const suggestionVehicles = await loadVehiclesForSuggestions(ctx, args.orgId);

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
          vehicleSuggestion: buildVehicleSuggestion(ev, suggestionVehicles),
          manualRepliedByName: repliedByUser?.name ?? null,
        };
      })
    );
  },
});

/**
 * Links a vehicle to all unlinked events in a conversation thread.
 * When platform + conversationKind (+ conversationPostId for comments) are
 * provided, only events in that specific thread are updated. When omitted,
 * all unlinked events for the customer are updated (leads-page behavior).
 * Also patches any associated lead that has no vehicle yet.
 */
export const setConversationVehicle = mutation({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    vehicleId: v.id("vehicles"),
    platform: v.optional(v.union(v.literal("instagram"), v.literal("facebook"))),
    conversationKind: v.optional(v.union(v.literal("comment"), v.literal("dm"))),
    conversationPostId: v.optional(v.string()),
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

    const inScope = (e: { kind: string; postId?: string }, platformMatches: boolean): boolean => {
      if (!platformMatches) return false;
      if (!args.conversationKind) return true;
      if (e.kind !== args.conversationKind) return false;
      if (args.conversationKind === "comment") {
        return (e.postId ?? null) === (args.conversationPostId ?? null);
      }
      return true;
    };

    const igToUpdate = igEvents.filter(
      (e) => !e.vehicleId && inScope(e, !args.platform || args.platform === "instagram")
    );
    const fbToUpdate = fbEvents.filter(
      (e) => !e.vehicleId && inScope(e, !args.platform || args.platform === "facebook")
    );

    await Promise.all([
      ...igToUpdate.map((e) => ctx.db.patch(e._id, { vehicleId: args.vehicleId })),
      ...fbToUpdate.map((e) => ctx.db.patch(e._id, { vehicleId: args.vehicleId })),
    ]);

    const allLeadIds = new Set(
      [...igToUpdate, ...fbToUpdate].filter((e) => e.leadId).map((e) => e.leadId as Id<"leads">)
    );
    await Promise.all(
      Array.from(allLeadIds).map(async (leadId) => {
        const lead = await ctx.db.get(leadId);
        if (lead && !lead.vehicleId) await ctx.db.patch(leadId, { vehicleId: args.vehicleId });
      })
    );
  },
});

/**
 * Platform analytics: count of received contacts broken down by platform
 * and event kind (comment vs DM). Used by the Social Inbox analytics panel.
 */
export const platformStats = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_LEADS]);

    const [igEvents, fbEvents] = await Promise.all([
      ctx.db.query("instagramEvents").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).collect(),
      ctx.db.query("facebookEvents").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).collect(),
    ]);

    const igComments = igEvents.filter((e) => e.kind === "comment").length;
    const igDms = igEvents.filter((e) => e.kind === "dm").length;
    const fbComments = fbEvents.filter((e) => e.kind === "comment").length;
    const fbDms = fbEvents.filter((e) => e.kind === "dm").length;

    const igUnique = new Set(igEvents.map((e) => e.senderInstagramId)).size;
    const fbUnique = new Set(fbEvents.map((e) => e.senderFacebookId)).size;

    return {
      instagram: { comments: igComments, dms: igDms, total: igEvents.length, uniqueContacts: igUnique },
      facebook: { comments: fbComments, dms: fbDms, total: fbEvents.length, uniqueContacts: fbUnique },
      total: igEvents.length + fbEvents.length,
    };
  },
});
