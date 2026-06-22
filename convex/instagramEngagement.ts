import { v } from "convex/values";
import { internalMutation, internalQuery, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { notifyManagers } from "./utils/notifications";

const INSTAGRAM_GRAPH_VERSION = "v21.0";
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

/** Auto-replies to an inbound comment. Same Graph endpoint as the manual reply in socialEngagement.ts. */
export const sendCommentReply = internalAction({
  args: { orgId: v.id("organizations"), commentId: v.string(), message: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const token = await ctx.runQuery(internal.instagramEngagement.getTokenForOrg, { orgId: args.orgId });
    if (!token) return;

    const url = new URL(`https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}/${args.commentId}/replies`);
    url.searchParams.set("message", args.message);
    url.searchParams.set("access_token", token.instagramAccessToken);
    const res = await fetch(url.toString(), { method: "POST" });
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "instagram",
        status: "error",
        summary: `Auto-reply to comment ${args.commentId} failed`,
        error: json?.error?.message ?? res.statusText,
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

    const url = new URL(
      `https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}/${token.instagramBusinessAccountId}/messages`
    );
    url.searchParams.set("access_token", token.instagramAccessToken);
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: args.recipientInstagramId },
        message: { text: args.message },
      }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "instagram",
        status: "error",
        summary: `Auto-reply DM to ${args.recipientInstagramId} failed`,
        error: json?.error?.message ?? res.statusText,
      });
    }
  },
});
