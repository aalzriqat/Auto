import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireAuth, requireTenantAuth, requireOwner } from "./utils/tenancy";
import { PERMISSIONS, DEFAULT_ROLE_TEMPLATES } from "./utils/permissions";

// ─── Mutations ───────────────────────────────────────────────────────────────

/**
 * Creates a new organization and seeds it with default roles.
 * The calling user is automatically assigned the OWNER role.
 */
export const create = mutation({
  args: {
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireAuth(ctx);

    const orgId = await ctx.db.insert("organizations", {
      name: args.name.trim(),
      createdAt: Date.now(),
    });

    // Seed default roles for the new organization
    let ownerRoleId = null;
    for (const template of DEFAULT_ROLE_TEMPLATES) {
      const roleId = await ctx.db.insert("roles", {
        orgId,
        name: template.name,
        permissions: [...template.permissions],
      });
      if (template.name === "OWNER") {
        ownerRoleId = roleId;
      }
    }

    if (!ownerRoleId) {
      throw new ConvexError("Fatal: OWNER role template is missing from defaults.");
    }

    // Assign the creator as OWNER
    await ctx.db.insert("memberships", {
      orgId,
      userId: user._id,
      roleId: ownerRoleId,
    });

    return orgId;
  },
});

/**
 * Updates organization details. Requires EDIT_ORG permission.
 */
export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_ORG]);

    await ctx.db.patch(args.orgId, {
      name: args.name.trim(),
    });
  },
});

/**
 * Permanently deletes an organization and all associated data.
 * Restricted to the OWNER role.
 */
export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    // Delete all memberships
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    for (const m of memberships) {
      await ctx.db.delete(m._id);
    }

    // Delete all roles
    const roles = await ctx.db
      .query("roles")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    for (const r of roles) {
      await ctx.db.delete(r._id);
    }

    // Delete the organization itself
    await ctx.db.delete(args.orgId);
  },
});

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * Returns the organization record. Requires membership.
 */
export const get = query({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId);
    return await ctx.db.get(args.orgId);
  },
});

/**
 * Lists all organizations the current user belongs to,
 * including their role name within each org.
 */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireAuth(ctx);

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();

    const orgs = await Promise.all(
      memberships.map(async (m) => {
        const org = await ctx.db.get(m.orgId);
        const role = await ctx.db.get(m.roleId);
        return org
          ? {
              _id: org._id,
              name: org.name,
              createdAt: org.createdAt,
              roleName: role?.name ?? "UNKNOWN",
              membershipId: m._id,
            }
          : null;
      })
    );

    return orgs.filter(Boolean);
  },
});
