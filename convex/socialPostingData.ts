import { v, ConvexError } from "convex/values";
import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyUser } from "./utils/notifications";
import { rateLimiter } from "./rateLimit";
import { requireFeature } from "./subscriptions";

// ─── Public ───────────────────────────────────────────────────────────────────

/**
 * Queues a vehicle to be posted to Instagram or Facebook. Inserts a PENDING
 * row and hands off to the platform-specific publish action — Instagram's
 * container → poll → publish flow and Facebook's photo/feed calls can both
 * take a moment and shouldn't block this mutation or risk failing alongside
 * an unrelated vehicle edit.
 */
export const requestPost = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    platform: v.union(v.literal("instagram"), v.literal("facebook")),
    caption: v.string(),
    imageStorageIds: v.array(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const limitStatus = await rateLimiter.limit(ctx, "socialPosting", { key: args.orgId });
    if (!limitStatus.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(limitStatus.retryAfter / 1000)}s`);
    }

    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);
    await requireFeature(ctx, args.orgId, "socialInbox");

    if (args.imageStorageIds.length === 0) {
      throw new ConvexError("Select at least one photo to post.");
    }

    const orgSettings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
    if (args.platform === "instagram") {
      if (!orgSettings?.instagramAccessToken || !orgSettings?.instagramBusinessAccountId) {
        throw new ConvexError("Instagram is not connected — go to Settings > Integrations to connect it.");
      }
    } else {
      if (!orgSettings?.facebookPageAccessToken || !orgSettings?.facebookPageId) {
        throw new ConvexError("Facebook is not connected — go to Settings > Integrations to connect it.");
      }
    }

    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.isDeleted || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }

    const vehicleImageIds = new Set((vehicle.imageIds ?? []).map((id) => id.toString()));
    for (const storageId of args.imageStorageIds) {
      if (!vehicleImageIds.has(storageId.toString())) {
        throw new ConvexError("One of the selected photos doesn't belong to this vehicle.");
      }
    }

    const socialPostId = await ctx.db.insert("socialPosts", {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      platform: args.platform,
      status: "PENDING",
      caption: args.caption,
      imageStorageIds: args.imageStorageIds,
      triggeredBy: "manual",
      requestedBy: user._id,
      requestedAt: Date.now(),
    });

    if (args.platform === "instagram") {
      await ctx.scheduler.runAfter(0, internal.socialPosting.publishToInstagram, { socialPostId });
    } else {
      await ctx.scheduler.runAfter(0, internal.facebookPosting.publishToFacebook, { socialPostId });
    }

    return socialPostId;
  },
});

/** Post history for a vehicle's Marketing tab. */
export const listForVehicle = query({
  args: { orgId: v.id("organizations"), vehicleId: v.id("vehicles") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLE_INFO]);
    await requireFeature(ctx, args.orgId, "socialInbox");

    const posts = await ctx.db
      .query("socialPosts")
      .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId))
      .collect();

    return posts.sort((a, b) => b.requestedAt - a.requestedAt);
  },
});

// ─── Internal (used by the publishToInstagram Node action) ─────────────────────

export const getPostContext = internalQuery({
  args: { socialPostId: v.id("socialPosts") },
  handler: async (ctx, args) => {
    const post = await ctx.db.get(args.socialPostId);
    if (!post) return null;

    const orgSettings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", post.orgId))
      .unique();

    return { post, orgSettings };
  },
});

export const getImageUrls = internalQuery({
  args: { storageIds: v.array(v.id("_storage")) },
  handler: async (ctx, args) => {
    return await Promise.all(args.storageIds.map((id) => ctx.storage.getUrl(id)));
  },
});

export const markPostResult = internalMutation({
  args: {
    socialPostId: v.id("socialPosts"),
    status: v.union(v.literal("PUBLISHED"), v.literal("FAILED")),
    externalPostId: v.optional(v.string()),
    externalPermalink: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const post = await ctx.db.get(args.socialPostId);
    if (!post) return;

    await ctx.db.patch(args.socialPostId, {
      status: args.status,
      externalPostId: args.externalPostId,
      externalPermalink: args.externalPermalink,
      errorMessage: args.errorMessage,
      publishedAt: args.status === "PUBLISHED" ? Date.now() : undefined,
    });

    const vehicle = await ctx.db.get(post.vehicleId);
    const vehicleLabel = vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : "your vehicle";
    const platformLabel = post.platform === "instagram" ? "Instagram" : "Facebook";

    if (args.status === "PUBLISHED") {
      await notifyUser(
        ctx,
        post.orgId,
        post.requestedBy,
        "social.post_succeeded",
        { platform: platformLabel, vehicleLabel },
        { link: `/${post.orgId}/vehicles?highlightId=${post.vehicleId}` }
      );
    } else {
      await notifyUser(
        ctx,
        post.orgId,
        post.requestedBy,
        "social.post_failed",
        { platform: platformLabel, vehicleLabel, error: args.errorMessage ?? "Unknown error" },
        { link: `/${post.orgId}/vehicles?highlightId=${post.vehicleId}` }
      );
    }
  },
});
