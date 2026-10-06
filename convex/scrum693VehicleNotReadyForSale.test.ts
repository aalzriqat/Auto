/**
 * SCRUM-693 PR-B F1 — A CAR IN INSPECTION OR REPAIR IS NOT SOLD UNTIL IT IS CLEARED.
 *
 * INVARIANT: the returned car of an unwound deal is parked IN_INSPECTION (D3). Every door that
 * completes or drafts a sale refuses a car whose status is IN_INSPECTION or IN_REPAIR with the
 * structured `VEHICLE_NOT_READY_FOR_SALE` code, writes nothing, and succeeds once an authorized
 * edit returns the car to AVAILABLE. The picker never reports such a car as FREE.
 *
 * Template: scrum641DeletedVehicleDoors.test.ts (same doors, same fixtures).
 */

import { describe, expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { expectAppError } from "../test-utils/expectAppError";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");

const PERMISSIONS = ["create:sales", "edit:sales", "view:sales", "view:customers", "edit:vehicles", "view:vehicles"];

const PRICE = 30_000;
const NOT_READY_MESSAGE = "This vehicle is in inspection or repair and cannot be sold until it is cleared for sale.";

type Blocked = "IN_INSPECTION" | "IN_REPAIR";
const BLOCKED: Blocked[] = ["IN_INSPECTION", "IN_REPAIR"];

let seq = 0;
let dealerSeq = 0;

async function seedDealer() {
  dealerSeq += 1;
  const n = dealerSeq;
  const t = convexTestWithComponents(schema, MODULES);
  const { orgId, userId, customerId } = await t.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("organizations", { name: `Dealer ${n}`, createdAt: now });
    await ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const roleId = await ctx.db.insert("roles", { orgId, name: "Admin", permissions: PERMISSIONS });
    const userId = await ctx.db.insert("users", { clerkId: `u693_${n}`, email: `${n}@t693.com`, name: "Sales" });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
    const customerId = await ctx.db.insert("customers", {
      orgId,
      firstName: "Customer",
      lastName: "A",
      phone: `+96279693${n}1`,
      createdAt: now,
    });
    return { orgId, userId, customerId };
  });
  return { t, orgId, userId, customerId, asUser: t.withIdentity({ subject: `u693_${n}`, clerkId: `u693_${n}` }) };
}
type Seed = Awaited<ReturnType<typeof seedDealer>>;

async function vehicle(seed: Seed, status: "AVAILABLE" | Blocked = "AVAILABLE") {
  seq += 1;
  return await seed.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: seed.orgId,
      vin: `SC693VIN${String(seq).padStart(8, "0")}`,
      make: "Toyota",
      model: "RAV4",
      year: 2023,
      color: "White",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 90,
      purchasePrice: 20_000,
      sellingPrice: PRICE,
      status,
      createdAt: Date.now(),
    })
  );
}

const setStatus = (seed: Seed, vehicleId: Id<"vehicles">, status: "AVAILABLE" | Blocked) =>
  seed.t.run((ctx) => ctx.db.patch(vehicleId, { status }));

async function quoteFor(seed: Seed, vehicles: Array<Id<"vehicles">>) {
  return await seed.asUser.mutation(api.quotes.saveQuote, {
    orgId: seed.orgId,
    customerId: seed.customerId,
    vehicleId: vehicles[0],
    vehicleItems: vehicles.map((vehicleId) => ({ vehicleId, unitPrice: PRICE })),
    mode: "CASH" as const,
    vehiclePrice: PRICE * vehicles.length,
    downPayment: 0,
    termMonths: 0,
  });
}

// Row CONTENT, not counts: a refusal that patched an existing row would leave every count equal.
const snapshot = (seed: Seed) => dbSnapshot(seed.t, Object.keys(schema.tables));

async function expectNotReadyAndNothingWritten(seed: Seed, attempt: () => Promise<unknown>) {
  const before = await snapshot(seed);
  await expectAppError(attempt(), "VEHICLE_NOT_READY_FOR_SALE", NOT_READY_MESSAGE);
  expect(await snapshot(seed), "nothing at all was written, and no existing row was modified").toEqual(before);
}

const completeQuote = (seed: Seed, quoteId: Id<"quotes">) =>
  seed.asUser.mutation(api.sales.completeFromQuote, { idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, quoteId });

const directSale = (seed: Seed, vehicleId: Id<"vehicles">) =>
  seed.asUser.mutation(api.sales.create, {
    idempotencyKey: crypto.randomUUID(),
    orgId: seed.orgId,
    vehicleId,
    customerId: seed.customerId,
    salespersonId: seed.userId,
    salePrice: PRICE,
    saleDate: Date.now(),
    status: "COMPLETED" as const,
  });

const draftArgs = (seed: Seed, vehicleId: Id<"vehicles">) => ({
  orgId: seed.orgId,
  vehicleId,
  customerId: seed.customerId,
  salespersonId: seed.userId,
  salePrice: PRICE,
  saleDate: Date.now(),
});

describe("SCRUM-705: the nothing-written assertion sees an in-place edit", () => {
  test("a modified existing row changes the snapshot although every row count is equal", async () => {
    const seed = await seedDealer();
    const v = await vehicle(seed);
    const before = await snapshot(seed);
    await seed.t.run((ctx) => ctx.db.patch(v, { sellingPrice: PRICE + 1 }));
    expect(await snapshot(seed)).not.toEqual(before);
  });
});

describe.each(BLOCKED)("SCRUM-693 F1: a %s car is not sold", (blocked) => {
  test("completeFromQuote refuses, writes nothing, and succeeds once cleared", async () => {
    const seed = await seedDealer();
    const v = await vehicle(seed, blocked);
    const quoteId = await quoteFor(seed, [v]);
    await expectNotReadyAndNothingWritten(seed, () => completeQuote(seed, quoteId));
    await setStatus(seed, v, "AVAILABLE");
    await expect(completeQuote(seed, quoteId), "control: cleared car completes").resolves.toHaveLength(1);
  });

  test("a multi-vehicle quote with the blocked car as a SECONDARY item is refused whole", async () => {
    const seed = await seedDealer();
    const primary = await vehicle(seed);
    const secondary = await vehicle(seed, blocked);
    const quoteId = await quoteFor(seed, [primary, secondary]);
    await expectNotReadyAndNothingWritten(seed, () => completeQuote(seed, quoteId));
    await setStatus(seed, secondary, "AVAILABLE");
    await expect(completeQuote(seed, quoteId)).resolves.toHaveLength(2);
  });

  test("sales.create (direct COMPLETED) refuses and succeeds once cleared", async () => {
    const seed = await seedDealer();
    const v = await vehicle(seed, blocked);
    await expectNotReadyAndNothingWritten(seed, () => directSale(seed, v));
    await setStatus(seed, v, "AVAILABLE");
    await expect(directSale(seed, v)).resolves.toBeTruthy();
  });

  test("createDraft refuses; completeDraft of a draft made before the car was parked refuses", async () => {
    const seed = await seedDealer();
    const v = await vehicle(seed);
    const draftId = await seed.asUser.mutation(api.sales.createDraft, draftArgs(seed, v));
    await setStatus(seed, v, blocked);
    await expectNotReadyAndNothingWritten(seed, () =>
      seed.asUser.mutation(api.sales.completeDraft, {
        idempotencyKey: crypto.randomUUID(),
        orgId: seed.orgId,
        saleId: draftId,
      })
    );
    const w = await vehicle(seed, blocked);
    await expectNotReadyAndNothingWritten(seed, () => seed.asUser.mutation(api.sales.createDraft, draftArgs(seed, w)));
    await setStatus(seed, w, "AVAILABLE");
    await expect(seed.asUser.mutation(api.sales.createDraft, draftArgs(seed, w))).resolves.toBeTruthy();
  });

  test("the picker never reports the car as FREE", async () => {
    const seed = await seedDealer();
    const v = await vehicle(seed, blocked);
    const free = await vehicle(seed);
    const rows = await seed.asUser.query(api.vehicleAvailability.pickerAvailability, {
      orgId: seed.orgId,
      vehicleIds: [v, free],
    });
    expect(rows.find((r) => r.vehicleId === v)?.availability).toBe("UNCERTAIN");
    expect(rows.find((r) => r.vehicleId === free)?.availability, "control").toBe("FREE");
  });
});
