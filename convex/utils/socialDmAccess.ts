import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { PERMISSIONS } from "./permissions";
import { requirePlanFeature } from "./subscriptionFeatures";
import { requireTenantAuth } from "./tenancy";

interface DmAccessArgs {
  orgId: Id<"organizations">;
  customerId: Id<"customers">;
}

type SocialPlatform = "instagram" | "facebook";

export interface SocialDmAccess<Event> {
  user: Doc<"users">;
  /** Null when the customer has no private-message event on this platform. */
  dmEvent: Event | null;
}

type Ctx = QueryCtx | MutationCtx;

/** The organization's settings row, for the callers that use it (the send paths). */
export async function readOrgSettings(ctx: Ctx, orgId: Id<"organizations">): Promise<Doc<"orgSettings"> | null> {
  return await ctx.db
    .query("orgSettings")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
}

/**
 * Tenant auth with EDIT_LEADS and the Social Inbox plan feature: the part of
 * the access rule that needs no customer data.
 */
export async function requireSocialInboxAccess(ctx: Ctx, orgId: Id<"organizations">): Promise<Doc<"users">> {
  const { user } = await requireTenantAuth(ctx, orgId, [PERMISSIONS.EDIT_LEADS]);
  await requirePlanFeature(ctx, orgId, "socialInbox");
  return user;
}

/**
 * A customer's newest direct-message events on one platform, newest first.
 * One indexed read of at most `limit` rows however many comment events the
 * customer has: the index ends in `kind`.
 */
export async function newestDmEvents(
  ctx: Ctx,
  args: DmAccessArgs & { platform: SocialPlatform },
  limit: number
): Promise<(Doc<"instagramEvents"> | Doc<"facebookEvents">)[]> {
  if (args.platform === "instagram") {
    return await ctx.db
      .query("instagramEvents")
      .withIndex("by_org_customer_kind", (q) =>
        q.eq("orgId", args.orgId).eq("customerId", args.customerId).eq("kind", "dm")
      )
      .order("desc")
      .take(limit);
  }
  return await ctx.db
    .query("facebookEvents")
    .withIndex("by_org_customer_kind", (q) =>
      q.eq("orgId", args.orgId).eq("customerId", args.customerId).eq("kind", "dm")
    )
    .order("desc")
    .take(limit);
}

/**
 * The one rule for "may this member work a customer's private-message thread":
 * `requireSocialInboxAccess`, then the customer's newest direct-message event
 * on that platform in that organization (read by organization, so another
 * dealership's rows are never reachable).
 *
 * Used by both manual-send access queries and by the AI draft request, so the
 * three can never drift apart. Callers that need the organization's settings
 * read them with `readOrgSettings`.
 */
export async function requireSocialDmAccess(
  ctx: Ctx,
  args: DmAccessArgs & { platform: "instagram" }
): Promise<SocialDmAccess<Doc<"instagramEvents">>>;
export async function requireSocialDmAccess(
  ctx: Ctx,
  args: DmAccessArgs & { platform: "facebook" }
): Promise<SocialDmAccess<Doc<"facebookEvents">>>;
export async function requireSocialDmAccess(
  ctx: Ctx,
  args: DmAccessArgs & { platform: SocialPlatform }
): Promise<SocialDmAccess<Doc<"instagramEvents"> | Doc<"facebookEvents">>>;
export async function requireSocialDmAccess(
  ctx: Ctx,
  args: DmAccessArgs & { platform: SocialPlatform }
): Promise<SocialDmAccess<Doc<"instagramEvents"> | Doc<"facebookEvents">>> {
  const user = await requireSocialInboxAccess(ctx, args.orgId);
  const [dmEvent = null] = await newestDmEvents(ctx, args, 1);
  return { user, dmEvent };
}
