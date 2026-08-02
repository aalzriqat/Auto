import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.*s");

async function seedVehicle(
  t: ReturnType<typeof convexTestWithComponents>,
  orgId: Id<"organizations">,
  status: string,
  n: number,
) {
  return await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      make: "Toyota",
      model: `Corolla ${n}`,
      year: 2020,
      vin: `RECONCILE${String(n).padStart(8, "0")}`,
      mileage: 1000,
      color: "White",
      fuelType: "PETROL",
      transmission: "AUTOMATIC",
      sellingPrice: 10000,
      status: status as "AVAILABLE",
    })
  );
}

describe("reconcileVehicleHolds", () => {
  test("releases RESERVED vehicles that nothing actually holds, and leaves SOLD alone", async () => {
    // The state the financial reset leaves behind: reservations and deposits
    // deleted, vehicles still claiming to be held by them.
    const t = convexTestWithComponents(schema, MODULES);
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Reconcile Motors", createdAt: Date.now() })
    );

    const stuck = await seedVehicle(t, orgId, "RESERVED", 1);
    const sold = await seedVehicle(t, orgId, "SOLD", 2);
    const archived = await seedVehicle(t, orgId, "ARCHIVED", 3);
    const sourcing = await seedVehicle(t, orgId, "SOURCING", 4);
    const available = await seedVehicle(t, orgId, "AVAILABLE", 5);

    const dry = await t.mutation(internal.migrations.reconcileVehicleHolds, { orgId });
    expect(dry.dryRun).toBe(true);
    expect(dry.released).toEqual([
      { vehicleId: stuck, from: "RESERVED", to: "AVAILABLE" },
    ]);
    // Dry run changed nothing.
    expect(await t.run((ctx) => ctx.db.get(stuck))).toMatchObject({ status: "RESERVED" });

    await t.mutation(internal.migrations.reconcileVehicleHolds, { orgId, dryRun: false });

    expect(await t.run((ctx) => ctx.db.get(stuck))).toMatchObject({ status: "AVAILABLE" });
    // A sold car is not "unheld" — re-listing it because its sale row was
    // deleted would be worse than the inconsistency being fixed.
    expect(await t.run((ctx) => ctx.db.get(sold))).toMatchObject({ status: "SOLD" });
    expect(await t.run((ctx) => ctx.db.get(archived))).toMatchObject({ status: "ARCHIVED" });
    // Mid-workflow states are not hold states and must not be touched.
    expect(await t.run((ctx) => ctx.db.get(sourcing))).toMatchObject({ status: "SOURCING" });
    expect(await t.run((ctx) => ctx.db.get(available))).toMatchObject({ status: "AVAILABLE" });
  });

  test("leaves a RESERVED vehicle alone while a real deposit hold exists", async () => {
    // The guard that makes this safe to run on a live org: it re-derives from
    // the holds that exist rather than clearing anything that looks stuck.
    const t = convexTestWithComponents(schema, MODULES);
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Held Motors", createdAt: Date.now() })
    );
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Real", lastName: "Buyer" })
    );
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "held_u", email: "held@example.com", name: "Held" })
    );
    const held = await seedVehicle(t, orgId, "RESERVED", 1);

    await t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId,
        customerId,
        vehicleId: held,
        amount: 500,
        status: "HELD" as const,
        holdActive: true,
        createdBy: userId,
        createdAt: Date.now(),
      })
    );

    const dry = await t.mutation(internal.migrations.reconcileVehicleHolds, { orgId });
    expect(dry.released).toEqual([]);

    await t.mutation(internal.migrations.reconcileVehicleHolds, { orgId, dryRun: false });
    expect(await t.run((ctx) => ctx.db.get(held))).toMatchObject({ status: "RESERVED" });
  });

  test("never touches another organization's vehicles", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const target = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Target", createdAt: Date.now() })
    );
    const bystander = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Bystander", createdAt: Date.now() })
    );
    const mine = await seedVehicle(t, target, "RESERVED", 1);
    const theirs = await seedVehicle(t, bystander, "RESERVED", 2);

    await t.mutation(internal.migrations.reconcileVehicleHolds, { orgId: target, dryRun: false });

    expect(await t.run((ctx) => ctx.db.get(mine))).toMatchObject({ status: "AVAILABLE" });
    expect(await t.run((ctx) => ctx.db.get(theirs))).toMatchObject({ status: "RESERVED" });
  });
});
