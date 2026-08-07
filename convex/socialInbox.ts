import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query } from "./_generated/server";
import { socialBulkMutation } from "./functions";
import { QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { suggestVehiclesFromText } from "./utils/vehicleTextMatch";
import { recordLeadActivity, describeLeadFieldValue } from "./utils/leadActivity";
import { requireFeature } from "./subscriptions";
import {
  collectSocialThread,
  facebookEventsByOrg,
  instagramEventsByOrg,
  newDeferredSocialThreads,
  socialContactsByOrg,
  socialConversationKey,
  syncDeferredSocialThreads,
} from "./aggregates";
import {
  describeMaterializationStatus,
  readMaterializationState,
  socialConversationsReady,
  SOCIAL_PLATFORMS,
} from "./utils/materialization";

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

/**
 * Picks what to show as the contact's name in the inbox.
 *
 * The customer record wins over the platform handle. Staff rename these
 * auto-created contacts to the person's real name, and that edit has to show
 * up here like it does on every other screen — previously the handle was
 * checked first, so a renamed Instagram contact kept displaying its old
 * username forever. The handle is still returned separately as
 * `latestSenderHandle`, which is what the profile/DM deep links use.
 *
 * The raw PSID/IGSID is never used as a name. It is a 17-digit platform
 * identifier, meaningless to the person reading the inbox, and it was landing
 * in the contact list whenever a profile lookup had not resolved yet.
 */
function resolveSenderDisplayName(
  event: Pick<NormalizedEvent, "platform" | "senderRawId" | "senderHandle">,
  customer: Doc<"customers"> | null
): string {
  if (customer) {
    // Trimmed per field, matching the engagement helpers: a trailing space on
    // firstName otherwise leaves a double space in the joined name, which then
    // matches neither the placeholder set nor a raw id — so exactly the
    // historical rows this is meant to clean up would slip through.
    const first = customer.firstName.trim();
    const last = customer.lastName.trim();
    const name = `${first} ${last}`.trim();
    // Records whose name was written as the raw id by an earlier intake path
    // are placeholders too. Both shapes occur: the id alone, and the id split
    // into `firstName` with "Contact" left in `lastName`.
    const isIdName = name === event.senderRawId || first === event.senderRawId;
    if (name && !PLACEHOLDER_NAMES.has(name) && !isIdName) return name;
  }
  if (event.senderHandle && event.senderHandle !== event.senderRawId) return event.senderHandle;
  return event.platform === "instagram" ? "Instagram Contact" : "Facebook Contact";
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

// The thread grouping now lives in `convex/aggregates.ts` as
// `socialConversationKey`, next to the trigger that materialises the rows, so
// the reader and the writer cannot drift on what a thread is.

/**
 * The two sources page through different cursor spaces, and a client can hold a
 * cursor across the moment readiness flips.
 *
 * The legacy path's cursor is an offset into a re-sorted array; the materialised
 * path's is a Convex index sort key. Neither is meaningful to the other, and the
 * failure is silent in the dangerous direction: `Number('["1700000000000",…]')`
 * is `NaN`, `slice(NaN, NaN)` is empty, and the legacy path would answer with an
 * empty page, `isDone: false`, and a `"NaN"` cursor — a Social Inbox that shows
 * one page and then loads forever without ever finishing. That is the same
 * confidently-wrong-and-quiet shape as the incident this gate was written for.
 *
 * So each path rejects the other's cursor explicitly. `InvalidCursor` is the one
 * error `usePaginatedQuery` recovers from by itself: it resets pagination state
 * and re-fetches from the start. Coercing a foreign cursor to `null` instead
 * would look tidier and would duplicate rows across the seam.
 */
const LEGACY_CURSOR_PREFIX = "legacyOffset:";

function invalidCursor(): never {
  throw new ConvexError({
    isConvexSystemError: true,
    paginationError: "InvalidCursor",
  });
}

/** Offset for the legacy path, rejecting a materialised cursor. */
function parseLegacyCursor(cursor: string | null): number {
  if (cursor === null) return 0;
  if (!cursor.startsWith(LEGACY_CURSOR_PREFIX)) invalidCursor();
  const offset = Number(cursor.slice(LEGACY_CURSOR_PREFIX.length));
  if (!Number.isInteger(offset) || offset < 0) invalidCursor();
  return offset;
}

/** One conversation row as the inbox renders it, from either source. */
type ConversationListItem = {
  customerId: Id<"customers">;
  leadId: Id<"leads"> | null;
  platform: "instagram" | "facebook";
  conversationKind: "comment" | "dm";
  conversationPostId: string | null;
  senderDisplayName: string;
  latestText: string | undefined;
  latestCreationTime: number;
  latestSenderHandle: string | null;
  vehicleSummary: string | null;
  vehicleCount: number;
  eventCount: number;
  needsReply: boolean;
  leadStage: string | null;
};

/**
 * The pre-materialisation implementation, kept as the fallback the readiness
 * gate falls back *to*.
 *
 * This is not dead code and must not be deleted as such. It is what the Social
 * Inbox runs for any org whose `socialConversations` rows have not been proven
 * complete — which includes the window between deploying this file and
 * finishing the backfill, the exact window in which a production deployment
 * once showed staff an empty inbox over a thousand live events.
 *
 * It reads both event tables in full, which is the 1.34 GB/week cost the
 * materialised path exists to remove. That is the intended trade: correct and
 * expensive beats fast and wrong, and it only runs until the backfill proves
 * itself.
 */
async function listConversationsFromEvents(
  ctx: QueryCtx,
  args: {
    orgId: Id<"organizations">;
    paginationOpts: { numItems: number; cursor: string | null };
    platform?: "instagram" | "facebook";
    kind?: "comment" | "dm";
    hasVehicle?: boolean;
    needsReply?: boolean;
  }
): Promise<{ page: ConversationListItem[]; isDone: boolean; continueCursor: string }> {
  const [igEvents, fbEvents] = await Promise.all([
    ctx.db.query("instagramEvents").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).collect(),
    ctx.db.query("facebookEvents").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).collect(),
  ]);
  const allEvents = [
    ...igEvents.map(normalizeInstagramEvent),
    ...fbEvents.map(normalizeFacebookEvent),
  ];

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
    // The writer's canonical key, so the fallback groups threads exactly as the
    // materialised path does. Using a second local implementation here is how
    // the two sources would silently disagree about what a conversation is.
    const key = socialConversationKey({
      platform: ev.platform,
      customerId: ev.customerId,
      kind: ev.kind,
      postId: ev.postId,
    });
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
    const latest = g.events.reduce((a, b) => (b._creationTime > a._creationTime ? b : a), g.events[0]);
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

  const start = parseLegacyCursor(args.paginationOpts.cursor);
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
    continueCursor: `${LEGACY_CURSOR_PREFIX}${start + numItems}`,
  };
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
    await requireFeature(ctx, args.orgId, "socialInbox");

    // The materialised table is authoritative only once a backfill for the
    // current generation has proven, by exhausting the source, that it holds
    // every thread this org has. Anything else — never started, mid-run,
    // interrupted, failed, or completed under an older generation — falls back
    // to reading the events directly.
    //
    // This is the fix for a production incident, not a precaution. Deploying
    // the materialised reader ahead of its backfill made the Social Inbox
    // report zero conversations for an org holding 1,029 events, with no error
    // and no way for staff to tell an empty inbox from an unbuilt one. The
    // gate makes deployment order irrelevant: the code can ship hours or days
    // before the backfill finishes and the inbox stays correct throughout,
    // switching over by itself once completion is recorded.
    //
    // Exactly one source answers any given request. Blending a page from both
    // would have to reconcile two different cursor spaces — an integer offset
    // here, an index sort key there — and could duplicate or drop threads at
    // the seam.
    if (!(await socialConversationsReady(ctx, args.orgId))) {
      return await listConversationsFromEvents(ctx, args);
    }

    // Readiness flipped underneath a client that is mid-scroll on the legacy
    // path. Convex would reject this cursor itself, but not before the shape of
    // the error became the caller's problem; raising `InvalidCursor` is what
    // makes `usePaginatedQuery` reset and re-page cleanly against the new
    // source.
    if (args.paginationOpts.cursor?.startsWith(LEGACY_CURSOR_PREFIX)) invalidCursor();

    // One page of materialised threads, newest activity first, straight off an
    // index. This used to `.collect()` both event tables in full, group them in
    // JavaScript, and slice the result — 1.34 GB of production bandwidth in a
    // week, re-read from scratch on every inbound message and once per mounted
    // page, because a "conversation" was not a row and the cursor was an offset
    // into an in-memory array.
    //
    // `platform` and `kind` each get their own index so the common filtered
    // views stay index-bounded. They are mutually exclusive in the index
    // choice: a query can only use one, so when both are supplied the platform
    // index runs and `kind` is matched against the stream. That still reads
    // only small conversation rows, never the events behind them.
    const { orgId, platform, kind, hasVehicle, needsReply } = args;
    const conversations = ctx.db.query("socialConversations");

    let baseQuery;
    if (platform) {
      baseQuery = conversations.withIndex("by_org_platform_lastEventAt", (q) =>
        q.eq("orgId", orgId).eq("platform", platform)
      );
    } else if (kind) {
      baseQuery = conversations.withIndex("by_org_kind_lastEventAt", (q) =>
        q.eq("orgId", orgId).eq("conversationKind", kind)
      );
    } else {
      baseQuery = conversations.withIndex("by_org_lastEventAt", (q) => q.eq("orgId", orgId));
    }

    // Whatever the chosen index did not already constrain. `hasVehicle` reads
    // the stored distinct-vehicle count and `needsReply` the stored unanswered
    // count, so both mean exactly what the old in-memory predicates meant.
    //
    // `q.and` is variadic and each clause is independent, so they are collected
    // and applied in one call. `true` when there is nothing to narrow — an
    // `and()` over an empty list is not a shape worth relying on.
    const filtered = baseQuery.filter((q) => {
      const clauses = [];
      // Only when the platform index was chosen, so `kind` was not applied to
      // the index range and still has to be matched against the stream.
      if (platform && kind) clauses.push(q.eq(q.field("conversationKind"), kind));
      if (hasVehicle === true) clauses.push(q.gt(q.field("vehicleCount"), 0));
      if (hasVehicle === false) clauses.push(q.eq(q.field("vehicleCount"), 0));
      if (needsReply === true) clauses.push(q.gt(q.field("unansweredCount"), 0));
      if (needsReply === false) clauses.push(q.eq(q.field("unansweredCount"), 0));
      return clauses.length === 0 ? true : q.and(...clauses);
    });

    const pageResult = await filtered.order("desc").paginate(args.paginationOpts);

    const page = await Promise.all(
      pageResult.page.map(async (c) => {
        const customer = await ctx.db.get(c.customerId);
        const lead = c.leadId ? await ctx.db.get(c.leadId) : null;
        const vehicleId = c.vehicleIds[0];
        const vehicle = vehicleId ? await ctx.db.get(vehicleId) : null;
        return {
          customerId: c.customerId,
          leadId: c.leadId ?? null,
          platform: c.platform,
          conversationKind: c.conversationKind,
          conversationPostId: c.conversationPostId ?? null,
          senderDisplayName: resolveSenderDisplayName(
            {
              platform: c.platform,
              senderRawId: c.latestSenderRawId,
              senderHandle: c.latestSenderHandle,
            },
            customer
          ),
          latestText: c.latestText,
          latestCreationTime: c.lastEventAt,
          latestSenderHandle: c.latestSenderHandle ?? null,
          vehicleSummary: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : null,
          vehicleCount: c.vehicleIds.length,
          eventCount: c.eventCount,
          needsReply: c.unansweredCount > 0,
          leadStage: lead?.stage ?? null,
        };
      })
    );

    return { ...pageResult, page };
  },
});

/**
 * Which source this org's inbox is reading, and how far its materialisation
 * has got.
 *
 * Tenant-scoped counterpart to `adminSystem.getSocialMaterializationStatus`,
 * so the inbox itself can say "still building, showing live results" instead of
 * leaving staff to wonder why a list feels slow — or, in the failure this was
 * written for, why it is empty.
 *
 * Returns counts that are already distinct: `processedCount` is source events
 * read, `materializedCount` is threads rebuilt. "0 of 1,029" was the unreadable
 * signal that prompted this; "1,029 processed, 12 threads, completed" is not.
 */
export const materializationStatus = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_LEADS]);
    await requireFeature(ctx, args.orgId, "socialInbox");

    const now = Date.now();
    const platforms = await Promise.all(
      SOCIAL_PLATFORMS.map(async (platform) => {
        const row = await readMaterializationState(ctx, args.orgId, platform);
        return {
          platform,
          status: describeMaterializationStatus(row, now),
          processedCount: row?.processedCount ?? 0,
          materializedCount: row?.materializedCount ?? 0,
          expectedCount: row?.expectedCount ?? 0,
          startedAt: row?.startedAt ?? null,
          lastProgressAt: row?.lastProgressAt ?? null,
          completedAt: row?.completedAt ?? null,
          failureMessage: row?.failureMessage ?? null,
        };
      })
    );

    return {
      // The honest answer to "is this list coming off the fast path", which is
      // the only thing the UI should branch on.
      readerSource: platforms.every((p) => p.status === "completed")
        ? ("materialized" as const)
        : ("legacyEvents" as const),
      platforms,
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
    await requireFeature(ctx, args.orgId, "socialInbox");

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
    await requireFeature(ctx, args.orgId, "socialInbox");
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
export const setConversationVehicle = socialBulkMutation({
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
    await requireFeature(ctx, args.orgId, "socialInbox");

    // The vehicle id comes straight from the caller and gets stamped onto
    // instagramEvents/facebookEvents and the linked lead. Readers
    // (listConversations, listConversationEvents, and the Instagram engagement
    // views) resolve it with a bare ctx.db.get and return year/make/model as
    // vehicleSummary, so an unchecked id here is a cross-tenant read: point a
    // conversation at another dealership's vehicle and its details come back
    // through your own inbox. Bind it to the caller's org before it is stored.
    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }

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

    // Deferred conversation sync. From the leads page this runs with no
    // `platform` or `conversationKind`, so it repoints *every* unlinked event
    // for the customer across both platforms — and `vehicleId` is a
    // materialised field, so a per-write recompute would re-read each thread
    // once per event. See `deferredThreadTriggers`.
    const touchedThreads = newDeferredSocialThreads();
    for (const e of igToUpdate) collectSocialThread(touchedThreads, "instagram", e);
    for (const e of fbToUpdate) collectSocialThread(touchedThreads, "facebook", e);

    await Promise.all([
      ...igToUpdate.map((e) => ctx.db.patch(e._id, { vehicleId: args.vehicleId })),
      ...fbToUpdate.map((e) => ctx.db.patch(e._id, { vehicleId: args.vehicleId })),
    ]);

    // `vehicleId` does not appear in the conversation key, so the threads are
    // the same before and after — collected from the pre-patch rows above.
    await syncDeferredSocialThreads(ctx, touchedThreads);

    const allLeadIds = new Set(
      [...igToUpdate, ...fbToUpdate].filter((e) => e.leadId).map((e) => e.leadId as Id<"leads">)
    );
    await Promise.all(
      Array.from(allLeadIds).map(async (leadId) => {
        const lead = await ctx.db.get(leadId);
        if (lead && !lead.vehicleId) {
          await ctx.db.patch(leadId, { vehicleId: args.vehicleId });
          await recordLeadActivity(ctx, {
            orgId: lead.orgId,
            leadId,
            action: "UPDATED",
            actorLabel: "Social inbox vehicle match",
            field: "vehicleId",
            toValue: await describeLeadFieldValue(ctx, "vehicleId", args.vehicleId),
          });
        }
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
    await requireFeature(ctx, args.orgId, "socialInbox");

    // Nine counts off three B-trees instead of reading every event the org has
    // ever received. This query was Convex's #3 bandwidth consumer at 1.08 GB in
    // one week: it is a live subscription over the same two tables social
    // ingestion writes to, so each inbound message re-ran it over the whole
    // history — and the history only grows.
    //
    // `exactKind` is a degenerate range (one key, both ends inclusive) because
    // `kind` is the only element of the sort key; the whole namespace is the
    // platform's total. Counting DMs as `total - comments` would be one fewer
    // read, but `kind` is a two-value union today and a subtraction would
    // silently absorb any third value into the DM figure.
    const exactKind = (kind: "comment" | "dm") => ({
      lower: { key: [kind] as [string], inclusive: true as const },
      upper: { key: [kind] as [string], inclusive: true as const },
    });
    const exactPlatform = (platform: "instagram" | "facebook") => ({
      lower: { key: [platform] as [string], inclusive: true as const },
      upper: { key: [platform] as [string], inclusive: true as const },
    });

    const [igComments, igDms, igTotal, fbComments, fbDms, fbTotal, igUnique, fbUnique] =
      await Promise.all([
        instagramEventsByOrg.count(ctx, { namespace: args.orgId, bounds: exactKind("comment") }),
        instagramEventsByOrg.count(ctx, { namespace: args.orgId, bounds: exactKind("dm") }),
        instagramEventsByOrg.count(ctx, { namespace: args.orgId }),
        facebookEventsByOrg.count(ctx, { namespace: args.orgId, bounds: exactKind("comment") }),
        facebookEventsByOrg.count(ctx, { namespace: args.orgId, bounds: exactKind("dm") }),
        facebookEventsByOrg.count(ctx, { namespace: args.orgId }),
        socialContactsByOrg.count(ctx, { namespace: args.orgId, bounds: exactPlatform("instagram") }),
        socialContactsByOrg.count(ctx, { namespace: args.orgId, bounds: exactPlatform("facebook") }),
      ]);

    return {
      instagram: { comments: igComments, dms: igDms, total: igTotal, uniqueContacts: igUnique },
      facebook: { comments: fbComments, dms: fbDms, total: fbTotal, uniqueContacts: fbUnique },
      total: igTotal + fbTotal,
    };
  },
});
