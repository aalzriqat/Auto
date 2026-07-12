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

  test("rejects adding users when the org has reached its plan member limit", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, roleId } = await setupOrg(t, "user_member_limit_owner");
    const asOwner = t.withIdentity({ subject: "user_member_limit_owner" });

    await t.run(async (ctx: any) => {
      const secondUserId = await ctx.db.insert("users", {
        clerkId: "user_member_limit_second",
        email: "member-limit-second@test.com",
      });
      await ctx.db.insert("memberships", { orgId, userId: secondUserId, roleId });
    });

    await expect(
      asOwner.mutation(api.memberships.add, {
        orgId,
        userEmail: "third-member@example.com",
        roleId,
      })
    ).rejects.toThrow(/2-user limit/i);
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

describe("memberships.createAccount", () => {
  test("rolls back the direct-account invite when Clerk configuration is missing", async () => {
    const originalSecret = process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_SECRET_KEY;

    try {
      const t = convexTest(schema, import.meta.glob("./**/*.*s"));
      const { orgId } = await setupOrg(t, "user_create_account_owner");
      const roleId = await t.run((ctx: any) =>
        ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
      ) as Id<"roles">;
      const asAdmin = t.withIdentity({ subject: "user_create_account_owner" });

      await expect(
        asAdmin.action(api.memberships.createAccount, {
          orgId,
          firstName: "Direct",
          lastName: "MissingSecret",
          email: "direct-missing-secret@example.com",
          roleId,
        })
      ).rejects.toThrow(/CLERK_SECRET_KEY/i);

      await t.run(async (ctx: any) => {
        const invite = await ctx.db
          .query("invitations")
          .withIndex("by_org_email", (q: any) =>
            q.eq("orgId", orgId).eq("email", "direct-missing-secret@example.com")
          )
          .unique();
        expect(invite?.source).toBe("DIRECT_ACCOUNT");
        expect(invite?.status).toBe("REVOKED");
      });
    } finally {
      if (originalSecret === undefined) {
        delete process.env.CLERK_SECRET_KEY;
      } else {
        process.env.CLERK_SECRET_KEY = originalSecret;
      }
    }
  });

  test("uses an existing passwordless Clerk user and emails a one-time setup link", async () => {
    const originalSecret = process.env.CLERK_SECRET_KEY;
    process.env.CLERK_SECRET_KEY = "test_secret";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "clerk_existing", password_enabled: false }]), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "setup_token_existing" }), { status: 200 }))
    );

    try {
      const t = convexTest(schema, import.meta.glob("./**/*.*s"));
      const { orgId } = await setupOrg(t, "user_existing_clerk_owner");
      const roleId = await t.run((ctx: any) =>
        ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
      ) as Id<"roles">;
      const asAdmin = t.withIdentity({ subject: "user_existing_clerk_owner" });

      await expect(
        asAdmin.action(api.memberships.createAccount, {
          orgId,
          firstName: "Existing",
          lastName: "Passwordless",
          email: "existing-passwordless@example.com",
          roleId,
        })
      ).resolves.toEqual({ success: true });

      await t.run(async (ctx: any) => {
        const user = await ctx.db
          .query("users")
          .withIndex("by_clerkId", (q: any) => q.eq("clerkId", "clerk_existing"))
          .unique();
        const membership = await ctx.db
          .query("memberships")
          .withIndex("by_org_user", (q: any) => q.eq("orgId", orgId).eq("userId", user?._id))
          .unique();
        const invite = await ctx.db
          .query("invitations")
          .withIndex("by_org_email", (q: any) =>
            q.eq("orgId", orgId).eq("email", "existing-passwordless@example.com")
          )
          .unique();
        expect(user?.name).toBe("Existing Passwordless");
        expect(membership?.roleId).toBe(roleId);
        expect(invite?.status).toBe("ACCEPTED");
      });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://api.clerk.com/v1/sign_in_tokens",
        expect.objectContaining({ method: "POST" })
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

  test("retries Clerk username collisions, then rolls back and deletes the new Clerk user if setup token minting fails", async () => {
    const originalSecret = process.env.CLERK_SECRET_KEY;
    process.env.CLERK_SECRET_KEY = "test_secret";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          errors: [{ meta: { param_name: "username" }, message: "Username has been taken" }],
        }), { status: 422 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: "clerk_created_after_retry" }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ message: "Token service down" }] }), { status: 500 }))
        .mockResolvedValueOnce(new Response("", { status: 200 }))
    );

    try {
      const t = convexTest(schema, import.meta.glob("./**/*.*s"));
      const { orgId } = await setupOrg(t, "user_retry_clerk_owner");
      const roleId = await t.run((ctx: any) =>
        ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
      ) as Id<"roles">;
      const asAdmin = t.withIdentity({ subject: "user_retry_clerk_owner" });

      await expect(
        asAdmin.action(api.memberships.createAccount, {
          orgId,
          firstName: "Retry",
          lastName: "Collision",
          email: "retry-collision@example.com",
          roleId,
        })
      ).rejects.toThrow(/setup link/i);

      await t.run(async (ctx: any) => {
        const invite = await ctx.db
          .query("invitations")
          .withIndex("by_org_email", (q: any) =>
            q.eq("orgId", orgId).eq("email", "retry-collision@example.com")
          )
          .unique();
        const user = await ctx.db
          .query("users")
          .withIndex("by_clerkId", (q: any) => q.eq("clerkId", "clerk_created_after_retry"))
          .unique();
        expect(invite?.status).toBe("REVOKED");
        expect(user).toBeNull();
      });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://api.clerk.com/v1/users/clerk_created_after_retry",
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

  test("returns Clerk validation messages for direct account creation failures", async () => {
    const originalSecret = process.env.CLERK_SECRET_KEY;
    process.env.CLERK_SECRET_KEY = "test_secret";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          errors: [{
            code: "form_data_missing",
            long_message: "last_name is required",
            meta: { param_names: ["last_name"] },
          }],
        }), { status: 422 }))
    );

    try {
      const t = convexTest(schema, import.meta.glob("./**/*.*s"));
      const { orgId } = await setupOrg(t, "user_clerk_validation_owner");
      const roleId = await t.run((ctx: any) =>
        ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
      ) as Id<"roles">;
      const asAdmin = t.withIdentity({ subject: "user_clerk_validation_owner" });

      await expect(
        asAdmin.action(api.memberships.createAccount, {
          orgId,
          firstName: "Missing",
          lastName: "",
          email: "missing-last-name@example.com",
          roleId,
        })
      ).rejects.toThrow(/family name is required/i);
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

describe("memberships direct-account utilities", () => {
  test("prepareDirectAccount rejects already-member users and existing pending direct invites", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, roleId, userId } = await setupOrg(t, "user_prepare_direct_owner");
    const asOwner = t.withIdentity({ subject: "user_prepare_direct_owner" });

    await expect(
      asOwner.action(api.memberships.createAccount, {
        orgId,
        firstName: "Already",
        lastName: "Member",
        email: "user_prepare_direct_owner@test.com",
        roleId,
      })
    ).rejects.toThrow(/already a member/i);

    await t.run((ctx: any) =>
      ctx.db.insert("invitations", {
        orgId,
        email: "pending-direct@example.com",
        roleId,
        createdBy: userId,
        status: "PENDING",
        source: "DIRECT_ACCOUNT",
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    await expect(
      asOwner.action(api.memberships.createAccount, {
        orgId,
        firstName: "Pending",
        lastName: "Direct",
        email: "pending-direct@example.com",
        roleId,
      })
    ).rejects.toThrow(/already pending/i);
  });

  test("checkEmailExists requires auth, handles missing Clerk config, and maps Clerk names", async () => {
    const originalSecret = process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_SECRET_KEY;
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await setupOrg(t, "user_check_email_owner");
    const asOwner = t.withIdentity({ subject: "user_check_email_owner" });

    await expect(
      t.action(api.memberships.checkEmailExists, { orgId, email: "nobody@example.com" })
    ).rejects.toThrow(/unauthenticated/i);
    await expect(
      asOwner.action(api.memberships.checkEmailExists, { orgId, email: "nobody@example.com" })
    ).resolves.toEqual({ exists: false });

    process.env.CLERK_SECRET_KEY = "test_secret";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify([{ first_name: "Clara", last_name: "Osman" }]), { status: 200 }))
    );
    await expect(
      asOwner.action(api.memberships.checkEmailExists, { orgId, email: "clara@example.com" })
    ).resolves.toEqual({ exists: true, firstName: "Clara", lastName: "Osman" });

    vi.unstubAllGlobals();
    if (originalSecret === undefined) {
      delete process.env.CLERK_SECRET_KEY;
    } else {
      process.env.CLERK_SECRET_KEY = originalSecret;
    }
  });

  test("syncRolePermissionsToTemplate updates standard roles and skips custom roles", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await setupOrg(t, "user_sync_roles_owner");
    const managerRoleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "MANAGER", permissions: [] })
    ) as Id<"roles">;
    const customRoleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "CUSTOM", permissions: ["custom:permission"] })
    ) as Id<"roles">;
    const asOwner = t.withIdentity({ subject: "user_sync_roles_owner" });

    const updated = await asOwner.mutation(api.memberships.syncRolePermissionsToTemplate, { orgId });
    expect(updated).toBeGreaterThanOrEqual(2);

    await t.run(async (ctx: any) => {
      const managerRole = await ctx.db.get(managerRoleId);
      const customRole = await ctx.db.get(customRoleId);
      expect(managerRole?.permissions.length).toBeGreaterThan(0);
      expect(customRole?.permissions).toEqual(["custom:permission"]);
    });
  });

  test("finalizeDirectAccount rejects invalid invitations and preserves existing user profile fields", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId: inviterId } = await setupOrg(t, "user_finalize_direct_owner");
    const roleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
    ) as Id<"roles">;
    const existingUserId = await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "clerk_existing_direct", email: "real-existing@example.com", name: "Real Existing" })
    ) as Id<"users">;
    const wrongSourceInviteId = await t.run((ctx: any) =>
      ctx.db.insert("invitations", {
        orgId,
        email: "real-existing@example.com",
        roleId,
        createdBy: inviterId,
        status: "PENDING",
        source: "EMAIL_INVITE",
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    ) as Id<"invitations">;
    await expect(
      t.mutation(internal.memberships.finalizeDirectAccount, {
        clerkId: "clerk_existing_direct",
        email: "real-existing@example.com",
        name: "Typed Over",
        orgId,
        roleId,
        inviteId: wrongSourceInviteId,
      })
    ).rejects.toThrow(/no longer valid/i);

    const inviteId = await t.run((ctx: any) =>
      ctx.db.insert("invitations", {
        orgId,
        email: "real-existing@example.com",
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
      clerkId: "clerk_existing_direct",
      email: "real-existing@example.com",
      name: "Typed Over",
      orgId,
      roleId,
      inviteId,
    });

    await t.run(async (ctx: any) => {
      const user = await ctx.db.get(existingUserId);
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q: any) => q.eq("orgId", orgId).eq("userId", existingUserId))
        .unique();
      expect(user?.email).toBe("real-existing@example.com");
      expect(user?.name).toBe("Real Existing");
      expect(membership?.roleId).toBe(roleId);
    });
  });

  test("finalizeDirectAccount rejects stale or mismatched invites and fills blank user profiles", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId: inviterId, roleId: ownerRoleId } = await setupOrg(t, "user_finalize_more_owner");
    const roleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
    ) as Id<"roles">;
    const otherRoleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "ACCOUNTANT", permissions: [] })
    ) as Id<"roles">;

    const mismatchedInviteId = await t.run((ctx: any) =>
      ctx.db.insert("invitations", {
        orgId,
        email: "wrong-role@example.com",
        roleId,
        createdBy: inviterId,
        status: "PENDING",
        source: "DIRECT_ACCOUNT",
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    ) as Id<"invitations">;
    await expect(
      t.mutation(internal.memberships.finalizeDirectAccount, {
        clerkId: "clerk_wrong_role",
        email: "wrong-role@example.com",
        name: "Wrong Role",
        orgId,
        roleId: otherRoleId,
        inviteId: mismatchedInviteId,
      })
    ).rejects.toThrow(/no longer valid/i);

    const acceptedInviteId = await t.run((ctx: any) =>
      ctx.db.insert("invitations", {
        orgId,
        email: "accepted@example.com",
        roleId,
        createdBy: inviterId,
        status: "ACCEPTED",
        source: "DIRECT_ACCOUNT",
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    ) as Id<"invitations">;
    await expect(
      t.mutation(internal.memberships.finalizeDirectAccount, {
        clerkId: "clerk_accepted_direct",
        email: "accepted@example.com",
        name: "Accepted Invite",
        orgId,
        roleId,
        inviteId: acceptedInviteId,
      })
    ).rejects.toThrow(/no longer valid/i);

    const expiredInviteId = await t.run((ctx: any) =>
      ctx.db.insert("invitations", {
        orgId,
        email: "expired-direct@example.com",
        roleId,
        createdBy: inviterId,
        status: "PENDING",
        source: "DIRECT_ACCOUNT",
        expiresAt: Date.now() - 1,
        createdAt: Date.now() - 120_000,
        updatedAt: Date.now() - 120_000,
      })
    ) as Id<"invitations">;
    await expect(
      t.mutation(internal.memberships.finalizeDirectAccount, {
        clerkId: "clerk_expired_direct",
        email: "expired-direct@example.com",
        name: "Expired Direct",
        orgId,
        roleId,
        inviteId: expiredInviteId,
      })
    ).rejects.toThrow(/expired/i);

    const blankUserId = await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "clerk_blank_direct", email: "", name: "" })
    ) as Id<"users">;
    const blankInviteId = await t.run((ctx: any) =>
      ctx.db.insert("invitations", {
        orgId,
        email: "blank-direct@example.com",
        roleId: ownerRoleId,
        createdBy: inviterId,
        status: "PENDING",
        source: "DIRECT_ACCOUNT",
        ownerRoleAuthorizedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    ) as Id<"invitations">;
    await t.mutation(internal.memberships.finalizeDirectAccount, {
      clerkId: "clerk_blank_direct",
      email: "blank-direct@example.com",
      name: "Filled Direct",
      orgId,
      roleId: ownerRoleId,
      inviteId: blankInviteId,
    });

    await t.run(async (ctx: any) => {
      const user = await ctx.db.get(blankUserId);
      expect(user?.email).toBe("blank-direct@example.com");
      expect(user?.name).toBe("Filled Direct");
    });
  });

  test("createAccount rolls back Clerk users when finalization fails after setup token creation", async () => {
    const originalSecret = process.env.CLERK_SECRET_KEY;
    process.env.CLERK_SECRET_KEY = "test_secret";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes("/sign_in_tokens")) {
        return new Response(JSON.stringify({ token: "setup-token" }), { status: 200 });
      }
      if (method === "DELETE") {
        return new Response(JSON.stringify({ errors: [{ message: "delete failed" }] }), { status: 500 });
      }
      return new Response(JSON.stringify({ id: "clerk_plan_full" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const t = convexTest(schema, import.meta.glob("./**/*.*s"));
      const { orgId, roleId } = await setupOrg(t, "user_plan_full_direct_owner");
      await t.run(async (ctx: any) => {
        const secondUserId = await ctx.db.insert("users", {
          clerkId: "user_plan_full_direct_second",
          email: "plan-full-direct-second@test.com",
        });
        await ctx.db.insert("memberships", { orgId, userId: secondUserId, roleId });
      });
      const asOwner = t.withIdentity({ subject: "user_plan_full_direct_owner" });

      await expect(
        asOwner.action(api.memberships.createAccount, {
          orgId,
          firstName: "Plan",
          lastName: "Full",
          email: "plan-full-new@example.com",
          roleId,
        })
      ).rejects.toThrow(/2-user limit/i);

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.clerk.com/v1/users/clerk_plan_full",
        expect.objectContaining({ method: "DELETE" })
      );
      await t.run(async (ctx: any) => {
        const invite = await ctx.db
          .query("invitations")
          .withIndex("by_org_email", (q: any) => q.eq("orgId", orgId).eq("email", "plan-full-new@example.com"))
          .first();
        expect(invite?.status).toBe("REVOKED");
      });
    } finally {
      consoleError.mockRestore();
      vi.unstubAllGlobals();
      if (originalSecret === undefined) {
        delete process.env.CLERK_SECRET_KEY;
      } else {
        process.env.CLERK_SECRET_KEY = originalSecret;
      }
    }
  });

  test("createAccount surfaces Clerk error shapes and handles rollback delete exceptions", async () => {
    const originalSecret = process.env.CLERK_SECRET_KEY;
    process.env.CLERK_SECRET_KEY = "test_secret";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      {
        const t = convexTest(schema, import.meta.glob("./**/*.*s"));
        const { orgId, roleId } = await setupOrg(t, "user_existing_no_token_owner");
        const asOwner = t.withIdentity({ subject: "user_existing_no_token_owner" });
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("/sign_in_tokens")) {
              return new Response(JSON.stringify({}), { status: 200 });
            }
            return new Response(JSON.stringify([{ id: "clerk_existing_no_token", password_enabled: false }]), {
              status: 200,
            });
          })
        );
        await expect(
          asOwner.action(api.memberships.createAccount, {
            orgId,
            firstName: "No",
            lastName: "Token",
            email: "no-token@example.com",
            roleId,
          })
        ).rejects.toThrow(/setup link/i);
        vi.unstubAllGlobals();
      }

      {
        const t = convexTest(schema, import.meta.glob("./**/*.*s"));
        const { orgId, roleId } = await setupOrg(t, "user_clerk_long_error_owner");
        const asOwner = t.withIdentity({ subject: "user_clerk_long_error_owner" });
        vi.stubGlobal(
          "fetch",
          vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify([]), { status: 200 });
            return new Response(
              JSON.stringify({ errors: [{ long_message: "Clerk says this email is blocked." }] }),
              { status: 400 }
            );
          })
        );
        await expect(
          asOwner.action(api.memberships.createAccount, {
            orgId,
            firstName: "Blocked",
            lastName: "Email",
            email: "blocked@example.com",
            roleId,
          })
        ).rejects.toThrow(/email is blocked/i);
        vi.unstubAllGlobals();
      }

      {
        const t = convexTest(schema, import.meta.glob("./**/*.*s"));
        const { orgId, roleId } = await setupOrg(t, "user_clerk_empty_error_owner");
        const asOwner = t.withIdentity({ subject: "user_clerk_empty_error_owner" });
        vi.stubGlobal(
          "fetch",
          vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify([]), { status: 200 });
            return new Response(JSON.stringify({ errors: [] }), { status: 500 });
          })
        );
        await expect(
          asOwner.action(api.memberships.createAccount, {
            orgId,
            firstName: "Empty",
            lastName: "Error",
            email: "empty-error@example.com",
            roleId,
          })
        ).rejects.toThrow(/failed to create user in clerk/i);
        vi.unstubAllGlobals();
      }

      {
        const t = convexTest(schema, import.meta.glob("./**/*.*s"));
        const { orgId, roleId } = await setupOrg(t, "user_delete_reject_owner");
        const asOwner = t.withIdentity({ subject: "user_delete_reject_owner" });
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method ?? "GET";
            if (method === "GET") return new Response(JSON.stringify([]), { status: 200 });
            if (url.includes("/sign_in_tokens")) {
              return new Response(JSON.stringify({ errors: [{ message: "token service down" }] }), { status: 500 });
            }
            if (method === "DELETE") throw new Error("delete network down");
            return new Response(JSON.stringify({ id: "clerk_delete_reject" }), { status: 200 });
          })
        );
        await expect(
          asOwner.action(api.memberships.createAccount, {
            orgId,
            firstName: "Delete",
            lastName: "Reject",
            email: "delete-reject@example.com",
            roleId,
          })
        ).rejects.toThrow(/setup link/i);
        vi.unstubAllGlobals();
      }
    } finally {
      consoleError.mockRestore();
      vi.unstubAllGlobals();
      if (originalSecret === undefined) {
        delete process.env.CLERK_SECRET_KEY;
      } else {
        process.env.CLERK_SECRET_KEY = originalSecret;
      }
    }
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

describe("memberships list, invites, and profile metadata", () => {
  test("list filters offboarding rows and getMyMembership expands owner permissions", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, roleId } = await setupOrg(t, "user_list_owner");
    const offboardedUserId = await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "user_list_offboarded", email: "list-offboarded@test.com" })
    );
    await t.run((ctx: any) =>
      ctx.db.insert("memberships", {
        orgId,
        userId: offboardedUserId,
        roleId,
        offboardingStatus: "PENDING_EXTERNAL_REMOVAL",
      })
    );
    const asOwner = t.withIdentity({ subject: "user_list_owner" });

    const list = await asOwner.query(api.memberships.list, {
      orgId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(list.page).toHaveLength(1);
    expect(list.page[0]).toMatchObject({
      userName: "Admin User",
      roleName: "OWNER",
      commissionRate: 0,
    });

    const mine = await asOwner.query(api.memberships.getMyMembership, { orgId });
    expect(mine.permissions).toEqual(expect.arrayContaining(ALL_PERMISSIONS));
  });

  test("add rejects invalid roles and reuses pending invite checks", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, roleId, userId } = await setupOrg(t, "user_invite_reuse_owner");
    const otherRoleId = await t.run(async (ctx: any) => {
      const otherOrgId = await ctx.db.insert("organizations", { name: "Other Invite Org", createdAt: Date.now() });
      return await ctx.db.insert("roles", { orgId: otherOrgId, name: "SALES", permissions: [] });
    }) as Id<"roles">;
    const asOwner = t.withIdentity({ subject: "user_invite_reuse_owner" });

    await expect(
      asOwner.mutation(api.memberships.add, {
        orgId,
        userEmail: "bad-role@example.com",
        roleId: otherRoleId,
      })
    ).rejects.toThrow(/specified role/i);

    await t.run(async (ctx: any) => {
      await ctx.db.insert("invitations", {
        orgId,
        email: "stale-invite@example.com",
        roleId,
        createdBy: userId,
        tokenHash: await hashInviteToken("stale-token"),
        status: "PENDING",
        source: "EMAIL_INVITE",
        expiresAt: Date.now() - 1,
        createdAt: Date.now() - 120_000,
        updatedAt: Date.now() - 120_000,
      });
    });
    const staleResult = await asOwner.mutation(api.memberships.add, {
      orgId,
      userEmail: "stale-invite@example.com",
      roleId,
    });
    expect(staleResult).toEqual({ status: "invited" });

    await expect(
      asOwner.mutation(api.memberships.add, {
        orgId,
        userEmail: "stale-invite@example.com",
        roleId,
      })
    ).rejects.toThrow(/already pending/i);

    await t.run(async (ctx: any) => {
      const invites = await ctx.db
        .query("invitations")
        .withIndex("by_org_email", (q: any) => q.eq("orgId", orgId).eq("email", "stale-invite@example.com"))
        .collect();
      expect(invites.some((invite: any) => invite.status === "EXPIRED")).toBe(true);
      expect(invites.some((invite: any) => invite.status === "PENDING")).toBe(true);
    });
  });

  test("acceptInvitation rejects short, mismatched, unavailable-org, invalid-role, owner-unauthorized, and offboarding invites", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId: inviterId, roleId: ownerRoleId } = await setupOrg(t, "user_invite_validation_owner");
    const roleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
    ) as Id<"roles">;
    const inviteeId = await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "user_invite_validation_invitee", email: "invite-validation@example.com" })
    ) as Id<"users">;
    const asInvitee = t.withIdentity({ subject: "user_invite_validation_invitee" });

    await expect(
      asInvitee.mutation(api.memberships.acceptInvitation, { token: "too-short" })
    ).rejects.toThrow(/no longer valid/i);

    const directAccountToken = "direct-account-token-1234567890abcdef";
    await t.run(async (ctx: any) =>
      ctx.db.insert("invitations", {
        orgId,
        email: "invite-validation@example.com",
        roleId,
        createdBy: inviterId,
        tokenHash: await hashInviteToken(directAccountToken),
        status: "PENDING",
        source: "DIRECT_ACCOUNT",
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    await expect(
      asInvitee.mutation(api.memberships.acceptInvitation, { token: directAccountToken })
    ).rejects.toThrow(/no longer valid/i);

    const mismatchedToken = "mismatched-invite-token-1234567890";
    await t.run(async (ctx: any) =>
      ctx.db.insert("invitations", {
        orgId,
        email: "someone-else@example.com",
        roleId,
        createdBy: inviterId,
        tokenHash: await hashInviteToken(mismatchedToken),
        status: "PENDING",
        source: "EMAIL_INVITE",
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    await expect(
      asInvitee.mutation(api.memberships.acceptInvitation, { token: mismatchedToken })
    ).rejects.toThrow(/not assigned/i);

    const suspendedToken = "suspended-invite-token-1234567890";
    await t.run(async (ctx: any) => {
      await ctx.db.patch(orgId, { suspended: true });
      await ctx.db.insert("invitations", {
        orgId,
        email: "invite-validation@example.com",
        roleId,
        createdBy: inviterId,
        tokenHash: await hashInviteToken(suspendedToken),
        status: "PENDING",
        source: "EMAIL_INVITE",
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    await expect(
      asInvitee.mutation(api.memberships.acceptInvitation, { token: suspendedToken })
    ).rejects.toThrow(/organization is no longer available/i);
    await t.run((ctx: any) => ctx.db.patch(orgId, { suspended: false }));

    const deletedRoleToken = "deleted-role-token-1234567890abcdef";
    const deletedRoleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "DELETED", permissions: [], isDeleted: true })
    ) as Id<"roles">;
    await t.run(async (ctx: any) =>
      ctx.db.insert("invitations", {
        orgId,
        email: "invite-validation@example.com",
        roleId: deletedRoleId,
        createdBy: inviterId,
        tokenHash: await hashInviteToken(deletedRoleToken),
        status: "PENDING",
        source: "EMAIL_INVITE",
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    await expect(
      asInvitee.mutation(api.memberships.acceptInvitation, { token: deletedRoleToken })
    ).rejects.toThrow(/invitation role/i);

    const ownerToken = "owner-role-token-1234567890abcdef";
    await t.run(async (ctx: any) =>
      ctx.db.insert("invitations", {
        orgId,
        email: "invite-validation@example.com",
        roleId: ownerRoleId,
        createdBy: inviterId,
        tokenHash: await hashInviteToken(ownerToken),
        status: "PENDING",
        source: "EMAIL_INVITE",
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    await expect(
      asInvitee.mutation(api.memberships.acceptInvitation, { token: ownerToken })
    ).rejects.toThrow(/owner invitation/i);

    await t.run((ctx: any) =>
      ctx.db.insert("memberships", {
        orgId,
        userId: inviteeId,
        roleId,
        offboardingStatus: "PENDING_EXTERNAL_REMOVAL",
      })
    );
    const offboardingToken = "offboarding-token-1234567890abcdef";
    await t.run(async (ctx: any) =>
      ctx.db.insert("invitations", {
        orgId,
        email: "invite-validation@example.com",
        roleId,
        createdBy: inviterId,
        tokenHash: await hashInviteToken(offboardingToken),
        status: "PENDING",
        source: "EMAIL_INVITE",
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    await expect(
      asInvitee.mutation(api.memberships.acceptInvitation, { token: offboardingToken })
    ).rejects.toThrow(/still being removed/i);
  });

  test("touchLastSeen throttles writes and commission rate updates validate membership state", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, membershipId } = await setupOrg(t, "user_profile_metadata_owner");
    const asOwner = t.withIdentity({ subject: "user_profile_metadata_owner" });

    await asOwner.mutation(api.memberships.touchLastSeen, { orgId });
    const firstSeenAt = await t.run(async (ctx: any) => (await ctx.db.get(membershipId))?.lastSeenAt);
    expect(firstSeenAt).toBeTypeOf("number");
    await asOwner.mutation(api.memberships.touchLastSeen, { orgId });
    const secondSeenAt = await t.run(async (ctx: any) => (await ctx.db.get(membershipId))?.lastSeenAt);
    expect(secondSeenAt).toBe(firstSeenAt);

    await asOwner.mutation(api.memberships.updateCommissionRate, {
      orgId,
      membershipId,
      commissionRate: 12.5,
    });
    await t.run(async (ctx: any) => {
      const membership = await ctx.db.get(membershipId);
      const notification = await ctx.db
        .query("notifications")
        .withIndex("by_user", (q: any) => q.eq("userId", membership!.userId))
        .first();
      expect(membership?.commissionRate).toBe(12.5);
      expect(notification?.type).toBe("membership.commission_rate_changed");
    });

    await expect(
      asOwner.mutation(api.memberships.updateCommissionRate, {
        orgId,
        membershipId,
        commissionRate: 101,
      })
    ).rejects.toThrow(/between 0 and 100/i);

    const otherMembershipId = await t.run(async (ctx: any) => {
      const otherOrgId = await ctx.db.insert("organizations", { name: "Other Commission Org", createdAt: Date.now() });
      const otherRoleId = await ctx.db.insert("roles", { orgId: otherOrgId, name: "SALES", permissions: [] });
      const otherUserId = await ctx.db.insert("users", { clerkId: "user_commission_other", email: "commission-other@test.com" });
      return await ctx.db.insert("memberships", { orgId: otherOrgId, userId: otherUserId, roleId: otherRoleId });
    }) as Id<"memberships">;
    await expect(
      asOwner.mutation(api.memberships.updateCommissionRate, {
        orgId,
        membershipId: otherMembershipId,
        commissionRate: 5,
      })
    ).rejects.toThrow(/membership not found/i);

    const targetUserId = await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "user_commission_offboarded", email: "commission-offboarded@test.com" })
    );
    const targetMembershipId = await t.run(async (ctx: any) => {
      const ownerMembership = await ctx.db.get(membershipId);
      return await ctx.db.insert("memberships", {
        orgId,
        userId: targetUserId,
        roleId: ownerMembership!.roleId,
        offboardingStatus: "PENDING_EXTERNAL_REMOVAL",
      });
    }) as Id<"memberships">;
    await expect(
      asOwner.mutation(api.memberships.updateCommissionRate, {
        orgId,
        membershipId: targetMembershipId,
        commissionRate: 5,
      })
    ).rejects.toThrow(/removal is already in progress/i);
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

  test("reuses an existing offboarding job and drains due jobs", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await setupOrg(t, "user_reuse_job_owner");
    const memberRoleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
    ) as Id<"roles">;
    const memberUserId = await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "user_reuse_job_target", email: "reuse-job@test.com" })
    ) as Id<"users">;
    const memberMembershipId = await t.run((ctx: any) =>
      ctx.db.insert("memberships", { orgId, userId: memberUserId, roleId: memberRoleId })
    ) as Id<"memberships">;
    const asOwner = t.withIdentity({ subject: "user_reuse_job_owner" });

    const first = await asOwner.action(api.memberships.remove, {
      orgId,
      membershipId: memberMembershipId,
    });
    const second = await asOwner.action(api.memberships.remove, {
      orgId,
      membershipId: memberMembershipId,
    });
    expect(second.jobId).toBe(first.jobId);

    const due = await t.query(internal.memberships.listDueMembershipOffboardingJobs, {
      now: Date.now() + 1,
      limit: 0,
    });
    expect(due.map((job: { _id: Id<"membershipOffboardingJobs"> }) => job._id)).toContain(first.jobId);

    const originalSecret = process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_SECRET_KEY;
    try {
      const drained = await t.action(internal.memberships.drainDueMembershipOffboardingJobs, {});
      expect(drained.processed).toBeGreaterThan(0);
    } finally {
      if (originalSecret === undefined) {
        delete process.env.CLERK_SECRET_KEY;
      } else {
        process.env.CLERK_SECRET_KEY = originalSecret;
      }
    }
  });

  test("records retry when Clerk deletion returns a server error", async () => {
    const originalSecret = process.env.CLERK_SECRET_KEY;
    process.env.CLERK_SECRET_KEY = "test_secret";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("server unavailable", { status: 500 })));

    try {
      const t = convexTest(schema, import.meta.glob("./**/*.*s"));
      const { orgId } = await setupOrg(t, "user_clerk_delete_failure_owner");
      const memberRoleId = await t.run((ctx: any) =>
        ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
      ) as Id<"roles">;
      const memberUserId = await t.run((ctx: any) =>
        ctx.db.insert("users", { clerkId: "user_clerk_delete_failure", email: "clerk-delete-failure@test.com" })
      ) as Id<"users">;
      const memberMembershipId = await t.run((ctx: any) =>
        ctx.db.insert("memberships", { orgId, userId: memberUserId, roleId: memberRoleId })
      ) as Id<"memberships">;
      const asOwner = t.withIdentity({ subject: "user_clerk_delete_failure_owner" });
      const result = await asOwner.action(api.memberships.remove, { orgId, membershipId: memberMembershipId });

      await expect(
        t.action(internal.memberships.processMembershipOffboardingJob, { jobId: result.jobId })
      ).resolves.toEqual({ status: "RETRYING" });

      await t.run(async (ctx: any) => {
        const job = await ctx.db.get(result.jobId);
        expect(job?.status).toBe("RETRYING");
        expect(job?.lastError).toMatch(/cleanup failed/i);
      });
    } finally {
      vi.unstubAllGlobals();
      if (originalSecret === undefined) {
        delete process.env.CLERK_SECRET_KEY;
      } else {
        process.env.CLERK_SECRET_KEY = originalSecret;
      }
    }
  });

  test("finalizes orphaned offboarding jobs without Clerk deletion", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await setupOrg(t, "user_orphan_job_owner");
    const memberRoleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
    ) as Id<"roles">;
    const memberUserId = await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "user_orphan_job_target", email: "orphan-job@test.com" })
    ) as Id<"users">;
    const memberMembershipId = await t.run((ctx: any) =>
      ctx.db.insert("memberships", { orgId, userId: memberUserId, roleId: memberRoleId })
    ) as Id<"memberships">;
    const jobId = await t.run(async (ctx: any) => {
      const jobId = await ctx.db.insert("membershipOffboardingJobs", {
        orgId,
        membershipId: memberMembershipId,
        userId: memberUserId,
        clerkId: "user_orphan_job_target",
        requestedBy: memberUserId,
        status: "PENDING",
        attempts: 0,
        nextAttemptAt: Date.now() - 1,
        requiresClerkUserDeletion: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.delete(memberMembershipId);
      await ctx.db.delete(memberUserId);
      return jobId;
    }) as Id<"membershipOffboardingJobs">;

    await expect(
      t.action(internal.memberships.processMembershipOffboardingJob, { jobId })
    ).resolves.toEqual({ status: "SUCCEEDED" });
  });

  test("remove handles missing memberships, last owners, missing users, and stale jobs", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, membershipId: ownerMembershipId } = await setupOrg(t, "user_remove_edges_owner");
    const salesRoleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
    ) as Id<"roles">;
    const asOwner = t.withIdentity({ subject: "user_remove_edges_owner" });

    const otherMembershipId = await t.run(async (ctx: any) => {
      const otherOrgId = await ctx.db.insert("organizations", { name: "Other Remove Org", createdAt: Date.now() });
      const otherRoleId = await ctx.db.insert("roles", { orgId: otherOrgId, name: "SALES", permissions: [] });
      const otherUserId = await ctx.db.insert("users", { clerkId: "user_remove_edges_other", email: "remove-other@test.com" });
      return await ctx.db.insert("memberships", { orgId: otherOrgId, userId: otherUserId, roleId: otherRoleId });
    }) as Id<"memberships">;
    await expect(
      asOwner.action(api.memberships.remove, { orgId, membershipId: otherMembershipId })
    ).rejects.toThrow(/membership not found/i);

    await expect(
      asOwner.action(api.memberships.remove, { orgId, membershipId: ownerMembershipId })
    ).rejects.toThrow(/cannot remove the last owner/i);

    const missingUserMembershipId = await t.run(async (ctx: any) => {
      const missingUserId = await ctx.db.insert("users", {
        clerkId: "user_remove_edges_missing",
        email: "remove-missing@test.com",
      });
      const membershipId = await ctx.db.insert("memberships", { orgId, userId: missingUserId, roleId: salesRoleId });
      await ctx.db.delete(missingUserId);
      return membershipId;
    }) as Id<"memberships">;
    await expect(
      asOwner.action(api.memberships.remove, { orgId, membershipId: missingUserMembershipId })
    ).rejects.toThrow(/user record is missing/i);

    const staleJob = await t.run(async (ctx: any) => {
      const userId = await ctx.db.insert("users", { clerkId: "user_remove_edges_stale", email: "remove-stale@test.com" });
      const membershipId = await ctx.db.insert("memberships", { orgId, userId, roleId: salesRoleId });
      const jobId = await ctx.db.insert("membershipOffboardingJobs", {
        orgId,
        membershipId,
        userId,
        clerkId: "user_remove_edges_stale",
        requestedBy: userId,
        status: "RETRYING",
        attempts: 2,
        nextAttemptAt: Date.now() - 1,
        requiresClerkUserDeletion: true,
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 60_000,
      });
      return { membershipId, jobId };
    }) as { membershipId: Id<"memberships">; jobId: Id<"membershipOffboardingJobs"> };
    const reused = await asOwner.action(api.memberships.remove, { orgId, membershipId: staleJob.membershipId });
    expect(reused).toMatchObject({ jobId: staleJob.jobId, status: "RETRYING", requiresClerkUserDeletion: true });
    await t.run(async (ctx: any) => {
      const membership = await ctx.db.get(staleJob.membershipId);
      expect(membership?.offboardingStatus).toBe("PENDING_EXTERNAL_REMOVAL");
      expect(membership?.offboardingAttempts).toBe(2);
    });

    const completedJobMembershipId = await t.run(async (ctx: any) => {
      const userId = await ctx.db.insert("users", { clerkId: "user_remove_edges_completed", email: "remove-completed@test.com" });
      const membershipId = await ctx.db.insert("memberships", {
        orgId,
        userId,
        roleId: salesRoleId,
        offboardingStatus: "PENDING_EXTERNAL_REMOVAL",
      });
      await ctx.db.insert("membershipOffboardingJobs", {
        orgId,
        membershipId,
        userId,
        clerkId: "user_remove_edges_completed",
        requestedBy: userId,
        status: "SUCCEEDED",
        attempts: 1,
        nextAttemptAt: Date.now(),
        requiresClerkUserDeletion: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return membershipId;
    }) as Id<"memberships">;
    await expect(
      asOwner.action(api.memberships.remove, { orgId, membershipId: completedJobMembershipId })
    ).rejects.toThrow(/removal is already in progress/i);
  });

  test("processMembershipOffboardingJob retries missing Clerk identities and thrown delete requests", async () => {
    const originalSecret = process.env.CLERK_SECRET_KEY;
    process.env.CLERK_SECRET_KEY = "test_secret";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const t = convexTest(schema, import.meta.glob("./**/*.*s"));
      const { orgId } = await setupOrg(t, "user_offboarding_edges_owner");
      const salesRoleId = await t.run((ctx: any) =>
        ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
      ) as Id<"roles">;

      const missingClerkJobId = await t.run(async (ctx: any) => {
        const userId = await ctx.db.insert("users", { clerkId: "", email: "missing-clerk@test.com" });
        const membershipId = await ctx.db.insert("memberships", { orgId, userId, roleId: salesRoleId });
        return await ctx.db.insert("membershipOffboardingJobs", {
          orgId,
          membershipId,
          userId,
          clerkId: "",
          requestedBy: userId,
          status: "PENDING",
          attempts: 0,
          nextAttemptAt: Date.now() - 1,
          requiresClerkUserDeletion: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }) as Id<"membershipOffboardingJobs">;
      await expect(
        t.action(internal.memberships.processMembershipOffboardingJob, { jobId: missingClerkJobId })
      ).resolves.toEqual({ status: "RETRYING" });
      await t.run(async (ctx: any) => {
        const job = await ctx.db.get(missingClerkJobId);
        expect(job?.lastError).toMatch(/identity is missing/i);
      });

      const thrownDeleteJobId = await t.run(async (ctx: any) => {
        const userId = await ctx.db.insert("users", {
          clerkId: "user_delete_throw_target",
          email: "delete-throw@test.com",
        });
        const membershipId = await ctx.db.insert("memberships", { orgId, userId, roleId: salesRoleId });
        return await ctx.db.insert("membershipOffboardingJobs", {
          orgId,
          membershipId,
          userId,
          clerkId: "user_delete_throw_target",
          requestedBy: userId,
          status: "PENDING",
          attempts: 0,
          nextAttemptAt: Date.now() - 1,
          requiresClerkUserDeletion: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }) as Id<"membershipOffboardingJobs">;
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue("network down"));
      await expect(
        t.action(internal.memberships.processMembershipOffboardingJob, { jobId: thrownDeleteJobId })
      ).resolves.toEqual({ status: "RETRYING" });
      await t.run(async (ctx: any) => {
        const job = await ctx.db.get(thrownDeleteJobId);
        expect(job?.lastError).toMatch(/cleanup failed/i);
      });
    } finally {
      consoleError.mockRestore();
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
    await expect(
      asImpersonator.mutation(api.memberships.transferOwnership, {
        orgId,
        targetMembershipId: targetOwnerMembershipId,
        currentOwnerNewRoleId: salesRoleId,
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

  test("updateRole rejects missing, offboarding, corrupted current-role, invalid new-role, and self owner demotion cases", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, roleId: ownerRoleId, membershipId: ownerMembershipId } = await setupOrg(t, "user_update_edges_owner");
    const salesRoleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
    ) as Id<"roles">;
    const otherMembershipId = await t.run(async (ctx: any) => {
      const otherOrgId = await ctx.db.insert("organizations", { name: "Other Update Role Org", createdAt: Date.now() });
      const otherRoleId = await ctx.db.insert("roles", { orgId: otherOrgId, name: "SALES", permissions: [] });
      const otherUserId = await ctx.db.insert("users", { clerkId: "user_update_edges_other", email: "update-other@test.com" });
      return await ctx.db.insert("memberships", { orgId: otherOrgId, userId: otherUserId, roleId: otherRoleId });
    }) as Id<"memberships">;
    const asOwner = t.withIdentity({ subject: "user_update_edges_owner" });

    await expect(
      asOwner.mutation(api.memberships.updateRole, {
        orgId,
        membershipId: otherMembershipId,
        newRoleId: salesRoleId,
      })
    ).rejects.toThrow(/membership not found/i);

    const memberUserId = await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "user_update_edges_member", email: "update-member@test.com" })
    );
    const memberMembershipId = await t.run((ctx: any) =>
      ctx.db.insert("memberships", {
        orgId,
        userId: memberUserId,
        roleId: salesRoleId,
        offboardingStatus: "PENDING_EXTERNAL_REMOVAL",
      })
    ) as Id<"memberships">;
    await expect(
      asOwner.mutation(api.memberships.updateRole, {
        orgId,
        membershipId: memberMembershipId,
        newRoleId: ownerRoleId,
      })
    ).rejects.toThrow(/removal is already in progress/i);

    const deletedRoleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "DELETED", permissions: [], isDeleted: true })
    ) as Id<"roles">;
    const corruptMembershipId = await t.run((ctx: any) =>
      ctx.db.insert("memberships", { orgId, userId: memberUserId, roleId: deletedRoleId })
    ) as Id<"memberships">;
    await expect(
      asOwner.mutation(api.memberships.updateRole, {
        orgId,
        membershipId: corruptMembershipId,
        newRoleId: salesRoleId,
      })
    ).rejects.toThrow(/role not found or corrupted/i);

    await expect(
      asOwner.mutation(api.memberships.updateRole, {
        orgId,
        membershipId: ownerMembershipId,
        newRoleId: deletedRoleId,
      })
    ).rejects.toThrow(/specified role/i);

    const secondOwnerUserId = await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "user_update_edges_second_owner", email: "second-owner-edge@test.com" })
    );
    await t.run((ctx: any) =>
      ctx.db.insert("memberships", { orgId, userId: secondOwnerUserId, roleId: ownerRoleId })
    );
    await expect(
      asOwner.mutation(api.memberships.updateRole, {
        orgId,
        membershipId: ownerMembershipId,
        newRoleId: salesRoleId,
      })
    ).rejects.toThrow(/cannot change your own owner role/i);
  });

  test("transferOwnership rejects invalid targets and replacement roles", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, roleId: ownerRoleId, membershipId: ownerMembershipId } = await setupOrg(t, "user_transfer_edges_owner");
    const salesRoleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] })
    ) as Id<"roles">;
    const deletedRoleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "DELETED", permissions: [], isDeleted: true })
    ) as Id<"roles">;
    const memberUserId = await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "user_transfer_edges_member", email: "transfer-edge@test.com" })
    );
    const memberMembershipId = await t.run((ctx: any) =>
      ctx.db.insert("memberships", { orgId, userId: memberUserId, roleId: salesRoleId })
    ) as Id<"memberships">;
    const asOwner = t.withIdentity({ subject: "user_transfer_edges_owner" });

    const otherMembershipId = await t.run(async (ctx: any) => {
      const otherOrgId = await ctx.db.insert("organizations", { name: "Other Transfer Org", createdAt: Date.now() });
      const otherRoleId = await ctx.db.insert("roles", { orgId: otherOrgId, name: "SALES", permissions: [] });
      const otherUserId = await ctx.db.insert("users", { clerkId: "user_transfer_other", email: "transfer-other@test.com" });
      return await ctx.db.insert("memberships", { orgId: otherOrgId, userId: otherUserId, roleId: otherRoleId });
    }) as Id<"memberships">;
    await expect(
      asOwner.mutation(api.memberships.transferOwnership, {
        orgId,
        targetMembershipId: otherMembershipId,
        currentOwnerNewRoleId: salesRoleId,
      })
    ).rejects.toThrow(/target membership not found/i);

    await expect(
      asOwner.mutation(api.memberships.transferOwnership, {
        orgId,
        targetMembershipId: ownerMembershipId,
        currentOwnerNewRoleId: salesRoleId,
      })
    ).rejects.toThrow(/choose another member/i);

    await expect(
      asOwner.mutation(api.memberships.transferOwnership, {
        orgId,
        targetMembershipId: memberMembershipId,
        currentOwnerNewRoleId: ownerRoleId,
      })
    ).rejects.toThrow(/replacement role must be a non-owner/i);

    await expect(
      asOwner.mutation(api.memberships.transferOwnership, {
        orgId,
        targetMembershipId: memberMembershipId,
        currentOwnerNewRoleId: deletedRoleId,
      })
    ).rejects.toThrow(/replacement role/i);

    const corruptTargetUserId = await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "user_transfer_corrupt", email: "transfer-corrupt@test.com" })
    );
    const corruptTargetMembershipId = await t.run((ctx: any) =>
      ctx.db.insert("memberships", { orgId, userId: corruptTargetUserId, roleId: deletedRoleId })
    ) as Id<"memberships">;
    await expect(
      asOwner.mutation(api.memberships.transferOwnership, {
        orgId,
        targetMembershipId: corruptTargetMembershipId,
        currentOwnerNewRoleId: salesRoleId,
      })
    ).rejects.toThrow(/target membership role/i);

    await t.run((ctx: any) => ctx.db.patch(memberMembershipId, { offboardingStatus: "PENDING_EXTERNAL_REMOVAL" }));
    await expect(
      asOwner.mutation(api.memberships.transferOwnership, {
        orgId,
        targetMembershipId: memberMembershipId,
        currentOwnerNewRoleId: salesRoleId,
      })
    ).rejects.toThrow(/removal is already in progress/i);

    const secondOwnerUserId = await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "user_transfer_edges_second_owner", email: "transfer-second-owner@test.com" })
    );
    const ownerTargetMembershipId = await t.run((ctx: any) =>
      ctx.db.insert("memberships", { orgId, userId: secondOwnerUserId, roleId: ownerRoleId })
    ) as Id<"memberships">;
    await expect(
      asOwner.mutation(api.memberships.transferOwnership, {
        orgId,
        targetMembershipId: ownerTargetMembershipId,
        currentOwnerNewRoleId: salesRoleId,
      })
    ).rejects.toThrow(/already an owner/i);
  });
});
