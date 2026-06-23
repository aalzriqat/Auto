import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth, requireOwner } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyOwner, getActorName } from "./utils/notifications";

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * Lists all roles for an organization.
 * Any member with VIEW_USERS can see the available roles.
 */
export const list = query({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_USERS]);

    return await ctx.db
      .query("roles")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.neq(q.field("isDeleted"), true)).collect();
  },
});

/**
 * Gets a single role by ID. Verifies the role belongs to the specified org.
 */
export const get = query({
  args: {
    orgId: v.id("organizations"),
    roleId: v.id("roles"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_USERS]);

    const role = await ctx.db.get(args.roleId);
    if (!role || role.isDeleted || role.orgId !== args.orgId) {
      throw new ConvexError("Role not found in this organization.");
    }

    return role;
  },
});

// ─── Mutations ───────────────────────────────────────────────────────────────

/**
 * Creates a custom role within an organization.
 * Owner-only — role/permission management can't be delegated.
 */
export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    name: v.string(),
    permissions: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    // Prevent duplicate role names within the same org
    const existingRoles = await ctx.db
      .query("roles")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.neq(q.field("isDeleted"), true)).collect();

    const duplicate = existingRoles.find(
      (r) => r.name.toUpperCase() === args.name.trim().toUpperCase()
    );
    if (duplicate) {
      throw new ConvexError(`A role named "${args.name}" already exists in this organization.`);
    }

    const roleId = await ctx.db.insert("roles", {
      orgId: args.orgId,
      name: args.name.trim(),
      permissions: args.permissions,
    });

    const actorName = await getActorName(ctx);
    await notifyOwner(ctx, args.orgId, "role.changed", { actorName, roleName: args.name.trim() });

    return roleId;
  },
});

/**
 * Updates a role's name and/or permissions.
 * Owner-only — role/permission management can't be delegated.
 * The built-in OWNER role cannot be renamed.
 */
export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    roleId: v.id("roles"),
    name: v.optional(v.string()),
    permissions: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    const role = await ctx.db.get(args.roleId);
    if (!role || role.isDeleted || role.orgId !== args.orgId) {
      throw new ConvexError("Role not found in this organization.");
    }

    // Prevent renaming the OWNER role
    if (role.name === "OWNER" && args.name && args.name.trim().toUpperCase() !== "OWNER") {
      throw new ConvexError("The OWNER role cannot be renamed.");
    }

    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) patch.name = args.name.trim();
    if (args.permissions !== undefined) patch.permissions = args.permissions;

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.roleId, patch);

      const actorName = await getActorName(ctx);
      await notifyOwner(ctx, args.orgId, "role.changed", { actorName, roleName: role.name });
    }
  },
});

/**
 * Deletes a custom role. Cannot delete the OWNER role or any role
 * that is currently assigned to a membership.
 */
// TODO: Add admin recovery endpoint if needed
export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    roleId: v.id("roles"),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    const role = await ctx.db.get(args.roleId);
    if (!role || role.isDeleted || role.orgId !== args.orgId) {
      throw new ConvexError("Role not found in this organization.");
    }

    if (role.name === "OWNER") {
      throw new ConvexError("The OWNER role cannot be deleted.");
    }

    // Ensure no memberships reference this role
    const membershipsUsingRole = await ctx.db
      .query("memberships")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("roleId"), args.roleId))
      .first();

    if (membershipsUsingRole) {
      throw new ConvexError(
        "Cannot delete this role — it is currently assigned to one or more members. Reassign them first."
      );
    }

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Unauthenticated");
    await ctx.db.patch(args.roleId, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: identity.subject
    });

    const actorName = await getActorName(ctx);
    await notifyOwner(ctx, args.orgId, "role.changed", { actorName, roleName: role.name });
  },
});
