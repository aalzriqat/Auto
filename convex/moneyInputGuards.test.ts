/**
 * NaN rejection at every caller-supplied money entry point.
 *
 * Convex accepts NaN as a legitimate `v.number()`, and **every** comparison
 * against NaN is false — so `x <= 0`, `x > max` and `x === 0` all let it
 * through. The audit found five entry points validated only by such a
 * comparison. What makes it worse than a bad input is that NaN is *sticky*:
 * once stored it fails every downstream guard too, so the record is neither
 * processed nor reported as outstanding. It just sits there, wrong.
 *
 * Each case drives the real mutation and asserts nothing was written.
 */
import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { ALL_PERMISSIONS } from "./utils/permissions";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

async function seed(t: any, suffix: string) {
  const ids = await t.run(async (ctx: any) => {
    const orgId = await ctx.db.insert("organizations", { name: `NaN ${suffix}`, createdAt: Date.now() });
    const userId = await ctx.db.insert("users", {
      clerkId: `nan_${suffix}`,
      email: `${suffix}@nan.example.com`,
      name: "Owner",
    });
    const roleId = await ctx.db.insert("roles", {
      orgId,
      name: "OWNER",
      permissions: ALL_PERMISSIONS,
      isSystemOwnerRole: true,
    });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
    await ctx.db.insert("orgSettings", {
      orgId,
      currency: "JOD",
      currencySymbol: "JD",
      enabledPaymentTypes: ["CASH"],
    });
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId,
      vin: `VIN-NAN-${suffix}`,
      make: "Kia",
      model: "Sportage",
      year: 2024,
      color: "Blue",
      fuelType: "Petrol",
      transmission: "Automatic",
      mileage: 10,
      sellingPrice: 20000,
      status: "AVAILABLE",
    });
    const customerId = await ctx.db.insert("customers", {
      orgId,
      firstName: "Sam",
      lastName: "Buyer",
      email: `${suffix}-buyer@nan.example.com`,
    });
    return { orgId, userId, vehicleId, customerId };
  });
  return { ...ids, asOwner: t.withIdentity({ subject: `nan_${suffix}` }) };
}

describe("money entry points reject NaN", () => {
  test("paymentIntents.create refuses a NaN amount", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const ids = await seed(t, "pi");

    await expect(
      ids.asOwner.mutation(api.paymentIntents.create, {
        orgId: ids.orgId,
        customerId: ids.customerId,
        provider: "stripe",
        amountMinor: NaN,
        currency: "JOD",
      })
    ).rejects.toThrow(/invalid minor-unit/i);

    const rows = await t.run((ctx: any) => ctx.db.query("paymentIntents").collect());
    expect(rows).toHaveLength(0);
  });

  test("vehicles.createSourced refuses a NaN supplier cost", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const ids = await seed(t, "veh");

    await expect(
      ids.asOwner.mutation(api.vehicles.createSourced, {
        orgId: ids.orgId,
        sourcedFromName: "العطيوي",
        sourceCost: NaN,
        make: "Toyota",
        model: "Corolla",
        color: "White",
        year: 2024,
        mileage: 0,
        fuelType: "Petrol",
        transmission: "Automatic",
        sellingPrice: 21000,
      })
    ).rejects.toThrow(/supplier cost/i);

    // Only the seeded vehicle — nothing sourced was written.
    const rows = await t.run((ctx: any) =>
      ctx.db.query("vehicles").withIndex("by_org", (q: any) => q.eq("orgId", ids.orgId)).collect()
    );
    expect(rows).toHaveLength(1);
  });

  test("workOrders.create refuses a NaN task cost instead of silently dropping the GL posting", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const ids = await seed(t, "wo");

    await expect(
      ids.asOwner.mutation(api.workOrders.create, {
        orgId: ids.orgId,
        vehicleId: ids.vehicleId,
        title: "Brake job",
        status: "COMPLETED",
        tasks: [
          { id: "t1", description: "Pads", partsCost: NaN, laborCost: 25, completed: true },
        ],
      })
    ).rejects.toThrow(/parts cost/i);

    const orders = await t.run((ctx: any) => ctx.db.query("workOrders").collect());
    expect(orders).toHaveLength(0);
    // The real damage pre-fix: the order persisted with no expense behind it.
    const expenses = await t.run((ctx: any) => ctx.db.query("expenses").collect());
    expect(expenses).toHaveLength(0);
  });
});
