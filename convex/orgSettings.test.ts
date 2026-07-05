import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

async function seedOwner(t: ReturnType<typeof convexTest>) {
  const orgId = await t.run(async (ctx) =>
    ctx.db.insert("organizations", { name: "Test Org", createdAt: Date.now() })
  );
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { clerkId: "owner_001", email: "owner@test.com", name: "Owner" })
  );
  const roleId = await t.run(async (ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "OWNER",
      permissions: ["view:settings", "edit:settings"],
      isSystemOwnerRole: true,
    })
  );
  await t.run(async (ctx) =>
    ctx.db.insert("memberships", { orgId, userId, roleId })
  );
  return { orgId, userId, asOwner: t.withIdentity({ subject: "owner_001" }) };
}

describe("orgSettings", () => {
  test("get returns null when no settings row exists", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    const settings = await asOwner.query(api.orgSettings.get, { orgId });
    expect(settings).toBeNull();
  });

  test("upsert creates settings with defaults", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    await asOwner.mutation(api.orgSettings.upsert, { orgId, currency: "AED", currencySymbol: "د.إ" });
    const settings = await asOwner.query(api.orgSettings.get, { orgId });
    expect(settings?.currency).toBe("AED");
    expect(settings?.currencySymbol).toBe("د.إ");
  });

  test("upsert patches existing settings without overwriting untouched fields", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    await asOwner.mutation(api.orgSettings.upsert, { orgId, currency: "SAR", vatRate: 15 });
    await asOwner.mutation(api.orgSettings.upsert, { orgId, currency: "USD" });
    const settings = await asOwner.query(api.orgSettings.get, { orgId });
    expect(settings?.currency).toBe("USD");
    // vatRate should be unchanged
    expect(settings?.vatRate).toBe(15);
  });

  test("setGeneratedLeadAutoAssignmentEnabled creates and patches the toggle", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);

    await asOwner.mutation(api.orgSettings.setGeneratedLeadAutoAssignmentEnabled, { orgId, enabled: true });
    let settings = await asOwner.query(api.orgSettings.get, { orgId });
    expect(settings?.generatedLeadAutoAssignmentEnabled).toBe(true);

    await asOwner.mutation(api.orgSettings.setGeneratedLeadAutoAssignmentEnabled, { orgId, enabled: false });
    settings = await asOwner.query(api.orgSettings.get, { orgId });
    expect(settings?.generatedLeadAutoAssignmentEnabled).toBe(false);
  });

  test("upsert stores and rejects invalid reservationHoldDays", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);

    await asOwner.mutation(api.orgSettings.upsert, { orgId, reservationHoldDays: 7 });
    const settings = await asOwner.query(api.orgSettings.get, { orgId });
    expect(settings?.reservationHoldDays).toBe(7);

    await expect(
      asOwner.mutation(api.orgSettings.upsert, { orgId, reservationHoldDays: 0 })
    ).rejects.toThrow(/greater than zero/i);
  });

  test("upsert is owner-only", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOwner(t);

    // Seed a non-owner member
    const userId2 = await t.run(async (ctx) =>
      ctx.db.insert("users", { clerkId: "member_002", email: "m@test.com", name: "Member" })
    );
    const memberRoleId = await t.run(async (ctx) =>
      ctx.db.insert("roles", { orgId, name: "SALES", permissions: ["view:settings"] })
    );
    await t.run(async (ctx) =>
      ctx.db.insert("memberships", { orgId, userId: userId2, roleId: memberRoleId })
    );
    const asMember = t.withIdentity({ subject: "member_002" });

    await expect(
      asMember.mutation(api.orgSettings.upsert, { orgId, currency: "EUR" })
    ).rejects.toThrow();
  });
});
