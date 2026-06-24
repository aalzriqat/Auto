import { v } from "convex/values";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { INSTAGRAM_GRAPH_VERSION } from "./utils/instagramApi";
import { FACEBOOK_GRAPH_VERSION } from "./utils/facebookApi";
import { matchVehicleFromText } from "./utils/vehicleTextMatch";

export const requireManagerAuthQuery = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_REQUESTS]);
  },
});

export const getIgCommentEvents = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("instagramEvents")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("kind"), "comment"))
      .collect();
  },
});

export const getFbCommentEvents = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("facebookEvents")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("kind"), "comment"))
      .collect();
  },
});

export const patchIgEventPostId = internalMutation({
  args: { eventId: v.id("instagramEvents"), postId: v.string() },
  handler: async (ctx, args) => {
    const ev = await ctx.db.get(args.eventId);
    if (!ev || ev.postId) return;
    await ctx.db.patch(args.eventId, { postId: args.postId });
  },
});

export const patchFbEventPostId = internalMutation({
  args: { eventId: v.id("facebookEvents"), postId: v.string() },
  handler: async (ctx, args) => {
    const ev = await ctx.db.get(args.eventId);
    if (!ev || ev.postId) return;
    await ctx.db.patch(args.eventId, { postId: args.postId });
  },
});

/**
 * Backfills postId and vehicleId on all existing Instagram + Facebook comment
 * events that are missing either field. Callable from the Social Inbox UI by
 * managers/owners.
 *
 * For comments without postId:
 *   IG — GET /{commentId}?fields=media → mediaId stored as postId
 *   FB — GET /{commentId}?fields=object → parent post id stored as postId
 * For comments with postId but no vehicleId:
 *   IG — GET /{mediaId}?fields=caption → text-match against inventory
 *   FB — GET /{postId}?fields=message → text-match against inventory
 *
 * Post-content fetches are deduplicated per post (captionCache / messageCache)
 * so N comments on the same post only hit the Graph API once.
 */
export const resyncEvents = action({
  args: { orgId: v.id("organizations") },
  handler: async (
    ctx,
    args
  ): Promise<{ igPostIds: number; fbPostIds: number; igVehicles: number; fbVehicles: number }> => {
    await ctx.runQuery(internal.socialInboxBackfill.requireManagerAuthQuery, { orgId: args.orgId });

    const [igToken, fbToken, vehicles] = await Promise.all([
      ctx.runQuery(internal.instagramEngagement.getTokenForOrg, { orgId: args.orgId }),
      ctx.runQuery(internal.facebookEngagement.getTokenForOrg, { orgId: args.orgId }),
      ctx.runQuery(internal.instagramEngagement.getOrgVehicles, { orgId: args.orgId }),
    ]);

    let igPostIds = 0, fbPostIds = 0, igVehicles = 0, fbVehicles = 0;

    // ── Instagram ────────────────────────────────────────────────────────────────
    if (igToken) {
      const igEvents = await ctx.runQuery(internal.socialInboxBackfill.getIgCommentEvents, { orgId: args.orgId });
      const captionCache = new Map<string, string>();

      for (const ev of igEvents) {
        let mediaId = ev.postId;

        if (!mediaId) {
          try {
            const res = await fetch(
              `https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}/${ev.externalId}?fields=media&access_token=${igToken.instagramAccessToken}`
            );
            if (res.ok) {
              const json = await res.json();
              const id = json.media?.id ? String(json.media.id) : undefined;
              if (id) {
                await ctx.runMutation(internal.socialInboxBackfill.patchIgEventPostId, {
                  eventId: ev._id,
                  postId: id,
                });
                mediaId = id;
                igPostIds++;
              }
            }
          } catch {
            // best-effort
          }
        }

        if (mediaId && !ev.vehicleId) {
          if (!captionCache.has(mediaId)) {
            try {
              const res = await fetch(
                `https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}/${mediaId}?fields=caption&access_token=${igToken.instagramAccessToken}`
              );
              if (res.ok) {
                const json = await res.json();
                captionCache.set(mediaId, json.caption ?? "");
              }
            } catch {
              // best-effort
            }
          }
          const caption = captionCache.get(mediaId);
          if (caption) {
            const matchedId = matchVehicleFromText(caption, vehicles);
            if (matchedId) {
              await ctx.runMutation(internal.instagramEngagement.patchEventVehicle, {
                orgId: args.orgId,
                externalId: ev.externalId,
                vehicleId: matchedId,
              });
              igVehicles++;
            }
          }
        }
      }
    }

    // ── Facebook ─────────────────────────────────────────────────────────────────
    if (fbToken) {
      const fbEvents = await ctx.runQuery(internal.socialInboxBackfill.getFbCommentEvents, { orgId: args.orgId });
      const messageCache = new Map<string, string>();

      for (const ev of fbEvents) {
        let postId = ev.postId;

        if (!postId) {
          try {
            const res = await fetch(
              `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${ev.externalId}?fields=object&access_token=${fbToken.facebookPageAccessToken}`
            );
            if (res.ok) {
              const json = await res.json();
              const id = json.object?.id ? String(json.object.id) : undefined;
              if (id) {
                await ctx.runMutation(internal.socialInboxBackfill.patchFbEventPostId, {
                  eventId: ev._id,
                  postId: id,
                });
                postId = id;
                fbPostIds++;
              }
            }
          } catch {
            // best-effort
          }
        }

        if (postId && !ev.vehicleId) {
          if (!messageCache.has(postId)) {
            try {
              const res = await fetch(
                `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${postId}?fields=message&access_token=${fbToken.facebookPageAccessToken}`
              );
              if (res.ok) {
                const json = await res.json();
                messageCache.set(postId, json.message ?? "");
              }
            } catch {
              // best-effort
            }
          }
          const message = messageCache.get(postId);
          if (message) {
            const matchedId = matchVehicleFromText(message, vehicles);
            if (matchedId) {
              await ctx.runMutation(internal.facebookEngagement.patchEventVehicle, {
                orgId: args.orgId,
                externalId: ev.externalId,
                vehicleId: matchedId,
              });
              fbVehicles++;
            }
          }
        }
      }
    }

    return { igPostIds, fbPostIds, igVehicles, fbVehicles };
  },
});
