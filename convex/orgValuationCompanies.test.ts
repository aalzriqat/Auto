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
    ctx.db.insert("users", { clerkId: "owner_vc_001", email: "owner@test.com", name: "Owner" })
  );
  const roleId = await t.run(async (ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ["view:settings"] })
  );
  await t.run(async (ctx) =>
    ctx.db.insert("memberships", { orgId, userId, roleId })
  );
  return { orgId, asOwner: t.withIdentity({ subject: "owner_vc_001" }) };
}

describe("orgValuationCompanies", () => {
  test("list returns empty before seeding", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    const companies = await asOwner.query(api.orgValuationCompanies.list, { orgId });
    expect(companies).toHaveLength(0);
  });

  test("seed inserts default companies", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    await asOwner.mutation(api.orgValuationCompanies.seed, { orgId });
    const companies = await asOwner.query(api.orgValuationCompanies.list, { orgId });
    expect(companies.length).toBeGreaterThan(0);
    expect(companies[0].order).toBe(0);
  });

  test("seed is idempotent", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    await asOwner.mutation(api.orgValuationCompanies.seed, { orgId });
    const countBefore = (await asOwner.query(api.orgValuationCompanies.list, { orgId })).length;
    await asOwner.mutation(api.orgValuationCompanies.seed, { orgId });
    const countAfter = (await asOwner.query(api.orgValuationCompanies.list, { orgId })).length;
    expect(countAfter).toBe(countBefore);
  });

  test("create appends a new company", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    const id = await asOwner.mutation(api.orgValuationCompanies.create, { orgId, name: "AcmeCars" });
    expect(id).toBeDefined();
    const companies = await asOwner.query(api.orgValuationCompanies.list, { orgId });
    expect(companies.some((c) => c.name === "AcmeCars")).toBe(true);
  });

  test("update changes name and isActive", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    const companyId = await asOwner.mutation(api.orgValuationCompanies.create, {
      orgId,
      name: "OldName",
    });
    await asOwner.mutation(api.orgValuationCompanies.update, {
      orgId,
      companyId,
      name: "NewName",
      isActive: false,
    });
    const companies = await asOwner.query(api.orgValuationCompanies.list, { orgId });
    const updated = companies.find((c) => c._id === companyId);
    expect(updated?.name).toBe("NewName");
    expect(updated?.isActive).toBe(false);
  });

  test("remove deletes the company", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    const companyId = await asOwner.mutation(api.orgValuationCompanies.create, {
      orgId,
      name: "ToDelete",
    });
    await asOwner.mutation(api.orgValuationCompanies.remove, { orgId, companyId });
    const companies = await asOwner.query(api.orgValuationCompanies.list, { orgId });
    expect(companies.find((c) => c._id === companyId)).toBeUndefined();
  });

  test("remove throws for wrong orgId", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    const companyId = await asOwner.mutation(api.orgValuationCompanies.create, {
      orgId,
      name: "Mine",
    });

    // Create a second org — owner tries to delete company belonging to first org
    const orgId2 = await t.run(async (ctx) =>
      ctx.db.insert("organizations", { name: "Org2", createdAt: Date.now() })
    );
    const userId2 = await t.run(async (ctx) =>
      ctx.db.insert("users", { clerkId: "owner_vc_002", email: "o2@test.com", name: "O2" })
    );
    const roleId2 = await t.run(async (ctx) =>
      ctx.db.insert("roles", { orgId: orgId2, name: "OWNER", permissions: [] })
    );
    await t.run(async (ctx) =>
      ctx.db.insert("memberships", { orgId: orgId2, userId: userId2, roleId: roleId2 })
    );
    const asOwner2 = t.withIdentity({ subject: "owner_vc_002" });

    await expect(
      asOwner2.mutation(api.orgValuationCompanies.remove, { orgId: orgId2, companyId })
    ).rejects.toThrow("Valuation company not found.");
  });
});
