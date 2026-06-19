import { v } from "convex/values";
import { mutation, query, internalMutation, QueryCtx, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { requireSuperAdmin } from "./utils/tenancy";
import { throwAppError, AppErrorCode } from "./utils/errors";
import { writeAuditLog } from "./utils/auditLog";

const IMPERSONATION_DURATION_MS = 30 * 60_000;

async function findActiveGrant(ctx: QueryCtx | MutationCtx, actorUserId: Id<"users">) {
  const grants = await ctx.db
    .query("impersonationGrants")
    .withIndex("by_actorUserId", (q) => q.eq("actorUserId", actorUserId))
    .collect();
  const now = Date.now();
  return grants.find((g) => !g.revokedAt && g.expiresAt > now) ?? null;
}

/**
 * Grants the super admin a real, time-limited membership in `orgId` that
 * copies the target member's exact role — same "act as" pattern as
 * convex/liveChat.ts's supportOrgAccessGrants, scoped to a specific member
 * instead of a fixed OWNER role. Every write made under the resulting
 * membership is audited by convex/utils/tenancy.ts's requireTenantAuth.
 */
export const startImpersonation = mutation({
  args: {
    targetUserId: v.id("users"),
    orgId: v.id("organizations"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);
    const reason = args.reason.trim();
    if (!reason) {
      throwAppError(AppErrorCode.VALIDATION_FAILED, "A reason is required to start impersonation.");
    }

    const org = await ctx.db.get(args.orgId);
    if (!org) throwAppError(AppErrorCode.ORG_NOT_FOUND, "Organization not found.");
    if (org.suspended) {
      throwAppError(AppErrorCode.FORBIDDEN, "Forbidden: This organization has been suspended.");
    }

    const target = await ctx.db.get(args.targetUserId);
    if (!target) throwAppError(AppErrorCode.USER_NOT_FOUND, "Target user not found.");
    if (target.disabled) {
      throwAppError(AppErrorCode.FORBIDDEN, "Forbidden: This account has been disabled.");
    }

    const targetMembership = await ctx.db
      .query("memberships")
      .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", args.targetUserId))
      .unique();
    if (!targetMembership) {
      throwAppError(AppErrorCode.MEMBER_NOT_FOUND, "Target user is not a member of this organization.");
    }

    const adminOwnMembership = await ctx.db
      .query("memberships")
      .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", admin._id))
      .unique();
    if (adminOwnMembership) {
      throwAppError(
        AppErrorCode.ALREADY_MEMBER,
        "You already have a membership in this organization; impersonation isn't available here."
      );
    }

    // Only one active impersonation session per admin — replace any prior one.
    const previous = await findActiveGrant(ctx, admin._id);
    if (previous) {
      await ctx.db.delete(previous.membershipId);
      await ctx.db.patch(previous._id, { revokedAt: Date.now() });
    }

    const now = Date.now();
    const expiresAt = now + IMPERSONATION_DURATION_MS;

    const membershipId = await ctx.db.insert("memberships", {
      orgId: args.orgId,
      userId: admin._id,
      roleId: targetMembership.roleId,
    });

    const grantId = await ctx.db.insert("impersonationGrants", {
      actorUserId: admin._id,
      targetUserId: args.targetUserId,
      orgId: args.orgId,
      membershipId,
      reason,
      grantedAt: now,
      expiresAt,
    });

    await ctx.db.patch(membershipId, { impersonationGrantId: grantId });

    await ctx.scheduler.runAfter(IMPERSONATION_DURATION_MS, internal.adminImpersonation.expireGrant, {
      grantId,
    });

    await writeAuditLog(ctx, admin, {
      action: "startImpersonation",
      targetTable: "users",
      targetId: args.targetUserId,
      orgId: args.orgId,
      after: { reason, expiresAt, targetEmail: target.email },
    });

    return { orgId: args.orgId, expiresAt };
  },
});

export const endImpersonation = mutation({
  args: {},
  handler: async (ctx) => {
    const admin = await requireSuperAdmin(ctx);
    const grant = await findActiveGrant(ctx, admin._id);
    if (!grant) return;

    await ctx.db.delete(grant.membershipId);
    await ctx.db.patch(grant._id, { revokedAt: Date.now() });

    await writeAuditLog(ctx, admin, {
      action: "endImpersonation",
      targetTable: "users",
      targetId: grant.targetUserId,
      orgId: grant.orgId,
    });
  },
});

/** Used by the impersonation banner to show who/what org/expiry. */
export const getMyActiveImpersonation = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx).catch(() => null);
    if (!admin) return null;

    const grant = await findActiveGrant(ctx, admin._id);
    if (!grant || grant.orgId !== args.orgId) return null;

    const [target, org, membership] = await Promise.all([
      ctx.db.get(grant.targetUserId),
      ctx.db.get(grant.orgId),
      ctx.db.get(grant.membershipId),
    ]);
    const role = membership ? await ctx.db.get(membership.roleId) : null;

    return {
      targetName: target?.name ?? target?.email ?? "Unknown user",
      targetEmail: target?.email,
      orgName: org?.name ?? "Unknown org",
      roleName: role?.name ?? "Unknown role",
      reason: grant.reason,
      expiresAt: grant.expiresAt,
    };
  },
});

export const expireGrant = internalMutation({
  args: { grantId: v.id("impersonationGrants") },
  handler: async (ctx, args) => {
    const grant = await ctx.db.get(args.grantId);
    if (!grant || grant.revokedAt) return;
    if (grant.expiresAt > Date.now()) return; // was extended/replaced — nothing to do

    const membership = await ctx.db.get(grant.membershipId);
    if (membership) await ctx.db.delete(grant.membershipId);
    await ctx.db.patch(grant._id, { revokedAt: Date.now() });
  },
});
