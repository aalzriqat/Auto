import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { ALL_PERMISSIONS } from "./utils/permissions";

type TestConvex = ReturnType<typeof convexTest>;
type PaidPlan = "starter" | "professional" | "enterprise";

async function seedOwnerOrg(
  t: TestConvex,
  options: { plan?: PaidPlan; currentPeriodEnd?: number } = {}
) {
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Gate Test Dealer", createdAt: Date.now() })
  ) as Id<"organizations">;

  if (options.plan) {
    await t.run((ctx) =>
      ctx.db.insert("subscriptions", {
        orgId,
        plan: options.plan,
        status: "active",
        currentPeriodEnd: options.currentPeriodEnd,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
  }

  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: "gate_owner",
      email: "gate-owner@example.com",
      name: "Gate Owner",
    })
  ) as Id<"users">;
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "OWNER",
      permissions: ALL_PERMISSIONS,
      isSystemOwnerRole: true,
    })
  ) as Id<"roles">;
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));

  return {
    orgId,
    asOwner: t.withIdentity({ subject: "gate_owner", clerkId: "gate_owner" }),
  };
}

describe("subscription feature gates", () => {
  test("free orgs are blocked from paid direct API surfaces", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwnerOrg(t);

    await expect(asOwner.mutation(api.chartOfAccounts.initialize, { orgId }))
      .rejects.toThrow(/accounting/i);
    await expect(asOwner.mutation(api.websites.startSetup, { orgId }))
      .rejects.toThrow(/website builder/i);
    await expect(
      asOwner.mutation(api.roles.create, {
        orgId,
        name: "Finance Manager",
        permissions: ["view:finance"],
      })
    ).rejects.toThrow(/custom roles/i);
    await expect(
      asOwner.mutation(api.branches.add, {
        orgId,
        name: "Second Showroom",
        isActive: true,
      })
    ).rejects.toThrow(/multi-branch/i);
    await expect(
      asOwner.query(api.socialInbox.listConversations, {
        orgId,
        paginationOpts: { numItems: 10, cursor: null },
      })
    ).rejects.toThrow(/social inbox/i);
    await expect(
      asOwner.mutation(api.notificationPreferences.setPreference, {
        orgId,
        category: "sales",
        emailEnabled: true,
        whatsappEnabled: true,
        pushEnabled: false,
      })
    ).rejects.toThrow(/whatsapp/i);
  });

  test("expired subscriptions fall back to free-plan access", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwnerOrg(t, {
      plan: "professional",
      currentPeriodEnd: Date.now() - 60_000,
    });

    await expect(asOwner.mutation(api.chartOfAccounts.initialize, { orgId }))
      .rejects.toThrow(/accounting/i);
  });

  test("professional plans allow professional gates but not enterprise gates", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwnerOrg(t, { plan: "professional" });

    await expect(asOwner.mutation(api.chartOfAccounts.initialize, { orgId })).resolves.toBe(true);
    await expect(
      asOwner.mutation(api.roles.create, {
        orgId,
        name: "Sales Lead",
        permissions: ["view:leads", "edit:leads"],
      })
    ).resolves.toBeDefined();
    await expect(
      asOwner.mutation(api.notificationPreferences.setPreference, {
        orgId,
        category: "sales",
        emailEnabled: true,
        whatsappEnabled: true,
        pushEnabled: false,
      })
    ).resolves.toBeNull();
    await expect(
      asOwner.query(api.socialInbox.listConversations, {
        orgId,
        paginationOpts: { numItems: 10, cursor: null },
      })
    ).resolves.toMatchObject({ page: [] });

    await expect(asOwner.mutation(api.websites.startSetup, { orgId }))
      .rejects.toThrow(/website builder/i);
    await expect(
      asOwner.mutation(api.branches.add, {
        orgId,
        name: "Second Showroom",
        isActive: true,
      })
    ).rejects.toThrow(/multi-branch/i);
  });

  test("enterprise plans allow enterprise-only gates", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwnerOrg(t, { plan: "enterprise" });

    await expect(asOwner.mutation(api.websites.startSetup, { orgId })).resolves.toBeDefined();
    await expect(
      asOwner.mutation(api.branches.add, {
        orgId,
        name: "Second Showroom",
        isActive: true,
      })
    ).resolves.toBeNull();

    const branches = await asOwner.query(api.branches.list, { orgId });
    expect(branches).toHaveLength(1);
    expect(branches[0].name).toBe("Second Showroom");
  });
});
