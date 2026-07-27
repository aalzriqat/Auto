import { QueryCtx, MutationCtx } from "../_generated/server";
import { Id, Doc } from "../_generated/dataModel";
import { Permission, isSystemOwnerRole } from "./permissions";
import { throwAppError, AppErrorCode } from "./errors";
import { getValidatedEnv } from "./env";
import { writeAuditLog } from "./auditLog";

/** True at runtime/type-level only for MutationCtx, which exposes ctx.db.insert. */
function isMutationCtx(ctx: QueryCtx | MutationCtx): ctx is MutationCtx {
  return "insert" in ctx.db;
}

/**
 * Result returned by all auth helpers so callers have typed access
 * to the resolved user, membership, and role without extra DB lookups.
 */
type AuthIdentity = NonNullable<Awaited<ReturnType<MutationCtx["auth"]["getUserIdentity"]>>>;

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

  if (user.disabled) {
    throwAppError(AppErrorCode.FORBIDDEN, "Forbidden: This account has been disabled.");
  }

  return user;
}

function placeholderEmailForSubject(subject: string): string {
  const safeSubject = subject.replace(/[^a-zA-Z0-9._+-]/g, "_");
  return `no-email-${safeSubject}@autoflow.local`;
}

function nameFromIdentity(identity: AuthIdentity): string | undefined {
  return identity.name ?? identity.givenName ?? identity.preferredUsername ?? identity.email;
}

/**
 * requireAuth, but creates the `users` row if it doesn't exist yet.
 *
 * The row is normally written by the Clerk -> Convex webhook, which is
 * asynchronous: a user who signs up and immediately acts can arrive before it
 * lands. Any entry point a brand-new account can hit as its FIRST authenticated
 * write must use this instead of requireAuth, or that user dead-ends on
 * USER_NOT_FOUND until the webhook catches up. Queries can't insert, so they
 * have to degrade gracefully (return an empty result) rather than call this.
 */
export async function requireOrCreateAuthenticatedUser(ctx: MutationCtx): Promise<Doc<"users">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throwAppError(AppErrorCode.UNAUTHENTICATED, "Unauthenticated: You must be logged in.");
  }

  const existingUser = await ctx.db
    .query("users")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
    .unique();

  if (existingUser) {
    if (existingUser.disabled) {
      throwAppError(AppErrorCode.FORBIDDEN, "Forbidden: This account has been disabled.");
    }
    return existingUser;
  }

  const email =
    typeof identity.email === "string" && identity.email.trim()
      ? identity.email.trim().toLowerCase()
      : placeholderEmailForSubject(identity.subject);

  const userId = await ctx.db.insert("users", {
    clerkId: identity.subject,
    email,
    name: nameFromIdentity(identity),
    imageUrl: identity.pictureUrl,
  });
  const user = await ctx.db.get(userId);
  if (!user) {
    throwAppError(AppErrorCode.USER_NOT_FOUND, "User not found in the database. Please contact support.");
  }
  return user;
}

// ─── Super-admin guard (cross-tenant) ────────────────────────────────────────

/**
 * Non-throwing counterpart to requireSuperAdmin for call sites that already
 * hold a resolved `users` doc (e.g. a query that looked up the caller
 * separately) and want a boolean check — to decide what to include in a
 * response, for instance — rather than a thrown error. Mirrors every check
 * requireSuperAdmin performs (allowlist membership AND not-disabled) so the
 * two never drift apart.
 */
export function isSuperAdminUser(user: Doc<"users">): boolean {
  if (user.disabled) return false;

  const allowlist = (getValidatedEnv().SUPER_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  return allowlist.includes(user.email.toLowerCase());
}

/**
 * Restricts access to developers listed in the SUPER_ADMIN_EMAILS env var.
 * Deliberately independent of org membership/roles — used only by the /admin
 * dashboard, which can see and act on every organization's data.
 */
export async function requireSuperAdmin(ctx: QueryCtx | MutationCtx): Promise<Doc<"users">> {
  const user = await requireAuth(ctx);

  if (!isSuperAdminUser(user)) {
    throwAppError(AppErrorCode.FORBIDDEN, "Forbidden: Super-admin access only.");
  }

  return user;
}

// ─── Support-agent guard (cross-tenant, narrower than super-admin) ──────────

/**
 * Restricts access to users with an active `supportAgents` row — managed by
 * a super admin via /admin/support-agents. Used only by the live chat system
 * (queue, claim, reply); deliberately cannot see/edit tenant data the way
 * requireSuperAdmin can.
 */
export async function requireSupportAgent(
  ctx: QueryCtx | MutationCtx
): Promise<{ user: Doc<"users">; agent: Doc<"supportAgents"> }> {
  const user = await requireAuth(ctx);

  const agent = await ctx.db
    .query("supportAgents")
    .withIndex("by_userId", (q) => q.eq("userId", user._id))
    .unique();

  if (!agent || !agent.isActive) {
    throwAppError(AppErrorCode.FORBIDDEN, "Forbidden: Support-agent access only.");
  }

  return { user, agent };
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
  if (org.suspended) {
    throwAppError(AppErrorCode.FORBIDDEN, "Forbidden: This organization has been suspended.");
  }

  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", user._id))
    .unique();

  if (!membership) {
    throwAppError(AppErrorCode.UNAUTHORIZED, "Unauthorized: You are not a member of this organization.");
  }
  if (membership.offboardingStatus) {
    throwAppError(AppErrorCode.UNAUTHORIZED, "Unauthorized: This organization membership is no longer active.");
  }

  const role = await ctx.db.get(membership.roleId);
  if (!role) {
    throwAppError(AppErrorCode.ROLE_NOT_FOUND, "Membership role not found or corrupted.");
  }

  if (requiredPermissions.length > 0 && !isSystemOwnerRole(role)) {
    const missing = requiredPermissions.filter((p) => !role.permissions.includes(p));
    if (missing.length > 0) {
      throwAppError(
        AppErrorCode.FORBIDDEN,
        `Forbidden: Missing required permissions: ${missing.join(", ")}`
      );
    }
  }

  // membership.impersonationGrantId means this is a super admin's temporary
  // membership from an active impersonation session (see
  // convex/adminImpersonation.ts).
  //
  // Verify the grant is still live on every call. Expiry used to rest entirely
  // on a single fire-and-forget ctx.scheduler.runAfter that deletes the
  // membership — with no retry and no sweep behind it, so a scheduled call that
  // failed or was delayed left cross-tenant access valid indefinitely. Checking
  // here makes the session fail closed: the grant's own expiresAt/revokedAt is
  // the authority, and the scheduled cleanup becomes housekeeping rather than
  // the security boundary. Applies to reads as well as writes.
  if (membership.impersonationGrantId) {
    const grant = await ctx.db.get(membership.impersonationGrantId);
    if (!grant || grant.revokedAt || grant.expiresAt <= Date.now()) {
      throwAppError(
        AppErrorCode.UNAUTHORIZED,
        "Unauthorized: This impersonation session has ended."
      );
    }
  }

  // Audit every write made under an impersonation session. `user` here is the
  // real admin, since the temp membership belongs to their own userId, so this
  // never misattributes the write to the impersonated member.
  if (membership.impersonationGrantId && isMutationCtx(ctx)) {
    const label = requiredPermissions.length > 0 ? requiredPermissions.join(",") : "tenant-write";
    await writeAuditLog(ctx, user, {
      action: `impersonated-write:${label}`,
      orgId,
      targetTable: "impersonationGrants",
      targetId: membership.impersonationGrantId,
    });
  }

  return { user, membership, role };
}

// ─── Owner-only guard ────────────────────────────────────────────────────────

/**
 * Shorthand for operations restricted to the OWNER role.
 * Throws if the caller is not assigned the immutable system OWNER role.
 */
export async function requireOwner(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">
): Promise<TenantAuthContext> {
  const authCtx = await requireTenantAuth(ctx, orgId);
  if (!isSystemOwnerRole(authCtx.role)) {
    throwAppError(AppErrorCode.FORBIDDEN, "Forbidden: Only the organization owner can perform this action.");
  }
  return authCtx;
}
