import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { mutation, query, action, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireSuperAdmin } from "./utils/tenancy";
import { throwAppError, AppErrorCode } from "./utils/errors";
import { logAdminAction } from "./adminAudit";

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
    const user = await ctx.db.get(args.userId);
    if (!user) throwAppError(AppErrorCode.USER_NOT_FOUND, "User not found.");

    await ctx.db.patch(args.userId, { disabled: true });
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
