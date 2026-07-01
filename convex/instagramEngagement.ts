import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation, internalQuery, internalAction, query, action } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { notifyManagers, notifyUser } from "./utils/notifications";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { requireFeature } from "./subscriptions";
import { postCommentReply, postDirectMessage, INSTAGRAM_GRAPH_VERSION } from "./utils/instagramApi";
import { matchIntent, detectLocale } from "./utils/smartReplyIntent";
import { buildSmartReplyText } from "./utils/smartReplyBuilder";
import { matchVehicleFromText, suggestVehiclesFromText } from "./utils/vehicleTextMatch";
import { attachSharedMobileNumberToCustomer, extractSharedMobileNumber } from "./utils/socialMobile";
import { nextGeneratedLeadAssignee } from "./utils/leadAssignment";
import { mobileReceivedAutoReplyText } from "./utils/socialMobileReply";

const AUTO_REPLY_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 1 reply per sender per 24h
// Placeholder name assigned when a customer is created without a username —
// DM webhook payloads never include one (only comments do). Checked against
// later to know whether a profile-enrichment fetch is still needed, and to
// avoid clobbering a name a staff member may have since edited manually.
const PLACEHOLDER_FIRST_NAME = "Instagram";
const PLACEHOLDER_LAST_NAME = "Contact";

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Reverse-lookup used by the webhook: maps the IG account ID Meta sends in
 * entry[].id back to an org. This is `instagramWebhookAccountId` (the
 * profile's "user_id" field) — NOT `instagramBusinessAccountId` (the OAuth
 * "id" field used for outbound Graph API path calls). Confirmed via direct
 * API probe 2026-06-22 that these are two different IDs for the same account.
 */
export const getSettingsByInstagramAccountId = internalQuery({
  args: { instagramBusinessAccountId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("orgSettings")
      .withIndex("by_instagram_webhook_account_id", (q) =>
        q.eq("instagramWebhookAccountId", args.instagramBusinessAccountId)
      )
      .unique();
  },
});

/**
 * Finds or creates a customer for an inbound comment/DM, opens a lead if
 * none is open, logs the dedup/audit event, notifies managers, and — if
 * eligible — picks the next round-robin auto-reply message. Mirrors
 * `whatsapp.handleIncomingMessage`'s find-or-create shape.
 *
 * Returns null if this externalId was already processed (Meta retries
 * webhook deliveries), otherwise returns what the caller (the HTTP action)
 * needs to actually send the auto-reply, since mutations can't fetch().
 */
export const handleIncomingInstagramEvent = internalMutation({
  args: {
    orgId: v.id("organizations"),
    // For "comment" events, externalId IS the comment id (used directly to
    // post a reply via /{commentId}/replies). For "dm" events, externalId is
    // the message id (used only for dedup — replies target senderInstagramId).
    kind: v.union(v.literal("comment"), v.literal("dm")),
    externalId: v.string(),
    senderInstagramId: v.string(),
    senderUsername: v.optional(v.string()),
    text: v.optional(v.string()),
    // The IG media (post) ID a comment was made on — absent for plain-text
    // DMs, which generally have no post reference. Used to link the lead
    // back to the vehicle that post was about, via socialPosts.externalPostId.
    mediaId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args
  ): Promise<{
    shouldAutoReply: boolean;
    replyText?: string;
    smartReplyVisibility?: "public" | "dm";
    leadId?: Id<"leads">;
    customerId?: Id<"customers">;
    needsProfileEnrichment: boolean;
    vehicleId?: Id<"vehicles">;
  } | null> => {
    const { orgId, kind, externalId, senderInstagramId, senderUsername, text, mediaId } = args;
    const sharedMobileNumber = kind === "dm" ? extractSharedMobileNumber(text) : null;

    const duplicate = await ctx.db
      .query("instagramEvents")
      .withIndex("by_org_external", (q) => q.eq("orgId", orgId).eq("externalId", externalId))
      .unique();
    if (duplicate) return null;

    // Find or create customer
    const customers = await ctx.db
      .query("customers")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect();

    let customer: Doc<"customers"> | null =
      customers.find((c) => c.instagramUserId === senderInstagramId) ?? null;

    if (!customer) {
      const nameParts = (senderUsername ?? `${PLACEHOLDER_FIRST_NAME} ${PLACEHOLDER_LAST_NAME}`).split(" ");
      const customerId = await ctx.db.insert("customers", {
        orgId,
        firstName: nameParts[0] ?? PLACEHOLDER_FIRST_NAME,
        lastName: nameParts.slice(1).join(" ") || PLACEHOLDER_LAST_NAME,
        instagramUserId: senderInstagramId,
      });
      customer = await ctx.db.get(customerId);
    }
    if (!customer) return null;

    if (kind === "dm") {
      await attachSharedMobileNumberToCustomer(ctx, orgId, customer, sharedMobileNumber);
    }

    // DM payloads never carry a username (only comments do) — if we still
    // only have the placeholder name, the caller (an action) should fetch
    // the real one from Instagram's profile API.
    const needsProfileEnrichment =
      !senderUsername && customer.firstName === PLACEHOLDER_FIRST_NAME && customer.lastName === PLACEHOLDER_LAST_NAME;

    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .unique();

    let vehicleId: Id<"vehicles"> | undefined;
    if (mediaId) {
      const socialPost = await ctx.db
        .query("socialPosts")
        .withIndex("by_external_post_id", (q) => q.eq("externalPostId", mediaId))
        .filter((q) => q.eq(q.field("orgId"), orgId))
        .first();
      vehicleId = socialPost?.vehicleId;
    }

    // Lead creation is independently toggleable per event kind (comments vs
    // DMs) — undefined defaults to true so orgs connected before this
    // setting existed keep their current behavior. Off doesn't mean ignored:
    // the event is still captured below and still eligible for auto-reply,
    // it just doesn't produce a Lead in the pipeline or a notification.
    const leadCreationEnabled =
      kind === "comment"
        ? settings?.instagramLeadFromCommentsEnabled !== false
        : settings?.instagramLeadFromDmsEnabled !== false
          && (!(settings?.instagramLeadFromDmsRequiresMobile ?? false) || Boolean(sharedMobileNumber));

    const label = kind === "dm" ? "Instagram DM" : "Instagram Comment";
    let leadId: Id<"leads"> | undefined;
    if (leadCreationEnabled) {
      const existingLeads = await ctx.db
        .query("leads")
        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customer!._id))
        .collect();
      const openLead = existingLeads.find((l) => !l.isDeleted && l.stage !== "WON" && l.stage !== "LOST");
      leadId = openLead?._id;

      if (!leadId) {
        const assignedUserId = await nextGeneratedLeadAssignee(ctx, orgId);
        leadId = await ctx.db.insert("leads", {
          orgId,
          customerId: customer._id,
          assignedUserId,
          vehicleId,
          source: label,
          stage: "NEW",
          notes: text ? `First ${label}: "${text.slice(0, 200)}"` : `Lead created from ${label}`,
        });

        await notifyManagers(
          ctx,
          orgId,
          "social.lead_created",
          { platform: label, senderName: senderUsername ?? senderInstagramId },
          { link: `/${orgId}/leads?highlightId=${leadId}` }
        );

        if (assignedUserId) {
          await notifyUser(
            ctx,
            orgId,
            assignedUserId,
            "lead.assigned",
            { actorName: "AutoFlow" },
            { link: `/${orgId}/leads?highlightId=${leadId}` }
          );
        }
      }
    }

    // Smart Reply: rule-based price/financing/availability/vehicleInfo/
    // location answers, tried before the generic canned round-robin
    // auto-reply. Not subject to AUTO_REPLY_COOLDOWN_MS below — these are
    // on-demand factual lookups, not repetitive canned messages, so two
    // distinct questions from the same sender within 24h should both be
    // answered. A complaint match suppresses BOTH this and the canned
    // reply and escalates to managers instead — never answer a complaint
    // with a cheerful templated reply.
    let shouldAutoReply = false;
    let replyText: string | undefined;
    let smartReplyVisibility: "public" | "dm" | undefined;
    let suppressCannedReply = false;
    let smartReplySource = false;

    const smartReplyEnabled = kind === "dm"
      ? (settings?.instagramSmartReplyForDmsEnabled ?? settings?.instagramSmartReplyEnabled ?? false)
      : (settings?.instagramSmartReplyForCommentsEnabled ?? settings?.instagramSmartReplyEnabled ?? false);

    if (smartReplyEnabled && text) {
      const intent = matchIntent(text);

      if (intent === "complaint") {
        suppressCannedReply = true;
        await notifyManagers(
          ctx,
          orgId,
          "social.possible_complaint",
          { platform: "Instagram", senderName: senderUsername ?? senderInstagramId, excerpt: text.slice(0, 200) },
          { link: leadId ? `/${orgId}/leads?highlightId=${leadId}` : `/${orgId}/leads` }
        );
      } else if (intent && (intent === "location" || intent === "greeting" || vehicleId)) {
        const vehicle = vehicleId ? await ctx.db.get(vehicleId) : null;
        const financeCompany = settings?.smartReplyDefaultFinanceCompanyId
          ? await ctx.db.get(settings.smartReplyDefaultFinanceCompanyId)
          : null;
        const locale = detectLocale(text) ?? settings?.smartReplyDefaultLocale ?? "en";
        const built = buildSmartReplyText({
          intent,
          vehicle,
          orgSettings: settings,
          financeCompany: financeCompany?.isActive ? financeCompany : null,
          locale,
        });
        if (built) {
          replyText = built;
          shouldAutoReply = true;
          smartReplySource = true;
          smartReplyVisibility = kind === "comment" ? (settings?.smartReplyVisibility ?? "public") : "dm";
        }
      }
    }

    // Auto-reply eligibility: enabled, has messages, and sender not replied-to in the last 24h
    const messages = settings?.instagramAutoReplyMessages ?? [];

    const cannedEnabled = kind === "dm"
      ? (settings?.instagramAutoReplyForDmsEnabled ?? settings?.instagramAutoReplyEnabled ?? false)
      : (settings?.instagramAutoReplyForCommentsEnabled ?? settings?.instagramAutoReplyEnabled ?? false);

    if (!shouldAutoReply && !suppressCannedReply && cannedEnabled) {
      const recentEvents = await ctx.db
        .query("instagramEvents")
        .withIndex("by_org_sender", (q) => q.eq("orgId", orgId).eq("senderInstagramId", senderInstagramId))
        .collect();
      const recentAutoReplyCutoff = Date.now() - AUTO_REPLY_COOLDOWN_MS;
      const mobileReceivedReply =
        kind === "dm" && sharedMobileNumber
          ? mobileReceivedAutoReplyText(settings?.instagramAutoReplyMobileReceivedMessage)
          : undefined;

      if (mobileReceivedReply) {
        const sentMobileReceivedReplyRecently = recentEvents.some(
          (e) => e.kind === kind && e.autoRepliedAt && e.autoRepliedAt > recentAutoReplyCutoff && e.autoReplyText === mobileReceivedReply
        );
        if (!sentMobileReceivedReplyRecently) {
          replyText = mobileReceivedReply;
          shouldAutoReply = true;
        }
      } else if (messages.length > 0 && settings) {
        const repliedRecently = recentEvents.some(
          (e) => e.kind === kind && e.autoRepliedAt && e.autoRepliedAt > recentAutoReplyCutoff
        );
        if (!repliedRecently) {
          const nextIndex = ((settings.instagramAutoReplyLastIndex ?? -1) + 1) % messages.length;
          replyText = messages[nextIndex];
          shouldAutoReply = true;
          await ctx.db.patch(settings._id, { instagramAutoReplyLastIndex: nextIndex });
        }
      }
    }

    await ctx.db.insert("instagramEvents", {
      orgId,
      externalId,
      kind,
      senderInstagramId,
      senderUsername,
      customerId: customer._id,
      leadId,
      vehicleId,
      text,
      postId: mediaId,
      autoRepliedAt: shouldAutoReply ? Date.now() : undefined,
      autoReplyText: shouldAutoReply ? replyText : undefined,
      autoReplySource: shouldAutoReply ? (smartReplySource ? "smart" : "canned") : undefined,
    });

    return { shouldAutoReply, replyText, smartReplyVisibility, leadId, customerId: customer._id, needsProfileEnrichment, vehicleId };
  },
});

/** Fetches a sender's display name from Instagram and applies it to their customer record. */
export const enrichCustomerProfile = internalAction({
  args: { orgId: v.id("organizations"), customerId: v.id("customers"), senderInstagramId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const token = await ctx.runQuery(internal.instagramEngagement.getTokenForOrg, { orgId: args.orgId });
    if (!token) return;

    const url = new URL(`https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}/${args.senderInstagramId}`);
    url.searchParams.set("fields", "name,username");
    url.searchParams.set("access_token", token.instagramAccessToken);
    const res = await fetch(url.toString());
    if (!res.ok) return; // best-effort enrichment — not worth failing the webhook over

    const json = await res.json();
    const displayName: string | undefined = json.username ?? json.name;
    if (!displayName) return;

    await ctx.runMutation(internal.instagramEngagement.saveCustomerDisplayName, {
      customerId: args.customerId,
      displayName,
    });
  },
});

export const saveCustomerDisplayName = internalMutation({
  args: { customerId: v.id("customers"), displayName: v.string() },
  handler: async (ctx, args) => {
    const customer = await ctx.db.get(args.customerId);
    // Only overwrite the placeholder — never clobber a name a staff member may have since edited.
    if (!customer || customer.firstName !== PLACEHOLDER_FIRST_NAME || customer.lastName !== PLACEHOLDER_LAST_NAME) {
      return;
    }
    const nameParts = args.displayName.trim().split(" ");
    await ctx.db.patch(args.customerId, {
      firstName: nameParts[0],
      lastName: nameParts.slice(1).join(" ") || nameParts[0],
    });
  },
});

export const getTokenForOrg = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
    if (!settings?.instagramAccessToken || !settings?.instagramBusinessAccountId) return null;
    return {
      instagramAccessToken: settings.instagramAccessToken,
      instagramBusinessAccountId: settings.instagramBusinessAccountId,
    };
  },
});

// ─── Outbound (Graph API calls — actions only, mutations can't fetch) ─────────

/** Auto-replies to an inbound comment. Same Graph endpoint as the manual reply below. */
export const sendCommentReply = internalAction({
  args: { orgId: v.id("organizations"), commentId: v.string(), message: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const token = await ctx.runQuery(internal.instagramEngagement.getTokenForOrg, { orgId: args.orgId });
    if (!token) return;

    const result = await postCommentReply(args.commentId, args.message, token.instagramAccessToken);
    if (!result.ok) {
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "instagram",
        status: "error",
        summary: `Auto-reply to comment ${args.commentId} failed`,
        error: result.error,
      });
    }
  },
});

/** Auto-replies to an inbound DM via the Instagram Messaging API. */
export const sendDirectMessage = internalAction({
  args: { orgId: v.id("organizations"), recipientInstagramId: v.string(), message: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const token = await ctx.runQuery(internal.instagramEngagement.getTokenForOrg, { orgId: args.orgId });
    if (!token) return;

    const result = await postDirectMessage(
      args.recipientInstagramId,
      args.message,
      token.instagramBusinessAccountId,
      token.instagramAccessToken
    );
    if (!result.ok) {
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "instagram",
        status: "error",
        summary: `Auto-reply DM to ${args.recipientInstagramId} failed`,
        error: result.error,
      });
    }
  },
});

// ─── Social Inbox UI: listing + manual replies ─────────────────────────────────

/** Paginated, org-wide list of inbound Instagram events for the Social Inbox page. */
export const listEvents = query({
  args: { orgId: v.id("organizations"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_LEADS]);
    await requireFeature(ctx, args.orgId, "socialInbox");

    const pageResult = await ctx.db
      .query("instagramEvents")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .paginate(args.paginationOpts);

    const page = await Promise.all(
      pageResult.page.map(async (ev) => {
        const vehicle = ev.vehicleId ? await ctx.db.get(ev.vehicleId) : null;
        const lead = ev.leadId ? await ctx.db.get(ev.leadId) : null;
        const customer = ev.customerId ? await ctx.db.get(ev.customerId) : null;
        return {
          ...ev,
          vehicleSummary: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : null,
          leadStage: lead?.stage ?? null,
          senderDisplayName: resolveSenderDisplayName(ev, customer),
        };
      })
    );

    return { ...pageResult, page };
  },
});

/**
 * Paginated, org-wide list of Instagram conversations for the Social Inbox page —
 * one row per lead, combining all of that customer's comments and DMs (even across
 * different posts/vehicles) rather than one row per raw event. Convex has no native
 * GROUP BY, so this collects the org's events (already small/bounded per org) and
 * groups them in JS; pagination is a synthetic numeric offset over the grouped array.
 */
export const listConversations = query({
  args: { orgId: v.id("organizations"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_LEADS]);
    await requireFeature(ctx, args.orgId, "socialInbox");

    const events = await ctx.db
      .query("instagramEvents")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .collect();

    // Events arrive desc (newest first), so the first event pushed into each
    // lead's bucket is that conversation's most recent activity, and the Map's
    // insertion order is already recency-sorted — no extra sort needed.
    const grouped = new Map<Id<"leads">, Doc<"instagramEvents">[]>();
    for (const ev of events) {
      if (!ev.leadId) continue;
      const bucket = grouped.get(ev.leadId);
      if (bucket) bucket.push(ev);
      else grouped.set(ev.leadId, [ev]);
    }

    const conversations = Array.from(grouped.entries()).map(([leadId, evs]) => {
      const vehicleIds = new Set(evs.filter((e) => e.vehicleId).map((e) => e.vehicleId as Id<"vehicles">));
      return {
        leadId,
        latest: evs[0],
        eventCount: evs.length,
        needsReply: evs.some((e) => !e.autoRepliedAt && !e.manualRepliedAt),
        vehicleIds,
      };
    });

    const start = Number(args.paginationOpts.cursor ?? "0");
    const numItems = args.paginationOpts.numItems;
    const pageSlice = conversations.slice(start, start + numItems);

    const page = await Promise.all(
      pageSlice.map(async (c) => {
        const customer = c.latest.customerId ? await ctx.db.get(c.latest.customerId) : null;
        const lead = await ctx.db.get(c.leadId);
        const vehicle = c.latest.vehicleId ? await ctx.db.get(c.latest.vehicleId) : null;
        return {
          leadId: c.leadId,
          senderDisplayName: resolveSenderDisplayName(c.latest, customer),
          latestText: c.latest.text,
          latestKind: c.latest.kind,
          latestCreationTime: c.latest._creationTime,
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
 * Prefers the event's own captured username (comments always have one),
 * then the customer's resolved name (real once `enrichCustomerProfile` has
 * run for DM-only senders, the generic placeholder until then), then the
 * raw Instagram-scoped ID as a last resort.
 */
function resolveSenderDisplayName(
  event: Doc<"instagramEvents">,
  customer: Doc<"customers"> | null
): string {
  if (event.senderUsername) return event.senderUsername;
  if (customer) {
    const name = `${customer.firstName} ${customer.lastName}`.trim();
    if (name && name !== `${PLACEHOLDER_FIRST_NAME} ${PLACEHOLDER_LAST_NAME}`) return name;
  }
  return event.senderInstagramId;
}

/** All inbound Instagram events tied to a single lead, oldest first, for the conversation dialog. */
export const listEventsForLead = query({
  args: { orgId: v.id("organizations"), leadId: v.id("leads") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_LEADS]);
    await requireFeature(ctx, args.orgId, "socialInbox");

    const events = await ctx.db
      .query("instagramEvents")
      .withIndex("by_org_lead", (q) => q.eq("orgId", args.orgId).eq("leadId", args.leadId))
      .order("asc")
      .collect();

    return await Promise.all(
      events.map(async (ev) => {
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

/** Auth gate for the manual-reply actions below — actions can't call ctx.db/ctx.auth directly. */
export const requireReplyAccessForEvent = internalQuery({
  args: { instagramEventId: v.id("instagramEvents") },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.instagramEventId);
    if (!event) throw new ConvexError("Event not found.");
    const { user } = await requireTenantAuth(ctx, event.orgId, [PERMISSIONS.EDIT_LEADS]);
    await requireFeature(ctx, event.orgId, "socialInbox");

    const orgSettings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", event.orgId))
      .unique();

    return { event, orgSettings, userId: user._id };
  },
});

export const saveManualReply = internalMutation({
  args: {
    instagramEventId: v.id("instagramEvents"),
    manualReplyText: v.string(),
    manualRepliedByUserId: v.id("users"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.instagramEventId, {
      manualReplyText: args.manualReplyText,
      manualRepliedAt: Date.now(),
      manualRepliedByUserId: args.manualRepliedByUserId,
    });
  },
});

/** Manually replies to a specific inbound comment from the Social Inbox / lead dialog UI. */
export const replyToInstagramComment = action({
  args: { orgId: v.id("organizations"), instagramEventId: v.id("instagramEvents"), message: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const { event, orgSettings, userId } = await ctx.runQuery(
      internal.instagramEngagement.requireReplyAccessForEvent,
      { instagramEventId: args.instagramEventId }
    );
    if (event.kind !== "comment") {
      throw new ConvexError("This event is not a comment.");
    }
    if (!orgSettings?.instagramAccessToken) {
      throw new ConvexError("Instagram is not connected for this organization.");
    }
    if (!args.message.trim()) {
      throw new ConvexError("Reply cannot be empty.");
    }

    const result = await postCommentReply(event.externalId, args.message, orgSettings.instagramAccessToken);
    if (!result.ok) {
      throw new ConvexError(`Failed to reply: ${result.error}`);
    }

    await ctx.runMutation(internal.instagramEngagement.saveManualReply, {
      instagramEventId: args.instagramEventId,
      manualReplyText: args.message,
      manualRepliedByUserId: userId,
    });
  },
});

/**
 * Auth gate + data load for a manual DM send. Resolves the most recent
 * inbound DM event for the customer (Instagram DMs aren't threaded
 * per-message like comments, so this is how the UI knows the customer's
 * senderInstagramId in the first place, and purely to have somewhere to
 * record the reply for display) and the org's Instagram credentials. Keyed
 * by customerId rather than leadId since lead creation is optional —
 * a conversation can exist with no lead at all.
 */
export const requireSendDmAccess = internalQuery({
  args: { orgId: v.id("organizations"), customerId: v.id("customers") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_LEADS]);
    await requireFeature(ctx, args.orgId, "socialInbox");

    const events = await ctx.db
      .query("instagramEvents")
      .withIndex("by_org_customer", (q) => q.eq("orgId", args.orgId).eq("customerId", args.customerId))
      .order("desc")
      .collect();
    const dmEvent = events.find((e) => e.kind === "dm") ?? null;

    const orgSettings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();

    return { dmEvent, orgSettings, userId: user._id };
  },
});

/** Sends a new DM to a customer, from the Social Inbox / conversation dialog UI. */
export const sendInstagramDirectMessage = action({
  args: { orgId: v.id("organizations"), customerId: v.id("customers"), message: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const { dmEvent, orgSettings, userId } = await ctx.runQuery(
      internal.instagramEngagement.requireSendDmAccess,
      { orgId: args.orgId, customerId: args.customerId }
    );
    if (!dmEvent) {
      throw new ConvexError("No Instagram DM conversation found for this customer.");
    }
    if (!args.message.trim()) {
      throw new ConvexError("Message cannot be empty.");
    }
    if (!orgSettings?.instagramAccessToken || !orgSettings?.instagramBusinessAccountId) {
      throw new ConvexError("Instagram is not connected for this organization.");
    }

    const result = await postDirectMessage(
      dmEvent.senderInstagramId,
      args.message,
      orgSettings.instagramBusinessAccountId,
      orgSettings.instagramAccessToken
    );
    if (!result.ok) {
      throw new ConvexError(`Failed to send message: ${result.error}`);
    }

    await ctx.runMutation(internal.instagramEngagement.saveManualReply, {
      instagramEventId: dmEvent._id,
      manualReplyText: args.message,
      manualRepliedByUserId: userId,
    });
  },
});

// ─── Post-content vehicle extraction ──────────────────────────────────────────

/**
 * Fetches the caption of an Instagram media post and tries to match it against
 * the org's vehicle inventory. Called after a comment event is stored when no
 * vehicle was found via the socialPosts table (i.e. the post wasn't published
 * through AutoFlow). Best-effort — silently no-ops on API errors.
 */
export const enrichEventVehicleFromPost = internalAction({
  args: {
    orgId: v.id("organizations"),
    externalId: v.string(),
    // mediaId absent for DMs (no post to fetch) — text-only path
    mediaId: v.optional(v.string()),
    // The comment/DM text itself — tried before fetching the post caption
    text: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const vehicles = await ctx.runQuery(internal.instagramEngagement.getOrgVehicles, { orgId: args.orgId });

    // 1. Try matching from the event text (comment body or DM message).
    if (args.text) {
      const matchedId = matchVehicleFromText(args.text, vehicles);
      if (matchedId) {
        await ctx.runMutation(internal.instagramEngagement.patchEventVehicle, {
          orgId: args.orgId,
          externalId: args.externalId,
          vehicleId: matchedId,
        });
        return;
      }
      if (suggestVehiclesFromText(args.text, vehicles).length > 0) {
        await ctx.runMutation(internal.instagramEngagement.patchEventVehicleHint, {
          orgId: args.orgId,
          externalId: args.externalId,
          hintText: args.text,
          source: "message",
        });
      }
    }

    // 2. Fall back: fetch the media caption.
    if (!args.mediaId) return;
    const token = await ctx.runQuery(internal.instagramEngagement.getTokenForOrg, { orgId: args.orgId });
    if (!token) return;

    const url = new URL(`https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}/${args.mediaId}`);
    url.searchParams.set("fields", "caption");
    url.searchParams.set("access_token", token.instagramAccessToken);
    const res = await fetch(url.toString());
    if (!res.ok) return;

    const json = await res.json();
    const caption: string | undefined = json.caption;
    if (!caption) return;

    const matchedId = matchVehicleFromText(caption, vehicles);
    if (!matchedId) {
      if (suggestVehiclesFromText(caption, vehicles).length > 0) {
        await ctx.runMutation(internal.instagramEngagement.patchEventVehicleHint, {
          orgId: args.orgId,
          externalId: args.externalId,
          hintText: caption,
          source: "post",
        });
      }
      return;
    }

    await ctx.runMutation(internal.instagramEngagement.patchEventVehicle, {
      orgId: args.orgId,
      externalId: args.externalId,
      vehicleId: matchedId,
    });
  },
});

export const getOrgVehicles = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("vehicles")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
  },
});

export const patchEventVehicle = internalMutation({
  args: {
    orgId: v.id("organizations"),
    externalId: v.string(),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, args) => {
    const event = await ctx.db
      .query("instagramEvents")
      .withIndex("by_org_external", (q) => q.eq("orgId", args.orgId).eq("externalId", args.externalId))
      .unique();
    if (!event || event.vehicleId) return; // already has a vehicle — don't overwrite
    await ctx.db.patch(event._id, { vehicleId: args.vehicleId });
    // Also update the linked lead if it has no vehicle yet
    if (event.leadId) {
      const lead = await ctx.db.get(event.leadId);
      if (lead && !lead.vehicleId) {
        await ctx.db.patch(event.leadId, { vehicleId: args.vehicleId });
      }
    }
  },
});

export const patchEventVehicleHint = internalMutation({
  args: {
    orgId: v.id("organizations"),
    externalId: v.string(),
    hintText: v.string(),
    source: v.union(v.literal("message"), v.literal("post")),
  },
  handler: async (ctx, args) => {
    const event = await ctx.db
      .query("instagramEvents")
      .withIndex("by_org_external", (q) => q.eq("orgId", args.orgId).eq("externalId", args.externalId))
      .unique();
    if (!event || event.vehicleId) return;
    await ctx.db.patch(event._id, {
      vehicleMatchHintText: args.hintText.slice(0, 1000),
      vehicleMatchHintSource: args.source,
    });
  },
});
