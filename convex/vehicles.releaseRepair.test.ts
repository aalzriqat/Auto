import { expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { supplierIdFor } from "../test-utils/supplierFixture";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { notifyManagers } from "./utils/notifications";
import { landedCostAccountDeltas } from "./utils/vehicleLandedCostWrite";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

vi.mock("./utils/notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./utils/notifications")>();
  return { ...actual, notifyManagers: vi.fn(actual.notifyManagers) };
});

const car = {
  vin: "1HGCM82633A000001", make: "Honda", model: "Accord", year: 2020,
  color: "White", fuelType: "Gasoline", transmission: "Automatic", mileage: 10_000, sellingPrice: 20_000,
  sourceType: "STOCK" as const,
};
const availableCar = { ...car, status: "AVAILABLE" as const };

async function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"), { transactionLimits: true });
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("organizations", { name: "Repair fixture", createdAt: now });
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: now, updatedAt: now });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
    const userId = await ctx.db.insert("users", { clerkId: "repair-owner", email: "repair@example.test" });
    const roleId = await ctx.db.insert("roles", {
      orgId, name: "Owner", isSystemOwnerRole: true,
      permissions: ["create:vehicles", "view:vehicles", "edit:vehicles", "delete:vehicles", "view:cost_price"],
    });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "Test", lastName: "Customer" });
    return { orgId, userId, customerId };
  });
  return { t, ...ids, owner: t.withIdentity({ subject: "repair-owner" }) };
}

test("create retries canonicalize VIN case and preserve historical command terms", async () => {
  const { t, orgId, owner } = await setup();
  const request = { orgId, ...availableCar, idempotencyKey: "case-only-retry" };
  const id = await owner.mutation(api.vehicles.create, request);
  expect(await owner.mutation(api.vehicles.create, { ...request, vin: car.vin.toLowerCase() })).toBe(id);
  await t.run(async (ctx) => {
    const command = await ctx.db.query("commandIdempotency").withIndex("by_org_operation_key",
      (q) => q.eq("orgId", orgId).eq("operation", "vehicles.create").eq("idempotencyKey", request.idempotencyKey)).unique();
    if (!command?.fingerprint) throw new Error("Missing vehicle command");
    await ctx.db.patch(command._id, {
      fingerprint: JSON.stringify({ ...JSON.parse(command.fingerprint), vin: car.vin.toLowerCase() }),
    });
  });
  expect(await owner.mutation(api.vehicles.create, request)).toBe(id);
  await expect(owner.mutation(api.vehicles.create, { ...request, sellingPrice: car.sellingPrice + 1 }))
    .rejects.toThrow(/different request content/);
});

test("VIN lookup hides a deleted vehicle while its VIN remains reserved", async () => {
  const { orgId, owner } = await setup();
  const request = { orgId, ...availableCar, idempotencyKey: "lookup-before-delete" };
  const id = await owner.mutation(api.vehicles.create, request);
  expect(await owner.query(api.vehicles.getByVin, { orgId, vin: car.vin })).toMatchObject({ _id: id });
  await owner.mutation(api.vehicles.softDelete, { orgId, vehicleId: id });
  expect(await owner.query(api.vehicles.getByVin, { orgId, vin: car.vin })).toBeNull();
  await expect(owner.mutation(api.vehicles.create, { ...request, idempotencyKey: "lookup-after-delete" }))
    .rejects.toThrow(/already exists/i);
});

test.each(["PURCHASE", "OPENING_STOCK"] as const)(
  "%s refuses a missing explicit valuation company before writing",
  async (acquisitionPosting) => {
    const { t, orgId, owner } = await setup();
    const companyId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("financeCompanies", {
        orgId, name: "Test finance", profitRate: 0, maxTermMonths: 36, gracePeriodMonths: 0, isActive: true,
      });
      await ctx.db.delete(id);
      return id;
    });
    await expect(owner.mutation(api.vehicles.importBulk, {
      orgId, acquisitionPosting, importId: "unavailable-company",
      ...(acquisitionPosting === "PURCHASE" ? { purchasePaymentMethod: "CASH" as const } : {}),
      vehicles: [{ ...car, rowId: 1, purchasePrice: 8_000, valuations: [{ companyId, valuationAmount: 9_000 }] }],
    })).rejects.toThrow(/Finance company not found/);
    expect(await owner.query(api.vehicles.getByVin, { orgId, vin: car.vin })).toBeNull();
  },
);

test.each([true, false])("tracked opening refuses a mixed VIN collision (sourced first: %s)", async (sourcedFirst) => {
  const { t, orgId, owner } = await setup();
  const stock = { ...car, rowId: 1, purchasePrice: 8_000 };
  const sourced = {
    ...car, rowId: 2, vin: car.vin.toLowerCase(), sourceType: "SOURCED" as const, sourceCost: 8_000,
    sourcedSupplierId: await supplierIdFor(t, orgId, "Test supplier"),
  };
  await expect(owner.mutation(api.vehicles.importBulk, {
    orgId, acquisitionPosting: "OPENING_STOCK", importId: "mixed-vin",
    vehicles: sourcedFirst ? [sourced, stock] : [stock, sourced],
  })).rejects.toThrow(/same VIN for owned and sourced/);
  expect(await owner.query(api.vehicles.getByVin, { orgId, vin: car.vin })).toBeNull();
});

test("tracked opening replays owned proof without skipping a new sourced row of the same number", async () => {
  const { t, orgId, owner } = await setup();
  const stock = { ...car, rowId: 1, purchasePrice: 8_000 };
  const command = { orgId, acquisitionPosting: "OPENING_STOCK" as const, importId: "owned-proof" };
  await owner.mutation(api.vehicles.importBulk, { ...command, vehicles: [stock] });
  const sourced = {
    ...car, rowId: 1, vin: "1HGCM82633A000002", sourceType: "SOURCED" as const, sourceCost: 8_000,
    sourcedSupplierId: await supplierIdFor(t, orgId, "Test supplier"),
    valuations: [{ companyName: "Test finance", valuationAmount: 10_000 }],
  };
  expect(await owner.mutation(api.vehicles.importBulk, { ...command, vehicles: [stock, sourced] }))
    .toMatchObject({ inserted: 1, skipped: 1, companiesCreated: 1 });
  const saved = await owner.query(api.vehicles.getByVin, { orgId, vin: sourced.vin });
  expect(saved?.sourceType).toBe("SOURCED");
  expect(await owner.query(api.finance.listValuations, { orgId, vehicleId: saved!._id }))
    .toMatchObject([{ valuationAmount: 10_000 }]);
});

test("tracked opening treats a wrong-table identifier in durable proof as a conflict", async () => {
  const { t, orgId, customerId, owner } = await setup();
  const request = {
    orgId, acquisitionPosting: "OPENING_STOCK" as const, importId: "malformed-proof",
    vehicles: [{ ...car, rowId: 1, purchasePrice: 8_000 }],
  };
  await owner.mutation(api.vehicles.importBulk, request);
  await t.run(async (ctx) => {
    const proof = await ctx.db.query("commandIdempotency").withIndex("by_org_operation_key",
      (q) => q.eq("orgId", orgId).eq("operation", "vehicles.importBulk.openingStock").eq("idempotencyKey", "malformed-proof:1"))
      .unique();
    if (!proof) throw new Error("Missing opening proof");
    await ctx.db.patch(proof._id, { result: { ...proof.result, vehicleId: customerId } });
  });
  await expect(owner.mutation(api.vehicles.importBulk, request)).rejects.toThrow(/retry proof conflicts/i);
});

test("legacy reservation replay accepts an omitted or matching expiry and refuses a changed timestamp", async () => {
  const { t, orgId, owner, customerId } = await setup();
  const vehicleId = await owner.mutation(api.vehicles.create, { orgId, ...availableCar, idempotencyKey: "car" });
  const request = { orgId, customerId, vehicleId, idempotencyKey: "reservation" };
  const id = await owner.mutation(api.vehicles.createReservation, request);
  expect(await owner.mutation(api.vehicles.createReservation, request)).toBe(id);
  const expiresAt = await t.run(async (ctx) => {
    const command = await ctx.db.query("commandIdempotency").withIndex("by_org_operation_key",
      (q) => q.eq("orgId", orgId).eq("operation", "vehicles.createReservation").eq("idempotencyKey", request.idempotencyKey)).unique();
    if (!command?.fingerprint) throw new Error("Missing reservation command");
    const { expiresAt: _intent, ...legacyTerms } = JSON.parse(command.fingerprint);
    await ctx.db.patch(command._id, { fingerprint: JSON.stringify(legacyTerms) });
    const row = await ctx.db.get(id);
    if (!row?.expiresAt) throw new Error("Missing effective expiry");
    return row.expiresAt;
  });
  expect(await owner.mutation(api.vehicles.createReservation, { ...request, expiresAt })).toBe(id);
  await expect(owner.mutation(api.vehicles.createReservation, { ...request, expiresAt: expiresAt + 1 }))
    .rejects.toThrow(/different request content/);
  expect(await owner.mutation(api.vehicles.createReservation, request)).toBe(id);
});

test.each([NaN, Infinity])("a new reservation refuses nonfinite expiry %s", async (expiresAt) => {
  const { orgId, owner, customerId } = await setup();
  const vehicleId = await owner.mutation(api.vehicles.create, { orgId, ...availableCar, idempotencyKey: "car" });
  await expect(owner.mutation(api.vehicles.createReservation, {
    orgId, customerId, vehicleId, idempotencyKey: "reservation", expiresAt,
  })).rejects.toThrow(/finite time in the future/);
});

test("expiry continues beyond a failed due page and omits no-deadline rows", async () => {
  const { t, orgId, customerId, userId } = await setup();
  const { missingExpiryId, lastDueId, failedRows } = await t.run(async (ctx) => {
    const seed = { orgId, customerId, status: "ACTIVE" as const, reservedAt: Date.now() - 1000, reservedBy: userId };
    const vehicleId = await ctx.db.insert("vehicles", { orgId, ...car, status: "RESERVED" });
    const missingExpiryId = await ctx.db.insert("vehicleReservations", { ...seed, vehicleId });
    let lastDueId = missingExpiryId;
    const failedRows = [];
    for (let i = 0; i < 9; i++) {
      const dueVehicle = await ctx.db.insert("vehicles", { orgId, ...car, vin: `DUE${i}`, status: "RESERVED" });
      const depositId = i < 4 ? await ctx.db.insert("deposits", {
        orgId, vehicleId: dueVehicle, customerId, amount: 100,
        status: "HELD", holdActive: true, createdBy: userId, createdAt: seed.reservedAt,
      }) : undefined;
      lastDueId = await ctx.db.insert("vehicleReservations", {
        ...seed, depositId, vehicleId: dueVehicle, expiresAt: seed.reservedAt + i,
      });
      if (depositId) failedRows.push({ depositId, reservationId: lastDueId });
    }
    return { missingExpiryId, lastDueId, failedRows };
  });
  for (const _row of failedRows) {
    vi.mocked(notifyManagers).mockRejectedValueOnce(new Error("Test notification failure"));
  }
  vi.useFakeTimers();
  try {
    expect(await t.mutation(internal.vehicles.expireReservations, { limit: 100 })).toEqual({ expired: 0 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  } finally {
    vi.useRealTimers();
  }
  expect(await t.run((ctx) => ctx.db.get(lastDueId))).toMatchObject({ status: "EXPIRED" });
  expect(await t.run((ctx) => ctx.db.get(missingExpiryId))).toMatchObject({ status: "ACTIVE" });
  for (const { depositId, reservationId } of failedRows) {
    expect(await t.run((ctx) => ctx.db.get(reservationId))).toMatchObject({ status: "ACTIVE" });
    expect(await t.run((ctx) => ctx.db.get(depositId))).toMatchObject({ holdActive: true });
  }
});

test("a reservation with a missing vehicle does not roll back another expiry", async () => {
  const { t, orgId, customerId, userId } = await setup();
  const [orphan, ordinary] = await t.run(async (ctx) => {
    const now = Date.now();
    const seed = { orgId, customerId, status: "ACTIVE" as const, reservedAt: now - 2000, reservedBy: userId };
    const vehicleId = await ctx.db.insert("vehicles", { orgId, ...car, status: "RESERVED" });
    const otherVehicle = await ctx.db.insert("vehicles", { orgId, ...car, vin: "OTHEREXPIRY", status: "RESERVED" });
    const first = await ctx.db.insert("vehicleReservations", { ...seed, vehicleId, expiresAt: now - 1000 });
    const second = await ctx.db.insert("vehicleReservations", { ...seed, vehicleId: otherVehicle, expiresAt: now - 500 });
    await ctx.db.delete(vehicleId);
    return [first, second];
  });
  expect(await t.mutation(internal.vehicles.expireReservations, { limit: 100 })).toEqual({ expired: 2 });
  expect(await t.run(async (ctx) =>
    [(await ctx.db.get(orphan))?.status, (await ctx.db.get(ordinary))?.status]
  )).toEqual(["EXPIRED", "EXPIRED"]);
});

test("a sourced car that arrives under reservation becomes available when released", async () => {
  const { t, orgId, customerId, owner } = await setup();
  const vehicleId = await t.run((ctx) => ctx.db.insert("vehicles", {
    orgId, ...car, sourceType: "SOURCED", status: "SOURCING",
  }));
  const reservationId = await owner.mutation(api.vehicles.createReservation, {
    orgId, customerId, vehicleId, idempotencyKey: "held-before-arrival",
  });
  await owner.mutation(api.vehicles.markSourcedVehicleArrived, { orgId, vehicleId });
  expect(await owner.query(api.vehicles.get, { orgId, vehicleId })).toMatchObject({ status: "RESERVED" });
  await owner.mutation(api.vehicles.releaseReservation, { orgId, reservationId });
  expect(await owner.query(api.vehicles.get, { orgId, vehicleId })).toMatchObject({ status: "AVAILABLE" });
});

test("arrival and reconciliation both preserve a live hold beyond stale deposits", async () => {
  const { t, orgId, customerId, userId, owner } = await setup();
  const { vehicleId, liveDepositId } = await t.run(async (ctx) => {
    const id = await ctx.db.insert("vehicles", { orgId, ...car, sourceType: "SOURCED", status: "SOURCING" });
    const deposit = { orgId, vehicleId: id, customerId, amount: 100, holdActive: true, createdBy: userId, createdAt: Date.now() };
    for (let i = 0; i < 50; i++) {
      await ctx.db.insert("deposits", { ...deposit, status: "VOIDED" });
    }
    const liveDepositId = await ctx.db.insert("deposits", { ...deposit, status: "HELD" });
    return { vehicleId: id, liveDepositId };
  });
  await owner.mutation(api.vehicles.markSourcedVehicleArrived, { orgId, vehicleId });
  expect(await owner.query(api.vehicles.get, { orgId, vehicleId }))
    .toMatchObject({ status: "RESERVED", arrivedAt: expect.any(Number) });
  const reconcile = (dryRun: boolean) => t.mutation(internal.migrations.reconcileVehicleHolds, { orgId, dryRun });
  expect(await reconcile(true)).toMatchObject({ released: [] });
  expect(await reconcile(false)).toMatchObject({ released: [] });

  await t.run((ctx) => ctx.db.patch(liveDepositId, { status: "VOIDED", holdActive: false }));
  const released = [{ vehicleId, from: "RESERVED", to: "AVAILABLE" }];
  expect(await reconcile(true)).toMatchObject({ released });
  expect(await reconcile(false)).toMatchObject({ released });
  expect(await owner.query(api.vehicles.get, { orgId, vehicleId })).toMatchObject({ status: "AVAILABLE" });
});

test("reservation history uses remaining active slices for a deposit's primary vehicle", async () => {
  const { t, orgId, customerId, userId, owner } = await setup();
  const { vehicleId, depositId } = await t.run(async (ctx) => {
    const vehicleId = await ctx.db.insert("vehicles", { orgId, ...car, status: "RESERVED" });
    const otherCar = await ctx.db.insert("vehicles", { orgId, ...car, vin: "OTHER", status: "RESERVED" });
    const depositId = await ctx.db.insert("deposits", {
      orgId, vehicleId, customerId, amount: 100, status: "HELD", holdActive: true,
      usesVehicleHoldRows: true, createdBy: userId, createdAt: Date.now(),
    });
    await ctx.db.insert("depositVehicleHolds", { orgId, depositId, vehicleId, active: false, createdAt: Date.now() });
    await ctx.db.insert("depositVehicleHolds", { orgId, depositId, vehicleId: otherCar, active: true, createdAt: Date.now() });
    return { vehicleId, depositId };
  });
  const history = () => owner.query(api.vehicles.getReservationHistory, { orgId, vehicleId });
  expect(await history()).toMatchObject([{ _id: depositId, status: "RELEASED" }]);
  await t.run((ctx) => ctx.db.insert("depositVehicleHolds", { orgId, depositId, vehicleId, active: true, createdAt: Date.now() }));
  expect(await history()).toMatchObject([{ _id: depositId, status: "ACTIVE" }]);
});

test("sourced landed costs refuse aggregate overflow and retain valid totals", async () => {
  const { t, orgId, owner } = await setup();
  const vehicleId = await t.run((ctx) => ctx.db.insert("vehicles", {
    orgId, ...car, sourceType: "SOURCED", status: "SOURCING",
  }));
  await expect(owner.mutation(api.vehicles.upsertLandedCosts, {
    orgId, vehicleId, items: [
      { label: "First item", amount: Number.MAX_VALUE },
      { label: "Second item", amount: Number.MAX_VALUE },
    ],
  })).rejects.toThrow(/landed cost total/i);
  expect(await owner.query(api.vehicles.getLandedCosts, { orgId, vehicleId })).toBeNull();
  expect(await owner.mutation(api.vehicles.upsertLandedCosts, {
    orgId, vehicleId, items: [{ label: "Valid item", amount: 0.001 }],
  })).toEqual({ total: 0.001 });
});

test("legacy subminor landed costs reverse the change in rounded account balances", () => {
  const cash = { label: "Legacy cost", amount: 0.0004, paymentMethod: "CASH" as const };
  const cheque = { label: "Separate settlement", amount: 1, paymentMethod: "CHEQUE" as const };
  expect(landedCostAccountDeltas([cash, cash, cheque], [cash, cheque], "JOD")).toEqual([
    { paymentMethod: "CASH", bankAccountId: undefined, deltaMinor: -1 },
  ]);
});
