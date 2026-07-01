import { v, ConvexError } from "convex/values";
import { action, internalQuery, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { requireFeature } from "./subscriptions";

const INSTAGRAM_GRAPH_VERSION = "v21.0";

// ─── Internal (auth gates for the public actions below) ───────────────────────
// Actions don't have `ctx.db`/`ctx.auth` directly — they call into an
// internalQuery to perform the permission check and load the data needed to
// call Instagram's API, mirroring the pattern in adminUsers.ts.

export const requireViewAccessForAction = internalQuery({
  args: { socialPostId: v.id("socialPosts") },
  handler: async (ctx, args) => {
    const post = await ctx.db.get(args.socialPostId);
    if (!post) throw new ConvexError("Post not found.");
    await requireTenantAuth(ctx, post.orgId, [PERMISSIONS.VIEW_VEHICLE_INFO]);
    await requireFeature(ctx, post.orgId, "socialInbox");

    const orgSettings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", post.orgId))
      .unique();

    return { post, orgSettings };
  },
});

export const requireEditAccessForAction = internalQuery({
  args: { socialPostId: v.id("socialPosts") },
  handler: async (ctx, args) => {
    const post = await ctx.db.get(args.socialPostId);
    if (!post) throw new ConvexError("Post not found.");
    await requireTenantAuth(ctx, post.orgId, [PERMISSIONS.EDIT_VEHICLES]);
    await requireFeature(ctx, post.orgId, "socialInbox");

    const orgSettings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", post.orgId))
      .unique();

    return { post, orgSettings };
  },
});

export const saveEngagement = internalMutation({
  args: {
    socialPostId: v.id("socialPosts"),
    likeCount: v.optional(v.number()),
    commentsCount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.socialPostId, {
      likeCount: args.likeCount,
      commentsCount: args.commentsCount,
      engagementSyncedAt: Date.now(),
    });
  },
});

// ─── Public ───────────────────────────────────────────────────────────────────

/**
 * Pulls like_count/comments_count for a published post. These are basic IG
 * Media fields covered by `instagram_business_basic`, the scope this app
 * already requests — no extra OAuth consent needed for engagement counts.
 */
export const refreshEngagement = action({
  args: { socialPostId: v.id("socialPosts") },
  handler: async (ctx, args): Promise<{ likeCount?: number; commentsCount?: number }> => {
    const { post, orgSettings } = await ctx.runQuery(internal.socialEngagement.requireViewAccessForAction, {
      socialPostId: args.socialPostId,
    });

    if (!post.externalPostId || !orgSettings?.instagramAccessToken) {
      throw new ConvexError("This post hasn't been published to Instagram yet.");
    }

    const url = new URL(`https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}/${post.externalPostId}`);
    url.searchParams.set("fields", "like_count,comments_count");
    url.searchParams.set("access_token", orgSettings.instagramAccessToken);
    const res = await fetch(url.toString());
    const json = await res.json();
    if (!res.ok) {
      throw new ConvexError(`Failed to fetch engagement: ${json?.error?.message ?? res.statusText}`);
    }

    await ctx.runMutation(internal.socialEngagement.saveEngagement, {
      socialPostId: args.socialPostId,
      likeCount: json.like_count,
      commentsCount: json.comments_count,
    });

    return { likeCount: json.like_count, commentsCount: json.comments_count };
  },
});

/**
 * Lists comments on a published post. Requires `instagram_business_manage_comments`
 * — orgs connected before that scope was added must reconnect Instagram first.
 */
export const listComments = action({
  args: { socialPostId: v.id("socialPosts") },
  handler: async (
    ctx,
    args
  ): Promise<Array<{ id: string; text: string; username?: string; timestamp?: string; hidden?: boolean }>> => {
    const { post, orgSettings } = await ctx.runQuery(internal.socialEngagement.requireViewAccessForAction, {
      socialPostId: args.socialPostId,
    });

    if (!post.externalPostId || !orgSettings?.instagramAccessToken) {
      throw new ConvexError("This post hasn't been published to Instagram yet.");
    }

    const url = new URL(`https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}/${post.externalPostId}/comments`);
    url.searchParams.set("fields", "id,text,username,timestamp,hidden");
    url.searchParams.set("access_token", orgSettings.instagramAccessToken);
    const res = await fetch(url.toString());
    const json = await res.json();
    if (!res.ok) {
      throw new ConvexError(
        `Failed to load comments: ${json?.error?.message ?? res.statusText}. If Instagram was connected before comment permissions were added, reconnect it in Settings > Integrations.`
      );
    }

    return json.data ?? [];
  },
});

/** Replies to a comment on a published post. */
export const replyToComment = action({
  args: { socialPostId: v.id("socialPosts"), commentId: v.string(), message: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const { orgSettings } = await ctx.runQuery(internal.socialEngagement.requireEditAccessForAction, {
      socialPostId: args.socialPostId,
    });
    if (!orgSettings?.instagramAccessToken) {
      throw new ConvexError("Instagram is not connected for this organization.");
    }
    if (!args.message.trim()) {
      throw new ConvexError("Reply message cannot be empty.");
    }

    const url = new URL(`https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}/${args.commentId}/replies`);
    url.searchParams.set("message", args.message);
    url.searchParams.set("access_token", orgSettings.instagramAccessToken);
    const res = await fetch(url.toString(), { method: "POST" });
    const json = await res.json();
    if (!res.ok || !json.id) {
      throw new ConvexError(`Failed to reply: ${json?.error?.message ?? res.statusText}`);
    }
  },
});

/** Hides or unhides a comment on a published post. */
export const setCommentHidden = action({
  args: { socialPostId: v.id("socialPosts"), commentId: v.string(), hide: v.boolean() },
  handler: async (ctx, args): Promise<void> => {
    const { orgSettings } = await ctx.runQuery(internal.socialEngagement.requireEditAccessForAction, {
      socialPostId: args.socialPostId,
    });
    if (!orgSettings?.instagramAccessToken) {
      throw new ConvexError("Instagram is not connected for this organization.");
    }

    const url = new URL(`https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}/${args.commentId}`);
    url.searchParams.set("hide", String(args.hide));
    url.searchParams.set("access_token", orgSettings.instagramAccessToken);
    const res = await fetch(url.toString(), { method: "POST" });
    const json = await res.json();
    if (!res.ok || json.success !== true) {
      throw new ConvexError(`Failed to update comment: ${json?.error?.message ?? res.statusText}`);
    }
  },
});
