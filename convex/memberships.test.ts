import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS } from "./utils/permissions";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const ADMIN_PERMISSIONS = ["manage:users", "view:users", "manage:roles"];

async function hashInviteToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function setupOrg(t: any, clerkId: string, ownerRoleName = "OWNER") {
  const orgId = await t.run((ctx: any) =>
    ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx: any) =>
    ctx.db.insert("users", { clerkId, email: `${clerkId}@test.com`, name: "Admin User" })
  );
  const roleId = await t.run((ctx: any) =>
    ctx.db.insert("roles", {
      orgId,
      name: ownerRoleName,
      permissions: ALL_PERMISSIONS,
      isSystemOwnerRole: ownerRoleName === "OWNER",
    })
  );
  const membershipId = await t.run((ctx: any) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  return { orgId, userId, roleId, membershipId };
}

describe("memberships.add", () => {
  test("adds an existing user to an org", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, roleId } = await setupOrg(t, "user_m1");
    const asAdmin = t.withIdentity({ subject: "user_m1" });

    // Seed a second user (existing in Convex but not yet a member)
    await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "user_m2", email: "newmember@test.com", name: "New Member" })
    );

    const result = await asAdmin.mutation(api.memberships.add, {
      orgId,
      userEmail: "newmember@test.com",
      roleId,
    });

    expect(result).toEqual({ status: "added" });

    await t.run(async (ctx: any) => {
      const memberships = await ctx.db
        .query("memberships")
        .withIndex("by_org", (q: any) => q.eq("orgId", orgId))
        .collect();
      expect(memberships).toHaveLength(2);
    });
  });

  test("rejects adding an already-member user", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, roleId } = await setupOrg(t, "user_m3");
    const asAdmin = t.withIdentity({ subject: "user_m3" });

    // user_m3 is already a member — try adding by email
    await expect(
      asAdmin.mutation(api.memberships.add, {
        orgId,
        userEmail: "user_m3@test.com",
        roleId,
      })
    ).rejects.toThrow(/already a member/i);
  });

  test("creates an invitation when user does not exist yet", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, roleId } = await setupOrg(t, "user_m5");
    const asAdmin = t.withIdentity({ subject: "user_m5" });

    const result = await asAdmin.mutation(api.memberships.add, {
      orgId,
      userEmail: "brand-new@example.com",
      roleId,
    });

    expect(result).toEqual({ status: "invited" });

    await t.run(async (ctx: any) => {
      const invite = await ctx.db
        .query("invitations")
        .withIndex("by_email", (q: any) => q.eq("email", "brand-new@example.com"))
        .first();
      expect(invite).toBeDefined();
      expect(invite?.orgId).toBe(orgId);
      expect(invite?.status).toBe("PENDING");
      expect(invite?.source).toBe("EMAIL_INVITE");
      expect(invite?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(invite?.expiresAt).toBeGreaterThan(Date.now());
    });
  });
});

describe("memberships.acceptInvitation", () => {
  test("Clerk user sync no longer auto-consumes a pending invite by email", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId: inviterId } = await setupOrg(t, "user_invite_owner");
    const roleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
    ) as Id<"roles">;
    const token = "auto-consume-token";
    await t.run(async (ctx: any) =>
      ctx.db.insert("invitations", {
        orgId,
        email: "invited@example.com",
        roleId,
        createdBy: inviterId,
        tokenHash: await hashInviteToken(token),
        status: "PENDING",
        source: "EMAIL_INVITE",
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    await t.run((ctx: any) =>
      ctx.runMutation(internal.users.updateOrCreateUser, {
        clerkId: "user_invited_auto",
        email: "invited@example.com",
        name: "Invited User",
      })
    );

    await t.run(async (ctx: any) => {
      const invitedUser = await ctx.db
        .query("users")
        .withIndex("by_clerkId", (q: any) => q.eq("clerkId", "user_invited_auto"))
        .unique();
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q: any) => q.eq("orgId", orgId).eq("userId", invitedUser?._id))
        .unique();
      const invite = await ctx.db
        .query("invitations")
        .withIndex("by_org_email", (q: any) => q.eq("orgId", orgId).eq("email", "invited@example.com"))
        .unique();

      expect(invitedUser).toBeTruthy();
      expect(membership).toBeNull();
      expect(invite?.status).toBe("PENDING");
    });
  });

  test("accepts a valid token for the matching authenticated email", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId: inviterId } = await setupOrg(t, "user_accept_owner");
    const roleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
    ) as Id<"roles">;
    const inviteeId = await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "user_accept_invitee", email: "accept@example.com" })
    ) as Id<"users">;
    const token = "valid-invite-token-1234567890abcdef";
    const inviteId = await t.run(async (ctx: any) =>
      ctx.db.insert("invitations", {
        orgId,
        email: "accept@example.com",
        roleId,
        createdBy: inviterId,
        tokenHash: await hashInviteToken(token),
        status: "PENDING",
        source: "EMAIL_INVITE",
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    ) as Id<"invitations">;

    const asInvitee = t.withIdentity({ subject: "user_accept_invitee" });
    const result = await asInvitee.mutation(api.memberships.acceptInvitation, { token });
    expect(result).toEqual({ status: "accepted", orgId });

    await t.run(async (ctx: any) => {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q: any) => q.eq("orgId", orgId).eq("userId", inviteeId))
        .unique();
      const invite = await ctx.db.get(inviteId);
      expect(membership?.roleId).toBe(roleId);
      expect(invite?.status).toBe("ACCEPTED");
      expect(invite?.acceptedBy).toBe(inviteeId);
      expect(invite?.acceptedAt).toBeTypeOf("number");
    });
  });

  test("rejects and expires stale tokens without creating membership", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId: inviterId } = await setupOrg(t, "user_expired_owner");
    const roleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
    ) as Id<"roles">;
    const inviteeId = await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "user_expired_invitee", email: "expired@example.com" })
    ) as Id<"users">;
    const token = "expired-invite-token-1234567890abcdef";
    const inviteId = await t.run(async (ctx: any) =>
      ctx.db.insert("invitations", {
        orgId,
        email: "expired@example.com",
        roleId,
        createdBy: inviterId,
        tokenHash: await hashInviteToken(token),
        status: "PENDING",
        source: "EMAIL_INVITE",
        expiresAt: Date.now() - 1,
        createdAt: Date.now() - 120_000,
        updatedAt: Date.now() - 120_000,
      })
    ) as Id<"invitations">;

    const asInvitee = t.withIdentity({ subject: "user_expired_invitee" });
    const result = await asInvitee.mutation(api.memberships.acceptInvitation, { token });
    expect(result).toEqual({ status: "expired", orgId });

    await t.run(async (ctx: any) => {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q: any) => q.eq("orgId", orgId).eq("userId", inviteeId))
        .unique();
      const invite = await ctx.db.get(inviteId);
      expect(membership).toBeNull();
      expect(invite?.status).toBe("EXPIRED");
    });
  });

  test("revalidates plan capacity before accepting an invite", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId: inviterId } = await setupOrg(t, "user_capacity_owner");
    const roleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
    ) as Id<"roles">;
    const secondUserId = await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "user_capacity_second", email: "capacity-second@example.com" })
    ) as Id<"users">;
    await t.run((ctx: any) => ctx.db.insert("memberships", { orgId, userId: secondUserId, roleId }));

    await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "user_capacity_invitee", email: "capacity-invitee@example.com" })
    );
    const token = "capacity-invite-token-1234567890abcdef";
    await t.run(async (ctx: any) =>
      ctx.db.insert("invitations", {
        orgId,
        email: "capacity-invitee@example.com",
        roleId,
        createdBy: inviterId,
        tokenHash: await hashInviteToken(token),
        status: "PENDING",
        source: "EMAIL_INVITE",
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    const asInvitee = t.withIdentity({ subject: "user_capacity_invitee" });
    await expect(
      asInvitee.mutation(api.memberships.acceptInvitation, { token })
    ).rejects.toThrow(/user limit/i);
  });

  test("direct account finalization marks the staging invite accepted", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId: inviterId } = await setupOrg(t, "user_direct_owner");
    const roleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
    ) as Id<"roles">;
    const inviteId = await t.run((ctx: any) =>
      ctx.db.insert("invitations", {
        orgId,
        email: "direct@example.com",
        roleId,
        createdBy: inviterId,
        status: "PENDING",
        source: "DIRECT_ACCOUNT",
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    ) as Id<"invitations">;

    await t.mutation(internal.memberships.finalizeDirectAccount, {
      clerkId: "user_direct_created",
      email: "direct@example.com",
      name: "Direct Created",
      orgId,
      roleId,
      inviteId,
    });

    await t.run(async (ctx: any) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerkId", (q: any) => q.eq("clerkId", "user_direct_created"))
        .unique();
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q: any) => q.eq("orgId", orgId).eq("userId", user?._id))
        .unique();
      const invite = await ctx.db.get(inviteId);

      expect(user).toBeTruthy();
      expect(membership?.roleId).toBe(roleId);
      expect(invite?.status).toBe("ACCEPTED");
      expect(invite?.acceptedBy).toBe(user?._id);
      expect(invite?.acceptedAt).toBeTypeOf("number");
    });
  });
});

describe("memberships.leave", () => {
  test("removes the user's own membership", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await setupOrg(t, "user_m6");

    // Add a second member who will leave
    const roleId2 = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
    );
    const userId2 = await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "user_m7", email: "leaver@test.com", name: "Leaver" })
    );
    await t.run((ctx: any) => ctx.db.insert("memberships", { orgId, userId: userId2, roleId: roleId2 }));

    const asLeaver = t.withIdentity({ subject: "user_m7" });
    await asLeaver.mutation(api.memberships.leave, { orgId });

    await t.run(async (ctx: any) => {
      const remaining = await ctx.db
        .query("memberships")
        .withIndex("by_org", (q: any) => q.eq("orgId", orgId))
        .collect();
      // Only the original owner should remain
      expect(remaining).toHaveLength(1);
    });
  });

  test("prevents the last OWNER from leaving", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    await setupOrg(t, "user_m8", "OWNER");
    const asOwner = t.withIdentity({ subject: "user_m8" });

    const orgId = await t.run((ctx: any) =>
      ctx.db
        .query("organizations")
        .filter((q: any) => q.eq(q.field("name"), "Test Dealer"))
        .first()
        .then((o: any) => o._id)
    ) as Id<"organizations">;

    await expect(
      asOwner.mutation(api.memberships.leave, { orgId })
    ).rejects.toThrow(/last owner/i);
  });
});

describe("memberships.remove", () => {
  test("queues offboarding and immediately revokes tenant auth without deleting local identity", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await setupOrg(t, "user_remove_owner");
    const memberRoleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
    ) as Id<"roles">;
    const memberUserId = await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "user_remove_target", email: "remove-target@test.com" })
    ) as Id<"users">;
    const memberMembershipId = await t.run((ctx: any) =>
      ctx.db.insert("memberships", { orgId, userId: memberUserId, roleId: memberRoleId })
    ) as Id<"memberships">;

    const asOwner = t.withIdentity({ subject: "user_remove_owner" });
    const result = await asOwner.action(api.memberships.remove, {
      orgId,
      membershipId: memberMembershipId,
    });

    expect(result.status).toBe("PENDING");
    expect(result.requiresClerkUserDeletion).toBe(true);

    await t.run(async (ctx: any) => {
      const membership = await ctx.db.get(memberMembershipId);
      const user = await ctx.db.get(memberUserId);
      const job = await ctx.db
        .query("membershipOffboardingJobs")
        .withIndex("by_membership", (q: any) => q.eq("membershipId", memberMembershipId))
        .first();

      expect(membership?.offboardingStatus).toBe("PENDING_EXTERNAL_REMOVAL");
      expect(user).toBeTruthy();
      expect(job?.status).toBe("PENDING");
    });

    const asRemovedMember = t.withIdentity({ subject: "user_remove_target" });
    await expect(
      asRemovedMember.query(api.memberships.getMyMembership, { orgId })
    ).rejects.toThrow(/no longer active/i);
  });

  test("records a retry instead of deleting local rows when Clerk configuration is missing", async () => {
    const originalSecret = process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_SECRET_KEY;

    try {
      const t = convexTest(schema, import.meta.glob("./**/*.*s"));
      const { orgId } = await setupOrg(t, "user_retry_owner");
      const memberRoleId = await t.run((ctx: any) =>
        ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
      ) as Id<"roles">;
      const memberUserId = await t.run((ctx: any) =>
        ctx.db.insert("users", { clerkId: "user_retry_target", email: "retry-target@test.com" })
      ) as Id<"users">;
      const memberMembershipId = await t.run((ctx: any) =>
        ctx.db.insert("memberships", { orgId, userId: memberUserId, roleId: memberRoleId })
      ) as Id<"memberships">;

      const asOwner = t.withIdentity({ subject: "user_retry_owner" });
      const result = await asOwner.action(api.memberships.remove, {
        orgId,
        membershipId: memberMembershipId,
      });

      await t.action(internal.memberships.processMembershipOffboardingJob, {
        jobId: result.jobId,
      });

      await t.run(async (ctx: any) => {
        const membership = await ctx.db.get(memberMembershipId);
        const user = await ctx.db.get(memberUserId);
        const job = await ctx.db.get(result.jobId);

        expect(membership?.offboardingStatus).toBe("EXTERNAL_REMOVAL_RETRYING");
        expect(membership?.offboardingAttempts).toBeGreaterThan(0);
        expect(user).toBeTruthy();
        expect(job?.status).toBe("RETRYING");
        expect(job?.lastError).toMatch(/cleanup is not configured/i);
      });
    } finally {
      if (originalSecret === undefined) {
        delete process.env.CLERK_SECRET_KEY;
      } else {
        process.env.CLERK_SECRET_KEY = originalSecret;
      }
    }
  });

  test("finalizes local deletion only after Clerk user deletion succeeds", async () => {
    const originalSecret = process.env.CLERK_SECRET_KEY;
    process.env.CLERK_SECRET_KEY = "test_secret";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));

    try {
      const t = convexTest(schema, import.meta.glob("./**/*.*s"));
      const { orgId } = await setupOrg(t, "user_success_owner");
      const memberRoleId = await t.run((ctx: any) =>
        ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
      ) as Id<"roles">;
      const memberUserId = await t.run((ctx: any) =>
        ctx.db.insert("users", { clerkId: "user_success_target", email: "success-target@test.com" })
      ) as Id<"users">;
      const memberMembershipId = await t.run((ctx: any) =>
        ctx.db.insert("memberships", { orgId, userId: memberUserId, roleId: memberRoleId })
      ) as Id<"memberships">;

      const asOwner = t.withIdentity({ subject: "user_success_owner" });
      const result = await asOwner.action(api.memberships.remove, {
        orgId,
        membershipId: memberMembershipId,
      });

      await t.action(internal.memberships.processMembershipOffboardingJob, {
        jobId: result.jobId,
      });

      await t.run(async (ctx: any) => {
        const membership = await ctx.db.get(memberMembershipId);
        const user = await ctx.db.get(memberUserId);
        const job = await ctx.db.get(result.jobId);

        expect(membership).toBeNull();
        expect(user).toBeNull();
        expect(job?.status).toBe("SUCCEEDED");
        expect(job?.succeededAt).toBeTypeOf("number");
      });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://api.clerk.com/v1/users/user_success_target",
        expect.objectContaining({ method: "DELETE" })
      );
    } finally {
      vi.unstubAllGlobals();
      if (originalSecret === undefined) {
        delete process.env.CLERK_SECRET_KEY;
      } else {
        process.env.CLERK_SECRET_KEY = originalSecret;
      }
    }
  });
});

describe("memberships.updateRole", () => {
  test("changes a member's role", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, roleId } = await setupOrg(t, "user_m9");
    const asAdmin = t.withIdentity({ subject: "user_m9" });

    // Create a second role and a second member
    const salesRoleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
    ) as Id<"roles">;
    const userId2 = await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "user_m10", email: "member@test.com", name: "Member" })
    );
    const membershipId = await t.run((ctx: any) =>
      ctx.db.insert("memberships", { orgId, userId: userId2, roleId })
    ) as Id<"memberships">;

    await asAdmin.mutation(api.memberships.updateRole, {
      orgId,
      membershipId,
      newRoleId: salesRoleId,
    });

    await t.run(async (ctx: any) => {
      const membership = await ctx.db.get(membershipId);
      expect(membership?.roleId).toBe(salesRoleId);
    });
  });

  test("prevents a manager from demoting an owner", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, roleId: ownerRoleId } = await setupOrg(t, "user_owner_demote");
    const managerRoleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "MANAGER", permissions: ADMIN_PERMISSIONS })
    ) as Id<"roles">;
    const salesRoleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
    ) as Id<"roles">;
    const managerUserId = await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "user_manager_demote", email: "manager-demote@test.com" })
    );
    await t.run((ctx: any) =>
      ctx.db.insert("memberships", { orgId, userId: managerUserId, roleId: managerRoleId })
    );
    const secondOwnerUserId = await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "user_second_owner", email: "second-owner@test.com" })
    );
    const secondOwnerMembershipId = await t.run((ctx: any) =>
      ctx.db.insert("memberships", { orgId, userId: secondOwnerUserId, roleId: ownerRoleId })
    ) as Id<"memberships">;

    const asManager = t.withIdentity({ subject: "user_manager_demote" });
    await expect(
      asManager.mutation(api.memberships.updateRole, {
        orgId,
        membershipId: secondOwnerMembershipId,
        newRoleId: salesRoleId,
      })
    ).rejects.toThrow(/only the organization owner/i);
  });

  test("prevents a manager from assigning the owner role", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, roleId: ownerRoleId } = await setupOrg(t, "user_owner_assign");
    const managerRoleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "MANAGER", permissions: ADMIN_PERMISSIONS })
    ) as Id<"roles">;
    const salesRoleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
    ) as Id<"roles">;
    const managerUserId = await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "user_manager_assign", email: "manager-assign@test.com" })
    );
    await t.run((ctx: any) =>
      ctx.db.insert("memberships", { orgId, userId: managerUserId, roleId: managerRoleId })
    );
    const memberUserId = await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "user_member_assign", email: "member-assign@test.com" })
    );
    const memberMembershipId = await t.run((ctx: any) =>
      ctx.db.insert("memberships", { orgId, userId: memberUserId, roleId: salesRoleId })
    ) as Id<"memberships">;

    const asManager = t.withIdentity({ subject: "user_manager_assign" });
    await expect(
      asManager.mutation(api.memberships.updateRole, {
        orgId,
        membershipId: memberMembershipId,
        newRoleId: ownerRoleId,
      })
    ).rejects.toThrow(/only the organization owner/i);
  });

  test("prevents demoting the last owner", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, membershipId } = await setupOrg(t, "user_last_owner");
    const salesRoleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
    ) as Id<"roles">;

    const asOwner = t.withIdentity({ subject: "user_last_owner" });
    await expect(
      asOwner.mutation(api.memberships.updateRole, {
        orgId,
        membershipId,
        newRoleId: salesRoleId,
      })
    ).rejects.toThrow(/last owner/i);
  });

  test("allows an owner to demote another owner when another owner remains", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, roleId: ownerRoleId } = await setupOrg(t, "user_owner_demotes_peer");
    const salesRoleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
    ) as Id<"roles">;
    const secondOwnerUserId = await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "user_owner_peer", email: "owner-peer@test.com" })
    );
    const secondOwnerMembershipId = await t.run((ctx: any) =>
      ctx.db.insert("memberships", { orgId, userId: secondOwnerUserId, roleId: ownerRoleId })
    ) as Id<"memberships">;

    const asOwner = t.withIdentity({ subject: "user_owner_demotes_peer" });
    await asOwner.mutation(api.memberships.updateRole, {
      orgId,
      membershipId: secondOwnerMembershipId,
      newRoleId: salesRoleId,
    });

    await t.run(async (ctx: any) => {
      const membership = await ctx.db.get(secondOwnerMembershipId);
      expect(membership?.roleId).toBe(salesRoleId);
    });
  });

  test("blocks impersonation sessions from changing owner memberships", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, roleId: ownerRoleId } = await setupOrg(t, "user_real_owner");
    const salesRoleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
    ) as Id<"roles">;
    const impersonatorUserId = await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "user_impersonator", email: "impersonator@test.com" })
    );
    const impersonationMembershipId = await t.run((ctx: any) =>
      ctx.db.insert("memberships", { orgId, userId: impersonatorUserId, roleId: ownerRoleId })
    ) as Id<"memberships">;
    const grantId = await t.run((ctx: any) =>
      ctx.db.insert("impersonationGrants", {
        actorUserId: impersonatorUserId,
        targetUserId: impersonatorUserId,
        orgId,
        membershipId: impersonationMembershipId,
        reason: "test",
        grantedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      })
    );
    await t.run((ctx: any) =>
      ctx.db.patch(impersonationMembershipId, { impersonationGrantId: grantId })
    );
    const targetOwnerUserId = await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "user_target_owner", email: "target-owner@test.com" })
    );
    const targetOwnerMembershipId = await t.run((ctx: any) =>
      ctx.db.insert("memberships", { orgId, userId: targetOwnerUserId, roleId: ownerRoleId })
    ) as Id<"memberships">;

    const asImpersonator = t.withIdentity({ subject: "user_impersonator" });
    await expect(
      asImpersonator.mutation(api.memberships.updateRole, {
        orgId,
        membershipId: targetOwnerMembershipId,
        newRoleId: salesRoleId,
      })
    ).rejects.toThrow(/impersonation sessions/i);
  });

  test("transfers ownership atomically", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, roleId: ownerRoleId, membershipId: ownerMembershipId } = await setupOrg(t, "user_transfer_owner");
    const salesRoleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
    ) as Id<"roles">;
    const targetUserId = await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "user_transfer_target", email: "transfer-target@test.com" })
    );
    const targetMembershipId = await t.run((ctx: any) =>
      ctx.db.insert("memberships", { orgId, userId: targetUserId, roleId: salesRoleId })
    ) as Id<"memberships">;

    const asOwner = t.withIdentity({ subject: "user_transfer_owner" });
    await asOwner.mutation(api.memberships.transferOwnership, {
      orgId,
      targetMembershipId,
      currentOwnerNewRoleId: salesRoleId,
    });

    await t.run(async (ctx: any) => {
      const oldOwnerMembership = await ctx.db.get(ownerMembershipId);
      const newOwnerMembership = await ctx.db.get(targetMembershipId);
      expect(oldOwnerMembership?.roleId).toBe(salesRoleId);
      expect(newOwnerMembership?.roleId).toBe(ownerRoleId);
    });
  });
});
