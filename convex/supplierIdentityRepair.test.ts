/**
 * SCRUM-868 P3 round-2 remediation: the release repair that gives P2-era supplier money rows their id.
 *
 * Invariant under test. A supplier money row written before supplier ids existed (no `supplierId`) is
 * given an id ONLY from the frozen supplier link of the vehicle it belongs to, and only when that
 * supplier belongs to the same organization and the name on the row is the supplier master's own name
 * (or one of its aliases) at a version the master has reached. A supplier id is never derived from a
 * name. Every row the repair cannot prove stays refused, is counted, and the counts-only check reports it.
 */
import { describe, expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { renameSupplier, seedSupplier } from "../test-utils/supplierFixture";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS } from "./utils/permissions";
import { SUPPLIER_ERROR, SUPPLIER_IDENTITY_UNRESOLVED_MESSAGE } from "./utils/supplierRegistry";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.ts");

type Harness = ReturnType<typeof convexTestWithComponents>;
type RepairPhase = "PAYABLES" | "RECEIVABLES" | "RECOVERIES" | "CONCESSIONS";
type CountPhase = RepairPhase | "VEHICLES";
type ThrownDomainError = { data?: { code?: string; message?: string } };

async function setupTest(tag: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `Org ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_user`, email: `${tag}@example.test`, name: `User ${tag}` })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"] })
  );
  const asUser = t.withIdentity({ subject: `${tag}_user`, clerkId: `${tag}_user` });
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear,
    periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Test", lastName: "Customer" }));
  return { t, orgId, userId, customerId, asUser };
}
type World = Awaited<ReturnType<typeof setupTest>>;

const SUPPLIER_NAME = "Al-Safeer Trading Co";
let vinCounter = 0;

/** A SOURCED car as P2 left it: sold, with a frozen link (or none), and the name the server read from the master. */
async function insertVehicle(
  w: World,
  options: { sourcedSupplierId?: Id<"suppliers">; sourcedFromName?: string; sourceType?: "SOURCED" | "STOCK"; orgId?: Id<"organizations"> } = {}
) {
  vinCounter += 1;
  return await w.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: options.orgId ?? w.orgId,
      vin: `VINREPAIR${String(vinCounter).padStart(4, "0")}`,
      make: "Toyota",
      model: "Camry",
      year: 2024,
      mileage: 1000,
      color: "White",
      fuelType: "Gas",
      transmission: "Auto",
      sellingPrice: 15_000,
      status: "SOLD",
      sourceType: options.sourceType ?? "SOURCED",
      ...(options.sourcedSupplierId ? { sourcedSupplierId: options.sourcedSupplierId } : {}),
      sourcedFromName: options.sourcedFromName ?? SUPPLIER_NAME,
      sourceCost: 12_000,
    } as never)
  );
}

async function insertSale(w: World, vehicleId: Id<"vehicles">) {
  return await w.t.run((ctx) =>
    ctx.db.insert("sales", {
      orgId: w.orgId,
      vehicleId,
      customerId: w.customerId,
      salespersonId: w.userId,
      salePrice: 15_000,
      saleDate: Date.now(),
      status: "COMPLETED",
    })
  );
}

type RowOptions = { name?: string; snapshotVersion?: number; status?: string };

/** A payable exactly as main's sale completion wrote it before P3: a name, no id. */
async function insertPayable(w: World, vehicleId: Id<"vehicles">, options: RowOptions = {}) {
  const saleId = await insertSale(w, vehicleId);
  const now = Date.now();
  return await w.t.run((ctx) =>
    ctx.db.insert("vehicleSupplierPayables", {
      orgId: w.orgId,
      vehicleId,
      saleId,
      sourcedFromName: options.name ?? SUPPLIER_NAME,
      ...(options.snapshotVersion === undefined ? {} : { supplierSnapshotVersion: options.snapshotVersion }),
      amountDue: 8_000,
      currency: "JOD",
      status: (options.status ?? "PENDING") as never,
      createdBy: w.userId,
      createdAt: now,
      updatedAt: now,
    })
  );
}

async function insertReceivable(w: World, vehicleId: Id<"vehicles">, options: RowOptions = {}) {
  const saleId = await insertSale(w, vehicleId);
  const now = Date.now();
  return await w.t.run((ctx) =>
    ctx.db.insert("vehicleSupplierReceivables", {
      orgId: w.orgId,
      vehicleId,
      saleId,
      sourcedFromName: options.name ?? SUPPLIER_NAME,
      ...(options.snapshotVersion === undefined ? {} : { supplierSnapshotVersion: options.snapshotVersion }),
      amountDue: 2_000,
      currency: "JOD",
      status: (options.status ?? "OPEN") as never,
      createdBy: w.userId,
      createdAt: now,
      updatedAt: now,
    })
  );
}

async function insertRecovery(w: World, vehicleId: Id<"vehicles">, options: RowOptions = {}) {
  const now = Date.now();
  const expenseId = await w.t.run((ctx) =>
    ctx.db.insert("expenses", {
      orgId: w.orgId,
      vehicleId,
      title: "Transport cost",
      amount: 300,
      date: now - 60_000,
      category: "TRANSPORT",
      status: "PAID",
      paymentMethod: "CASH",
      costBearer: "SUPPLIER",
    } as never)
  );
  return await w.t.run((ctx) =>
    ctx.db.insert("supplierCostRecoveries", {
      orgId: w.orgId,
      vehicleId,
      expenseId,
      origin: "EXPENSE",
      sourcedFromName: options.name ?? SUPPLIER_NAME,
      ...(options.snapshotVersion === undefined ? {} : { supplierSnapshotVersion: options.snapshotVersion }),
      amountDueMinor: 300_000,
      amountRecoveredMinor: 0,
      currency: "JOD",
      receiptSeq: 0,
      status: (options.status ?? "OPEN") as never,
      sourceEventKey: `expense:${expenseId}:created`,
      createdBy: w.userId,
      createdAt: now,
      updatedAt: now,
    } as never)
  );
}

type PageResult = { status: "MORE" | "READY"; cursor: string | null; examined: number; repaired?: number; unresolved: number };

/** Walks every page of one phase, the way the release step does, and returns the summed counts and the page count. */
async function drain(
  t: Harness,
  fn: "repairPage" | "countPage",
  orgId: Id<"organizations">,
  phase: CountPhase,
  numItems?: number
) {
  let cursor: string | null = null;
  const total = { examined: 0, repaired: 0, unresolved: 0, pages: 0, maxPageExamined: 0 };
  for (let guard = 0; guard < 200; guard += 1) {
    const args = { orgId, phase: phase as never, cursor, ...(numItems === undefined ? {} : { numItems }) } as never;
    const page: PageResult =
      fn === "repairPage"
        ? await t.mutation(internal.supplierIdentityRepair.repairPage, args)
        : await t.query(internal.supplierIdentityRepair.countPage, args);
    total.examined += page.examined;
    total.repaired += page.repaired ?? 0;
    total.unresolved += page.unresolved;
    total.pages += 1;
    total.maxPageExamined = Math.max(total.maxPageExamined, page.examined);
    if (page.status === "READY") return total;
    cursor = page.cursor;
  }
  throw new Error("the phase never finished");
}

const repairAll = async (t: Harness, orgId: Id<"organizations">) => {
  const out: Record<string, Awaited<ReturnType<typeof drain>>> = {};
  for (const phase of ["PAYABLES", "RECEIVABLES", "RECOVERIES", "CONCESSIONS"] as RepairPhase[]) {
    out[phase] = await drain(t, "repairPage", orgId, phase);
  }
  return out;
};

const countAll = async (t: Harness, orgId: Id<"organizations">) => {
  const out: Record<string, number> = {};
  for (const phase of ["PAYABLES", "RECEIVABLES", "RECOVERIES", "CONCESSIONS", "VEHICLES"] as CountPhase[]) {
    out[phase] = (await drain(t, "countPage", orgId, phase)).unresolved;
  }
  return out;
};

const table = (name: "vehicleSupplierPayables" | "vehicleSupplierReceivables" | "supplierCostRecoveries", w: World) =>
  w.t.run(async (ctx) => (await ctx.db.query(name).collect()).filter((row) => row.orgId === w.orgId));

async function refusalCode(promise: Promise<unknown>): Promise<ThrownDomainError["data"] | undefined> {
  try {
    await promise;
  } catch (error) {
    return (error as ThrownDomainError).data;
  }
  return undefined;
}

const markPaid = (w: World, payableId: Id<"vehicleSupplierPayables">) =>
  w.asUser.mutation(api.sourcingPayables.markPaid, {
    orgId: w.orgId,
    payableId,
    paymentMethod: "CASH",
    idempotencyKey: crypto.randomUUID(),
  });

const recordReceipt = (w: World, receivableId: Id<"vehicleSupplierReceivables">) =>
  w.asUser.mutation(api.supplierReceivables.recordReceipt, {
    orgId: w.orgId,
    receivableId,
    amount: 1000,
    receiptMethod: "CASH",
    idempotencyKey: crypto.randomUUID(),
  });

const recordRecoveryReceipt = (w: World, recoveryId: Id<"supplierCostRecoveries">) =>
  w.asUser.mutation(api.supplierCostRecoveries.recordReceipt, {
    orgId: w.orgId,
    recoveryId,
    amountMinor: 300_000,
    method: "CASH",
    receivedDate: Date.now(),
    idempotencyKey: crypto.randomUUID(),
  });

async function p2World(tag: string, version = 2) {
  const w = await setupTest(tag);
  const supplierId = await seedSupplier(w.t, { orgId: w.orgId, userId: w.userId, displayName: SUPPLIER_NAME, version });
  const vehicleId = await insertVehicle(w, { sourcedSupplierId: supplierId });
  return { w, supplierId, vehicleId };
}

describe("SCRUM-868 P3 repair: P2-era rows get their id from the vehicle's frozen supplier link, and only then", () => {
  test("a P2 payable is refused before the repair, bound to the vehicle's supplier by it, and settleable after", async () => {
    const { w, supplierId, vehicleId } = await p2World("rep_pay");
    const payableId = await insertPayable(w, vehicleId);

    const before = await refusalCode(markPaid(w, payableId));
    expect(before?.code).toBe(SUPPLIER_ERROR.IDENTITY_UNRESOLVED);

    const result = await repairAll(w.t, w.orgId);
    expect(result.PAYABLES).toMatchObject({ repaired: 1, unresolved: 0 });

    const row = await w.t.run((ctx) => ctx.db.get(payableId));
    expect(row?.supplierId).toBe(supplierId);
    expect(row?.supplierIdentityRepair).toMatchObject({ source: "VEHICLE_LINK", nameMatchedOn: "DISPLAY_NAME" });
    // The name snapshot is evidence and is never rewritten; no version is invented.
    expect(row?.sourcedFromName).toBe(SUPPLIER_NAME);
    expect(row?.supplierSnapshotVersion).toBeUndefined();

    await markPaid(w, payableId);
    expect((await w.t.run((ctx) => ctx.db.get(payableId)))?.status).toBe("PAID");
  });

  test("a P2 receivable is bound by the repair and then collectable", async () => {
    const { w, supplierId, vehicleId } = await p2World("rep_rec");
    const receivableId = await insertReceivable(w, vehicleId);
    expect((await refusalCode(recordReceipt(w, receivableId)))?.code).toBe(SUPPLIER_ERROR.IDENTITY_UNRESOLVED);

    const result = await repairAll(w.t, w.orgId);
    expect(result.RECEIVABLES).toMatchObject({ repaired: 1, unresolved: 0 });
    expect((await w.t.run((ctx) => ctx.db.get(receivableId)))?.supplierId).toBe(supplierId);

    await recordReceipt(w, receivableId);
    expect((await w.t.run((ctx) => ctx.db.get(receivableId)))?.amountReceived).toBe(1000);
  });

  test("a P2 cost recovery is bound by the repair and the receipt door then gets past the identity check", async () => {
    const { w, supplierId, vehicleId } = await p2World("rep_cost");
    const recoveryId = await insertRecovery(w, vehicleId);
    expect((await refusalCode(recordRecoveryReceipt(w, recoveryId)))?.code).toBe(SUPPLIER_ERROR.IDENTITY_UNRESOLVED);

    const result = await repairAll(w.t, w.orgId);
    expect(result.RECOVERIES).toMatchObject({ repaired: 1, unresolved: 0 });
    expect((await w.t.run((ctx) => ctx.db.get(recoveryId)))?.supplierId).toBe(supplierId);

    // A hand-built recovery has no posted source expense event, so the door's NEXT check (ledger posting of
    // the source cost) refuses. That it is a different refusal, with no supplier code, is the evidence that the
    // identity check passed; the receipt-recording path itself is covered by supplierCostRecoveries tests.
    const after = await refusalCode(recordRecoveryReceipt(w, recoveryId));
    expect(after?.code).not.toBe(SUPPLIER_ERROR.IDENTITY_UNRESOLVED);
  });

  test("a second run is a no-op: nothing is rewritten and the stamp keeps its first timestamp", async () => {
    const { w, vehicleId } = await p2World("rep_idem");
    const payableId = await insertPayable(w, vehicleId);
    await insertReceivable(w, vehicleId);
    await insertRecovery(w, vehicleId);

    const first = await repairAll(w.t, w.orgId);
    expect(first.PAYABLES.repaired + first.RECEIVABLES.repaired + first.RECOVERIES.repaired).toBe(3);
    const stampAt = (await w.t.run((ctx) => ctx.db.get(payableId)))?.supplierIdentityRepair?.at;
    expect(typeof stampAt).toBe("number");
    const snapshot = await dbSnapshot(w.t, Object.keys(schema.tables));

    const second = await repairAll(w.t, w.orgId);
    expect(second.PAYABLES.repaired + second.RECEIVABLES.repaired + second.RECOVERIES.repaired + second.CONCESSIONS.repaired).toBe(0);
    expect(await dbSnapshot(w.t, Object.keys(schema.tables))).toEqual(snapshot);
    expect((await w.t.run((ctx) => ctx.db.get(payableId)))?.supplierIdentityRepair?.at).toBe(stampAt);
  });

  test("an inactive supplier is still bound: deactivation never strands an obligation", async () => {
    const { w, supplierId, vehicleId } = await p2World("rep_inactive");
    const payableId = await insertPayable(w, vehicleId);
    await w.t.run((ctx) => ctx.db.patch(supplierId, { status: "INACTIVE" }));
    await repairAll(w.t, w.orgId);
    expect((await w.t.run((ctx) => ctx.db.get(payableId)))?.supplierId).toBe(supplierId);
    await markPaid(w, payableId);
  });

  test("a row that already carries an id is never touched, whatever the vehicle says", async () => {
    const { w, supplierId, vehicleId } = await p2World("rep_has_id");
    const otherId = await seedSupplier(w.t, { orgId: w.orgId, userId: w.userId, displayName: "Other Supplier Ltd" });
    const payableId = await insertPayable(w, vehicleId);
    await w.t.run((ctx) => ctx.db.patch(payableId, { supplierId: otherId }));
    const snapshot = await dbSnapshot(w.t, Object.keys(schema.tables));
    await repairAll(w.t, w.orgId);
    expect(await dbSnapshot(w.t, Object.keys(schema.tables))).toEqual(snapshot);
    expect((await w.t.run((ctx) => ctx.db.get(payableId)))?.supplierId).toBe(otherId);
    expect(supplierId).not.toBe(otherId);
  });
});

describe("SCRUM-868 P3 repair: every row the repair cannot prove stays refused, unchanged and counted", () => {
  /** Seeds one row of every kind on `vehicleId` and asserts the repair wrote nothing and the check counts all three. */
  async function expectStaysRefused(w: World, vehicleId: Id<"vehicles">, options: RowOptions = {}) {
    const payableId = await insertPayable(w, vehicleId, options);
    const receivableId = await insertReceivable(w, vehicleId, options);
    const recoveryId = await insertRecovery(w, vehicleId, options);
    const snapshot = await dbSnapshot(w.t, Object.keys(schema.tables));

    const repaired = await repairAll(w.t, w.orgId);
    expect(repaired.PAYABLES).toMatchObject({ repaired: 0, unresolved: 1 });
    expect(repaired.RECEIVABLES).toMatchObject({ repaired: 0, unresolved: 1 });
    expect(repaired.RECOVERIES).toMatchObject({ repaired: 0, unresolved: 1 });
    expect(await dbSnapshot(w.t, Object.keys(schema.tables))).toEqual(snapshot);

    const counts = await countAll(w.t, w.orgId);
    expect(counts).toMatchObject({ PAYABLES: 1, RECEIVABLES: 1, RECOVERIES: 1 });
    // The door still refuses, with the stable code.
    expect((await refusalCode(markPaid(w, payableId)))?.code).toBe(SUPPLIER_ERROR.IDENTITY_UNRESOLVED);
    expect((await refusalCode(recordReceipt(w, receivableId)))?.code).toBe(SUPPLIER_ERROR.IDENTITY_UNRESOLVED);
    expect((await refusalCode(recordRecoveryReceipt(w, recoveryId)))?.code).toBe(SUPPLIER_ERROR.IDENTITY_UNRESOLVED);
  }

  test("a vehicle with no supplier link stays refused even though a supplier of that exact name exists (never from a name)", async () => {
    const w = await setupTest("rep_noid");
    await seedSupplier(w.t, { orgId: w.orgId, userId: w.userId, displayName: SUPPLIER_NAME });
    const vehicleId = await insertVehicle(w);
    await expectStaysRefused(w, vehicleId);
  });

  test("a vehicle linked to a supplier of ANOTHER organization stays refused", async () => {
    const w = await setupTest("rep_foreign");
    const foreignOrgId = await w.t.run((ctx) => ctx.db.insert("organizations", { name: "Other dealership", createdAt: Date.now() }));
    const foreignSupplier = await seedSupplier(w.t, { orgId: foreignOrgId, userId: w.userId, displayName: SUPPLIER_NAME });
    const vehicleId = await insertVehicle(w, { sourcedSupplierId: foreignSupplier });
    await expectStaysRefused(w, vehicleId);
  });

  test("a vehicle whose supplier was deleted stays refused", async () => {
    const w = await setupTest("rep_deleted");
    const gone = await seedSupplier(w.t, { orgId: w.orgId, userId: w.userId, displayName: SUPPLIER_NAME });
    const vehicleId = await insertVehicle(w, { sourcedSupplierId: gone });
    await w.t.run((ctx) => ctx.db.delete(gone));
    await expectStaysRefused(w, vehicleId);
  });

  test("a row whose name is not the linked supplier's name stays refused even if another supplier carries that name", async () => {
    const { w, vehicleId } = await p2World("rep_name");
    await seedSupplier(w.t, { orgId: w.orgId, userId: w.userId, displayName: "Different Name LLC" });
    await expectStaysRefused(w, vehicleId, { name: "Different Name LLC" });
  });

  test("a row whose name is only an alias of ANOTHER supplier stays refused", async () => {
    const { w, vehicleId } = await p2World("rep_name_alias_other");
    const other = await seedSupplier(w.t, { orgId: w.orgId, userId: w.userId, displayName: "Different Name LLC" });
    await w.t.run((ctx) =>
      ctx.db.insert("supplierAliases", {
        orgId: w.orgId,
        supplierId: other,
        alias: "Old Trading Name",
        aliasKey: "old trading name",
        source: "MANUAL",
        status: "ACTIVE",
        createdBy: w.userId,
        createdAt: Date.now(),
      })
    );
    await expectStaysRefused(w, vehicleId, { name: "Old Trading Name" });
  });

  test("a row whose snapshot version is ahead of the master is not evidence and stays refused", async () => {
    const { w, vehicleId } = await p2World("rep_version", 2);
    await expectStaysRefused(w, vehicleId, { snapshotVersion: 3 });
  });

  test("a snapshot version the master has reached is accepted", async () => {
    const { w, supplierId, vehicleId } = await p2World("rep_version_ok", 3);
    const payableId = await insertPayable(w, vehicleId, { snapshotVersion: 2 });
    await repairAll(w.t, w.orgId);
    const row = await w.t.run((ctx) => ctx.db.get(payableId));
    expect(row?.supplierId).toBe(supplierId);
    expect(row?.supplierSnapshotVersion).toBe(2);
  });

  test("a vehicle that is no longer SOURCED (its supplier id is not the creditor of this row) stays refused", async () => {
    const { w, vehicleId } = await p2World("rep_converted");
    await w.t.run((ctx) => ctx.db.patch(vehicleId, { sourceType: "STOCK" } as never));
    await expectStaysRefused(w, vehicleId);
  });

  test("a vehicle of another organization stays refused", async () => {
    const w = await setupTest("rep_vehicle_foreign");
    const foreignOrgId = await w.t.run((ctx) => ctx.db.insert("organizations", { name: "Other dealership", createdAt: Date.now() }));
    const supplierId = await seedSupplier(w.t, { orgId: w.orgId, userId: w.userId, displayName: SUPPLIER_NAME });
    const vehicleId = await insertVehicle(w, { sourcedSupplierId: supplierId, orgId: foreignOrgId });
    await expectStaysRefused(w, vehicleId);
  });

  test("a renamed supplier needs an alias for the old name: without it the row stays refused, with it the row is bound", async () => {
    const { w, supplierId, vehicleId } = await p2World("rep_alias");
    await renameSupplier(w.t, supplierId, "Al-Safeer International");
    const payableId = await insertPayable(w, vehicleId);

    const without = await drain(w.t, "repairPage", w.orgId, "PAYABLES");
    expect(without).toMatchObject({ repaired: 0, unresolved: 1 });
    expect((await w.t.run((ctx) => ctx.db.get(payableId)))?.supplierId).toBeUndefined();

    await w.t.run((ctx) =>
      ctx.db.insert("supplierAliases", {
        orgId: w.orgId,
        supplierId,
        alias: SUPPLIER_NAME,
        aliasKey: "al safeer trading co",
        source: "MANUAL",
        status: "RETIRED",
        createdBy: w.userId,
        createdAt: Date.now(),
      })
    );
    const withAlias = await drain(w.t, "repairPage", w.orgId, "PAYABLES");
    expect(withAlias).toMatchObject({ repaired: 1, unresolved: 0 });
    const row = await w.t.run((ctx) => ctx.db.get(payableId));
    expect(row?.supplierId).toBe(supplierId);
    expect(row?.supplierIdentityRepair?.nameMatchedOn).toBe("ALIAS");
  });

  test("OPENING rows are exempt: neither repaired nor counted", async () => {
    const { w, vehicleId } = await p2World("rep_opening");
    const saleId = await insertSale(w, vehicleId);
    const draftId = await w.t.run((ctx) =>
      ctx.db.insert("openingBalanceDrafts", {
        orgId: w.orgId,
        status: "POSTED",
        lines: [],
        asOfDate: Date.now(),
        createdBy: w.userId,
        createdAt: Date.now(),
      })
    );
    const openingId = await w.t.run((ctx) =>
      ctx.db.insert("vehicleSupplierPayables", {
        orgId: w.orgId,
        origin: "OPENING",
        openingBalanceDraftId: draftId,
        openingRowKey: "row-1",
        openingKind: "SUPPLIER_PAYABLE",
        title: "Opening balance",
        sourcedFromName: SUPPLIER_NAME,
        amountDue: 500,
        currency: "JOD",
        status: "PENDING",
        createdBy: w.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as never)
    );
    expect(saleId).toBeDefined();
    const result = await drain(w.t, "repairPage", w.orgId, "PAYABLES");
    expect(result).toMatchObject({ repaired: 0, unresolved: 0 });
    expect((await countAll(w.t, w.orgId)).PAYABLES).toBe(0);
    expect((await w.t.run((ctx) => ctx.db.get(openingId)))?.supplierId).toBeUndefined();
  });

  test("a repair for one organization never reads or writes another organization's rows", async () => {
    const a = await p2World("rep_iso_a");
    const otherOrgId = await a.w.t.run((ctx) => ctx.db.insert("organizations", { name: "Neighbour", createdAt: Date.now() }));
    const neighbourUser = a.w.userId;
    const neighbourSupplier = await seedSupplier(a.w.t, { orgId: otherOrgId, userId: neighbourUser, displayName: SUPPLIER_NAME });
    const neighbourVehicle = await a.w.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: otherOrgId, vin: "VINNEIGHBOUR1", make: "Kia", model: "Rio", year: 2022, mileage: 1, color: "Red",
        fuelType: "Gas", transmission: "Auto", sellingPrice: 9_000, status: "SOLD", sourceType: "SOURCED",
        sourcedSupplierId: neighbourSupplier, sourcedFromName: SUPPLIER_NAME, sourceCost: 7_000,
      } as never)
    );
    const neighbourPayable = await a.w.t.run((ctx) =>
      ctx.db.insert("vehicleSupplierPayables", {
        orgId: otherOrgId, vehicleId: neighbourVehicle, sourcedFromName: SUPPLIER_NAME, amountDue: 7_000, currency: "JOD",
        status: "PENDING", createdBy: neighbourUser, createdAt: Date.now(), updatedAt: Date.now(),
      })
    );
    await insertPayable(a.w, a.vehicleId);
    await repairAll(a.w.t, a.w.orgId);
    expect((await a.w.t.run((ctx) => ctx.db.get(neighbourPayable)))?.supplierId).toBeUndefined();
  });
});

describe("SCRUM-868 P3 repair: paging is bounded and resumable", () => {
  test("a small page size walks every row across several bounded pages and repairs all of them", async () => {
    const { w, vehicleId } = await p2World("rep_paging");
    for (let i = 0; i < 7; i += 1) await insertPayable(w, vehicleId);
    const run = await drain(w.t, "repairPage", w.orgId, "PAYABLES", 3);
    expect(run.repaired).toBe(7);
    expect(run.pages).toBeGreaterThanOrEqual(3);
    expect(run.maxPageExamined).toBeLessThanOrEqual(3);
    expect((await table("vehicleSupplierPayables", w)).every((row) => row.supplierId !== undefined)).toBe(true);
  });

  test("the page size is capped no matter what the caller asks for", async () => {
    const { w, vehicleId } = await p2World("rep_cap");
    for (let i = 0; i < 130; i += 1) await insertPayable(w, vehicleId);
    const run = await drain(w.t, "repairPage", w.orgId, "PAYABLES", 10_000);
    expect(run.repaired).toBe(130);
    expect(run.maxPageExamined).toBeLessThanOrEqual(100);
    expect(run.pages).toBeGreaterThanOrEqual(2);
  });
});

describe("SCRUM-868 P3 repair: the counts-only check", () => {
  test("it reports non-zero for every unresolved class and zero after the repair resolves what it can", async () => {
    const { w, vehicleId } = await p2World("cnt_all");
    await insertPayable(w, vehicleId);
    await insertReceivable(w, vehicleId);
    await insertRecovery(w, vehicleId);
    // A SOURCED vehicle with no supplier id is counted on its own.
    await insertVehicle(w);
    // A STOCK car with no supplier id is not a supplier vehicle.
    await insertVehicle(w, { sourceType: "STOCK" });
    // A deleted SOURCED car is not counted either.
    const deleted = await insertVehicle(w);
    await w.t.run((ctx) => ctx.db.patch(deleted, { isDeleted: true } as never));

    expect(await countAll(w.t, w.orgId)).toEqual({ PAYABLES: 1, RECEIVABLES: 1, RECOVERIES: 1, CONCESSIONS: 0, VEHICLES: 1 });
    await repairAll(w.t, w.orgId);
    expect(await countAll(w.t, w.orgId)).toEqual({ PAYABLES: 0, RECEIVABLES: 0, RECOVERIES: 0, CONCESSIONS: 0, VEHICLES: 1 });
  });

  test("the count is read-only", async () => {
    const { w, vehicleId } = await p2World("cnt_readonly");
    await insertPayable(w, vehicleId);
    const snapshot = await dbSnapshot(w.t, Object.keys(schema.tables));
    await countAll(w.t, w.orgId);
    expect(await dbSnapshot(w.t, Object.keys(schema.tables))).toEqual(snapshot);
  });

  test("terminal id-less rows are counted too: a PAID or CANCELLED payable the repair cannot bind still blocks", async () => {
    const w = await setupTest("cnt_terminal");
    const vehicleId = await insertVehicle(w);
    await insertPayable(w, vehicleId, { status: "PAID" });
    await insertPayable(w, vehicleId, { status: "CANCELLED" });
    expect((await countAll(w.t, w.orgId)).PAYABLES).toBe(2);
  });
});

describe("SCRUM-868 P3 repair: refusal texts name a step that exists", () => {
  test("the unresolved-identity message gives a next step", () => {
    expect(SUPPLIER_IDENTITY_UNRESOLVED_MESSAGE).toMatch(/reviewed correction/i);
    expect(SUPPLIER_IDENTITY_UNRESOLVED_MESSAGE.length).toBeGreaterThan("Supplier identity is unresolved.".length);
  });
});
