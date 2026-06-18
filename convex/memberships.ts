import { v, ConvexError } from "convex/values";
import { mutation, query, action, internalMutation } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { internal } from "./_generated/api";
import { requireTenantAuth, requireOwner } from "./utils/tenancy";
import { PERMISSIONS, ALL_PERMISSIONS, DEFAULT_ROLE_TEMPLATES } from "./utils/permissions";

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
          commissionRate: m.commissionRate ?? 0,
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
    // OWNER always gets all permissions — prevents stale DB roles when new permissions are added
    const permissions: string[] = role.name === "OWNER"
      ? [...ALL_PERMISSIONS]
      : role.permissions;
    return {
      _id: membership._id,
      userId: user._id,
      roleId: role._id,
      roleName: role.name,
      permissions,
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

    // Only delete the Convex user record and Clerk account if this was
    // their last org membership. Multi-org users must not be evicted globally.
    if (user) {
      const remaining = await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .collect();

      if (remaining.length === 0) {
        await ctx.db.delete(user._id);
        return user.clerkId;
      }
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
          const res = await fetch(`https://api.clerk.com/v1/users/${clerkId}`, {
            method: "DELETE",
            headers: {
              "Authorization": `Bearer ${clerkSecret}`
            }
          });
          
          if (!res.ok) {
            throw new ConvexError("User removed from DB, but failed to remove from authentication provider.");
          }
        } catch (error) {
          if (error instanceof ConvexError) throw error;
          throw new ConvexError("Failed to connect to authentication provider to remove user.");
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

/** Generates a random password meeting Clerk's default complexity rules (mixed case, digit, symbol, 12+ chars). */
function generateTemporaryPassword(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  const random = Array.from(bytes, (b) => b.toString(36)).join("").slice(0, 20);
  return `Af${random}!9`;
}

/** Derives a Clerk-compatible username (this Clerk instance requires one): first initial + full last name. */
function generateUsername(firstName: string, lastName: string, email: string, suffix: number): string {
  const firstInitial = firstName.trim().charAt(0).toLowerCase().replace(/[^a-z0-9]/g, "");
  const cleanLastName = lastName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const base = `${firstInitial}${cleanLastName}`
    || email.split("@")[0].toLowerCase().replace(/[^a-z0-9]/g, "")
    || "user";
  return suffix === 0 ? base : `${base}${suffix}`;
}

export const createAccount = action({
  args: {
    orgId: v.id("organizations"),
    firstName: v.string(),
    lastName: v.string(),
    email: v.string(),
    roleId: v.id("roles"),
  },
  handler: async (ctx, args) => {
    const fullName = `${args.firstName.trim()} ${args.lastName.trim()}`.trim();

    // 1. Prepare: Check permissions and insert invitation
    const inviteId = await ctx.runMutation(internal.memberships.prepareDirectAccount, {
      orgId: args.orgId,
      email: args.email,
      roleId: args.roleId,
    });

    try {
      const clerkSecret = process.env.CLERK_SECRET_KEY;
      if (!clerkSecret) throw new ConvexError("CLERK_SECRET_KEY is not set.");

      // 2. Check if a Clerk user already exists with this email
      const lookupResponse = await fetch(
        `https://api.clerk.com/v1/users?email_address=${encodeURIComponent(args.email.toLowerCase().trim())}`,
        {
          method: "GET",
          headers: { "Authorization": `Bearer ${clerkSecret}` },
        }
      );

      let clerkId: string | null = null;
      let isNewClerkUser = false;

      if (lookupResponse.ok) {
        const existingUsers = await lookupResponse.json();
        if (Array.isArray(existingUsers) && existingUsers.length > 0) {
          // User already has a Clerk account — reuse it, no need to create
          clerkId = existingUsers[0].id;
        }
      }

      let temporaryPassword: string | null = null;

      if (!clerkId) {
        // 3a. No existing Clerk account — create a new one with an auto-generated password + username
        temporaryPassword = generateTemporaryPassword();
        isNewClerkUser = true;

        let response: Response | null = null;
        let errorData: any = null;

        // This Clerk instance requires a unique username — retry with a numeric suffix on collision.
        for (let attempt = 0; attempt < 5; attempt++) {
          const username = generateUsername(args.firstName, args.lastName, args.email, attempt);

          response = await fetch("https://api.clerk.com/v1/users", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${clerkSecret}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              email_address: [args.email.toLowerCase().trim()],
              password: temporaryPassword,
              username,
              first_name: args.firstName.trim(),
              last_name: args.lastName.trim() || undefined,
              skip_password_checks: false,
              skip_password_requirement: false,
            }),
          });

          if (response.ok) break;

          errorData = await response.json();
          const isUsernameTaken = errorData.errors?.some((e: any) => e.meta?.param_name === "username");
          if (!isUsernameTaken) break;
        }

        if (!response!.ok) {
          const firstError = errorData?.errors?.[0];
          if (firstError) {
            if (firstError.code === "form_data_missing" && firstError.meta?.param_names?.includes("last_name")) {
              throw new ConvexError("Family name is required. Please enter both first and last name.");
            }
            throw new ConvexError(firstError.long_message || firstError.message || "Failed to create user in Clerk");
          }
          throw new ConvexError("Failed to create user in Clerk");
        }

        const clerkUser = await response!.json();
        clerkId = clerkUser.id;
      }

      // 3b. Finalize: Create Convex user record + membership (idempotent)
      await ctx.runMutation(internal.memberships.finalizeDirectAccount, {
        clerkId: clerkId!,
        email: args.email,
        name: fullName,
        orgId: args.orgId,
        roleId: args.roleId,
        inviteId,
      });

      // 3c. Email the temporary password — only for accounts we just created in Clerk
      if (isNewClerkUser && temporaryPassword) {
        const org = await ctx.runQuery(internal.organizations.getInternal, { orgId: args.orgId });
        await ctx.scheduler.runAfter(0, internal.email.sendNewAccountCredentials, {
          toEmail: args.email,
          firstName: args.firstName.trim(),
          orgName: org?.name ?? "AutoFlow",
          temporaryPassword,
        });
      }

      return { success: true };
    } catch (error: any) {
      // Rollback: Delete the invitation if anything failed
      await ctx.runMutation(internal.memberships.rollbackDirectAccount, { inviteId });
      throw new ConvexError(error.message || "An unexpected error occurred during user creation.");
    }
  }
});

/**
 * Check whether an email address already has a Clerk account.
 * Returns exists flag and the user's first/last name if found.
 * Used by the frontend to decide whether to show the name-entry fields.
 */
export const checkEmailExists = action({
  args: { email: v.string() },
  handler: async (ctx, args): Promise<{ exists: boolean; firstName?: string; lastName?: string }> => {
    const clerkSecret = process.env.CLERK_SECRET_KEY;
    if (!clerkSecret) return { exists: false };

    const response = await fetch(
      `https://api.clerk.com/v1/users?email_address=${encodeURIComponent(args.email.toLowerCase().trim())}`,
      {
        method: "GET",
        headers: { "Authorization": `Bearer ${clerkSecret}` },
      }
    );

    if (!response.ok) return { exists: false };

    const users = await response.json();
    if (!Array.isArray(users) || users.length === 0) return { exists: false };

    const clerkUser = users[0];
    return {
      exists: true,
      firstName: clerkUser.first_name || undefined,
      lastName: clerkUser.last_name || undefined,
    };
  }
});


/**
 * Re-applies the default permission template to all standard roles in the org.
 * Safe to call after adding new permissions — only updates roles whose names
 * match a template (OWNER, MANAGER, SALES, RECEPTION, ACCOUNTANT).
 * Custom roles are never touched.
 */
export const syncRolePermissionsToTemplate = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);
    const roles = await ctx.db
      .query("roles")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    let updated = 0;
    for (const role of roles) {
      const template = DEFAULT_ROLE_TEMPLATES.find(t => t.name === role.name);
      if (!template) continue;
      await ctx.db.patch(role._id, { permissions: [...template.permissions] });
      updated++;
    }
    return updated;
  },
});

export const updateCommissionRate = mutation({
  args: {
    orgId: v.id("organizations"),
    membershipId: v.id("memberships"),
    commissionRate: v.number(),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_USERS]);

    const membership = await ctx.db.get(args.membershipId);
    if (!membership || membership.orgId !== args.orgId) {
      throw new ConvexError("Membership not found in this organization.");
    }

    if (args.commissionRate < 0 || args.commissionRate > 100) {
      throw new ConvexError("Commission rate must be between 0 and 100.");
    }

    await ctx.db.patch(args.membershipId, { commissionRate: args.commissionRate });
  },
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
      // Only update fields that are blank — don't overwrite an existing user's
      // real name/email with whatever the admin typed in the invite form.
      const patch: Record<string, string> = {};
      if (!existingUser.name && args.name) patch.name = args.name;
      if (!existingUser.email && args.email) patch.email = args.email;
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(existingUser._id, patch);
      }
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
