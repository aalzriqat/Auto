import { v, ConvexError } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { requireTenantAuth, requireOwner } from "./utils/tenancy";
import {
  PERMISSIONS,
  dedupePermissions,
  getInvalidPermissions,
  isReservedRoleName,
  isSystemOwnerRole,
  isUnqualifiedOwnerNamed,
  newlyAddedLegacyPermissions,
  normalizeRoleName,
} from "./utils/permissions";
import { notifyOwner, getActorName } from "./utils/notifications";
import { requireFeature } from "./subscriptions";
import { AppErrorCode, throwAppError } from "./utils/errors";

// Translated under ServerError_PERMISSION_RETIRED; the EN dictionary text equals this string.
const RETIRED_PERMISSION_MESSAGE =
  'The "Finalize financed deal" permission is no longer used. Grant "Record the supplier payment route" or "Cancel a closed financed deal" instead.';

// Translated under ServerError_OWNER_NAMED_ROLE_LOCKED; the EN dictionary text equals this string.
const OWNER_NAMED_ROLE_LOCKED_MESSAGE =
  "This role is named OWNER but is not the system owner role, so its permissions cannot be edited. Rename it to a different name first.";

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

    const roles = await ctx.db
      .query("roles")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    return roles.filter((role) => !role.isDeleted);
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
    await requireFeature(ctx, args.orgId, "customRoles");

    const roleName = args.name.trim();
    if (!roleName) {
      throw new ConvexError("Role name is required.");
    }
    if (isReservedRoleName(roleName)) {
      throw new ConvexError("OWNER is a reserved system role name.");
    }

    const invalidPermissions = getInvalidPermissions(args.permissions);
    if (invalidPermissions.length > 0) {
      throw new ConvexError(`Invalid permissions: ${invalidPermissions.join(", ")}`);
    }
    // SCRUM-413: finalize:financed_deal was split into
    // manage:supplier_settlement and cancel:closed_deal and is retired. A new
    // role has no reason to start carrying it.
    if (newlyAddedLegacyPermissions(args.permissions, []).length > 0) {
      throwAppError(AppErrorCode.PERMISSION_RETIRED, RETIRED_PERMISSION_MESSAGE);
    }

    // Prevent duplicate role names within the same org
    const existingRoles = await ctx.db
      .query("roles")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    const normalizedName = normalizeRoleName(roleName);
    const duplicate = existingRoles.find(
      (r) => !r.isDeleted && normalizeRoleName(r.name) === normalizedName
    );
    if (duplicate) {
      throw new ConvexError(`A role named "${roleName}" already exists in this organization.`);
    }

    const roleId = await ctx.db.insert("roles", {
      orgId: args.orgId,
      name: roleName,
      permissions: dedupePermissions(args.permissions),
    });

    const actorName = await getActorName(ctx);
    await notifyOwner(ctx, args.orgId, "role.changed", { actorName, roleName });

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
    await requireFeature(ctx, args.orgId, "customRoles");

    const role = await ctx.db.get(args.roleId);
    if (!role || role.isDeleted || role.orgId !== args.orgId) {
      throw new ConvexError("Role not found in this organization.");
    }

    const roleIsOwner = isSystemOwnerRole(role);

    // The system OWNER role is immutable; it can only be resynced by template tooling.
    if (roleIsOwner && args.name && normalizeRoleName(args.name) !== "OWNER") {
      throw new ConvexError("The OWNER role cannot be renamed.");
    }
    if (roleIsOwner && args.permissions !== undefined) {
      throw new ConvexError("The OWNER role permissions cannot be customized.");
    }

    // SCRUM-413 S413B-4/L-2: an OWNER-named row that does not qualify must not gain owner-scale
    // authority from an edit (crossing the frozen fallback); see isUnqualifiedOwnerNamed.
    if (args.permissions !== undefined && isUnqualifiedOwnerNamed(role)) {
      throwAppError(AppErrorCode.OWNER_NAMED_ROLE_LOCKED, OWNER_NAMED_ROLE_LOCKED_MESSAGE);
    }

    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) {
      const roleName = args.name.trim();
      if (!roleName) {
        throw new ConvexError("Role name is required.");
      }
      if (!roleIsOwner && isReservedRoleName(roleName)) {
        throw new ConvexError("OWNER is a reserved system role name.");
      }

      const existingRoles = await ctx.db
        .query("roles")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .collect();
      const normalizedName = normalizeRoleName(roleName);
      const duplicate = existingRoles.find(
        (r) => !r.isDeleted && r._id !== args.roleId && normalizeRoleName(r.name) === normalizedName
      );
      if (duplicate) {
        throw new ConvexError(`A role named "${roleName}" already exists in this organization.`);
      }

      // The system OWNER role is stored normalized. The guard above accepts any
      // casing/spacing that normalizes to "OWNER", but isSystemOwnerRole()'s
      // legacy fallback matches `role.name === "OWNER"` EXACTLY — so storing
      // "owner" verbatim made an org whose isSystemOwnerRole flag is unset stop
      // being recognised as having an owner at all. That locks it out of every
      // requireOwner path, including this mutation, so it cannot be undone from
      // the app. Custom roles keep the name exactly as typed.
      patch.name = roleIsOwner ? normalizeRoleName(roleName) : roleName;
    }
    if (args.permissions !== undefined) {
      const invalidPermissions = getInvalidPermissions(args.permissions);
      if (invalidPermissions.length > 0) {
        throw new ConvexError(`Invalid permissions: ${invalidPermissions.join(", ")}`);
      }
      // SCRUM-413: a retired permission already stored on the role may
      // round-trip through an edit; a NEWLY added one is refused. Editing or
      // renaming a role never grants anything the caller did not send.
      if (newlyAddedLegacyPermissions(args.permissions, role.permissions).length > 0) {
        throwAppError(AppErrorCode.PERMISSION_RETIRED, RETIRED_PERMISSION_MESSAGE);
      }
      patch.permissions = dedupePermissions(args.permissions);
    }

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
    await requireFeature(ctx, args.orgId, "customRoles");

    const role = await ctx.db.get(args.roleId);
    if (!role || role.isDeleted || role.orgId !== args.orgId) {
      throw new ConvexError("Role not found in this organization.");
    }

    if (isSystemOwnerRole(role)) {
      throw new ConvexError("The OWNER role cannot be deleted.");
    }

    // Ensure no memberships reference this role
    let roleInUse = false;
    for await (const membership of ctx.db
      .query("memberships")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))) {
      if (membership.roleId === args.roleId) {
        roleInUse = true;
        break;
      }
    }

    if (roleInUse) {
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
