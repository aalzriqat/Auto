import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const ADMIN_PERMISSIONS = ["manage:users", "view:users", "manage:roles"];

async function setupOrg(t: any, clerkId: string, ownerRoleName = "OWNER") {
  const orgId = await t.run((ctx: any) =>
    ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx: any) =>
    ctx.db.insert("users", { clerkId, email: `${clerkId}@test.com`, name: "Admin User" })
  );
  const roleId = await t.run((ctx: any) =>
    ctx.db.insert("roles", { orgId, name: ownerRoleName, permissions: ADMIN_PERMISSIONS })
  );
  await t.run((ctx: any) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  return { orgId, userId, roleId };
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
});
