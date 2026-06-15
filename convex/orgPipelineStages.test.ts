import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { DEFAULT_STAGES } from "./orgPipelineStages";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
}));

async function seedOwner(t: ReturnType<typeof convexTest>) {
  const orgId = await t.run(async (ctx) =>
    ctx.db.insert("organizations", { name: "Test Org", createdAt: Date.now() })
  );
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { clerkId: "owner_ps_001", email: "owner@test.com", name: "Owner" })
  );
  const roleId = await t.run(async (ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: [] })
  );
  await t.run(async (ctx) =>
    ctx.db.insert("memberships", { orgId, userId, roleId })
  );
  return { orgId, asOwner: t.withIdentity({ subject: "owner_ps_001" }) };
}

describe("orgPipelineStages", () => {
  test("list returns empty before seeding", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    const stages = await asOwner.query(api.orgPipelineStages.list, { orgId });
    expect(stages).toHaveLength(0);
  });

  test("seed inserts all default stages", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    await asOwner.mutation(api.orgPipelineStages.seed, { orgId });
    const stages = await asOwner.query(api.orgPipelineStages.list, { orgId });
    expect(stages).toHaveLength(DEFAULT_STAGES.length);
    expect(stages[0].stageKey).toBe("NEW");
    expect(stages[stages.length - 1].stageKey).toBe("LOST");
  });

  test("seed is idempotent — running twice keeps the same count", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    await asOwner.mutation(api.orgPipelineStages.seed, { orgId });
    await asOwner.mutation(api.orgPipelineStages.seed, { orgId });
    const stages = await asOwner.query(api.orgPipelineStages.list, { orgId });
    expect(stages).toHaveLength(DEFAULT_STAGES.length);
  });

  test("update changes label and color", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    await asOwner.mutation(api.orgPipelineStages.seed, { orgId });
    const stages = await asOwner.query(api.orgPipelineStages.list, { orgId });
    const first = stages[0];
    await asOwner.mutation(api.orgPipelineStages.update, {
      orgId,
      stageId: first._id,
      label: "Enquiry",
      color: "#ff0000",
    });
    const updated = await asOwner.query(api.orgPipelineStages.list, { orgId });
    expect(updated[0].label).toBe("Enquiry");
    expect(updated[0].color).toBe("#ff0000");
  });

  test("reorder reassigns order values", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    await asOwner.mutation(api.orgPipelineStages.seed, { orgId });
    const stages = await asOwner.query(api.orgPipelineStages.list, { orgId });
    // Reverse all
    const reversed = [...stages].map((s) => s._id).reverse();
    await asOwner.mutation(api.orgPipelineStages.reorder, { orgId, orderedIds: reversed });
    const reordered = await asOwner.query(api.orgPipelineStages.list, { orgId });
    expect(reordered[0]._id).toBe(reversed[0]);
  });
});
