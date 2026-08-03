import { v } from "convex/values";
import { action, internalQuery } from "./_generated/server";
import { internalMutation } from "./functions";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { isUnresolvedInstagramName } from "./instagramEngagement";
import { isUnresolvedFacebookName } from "./facebookEngagement";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { INSTAGRAM_GRAPH_VERSION } from "./utils/instagramApi";
import {
  FACEBOOK_GRAPH_VERSION,
  FACEBOOK_REEL_VIDEO_FIELDS,
  FACEBOOK_PAGE_POST_FIELDS,
  FACEBOOK_POST_TEXT_FIELDS,
} from "./utils/facebookApi";
import { matchVehicleFromText, suggestVehiclesFromText } from "./utils/vehicleTextMatch";
import { requireFeature } from "./subscriptions";

export const requireManagerAuthQuery = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_REQUESTS]);
    await requireFeature(ctx, args.orgId, "socialInbox");
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

export const patchIgVehicleMatchHint = internalMutation({
  args: {
    eventId: v.id("instagramEvents"),
    hintText: v.string(),
    source: v.union(v.literal("message"), v.literal("post")),
  },
  handler: async (ctx, args) => {
    const ev = await ctx.db.get(args.eventId);
    if (!ev || ev.vehicleId) return;
    await ctx.db.patch(args.eventId, {
      vehicleMatchHintText: args.hintText.slice(0, 1000),
      vehicleMatchHintSource: args.source,
    });
  },
});

export const patchFbVehicleMatchHint = internalMutation({
  args: {
    eventId: v.id("facebookEvents"),
    hintText: v.string(),
    source: v.union(v.literal("message"), v.literal("post")),
  },
  handler: async (ctx, args) => {
    const ev = await ctx.db.get(args.eventId);
    if (!ev || ev.vehicleId) return;
    await ctx.db.patch(args.eventId, {
      vehicleMatchHintText: args.hintText.slice(0, 1000),
      vehicleMatchHintSource: args.source,
    });
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
  ): Promise<{ igPostIds: number; fbPostIds: number; igVehicles: number; fbVehicles: number; igHints: number; fbHints: number }> => {
    await ctx.runQuery(internal.socialInboxBackfill.requireManagerAuthQuery, { orgId: args.orgId });

    const [igToken, fbToken, vehicles] = await Promise.all([
      ctx.runQuery(internal.instagramEngagement.getTokenForOrg, { orgId: args.orgId }),
      ctx.runQuery(internal.facebookEngagement.getTokenForOrg, { orgId: args.orgId }),
      ctx.runQuery(internal.instagramEngagement.getOrgVehicles, { orgId: args.orgId }),
    ]);

    let igPostIds = 0, fbPostIds = 0, igVehicles = 0, fbVehicles = 0, igHints = 0, fbHints = 0;
    const igHintedEventIds = new Set<string>();
    const fbHintedEventIds = new Set<string>();
    const countIgHint = (eventId: string) => {
      if (igHintedEventIds.has(eventId)) return;
      igHintedEventIds.add(eventId);
      igHints++;
    };
    const countFbHint = (eventId: string) => {
      if (fbHintedEventIds.has(eventId)) return;
      fbHintedEventIds.add(eventId);
      fbHints++;
    };

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
            if (suggestVehiclesFromText(ev.text, vehicles).length > 0) {
              await ctx.runMutation(internal.socialInboxBackfill.patchIgVehicleMatchHint, {
                eventId: ev._id,
                hintText: ev.text,
                source: "message",
              });
              countIgHint(ev._id);
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
              } else if (suggestVehiclesFromText(caption, vehicles).length > 0) {
                await ctx.runMutation(internal.socialInboxBackfill.patchIgVehicleMatchHint, {
                  eventId: ev._id,
                  hintText: caption,
                  source: "post",
                });
                countIgHint(ev._id);
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
          } else if (suggestVehiclesFromText(ev.text, vehicles).length > 0) {
            await ctx.runMutation(internal.socialInboxBackfill.patchIgVehicleMatchHint, {
              eventId: ev._id,
              hintText: ev.text,
              source: "message",
            });
            countIgHint(ev._id);
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
            if (suggestVehiclesFromText(ev.text, vehicles).length > 0) {
              await ctx.runMutation(internal.socialInboxBackfill.patchFbVehicleMatchHint, {
                eventId: ev._id,
                hintText: ev.text,
                source: "message",
              });
              countFbHint(ev._id);
            }
          }

          // 2. Fall back to post content — every text-bearing field Meta exposes
          if (postId) {
            if (!postTextCache.has(postId)) {
              try {
                // Reels resolve to a Video node, not a Page Post — Video
                // nodes don't support "message"/"story"/"caption"/"name"
                // and the Graph API 400s the *entire* request if any
                // requested field is invalid for the resolved node type,
                // so this needs a narrower field list (mirrors the same
                // fix in facebookEngagement.enrichEventVehicleFromPost).
                const fields = ev.sourceSurface === "reel" ? FACEBOOK_REEL_VIDEO_FIELDS : FACEBOOK_PAGE_POST_FIELDS;
                const res = await fetch(
                  `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${postId}?fields=${fields}&access_token=${fbToken.facebookPageAccessToken}`
                );
                if (res.ok) {
                  const json = await res.json();
                  const parts: string[] = [];

                  // Post-level text fields
                  for (const f of FACEBOOK_POST_TEXT_FIELDS) {
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
              } else if (suggestVehiclesFromText(combined, vehicles).length > 0) {
                await ctx.runMutation(internal.socialInboxBackfill.patchFbVehicleMatchHint, {
                  eventId: ev._id,
                  hintText: combined,
                  source: "post",
                });
                countFbHint(ev._id);
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
          } else if (suggestVehiclesFromText(ev.text, vehicles).length > 0) {
            await ctx.runMutation(internal.socialInboxBackfill.patchFbVehicleMatchHint, {
              eventId: ev._id,
              hintText: ev.text,
              source: "message",
            });
            countFbHint(ev._id);
          }
        }
      }
    }

    return { igPostIds, fbPostIds, igVehicles, fbVehicles, igHints, fbHints };
  },
});

/**
 * Ceiling on how many contacts one repair run will look up.
 *
 * Each contact costs a Graph round trip, and the action holds a single
 * execution slot for the whole batch. Bounded so a large inbox cannot run the
 * action past its time budget; the caller re-runs to continue.
 */
const CONTACT_NAME_RESYNC_LIMIT = 200;

/**
 * How many customer rows one repair run will scan looking for unresolved ones.
 * Comfortably above the resync limit so a run can always fill its batch, while
 * staying well inside a Convex query's read budget.
 */
const CONTACT_NAME_SCAN_LIMIT = 4_000;

export const getUnresolvedSocialCustomers = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    // Bounded scan. "Unresolved" is not indexable, so finding these rows means
    // reading customers — and an unbounded collect over a large org's whole
    // customer book can exceed a query's read limit and fail outright, which
    // would take the repair path down exactly on the orgs that need it most.
    // Newest-first because social contacts are created by inbound messages, so
    // unresolved ones cluster at the recent end.
    const customers = await ctx.db
      .query("customers")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(CONTACT_NAME_SCAN_LIMIT);

    const instagram: Array<{ customerId: Id<"customers">; senderInstagramId: string }> = [];
    const facebook: Array<{ customerId: Id<"customers">; senderFacebookId: string }> = [];

    for (const customer of customers) {
      if (customer.isDeleted) continue;
      if (
        customer.instagramUserId &&
        isUnresolvedInstagramName(customer, customer.instagramUserId)
      ) {
        instagram.push({ customerId: customer._id, senderInstagramId: customer.instagramUserId });
      }
      if (
        customer.facebookUserId &&
        isUnresolvedFacebookName(customer, customer.facebookUserId)
      ) {
        facebook.push({ customerId: customer._id, senderFacebookId: customer.facebookUserId });
      }
    }

    return { instagram, facebook };
  },
});

/**
 * Re-runs profile enrichment for social contacts that never got a real name.
 *
 * Enrichment normally only fires while a webhook is being processed, so a
 * lookup that failed once — expired page token, a permission not yet granted,
 * a transient Graph error — left that contact showing "Facebook Contact" or a
 * bare numeric PSID until the same person happened to message again. Contacts
 * captured before enrichment existed were never retried at all. This is the
 * repair path for both: it walks the org's unresolved social contacts and
 * re-attempts the lookup for each.
 *
 * Safe to re-run. The underlying save refuses to overwrite any name that is
 * not still a placeholder, so a contact a staff member has already renamed by
 * hand is left alone.
 */
export const resyncContactNames = action({
  args: { orgId: v.id("organizations") },
  handler: async (
    ctx,
    args
  ): Promise<{
    instagramAttempted: number;
    facebookAttempted: number;
    resolved: number;
    /** Retried this run and still unresolved — a subset of `remaining`. */
    attemptedButUnresolved: number;
    /** The org's whole remaining backlog, including contacts past the batch. */
    remaining: number;
  }> => {
    await ctx.runQuery(internal.socialInboxBackfill.requireManagerAuthQuery, { orgId: args.orgId });

    const before = await ctx.runQuery(
      internal.socialInboxBackfill.getUnresolvedSocialCustomers,
      { orgId: args.orgId }
    );

    // Split the budget per platform rather than filling it with Instagram
    // first. Taking Instagram to the cap meant an org with 200+ unresolved
    // Instagram contacts — especially one whose IG token is broken, so none of
    // them ever resolve — would retry the same rows on every run and never
    // reach a single Facebook contact. Each platform gets half, and whatever
    // one platform does not need is lent to the other.
    const half = Math.floor(CONTACT_NAME_RESYNC_LIMIT / 2);
    const instagramShare = Math.min(
      before.instagram.length,
      Math.max(half, CONTACT_NAME_RESYNC_LIMIT - before.facebook.length)
    );
    const facebookShare = Math.min(
      before.facebook.length,
      CONTACT_NAME_RESYNC_LIMIT - instagramShare
    );
    const instagramBatch = before.instagram.slice(0, instagramShare);
    const facebookBatch = before.facebook.slice(0, facebookShare);

    // Sequential on purpose: these are third-party lookups against a per-page
    // rate limit, and a burst of parallel requests is what gets a page token
    // throttled. Each enrichment already swallows its own failures.
    for (const contact of instagramBatch) {
      await ctx.runAction(internal.instagramEngagement.enrichCustomerProfile, {
        orgId: args.orgId,
        customerId: contact.customerId,
        senderInstagramId: contact.senderInstagramId,
      });
    }
    for (const contact of facebookBatch) {
      await ctx.runAction(internal.facebookEngagement.enrichCustomerProfile, {
        orgId: args.orgId,
        customerId: contact.customerId,
        senderFacebookId: contact.senderFacebookId,
      });
    }

    const after = await ctx.runQuery(
      internal.socialInboxBackfill.getUnresolvedSocialCustomers,
      { orgId: args.orgId }
    );
    const remaining = after.instagram.length + after.facebook.length;
    const attempted = instagramBatch.length + facebookBatch.length;
    const startingTotal = before.instagram.length + before.facebook.length;

    // Two separate numbers rather than one ambiguous "stillUnresolved":
    // `resolved` is org-wide, so reporting a batch-only failure count beside
    // it invited reading the backlog as smaller than it is whenever it exceeds
    // one run's budget.
    return {
      instagramAttempted: instagramBatch.length,
      facebookAttempted: facebookBatch.length,
      resolved: Math.max(0, startingTotal - remaining),
      attemptedButUnresolved: Math.max(0, remaining - (startingTotal - attempted)),
      remaining,
    };
  },
});
