import { v, ConvexError } from "convex/values";
import { query, internalQuery, MutationCtx } from "./_generated/server";
import { mutation } from "./functions";
import { Id } from "./_generated/dataModel";
import { requireTenantAuth, requireOwner, requireOrCreateAuthenticatedUser } from "./utils/tenancy";
import { PERMISSIONS, DEFAULT_ROLE_TEMPLATES, SYSTEM_OWNER_ROLE_NAME } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";
import { throwAppError, AppErrorCode } from "./utils/errors";
import {
  SOCIAL_CONVERSATION_GENERATION,
  SOCIAL_PLATFORMS,
} from "./utils/materialization";

const ACTIVE_DELETION_STATUSES = ["PENDING_REVIEW", "APPROVED", "RUNNING"] as const;

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
 * The whole birth of a dealership: the organization row, its default roles,
 * the owner's membership, the subscription, and the social-materialization
 * stamps.
 *
 * ⚠️ EXTRACTED, NOT COPIED (SCRUM-143). The E2E preview bootstrap
 * (`convex/e2eBootstrap.ts`) has to seed a QA dealership on a fresh preview
 * deployment where no browser has run the onboarding wizard. Writing a second
 * creator for it is precisely the failure `commitmentWriteGuard`'s
 * organization-insert-site audit exists to catch — a creator that merely omits
 * `commitmentAuthorityVersion` writes no guarded field, passes every other
 * check, and mints LEGACY dealerships forever. So the seed calls THIS
 * function, and the backend still contains exactly one
 * `ctx.db.insert("organizations", …)`.
 *
 * Takes the owner's `users` row id rather than resolving the caller, because
 * the seed has no authenticated identity to resolve.
 */
export async function createOrganizationWithDefaultRoles(
  ctx: MutationCtx,
  args: { name: string; ownerUserId: Id<"users"> }
): Promise<Id<"organizations">> {
  // ⚠️ A NEW DEALERSHIP IS BORN CANONICAL (SCRUM-208 / SCRUM-201, owner
  // ruling c15855).
  //
  // `admitAuthorityVersion` reads `undefined | 0` as LEGACY, so an
  // organization created without this field can never reach the canonical
  // restoration lifecycle: every reversal it defers terminalizes as
  // AUTHORITY_WITHHELD_CANONICAL_UNAVAILABLE, permanently. That is not future
  // migration work — it is a brand-new tenant switched for good into the very
  // model the canonical authority exists to replace. The legacy half of that
  // behaviour was proven against a real backend in SCRUM-208 c15854.
  //
  // Server-owned and unconditional. No argument selects it, no update path
  // reaches it, and there is no downgrade: `commitmentAuthorityVersion` is a
  // guarded field, so a second writer outside the choke fails CI, and
  // `commitmentWriteGuard` also counts organization INSERT SITES — because a
  // future creator that merely OMITTED this field would write no guarded
  // field at all, pass the field guard, and silently return every new
  // dealership to LEGACY.
  //
  // ⚠️ WHY THE LITERAL 1 AND NOT `COMMITMENT_AUTHORITY_V1` (SCRUM-208
  // c15929, owner ruling). The structural guard has to decide, from source
  // text alone, that this field is really bound to the canonical version.
  // Twice it tried to do that by trusting the CONSTANT'S NAME, and twice the
  // name was forged — first by a plain redeclaration, then by an inner-scope
  // shadow sitting under a genuine top-level import. Resolving a name to its
  // binding needs a TypeScript Program, not a text scan, so the guard now
  // accepts only a numeric literal. A number cannot be shadowed.
  //
  // The duplication is deliberate and it is NOT unpinned. Two executable
  // contracts tie this literal to the kernel:
  //
  //   1. the guard's suite compares the guard's own canonical number with
  //      the real `COMMITMENT_AUTHORITY_V1`;
  //   2. `organizations.test.ts` drives THIS mutation and asserts the value
  //      it actually stored equals that same kernel constant.
  //
  // So bumping the kernel to V2 does not silently leave new dealerships on
  // 1 — it turns both suites red until this line and the guard are changed
  // on purpose, together.
  //
  // EXISTING organizations are untouched. They stay LEGACY and keep failing
  // closed; activating them is SCRUM-201's cutover and deliberately does not
  // happen here.
  const orgId = await ctx.db.insert("organizations", {
    name: args.name.trim(),
    createdAt: Date.now(),
    commitmentAuthorityVersion: 1,
  });

  // A brand-new org has no social events, so its materialised conversation
  // set is exhaustively correct the moment it exists — the eligible source is
  // empty, and every event from here on is materialised by the trigger as it
  // arrives. Recording that up front is what stops new tenants from sitting
  // on the legacy full-scan path forever waiting for a backfill that has
  // nothing to do.
  //
  // This is the one place COMPLETED may be written without a pagination pass,
  // and it is sound for a reason specific to this moment: an event cannot
  // exist for an organization that did not exist when the event arrived.
  const materializationStamp = {
    orgId,
    generation: SOCIAL_CONVERSATION_GENERATION,
    status: "completed" as const,
    runId: `orgCreate:${Date.now()}`,
    processedCount: 0,
    materializedCount: 0,
    expectedCount: 0,
    startedAt: Date.now(),
    lastProgressAt: Date.now(),
    completedAt: Date.now(),
  };
  for (const platform of SOCIAL_PLATFORMS) {
    await ctx.db.insert("socialMaterializationState", { ...materializationStamp, platform });
  }

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
    userId: args.ownerUserId,
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
}

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
    return await createOrganizationWithDefaultRoles(ctx, {
      name: args.name,
      ownerUserId: user._id,
    });
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
