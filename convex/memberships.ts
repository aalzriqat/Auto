import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth, requireOwner } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * Lists all members of an organization, hydrated with user and role data.
 */
export const list = query({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_USERS]);

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    return await Promise.all(
      memberships.map(async (m) => {
        const user = await ctx.db.get(m.userId);
        const role = await ctx.db.get(m.roleId);
        return {
          _id: m._id,
          orgId: m.orgId,
          userId: m.userId,
          roleId: m.roleId,
          userName: user?.name ?? user?.email ?? "Unknown",
          userEmail: user?.email ?? "",
          userImage: user?.imageUrl,
          roleName: role?.name ?? "UNKNOWN",
        };
      })
    );
  },
});

/**
 * Returns the current user's own membership within an organization,
 * including their role and permissions. Useful for the frontend to
 * conditionally render UI based on permissions.
 */
export const getMyMembership = query({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    const { user, membership, role } = await requireTenantAuth(ctx, args.orgId);
    return {
      _id: membership._id,
      userId: user._id,
      roleId: role._id,
      roleName: role.name,
      permissions: role.permissions,
    };
  },
});

// ─── Mutations ───────────────────────────────────────────────────────────────

/**
 * Adds a user to an organization with a specified role.
 * The target user must already exist in the `users` table (synced via Clerk webhook).
 * Requires MANAGE_USERS permission.
 */
export const add = mutation({
  args: {
    orgId: v.id("organizations"),
    userEmail: v.string(),
    roleId: v.id("roles"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_USERS]);

    // Verify the role belongs to this org
    const role = await ctx.db.get(args.roleId);
    if (!role || role.orgId !== args.orgId) {
      throw new ConvexError("The specified role does not belong to this organization.");
    }

    // Find the target user by email
    const targetUser = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("email"), args.userEmail.toLowerCase().trim()))
      .first();

    if (!targetUser) {
      throw new ConvexError(
        "No user found with that email. They must sign up first before being added."
      );
    }

    // Check for existing membership
    const existing = await ctx.db
      .query("memberships")
      .withIndex("by_org_user", (q) =>
        q.eq("orgId", args.orgId).eq("userId", targetUser._id)
      )
      .unique();

    if (existing) {
      throw new ConvexError("This user is already a member of this organization.");
    }

    return await ctx.db.insert("memberships", {
      orgId: args.orgId,
      userId: targetUser._id,
      roleId: args.roleId,
    });
  },
});

/**
 * Changes a member's role within the organization.
 * Cannot change the OWNER's own role (prevents accidental lockout).
 * Requires MANAGE_USERS permission.
 */
export const updateRole = mutation({
  args: {
    orgId: v.id("organizations"),
    membershipId: v.id("memberships"),
    newRoleId: v.id("roles"),
  },
  handler: async (ctx, args) => {
    const { user: callingUser } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.MANAGE_USERS,
    ]);

    const membership = await ctx.db.get(args.membershipId);
    if (!membership || membership.orgId !== args.orgId) {
      throw new ConvexError("Membership not found in this organization.");
    }

    // Prevent changing the original OWNER's role
    const currentRole = await ctx.db.get(membership.roleId);
    if (currentRole?.name === "OWNER" && membership.userId === callingUser._id) {
      throw new ConvexError("You cannot change your own OWNER role. Transfer ownership first.");
    }

    // Verify the new role belongs to this org
    const newRole = await ctx.db.get(args.newRoleId);
    if (!newRole || newRole.orgId !== args.orgId) {
      throw new ConvexError("The specified role does not belong to this organization.");
    }

    // Only an OWNER can assign the OWNER role
    if (newRole.name === "OWNER") {
      await requireOwner(ctx, args.orgId);
    }

    await ctx.db.patch(args.membershipId, {
      roleId: args.newRoleId,
    });
  },
});

/**
 * Removes a member from the organization.
 * The last OWNER cannot be removed — there must always be at least one.
 * Requires MANAGE_USERS permission.
 */
export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    membershipId: v.id("memberships"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_USERS]);

    const membership = await ctx.db.get(args.membershipId);
    if (!membership || membership.orgId !== args.orgId) {
      throw new ConvexError("Membership not found in this organization.");
    }

    // Prevent removing the last OWNER
    const memberRole = await ctx.db.get(membership.roleId);
    if (memberRole?.name === "OWNER") {
      const allMemberships = await ctx.db
        .query("memberships")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .collect();

      let ownerCount = 0;
      for (const m of allMemberships) {
        const r = await ctx.db.get(m.roleId);
        if (r?.name === "OWNER") ownerCount++;
      }

      if (ownerCount <= 1) {
        throw new ConvexError(
          "Cannot remove the last owner. Transfer ownership to another member first."
        );
      }
    }

    await ctx.db.delete(args.membershipId);
  },
});

/**
 * Allows the current user to voluntarily leave an organization.
 * Cannot leave if the user is the last OWNER.
 */
export const leave = mutation({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    const { user, membership, role } = await requireTenantAuth(ctx, args.orgId);

    // Prevent the last OWNER from leaving
    if (role.name === "OWNER") {
      const allMemberships = await ctx.db
        .query("memberships")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .collect();

      let ownerCount = 0;
      for (const m of allMemberships) {
        const r = await ctx.db.get(m.roleId);
        if (r?.name === "OWNER") ownerCount++;
      }

      if (ownerCount <= 1) {
        throw new ConvexError(
          "You are the last owner. Transfer ownership before leaving."
        );
      }
    }

    await ctx.db.delete(membership._id);
  },
});
