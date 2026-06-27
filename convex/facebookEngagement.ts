import { v, ConvexError } from "convex/values";
import { internalMutation, internalQuery, internalAction, action, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { notifyManagers, notifyUser } from "./utils/notifications";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { postCommentReply, postDirectMessage, fetchFbConversationMessages, FACEBOOK_GRAPH_VERSION } from "./utils/facebookApi";
import { matchIntent, detectLocale } from "./utils/smartReplyIntent";
import { buildSmartReplyText } from "./utils/smartReplyBuilder";
import { matchVehicleFromText, suggestVehiclesFromText } from "./utils/vehicleTextMatch";
import { attachSharedMobileNumberToCustomer, extractSharedMobileNumber } from "./utils/socialMobile";
import { nextGeneratedLeadAssignee } from "./utils/leadAssignment";

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
    sourceSurface: v.optional(v.union(v.literal("post"), v.literal("reel"), v.literal("story"), v.literal("ad"), v.literal("unknown"))),
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
    vehicleId?: Id<"vehicles">;
  } | null> => {
    const { orgId, kind, externalId, senderFacebookId, senderName, text, mediaId, sourceSurface } = args;
    const sharedMobileNumber = kind === "dm" ? extractSharedMobileNumber(text) : null;

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

    if (kind === "dm") {
      await attachSharedMobileNumberToCustomer(ctx, orgId, customer, sharedMobileNumber);
    }

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
        : settings?.facebookLeadFromDmsEnabled !== false
          && (!(settings?.facebookLeadFromDmsRequiresMobile ?? false) || Boolean(sharedMobileNumber));

    const surfaceLabel =
      sourceSurface === "reel" ? " Reel"
        : sourceSurface === "story" ? " Story"
          : sourceSurface === "ad" ? " Ad"
            : "";
    const label = kind === "dm" ? `Facebook${surfaceLabel} DM` : `Facebook${surfaceLabel} Comment`;
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
          { platform: label, senderName: senderName ?? senderFacebookId },
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
      ? (settings?.facebookSmartReplyForDmsEnabled ?? settings?.facebookSmartReplyEnabled ?? false)
      : (settings?.facebookSmartReplyForCommentsEnabled ?? settings?.facebookSmartReplyEnabled ?? false);

    if (smartReplyEnabled && text) {
      const intent = matchIntent(text);

      if (intent === "complaint") {
        suppressCannedReply = true;
        await notifyManagers(
          ctx,
          orgId,
          "social.possible_complaint",
          { platform: "Facebook", senderName: senderName ?? senderFacebookId, excerpt: text.slice(0, 200) },
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
    const messages = settings?.facebookAutoReplyMessages ?? [];

    const cannedEnabled = kind === "dm"
      ? (settings?.facebookAutoReplyForDmsEnabled ?? settings?.facebookAutoReplyEnabled ?? false)
      : (settings?.facebookAutoReplyForCommentsEnabled ?? settings?.facebookAutoReplyEnabled ?? false);

    if (!shouldAutoReply && !suppressCannedReply && cannedEnabled && messages.length > 0) {
      const recentEvents = await ctx.db
        .query("facebookEvents")
        .withIndex("by_org_sender", (q) => q.eq("orgId", orgId).eq("senderFacebookId", senderFacebookId))
        .collect();
      const repliedRecently = recentEvents.some(
        (e) => e.autoRepliedAt && e.autoRepliedAt > Date.now() - AUTO_REPLY_COOLDOWN_MS
      );

      if (!repliedRecently && settings) {
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
      postId: mediaId,
      sourceSurface,
      autoRepliedAt: shouldAutoReply ? Date.now() : undefined,
      autoReplyText: shouldAutoReply ? replyText : undefined,
      autoReplySource: shouldAutoReply ? (smartReplySource ? "smart" : "canned") : undefined,
    });

    // For DMs, also store in facebookMessages for the full-thread view.
    if (kind === "dm") {
      const msgExists = await ctx.db
        .query("facebookMessages")
        .withIndex("by_org_fb_message", (q) => q.eq("orgId", orgId).eq("fbMessageId", externalId))
        .unique();
      if (!msgExists) {
        await ctx.db.insert("facebookMessages", {
          orgId,
          customerId: customer._id,
          direction: "in",
          text,
          timestamp: Date.now(),
          fbMessageId: externalId,
        });
      }
    }

    return { shouldAutoReply, replyText, smartReplyVisibility, leadId, customerId: customer._id, vehicleId };
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

    // Store outbound message in facebookMessages for the full-thread view.
    if (result.messageId) {
      await ctx.runMutation(internal.facebookEngagement.storeFbMessage, {
        orgId: args.orgId,
        customerId: args.customerId,
        direction: "out",
        text: args.message,
        timestamp: Date.now(),
        fbMessageId: result.messageId,
        sentByUserId: userId,
      });
    }
  },
});

// ─── Post-content vehicle extraction ──────────────────────────────────────────

/**
 * Fetches the message/caption of a Facebook post and tries to match it against
 * the org's vehicle inventory. Called after a comment event is stored when no
 * vehicle was found via the socialPosts table (i.e. the post wasn't published
 * through AutoFlow). Best-effort — silently no-ops on API errors.
 */
export const enrichEventVehicleFromPost = internalAction({
  args: {
    orgId: v.id("organizations"),
    externalId: v.string(),
    // postId absent for DMs (no post to fetch) — text-only path
    postId: v.optional(v.string()),
    // The comment/DM text itself — tried before fetching the post caption
    text: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const vehicles = await ctx.runQuery(internal.facebookEngagement.getOrgVehicles, { orgId: args.orgId });

    // 1. Try matching from the event text (comment body or DM message).
    if (args.text) {
      const matchedId = matchVehicleFromText(args.text, vehicles);
      if (matchedId) {
        await ctx.runMutation(internal.facebookEngagement.patchEventVehicle, {
          orgId: args.orgId,
          externalId: args.externalId,
          vehicleId: matchedId,
        });
        return;
      }
      if (suggestVehiclesFromText(args.text, vehicles).length > 0) {
        await ctx.runMutation(internal.facebookEngagement.patchEventVehicleHint, {
          orgId: args.orgId,
          externalId: args.externalId,
          hintText: args.text,
          source: "message",
        });
      }
    }

    // 2. Fall back: fetch every text-bearing field Meta exposes on the post.
    if (!args.postId) return;
    const token = await ctx.runQuery(internal.facebookEngagement.getTokenForOrg, { orgId: args.orgId });
    if (!token) return;

    const fields = [
      "message",
      "story",
      "name",
      "caption",
      "description",
      "call_to_action",
      "properties",
      "attachments{title,description,name,caption,url,unshimmed_url,subattachments{title,description,name,caption,url,unshimmed_url}}",
      "child_attachments{title,description,name,caption,url,call_to_action}",
    ].join(",");

    const url = new URL(`https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${args.postId}`);
    url.searchParams.set("fields", fields);
    url.searchParams.set("access_token", token.facebookPageAccessToken);
    const res = await fetch(url.toString());
    if (!res.ok) return;

    const json = await res.json();
    const parts: string[] = [];

    for (const f of ["message", "story", "name", "caption", "description"] as const) {
      if (json[f]) parts.push(json[f]);
    }

    const cta = json.call_to_action?.value ?? {};
    if (cta.page_welcome_message) parts.push(cta.page_welcome_message);
    if (cta.link) {
      parts.push(cta.link);
      try {
        const waText = new URL(cta.link).searchParams.get("text");
        if (waText) parts.push(decodeURIComponent(waText));
      } catch { /* not a URL */ }
    }

    for (const prop of json.properties?.data ?? []) {
      if (prop.name) parts.push(prop.name);
      if (prop.text) parts.push(prop.text);
    }

    const collectAtt = (att: Record<string, unknown>) => {
      for (const f of ["title", "description", "name", "caption"] as const) {
        if (att[f]) parts.push(att[f] as string);
      }
      for (const f of ["url", "unshimmed_url"] as const) {
        const u = att[f] as string | undefined;
        if (u) {
          parts.push(u);
          try {
            const waText = new URL(u).searchParams.get("text");
            if (waText) parts.push(decodeURIComponent(waText));
          } catch { /* not a URL */ }
        }
      }
      const callToAction = att.call_to_action as
        | { value?: { page_welcome_message?: string; link?: string } }
        | undefined;
      const subCta = callToAction?.value;
      if (subCta?.page_welcome_message) parts.push(subCta.page_welcome_message);
      if (subCta?.link) {
        try {
          const waText = new URL(subCta.link).searchParams.get("text");
          if (waText) parts.push(decodeURIComponent(waText));
        } catch { /* not a URL */ }
      }
    };

    for (const att of json.attachments?.data ?? []) {
      collectAtt(att);
      for (const sub of att.subattachments?.data ?? []) collectAtt(sub);
    }
    for (const att of json.child_attachments?.data ?? []) collectAtt(att);

    const combined = parts.join(" ");
    if (!combined.trim()) return;

    const matchedId = matchVehicleFromText(combined, vehicles);
    if (!matchedId) {
      if (suggestVehiclesFromText(combined, vehicles).length > 0) {
        await ctx.runMutation(internal.facebookEngagement.patchEventVehicleHint, {
          orgId: args.orgId,
          externalId: args.externalId,
          hintText: combined,
          source: "post",
        });
      }
      return;
    }

    await ctx.runMutation(internal.facebookEngagement.patchEventVehicle, {
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

// ─── Facebook Message Thread (full conversation history) ──────────────────────

/** Inserts one row into facebookMessages, deduping by fbMessageId. */
export const storeFbMessage = internalMutation({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    direction: v.union(v.literal("in"), v.literal("out")),
    text: v.optional(v.string()),
    timestamp: v.number(),
    fbMessageId: v.string(),
    fbConversationId: v.optional(v.string()),
    sentByUserId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("facebookMessages")
      .withIndex("by_org_fb_message", (q) => q.eq("orgId", args.orgId).eq("fbMessageId", args.fbMessageId))
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("facebookMessages", args);
  },
});

/**
 * Fetches the full Messenger conversation history for a customer from the
 * Graph API and stores every message in facebookMessages. Skips non-text
 * messages (reactions, etc.). Safe to run multiple times — dedupes by fbMessageId.
 */
export const syncFbConversationHistory = internalAction({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    senderFacebookId: v.string(),
  },
  handler: async (ctx, args): Promise<{ synced: number }> => {
    const token = await ctx.runQuery(internal.facebookEngagement.getTokenForOrg, { orgId: args.orgId });
    if (!token) return { synced: 0 };

    const { conversationId, messages } = await fetchFbConversationMessages(
      args.senderFacebookId,
      token.facebookPageId,
      token.facebookPageAccessToken
    );

    let synced = 0;
    for (const msg of messages) {
      if (!msg.message) continue;
      const direction: "in" | "out" = msg.from.id === token.facebookPageId ? "out" : "in";
      const timestamp = new Date(msg.created_time).getTime();
      await ctx.runMutation(internal.facebookEngagement.storeFbMessage, {
        orgId: args.orgId,
        customerId: args.customerId,
        direction,
        text: msg.message,
        timestamp,
        fbMessageId: msg.id,
        fbConversationId: conversationId ?? undefined,
      });
      synced++;
    }
    return { synced };
  },
});

/**
 * Auth-gated history sync — called from the Social Inbox conversation dialog.
 * Looks up the customer's PSID from the most recent facebookEvent DM, then
 * delegates to syncFbConversationHistory.
 */
export const fetchFbConversationHistory = action({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
  },
  handler: async (ctx, args): Promise<{ synced: number }> => {
    const { dmEvent } = await ctx.runQuery(internal.facebookEngagement.requireSendDmAccess, {
      orgId: args.orgId,
      customerId: args.customerId,
    });
    if (!dmEvent) return { synced: 0 };

    return ctx.runAction(internal.facebookEngagement.syncFbConversationHistory, {
      orgId: args.orgId,
      customerId: args.customerId,
      senderFacebookId: dmEvent.senderFacebookId,
    });
  },
});

/** Returns all Facebook DM messages for a customer, oldest-first. */
export const listFbMessages = query({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_LEADS]);
    return await ctx.db
      .query("facebookMessages")
      .withIndex("by_org_customer_ts", (q) => q.eq("orgId", args.orgId).eq("customerId", args.customerId))
      .order("asc")
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
      .query("facebookEvents")
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
      .query("facebookEvents")
      .withIndex("by_org_external", (q) => q.eq("orgId", args.orgId).eq("externalId", args.externalId))
      .unique();
    if (!event || event.vehicleId) return;
    await ctx.db.patch(event._id, {
      vehicleMatchHintText: args.hintText.slice(0, 1000),
      vehicleMatchHintSource: args.source,
    });
  },
});
