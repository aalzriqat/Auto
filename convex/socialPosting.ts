"use node";

import { v, ConvexError } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

const INSTAGRAM_GRAPH_VERSION = "v21.0";
const CONTAINER_POLL_INTERVAL_MS = 1500;
const CONTAINER_POLL_MAX_ATTEMPTS = 10;

// This app is on Meta's "API setup with Instagram Login" flow (see
// socialIntegrations.ts), whose tokens are issued for graph.instagram.com,
// not graph.facebook.com — same endpoint shapes, different host.

async function waitForContainerReady(containerId: string, accessToken: string): Promise<void> {
  for (let attempt = 0; attempt < CONTAINER_POLL_MAX_ATTEMPTS; attempt++) {
    const url = new URL(`https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}/${containerId}`);
    url.searchParams.set("fields", "status_code");
    url.searchParams.set("access_token", accessToken);
    const res = await fetch(url.toString());
    const json = await res.json();
    if (json.status_code === "FINISHED") return;
    if (json.status_code === "ERROR") {
      throw new ConvexError(`Instagram media container failed to process: ${JSON.stringify(json)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, CONTAINER_POLL_INTERVAL_MS));
  }
  throw new ConvexError("Instagram media container took too long to process.");
}

async function createMediaContainer(
  igUserId: string,
  accessToken: string,
  params: Record<string, string>
): Promise<string> {
  const url = new URL(`https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}/${igUserId}/media`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("access_token", accessToken);

  const res = await fetch(url.toString(), { method: "POST" });
  const json = await res.json();
  if (!res.ok || !json.id) {
    throw new ConvexError(`Failed to create Instagram media container: ${json?.error?.message ?? res.statusText}`);
  }
  return json.id;
}

/**
 * Publishes a vehicle to Instagram. Runs as a Node action — needs `fetch`
 * plus `setTimeout`-based polling while Meta processes the media
 * container(s), which the lighter V8 action runtime doesn't support.
 * Always resolves into a `socialPosts` status patch; never leaves a post
 * stuck PENDING.
 */
export const publishToInstagram = internalAction({
  args: { socialPostId: v.id("socialPosts") },
  handler: async (ctx, args): Promise<void> => {
    const context = await ctx.runQuery(internal.socialPostingData.getPostContext, {
      socialPostId: args.socialPostId,
    });

    if (!context) return;
    const { post, orgSettings } = context;

    if (!orgSettings?.instagramAccessToken || !orgSettings?.instagramBusinessAccountId) {
      await ctx.runMutation(internal.socialPostingData.markPostResult, {
        socialPostId: args.socialPostId,
        status: "FAILED",
        errorMessage: "Instagram is not connected for this organization.",
      });
      return;
    }

    try {
      const accessToken = orgSettings.instagramAccessToken;
      const igUserId = orgSettings.instagramBusinessAccountId;
      const caption = post.caption ?? "";

      const imageUrls = await ctx.runQuery(internal.socialPostingData.getImageUrls, {
        storageIds: post.imageStorageIds,
      });
      if (imageUrls.some((url: string | null) => !url)) {
        throw new ConvexError("One or more selected photos could not be resolved to a public URL.");
      }

      let creationId: string;

      if (imageUrls.length === 1) {
        creationId = await createMediaContainer(igUserId, accessToken, {
          image_url: imageUrls[0]!,
          caption,
        });
        await waitForContainerReady(creationId, accessToken);
      } else {
        const childIds: string[] = [];
        for (const imageUrl of imageUrls) {
          const childId = await createMediaContainer(igUserId, accessToken, {
            image_url: imageUrl!,
            is_carousel_item: "true",
          });
          await waitForContainerReady(childId, accessToken);
          childIds.push(childId);
        }
        creationId = await createMediaContainer(igUserId, accessToken, {
          media_type: "CAROUSEL",
          children: childIds.join(","),
          caption,
        });
        await waitForContainerReady(creationId, accessToken);
      }

      const publishUrl = new URL(`https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}/${igUserId}/media_publish`);
      publishUrl.searchParams.set("creation_id", creationId);
      publishUrl.searchParams.set("access_token", accessToken);
      const publishRes = await fetch(publishUrl.toString(), { method: "POST" });
      const publishJson = await publishRes.json();
      if (!publishRes.ok || !publishJson.id) {
        throw new ConvexError(`Failed to publish to Instagram: ${publishJson?.error?.message ?? publishRes.statusText}`);
      }

      const mediaId: string = publishJson.id;
      let permalink: string | undefined;
      try {
        const permalinkUrl = new URL(`https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}/${mediaId}`);
        permalinkUrl.searchParams.set("fields", "permalink");
        permalinkUrl.searchParams.set("access_token", accessToken);
        const permalinkRes = await fetch(permalinkUrl.toString());
        const permalinkJson = await permalinkRes.json();
        permalink = permalinkJson.permalink;
      } catch {
        // Non-fatal — the post succeeded even if we couldn't fetch the permalink.
      }

      await ctx.runMutation(internal.socialPostingData.markPostResult, {
        socialPostId: args.socialPostId,
        status: "PUBLISHED",
        externalPostId: mediaId,
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
