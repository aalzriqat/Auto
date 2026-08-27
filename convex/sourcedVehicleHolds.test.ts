import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }), check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const PERMISSIONS = [
  "create:sales",
  "edit:sales",
  "view:sales",
  "edit:vehicles",
  "view:vehicles",
  "view:reports",
  "approve:requests",
  "manage:finance",
  "view:finance",
];

async function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Sourcing Dealer", createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_src_1", email: "src@test.com", name: "Sourcing User" })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_src_appr", email: "appr@test.com", name: "Approver" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Admin", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));
  const asUser = t.withIdentity({ subject: "user_src_1", clerkId: "user_src_1" });
  const asApprover = t.withIdentity({ subject: "user_src_appr", clerkId: "user_src_appr" });

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Sami", lastName: "Odeh" })
  );

  return { t, orgId, userId, approverId, customerId, asUser, asApprover };
}

/**
 * Reads a vehicle back with a concrete type. `t.run` with an `any`-typed ctx
 * infers `unknown`, which plain `tsc --noEmit` tolerates but the stricter
 * typecheck Convex runs does not.
 */
async function getVehicle(t: any, vehicleId: any): Promise<Doc<"vehicles">> {
  return (await t.run((ctx: any) => ctx.db.get(vehicleId))) as Doc<"vehicles">;
}

async function makeSourcedVehicle(t: any, orgId: any, overrides: Record<string, unknown> = {}) {
  return await t.run((ctx: any) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: "SOURCING-TEST-1",
      make: "BYD",
      model: "Dolphyn",
      year: 2022,
      color: "White",
      fuelType: "Electric",
      transmission: "Automatic",
      mileage: 10,
      sellingPrice: 15000,
      status: "SOURCING",
      sourceType: "SOURCED",
      sourcedFromName: "Al-Zriqat Motors",
      sourceCost: 12800,
      ...overrides,
    })
  );
}

async function makeOwnedVehicle(t: any, orgId: any, overrides: Record<string, unknown> = {}) {
  return await t.run((ctx: any) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: "OWNED-TEST-1",
      make: "Toyota",
      model: "Corolla",
      year: 2021,
      color: "Silver",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 30000,
      sellingPrice: 14000,
      purchasePrice: 11000,
      status: "AVAILABLE",
      sourceType: "STOCK",
      ...overrides,
    })
  );
}

describe("deposit hold on a sourced vehicle", () => {
  test("recording a deposit on a SOURCING vehicle reserves it", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const vehicleId = await makeSourcedVehicle(t, orgId);

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 15000,
      downPayment: 1000,
      termMonths: 0,
    });

    await asUser.mutation(api.deposits.create, {
      orgId,
      quoteId,
      amount: 500,
      method: "CASH",
    });

    const vehicle = await getVehicle(t, vehicleId);
    // Before the fix this stayed "SOURCING" while the deposit was written with
    // holdActive: true — a hold that existed in the database and nowhere on
    // the vehicle.
    expect(vehicle.status).toBe("RESERVED");
    expect(vehicle.preHoldStatus).toBe("SOURCING");
  });

  test("releasing the deposit returns a sourced vehicle to SOURCING, not AVAILABLE", async () => {
    const { t, orgId, customerId, asUser, asApprover } = await setup();
    const vehicleId = await makeSourcedVehicle(t, orgId);

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 15000,
      downPayment: 1000,
      termMonths: 0,
    });
    const depositId = await asUser.mutation(api.deposits.create, {
      orgId,
      quoteId,
      amount: 500,
      method: "CASH",
    });

    await asApprover.mutation(api.deposits.release, {
      orgId,
      depositId,
      resolution: "REFUNDED",
      refundMethod: "CASH",
    });

    const vehicle = await getVehicle(t, vehicleId);
    // A blanket fallback to AVAILABLE would present a car the dealership does
    // not own as owned stock on the lot.
    expect(vehicle.status).toBe("SOURCING");
    expect(vehicle.preHoldStatus).toBeUndefined();
  });

  test("an owned vehicle still returns to AVAILABLE after its deposit is released", async () => {
    const { t, orgId, customerId, asUser, asApprover } = await setup();
    const vehicleId = await makeOwnedVehicle(t, orgId);

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 14000,
      downPayment: 1000,
      termMonths: 0,
    });
    const depositId = await asUser.mutation(api.deposits.create, {
      orgId,
      quoteId,
      amount: 500,
      method: "CASH",
    });
    expect((await getVehicle(t, vehicleId)).status).toBe("RESERVED");

    await asApprover.mutation(api.deposits.release, {
      orgId,
      depositId,
      resolution: "REFUNDED",
      refundMethod: "CASH",
    });

    expect((await getVehicle(t, vehicleId)).status).toBe("AVAILABLE");
  });
});

describe("createReservation on a sourced vehicle", () => {
  test("a SOURCING vehicle can be reserved", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const vehicleId = await makeSourcedVehicle(t, orgId);

    await asUser.mutation(api.vehicles.createReservation, {
      orgId,
      vehicleId,
      customerId,
    });

    const vehicle = await getVehicle(t, vehicleId);
    expect(vehicle.status).toBe("RESERVED");
    expect(vehicle.preHoldStatus).toBe("SOURCING");
  });

  test("a SOURCING vehicle that already carries a deposit hold can still be reserved", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const vehicleId = await makeSourcedVehicle(t, orgId);

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 15000,
      downPayment: 1000,
      termMonths: 0,
    });
    await asUser.mutation(api.deposits.create, { orgId, quoteId, amount: 500, method: "CASH" });

    // createReservation calls syncVehicleHoldStatus *before* it checks the
    // status, so the deposit hold promotes the car to RESERVED first. Rejecting
    // RESERVED threw and rolled the promotion back with it, leaving the vehicle
    // exactly as it started — the case this flow exists for could never pass.
    // SCRUM-195: this reservation belongs to the deal whose deposit is already
    // holding the car, and it says so by NAMING that deal. Reserving a car your
    // own customer's deposit holds is ordinary work; reserving one somebody
    // else's deal holds is not, and only explicit proof separates them.
    await asUser.mutation(api.vehicles.createReservation, {
      orgId,
      vehicleId,
      customerId,
      dealQuoteId: quoteId,
    });

    const vehicle = await getVehicle(t, vehicleId);
    expect(vehicle.status).toBe("RESERVED");
  });

  test("another customer's deposit hold still blocks a reservation", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const vehicleId = await makeSourcedVehicle(t, orgId);
    const otherCustomerId = (await t.run((ctx: any) =>
      ctx.db.insert("customers", { orgId, firstName: "Rania", lastName: "Haddad" })
    )) as Id<"customers">;

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 15000,
      downPayment: 1000,
      termMonths: 0,
    });
    await asUser.mutation(api.deposits.create, { orgId, quoteId, amount: 500, method: "CASH" });

    await expect(
      asUser.mutation(api.vehicles.createReservation, {
        orgId,
        vehicleId,
        customerId: otherCustomerId,
      })
    ).rejects.toThrow(/another customer's deposit/i);
  });
});

describe("multi-vehicle deposits hold their secondary vehicles too", () => {
  test("a secondary vehicle cannot be reserved out from under the holding customer", async () => {
    const { t, orgId, customerId, userId, asUser } = await setup();
    const primaryId = await makeOwnedVehicle(t, orgId);
    const secondaryId = await makeSourcedVehicle(t, orgId, { vin: "SOURCING-TEST-2" });
    const otherCustomerId = (await t.run((ctx: any) =>
      ctx.db.insert("customers", { orgId, firstName: "Rania", lastName: "Haddad" })
    )) as Id<"customers">;

    // A multi-vehicle quote snapshots only its primary vehicleId on the deposit
    // row; every other car on the deal lives in depositVehicleHolds alone.
    const depositId = await t.run((ctx: any) =>
      ctx.db.insert("deposits", {
        orgId,
        vehicleId: primaryId,
        customerId,
        amount: 1000,
        currency: "JOD",
        method: "CASH",
        status: "HELD",
        holdActive: true,
        createdBy: userId,
        createdAt: Date.now(),
      })
    );
    await t.run((ctx: any) =>
      ctx.db.insert("depositVehicleHolds", {
        orgId,
        depositId,
        vehicleId: secondaryId,
        active: true,
        createdAt: Date.now(),
      })
    );
    await t.run((ctx: any) =>
      ctx.db.patch(secondaryId, { status: "RESERVED", preHoldStatus: "SOURCING" })
    );

    // Checking only deposits.by_vehicle_hold reports this car as unheld.
    await expect(
      asUser.mutation(api.vehicles.createReservation, {
        orgId,
        vehicleId: secondaryId,
        customerId: otherCustomerId,
      })
    ).rejects.toThrow(/another customer's deposit/i);
  });

  test("the pipeline shows the holding customer and deposit for a secondary vehicle", async () => {
    const { t, orgId, customerId, userId, asUser } = await setup();
    const primaryId = await makeOwnedVehicle(t, orgId);
    const secondaryId = await makeSourcedVehicle(t, orgId, { vin: "SOURCING-TEST-3" });

    const depositId = await t.run((ctx: any) =>
      ctx.db.insert("deposits", {
        orgId,
        vehicleId: primaryId,
        customerId,
        amount: 1000,
        currency: "JOD",
        method: "CASH",
        status: "HELD",
        holdActive: true,
        createdBy: userId,
        createdAt: Date.now(),
      })
    );
    await t.run((ctx: any) =>
      ctx.db.insert("depositVehicleHolds", {
        orgId,
        depositId,
        vehicleId: secondaryId,
        active: true,
        createdAt: Date.now(),
      })
    );

    const pipeline = await asUser.query(api.sourcingPayables.listPipeline, { orgId });
    const row = pipeline.find((entry: any) => entry._id === secondaryId);
    expect(row).toBeDefined();
    expect(row!.customerName).toBe("Sami Odeh");
    expect(row!.depositTotal).toBe(1000);
    expect(row!.isHeld).toBe(true);
  });
});

describe("getReservationHistory", () => {
  test("surfaces a wizard deposit hold that writes no reservation row", async () => {
    const { orgId, customerId, asUser, t } = await setup();
    const vehicleId = await makeSourcedVehicle(t, orgId);

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 15000,
      downPayment: 1000,
      termMonths: 0,
    });
    await asUser.mutation(api.deposits.create, { orgId, quoteId, amount: 500, method: "CASH" });

    const history = await asUser.query(api.vehicles.getReservationHistory, { orgId, vehicleId });

    // Previously empty: the tab read only `vehicleReservations` while the sales
    // wizard writes only `deposits`.
    expect(history).toHaveLength(1);
    expect(history[0].origin).toBe("DEPOSIT");
    expect(history[0].status).toBe("ACTIVE");
    expect(history[0].depositAmount).toBe(500);
  });

  test("a deposit whose hold was released is not still reported as ACTIVE", async () => {
    const { orgId, customerId, asUser, t } = await setup();
    const vehicleId = await makeSourcedVehicle(t, orgId);

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 15000,
      downPayment: 1000,
      termMonths: 0,
    });
    const depositId = await asUser.mutation(api.deposits.create, {
      orgId,
      quoteId,
      amount: 500,
      method: "CASH",
    });

    // holdActive and status are deliberately decoupled: a rejected finance
    // application clears the hold but leaves the deposit HELD so a manager
    // still decides refund vs forfeit. Reading `status` alone rendered these
    // as live holds forever.
    await t.run((ctx: any) => ctx.db.patch(depositId, { holdActive: false }));

    const history = await asUser.query(api.vehicles.getReservationHistory, { orgId, vehicleId });
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("RELEASED");
  });
});

describe("markSourcedVehicleArrived", () => {
  test("records arrival without disturbing a customer's hold", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const vehicleId = await makeSourcedVehicle(t, orgId);

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 15000,
      downPayment: 1000,
      termMonths: 0,
    });
    await asUser.mutation(api.deposits.create, { orgId, quoteId, amount: 500, method: "CASH" });

    await asUser.mutation(api.vehicles.markSourcedVehicleArrived, { orgId, vehicleId });

    const vehicle = await getVehicle(t, vehicleId);
    // The status guard refuses to move a vehicle out of RESERVED, so arrival
    // cannot be a status change for exactly the cars in this pipeline.
    expect(vehicle.status).toBe("RESERVED");
    expect(vehicle.arrivedAt).toBeTypeOf("number");
  });

  test("an unheld sourced vehicle moves onto the lot when it arrives", async () => {
    const { t, orgId, asUser } = await setup();
    const vehicleId = await makeSourcedVehicle(t, orgId);

    await asUser.mutation(api.vehicles.markSourcedVehicleArrived, { orgId, vehicleId });

    const vehicle = await getVehicle(t, vehicleId);
    expect(vehicle.status).toBe("AVAILABLE");
    expect(vehicle.arrivedAt).toBeTypeOf("number");
  });

  test("a legacy SOURCING row with a live hold is not put back on the lot", async () => {
    const { t, orgId, customerId, userId, asUser } = await setup();
    const vehicleId = await makeSourcedVehicle(t, orgId);

    // The exact pre-fix state: a deposit holding a vehicle that was left on
    // SOURCING. These rows survive in production until reconcileVehicleHolds
    // runs, and marking one arrived must not hand it back to the lot while a
    // customer's money is still on it.
    await t.run((ctx: any) =>
      ctx.db.insert("deposits", {
        orgId,
        vehicleId,
        customerId,
        amount: 500,
        currency: "JOD",
        method: "CASH",
        status: "HELD",
        holdActive: true,
        createdBy: userId,
        createdAt: Date.now(),
      })
    );

    await asUser.mutation(api.vehicles.markSourcedVehicleArrived, { orgId, vehicleId });

    const vehicle = await getVehicle(t, vehicleId);
    expect(vehicle.status).toBe("RESERVED");
    expect(vehicle.arrivedAt).toBeTypeOf("number");
  });

  test("rejects an owned-stock vehicle", async () => {
    const { t, orgId, asUser } = await setup();
    const vehicleId = await makeOwnedVehicle(t, orgId);

    await expect(
      asUser.mutation(api.vehicles.markSourcedVehicleArrived, { orgId, vehicleId })
    ).rejects.toThrow(/only sourced vehicles/i);
  });
});

describe("inventory valuation split", () => {
  test("sourced vehicles are reported as a commitment, not as inventory value", async () => {
    const { t, orgId, asUser } = await setup();
    await makeOwnedVehicle(t, orgId);
    await makeSourcedVehicle(t, orgId);

    const report = await asUser.query(api.reports.getInventoryReport, { orgId });

    // Summing both into one figure overstated the org's assets against its own
    // general ledger — a sourced car never posts to Vehicle Inventory.
    expect(report.totalValue).toBe(11000);
    expect(report.ownedCount).toBe(1);
    expect(report.sourcedCommitment).toBe(12800);
    expect(report.sourcedCount).toBe(1);
  });

  test("a SOURCING vehicle is included in the sourced commitment", async () => {
    const { t, orgId, asUser } = await setup();
    await makeSourcedVehicle(t, orgId);

    const report = await asUser.query(api.reports.getInventoryReport, { orgId });
    expect(report.sourcedCount).toBe(1);
    expect(report.sourcedCommitment).toBe(12800);
    expect(report.totalValue).toBe(0);
  });
});

describe("hold detection is not truncated by reservation history", () => {
  test("an active reservation is still found behind 60 historical ones", async () => {
    const { t, orgId, customerId, userId, asUser, asApprover } = await setup();
    const vehicleId = await makeOwnedVehicle(t, orgId);

    // by_org_vehicle returns oldest-first across every status, so a long tail of
    // released reservations used to push the live one out of the .take(50)
    // window — and "no hold found" is what hands a vehicle back to the lot.
    await t.run(async (ctx: any) => {
      for (let i = 0; i < 60; i++) {
        await ctx.db.insert("vehicleReservations", {
          orgId,
          vehicleId,
          customerId,
          status: "RELEASED",
          reservedBy: userId,
          reservedAt: Date.now() - (i + 2) * 86400000,
          releasedAt: Date.now() - (i + 1) * 86400000,
        });
      }
      await ctx.db.insert("vehicleReservations", {
        orgId,
        vehicleId,
        customerId,
        status: "ACTIVE",
        reservedBy: userId,
        reservedAt: Date.now(),
        expiresAt: Date.now() + 7 * 86400000,
      });
      await ctx.db.patch(vehicleId, { status: "RESERVED", preHoldStatus: "AVAILABLE" });
    });

    // Take an unrelated deposit and release it: the release path asks "is
    // anything else holding this?" and must see the live reservation.
    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 14000,
      downPayment: 1000,
      termMonths: 0,
    });
    const depositId = await asUser.mutation(api.deposits.create, {
      orgId,
      quoteId,
      amount: 500,
      method: "CASH",
    });
    await asApprover.mutation(api.deposits.release, {
      orgId,
      depositId,
      resolution: "REFUNDED",
      refundMethod: "CASH",
    });

    const vehicle = await getVehicle(t, vehicleId);
    expect(vehicle.status).toBe("RESERVED");
  });
});

describe("preHoldStatus does not outlive its meaning", () => {
  test("a vehicle converted from sourced to owned mid-hold is released to AVAILABLE", async () => {
    const { t, orgId, customerId, asUser, asApprover } = await setup();
    const vehicleId = await makeSourcedVehicle(t, orgId);

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 15000,
      downPayment: 1000,
      termMonths: 0,
    });
    const depositId = await asUser.mutation(api.deposits.create, {
      orgId,
      quoteId,
      amount: 500,
      method: "CASH",
    });
    expect((await getVehicle(t, vehicleId)).preHoldStatus).toBe("SOURCING");

    // The dealership bought the car outright while the deposit was live. This
    // needs no status transition, so the workflow guard permits it.
    await t.run((ctx: any) =>
      ctx.db.patch(vehicleId, { sourceType: "STOCK", purchasePrice: 12800 })
    );

    await asApprover.mutation(api.deposits.release, {
      orgId,
      depositId,
      resolution: "REFUNDED",
      refundMethod: "CASH",
    });

    // Restoring the stale SOURCING snapshot would park owned stock in the
    // sourcing lifecycle, off the lot and out of available inventory.
    const vehicle = await getVehicle(t, vehicleId);
    expect(vehicle.status).toBe("AVAILABLE");
  });
});

describe("reconcileVehicleHolds repairs pre-existing drift", () => {
  test("promotes a SOURCING vehicle that a live deposit hold is already holding", async () => {
    const { t, orgId, customerId, userId } = await setup();
    const vehicleId = await makeSourcedVehicle(t, orgId);

    // Reproduce the shipped-bug state directly: a live hold recorded against a
    // vehicle the old code left on SOURCING. This is the row the dealership
    // already has in production, which no forward code path would ever heal.
    await t.run((ctx: any) =>
      ctx.db.insert("deposits", {
        orgId,
        vehicleId,
        customerId,
        amount: 500,
        currency: "JOD",
        method: "CASH",
        status: "HELD",
        holdActive: true,
        createdBy: userId,
        createdAt: Date.now(),
      })
    );

    const dry = await t.mutation(internal.migrations.reconcileVehicleHolds, { orgId });
    expect(dry.released).toEqual([
      { vehicleId, from: "SOURCING", to: "RESERVED" },
    ]);

    await t.mutation(internal.migrations.reconcileVehicleHolds, { orgId, dryRun: false });

    const vehicle = await getVehicle(t, vehicleId);
    expect(vehicle.status).toBe("RESERVED");
    expect(vehicle.preHoldStatus).toBe("SOURCING");
  });

  test("leaves an unheld SOURCING vehicle alone", async () => {
    const { t, orgId } = await setup();
    const vehicleId = await makeSourcedVehicle(t, orgId);

    const dry = await t.mutation(internal.migrations.reconcileVehicleHolds, { orgId });
    expect(dry.released).toEqual([]);

    await t.mutation(internal.migrations.reconcileVehicleHolds, { orgId, dryRun: false });
    expect((await getVehicle(t, vehicleId)).status).toBe("SOURCING");
  });
});

describe("sourcing pipeline", () => {
  test("lists a special order that has no supplier payable yet", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const vehicleId = await makeSourcedVehicle(t, orgId);

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 15000,
      downPayment: 1000,
      termMonths: 0,
    });
    await asUser.mutation(api.deposits.create, { orgId, quoteId, amount: 500, method: "CASH" });

    const pipeline = await asUser.query(api.sourcingPayables.listPipeline, { orgId });

    // vehicleSupplierPayables rows are only written at sale completion, so the
    // page was empty for the entire life of an order and filled up once it was
    // over.
    expect(pipeline).toHaveLength(1);
    expect(pipeline[0].sourcedFromName).toBe("Al-Zriqat Motors");
    expect(pipeline[0].customerName).toBe("Sami Odeh");
    expect(pipeline[0].depositTotal).toBe(500);
    expect(pipeline[0].hasArrived).toBe(false);
    expect(pipeline[0].isHeld).toBe(true);
  });

  test("excludes owned stock", async () => {
    const { t, orgId, asUser } = await setup();
    await makeOwnedVehicle(t, orgId);

    const pipeline = await asUser.query(api.sourcingPayables.listPipeline, { orgId });
    expect(pipeline).toHaveLength(0);
  });
});
