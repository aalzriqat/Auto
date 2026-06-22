import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation, internalQuery, internalAction, query, action } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { notifyManagers } from "./utils/notifications";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { postCommentReply, postDirectMessage } from "./utils/instagramApi";

const AUTO_REPLY_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 1 reply per sender per 24h

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
  ): Promise<{ shouldAutoReply: boolean; replyText?: string; leadId?: Id<"leads"> } | null> => {
    const { orgId, kind, externalId, senderInstagramId, senderUsername, text, mediaId } = args;

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
      const nameParts = (senderUsername ?? "Instagram Contact").split(" ");
      const customerId = await ctx.db.insert("customers", {
        orgId,
        firstName: nameParts[0] ?? "Instagram",
        lastName: nameParts.slice(1).join(" ") || "Contact",
        instagramUserId: senderInstagramId,
      });
      customer = await ctx.db.get(customerId);
    }
    if (!customer) return null;

    // Find or create an open lead
    const existingLeads = await ctx.db
      .query("leads")
      .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customer!._id))
      .collect();

    const openLead = existingLeads.find((l) => !l.isDeleted && l.stage !== "WON" && l.stage !== "LOST");

    let vehicleId: Id<"vehicles"> | undefined;
    if (mediaId) {
      const socialPost = await ctx.db
        .query("socialPosts")
        .withIndex("by_external_post_id", (q) => q.eq("externalPostId", mediaId))
        .filter((q) => q.eq(q.field("orgId"), orgId))
        .first();
      vehicleId = socialPost?.vehicleId;
    }

    const label = kind === "dm" ? "Instagram DM" : "Instagram Comment";
    let leadId = openLead?._id;
    if (!leadId) {
      leadId = await ctx.db.insert("leads", {
        orgId,
        customerId: customer._id,
        vehicleId,
        source: label,
        stage: "NEW",
        notes: text ? `First ${label}: "${text.slice(0, 200)}"` : `Lead created from ${label}`,
      });

      await notifyManagers(
        ctx,
        orgId,
        `New ${label} Lead`,
        `New ${label.toLowerCase()} from ${senderUsername ?? senderInstagramId}.`,
        `/${orgId}/leads?highlightId=${leadId}`
      );
    }

    // Auto-reply eligibility: enabled, has messages, and sender not replied-to in the last 24h
    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .unique();

    const messages = settings?.instagramAutoReplyMessages ?? [];
    let shouldAutoReply = false;
    let replyText: string | undefined;

    if (settings?.instagramAutoReplyEnabled && messages.length > 0) {
      const recentEvents = await ctx.db
        .query("instagramEvents")
        .withIndex("by_org_sender", (q) => q.eq("orgId", orgId).eq("senderInstagramId", senderInstagramId))
        .collect();
      const repliedRecently = recentEvents.some(
        (e) => e.autoRepliedAt && e.autoRepliedAt > Date.now() - AUTO_REPLY_COOLDOWN_MS
      );

      if (!repliedRecently) {
        const nextIndex = ((settings.instagramAutoReplyLastIndex ?? -1) + 1) % messages.length;
        replyText = messages[nextIndex];
        shouldAutoReply = true;
        await ctx.db.patch(settings._id, { instagramAutoReplyLastIndex: nextIndex });
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
      autoRepliedAt: shouldAutoReply ? Date.now() : undefined,
      autoReplyText: shouldAutoReply ? replyText : undefined,
    });

    return { shouldAutoReply, replyText, leadId };
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

    const pageResult = await ctx.db
      .query("instagramEvents")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .paginate(args.paginationOpts);

    const page = await Promise.all(
      pageResult.page.map(async (ev) => {
        const vehicle = ev.vehicleId ? await ctx.db.get(ev.vehicleId) : null;
        const lead = ev.leadId ? await ctx.db.get(ev.leadId) : null;
        return {
          ...ev,
          vehicleSummary: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : null,
          leadStage: lead?.stage ?? null,
        };
      })
    );

    return { ...pageResult, page };
  },
});

/** All inbound Instagram events tied to a single lead, oldest first, for the conversation dialog. */
export const listEventsForLead = query({
  args: { orgId: v.id("organizations"), leadId: v.id("leads") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_LEADS]);

    return await ctx.db
      .query("instagramEvents")
      .withIndex("by_org_lead", (q) => q.eq("orgId", args.orgId).eq("leadId", args.leadId))
      .order("asc")
      .collect();
  },
});

/** Auth gate for the manual-reply actions below — actions can't call ctx.db/ctx.auth directly. */
export const requireReplyAccessForEvent = internalQuery({
  args: { instagramEventId: v.id("instagramEvents") },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.instagramEventId);
    if (!event) throw new ConvexError("Event not found.");
    const { user } = await requireTenantAuth(ctx, event.orgId, [PERMISSIONS.EDIT_LEADS]);

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
 * inbound DM event for the lead (Instagram DMs aren't threaded per-message
 * like comments, so this is how the UI knows the customer's
 * senderInstagramId in the first place, and purely to have somewhere to
 * record the reply for display) and the org's Instagram credentials.
 */
export const requireSendDmAccess = internalQuery({
  args: { orgId: v.id("organizations"), leadId: v.id("leads") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_LEADS]);

    const events = await ctx.db
      .query("instagramEvents")
      .withIndex("by_org_lead", (q) => q.eq("orgId", args.orgId).eq("leadId", args.leadId))
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

/** Sends a new DM to the customer tied to a lead, from the Social Inbox / lead dialog UI. */
export const sendInstagramDirectMessage = action({
  args: { orgId: v.id("organizations"), leadId: v.id("leads"), message: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const { dmEvent, orgSettings, userId } = await ctx.runQuery(
      internal.instagramEngagement.requireSendDmAccess,
      { orgId: args.orgId, leadId: args.leadId }
    );
    if (!dmEvent) {
      throw new ConvexError("No Instagram DM conversation found for this lead.");
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
