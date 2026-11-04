import { describe, expect, test } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { supplierIdFor } from "../test-utils/supplierFixture";
import { api } from "./_generated/api";
import schema from "./schema";

async function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const { orgId, userId } = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "Synthetic dealer", createdAt: Date.now() });
    const userId = await ctx.db.insert("users", { clerkId: "scrum907", email: "907@example.test", name: "Test" });
    const roleId = await ctx.db.insert("roles", {
      orgId, name: "ADMIN", permissions: ["create:vehicles", "edit:vehicles", "view:cost_price", "view:vehicles"],
    });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
    await ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    });
    return { orgId, userId };
  });
  const asUser = t.withIdentity({ subject: "scrum907" });
  const sourcedSupplierId = await supplierIdFor(t, orgId, "Synthetic supplier");
  const vehicleId = await asUser.mutation(api.vehicles.create, {
    orgId, idempotencyKey: crypto.randomUUID(), vin: "1HGCM82633A009070", make: "Honda", model: "Accord",
    year: 2020, mileage: 10000, color: "White", fuelType: "Gasoline", transmission: "Automatic",
    status: "AVAILABLE", sellingPrice: 12000, sourceType: "SOURCED", sourceCost: 10250, sourcedSupplierId,
  });
  return { t, orgId, userId, vehicleId, asUser };
}

describe("SCRUM-907 sourced cost mirror", () => {
  test("updating supplier cost mirrors purchasePrice and the approved edit audit", async () => {
    const { t, orgId, vehicleId, asUser } = await setup();
    await asUser.mutation(api.vehicles.update, { orgId, vehicleId, sourceCost: 9900 });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(vehicleId)).toMatchObject({ sourceCost: 9900, purchasePrice: 9900 });
      const edits = await ctx.db.query("vehicleEdits").withIndex("by_org", q => q.eq("orgId", orgId)).collect();
      expect(edits.find(edit => edit.type === "UPDATE")?.payload).toMatchObject({ sourceCost: 9900, purchasePrice: 9900 });
    });
  });
  test("an old pending supplier-cost request applies and audits the mirror at approval", async () => {
    const { t, orgId, vehicleId, userId, asUser } = await setup();
    const requestId = await t.run(ctx => ctx.db.insert("vehicleEdits", {
      orgId, vehicleId, requestedBy: userId, type: "UPDATE", payload: { sourceCost: 9900 }, status: "PENDING", createdAt: Date.now(),
    }));
    await asUser.mutation(api.vehicleEdits.resolve, { orgId, requestId, status: "APPROVED" });
    await t.run(async ctx => {
      expect(await ctx.db.get(vehicleId)).toMatchObject({ sourceCost: 9900, purchasePrice: 9900 });
      expect((await ctx.db.get(requestId))?.payload).toMatchObject({ sourceCost: 9900, purchasePrice: 9900 });
    });
  });

  test("posted acquisition still locks supplier cost and the mirror", async () => {
    const fixture = await setup();
    await seedAcquisition(fixture);
    await expect(fixture.asUser.mutation(api.vehicles.update, {
      orgId: fixture.orgId, vehicleId: fixture.vehicleId, sourceCost: 9900,
    })).rejects.toThrow(/VEHICLE_COST_POSTED/);
    expect(await fixture.t.run(ctx => ctx.db.get(fixture.vehicleId))).toMatchObject({ sourceCost: 10250, purchasePrice: 10250 });
  });

});

async function seedAcquisition({ t, orgId, userId, vehicleId }: Awaited<ReturnType<typeof setup>>) {
  await t.run(ctx => ctx.db.insert("accountingEvents", {
    orgId, eventType: "VEHICLE_ACQUIRED", sourceType: "vehicles", sourceId: vehicleId,
    eventVersion: 1, idempotencyKey: `vehicle_acquired_${vehicleId}`, occurredAt: Date.now(), accountingDate: Date.now(),
    currency: "JOD", payload: {}, status: "POSTED", createdBy: userId, createdAt: Date.now(),
  }));
}
