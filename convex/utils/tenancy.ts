import { QueryCtx, MutationCtx } from "../_generated/server";
import { Id, Doc } from "../_generated/dataModel";
import { Permission } from "./permissions";
import { throwAppError, AppErrorCode } from "./errors";

/**
 * Result returned by all auth helpers so callers have typed access
 * to the resolved user, membership, and role without extra DB lookups.
 */
export interface TenantAuthContext {
  user: Doc<"users">;
  membership: Doc<"memberships">;
  role: Doc<"roles">;
}

// ─── Auth-only helper (no org scope) ─────────────────────────────────────────

/**
 * Resolves the currently authenticated Clerk user to their Convex `users` row.
 * Use this for operations that are not scoped to any organization
 * (e.g. listing a user's own orgs, creating a new org).
 */
export async function requireAuth(ctx: QueryCtx | MutationCtx): Promise<Doc<"users">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throwAppError(AppErrorCode.UNAUTHENTICATED, "Unauthenticated: You must be logged in.");
  }

  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
    .unique();

  if (!user) {
    throwAppError(AppErrorCode.USER_NOT_FOUND, "User not found in the database. Please contact support.");
  }

  return user;
}

// ─── Full tenant-scoped auth ─────────────────────────────────────────────────

/**
 * Ensures the user is authenticated, exists in the database, holds an active
 * membership in the specified organization, and (optionally) possesses every
 * permission listed in `requiredPermissions`.
 *
 * Usage:
 *   const { user, role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);
 */
export async function requireTenantAuth(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  requiredPermissions: Permission[] = []
): Promise<TenantAuthContext> {
  const user = await requireAuth(ctx);

  // Verify the org itself exists
  const org = await ctx.db.get(orgId);
  if (!org) {
    throwAppError(AppErrorCode.ORG_NOT_FOUND, "Organization not found.");
  }

  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", user._id))
    .unique();

  if (!membership) {
    throwAppError(AppErrorCode.UNAUTHORIZED, "Unauthorized: You are not a member of this organization.");
  }

  const role = await ctx.db.get(membership.roleId);
  if (!role) {
    throwAppError(AppErrorCode.ROLE_NOT_FOUND, "Membership role not found or corrupted.");
  }

  if (requiredPermissions.length > 0) {
    const missing = requiredPermissions.filter((p) => !role.permissions.includes(p));
    if (missing.length > 0) {
      throwAppError(
        AppErrorCode.FORBIDDEN,
        `Forbidden: Missing required permissions: ${missing.join(", ")}`
      );
    }
  }

  return { user, membership, role };
}

// ─── Owner-only guard ────────────────────────────────────────────────────────

/**
 * Shorthand for operations restricted to the OWNER role.
 * Throws if the caller's role name is not "OWNER".
 */
export async function requireOwner(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">
): Promise<TenantAuthContext> {
  const authCtx = await requireTenantAuth(ctx, orgId);
  if (authCtx.role.name !== "OWNER") {
    throwAppError(AppErrorCode.FORBIDDEN, "Forbidden: Only the organization owner can perform this action.");
  }
  return authCtx;
}
