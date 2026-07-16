import { v, ConvexError } from "convex/values";
import { mutation, query, internalQuery, MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireTenantAuth, requireOwner } from "./utils/tenancy";
import { PERMISSIONS, DEFAULT_ROLE_TEMPLATES, SYSTEM_OWNER_ROLE_NAME } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";
import { throwAppError, AppErrorCode } from "./utils/errors";

const ACTIVE_DELETION_STATUSES = ["PENDING_REVIEW", "APPROVED", "RUNNING"] as const;
type AuthIdentity = NonNullable<Awaited<ReturnType<MutationCtx["auth"]["getUserIdentity"]>>>;

function placeholderEmailForSubject(subject: string): string {
  const safeSubject = subject.replace(/[^a-zA-Z0-9._+-]/g, "_");
  return `no-email-${safeSubject}@autoflow.local`;
}

function nameFromIdentity(identity: AuthIdentity): string | undefined {
  return identity.name ?? identity.givenName ?? identity.preferredUsername ?? identity.email;
}

async function requireOrCreateAuthenticatedUser(ctx: MutationCtx): Promise<Doc<"users">> {
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

  const email = typeof identity.email === "string" && identity.email.trim()
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

async function findActiveDeletionRequest(ctx: MutationCtx, orgId: Id<"organizations">) {
  for (const status of ACTIVE_DELETION_STATUSES) {
    const request = await ctx.db
      .query("organizationDeletionRequests")
      .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", status))
      .first();
    if (request) {
      return request;
    }
  }
  return null;
}

/** Internal lookup (no auth) for server-side flows like account-creation emails. */
export const getInternal = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.orgId);
  },
});

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
    const user = await requireOrCreateAuthenticatedUser(ctx);

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
        isSystemOwnerRole: template.name === SYSTEM_OWNER_ROLE_NAME,
      });
      if (template.name === SYSTEM_OWNER_ROLE_NAME) {
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

    // All new orgs start on the enterprise plan (no time limit)
    await ctx.db.insert("subscriptions", {
      orgId,
      plan: "enterprise",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
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
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_ORG]);

    await ctx.db.patch(args.orgId, {
      name: args.name.trim(),
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "organization.settings_changed",
      { actorName },
      { excludeUserId: user._id }
    );
  },
});

/**
 * Requests organization deletion. Restricted to the OWNER role.
 * Platform super-admin review is required before any data is permanently deleted.
 */
export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireOwner(ctx, args.orgId);
    const org = await ctx.db.get(args.orgId);
    if (!org) {
      throwAppError(AppErrorCode.ORG_NOT_FOUND, "Organization not found.");
    }

    const existingRequest = await findActiveDeletionRequest(ctx, args.orgId);
    if (existingRequest) {
      throwAppError(AppErrorCode.PENDING_REQUEST_EXISTS, "This organization already has an active deletion request.");
    }

    const now = Date.now();
    const requestId = await ctx.db.insert("organizationDeletionRequests", {
      orgId: args.orgId,
      orgName: org.name,
      requestedBy: user._id,
      requestedAt: now,
      reason: args.reason,
      status: "PENDING_REVIEW",
      lastProcessedAt: now,
    });

    await ctx.db.patch(args.orgId, {
      suspended: true,
      suspendedAt: now,
      suspendedReason: "Organization deletion requested by owner and awaiting platform review.",
      deletionRequestedAt: now,
      deletionRequestId: requestId,
    });

    await notifyManagers(ctx, args.orgId, "admin.org_suspended", {
      reason: "Organization deletion requested by owner and awaiting platform review.",
    });

    return { requestId, status: "PENDING_REVIEW" as const };
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
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError("Unauthenticated: You must be logged in.");
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (!user) {
      // The Clerk webhook hasn't finished syncing yet.
      // Return an empty array. When the webhook inserts the user, 
      // this query will automatically re-run because it's tracking the `users` table.
      return [];
    }

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
              permissions: role?.permissions ?? [],
            }
          : null;
      })
    );

    return orgs.filter(Boolean);
  },
});
