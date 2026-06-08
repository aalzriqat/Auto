import { v, ConvexError } from "convex/values";
import { mutation, query, action, internalMutation } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { internal } from "./_generated/api";
import { requireTenantAuth, requireOwner } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * Lists all members of an organization, hydrated with user and role data.
 */
export const list = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_USERS]);

    const pageResult = await ctx.db
      .query("memberships")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .paginate(args.paginationOpts);

    const page = await Promise.all(
      pageResult.page.map(async (m) => {
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
    
    return { ...pageResult, page };
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

    const org = await ctx.db.get(args.orgId);
    if (!org) throw new ConvexError("Organization not found");

    const email = args.userEmail.toLowerCase().trim();

    // Find the target user by email
    const targetUser = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("email"), email))
      .first();

    if (!targetUser) {
      // User doesn't exist yet, create an invitation!
      // Check if they are already invited
      const existingInvite = await ctx.db
        .query("invitations")
        .withIndex("by_email", (q) => q.eq("email", email))
        .filter((q) => q.eq(q.field("orgId"), args.orgId))
        .first();

      if (existingInvite) {
        throw new ConvexError("An invitation is already pending for this email.");
      }

      await ctx.db.insert("invitations", {
        orgId: args.orgId,
        email,
        roleId: args.roleId,
        createdAt: Date.now(),
      });

      // Schedule the invite email
      await ctx.scheduler.runAfter(0, internal.email.sendTeamInvite, {
        toEmail: email,
        orgName: org.name,
      });

      return { status: "invited" };
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

    await ctx.db.insert("memberships", {
      orgId: args.orgId,
      userId: targetUser._id,
      roleId: args.roleId,
    });

    return { status: "added" };
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
export const removeMembershipInternal = internalMutation({
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

    const user = await ctx.db.get(membership.userId);

    await ctx.db.delete(args.membershipId);

    // Also remove the user record entirely from the database
    // since accounts are strictly tied to orgs in this setup
    if (user) {
      await ctx.db.delete(user._id);
      return user.clerkId;
    }
    
    return null;
  },
});

export const remove = action({
  args: {
    orgId: v.id("organizations"),
    membershipId: v.id("memberships"),
  },
  handler: async (ctx, args) => {
    const clerkId = await ctx.runMutation(internal.memberships.removeMembershipInternal, args);

    if (clerkId) {
      const clerkSecret = process.env.CLERK_SECRET_KEY;
      if (clerkSecret) {
        try {
          await fetch(`https://api.clerk.com/v1/users/${clerkId}`, {
            method: "DELETE",
            headers: {
              "Authorization": `Bearer ${clerkSecret}`
            }
          });
        } catch (error) {
          console.error("Failed to delete user from Clerk:", error);
        }
      }
    }
  }
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

// ─── Direct Account Creation ──────────────────────────────────────────────────

/**
 * Prepares the direct account creation by checking permissions
 * and inserting a temporary invitation to be converted by the webhook.
 */
export const prepareDirectAccount = internalMutation({
  args: {
    orgId: v.id("organizations"),
    email: v.string(),
    roleId: v.id("roles"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_USERS]);

    const role = await ctx.db.get(args.roleId);
    if (!role || role.orgId !== args.orgId) {
      throw new ConvexError("The specified role does not belong to this organization.");
    }

    const email = args.email.toLowerCase().trim();

    // Find the target user by email
    const targetUser = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("email"), email))
      .first();

    if (targetUser) {
      const existing = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) =>
          q.eq("orgId", args.orgId).eq("userId", targetUser._id)
        )
        .unique();

      if (existing) {
        throw new ConvexError("This user is already a member of this organization.");
      }
    }

    // Check if they are already invited
    const existingInvite = await ctx.db
      .query("invitations")
      .withIndex("by_email", (q) => q.eq("email", email))
      .filter((q) => q.eq(q.field("orgId"), args.orgId))
      .first();

    if (existingInvite) {
      throw new ConvexError("An invitation is already pending for this email. Delete it first if you want to recreate.");
    }

    return await ctx.db.insert("invitations", {
      orgId: args.orgId,
      email,
      roleId: args.roleId,
      createdAt: Date.now(),
    });
  }
});

export const rollbackDirectAccount = internalMutation({
  args: { inviteId: v.id("invitations") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.inviteId);
  }
});

export const createAccount = action({
  args: {
    orgId: v.id("organizations"),
    name: v.string(),
    username: v.string(),
    email: v.string(),
    password: v.string(),
    roleId: v.id("roles"),
  },
  handler: async (ctx, args) => {
    // 1. Prepare: Check permissions and insert invitation
    const inviteId = await ctx.runMutation(internal.memberships.prepareDirectAccount, {
      orgId: args.orgId,
      email: args.email,
      roleId: args.roleId,
    });

    try {
      // 2. Call Clerk API to create the user
      const clerkSecret = process.env.CLERK_SECRET_KEY;
      if (!clerkSecret) throw new Error("CLERK_SECRET_KEY is not set.");

      const response = await fetch("https://api.clerk.com/v1/users", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${clerkSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email_address: [args.email.toLowerCase().trim()],
          password: args.password,
          username: args.username,
          first_name: args.name.split(" ")[0],
          last_name: args.name.split(" ").slice(1).join(" ") || undefined,
          skip_password_checks: false,
          skip_password_requirement: false,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error("Clerk user creation failed:", errorData);
        throw new Error(errorData.errors?.[0]?.message || "Failed to create user in Clerk");
      }

      // Parse Clerk API response
      const clerkUser = await response.json();
      const clerkId = clerkUser.id;

      // 3. Finalize: Instantly create the user and membership in Convex
      // This bypasses the webhook delay ensuring immediate access.
      await ctx.runMutation(internal.memberships.finalizeDirectAccount, {
        clerkId,
        email: args.email,
        name: args.name,
        orgId: args.orgId,
        roleId: args.roleId,
        inviteId,
      });

      return { success: true };
    } catch (error: any) {
      // 3. Rollback: Delete the invitation if Clerk creation failed
      await ctx.runMutation(internal.memberships.rollbackDirectAccount, { inviteId });
      throw new ConvexError(error.message || "An unexpected error occurred during user creation.");
    }
  }
});

export const finalizeDirectAccount = internalMutation({
  args: {
    clerkId: v.string(),
    email: v.string(),
    name: v.string(),
    orgId: v.id("organizations"),
    roleId: v.id("roles"),
    inviteId: v.id("invitations"),
  },
  handler: async (ctx, args) => {
    // Upsert User
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", args.clerkId))
      .unique();

    let userId;
    if (existingUser) {
      await ctx.db.patch(existingUser._id, {
        email: args.email,
        name: args.name,
      });
      userId = existingUser._id;
    } else {
      userId = await ctx.db.insert("users", {
        clerkId: args.clerkId,
        email: args.email,
        name: args.name,
      });
    }

    // Insert Membership
    const existingMembership = await ctx.db
      .query("memberships")
      .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", userId))
      .unique();

    if (!existingMembership) {
      await ctx.db.insert("memberships", {
        orgId: args.orgId,
        userId: userId,
        roleId: args.roleId,
      });
    }

    // Clean up Invitation
    const invite = await ctx.db.get(args.inviteId);
    if (invite) {
      await ctx.db.delete(args.inviteId);
    }
  }
});
