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
    ctx.db.insert("users", { clerkId: "owner_ls_001", email: "owner@test.com", name: "Owner" })
  );
  const roleId = await t.run(async (ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "OWNER",
      permissions: ["view:settings"],
      isSystemOwnerRole: true,
    })
  );
  await t.run(async (ctx) =>
    ctx.db.insert("memberships", { orgId, userId, roleId })
  );
  return { orgId, asOwner: t.withIdentity({ subject: "owner_ls_001" }) };
}

describe("orgLeadSources", () => {
  test("list returns empty array before seeding", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    const sources = await asOwner.query(api.orgLeadSources.list, { orgId });
    expect(sources).toHaveLength(0);
  });

  test("seed inserts default lead sources ordered by index", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    await asOwner.mutation(api.orgLeadSources.seed, { orgId });
    const sources = await asOwner.query(api.orgLeadSources.list, { orgId });
    expect(sources.length).toBeGreaterThan(0);
    expect(sources[0].order).toBe(0);
    expect(sources[0].label).toBe("Walk-in");
  });

  test("seed is idempotent — calling twice does not duplicate", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    await asOwner.mutation(api.orgLeadSources.seed, { orgId });
    await asOwner.mutation(api.orgLeadSources.seed, { orgId });
    const sources = await asOwner.query(api.orgLeadSources.list, { orgId });
    const labels = sources.map((s) => s.label);
    expect(new Set(labels).size).toBe(labels.length); // no duplicates
  });

  test("create appends a new lead source with incremented order", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    await asOwner.mutation(api.orgLeadSources.seed, { orgId });
    const beforeCount = (await asOwner.query(api.orgLeadSources.list, { orgId })).length;
    await asOwner.mutation(api.orgLeadSources.create, { orgId, label: "TikTok" });
    const sources = await asOwner.query(api.orgLeadSources.list, { orgId });
    expect(sources).toHaveLength(beforeCount + 1);
    expect(sources[sources.length - 1].label).toBe("TikTok");
  });

  test("update changes label and isActive", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    const sourceId = await asOwner.mutation(api.orgLeadSources.create, { orgId, label: "Old" });
    await asOwner.mutation(api.orgLeadSources.update, {
      orgId,
      sourceId,
      label: "New",
      isActive: false,
    });
    const sources = await asOwner.query(api.orgLeadSources.list, { orgId });
    const updated = sources.find((s) => s._id === sourceId);
    expect(updated?.label).toBe("New");
    expect(updated?.isActive).toBe(false);
  });

  test("update only touches the fields provided (order alone)", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    const sourceId = await asOwner.mutation(api.orgLeadSources.create, { orgId, label: "Kept" });
    await asOwner.mutation(api.orgLeadSources.update, { orgId, sourceId, order: 5 });
    const sources = await asOwner.query(api.orgLeadSources.list, { orgId });
    const updated = sources.find((s) => s._id === sourceId);
    expect(updated?.label).toBe("Kept");
    expect(updated?.isActive).toBe(true);
    expect(updated?.order).toBe(5);
  });

  test("update throws if the lead source no longer exists", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    const sourceId = await asOwner.mutation(api.orgLeadSources.create, { orgId, label: "Gone" });
    await t.run((ctx) => ctx.db.delete(sourceId));

    await expect(
      asOwner.mutation(api.orgLeadSources.update, { orgId, sourceId, label: "Hijacked" })
    ).rejects.toThrow(/not found/i);
  });

  test("remove deletes the lead source", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    const sourceId = await asOwner.mutation(api.orgLeadSources.create, { orgId, label: "ToRemove" });
    await asOwner.mutation(api.orgLeadSources.remove, { orgId, sourceId });
    const sources = await asOwner.query(api.orgLeadSources.list, { orgId });
    expect(sources.find((s) => s._id === sourceId)).toBeUndefined();
  });

  test("remove throws if the lead source no longer exists", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    const sourceId = await asOwner.mutation(api.orgLeadSources.create, { orgId, label: "Gone" });
    await t.run((ctx) => ctx.db.delete(sourceId));

    await expect(
      asOwner.mutation(api.orgLeadSources.remove, { orgId, sourceId })
    ).rejects.toThrow(/not found/i);
  });

  test("reorder reassigns order values", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    const id1 = await asOwner.mutation(api.orgLeadSources.create, { orgId, label: "First" });
    const id2 = await asOwner.mutation(api.orgLeadSources.create, { orgId, label: "Second" });
    // Reverse the order
    await asOwner.mutation(api.orgLeadSources.reorder, { orgId, orderedIds: [id2, id1] });
    const sources = await asOwner.query(api.orgLeadSources.list, { orgId });
    expect(sources[0]._id).toBe(id2);
    expect(sources[1]._id).toBe(id1);
  });

  test("reorder throws if one of the ids no longer exists", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    const id1 = await asOwner.mutation(api.orgLeadSources.create, { orgId, label: "First" });
    await t.run((ctx) => ctx.db.delete(id1));

    await expect(
      asOwner.mutation(api.orgLeadSources.reorder, { orgId, orderedIds: [id1] })
    ).rejects.toThrow(/not found/i);
  });
});
