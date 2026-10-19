import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { isSystemOwnerRole } from "./permissions";

/**
 * Finds the org's OWNER-role member's user doc. A plain helper (not a
 * registered function) so queries and mutations can share it without a nested
 * `ctx.runQuery` (Convex best practices: "Use ctx.runQuery and ctx.runMutation
 * sparingly in queries and mutations"). Shared by crons.getOrgOwnerEmail /
 * getOrgOwnerUserId and the weekly marketplace report freeze.
 */
export async function findOrgOwnerUser(ctx: QueryCtx, orgId: Id<"organizations">): Promise<Doc<"users"> | null> {
  // Role *definitions* per org are inherently few (the role list, not member
  // assignments), so collect() is safe here — while a .take(N) cap could
  // silently miss the owner role in an org with many custom roles.
  const roles = await ctx.db
    .query("roles")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
  const ownerRole = roles.find((r) => isSystemOwnerRole(r));
  if (!ownerRole) return null;

  // by_org_role fixes orgId and roleId, so first() is the earliest owner membership (index order = _creationTime).
  const ownerMembership = await ctx.db
    .query("memberships")
    .withIndex("by_org_role", (q) => q.eq("orgId", orgId).eq("roleId", ownerRole._id))
    .first();
  if (!ownerMembership) return null;

  return await ctx.db.get(ownerMembership.userId);
}
