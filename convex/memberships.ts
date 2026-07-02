import { v, ConvexError } from "convex/values";
import { mutation, query, action, internalMutation, internalQuery, internalAction, MutationCtx } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requireAuth, requireTenantAuth, requireOwner } from "./utils/tenancy";
import { PERMISSIONS, ALL_PERMISSIONS, DEFAULT_ROLE_TEMPLATES, isSystemOwnerRole } from "./utils/permissions";
import { notifyUser, notifyManagers } from "./utils/notifications";

const MEMBERSHIP_OFFBOARDING_RETRY_BASE_MS = 60_000;
const MEMBERSHIP_OFFBOARDING_RETRY_MAX_MS = 60 * 60_000;
const MEMBERSHIP_OFFBOARDING_DRAIN_LIMIT = 25;
const INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const DIRECT_ACCOUNT_INVITATION_TTL_MS = 60 * 60 * 1000;

type MembershipOffboardingStatus = "PENDING" | "RETRYING" | "SUCCEEDED";
type MembershipOffboardingJobResult = {
  jobId: Id<"membershipOffboardingJobs">;
  status: MembershipOffboardingStatus;
  requiresClerkUserDeletion: boolean;
};
type MembershipOffboardingJobSnapshot =
  | (Doc<"membershipOffboardingJobs"> & {
      membershipExists: boolean;
      clerkIdForDeletion: string | null;
      requiresClerkUserDeletionNow: boolean;
    })
  | null;
type InvitationStatus = "PENDING" | "ACCEPTED" | "EXPIRED" | "REVOKED";

async function countOwners(ctx: MutationCtx, orgId: Id<"organizations">): Promise<number> {
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();

  let ownerCount = 0;
  for (const membership of memberships) {
    if (membership.offboardingStatus) continue;
    const role = await ctx.db.get(membership.roleId);
    if (isSystemOwnerRole(role)) ownerCount++;
  }
  return ownerCount;
}

async function requireRealOwner(ctx: MutationCtx, orgId: Id<"organizations">) {
  const auth = await requireOwner(ctx, orgId);
  if (auth.membership.impersonationGrantId) {
    throw new ConvexError("Impersonation sessions cannot change organization ownership.");
  }
  return auth;
}

async function requireOwnerForOwnerRole(ctx: MutationCtx, orgId: Id<"organizations">, roleId: Id<"roles">) {
  const role = await ctx.db.get(roleId);
  if (!role || role.orgId !== orgId || role.isDeleted) {
    throw new ConvexError("The specified role does not belong to this organization.");
  }
  if (isSystemOwnerRole(role)) {
    await requireRealOwner(ctx, orgId);
  }
  return role;
}

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

function generateInvitationToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashInvitationToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function invitationStatus(invite: Doc<"invitations">): InvitationStatus {
  return invite.status ?? "PENDING";
}

async function expireInvitation(ctx: MutationCtx, invite: Doc<"invitations">, now: number) {
  if (invitationStatus(invite) !== "PENDING") return;
  await ctx.db.patch(invite._id, {
    status: "EXPIRED",
    updatedAt: now,
  });
}

async function findReusablePendingInvitation(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  email: string
): Promise<Doc<"invitations"> | null> {
  const now = Date.now();
  const invitations = await ctx.db
    .query("invitations")
    .withIndex("by_org_email", (q) => q.eq("orgId", orgId).eq("email", email))
    .collect();

  for (const invite of invitations) {
    if (invitationStatus(invite) !== "PENDING") continue;
    if (!invite.expiresAt || invite.expiresAt <= now) {
      await expireInvitation(ctx, invite, now);
      continue;
    }
    return invite;
  }

  return null;
}

async function assertInvitationCanBeAccepted(
  ctx: MutationCtx,
  invite: Doc<"invitations">,
  recipientEmail: string
) {
  const now = Date.now();
  if (invitationStatus(invite) !== "PENDING") {
    throw new ConvexError("Invitation is no longer valid.");
  }
  if (!invite.expiresAt || invite.expiresAt <= now) {
    await expireInvitation(ctx, invite, now);
    throw new ConvexError("Invitation has expired. Ask your administrator for a new invite.");
  }
  if (invite.email !== normalizeEmail(recipientEmail)) {
    throw new ConvexError("Invitation is not assigned to this account.");
  }

  const org = await ctx.db.get(invite.orgId);
  if (!org || org.suspended) {
    throw new ConvexError("Invitation organization is no longer available.");
  }

  const role = await ctx.db.get(invite.roleId);
  if (!role || role.orgId !== invite.orgId || role.isDeleted) {
    throw new ConvexError("The invitation role is no longer valid.");
  }
  if (isSystemOwnerRole(role) && !invite.ownerRoleAuthorizedAt) {
    throw new ConvexError("This owner invitation is no longer valid. Create a new owner-authorized invitation.");
  }

  const memberGate = await ctx.runQuery(internal.subscriptions.canAddMember, { orgId: invite.orgId });
  if (!memberGate.allowed) {
    throw new ConvexError(
      `You've reached the ${memberGate.limit}-user limit on your current plan. Upgrade to add more team members.`
    );
  }

  return { org, role };
}

function normalizeOffboardingError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function nextOffboardingRetryDelay(attempts: number): number {
  const exponential = MEMBERSHIP_OFFBOARDING_RETRY_BASE_MS * 2 ** Math.min(Math.max(attempts - 1, 0), 6);
  return Math.min(exponential, MEMBERSHIP_OFFBOARDING_RETRY_MAX_MS);
}

async function createOrReuseMembershipOffboardingJob(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    membershipId: Id<"memberships">;
    requestedBy: Id<"users">;
  }
): Promise<MembershipOffboardingJobResult> {
  const membership = await ctx.db.get(args.membershipId);
  if (!membership || membership.orgId !== args.orgId) {
    throw new ConvexError("Membership not found in this organization.");
  }

  const user = await ctx.db.get(membership.userId);
  if (!user) {
    throw new ConvexError("Membership user record is missing.");
  }

  const existingJob = await ctx.db
    .query("membershipOffboardingJobs")
    .withIndex("by_membership", (q) => q.eq("membershipId", membership._id))
    .first();

  if (existingJob && existingJob.status !== "SUCCEEDED") {
    if (!membership.offboardingStatus) {
      await ctx.db.patch(membership._id, {
        offboardingStatus: "PENDING_EXTERNAL_REMOVAL",
        offboardingRequestedAt: existingJob.createdAt,
        offboardingRequestedBy: existingJob.requestedBy,
        offboardingAttempts: existingJob.attempts,
        offboardingNextRetryAt: existingJob.nextAttemptAt,
      });
    }
    await ctx.scheduler.runAfter(0, internal.memberships.processMembershipOffboardingJob, {
      jobId: existingJob._id,
    });
    return {
      jobId: existingJob._id,
      status: existingJob.status,
      requiresClerkUserDeletion: existingJob.requiresClerkUserDeletion,
    };
  }

  const now = Date.now();
  const otherMemberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  const requiresClerkUserDeletion = otherMemberships.every((m) => m._id === membership._id);

  await ctx.db.patch(membership._id, {
    offboardingStatus: "PENDING_EXTERNAL_REMOVAL",
    offboardingRequestedAt: now,
    offboardingRequestedBy: args.requestedBy,
    offboardingAttempts: 0,
    offboardingNextRetryAt: now,
  });

  const jobId = await ctx.db.insert("membershipOffboardingJobs", {
    membershipId: membership._id,
    orgId: args.orgId,
    userId: user._id,
    clerkId: user.clerkId,
    requestedBy: args.requestedBy,
    requiresClerkUserDeletion,
    status: "PENDING",
    attempts: 0,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  });

  await ctx.scheduler.runAfter(0, internal.memberships.processMembershipOffboardingJob, { jobId });

  return { jobId, status: "PENDING", requiresClerkUserDeletion };
}

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

    const activePage = pageResult.page.filter((m) => !m.offboardingStatus);

    const page = await Promise.all(
      activePage.map(async (m) => {
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
          lastSeenAt: m.lastSeenAt,
          offboardingStatus: m.offboardingStatus,
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
    const permissions: string[] = isSystemOwnerRole(role)
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
    const { user: callingUser } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_USERS]);

    // Verify the role belongs to this org
    const role = await requireOwnerForOwnerRole(ctx, args.orgId, args.roleId);

    const memberGate = await ctx.runQuery(internal.subscriptions.canAddMember, { orgId: args.orgId });
    if (!memberGate.allowed) {
      throw new ConvexError(
        `You've reached the ${memberGate.limit}-user limit on your current plan. Upgrade to add more team members.`
      );
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
      const existingInvite = await findReusablePendingInvitation(ctx, args.orgId, email);

      if (existingInvite) {
        throw new ConvexError("An invitation is already pending for this email.");
      }

      const now = Date.now();
      const inviteToken = generateInvitationToken();
      await ctx.db.insert("invitations", {
        orgId: args.orgId,
        email,
        roleId: args.roleId,
        createdBy: callingUser._id,
        tokenHash: await hashInvitationToken(inviteToken),
        status: "PENDING",
        source: "EMAIL_INVITE",
        expiresAt: now + INVITATION_TTL_MS,
        updatedAt: now,
        ...(isSystemOwnerRole(role) ? { ownerRoleAuthorizedAt: now } : {}),
        createdAt: now,
      });

      // Schedule the invite email
      await ctx.scheduler.runAfter(0, internal.email.sendTeamInvite, {
        toEmail: email,
        orgName: org.name,
        inviteToken,
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

    await notifyUser(ctx, args.orgId, targetUser._id, "membership.added", { orgName: org.name });
    await notifyManagers(ctx, args.orgId, "membership.added", { orgName: org.name }, { excludeUserId: targetUser._id });

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
    const { user: callingUser, membership: callingMembership } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.MANAGE_USERS,
    ]);

    const membership = await ctx.db.get(args.membershipId);
    if (!membership || membership.orgId !== args.orgId) {
      throw new ConvexError("Membership not found in this organization.");
    }
    if (membership.offboardingStatus) {
      throw new ConvexError("Membership removal is already in progress.");
    }

    // Prevent changing the original OWNER's role
    const currentRole = await ctx.db.get(membership.roleId);
    if (!currentRole || currentRole.orgId !== args.orgId || currentRole.isDeleted) {
      throw new ConvexError("Membership role not found or corrupted.");
    }

    // Verify the new role belongs to this org
    const newRole = await ctx.db.get(args.newRoleId);
    if (!newRole || newRole.orgId !== args.orgId || newRole.isDeleted) {
      throw new ConvexError("The specified role does not belong to this organization.");
    }

    const currentRoleIsOwner = isSystemOwnerRole(currentRole);
    const newRoleIsOwner = isSystemOwnerRole(newRole);

    // Only an OWNER can assign, demote, or otherwise modify an OWNER membership.
    if (currentRoleIsOwner || newRoleIsOwner) {
      if (callingMembership.impersonationGrantId) {
        throw new ConvexError("Impersonation sessions cannot change organization ownership.");
      }
      await requireRealOwner(ctx, args.orgId);
    }

    if (currentRoleIsOwner && !newRoleIsOwner) {
      if (await countOwners(ctx, args.orgId) <= 1) {
        throw new ConvexError("Cannot demote the last owner. Transfer ownership to another member first.");
      }
      if (membership.userId === callingUser._id) {
        throw new ConvexError("You cannot change your own OWNER role. Transfer ownership first.");
      }
    }

    await ctx.db.patch(args.membershipId, {
      roleId: args.newRoleId,
    });

    await notifyUser(ctx, args.orgId, membership.userId, "membership.role_changed", { roleName: newRole.name });
  },
});

/**
 * Atomically transfers the caller's OWNER role to another membership and
 * demotes the caller to a non-owner role. Use this instead of manually
 * changing OWNER memberships.
 */
export const transferOwnership = mutation({
  args: {
    orgId: v.id("organizations"),
    targetMembershipId: v.id("memberships"),
    currentOwnerNewRoleId: v.id("roles"),
  },
  handler: async (ctx, args) => {
    const { user, membership: currentOwnerMembership, role: ownerRole } = await requireRealOwner(ctx, args.orgId);

    const targetMembership = await ctx.db.get(args.targetMembershipId);
    if (!targetMembership || targetMembership.orgId !== args.orgId) {
      throw new ConvexError("Target membership not found in this organization.");
    }
    if (targetMembership.offboardingStatus) {
      throw new ConvexError("Membership removal is already in progress.");
    }
    if (targetMembership.userId === user._id) {
      throw new ConvexError("Choose another member to transfer ownership to.");
    }

    const currentOwnerNewRole = await ctx.db.get(args.currentOwnerNewRoleId);
    if (!currentOwnerNewRole || currentOwnerNewRole.orgId !== args.orgId || currentOwnerNewRole.isDeleted) {
      throw new ConvexError("The replacement role does not belong to this organization.");
    }
    if (isSystemOwnerRole(currentOwnerNewRole)) {
      throw new ConvexError("The replacement role must be a non-owner role.");
    }

    const targetCurrentRole = await ctx.db.get(targetMembership.roleId);
    if (!targetCurrentRole || targetCurrentRole.orgId !== args.orgId || targetCurrentRole.isDeleted) {
      throw new ConvexError("Target membership role not found or corrupted.");
    }
    if (isSystemOwnerRole(targetCurrentRole)) {
      throw new ConvexError("The target member is already an owner.");
    }

    await ctx.db.patch(args.targetMembershipId, { roleId: ownerRole._id });
    await ctx.db.patch(currentOwnerMembership._id, { roleId: args.currentOwnerNewRoleId });

    await notifyUser(ctx, args.orgId, targetMembership.userId, "membership.role_changed", {
      roleName: ownerRole.name,
    });
    await notifyUser(ctx, args.orgId, user._id, "membership.role_changed", {
      roleName: currentOwnerNewRole.name,
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
    const { user: callingUser } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_USERS]);

    const membership = await ctx.db.get(args.membershipId);
    if (!membership || membership.orgId !== args.orgId) {
      throw new ConvexError("Membership not found in this organization.");
    }
    if (membership.offboardingStatus) {
      const existingJob = await ctx.db
        .query("membershipOffboardingJobs")
        .withIndex("by_membership", (q) => q.eq("membershipId", membership._id))
        .first();
      if (existingJob && existingJob.status !== "SUCCEEDED") {
        await ctx.scheduler.runAfter(0, internal.memberships.processMembershipOffboardingJob, {
          jobId: existingJob._id,
        });
        return {
          jobId: existingJob._id,
          status: existingJob.status,
          requiresClerkUserDeletion: existingJob.requiresClerkUserDeletion,
        };
      }
      throw new ConvexError("Membership removal is already in progress.");
    }

    // Prevent removing the last OWNER
    const memberRole = await ctx.db.get(membership.roleId);
    if (isSystemOwnerRole(memberRole)) {
      await requireRealOwner(ctx, args.orgId);
      if (await countOwners(ctx, args.orgId) <= 1) {
        throw new ConvexError(
          "Cannot remove the last owner. Transfer ownership to another member first."
        );
      }
    }

    return await createOrReuseMembershipOffboardingJob(ctx, {
      orgId: args.orgId,
      membershipId: args.membershipId,
      requestedBy: callingUser._id,
    });
  },
});

export const remove = action({
  args: {
    orgId: v.id("organizations"),
    membershipId: v.id("memberships"),
  },
  handler: async (ctx, args) => {
    const result: MembershipOffboardingJobResult = await ctx.runMutation(
      internal.memberships.removeMembershipInternal,
      args
    );
    return result;
  }
});

export const getMembershipOffboardingJob = internalQuery({
  args: {
    jobId: v.id("membershipOffboardingJobs"),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;

    const membership = await ctx.db.get(job.membershipId);
    const user = await ctx.db.get(job.userId);
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", job.userId))
      .collect();
    const otherMembershipCount = memberships.filter((m) => m._id !== job.membershipId).length;

    return {
      ...job,
      membershipExists: Boolean(membership),
      clerkIdForDeletion: user?.clerkId ?? job.clerkId ?? null,
      requiresClerkUserDeletionNow: Boolean(user && otherMembershipCount === 0),
    };
  },
});

export const listDueMembershipOffboardingJobs = internalQuery({
  args: {
    now: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit, MEMBERSHIP_OFFBOARDING_DRAIN_LIMIT));
    const pending = await ctx.db
      .query("membershipOffboardingJobs")
      .withIndex("by_status_and_nextAttemptAt", (q) =>
        q.eq("status", "PENDING").lte("nextAttemptAt", args.now)
      )
      .take(limit);
    const retrying = await ctx.db
      .query("membershipOffboardingJobs")
      .withIndex("by_status_and_nextAttemptAt", (q) =>
        q.eq("status", "RETRYING").lte("nextAttemptAt", args.now)
      )
      .take(limit);

    return [...pending, ...retrying].slice(0, limit).map((job) => ({ _id: job._id }));
  },
});

export const recordMembershipOffboardingRetry = internalMutation({
  args: {
    jobId: v.id("membershipOffboardingJobs"),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status === "SUCCEEDED") return null;

    const now = Date.now();
    const attempts = job.attempts + 1;
    const delayMs = nextOffboardingRetryDelay(attempts);
    const nextAttemptAt = now + delayMs;
    const cleanError = args.error.slice(0, 500);

    await ctx.db.patch(job._id, {
      status: "RETRYING",
      attempts,
      lastAttemptAt: now,
      lastError: cleanError,
      nextAttemptAt,
      updatedAt: now,
    });

    const membership = await ctx.db.get(job.membershipId);
    if (membership) {
      await ctx.db.patch(membership._id, {
        offboardingStatus: "EXTERNAL_REMOVAL_RETRYING",
        offboardingAttempts: attempts,
        offboardingLastAttemptAt: now,
        offboardingLastError: cleanError,
        offboardingNextRetryAt: nextAttemptAt,
      });
    }

    await ctx.scheduler.runAfter(delayMs, internal.memberships.processMembershipOffboardingJob, {
      jobId: job._id,
    });

    return { attempts, nextAttemptAt };
  },
});

export const finalizeMembershipOffboardingJob = internalMutation({
  args: {
    jobId: v.id("membershipOffboardingJobs"),
    clerkUserDeleted: v.boolean(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status === "SUCCEEDED") return null;

    const membership = await ctx.db.get(job.membershipId);
    if (membership) {
      await ctx.db.delete(membership._id);
    }

    const remainingMemberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", job.userId))
      .collect();
    if (remainingMemberships.length === 0 && args.clerkUserDeleted) {
      const user = await ctx.db.get(job.userId);
      if (user) {
        await ctx.db.delete(user._id);
      }
    }

    const now = Date.now();
    await ctx.db.patch(job._id, {
      status: "SUCCEEDED",
      requiresClerkUserDeletion: args.clerkUserDeleted,
      nextAttemptAt: now,
      updatedAt: now,
      succeededAt: now,
    });

    return { status: "SUCCEEDED" };
  },
});

export const processMembershipOffboardingJob = internalAction({
  args: {
    jobId: v.id("membershipOffboardingJobs"),
  },
  handler: async (ctx, args) => {
    const job: MembershipOffboardingJobSnapshot = await ctx.runQuery(
      internal.memberships.getMembershipOffboardingJob,
      { jobId: args.jobId }
    );
    if (!job || job.status === "SUCCEEDED") return null;

    if (!job.membershipExists && !job.requiresClerkUserDeletionNow) {
      await ctx.runMutation(internal.memberships.finalizeMembershipOffboardingJob, {
        jobId: args.jobId,
        clerkUserDeleted: false,
      });
      return { status: "SUCCEEDED" };
    }

    let clerkUserDeleted = false;
    if (job.requiresClerkUserDeletionNow) {
      const clerkSecret = process.env.CLERK_SECRET_KEY;
      if (!clerkSecret) {
        console.error("Membership offboarding cannot delete Clerk user: CLERK_SECRET_KEY is not configured.");
        await ctx.runMutation(internal.memberships.recordMembershipOffboardingRetry, {
          jobId: args.jobId,
          error: "Authentication provider cleanup is not configured.",
        });
        return { status: "RETRYING" };
      }

      if (!job.clerkIdForDeletion) {
        console.error("Membership offboarding cannot delete Clerk user: no Clerk id is available.", {
          jobId: args.jobId,
          userId: job.userId,
        });
        await ctx.runMutation(internal.memberships.recordMembershipOffboardingRetry, {
          jobId: args.jobId,
          error: "Authentication provider identity is missing.",
        });
        return { status: "RETRYING" };
      }

      try {
        const res = await fetch(`https://api.clerk.com/v1/users/${job.clerkIdForDeletion}`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${clerkSecret}`,
          },
        });

        if (!res.ok && res.status !== 404) {
          const body = await res.text().catch(() => "");
          console.error("Membership offboarding Clerk delete failed.", {
            jobId: args.jobId,
            status: res.status,
            body: body.slice(0, 500),
          });
          await ctx.runMutation(internal.memberships.recordMembershipOffboardingRetry, {
            jobId: args.jobId,
            error: "Authentication provider cleanup failed.",
          });
          return { status: "RETRYING" };
        }

        clerkUserDeleted = true;
      } catch (error) {
        console.error("Membership offboarding Clerk delete request failed.", {
          jobId: args.jobId,
          error: normalizeOffboardingError(error),
        });
        await ctx.runMutation(internal.memberships.recordMembershipOffboardingRetry, {
          jobId: args.jobId,
          error: "Authentication provider cleanup failed.",
        });
        return { status: "RETRYING" };
      }
    }

    await ctx.runMutation(internal.memberships.finalizeMembershipOffboardingJob, {
      jobId: args.jobId,
      clerkUserDeleted,
    });

    return { status: "SUCCEEDED" };
  },
});

export const drainDueMembershipOffboardingJobs = internalAction({
  args: {},
  handler: async (ctx) => {
    const dueJobs: Array<{ _id: Id<"membershipOffboardingJobs"> }> = await ctx.runQuery(
      internal.memberships.listDueMembershipOffboardingJobs,
      { now: Date.now(), limit: MEMBERSHIP_OFFBOARDING_DRAIN_LIMIT }
    );

    for (const job of dueJobs) {
      await ctx.runAction(internal.memberships.processMembershipOffboardingJob, { jobId: job._id });
    }

    return { processed: dueJobs.length };
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
    if (isSystemOwnerRole(role)) {
      if (await countOwners(ctx, args.orgId) <= 1) {
        throw new ConvexError(
          "You are the last owner. Transfer ownership before leaving."
        );
      }
    }

    await notifyManagers(
      ctx,
      args.orgId,
      "membership.left",
      { userName: user.name ?? user.email },
      { excludeUserId: user._id }
    );

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
    const { user: callingUser } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_USERS]);

    const role = await requireOwnerForOwnerRole(ctx, args.orgId, args.roleId);

    const email = normalizeEmail(args.email);

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

    const existingInvite = await findReusablePendingInvitation(ctx, args.orgId, email);

    if (existingInvite) {
      throw new ConvexError("An invitation is already pending for this email. Delete it first if you want to recreate.");
    }

    const now = Date.now();
    return await ctx.db.insert("invitations", {
      orgId: args.orgId,
      email,
      roleId: args.roleId,
      createdBy: callingUser._id,
      status: "PENDING",
      source: "DIRECT_ACCOUNT",
      expiresAt: now + DIRECT_ACCOUNT_INVITATION_TTL_MS,
      updatedAt: now,
      ...(isSystemOwnerRole(role) ? { ownerRoleAuthorizedAt: now } : {}),
      createdAt: now,
    });
  }
});

export const rollbackDirectAccount = internalMutation({
  args: { inviteId: v.id("invitations") },
  handler: async (ctx, args) => {
    const invite = await ctx.db.get(args.inviteId);
    if (!invite || invitationStatus(invite) !== "PENDING") return;
    await ctx.db.patch(args.inviteId, {
      status: "REVOKED",
      updatedAt: Date.now(),
    });
  }
});

/** How long the emailed one-time account-setup link stays valid. */
const ACCOUNT_SETUP_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Mints a one-time Clerk sign-in token for the given user. The token is
 * emailed as a setup link instead of a password: it can be consumed exactly
 * once, expires, and the user chooses their own password after signing in —
 * a reusable credential never travels over email.
 */
async function createClerkSignInToken(
  clerkSecret: string,
  clerkUserId: string
): Promise<string> {
  const response = await fetch("https://api.clerk.com/v1/sign_in_tokens", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${clerkSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      user_id: clerkUserId,
      expires_in_seconds: ACCOUNT_SETUP_TOKEN_TTL_SECONDS,
    }),
  });
  if (!response.ok) {
    throw new ConvexError("Failed to create the account setup link.");
  }
  const tokenData = await response.json();
  const token = typeof tokenData?.token === "string" ? tokenData.token : null;
  if (!token) {
    throw new ConvexError("Failed to create the account setup link.");
  }
  return token;
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

      let setupToken: string | null = null;

      if (!clerkId) {
        // 3a. No existing Clerk account — create one WITHOUT a password. The
        // user receives a one-time setup link and picks their own password;
        // no reusable credential is ever generated or emailed.
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
              username,
              first_name: args.firstName.trim(),
              last_name: args.lastName.trim() || undefined,
              skip_password_requirement: true,
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

        // Mint the one-time setup token before finalizing. If this fails,
        // delete the passwordless Clerk user we just created so the whole
        // operation rolls back cleanly and can simply be retried.
        try {
          setupToken = await createClerkSignInToken(clerkSecret, clerkId!);
        } catch (tokenError) {
          await fetch(`https://api.clerk.com/v1/users/${clerkId}`, {
            method: "DELETE",
            headers: { "Authorization": `Bearer ${clerkSecret}` },
          }).catch(() => undefined);
          throw tokenError;
        }
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

      // 3c. Email the one-time setup link — only for accounts we just created in Clerk
      if (isNewClerkUser && setupToken) {
        const org = await ctx.runQuery(internal.organizations.getInternal, { orgId: args.orgId });
        await ctx.scheduler.runAfter(0, internal.email.sendAccountSetupLink, {
          toEmail: args.email,
          firstName: args.firstName.trim(),
          orgName: org?.name ?? "AutoFlow",
          setupToken,
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
 * Internal guard: verifies the caller holds MANAGE_USERS in the given org.
 * Used by the checkEmailExists action, which cannot call requireTenantAuth
 * directly (actions have no db handle). Throws on failure.
 */
export const assertCanManageUsers = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_USERS]);
    return true;
  },
});

/**
 * Check whether an email address already has a Clerk account.
 * Returns exists flag and the user's first/last name if found.
 * Used by the team invite flow to decide whether to show name-entry fields.
 *
 * Gated by MANAGE_USERS in the target org: this leaks whether a person has an
 * account plus their name (PII / account enumeration), so it must not be
 * callable by any authenticated user — only by someone allowed to manage that
 * org's members.
 */
export const checkEmailExists = action({
  args: { orgId: v.id("organizations"), email: v.string() },
  handler: async (ctx, args): Promise<{ exists: boolean; firstName?: string; lastName?: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Unauthenticated");
    // Authorize against the target org (throws if the caller lacks MANAGE_USERS).
    await ctx.runQuery(internal.memberships.assertCanManageUsers, { orgId: args.orgId });

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

export const acceptInvitation = mutation({
  args: {
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireAuth(ctx);
    const token = args.token.trim();
    if (token.length < 32) {
      throw new ConvexError("Invitation is no longer valid.");
    }

    const tokenHash = await hashInvitationToken(token);
    const invite = await ctx.db
      .query("invitations")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
      .unique();

    if (!invite || invite.source !== "EMAIL_INVITE") {
      throw new ConvexError("Invitation is no longer valid.");
    }
    if (invitationStatus(invite) === "PENDING" && (!invite.expiresAt || invite.expiresAt <= Date.now())) {
      await expireInvitation(ctx, invite, Date.now());
      return { status: "expired", orgId: invite.orgId };
    }

    await assertInvitationCanBeAccepted(ctx, invite, user.email);

    const existingMembership = await ctx.db
      .query("memberships")
      .withIndex("by_org_user", (q) => q.eq("orgId", invite.orgId).eq("userId", user._id))
      .unique();

    if (existingMembership?.offboardingStatus) {
      throw new ConvexError("This account is still being removed from the organization.");
    }

    if (!existingMembership) {
      await ctx.db.insert("memberships", {
        orgId: invite.orgId,
        userId: user._id,
        roleId: invite.roleId,
      });
    }

    const now = Date.now();
    await ctx.db.patch(invite._id, {
      status: "ACCEPTED",
      acceptedAt: now,
      acceptedBy: user._id,
      updatedAt: now,
    });

    return { status: "accepted", orgId: invite.orgId };
  },
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

// Server-side floor under the client's own throttle (PresenceTracker uses a
// 5-minute localStorage debounce) — keeps writes bounded even if a user has
// several tabs/devices open at once, each tracking its own localStorage.
const LAST_SEEN_THROTTLE_MS = 4 * 60 * 1000;

/**
 * Records that the calling user is actively using the org workspace right
 * now, for the "last seen" indicator on Team > Members. Deliberately not a
 * live heartbeat: called only on page mount / tab-focus-regain (throttled
 * client-side), and a no-op here if the membership was already touched
 * recently, so this stays a handful of tiny writes per user per hour.
 */
export const touchLastSeen = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { membership } = await requireTenantAuth(ctx, args.orgId);

    const now = Date.now();
    if (membership.lastSeenAt && now - membership.lastSeenAt < LAST_SEEN_THROTTLE_MS) {
      return;
    }

    await ctx.db.patch(membership._id, { lastSeenAt: now });
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
    if (membership.offboardingStatus) {
      throw new ConvexError("Membership removal is already in progress.");
    }

    if (args.commissionRate < 0 || args.commissionRate > 100) {
      throw new ConvexError("Commission rate must be between 0 and 100.");
    }

    await ctx.db.patch(args.membershipId, { commissionRate: args.commissionRate });

    await notifyUser(ctx, args.orgId, membership.userId, "membership.commission_rate_changed", {
      rate: args.commissionRate,
    });
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
    const invite = await ctx.db.get(args.inviteId);
    if (!invite || invite.orgId !== args.orgId || invite.roleId !== args.roleId) {
      throw new ConvexError("Invitation not found or no longer valid.");
    }
    if (invite.source !== "DIRECT_ACCOUNT") {
      throw new ConvexError("Invitation not found or no longer valid.");
    }
    await assertInvitationCanBeAccepted(ctx, invite, args.email);

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

    const now = Date.now();
    await ctx.db.patch(args.inviteId, {
      status: "ACCEPTED",
      acceptedAt: now,
      acceptedBy: userId,
      updatedAt: now,
    });
  }
});
