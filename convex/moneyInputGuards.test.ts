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
import { convexTestWithComponents } from "../test-utils/convexTest";
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
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

  test("workOrders.update refuses a NaN task cost on an existing order", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seed(t, "woup");

    const workOrderId = await ids.asOwner.mutation(api.workOrders.create, {
      orgId: ids.orgId,
      vehicleId: ids.vehicleId,
      title: "Brake job",
      status: "OPEN",
      tasks: [{ id: "t1", description: "Pads", partsCost: 40, laborCost: 25, completed: false }],
    });

    await expect(
      ids.asOwner.mutation(api.workOrders.update, {
        orgId: ids.orgId,
        workOrderId,
        title: "Brake job",
        status: "COMPLETED",
        tasks: [{ id: "t1", description: "Pads", partsCost: 40, laborCost: NaN, completed: true }],
      })
    ).rejects.toThrow(/labor cost/i);

    // The order keeps its last good total rather than becoming NaN in place.
    const order: any = await t.run((ctx: any) => ctx.db.get(workOrderId));
    expect(order.totalCost).toBe(65);
    expect(order.status).toBe("OPEN");
  });

  // Pinned to record *which* layer rejects it. `create` runs
  // CreateVehicleSchema, and Zod's `z.number()` already refuses NaN — which is
  // exactly why `createSourced` above needed an explicit guard instead: that
  // path runs no Zod schema at all. If `create` is ever refactored off Zod,
  // this test starts failing rather than the gap reopening silently.
  test("vehicles.create rejects a NaN supplier cost on the SOURCED branch", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seed(t, "vcs");

    await expect(
      ids.asOwner.mutation(api.vehicles.create, {
        orgId: ids.orgId,
        vin: "VNSRCDNAN1234",
        make: "Toyota",
        model: "Corolla",
        year: 2024,
        color: "White",
        fuelType: "Petrol",
        transmission: "Automatic",
        mileage: 0,
        sellingPrice: 21000,
        status: "SOURCING",
        sourceType: "SOURCED",
        sourcedFromName: "العطيوي",
        sourceCost: NaN,
      })
    ).rejects.toThrow(/sourceCost: Expected number, received nan/i);

    const rows = await t.run((ctx: any) =>
      ctx.db.query("vehicles").withIndex("by_org", (q: any) => q.eq("orgId", ids.orgId)).collect()
    );
    expect(rows).toHaveLength(1);
  });

  test("vehicles.upsertLandedCosts refuses a NaN item amount", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seed(t, "lc");

    await expect(
      ids.asOwner.mutation(api.vehicles.upsertLandedCosts, {
        orgId: ids.orgId,
        vehicleId: ids.vehicleId,
        items: [
          { label: "Shipping", amount: 500 },
          { label: "Customs", amount: NaN },
        ],
      })
    ).rejects.toThrow(/landed cost/i);

    // A NaN here would have been written straight onto the vehicle as
    // landedCostTotal, poisoning every cost and profit figure that reads it.
    const rows = await t.run((ctx: any) => ctx.db.query("vehicleLandedCosts").collect());
    expect(rows).toHaveLength(0);
    const vehicle: any = await t.run((ctx: any) => ctx.db.get(ids.vehicleId));
    expect(vehicle.landedCostTotal).toBeUndefined();
  });

  test("vehicles.importBulk validates every row before writing any of them", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seed(t, "imp");

    const row = (vin: string, sellingPrice: number) => ({
      make: "Toyota",
      model: "Corolla",
      year: 2024,
      vin,
      color: "White",
      fuelType: "Petrol",
      transmission: "Automatic",
      sellingPrice,
    });

    await expect(
      ids.asOwner.mutation(api.vehicles.importBulk, {
        orgId: ids.orgId,
        // The good row comes first deliberately: a per-row guard would have
        // committed it before reaching the bad one, leaving a half-done import.
        vehicles: [row("VINBULKGOOD11", 20000), row("VINBULKBAD112", NaN)],
      })
    ).rejects.toThrow(/selling price/i);

    const rows: any[] = await t.run((ctx: any) =>
      ctx.db.query("vehicles").withIndex("by_org", (q: any) => q.eq("orgId", ids.orgId)).collect()
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].vin).toBe(`VIN-NAN-imp`);
  });

  test("sales.setCommissionAmount refuses a NaN amount that Math.max would pass through", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seed(t, "comm");

    const saleId = await t.run(async (ctx: any) =>
      ctx.db.insert("sales", {
        orgId: ids.orgId,
        vehicleId: ids.vehicleId,
        customerId: ids.customerId,
        salespersonId: ids.userId,
        salePrice: 20000,
        saleDate: Date.now(),
        status: "PENDING",
      })
    );

    await expect(
      ids.asOwner.mutation(api.sales.setCommissionAmount, {
        orgId: ids.orgId,
        saleId,
        commissionAmount: NaN,
      })
    ).rejects.toThrow(/commission/i);

    // `v.number()` accepts Infinity as readily as NaN, and it passes every
    // `> 0` guard downstream instead of failing them — a commission of
    // Infinity would sweep into payroll and overflow the payslip total.
    await expect(
      ids.asOwner.mutation(api.sales.setCommissionAmount, {
        orgId: ids.orgId,
        saleId,
        commissionAmount: Infinity,
      })
    ).rejects.toThrow(/commission/i);

    // `Math.max(0, NaN)` is NaN, so the clamp that looks like a floor is not one.
    const sale: any = await t.run((ctx: any) => ctx.db.get(saleId));
    expect(sale.commissionAmount).toBeUndefined();
  });
});
