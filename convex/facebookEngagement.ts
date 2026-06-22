import { v, ConvexError } from "convex/values";
import { internalMutation, internalQuery, internalAction, action } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { notifyManagers } from "./utils/notifications";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { postCommentReply, postDirectMessage } from "./utils/facebookApi";

const AUTO_REPLY_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 1 reply per sender per 24h

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Reverse-lookup used by the webhook: maps the Page ID Meta sends in entry[].id back to an org. */
export const getSettingsByFacebookPageId = internalQuery({
  args: { facebookPageId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("orgSettings")
      .withIndex("by_facebook_page_id", (q) => q.eq("facebookPageId", args.facebookPageId))
      .unique();
  },
});

/**
 * Finds or creates a customer for an inbound comment/DM, opens a lead if
 * none is open, notifies managers, and — if eligible — picks the next
 * round-robin auto-reply message. Mirrors
 * `instagramEngagement.handleIncomingInstagramEvent`'s shape exactly.
 *
 * Returns null if this externalId was already processed (Meta retries
 * webhook deliveries), otherwise returns what the caller (the HTTP action)
 * needs to actually send the auto-reply, since mutations can't fetch().
 */
export const handleIncomingFacebookEvent = internalMutation({
  args: {
    orgId: v.id("organizations"),
    // For "comment" events, externalId IS the comment id (used directly to
    // post a reply via /{commentId}/comments). For "dm" events, externalId is
    // the message id (used only for dedup — replies target senderFacebookId).
    kind: v.union(v.literal("comment"), v.literal("dm")),
    externalId: v.string(),
    senderFacebookId: v.string(),
    senderName: v.optional(v.string()),
    text: v.optional(v.string()),
    // The Facebook post ID a comment was made on — absent for plain-text
    // DMs. Used to link the lead back to the vehicle that post was about,
    // via socialPosts.externalPostId.
    mediaId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args
  ): Promise<{
    shouldAutoReply: boolean;
    replyText?: string;
    leadId?: Id<"leads">;
    customerId?: Id<"customers">;
  } | null> => {
    const { orgId, kind, externalId, senderFacebookId, senderName, text, mediaId } = args;

    const duplicate = await ctx.db
      .query("facebookEvents")
      .withIndex("by_org_external", (q) => q.eq("orgId", orgId).eq("externalId", externalId))
      .unique();
    if (duplicate) return null;

    // Find or create customer
    const customers = await ctx.db
      .query("customers")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect();

    let customer: Doc<"customers"> | null =
      customers.find((c) => c.facebookUserId === senderFacebookId) ?? null;

    if (!customer) {
      const nameParts = (senderName ?? "Facebook Contact").split(" ");
      const customerId = await ctx.db.insert("customers", {
        orgId,
        firstName: nameParts[0] ?? "Facebook",
        lastName: nameParts.slice(1).join(" ") || "Contact",
        facebookUserId: senderFacebookId,
      });
      customer = await ctx.db.get(customerId);
    }
    if (!customer) return null;

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
    // DMs), default true. Off doesn't mean ignored: the event is still
    // captured below and still eligible for auto-reply, it just doesn't
    // produce a Lead in the pipeline or a notification.
    const leadCreationEnabled =
      kind === "comment"
        ? settings?.facebookLeadFromCommentsEnabled !== false
        : settings?.facebookLeadFromDmsEnabled !== false;

    const label = kind === "dm" ? "Facebook DM" : "Facebook Comment";
    let leadId: Id<"leads"> | undefined;
    if (leadCreationEnabled) {
      const existingLeads = await ctx.db
        .query("leads")
        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customer!._id))
        .collect();
      const openLead = existingLeads.find((l) => !l.isDeleted && l.stage !== "WON" && l.stage !== "LOST");
      leadId = openLead?._id;

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
          `New ${label.toLowerCase()} from ${senderName ?? senderFacebookId}.`,
          `/${orgId}/leads?highlightId=${leadId}`
        );
      }
    }

    // Auto-reply eligibility: enabled, has messages, and sender not replied-to in the last 24h
    const messages = settings?.facebookAutoReplyMessages ?? [];
    let shouldAutoReply = false;
    let replyText: string | undefined;

    if (settings?.facebookAutoReplyEnabled && messages.length > 0) {
      const recentEvents = await ctx.db
        .query("facebookEvents")
        .withIndex("by_org_sender", (q) => q.eq("orgId", orgId).eq("senderFacebookId", senderFacebookId))
        .collect();
      const repliedRecently = recentEvents.some(
        (e) => e.autoRepliedAt && e.autoRepliedAt > Date.now() - AUTO_REPLY_COOLDOWN_MS
      );

      if (!repliedRecently) {
        const nextIndex = ((settings.facebookAutoReplyLastIndex ?? -1) + 1) % messages.length;
        replyText = messages[nextIndex];
        shouldAutoReply = true;
        await ctx.db.patch(settings._id, { facebookAutoReplyLastIndex: nextIndex });
      }
    }

    await ctx.db.insert("facebookEvents", {
      orgId,
      externalId,
      kind,
      senderFacebookId,
      senderName,
      customerId: customer._id,
      leadId,
      vehicleId,
      text,
      autoRepliedAt: shouldAutoReply ? Date.now() : undefined,
      autoReplyText: shouldAutoReply ? replyText : undefined,
    });

    return { shouldAutoReply, replyText, leadId, customerId: customer._id };
  },
});

export const getTokenForOrg = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
    if (!settings?.facebookPageAccessToken || !settings?.facebookPageId) return null;
    return {
      facebookPageAccessToken: settings.facebookPageAccessToken,
      facebookPageId: settings.facebookPageId,
    };
  },
});

// ─── Outbound (Graph API calls — actions only, mutations can't fetch) ─────────

/** Auto-replies to an inbound comment. Same Graph endpoint as the manual reply below. */
export const sendCommentReply = internalAction({
  args: { orgId: v.id("organizations"), commentId: v.string(), message: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const token = await ctx.runQuery(internal.facebookEngagement.getTokenForOrg, { orgId: args.orgId });
    if (!token) return;

    const result = await postCommentReply(args.commentId, args.message, token.facebookPageAccessToken);
    if (!result.ok) {
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "facebook",
        status: "error",
        summary: `Auto-reply to comment ${args.commentId} failed`,
        error: result.error,
      });
    }
  },
});

/** Auto-replies to an inbound DM via the Messenger API. */
export const sendDirectMessage = internalAction({
  args: { orgId: v.id("organizations"), recipientFacebookId: v.string(), message: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const token = await ctx.runQuery(internal.facebookEngagement.getTokenForOrg, { orgId: args.orgId });
    if (!token) return;

    const result = await postDirectMessage(
      args.recipientFacebookId,
      args.message,
      token.facebookPageId,
      token.facebookPageAccessToken
    );
    if (!result.ok) {
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "facebook",
        status: "error",
        summary: `Auto-reply DM to ${args.recipientFacebookId} failed`,
        error: result.error,
      });
    }
  },
});

// ─── Social Inbox: manual replies ──────────────────────────────────────────────

/** Auth gate for the manual-reply actions below — actions can't call ctx.db/ctx.auth directly. */
export const requireReplyAccessForEvent = internalQuery({
  args: { facebookEventId: v.id("facebookEvents") },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.facebookEventId);
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
    facebookEventId: v.id("facebookEvents"),
    manualReplyText: v.string(),
    manualRepliedByUserId: v.id("users"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.facebookEventId, {
      manualReplyText: args.manualReplyText,
      manualRepliedAt: Date.now(),
      manualRepliedByUserId: args.manualRepliedByUserId,
    });
  },
});

/** Manually replies to a specific inbound comment from the Social Inbox / lead dialog UI. */
export const replyToFacebookComment = action({
  args: { orgId: v.id("organizations"), facebookEventId: v.id("facebookEvents"), message: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const { event, orgSettings, userId } = await ctx.runQuery(
      internal.facebookEngagement.requireReplyAccessForEvent,
      { facebookEventId: args.facebookEventId }
    );
    if (event.kind !== "comment") {
      throw new ConvexError("This event is not a comment.");
    }
    if (!orgSettings?.facebookPageAccessToken) {
      throw new ConvexError("Facebook is not connected for this organization.");
    }
    if (!args.message.trim()) {
      throw new ConvexError("Reply cannot be empty.");
    }

    const result = await postCommentReply(event.externalId, args.message, orgSettings.facebookPageAccessToken);
    if (!result.ok) {
      throw new ConvexError(`Failed to reply: ${result.error}`);
    }

    await ctx.runMutation(internal.facebookEngagement.saveManualReply, {
      facebookEventId: args.facebookEventId,
      manualReplyText: args.message,
      manualRepliedByUserId: userId,
    });
  },
});

/**
 * Auth gate + data load for a manual DM send. Resolves the most recent
 * inbound DM event for the customer (Messenger DMs aren't threaded
 * per-message like comments, so this is how the UI knows the customer's
 * senderFacebookId in the first place) and the org's Facebook credentials.
 * Keyed by customerId rather than leadId since lead creation is optional —
 * a conversation can exist with no lead at all.
 */
export const requireSendDmAccess = internalQuery({
  args: { orgId: v.id("organizations"), customerId: v.id("customers") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_LEADS]);

    const events = await ctx.db
      .query("facebookEvents")
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
export const sendFacebookDirectMessage = action({
  args: { orgId: v.id("organizations"), customerId: v.id("customers"), message: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const { dmEvent, orgSettings, userId } = await ctx.runQuery(
      internal.facebookEngagement.requireSendDmAccess,
      { orgId: args.orgId, customerId: args.customerId }
    );
    if (!dmEvent) {
      throw new ConvexError("No Facebook DM conversation found for this customer.");
    }
    if (!args.message.trim()) {
      throw new ConvexError("Message cannot be empty.");
    }
    if (!orgSettings?.facebookPageAccessToken || !orgSettings?.facebookPageId) {
      throw new ConvexError("Facebook is not connected for this organization.");
    }

    const result = await postDirectMessage(
      dmEvent.senderFacebookId,
      args.message,
      orgSettings.facebookPageId,
      orgSettings.facebookPageAccessToken
    );
    if (!result.ok) {
      throw new ConvexError(`Failed to send message: ${result.error}`);
    }

    await ctx.runMutation(internal.facebookEngagement.saveManualReply, {
      facebookEventId: dmEvent._id,
      manualReplyText: args.message,
      manualRepliedByUserId: userId,
    });
  },
});
