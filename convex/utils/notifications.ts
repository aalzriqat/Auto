import { MutationCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";
import { PERMISSIONS } from "./permissions";

/**
 * Creates a notification for a specific user.
 */
export async function notifyUser(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  userId: Id<"users">,
  title: string,
  message: string,
  link?: string
) {
  await ctx.db.insert("notifications", {
    orgId,
    userId,
    title,
    message,
    isRead: false,
    link,
  });
}

/**
 * Creates a notification for all managers/owners in the organization.
 */
export async function notifyManagers(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  title: string,
  message: string,
  link?: string,
  excludeUserId?: Id<"users">
) {
  // Find all memberships in the org
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();

  for (const membership of memberships) {
    if (excludeUserId && membership.userId === excludeUserId) {
      continue;
    }

    const role = await ctx.db.get(membership.roleId);
    if (!role) continue;

    if (role.permissions.includes(PERMISSIONS.MANAGE_USERS)) {
      await notifyUser(ctx, orgId, membership.userId, title, message, link);
    }
  }
}

/**
 * Helper to get the name of the actor performing the action.
 */
export async function getActorName(ctx: MutationCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return "Someone";

  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
    .first();
    
  return user?.name || identity.name || "A team member";
}
