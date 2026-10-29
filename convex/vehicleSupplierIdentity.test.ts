/**
 * SCRUM-868 P2: the supplier identity of a vehicle (design doc sections 4.3, 4.4, 7).
 *
 * Invariants under test, per entry point (vehicles.create / update / createSourced / importBulk and
 * vehicleEdits.requestCreate / requestUpdate / resolve):
 *   - the consignment supplier of a SOURCED car and the creditor of an OWNED ON_ACCOUNT car are set
 *     only from a supplier master id resolved in the caller's organization; a missing id, a foreign or
 *     missing id and an inactive supplier are refused with stable codes (N5, N6, N10);
 *   - the stored name is the one the SERVER read from the master, never the client's text (N3), and it
 *     survives a later rename;
 *   - the two roles are separate fields and cross-sending is refused (N9);
 *   - once money exists against the vehicle, the supplier link cannot change (N11);
 *   - a mobile-shaped call (names only) cannot reach these paths (OQ-6, pilot is web only);
 *   - nothing is posted or re-amounted by the identity change (N4).
 *
 * Every refusal also asserts that NOTHING was written: a refusal caught after a write would commit.
 */
import { describe, expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { expectAppError } from "../test-utils/expectAppError";
import { renameSupplier, seedSupplier } from "../test-utils/supplierFixture";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { SUPPLIER_ERROR, SUPPLIER_NOT_FOUND_MESSAGE } from "./utils/supplierRegistry";
import { SUPPLIER_CONCESSION_REFUSALS } from "./utils/supplierConcession";
import { VEHICLE_SOURCE_SHAPE_MESSAGES } from "./utils/vehicleSourceShape";
import { SUPPLIER_LINK_FROZEN_MESSAGE, SUPPLIER_ROLE_CONFLICT_MESSAGE } from "./utils/vehicleSupplierIdentity";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

// RT11-DOORS: the buy-out mechanics below run with the pilot doors explicitly open; the shipped-state
// refusal is pinned in rt11DoorContainment.test.ts and is not changed by SCRUM-868.
vi.mock("./utils/rt11DoorContainment", async (importOriginal) =>
  (await import("../test-utils/rt11DoorSwitches")).openRt11Doors(
    await importOriginal<typeof import("./utils/rt11DoorContainment")>()
  ));

const MODULE_GLOB = import.meta.glob("./**/*.ts");

const OWNER_PERMISSIONS = [
  "create:vehicles", "edit:vehicles", "view:vehicles", "view:cost_price",
  "create:expenses", "view:expenses", "view:finance", "manage:finance", "view:reports",
  "approve:requests",
];
const CLERK_PERMISSIONS = ["create:vehicles", "edit:vehicles", "view:vehicles"];

const baseVehicle = {
  vin: "1HGCM82633A000001",
  make: "Honda",
  model: "Accord",
  year: 2020,
  mileage: 10000,
  color: "White",
  fuelType: "Gasoline",
  transmission: "Automatic",
  sellingPrice: 20000,
  status: "AVAILABLE" as const,
};

async function seedDealer(suffix: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Supplier Identity Dealer ${suffix}`, createdAt: Date.now() })
  );
  const otherOrgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Other Dealer ${suffix}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const ownerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `owner_${suffix}`, email: `${suffix}@example.com`, name: "Owner" })
  );
  const ownerRole = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: OWNER_PERMISSIONS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: ownerId, roleId: ownerRole }));
  const clerkId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `clerk_${suffix}`, email: `clerk-${suffix}@example.com`, name: "Clerk" })
  );
  const clerkRole = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Clerk", permissions: CLERK_PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: clerkId, roleId: clerkRole }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] })
  );
  const asOwner = t.withIdentity({ subject: `owner_${suffix}`, clerkId: `owner_${suffix}` });
  const asClerk = t.withIdentity({ subject: `clerk_${suffix}`, clerkId: `clerk_${suffix}` });
  await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });
  await asOwner.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(2020, 0, 1), endDate: Date.UTC(2035, 11, 31, 23, 59, 59, 999),
    fiscalYear: 2025, periodNumber: 1,
  });
  const period = (await asOwner.query(api.accountingPeriods.list, { orgId }))[0];
  await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const gulf = await seedSupplier(t, { orgId, userId: ownerId, displayName: "Gulf Motors" });
  const creditor = await seedSupplier(t, { orgId, userId: ownerId, displayName: "Credit Supplier Co" });
  const dormant = await seedSupplier(t, { orgId, userId: ownerId, displayName: "Dormant Trading", status: "INACTIVE" });
  const foreign = await seedSupplier(t, { orgId: otherOrgId, userId: ownerId, displayName: "Foreign Org Supplier" });
  return { t, orgId, ownerId, asOwner, asClerk, gulf, creditor, dormant, foreign };
}
type Dealer = Awaited<ReturnType<typeof seedDealer>>;

/** Everything a refused identity write must leave untouched (single-organization world per test). */
async function worldCounts(d: Dealer) {
  return d.t.run(async (ctx) => ({
    vehicles: (await ctx.db.query("vehicles").collect()).length,
    events: (await ctx.db.query("accountingEvents").collect()).length,
    pending: (await ctx.db.query("pendingAccountingEvents").collect()).length,
    payables: (await ctx.db.query("vehicleSupplierPayables").collect()).length,
    transactions: (await ctx.db.query("transactions").collect()).length,
    edits: (await ctx.db.query("vehicleEdits").collect()).length,
  }));
}

const sourcedBody = { sourceType: "SOURCED" as const, sourceCost: 9000 };
const onAccountBody = { sourceType: "STOCK" as const, purchasePrice: 10000, purchasePaymentMethod: "ON_ACCOUNT" as const };

const identityRequired = [SUPPLIER_ERROR.IDENTITY_REQUIRED, "A supplier is required."] as const;
const notFound = [SUPPLIER_ERROR.NOT_FOUND, SUPPLIER_NOT_FOUND_MESSAGE] as const;
const inactive = [SUPPLIER_ERROR.INACTIVE, "This supplier is inactive and cannot be used for new records."] as const;
const roleConflict = [SUPPLIER_ERROR.ROLE_CONFLICT, SUPPLIER_ROLE_CONFLICT_MESSAGE] as const;
const linkFrozen = [SUPPLIER_ERROR.LINK_FROZEN, SUPPLIER_LINK_FROZEN_MESSAGE] as const;

async function createSourcedVehicle(d: Dealer, overrides: Record<string, unknown> = {}) {
  return await d.asOwner.mutation(api.vehicles.create, {
    idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, ...sourcedBody,
    sourcedSupplierId: d.gulf, ...overrides,
  });
}

async function vehicleRow(d: Dealer, id: Id<"vehicles">) {
  return await d.t.run((ctx) => ctx.db.get(id));
}

async function payablesOf(d: Dealer, vehicleId: Id<"vehicles">) {
  return d.t.run((ctx) =>
    ctx.db.query("vehicleSupplierPayables").withIndex("by_vehicle", (q) => q.eq("vehicleId", vehicleId)).collect()
  );
}

describe("vehicles.create: the consignment supplier of a SOURCED car", () => {
  test("is stored as the master id and the SERVER name, never the client's typed text", async () => {
    const d = await seedDealer("c1");
    const id = await createSourcedVehicle(d, { sourcedFromName: "  typed by the client  " });
    const row = await vehicleRow(d, id);
    expect(row).toMatchObject({ sourceType: "SOURCED", sourcedSupplierId: d.gulf, sourcedFromName: "Gulf Motors" });
    const edit = await d.t.run((ctx) => ctx.db.query("vehicleEdits").collect());
    expect(edit[0].payload).toMatchObject({ sourcedSupplierId: d.gulf, sourcedFromName: "Gulf Motors" });
  });

  test("the stored name is a snapshot: a later rename of the master does not rewrite the vehicle (N3)", async () => {
    const d = await seedDealer("c2");
    const id = await createSourcedVehicle(d);
    await renameSupplier(d.t, d.gulf, "Gulf Motors International");
    expect((await vehicleRow(d, id))?.sourcedFromName).toBe("Gulf Motors");
  });

  test("a name-only call (the shape the mobile app sends) is refused and writes nothing", async () => {
    const d = await seedDealer("c3");
    const before = await worldCounts(d);
    await expectAppError(
      d.asOwner.mutation(api.vehicles.create, {
        idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, ...sourcedBody, sourcedFromName: "Gulf Motors",
      }),
      ...identityRequired
    );
    expect(await worldCounts(d)).toEqual(before);
  });

  test("a foreign-organization id and a missing id get the SAME code and message (no existence oracle)", async () => {
    const d = await seedDealer("c4");
    const before = await worldCounts(d);
    await expectAppError(createSourcedVehicle(d, { sourcedSupplierId: d.foreign }), ...notFound);
    const gone = await seedSupplier(d.t, { orgId: d.orgId, userId: d.ownerId, displayName: "Removed Later" });
    await d.t.run((ctx) => ctx.db.delete(gone));
    await expectAppError(createSourcedVehicle(d, { sourcedSupplierId: gone }), ...notFound);
    expect(await worldCounts(d)).toEqual(before);
  });

  test("an inactive supplier takes no new vehicle", async () => {
    const d = await seedDealer("c5");
    const before = await worldCounts(d);
    await expectAppError(createSourcedVehicle(d, { sourcedSupplierId: d.dormant }), ...inactive);
    expect(await worldCounts(d)).toEqual(before);
  });

  test("the creditor id on a consignment car is a role conflict (N9)", async () => {
    const d = await seedDealer("c6");
    const before = await worldCounts(d);
    await expectAppError(createSourcedVehicle(d, { purchaseSupplierId: d.creditor }), ...roleConflict);
    expect(await worldCounts(d)).toEqual(before);
  });

  test("the same idempotency key with a different supplier id is a conflict, not a dedupe (N12)", async () => {
    const d = await seedDealer("c7");
    const idempotencyKey = crypto.randomUUID();
    await createSourcedVehicle(d, { idempotencyKey });
    await expect(createSourcedVehicle(d, { idempotencyKey, sourcedSupplierId: d.creditor })).rejects.toThrow();
    expect(await d.t.run((ctx) => ctx.db.query("vehicles").collect())).toHaveLength(1);
  });

  test("a retry after the master was renamed replays the first execution and writes no second car (N12)", async () => {
    const d = await seedDealer("c8");
    const idempotencyKey = crypto.randomUUID();
    const first = await createSourcedVehicle(d, { idempotencyKey });
    await renameSupplier(d.t, d.gulf, "Gulf Motors Renamed");
    const second = await createSourcedVehicle(d, { idempotencyKey });
    expect(second).toBe(first);
    expect((await vehicleRow(d, first))?.sourcedFromName).toBe("Gulf Motors");
  });
});

describe("vehicles.create: the creditor of an OWNED car bought ON_ACCOUNT", () => {
  test("the payable carries the id, the version and the SERVER name; the journal is the unchanged one (N4)", async () => {
    const d = await seedDealer("o1");
    const id = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, ...onAccountBody,
      purchaseSupplierId: d.creditor, purchaseSupplierName: "typed by the client",
    });
    const payables = await payablesOf(d, id);
    expect(payables).toHaveLength(1);
    expect(payables[0]).toMatchObject({
      supplierId: d.creditor, supplierSnapshotVersion: 1, sourcedFromName: "Credit Supplier Co", amountDue: 10000, status: "PENDING",
    });
    const vehicle = await vehicleRow(d, id);
    expect(vehicle?.sourcedSupplierId).toBeUndefined();
    expect(vehicle?.sourcedFromName).toBeUndefined();
    const events = await d.t.run((ctx) => ctx.db.query("accountingEvents").collect());
    expect(events.filter((e) => e.eventType === "VEHICLE_ACQUIRED")).toHaveLength(1);
  });

  test("a name-only creditor is refused and writes nothing", async () => {
    const d = await seedDealer("o2");
    const before = await worldCounts(d);
    await expectAppError(
      d.asOwner.mutation(api.vehicles.create, {
        idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, ...onAccountBody, purchaseSupplierName: "Credit Supplier Co",
      }),
      ...identityRequired
    );
    expect(await worldCounts(d)).toEqual(before);
  });

  test.each([
    ["a foreign id", "foreign", notFound],
    ["an inactive supplier", "dormant", inactive],
  ] as const)("%s as creditor is refused and writes nothing", async (_label, which, expected) => {
    const d = await seedDealer(`o3${which}`);
    const before = await worldCounts(d);
    await expectAppError(
      d.asOwner.mutation(api.vehicles.create, {
        idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, ...onAccountBody, purchaseSupplierId: d[which],
      }),
      expected[0],
      expected[1]
    );
    expect(await worldCounts(d)).toEqual(before);
  });

  test("the consignment id on an owned car, and a creditor id on a cash purchase, are role conflicts", async () => {
    const d = await seedDealer("o4");
    const before = await worldCounts(d);
    await expectAppError(
      d.asOwner.mutation(api.vehicles.create, {
        idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, ...onAccountBody,
        purchaseSupplierId: d.creditor, sourcedSupplierId: d.gulf,
      }),
      ...roleConflict
    );
    await expectAppError(
      d.asOwner.mutation(api.vehicles.create, {
        idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, sourceType: "STOCK",
        purchasePrice: 10000, purchasePaymentMethod: "CASH", purchaseSupplierId: d.creditor,
      }),
      ...roleConflict
    );
    expect(await worldCounts(d)).toEqual(before);
  });
});

describe("vehicles.createSourced (Sales Wizard)", () => {
  const body = {
    make: "Kia", model: "Sportage", year: 2021, color: "Black", mileage: 5000,
    fuelType: "Gasoline", transmission: "Automatic", sourceCost: 9000, sellingPrice: 12000,
  };

  test("stores the id and the server name", async () => {
    const d = await seedDealer("s1");
    const id = await d.asOwner.mutation(api.vehicles.createSourced, {
      orgId: d.orgId, ...body, sourcedSupplierId: d.gulf, sourcedFromName: "typed by the client",
    });
    expect(await vehicleRow(d, id)).toMatchObject({ sourcedSupplierId: d.gulf, sourcedFromName: "Gulf Motors", sourceType: "SOURCED" });
  });

  test("a name-only call is refused; foreign and inactive ids are refused; nothing is written", async () => {
    const d = await seedDealer("s2");
    const before = await worldCounts(d);
    await expectAppError(d.asOwner.mutation(api.vehicles.createSourced, { orgId: d.orgId, ...body, sourcedFromName: "Gulf Motors" }), ...identityRequired);
    await expectAppError(d.asOwner.mutation(api.vehicles.createSourced, { orgId: d.orgId, ...body, sourcedSupplierId: d.foreign }), ...notFound);
    await expectAppError(d.asOwner.mutation(api.vehicles.createSourced, { orgId: d.orgId, ...body, sourcedSupplierId: d.dormant }), ...inactive);
    expect(await worldCounts(d)).toEqual(before);
  });
});

describe("vehicles.update: changing the consignment supplier", () => {
  test("by id stores the id and the server name while no money exists", async () => {
    const d = await seedDealer("u1");
    const id = await createSourcedVehicle(d);
    const other = await seedSupplier(d.t, { orgId: d.orgId, userId: d.ownerId, displayName: "Other Motors" });
    await d.asOwner.mutation(api.vehicles.update, {
      orgId: d.orgId, vehicleId: id, sourceType: "SOURCED", sourcedSupplierId: other, sourcedFromName: "typed by the client",
    });
    expect(await vehicleRow(d, id)).toMatchObject({ sourcedSupplierId: other, sourcedFromName: "Other Motors" });
  });

  test("a typed name that differs from the stored one, with no id, is refused (a mobile-shaped write)", async () => {
    const d = await seedDealer("u2");
    const id = await createSourcedVehicle(d);
    const before = await worldCounts(d);
    await expectAppError(
      d.asOwner.mutation(api.vehicles.update, { orgId: d.orgId, vehicleId: id, sourceType: "SOURCED", sourcedFromName: "Someone Else" }),
      ...identityRequired
    );
    expect(await worldCounts(d)).toEqual(before);
    expect((await vehicleRow(d, id))?.sourcedFromName).toBe("Gulf Motors");
  });

  test("echoing the stored name back unchanged is not a supplier write: an unrelated edit still works", async () => {
    const d = await seedDealer("u3");
    const id = await createSourcedVehicle(d);
    await d.asOwner.mutation(api.vehicles.update, {
      orgId: d.orgId, vehicleId: id, sourceType: "SOURCED", sourcedFromName: "Gulf Motors", color: "Blue",
    });
    expect(await vehicleRow(d, id)).toMatchObject({ color: "Blue", sourcedFromName: "Gulf Motors", sourcedSupplierId: d.gulf });
  });

  test("re-sending the SAME id is a no-op even after the supplier was deactivated and money exists", async () => {
    const d = await seedDealer("u4");
    const id = await createSourcedVehicle(d);
    await insertPayable(d, id);
    await d.t.run((ctx) => ctx.db.patch(d.gulf, { status: "INACTIVE" }));
    await d.asOwner.mutation(api.vehicles.update, {
      orgId: d.orgId, vehicleId: id, sourceType: "SOURCED", sourcedSupplierId: d.gulf, color: "Green",
    });
    expect(await vehicleRow(d, id)).toMatchObject({ color: "Green", sourcedSupplierId: d.gulf });
  });

  /** Seeds one kind of money record on a consigned car, then proves a supplier change is refused and writes nothing. */
  async function expectSupplierChangeRefusedAfter(
    suffix: string,
    addMoney: (d: Dealer, vehicleId: Id<"vehicles">) => Promise<void>,
    refusal: "frozen" | "held-concession" = "frozen"
  ) {
    const d = await seedDealer(suffix);
    const id = await createSourcedVehicle(d);
    const other = await seedSupplier(d.t, { orgId: d.orgId, userId: d.ownerId, displayName: "Other Motors" });
    await addMoney(d, id);
    const before = await worldCounts(d);
    const attempt = d.asOwner.mutation(api.vehicles.update, {
      orgId: d.orgId, vehicleId: id, sourceType: "SOURCED", sourcedSupplierId: other,
    });
    if (refusal === "held-concession") {
      // The held-concession refusal is its own (string) ConvexError, raised before the money check.
      await expect(attempt).rejects.toMatchObject({ data: SUPPLIER_CONCESSION_REFUSALS.HELD_BY_DEAL });
    } else {
      await expectAppError(attempt, ...linkFrozen);
    }
    expect(await worldCounts(d)).toEqual(before);
    expect(await vehicleRow(d, id)).toMatchObject({ sourcedSupplierId: d.gulf, sourcedFromName: "Gulf Motors" });
  }

  test("is frozen once a supplier payable exists (N11): the id and the name stay as they were", async () => {
    await expectSupplierChangeRefusedAfter("u5a", insertPayable);
  });

  test("is frozen by a supplier receivable alone, as a direct-to-supplier sale leaves it with no payable (N11)", async () => {
    await expectSupplierChangeRefusedAfter("u5b", insertReceivableOnly);
  });

  test("is frozen by a supplier cost recovery alone (N11)", async () => {
    await expectSupplierChangeRefusedAfter("u5d", insertRecoveryOnly);
  });

  test("is frozen once a supplier-borne expense exists (N11)", async () => {
    await expectSupplierChangeRefusedAfter("u5e", insertSupplierExpense);
  });

  test("is refused while a finance application holds a supplier concession on the car", async () => {
    await expectSupplierChangeRefusedAfter("u5f", insertHeldConcession, "held-concession");
  });
  test("fails closed when the supplier-borne expense scan fills its bound (200) without a hit, and not one row earlier", async () => {
    const d = await seedDealer("u5c");
    const id = await createSourcedVehicle(d);
    const other = await seedSupplier(d.t, { orgId: d.orgId, userId: d.ownerId, displayName: "Other Motors" });
    const change = () =>
      d.asOwner.mutation(api.vehicles.update, { orgId: d.orgId, vehicleId: id, sourceType: "SOURCED", sourcedSupplierId: other });
    // 199 dealership-borne expenses: the scan sees them all, finds no supplier-borne row, and allows the change.
    await insertDealershipExpenses(d, id, 199);
    await change();
    expect(await vehicleRow(d, id)).toMatchObject({ sourcedSupplierId: other, sourcedFromName: "Other Motors" });
    // The 200th fills the bound: the scan cannot prove the absence of a supplier-borne row, so it refuses.
    await insertDealershipExpenses(d, id, 1);
    const before = await worldCounts(d);
    await expectAppError(
      d.asOwner.mutation(api.vehicles.update, { orgId: d.orgId, vehicleId: id, sourceType: "SOURCED", sourcedSupplierId: d.gulf }),
      ...linkFrozen
    );
    expect(await worldCounts(d)).toEqual(before);
    expect(await vehicleRow(d, id)).toMatchObject({ sourcedSupplierId: other });
  });

  test("a consignment id sent for an owned car is a role conflict", async () => {
    const d = await seedDealer("u6");
    const id = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, sourceType: "STOCK", purchasePrice: 8000, purchasePaymentMethod: "CASH",
    });
    await expectAppError(
      d.asOwner.mutation(api.vehicles.update, { orgId: d.orgId, vehicleId: id, sourceType: "STOCK", sourcedSupplierId: d.gulf }),
      ...roleConflict
    );
  });
});

describe("vehicles.update: the creditor when a first purchase price posts on account", () => {
  test("needs the creditor's id; the payable carries it and the server name", async () => {
    const d = await seedDealer("p1");
    const id = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, sourceType: "STOCK",
    });
    const before = await worldCounts(d);
    await expectAppError(
      d.asOwner.mutation(api.vehicles.update, {
        orgId: d.orgId, vehicleId: id, sourceType: "STOCK", purchasePrice: 7000, purchasePaymentMethod: "ON_ACCOUNT",
        purchaseSupplierName: "Credit Supplier Co",
      }),
      ...identityRequired
    );
    expect(await worldCounts(d)).toEqual(before);
    await d.asOwner.mutation(api.vehicles.update, {
      orgId: d.orgId, vehicleId: id, sourceType: "STOCK", purchasePrice: 7000, purchasePaymentMethod: "ON_ACCOUNT",
      purchaseSupplierId: d.creditor,
    });
    const payables = await payablesOf(d, id);
    expect(payables).toHaveLength(1);
    expect(payables[0]).toMatchObject({ supplierId: d.creditor, sourcedFromName: "Credit Supplier Co", amountDue: 7000 });
  });
});

describe("vehicles.importBulk", () => {
  const row = {
    make: "Toyota", model: "Camry", year: 2019, color: "Silver", fuelType: "Gasoline",
    transmission: "Automatic", sellingPrice: 15000, mileage: 1000,
  };

  test("a SOURCED row stores its master id and the server name; a name-only row refuses the whole file", async () => {
    const d = await seedDealer("i1");
    const sourcedRow = { ...row, vin: "IMPORTSRC0000001", sourceType: "SOURCED", sourceCost: 9000 };
    const before = await worldCounts(d);
    await expectAppError(
      d.asOwner.mutation(api.vehicles.importBulk, {
        orgId: d.orgId, acquisitionPosting: "OPENING_STOCK", vehicles: [{ ...sourcedRow, sourcedFromName: "Gulf Motors" }],
      }),
      ...identityRequired
    );
    expect(await worldCounts(d)).toEqual(before);
    await d.asOwner.mutation(api.vehicles.importBulk, {
      orgId: d.orgId, acquisitionPosting: "OPENING_STOCK",
      vehicles: [{ ...sourcedRow, sourcedSupplierId: d.gulf, sourcedFromName: "typed by the client" }],
    });
    const stored = await d.t.run((ctx) => ctx.db.query("vehicles").collect());
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ sourcedSupplierId: d.gulf, sourcedFromName: "Gulf Motors" });
  });

  test("a PURCHASE ON_ACCOUNT row opens the payable under the creditor id; missing, foreign and inactive ids refuse the file", async () => {
    const d = await seedDealer("i2");
    const owned = { ...row, vin: "IMPORTOWN0000001", sourceType: "STOCK", purchasePrice: 9000 };
    const call = (rowOverrides: Record<string, unknown>) =>
      d.asOwner.mutation(api.vehicles.importBulk, {
        orgId: d.orgId, acquisitionPosting: "PURCHASE", importId: crypto.randomUUID(), purchasePaymentMethod: "ON_ACCOUNT",
        vehicles: [{ ...owned, rowId: 1, ...rowOverrides }],
      });
    const before = await worldCounts(d);
    await expectAppError(call({ purchaseSupplierName: "Credit Supplier Co" }), ...identityRequired);
    await expectAppError(call({ purchaseSupplierId: d.foreign }), ...notFound);
    await expectAppError(call({ purchaseSupplierId: d.dormant }), ...inactive);
    expect(await worldCounts(d)).toEqual(before);
    await call({ purchaseSupplierId: d.creditor, purchaseSupplierName: "typed by the client" });
    const payables = await d.t.run((ctx) => ctx.db.query("vehicleSupplierPayables").collect());
    expect(payables).toHaveLength(1);
    expect(payables[0]).toMatchObject({ supplierId: d.creditor, sourcedFromName: "Credit Supplier Co", amountDue: 9000 });
  });

  describe("a proven replay of a purchase import after its supplier was deactivated", () => {
    const owned = { ...row, vin: "IMPORTRPL000001", sourceType: "STOCK", purchasePrice: 9000 };
    const sourced = { ...row, vin: "IMPORTRPL000002", sourceType: "SOURCED", sourceCost: 8000 };
    const purchase = (d: Dealer, importId: string, vehicles: Array<Record<string, unknown>>) =>
      d.asOwner.mutation(api.vehicles.importBulk, {
        orgId: d.orgId, acquisitionPosting: "PURCHASE", importId, purchasePaymentMethod: "ON_ACCOUNT", vehicles,
      } as never);

    test("is recognised as already recorded and posts nothing more (a lost-response retry must not be refused)", async () => {
      const d = await seedDealer("i3");
      const importId = crypto.randomUUID();
      const rows = [
        { ...owned, rowId: 1, purchaseSupplierId: d.creditor },
        { ...sourced, rowId: 2, sourcedSupplierId: d.gulf },
      ];
      expect(await purchase(d, importId, rows)).toMatchObject({ inserted: 2, alreadyRecorded: 0 });
      const before = await worldCounts(d);
      expect(before.payables).toBe(1);
      await d.t.run(async (ctx) => {
        await ctx.db.patch(d.creditor, { status: "INACTIVE" });
        await ctx.db.patch(d.gulf, { status: "INACTIVE" });
      });
      // The identical call, resent: it already ran, so it is a no-op rather than SUPPLIER_INACTIVE.
      expect(await purchase(d, importId, rows)).toMatchObject({ inserted: 0, alreadyRecorded: 2 });
      expect(await worldCounts(d)).toEqual(before);
      const payables = await d.t.run((ctx) => ctx.db.query("vehicleSupplierPayables").collect());
      expect(payables).toHaveLength(1);
      expect(payables[0]).toMatchObject({ supplierId: d.creditor, amountDue: 9000 });
    });

    test("does not excuse NEW use: another import with the same inactive creditor, or a changed replay, is still refused", async () => {
      const d = await seedDealer("i4");
      const importId = crypto.randomUUID();
      const first = { ...owned, rowId: 1, purchaseSupplierId: d.creditor };
      await purchase(d, importId, [first]);
      await d.t.run((ctx) => ctx.db.patch(d.creditor, { status: "INACTIVE" }));
      const before = await worldCounts(d);
      // A different import is a new use of the inactive supplier.
      await expectAppError(purchase(d, crypto.randomUUID(), [{ ...first, vin: "IMPORTRPL000003" }]), ...inactive);
      // The same key with a different fact is not a replay: the fingerprint conflict still refuses it.
      await expect(purchase(d, importId, [{ ...first, purchasePrice: 9500 }])).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
      // The same key with another organization's supplier is still refused, never trusted as a replay.
      await expect(purchase(d, importId, [{ ...first, purchaseSupplierId: d.foreign }])).rejects.toThrow(/IDEMPOTENCY_CONFLICT|SUPPLIER_NOT_FOUND/);
      expect(await worldCounts(d)).toEqual(before);
    });

    /**
     * The PURCHASE validator accepts any integer row number (Number.isInteger), so evidence exists for
     * -1 and for 2^53 as well. A retry must be recognised for every row number the command ever accepted.
     */
    async function expectReplayRecognisedForRowId(suffix: string, rowId: number) {
      const d = await seedDealer(suffix);
      const importId = crypto.randomUUID();
      const first = { ...owned, rowId, purchaseSupplierId: d.creditor };
      expect(await purchase(d, importId, [first])).toMatchObject({ inserted: 1, alreadyRecorded: 0 });
      await d.t.run((ctx) => ctx.db.patch(d.creditor, { status: "INACTIVE" }));
      const before = await worldCounts(d);
      expect(await purchase(d, importId, [first])).toMatchObject({ inserted: 0, alreadyRecorded: 1 });
      expect(await worldCounts(d)).toEqual(before);
      // The same evidence key with a different fact is still a conflict, never a trusted replay.
      await expect(purchase(d, importId, [{ ...first, purchasePrice: 9500 }])).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
      // A new use of the inactive creditor under the same row number is still refused.
      await expectAppError(purchase(d, crypto.randomUUID(), [{ ...first, vin: "IMPORTRPL000004" }]), ...inactive);
      expect(await worldCounts(d)).toEqual(before);
    }

    test("an accepted negative row number is recognised as a replay after its supplier was deactivated", async () => {
      await expectReplayRecognisedForRowId("i5", -1);
    });

    test("an accepted row number beyond the safe integer range (2^53) is recognised as a replay after its supplier was deactivated", async () => {
      await expectReplayRecognisedForRowId("i6", 9007199254740992);
    });

  });
});

describe("vehicleEdits: request and approval", () => {
  test("requestCreate stores the id and the server name in the request; a name-only request is refused", async () => {
    const d = await seedDealer("e1");
    const before = await worldCounts(d);
    await expectAppError(
      d.asClerk.mutation(api.vehicleEdits.requestCreate, {
        orgId: d.orgId, payload: { ...baseVehicle, ...sourcedBody, sourcedFromName: "Gulf Motors" },
      }),
      ...identityRequired
    );
    expect(await worldCounts(d)).toEqual(before);
    const requestId = await d.asClerk.mutation(api.vehicleEdits.requestCreate, {
      orgId: d.orgId, payload: { ...baseVehicle, ...sourcedBody, sourcedSupplierId: d.gulf, sourcedFromName: "typed by the client" },
    });
    const request = await d.t.run((ctx) => ctx.db.get(requestId));
    expect(request?.payload).toMatchObject({ sourcedSupplierId: d.gulf, sourcedFromName: "Gulf Motors" });
  });

  test("approval creates the vehicle with the id and the CURRENT server name, and refuses a supplier deactivated since", async () => {
    const d = await seedDealer("e2");
    const requestId = await d.asClerk.mutation(api.vehicleEdits.requestCreate, {
      orgId: d.orgId, payload: { ...baseVehicle, ...sourcedBody, sourcedSupplierId: d.gulf },
    });
    await d.t.run((ctx) => ctx.db.patch(d.gulf, { status: "INACTIVE" }));
    const before = await worldCounts(d);
    await expectAppError(d.asOwner.mutation(api.vehicleEdits.resolve, { orgId: d.orgId, requestId, status: "APPROVED" }), ...inactive);
    expect(await worldCounts(d)).toEqual(before);
    await d.t.run((ctx) => ctx.db.patch(d.gulf, { status: "ACTIVE" }));
    await renameSupplier(d.t, d.gulf, "Gulf Motors Renamed");
    await d.asOwner.mutation(api.vehicleEdits.resolve, { orgId: d.orgId, requestId, status: "APPROVED" });
    const stored = await d.t.run((ctx) => ctx.db.query("vehicles").collect());
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ sourcedSupplierId: d.gulf, sourcedFromName: "Gulf Motors Renamed" });
    expect("purchaseSupplierId" in stored[0]).toBe(false);
  });

  test("a legacy name-only pending request cannot be approved: it stays pending and creates nothing", async () => {
    const d = await seedDealer("e3");
    const requestId = await d.t.run((ctx) =>
      ctx.db.insert("vehicleEdits", {
        orgId: d.orgId, requestedBy: d.ownerId, type: "CREATE", status: "PENDING", createdAt: Date.now(),
        payload: { ...baseVehicle, ...sourcedBody, sourcedFromName: "Gulf Motors" },
      })
    );
    await expectAppError(d.asOwner.mutation(api.vehicleEdits.resolve, { orgId: d.orgId, requestId, status: "APPROVED" }), ...identityRequired);
    expect((await d.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("PENDING");
    expect(await d.t.run((ctx) => ctx.db.query("vehicles").collect())).toHaveLength(0);
  });

  test("an ON_ACCOUNT request carries the creditor id through approval to the payable", async () => {
    const d = await seedDealer("e4");
    const requestId = await d.asClerk.mutation(api.vehicleEdits.requestCreate, {
      orgId: d.orgId, payload: { ...baseVehicle, ...onAccountBody, purchaseSupplierId: d.creditor },
    });
    await d.asOwner.mutation(api.vehicleEdits.resolve, { orgId: d.orgId, requestId, status: "APPROVED" });
    const payables = await d.t.run((ctx) => ctx.db.query("vehicleSupplierPayables").collect());
    expect(payables).toHaveLength(1);
    expect(payables[0]).toMatchObject({ supplierId: d.creditor, sourcedFromName: "Credit Supplier Co" });
  });

  test("an approver's ownership decision carries the supplier id too, and a name-only decision is refused", async () => {
    const d = await seedDealer("e5");
    const requestId = await d.t.run((ctx) =>
      ctx.db.insert("vehicleEdits", {
        orgId: d.orgId, requestedBy: d.ownerId, type: "CREATE", status: "PENDING", createdAt: Date.now(), payload: { ...baseVehicle },
      })
    );
    await expectAppError(
      d.asOwner.mutation(api.vehicleEdits.resolve, {
        orgId: d.orgId, requestId, status: "APPROVED", ownership: { ...sourcedBody, sourcedFromName: "Gulf Motors" },
      }),
      ...identityRequired
    );
    await d.asOwner.mutation(api.vehicleEdits.resolve, {
      orgId: d.orgId, requestId, status: "APPROVED", ownership: { ...sourcedBody, sourcedSupplierId: d.gulf },
    });
    const stored = await d.t.run((ctx) => ctx.db.query("vehicles").collect());
    expect(stored[0]).toMatchObject({ sourcedSupplierId: d.gulf, sourcedFromName: "Gulf Motors" });
  });

  test("an UPDATE request that changes the supplier is refused at request time AND at approval once money exists (N11)", async () => {
    const d = await seedDealer("e6");
    const id = await createSourcedVehicle(d);
    const other = await seedSupplier(d.t, { orgId: d.orgId, userId: d.ownerId, displayName: "Other Motors" });
    const requestId = await d.asClerk.mutation(api.vehicleEdits.requestUpdate, {
      orgId: d.orgId, vehicleId: id, payload: { sourcedSupplierId: other },
    });
    await insertPayable(d, id);
    await expectAppError(d.asOwner.mutation(api.vehicleEdits.resolve, { orgId: d.orgId, requestId, status: "APPROVED" }), ...linkFrozen);
    expect(await vehicleRow(d, id)).toMatchObject({ sourcedSupplierId: d.gulf, sourcedFromName: "Gulf Motors" });
    await expectAppError(
      d.asClerk.mutation(api.vehicleEdits.requestUpdate, { orgId: d.orgId, vehicleId: id, payload: { sourcedSupplierId: other } }),
      ...linkFrozen
    );
    await expectAppError(
      d.asClerk.mutation(api.vehicleEdits.requestUpdate, { orgId: d.orgId, vehicleId: id, payload: { sourcedFromName: "Someone Else" } }),
      ...identityRequired
    );
  });

  test("an UPDATE request that changes the supplier is refused at request time while a finance application holds a concession, and stores no request", async () => {
    const d = await seedDealer("e8");
    const id = await createSourcedVehicle(d);
    const other = await seedSupplier(d.t, { orgId: d.orgId, userId: d.ownerId, displayName: "Other Motors" });
    await insertHeldConcession(d, id);
    const before = await worldCounts(d);
    await expect(
      d.asClerk.mutation(api.vehicleEdits.requestUpdate, { orgId: d.orgId, vehicleId: id, payload: { sourcedSupplierId: other } })
    ).rejects.toMatchObject({ data: SUPPLIER_CONCESSION_REFUSALS.HELD_BY_DEAL });
    expect(await worldCounts(d)).toEqual(before);
    expect(await vehicleRow(d, id)).toMatchObject({ sourcedSupplierId: d.gulf, sourcedFromName: "Gulf Motors" });
  });

  test("an UPDATE request never stores a typed creditor name: only the server's snapshot, beside the id", async () => {
    const d = await seedDealer("e7");
    // An owned CASH car: its acquisition already posted, so a creditor name has no role in this request.
    const owned = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, sourceType: "STOCK", purchasePrice: 8000, purchasePaymentMethod: "CASH",
    });
    const noRole = await d.asClerk.mutation(api.vehicleEdits.requestUpdate, {
      orgId: d.orgId, vehicleId: owned, payload: { color: "Blue", purchaseSupplierName: "Typed Creditor Co" },
    });
    expect((await d.t.run((ctx) => ctx.db.get(noRole)))?.payload).toEqual({ color: "Blue" });

    // An owned car with no price yet: the request posts its acquisition ON_ACCOUNT, so the id and the server name are stored.
    const unpriced = await d.asOwner.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(), orgId: d.orgId, ...baseVehicle, vin: "1HGCM82633A000002", sourceType: "STOCK",
    });
    const posting = await d.asClerk.mutation(api.vehicleEdits.requestUpdate, {
      orgId: d.orgId, vehicleId: unpriced,
      payload: { purchasePrice: 7000, purchasePaymentMethod: "ON_ACCOUNT", purchaseSupplierId: d.creditor, purchaseSupplierName: "typed by the client" },
    });
    expect((await d.t.run((ctx) => ctx.db.get(posting)))?.payload).toMatchObject({
      purchaseSupplierId: d.creditor, purchaseSupplierName: "Credit Supplier Co", purchasePrice: 7000,
    });
  });
});

async function insertPayable(d: Dealer, vehicleId: Id<"vehicles">) {
  const now = Date.now();
  await d.t.run((ctx) =>
    ctx.db.insert("vehicleSupplierPayables", {
      orgId: d.orgId, vehicleId, sourcedFromName: "Gulf Motors", supplierId: d.gulf, amountDue: 9000, currency: "JOD",
      status: "PENDING", createdBy: d.ownerId, createdAt: now, updatedAt: now,
    })
  );
}

/** A direct-to-supplier sale: a receivable from the supplier and NO payable (the supplier is paid outside the books). */
async function insertReceivableOnly(d: Dealer, vehicleId: Id<"vehicles">) {
  const now = Date.now();
  await d.t.run(async (ctx) => {
    const customerId = await ctx.db.insert("customers", { orgId: d.orgId, firstName: "Dana", lastName: "Saleh" });
    const saleId = await ctx.db.insert("sales", {
      orgId: d.orgId, vehicleId, customerId, salespersonId: d.ownerId, salePrice: 12000, saleDate: now, status: "COMPLETED",
    });
    await ctx.db.insert("vehicleSupplierReceivables", {
      orgId: d.orgId, vehicleId, saleId, sourcedFromName: "Gulf Motors", supplierId: d.gulf, amountDue: 2500,
      currency: "JOD", status: "OPEN", createdBy: d.ownerId, createdAt: now, updatedAt: now,
    });
  });
  expect(await payablesOf(d, vehicleId)).toHaveLength(0);
}

/** A cost recovery whose source expense is NOT supplier-borne in the table, so only the recovery row can freeze the link. */
async function insertRecoveryOnly(d: Dealer, vehicleId: Id<"vehicles">) {
  const now = Date.now();
  await d.t.run(async (ctx) => {
    const expenseId = await ctx.db.insert("expenses", {
      orgId: d.orgId, vehicleId, amount: 100, date: now, category: "REPAIR", title: "Repair", status: "PENDING",
    });
    await ctx.db.insert("supplierCostRecoveries", {
      orgId: d.orgId, sourcedFromName: "Gulf Motors", supplierId: d.gulf, amountDueMinor: 100_000, amountRecoveredMinor: 0,
      currency: "JOD", receiptSeq: 0, status: "OPEN", createdBy: d.ownerId, createdAt: now, updatedAt: now,
      vehicleId, expenseId, sourceEventKey: `evt-${crypto.randomUUID()}`,
    });
  });
  expect(await payablesOf(d, vehicleId)).toHaveLength(0);
}

/** An open finance application that holds a supplier concession against the car. */
async function insertHeldConcession(d: Dealer, vehicleId: Id<"vehicles">) {
  const now = Date.now();
  await d.t.run(async (ctx) => {
    const customerId = await ctx.db.insert("customers", { orgId: d.orgId, firstName: "Dana", lastName: "Saleh" });
    const companyId = await ctx.db.insert("financeCompanies", {
      orgId: d.orgId, name: "Test Bank", isActive: true, profitRate: 5.5, maxTermMonths: 72, gracePeriodMonths: 3,
    });
    const quoteId = await ctx.db.insert("quotes", {
      orgId: d.orgId, vehicleId, customerId, vehiclePrice: 12000, downPayment: 2000, totalFinancedAmount: 10000,
      termMonths: 24, status: "DRAFT", companyId, createdBy: d.ownerId, createdAt: now,
    });
    await ctx.db.insert("financeApplications", {
      orgId: d.orgId, customerId, vehicleId, companyId, quoteId, salespersonId: d.ownerId, status: "APPROVED",
      createdAt: now, updatedAt: now, supplierGapShareMinor: 400_000,
    });
  });
  expect(await payablesOf(d, vehicleId)).toHaveLength(0);
}

/** Expenses that are NOT borne by the supplier, to fill the freeze scan's bound without a supplier-borne hit. */
async function insertDealershipExpenses(d: Dealer, vehicleId: Id<"vehicles">, count: number) {
  await d.t.run(async (ctx) => {
    for (let i = 0; i < count; i += 1) {
      await ctx.db.insert("expenses", {
        orgId: d.orgId, vehicleId, amount: 1, date: Date.now(), category: "REPAIR", title: `Dealership repair ${i}`, status: "PENDING",
      });
    }
  });
}

async function insertSupplierExpense(d: Dealer, vehicleId: Id<"vehicles">) {
  await d.t.run((ctx) =>
    ctx.db.insert("expenses", {
      orgId: d.orgId, vehicleId, amount: 100, date: Date.now(), category: "REPAIR", title: "Supplier-borne repair",
      status: "PENDING", costBearer: "SUPPLIER",
    })
  );
}

describe("the data browser (adminData.adminUpdateRecord) and the consignment supplier link", () => {
  async function withAdmin<T>(fn: () => Promise<T>): Promise<T> {
    const previous = process.env.SUPER_ADMIN_EMAILS;
    process.env.SUPER_ADMIN_EMAILS = "admin@autoflow.dev";
    process.env.CLERK_JWT_ISSUER_DOMAIN ??= "https://test.clerk.accounts.dev";
    process.env.NEXT_PUBLIC_APP_URL ??= "https://test.example.com";
    try {
      return await fn();
    } finally {
      if (previous === undefined) delete process.env.SUPER_ADMIN_EMAILS;
      else process.env.SUPER_ADMIN_EMAILS = previous;
    }
  }

  test("a CHANGE to sourcedSupplierId (another supplier, or another organization's) is refused; an unchanged round trip still saves", async () => {
    await withAdmin(async () => {
      const d = await seedDealer("adm1");
      await d.t.run((ctx) => ctx.db.insert("users", { clerkId: "dev_868", email: "admin@autoflow.dev" }));
      const asAdmin = d.t.withIdentity({ subject: "dev_868" });
      const id = await createSourcedVehicle(d);
      const locked = [d.creditor, d.foreign];
      for (const supplierId of locked) {
        await expectAppError(
          asAdmin.mutation(api.adminData.adminUpdateRecord, { table: "vehicles", id, patch: { sourcedSupplierId: supplierId } }),
          "VEHICLE_OWNERSHIP_FIELDS_LOCKED",
          VEHICLE_SOURCE_SHAPE_MESSAGES.VEHICLE_OWNERSHIP_FIELDS_LOCKED
        );
      }
      expect(await vehicleRow(d, id)).toMatchObject({ sourcedSupplierId: d.gulf, sourcedFromName: "Gulf Motors" });

      // The editor re-sends the whole record: the unchanged link is not a change.
      await asAdmin.mutation(api.adminData.adminUpdateRecord, {
        table: "vehicles", id, patch: { sourcedSupplierId: d.gulf, color: "Green" },
      });
      expect(await vehicleRow(d, id)).toMatchObject({ sourcedSupplierId: d.gulf, color: "Green" });
    });
  });
});

describe("readers of a stored sourcedSupplierId re-check the organization (N6)", () => {
  test("the buy-out conversion record keeps the supplier id of the vehicle's own organization and drops a foreign one", async () => {
    const d = await seedDealer("rd1");
    const own = await createSourcedVehicle(d);
    const corrupt = await createSourcedVehicle(d, { vin: "1HGCM82633A000002" });
    // Corruption no write here produces: a vehicle whose stored link points at another organization's supplier.
    await d.t.run((ctx) => ctx.db.patch(corrupt, { sourcedSupplierId: d.foreign }));

    for (const vehicleId of [own, corrupt]) {
      await d.asOwner.mutation(api.vehicles.update, {
        orgId: d.orgId, vehicleId, sourceType: "STOCK", purchasePrice: 8000, purchasePaymentMethod: "CASH",
      });
    }
    const conversions = await d.t.run((ctx) => ctx.db.query("vehicleOwnershipConversions").take(10));
    const byVehicle = (id: Id<"vehicles">) => conversions.find((row) => row.vehicleId === id);
    expect(byVehicle(own)?.supplierId).toBe(d.gulf);
    expect(byVehicle(corrupt)?.supplierId).toBeUndefined();
    expect(byVehicle(corrupt)?.supplierName).toBe("Gulf Motors");
  });
});