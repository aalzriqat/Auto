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

export const getIgDmEvents = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("instagramEvents")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("kind"), "dm"))
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

export const getFbDmEvents = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("facebookEvents")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("kind"), "dm"))
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
 * and DM events that are missing either field. Callable from the Social Inbox
 * UI by managers/owners.
 *
 * For comments without postId:
 *   IG — GET /{commentId}?fields=media → mediaId stored as postId
 *   FB — GET /{commentId}?fields=object → parent post id stored as postId
 * For comments/DMs with no vehicleId:
 *   1. Try matching the stored event text directly (fastest, no extra API call)
 *   2. For comments with a postId: fetch post content (IG caption; FB
 *      message+story+attachments) and try matching — deduplicated per post
 *      so N comments on the same post only hit the Graph API once.
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
      const [igCommentEvents, igDmEvents] = await Promise.all([
        ctx.runQuery(internal.socialInboxBackfill.getIgCommentEvents, { orgId: args.orgId }),
        ctx.runQuery(internal.socialInboxBackfill.getIgDmEvents, { orgId: args.orgId }),
      ]);
      const captionCache = new Map<string, string>();

      for (const ev of igCommentEvents) {
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

        if (!ev.vehicleId) {
          // 1. Try the comment text itself first
          if (ev.text) {
            const matchedId = matchVehicleFromText(ev.text, vehicles);
            if (matchedId) {
              await ctx.runMutation(internal.instagramEngagement.patchEventVehicle, {
                orgId: args.orgId,
                externalId: ev.externalId,
                vehicleId: matchedId,
              });
              igVehicles++;
              continue;
            }
          }

          // 2. Fall back to post caption
          if (mediaId) {
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

      // DMs — match from DM text only (no post to fetch)
      for (const ev of igDmEvents) {
        if (!ev.vehicleId && ev.text) {
          const matchedId = matchVehicleFromText(ev.text, vehicles);
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

    // ── Facebook ─────────────────────────────────────────────────────────────────
    if (fbToken) {
      const [fbCommentEvents, fbDmEvents] = await Promise.all([
        ctx.runQuery(internal.socialInboxBackfill.getFbCommentEvents, { orgId: args.orgId }),
        ctx.runQuery(internal.socialInboxBackfill.getFbDmEvents, { orgId: args.orgId }),
      ]);
      // Cache maps postId → combined text (message + story + attachment titles)
      const postTextCache = new Map<string, string>();

      for (const ev of fbCommentEvents) {
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

        if (!ev.vehicleId) {
          // 1. Try the comment text itself first
          if (ev.text) {
            const matchedId = matchVehicleFromText(ev.text, vehicles);
            if (matchedId) {
              await ctx.runMutation(internal.facebookEngagement.patchEventVehicle, {
                orgId: args.orgId,
                externalId: ev.externalId,
                vehicleId: matchedId,
              });
              fbVehicles++;
              continue;
            }
          }

          // 2. Fall back to post content — every text-bearing field Meta exposes
          if (postId) {
            if (!postTextCache.has(postId)) {
              try {
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
                const res = await fetch(
                  `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${postId}?fields=${fields}&access_token=${fbToken.facebookPageAccessToken}`
                );
                if (res.ok) {
                  const json = await res.json();
                  const parts: string[] = [];

                  // Post-level text fields
                  for (const f of ["message", "story", "name", "caption", "description"] as const) {
                    if (json[f]) parts.push(json[f]);
                  }

                  // call_to_action — WhatsApp CTA often carries the vehicle name
                  // either in page_welcome_message or in the ?text= query param of the link
                  const cta = json.call_to_action?.value ?? {};
                  if (cta.page_welcome_message) parts.push(cta.page_welcome_message);
                  if (cta.link) {
                    parts.push(cta.link);
                    try {
                      const waText = new URL(cta.link).searchParams.get("text");
                      if (waText) parts.push(decodeURIComponent(waText));
                    } catch { /* not a valid URL */ }
                  }

                  // properties (key-value pairs on some post types)
                  for (const prop of json.properties?.data ?? []) {
                    if (prop.name) parts.push(prop.name);
                    if (prop.text) parts.push(prop.text);
                  }

                  // Helper: collect every text field from an attachment node
                  const collectAtt = (att: Record<string, unknown>) => {
                    for (const f of ["title", "description", "name", "caption"] as const) {
                      if (att[f]) parts.push(att[f] as string);
                    }
                    // WhatsApp deep-link URLs may carry ?text=VehicleName
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
                    // CTA nested inside child_attachments
                    const subCta = (att.call_to_action as any)?.value ?? {};
                    if (subCta.page_welcome_message) parts.push(subCta.page_welcome_message);
                    if (subCta.link) {
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
                  for (const att of json.child_attachments?.data ?? []) {
                    collectAtt(att);
                  }

                  postTextCache.set(postId, parts.join(" "));
                }
              } catch {
                // best-effort
              }
            }
            const combined = postTextCache.get(postId);
            if (combined) {
              const matchedId = matchVehicleFromText(combined, vehicles);
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

      // DMs — match from DM text only (no post to fetch)
      for (const ev of fbDmEvents) {
        if (!ev.vehicleId && ev.text) {
          const matchedId = matchVehicleFromText(ev.text, vehicles);
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

    return { igPostIds, fbPostIds, igVehicles, fbVehicles };
  },
});
