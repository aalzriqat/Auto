import { QueryCtx, MutationCtx } from "../_generated/server";
import { Id, Doc, TableNames } from "../_generated/dataModel";
import { ConvexError } from "convex/values";
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

  await enforceImpersonationGrant(ctx, { user, membership, orgId, requiredPermissions });

  return { user, membership, role };
}

/**
 * Everything that applies only when the caller is acting through an
 * impersonation session — verifying the grant is still live, and auditing the
 * write. Split out of requireTenantAuth so the ordinary membership path reads as
 * one straight line; both halves key off the same membership.impersonationGrantId
 * and are a no-op for a normal member.
 */
async function enforceImpersonationGrant(
  ctx: QueryCtx | MutationCtx,
  args: {
    user: Doc<"users">;
    membership: Doc<"memberships">;
    orgId: Id<"organizations">;
    requiredPermissions: Permission[];
  }
): Promise<void> {
  // membership.impersonationGrantId means this is a super admin's temporary
  // membership from an active impersonation session (see
  // convex/adminImpersonation.ts).
  const grantId = args.membership.impersonationGrantId;
  if (!grantId) return;

  // Verify the grant is still live on every call. Expiry used to rest entirely
  // on a single fire-and-forget ctx.scheduler.runAfter that deletes the
  // membership — with no retry and no sweep behind it, so a scheduled call that
  // failed or was delayed left cross-tenant access valid indefinitely. Checking
  // here makes the session fail closed: the grant's own expiresAt/revokedAt is
  // the authority, and the scheduled cleanup becomes housekeeping rather than
  // the security boundary. Applies to reads as well as writes.
  const grant = await ctx.db.get(grantId);
  if (!grant || grant.revokedAt || grant.expiresAt <= Date.now()) {
    throwAppError(
      AppErrorCode.UNAUTHORIZED,
      "Unauthorized: This impersonation session has ended."
    );
  }

  // Audit every write made under an impersonation session. `user` here is the
  // real admin, since the temp membership belongs to their own userId, so this
  // never misattributes the write to the impersonated member.
  if (!isMutationCtx(ctx)) return;
  const label =
    args.requiredPermissions.length > 0 ? args.requiredPermissions.join(",") : "tenant-write";
  await writeAuditLog(ctx, args.user, {
    action: `impersonated-write:${label}`,
    orgId: args.orgId,
    targetTable: "impersonationGrants",
    targetId: grantId,
  });
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

// ─── Member-reference guard ──────────────────────────────────────────────────

/**
 * Proves a caller-supplied **user** id is a member of `orgId`.
 *
 * The row-ownership counterpart for user references. A handler that accepts an
 * arbitrary `users` id and then stores it, assigns work to it, or — worst —
 * notifies it, is leaking across tenants just as surely as one that patches a
 * foreign row: `notifyUser` will happily push this org's vehicle and customer
 * detail, plus a deep link into its dashboard, to somebody who was never in it.
 */
export async function requireOrgMember(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  userId: Id<"users">,
  code: AppErrorCode = AppErrorCode.SALESPERSON_NOT_MEMBER,
  message = "Salesperson is not a member of this organization."
): Promise<Doc<"memberships">> {
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", userId))
    .unique();
  // An offboarding membership is not an active one: `requireTenantAuth` above
  // refuses to authenticate its owner, so accepting it here would let a user
  // who can no longer sign in to this org still be assigned its work and
  // notified with its data. Both cases raise the same error — the caller has no
  // business learning which of the two it was.
  // An offboarding membership is not an active one: `requireTenantAuth` above
  // refuses to authenticate its owner, so accepting it here would let a user
  // who can no longer sign in to this org still be assigned its work and
  // notified with its data. Both cases raise the same error — the caller has no
  // business learning which of the two it was.
  if (!membership || membership.offboardingStatus) {
    throwAppError(code, message);
  }
  return membership;
}

/**
 * Whether a given member holds a permission, for guards that run away from the
 * mutation boundary.
 *
 * `requireTenantAuth` proves the CALLER's permissions at the entry point, which
 * is right for the operation the entry point names — but a mutation authorized
 * for one thing can go on to perform another. Completing a sale needs
 * `create:sales`; refunding the customer's reservation deposit inside it needs
 * `approve:requests`, and nothing at the boundary was ever going to notice.
 *
 * System owners pass everything, same as `requireTenantAuth`.
 */
export async function requireActorPermission(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  userId: Id<"users">,
  permission: string,
  message: string
): Promise<void> {
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", userId))
    .unique();
  if (!membership || membership.offboardingStatus) {
    throwAppError(AppErrorCode.FORBIDDEN, message);
  }
  const role = await ctx.db.get(membership.roleId);
  if (!role) {
    throwAppError(AppErrorCode.ROLE_NOT_FOUND, "Membership role not found or corrupted.");
  }
  if (isSystemOwnerRole(role)) return;
  if (!role.permissions.includes(permission)) {
    throwAppError(AppErrorCode.FORBIDDEN, message);
  }
}

// ─── Row-ownership guard ─────────────────────────────────────────────────────

/**
 * Every table whose documents carry an `orgId`, i.e. every tenant-scoped table.
 * Derived from the schema, so a new tenant table is covered automatically and a
 * non-tenant table is a compile error at the call site.
 */
export type OrgScopedTable = {
  [T in TableNames]: Doc<T> extends { orgId: Id<"organizations"> } ? T : never;
}[TableNames];

/**
 * Loads a row by a **caller-supplied id** and proves it belongs to `orgId`.
 *
 * `requireTenantAuth` / `requireOwner` only prove the caller may act inside the
 * org they named — they say nothing about the row they are about to touch. Any
 * handler that takes both an `orgId` and a document id must bridge that gap
 * before `ctx.db.patch` / `ctx.db.delete`, or an authenticated member of org A
 * can mutate org B's rows by passing a foreign id. Omitting the check is
 * invisible in review, so route the lookup through this helper rather than
 * hand-writing `get` + `orgId !==` at each of the ~220 sites.
 *
 * Fails closed: a missing row and a foreign row raise the same error, so the
 * response cannot be used to probe for the existence of another org's records.
 */
export async function requireOwnedRow<T extends OrgScopedTable>(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  // Not needed to load the row — it binds T, documents intent at the call site,
  // and makes an id typed against the wrong table a compile error.
  _table: T,
  id: Id<T>,
  notFoundMessage = "Record not found in this organization."
): Promise<Doc<T>> {
  const doc = await ctx.db.get(id);
  if (!doc || (doc as { orgId?: Id<"organizations"> }).orgId !== orgId) {
    throw new ConvexError(notFoundMessage);
  }
  return doc;
}

/**
 * What a caller may see of a finance application's settlement evidence.
 *
 * One rule, called by every query that returns the document, because this
 * release learned the cost of the alternative twice: `dealCockpit` was gated
 * while `applications.get` returned the same fields wholesale, and gating that
 * still left `financingEconomics.getEconomics` open to a weaker role again.
 * Gating one of three doors gates nothing.
 *
 * The split is between EVIDENCE and WORKFLOW, not between two grades of
 * secrecy:
 *
 *  - What the advice says was paid, its reference, and the approval frozen
 *    beside a discrepancy are evidence about money. They need VIEW_FINANCE.
 *  - The approved amount, whether a disbursement is already recorded, and its
 *    status are what the CONFIRMATION SCREEN runs on. Withholding them from the
 *    people who hold the confirmation permission does not protect anything — it
 *    opens the amount field blank so the figure gets typed from memory, leaves
 *    the confirm button showing on an already-paid deal, and reports "awaiting
 *    disbursement" for a deal the financier has settled. A mistyped figure then
 *    locks the deal in REQUIRES_RECONCILIATION, which only MANAGE_FINANCE can
 *    repair. That is a worse outcome than the disclosure it was avoiding, and
 *    it discloses nothing new anyway: the default MANAGER already holds
 *    VIEW_COST_PRICE, so the supplier's entitlement is visible to them.
 *
 * SALES holds neither permission and keeps the full redaction.
 *
 * Fields are BLANKED rather than omitted so the returned shape is identical for
 * every caller — Convex drops undefined values from the wire, so nothing leaks,
 * while consumers keep one type instead of a union they must narrow.
 */
export function redactSettlementEvidence<T extends Doc<"financeApplications">>(
  app: T,
  role: Doc<"roles">
): T {
  const has = (permission: Permission) =>
    isSystemOwnerRole(role) || role.permissions.includes(permission);
  const canSeeFinance = has("view:finance" as Permission);
  const canWorkDisbursement = canSeeFinance || has("confirm:finance_disbursement" as Permission);

  return {
    ...app,
    supplierDisbursedAmountMinor: canSeeFinance ? app.supplierDisbursedAmountMinor : undefined,
    supplierDisbursementReference: canSeeFinance ? app.supplierDisbursementReference : undefined,
    supplierDisbursementApprovedAtRecordingMinor: canSeeFinance
      ? app.supplierDisbursementApprovedAtRecordingMinor
      : undefined,
    approvedDealerPurchaseAmountMinor: canWorkDisbursement
      ? app.approvedDealerPurchaseAmountMinor
      : undefined,
    supplierDisbursementConfirmedAt: canWorkDisbursement
      ? app.supplierDisbursementConfirmedAt
      : undefined,
    supplierDisbursementConfirmedBy: canWorkDisbursement
      ? app.supplierDisbursementConfirmedBy
      : undefined,
    supplierDisbursementStatus: canWorkDisbursement ? app.supplierDisbursementStatus : undefined,
  };
}
