import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

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

    const vehicle = await t.run((ctx: any) => ctx.db.get(vehicleId));
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

    const vehicle = await t.run((ctx: any) => ctx.db.get(vehicleId));
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
    expect((await t.run((ctx: any) => ctx.db.get(vehicleId))).status).toBe("RESERVED");

    await asApprover.mutation(api.deposits.release, {
      orgId,
      depositId,
      resolution: "REFUNDED",
      refundMethod: "CASH",
    });

    expect((await t.run((ctx: any) => ctx.db.get(vehicleId))).status).toBe("AVAILABLE");
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

    const vehicle = await t.run((ctx: any) => ctx.db.get(vehicleId));
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
    await asUser.mutation(api.vehicles.createReservation, { orgId, vehicleId, customerId });

    const vehicle = await t.run((ctx: any) => ctx.db.get(vehicleId));
    expect(vehicle.status).toBe("RESERVED");
  });

  test("another customer's deposit hold still blocks a reservation", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const vehicleId = await makeSourcedVehicle(t, orgId);
    const otherCustomerId = await t.run((ctx: any) =>
      ctx.db.insert("customers", { orgId, firstName: "Rania", lastName: "Haddad" })
    );

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

    const vehicle = await t.run((ctx: any) => ctx.db.get(vehicleId));
    // The status guard refuses to move a vehicle out of RESERVED, so arrival
    // cannot be a status change for exactly the cars in this pipeline.
    expect(vehicle.status).toBe("RESERVED");
    expect(vehicle.arrivedAt).toBeTypeOf("number");
  });

  test("an unheld sourced vehicle moves onto the lot when it arrives", async () => {
    const { t, orgId, asUser } = await setup();
    const vehicleId = await makeSourcedVehicle(t, orgId);

    await asUser.mutation(api.vehicles.markSourcedVehicleArrived, { orgId, vehicleId });

    const vehicle = await t.run((ctx: any) => ctx.db.get(vehicleId));
    expect(vehicle.status).toBe("AVAILABLE");
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
