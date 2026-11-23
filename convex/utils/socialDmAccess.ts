import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { PERMISSIONS } from "./permissions";
import { requirePlanFeature } from "./subscriptionFeatures";
import { requireTenantAuth } from "./tenancy";

interface DmAccessArgs {
  orgId: Id<"organizations">;
  customerId: Id<"customers">;
}

export interface SocialDmAccess<Event> {
  user: Doc<"users">;
  /** Null when the customer has no private-message event on this platform. */
  dmEvent: Event | null;
  orgSettings: Doc<"orgSettings"> | null;
}

type Ctx = QueryCtx | MutationCtx;

async function readOrgSettings(ctx: Ctx, orgId: Id<"organizations">): Promise<Doc<"orgSettings"> | null> {
  return await ctx.db
    .query("orgSettings")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
}

// Newest first, stopping at the first direct message: a customer's comment
// events never force a full read of the thread.
async function newestInstagramDm(ctx: Ctx, args: DmAccessArgs): Promise<Doc<"instagramEvents"> | null> {
  const events = ctx.db
    .query("instagramEvents")
    .withIndex("by_org_customer", (q) => q.eq("orgId", args.orgId).eq("customerId", args.customerId))
    .order("desc");
  for await (const event of events) {
    if (event.kind === "dm") return event;
  }
  return null;
}

async function newestFacebookDm(ctx: Ctx, args: DmAccessArgs): Promise<Doc<"facebookEvents"> | null> {
  const events = ctx.db
    .query("facebookEvents")
    .withIndex("by_org_customer", (q) => q.eq("orgId", args.orgId).eq("customerId", args.customerId))
    .order("desc");
  for await (const event of events) {
    if (event.kind === "dm") return event;
  }
  return null;
}

/**
 * The one rule for "may this member work a customer's private-message thread":
 * tenant auth with EDIT_LEADS, the Social Inbox plan feature, the customer's
 * newest direct-message event on that platform in that organization (read by
 * organization, so another dealership's rows are never reachable), and the
 * organization's settings.
 *
 * Used by both manual-send access queries and by the AI draft request, so the
 * three can never drift apart.
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
  args: DmAccessArgs & { platform: "instagram" | "facebook" }
): Promise<SocialDmAccess<Doc<"instagramEvents"> | Doc<"facebookEvents">>>;
export async function requireSocialDmAccess(
  ctx: Ctx,
  args: DmAccessArgs & { platform: "instagram" | "facebook" }
): Promise<SocialDmAccess<Doc<"instagramEvents"> | Doc<"facebookEvents">>> {
  const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_LEADS]);
  await requirePlanFeature(ctx, args.orgId, "socialInbox");
  if (args.platform === "instagram") {
    const dmEvent = await newestInstagramDm(ctx, args);
    return { user, dmEvent, orgSettings: await readOrgSettings(ctx, args.orgId) };
  }
  const dmEvent = await newestFacebookDm(ctx, args);
  return { user, dmEvent, orgSettings: await readOrgSettings(ctx, args.orgId) };
}
