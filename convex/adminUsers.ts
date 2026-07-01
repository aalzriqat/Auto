import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { mutation, query, action, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireSuperAdmin } from "./utils/tenancy";
import { throwAppError, AppErrorCode } from "./utils/errors";
import { logAdminAction } from "./adminAudit";
import { notifyUser } from "./utils/notifications";
import { Id } from "./_generated/dataModel";
import { MutationCtx } from "./_generated/server";

/** disableUser/enableUser aren't org-scoped, but notifications are — fan out across every org the user belongs to. */
async function notifyUserAcrossOrgs(
  ctx: MutationCtx,
  userId: Id<"users">,
  type: "admin.user_disabled" | "admin.user_enabled",
) {
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const membership of memberships) {
    await notifyUser(ctx, membership.orgId, userId, type, {});
  }
}

/**
 * Recovery escape hatch for a super admin who locked themselves out by
 * disabling their own account (requireAuth rejects disabled users before
 * requireSuperAdmin even runs, so no authenticated mutation can undo it).
 * Internal only — not reachable from the client, just `npx convex run`.
 */
export const setDisabledByEmailInternal = internalMutation({
  args: { email: v.string(), disabled: v.boolean() },
  handler: async (ctx, args) => {
    const target = args.email.toLowerCase().trim();
    const allUsers = await ctx.db.query("users").collect();
    const user = allUsers.find((u) => u.email.toLowerCase() === target);
    if (!user) throw new ConvexError(`No user found with email ${args.email}`);
    await ctx.db.patch(user._id, { disabled: args.disabled });
    return { userId: user._id, disabled: args.disabled };
  },
});

export const listUsers = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const page = await ctx.db.query("users").order("desc").paginate(args.paginationOpts);

    const items = await Promise.all(
      page.page.map(async (user) => {
        const memberships = await ctx.db
          .query("memberships")
          .withIndex("by_user", (q) => q.eq("userId", user._id))
          .collect();

        const orgs = await Promise.all(
          memberships.map(async (m) => {
            const org = await ctx.db.get(m.orgId);
            const role = await ctx.db.get(m.roleId);
            return { orgId: m.orgId, orgName: org?.name ?? "Unknown", roleName: role?.name ?? "Unknown" };
          })
        );

        return { ...user, orgs };
      })
    );

    return { ...page, page: items };
  },
});

export const getUserDetail = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const user = await ctx.db.get(args.userId);
    if (!user) throwAppError(AppErrorCode.USER_NOT_FOUND, "User not found.");

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();

    const orgs = await Promise.all(
      memberships.map(async (m) => {
        const org = await ctx.db.get(m.orgId);
        const role = await ctx.db.get(m.roleId);
        return { membershipId: m._id, orgId: m.orgId, orgName: org?.name ?? "Unknown", roleId: m.roleId, roleName: role?.name ?? "Unknown" };
      })
    );

    return { user, orgs };
  },
});

export const listRolesForOrg = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    return await ctx.db
      .query("roles")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.neq(q.field("isDeleted"), true))
      .collect();
  },
});

export const disableUser = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);
    if (args.userId === admin._id) {
      throwAppError(AppErrorCode.FORBIDDEN, "Forbidden: You cannot disable your own account.");
    }
    const user = await ctx.db.get(args.userId);
    if (!user) throwAppError(AppErrorCode.USER_NOT_FOUND, "User not found.");

    await ctx.db.patch(args.userId, { disabled: true });
    await notifyUserAcrossOrgs(ctx, args.userId, "admin.user_disabled");
    await logAdminAction(ctx, admin, {
      action: "disableUser",
      targetTable: "users",
      targetId: args.userId,
      before: { disabled: user.disabled ?? false },
      after: { disabled: true },
    });
  },
});

export const enableUser = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);
    const user = await ctx.db.get(args.userId);
    if (!user) throwAppError(AppErrorCode.USER_NOT_FOUND, "User not found.");

    await ctx.db.patch(args.userId, { disabled: false });
    await notifyUserAcrossOrgs(ctx, args.userId, "admin.user_enabled");
    await logAdminAction(ctx, admin, {
      action: "enableUser",
      targetTable: "users",
      targetId: args.userId,
      before: { disabled: true },
      after: { disabled: false },
    });
  },
});

export const changeUserRole = mutation({
  args: { userId: v.id("users"), orgId: v.id("organizations"), roleId: v.id("roles") },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);

    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", args.userId))
      .unique();
    if (!membership) throwAppError(AppErrorCode.MEMBER_NOT_FOUND, "Membership not found.");

    const newRole = await ctx.db.get(args.roleId);
    if (!newRole || newRole.orgId !== args.orgId) {
      throwAppError(AppErrorCode.ROLE_NOT_FOUND, "Role does not belong to this organization.");
    }

    const oldRole = await ctx.db.get(membership.roleId);
    await ctx.db.patch(membership._id, { roleId: args.roleId });

    await notifyUser(ctx, args.orgId, args.userId, "admin.user_role_changed", { roleName: newRole.name });

    await logAdminAction(ctx, admin, {
      action: "changeUserRole",
      targetTable: "memberships",
      targetId: membership._id,
      orgId: args.orgId,
      before: { roleName: oldRole?.name },
      after: { roleName: newRole.name },
    });
  },
});

export const removeMembership = mutation({
  args: { userId: v.id("users"), orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", args.userId))
      .unique();
    if (!membership) throwAppError(AppErrorCode.MEMBER_NOT_FOUND, "Membership not found.");

    await ctx.db.delete(membership._id);
    await logAdminAction(ctx, admin, {
      action: "removeMembership",
      targetTable: "memberships",
      targetId: membership._id,
      orgId: args.orgId,
      before: { userId: args.userId },
    });
  },
});

export const listOffboardingReviews = query({
  args: {
    status: v.optional(v.union(v.literal("PENDING_REVIEW"), v.literal("RESOLVED"))),
  },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);

    const reviews = args.status
      ? await ctx.db
        .query("userOffboardingReviews")
        .withIndex("by_status", (q) => q.eq("status", args.status!))
        .take(100)
      : await ctx.db.query("userOffboardingReviews").order("desc").take(100);

    return await Promise.all(
      reviews.map(async (review) => {
        const user = await ctx.db.get(review.userId);
        const ownerOrgs = await Promise.all(
          review.ownerOrgIds.map(async (orgId) => {
            const org = await ctx.db.get(orgId);
            return { orgId, orgName: org?.name ?? "Unknown" };
          })
        );
        return {
          ...review,
          userEmail: user?.email ?? "Deleted user",
          userName: user?.name ?? "Deleted user",
          ownerOrgs,
        };
      })
    );
  },
});

export const resolveOffboardingReview = mutation({
  args: {
    reviewId: v.id("userOffboardingReviews"),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);
    const review = await ctx.db.get(args.reviewId);
    if (!review) throw new ConvexError("Offboarding review not found.");

    await ctx.db.patch(args.reviewId, {
      status: "RESOLVED",
      resolvedAt: Date.now(),
      resolvedBy: admin._id,
      notes: args.notes?.trim() || undefined,
    });

    await logAdminAction(ctx, admin, {
      action: "resolveUserOffboardingReview",
      targetTable: "userOffboardingReviews",
      targetId: args.reviewId,
      before: { status: review.status, membershipCount: review.membershipCount },
      after: { status: "RESOLVED" },
    });
  },
});

// ─── Hard user delete (DB + Clerk account) ───────────────────────────────────

export const deleteUserInternal = internalMutation({
  args: { adminUserId: v.id("users"), adminEmail: v.string(), userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) throwAppError(AppErrorCode.USER_NOT_FOUND, "User not found.");

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    for (const m of memberships) {
      await ctx.db.delete(m._id);
    }
    await ctx.db.delete(args.userId);

    await ctx.db.insert("adminAuditLog", {
      actorUserId: args.adminUserId,
      actorEmail: args.adminEmail,
      action: "deleteUser",
      targetTable: "users",
      targetId: args.userId,
      before: { email: user.email, membershipCount: memberships.length },
      createdAt: Date.now(),
    });

    return user.clerkId;
  },
});

export const deleteUser = action({
  args: { userId: v.id("users"), confirmEmail: v.string() },
  handler: async (ctx, args): Promise<{ success: true }> => {
    const admin = await ctx.runQuery(internal.adminUsers.requireSuperAdminForAction, {});
    if (args.userId === admin._id) {
      throw new ConvexError("You cannot delete your own account.");
    }
    const target = await ctx.runQuery(internal.adminUsers.getUserForDeleteCheck, { userId: args.userId });

    if (!target || target.email.toLowerCase() !== args.confirmEmail.toLowerCase().trim()) {
      throw new ConvexError("Confirmation email does not match.");
    }

    const clerkId = await ctx.runMutation(internal.adminUsers.deleteUserInternal, {
      adminUserId: admin._id,
      adminEmail: admin.email,
      userId: args.userId,
    });

    const clerkSecret = process.env.CLERK_SECRET_KEY;
    if (clerkSecret && clerkId) {
      const res = await fetch(`https://api.clerk.com/v1/users/${clerkId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${clerkSecret}` },
      });
      if (!res.ok) {
        throw new ConvexError("User removed from the database, but failed to remove from Clerk.");
      }
    }

    return { success: true };
  },
});

export const requireSuperAdminForAction = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await requireSuperAdmin(ctx);
  },
});

export const getUserForDeleteCheck = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.userId);
  },
});
