import { v, ConvexError } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

const FACEBOOK_GRAPH_VERSION = "v25.0";

/**
 * Publishes a vehicle to a Facebook Page. Unlike Instagram's container/poll/
 * publish flow, Page photo/feed posting is synchronous — a single photo is
 * one Graph call, multiple photos are uploaded unpublished first then
 * attached to one feed post. Plain V8 action (no Node runtime, no polling).
 * Always resolves into a `socialPosts` status patch; never leaves a post
 * stuck PENDING.
 */
export const publishToFacebook = internalAction({
  args: { socialPostId: v.id("socialPosts") },
  handler: async (ctx, args): Promise<void> => {
    const context = await ctx.runQuery(internal.socialPostingData.getPostContext, {
      socialPostId: args.socialPostId,
    });

    if (!context) return;
    const { post, orgSettings } = context;

    if (!orgSettings?.facebookPageAccessToken || !orgSettings?.facebookPageId) {
      await ctx.runMutation(internal.socialPostingData.markPostResult, {
        socialPostId: args.socialPostId,
        status: "FAILED",
        errorMessage: "Facebook is not connected for this organization.",
      });
      return;
    }

    try {
      const accessToken = orgSettings.facebookPageAccessToken;
      const pageId = orgSettings.facebookPageId;
      const caption = post.caption ?? "";

      const imageUrls = await ctx.runQuery(internal.socialPostingData.getImageUrls, {
        storageIds: post.imageStorageIds,
      });
      if (imageUrls.some((url) => !url)) {
        throw new ConvexError("One or more selected photos could not be resolved to a public URL.");
      }

      let postId: string;
      let permalink: string | undefined;

      if (imageUrls.length === 1) {
        const photoUrl = new URL(`https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${pageId}/photos`);
        photoUrl.searchParams.set("url", imageUrls[0]!);
        photoUrl.searchParams.set("caption", caption);
        photoUrl.searchParams.set("access_token", accessToken);
        const photoRes = await fetch(photoUrl.toString(), { method: "POST" });
        const photoJson = await photoRes.json();
        if (!photoRes.ok || !photoJson.id) {
          throw new ConvexError(`Failed to post to Facebook: ${photoJson?.error?.message ?? photoRes.statusText}`);
        }
        postId = photoJson.post_id ?? photoJson.id;
      } else {
        const mediaFbids: string[] = [];
        for (const imageUrl of imageUrls) {
          const unpublishedUrl = new URL(`https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${pageId}/photos`);
          unpublishedUrl.searchParams.set("url", imageUrl!);
          unpublishedUrl.searchParams.set("published", "false");
          unpublishedUrl.searchParams.set("access_token", accessToken);
          const unpublishedRes = await fetch(unpublishedUrl.toString(), { method: "POST" });
          const unpublishedJson = await unpublishedRes.json();
          if (!unpublishedRes.ok || !unpublishedJson.id) {
            throw new ConvexError(`Failed to upload photo to Facebook: ${unpublishedJson?.error?.message ?? unpublishedRes.statusText}`);
          }
          mediaFbids.push(unpublishedJson.id);
        }

        const feedUrl = new URL(`https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${pageId}/feed`);
        feedUrl.searchParams.set("message", caption);
        mediaFbids.forEach((id, index) => {
          feedUrl.searchParams.set(`attached_media[${index}]`, JSON.stringify({ media_fbid: id }));
        });
        feedUrl.searchParams.set("access_token", accessToken);
        const feedRes = await fetch(feedUrl.toString(), { method: "POST" });
        const feedJson = await feedRes.json();
        if (!feedRes.ok || !feedJson.id) {
          throw new ConvexError(`Failed to post to Facebook: ${feedJson?.error?.message ?? feedRes.statusText}`);
        }
        postId = feedJson.id;
      }

      try {
        const permalinkUrl = new URL(`https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${postId}`);
        permalinkUrl.searchParams.set("fields", "permalink_url");
        permalinkUrl.searchParams.set("access_token", accessToken);
        const permalinkRes = await fetch(permalinkUrl.toString());
        const permalinkJson = await permalinkRes.json();
        permalink = permalinkJson.permalink_url;
      } catch {
        // Non-fatal — the post succeeded even if we couldn't fetch the permalink.
      }

      await ctx.runMutation(internal.socialPostingData.markPostResult, {
        socialPostId: args.socialPostId,
        status: "PUBLISHED",
        externalPostId: postId,
        externalPermalink: permalink,
      });
    } catch (err) {
      await ctx.runMutation(internal.socialPostingData.markPostResult, {
        socialPostId: args.socialPostId,
        status: "FAILED",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  },
});
