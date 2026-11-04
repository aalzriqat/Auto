/**
 * SCRUM-868 P4/P5 round 4: the first supplier link of a SOURCED car that already has money.
 *
 * Invariant under test. A SOURCED car with no supplier link (`sourcedSupplierId` unset) and money already
 * recorded against it can be given its FIRST link, once, by a caller who holds MANAGE_FINANCE, and only
 * to a supplier the operator picked by id whose display name or alias matches (under the registry's own
 * `normalizeNameKey`) the name stored on the car and on every id-less money row of that car. The name
 * only CONFIRMS the picked id; it never selects a supplier. An existing link is never changed (N11), a
 * held concession still refuses first, and a sales-originated edit request gains no such power. Nothing
 * is posted and no amount moves: the money rows are bound afterwards by the existing release repair.
 *
 * Why it matters: before this door, an unlinked car with money could be neither linked (frozen) nor
 * repaired (the repair takes the id only from the car), so the release count could never reach zero.
 */
import { describe, expect, test, vi } from "vitest";
import { commonAr, commonEn } from "../lib/i18n/domains/common";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { renameSupplier, seedSupplier } from "../test-utils/supplierFixture";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS } from "./utils/permissions";
import { SUPPLIER_CONCESSION_REFUSALS } from "./utils/supplierConcession";
import { SUPPLIER_ERROR, snapshotSupplier } from "./utils/supplierRegistry";
import { SUPPLIER_LINK_FROZEN_MESSAGE, assertSupplierLinkChangeAllowed } from "./utils/vehicleSupplierIdentity";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.ts");

const NEEDS_FINANCE_MANAGER = "SUPPLIER_FIRST_LINK_NEEDS_FINANCE_MANAGER";
const NOT_PROVEN = "SUPPLIER_FIRST_LINK_NOT_PROVEN";
const FIRST_LINK_AUDIT_ACTION = "vehicle.supplierFirstLink";

const SUPPLIER_NAME = "Al-Safeer Trading Co";
const EDITOR_PERMISSIONS = ["view:vehicles", "edit:vehicles", "create:vehicles"];
const FINANCE_MANAGER_PERMISSIONS = ["view:vehicles", "edit:vehicles", "view:finance", "manage:finance"];

type ThrownDomainError = { data?: { code?: string; message?: string } | string };

async function seedWorld(tag: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `First link ${tag}`, createdAt: Date.now() }));
  const otherOrgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `Other ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] })
  );
  const member = async (key: string, roleName: string, permissions: string[], owner: boolean) => {
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: `${key}_${tag}`, email: `${key}-${tag}@example.test`, name: roleName })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: roleName, permissions, ...(owner ? { isSystemOwnerRole: true } : {}) })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    return { userId, as: t.withIdentity({ subject: `${key}_${tag}`, clerkId: `${key}_${tag}` }) };
  };
  const owner = await member("owner", "Owner", ALL_PERMISSIONS, true);
  // Deliberately NOT the system owner: the permission under test is the role's own manage:finance.
  const finance = await member("finance", "Finance Manager", FINANCE_MANAGER_PERMISSIONS, false);
  const editor = await member("editor", "Vehicle Editor", EDITOR_PERMISSIONS, false);

  await owner.as.mutation(api.chartOfAccounts.initialize, { orgId });
  await owner.as.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(2020, 0, 1), endDate: Date.UTC(2035, 11, 31, 23, 59, 59, 999), fiscalYear: 2025, periodNumber: 1,
  });
  const period = (await owner.as.query(api.accountingPeriods.list, { orgId }))[0];
  await owner.as.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Dana", lastName: "Saleh" }));
  const supplierId = await seedSupplier(t, { orgId, userId: owner.userId, displayName: SUPPLIER_NAME });
  return { t, orgId, otherOrgId, owner, finance, editor, customerId, supplierId };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

let vinCounter = 0;
/** A SOURCED car as it exists in production today: no supplier link, the name the dealer typed at intake. */
async function insertUnlinkedCar(
  w: World,
  options: { status?: "AVAILABLE" | "SOLD"; name?: string; linkedTo?: Id<"suppliers"> } = {}
) {
  vinCounter += 1;
  return await w.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: w.orgId,
      vin: `VINFIRSTLINK${String(vinCounter).padStart(4, "0")}`,
      make: "Toyota", model: "Camry", year: 2024, mileage: 1000, color: "White", fuelType: "Gas", transmission: "Auto",
      sellingPrice: 15_000, status: options.status ?? "AVAILABLE", sourceType: "SOURCED",
      sourcedFromName: options.name ?? SUPPLIER_NAME, sourceCost: 12_000,
      ...(options.linkedTo ? { sourcedSupplierId: options.linkedTo } : {}),
    } as never)
  );
}

async function insertSale(w: World, vehicleId: Id<"vehicles">) {
  return await w.t.run((ctx) =>
    ctx.db.insert("sales", {
      orgId: w.orgId, vehicleId, customerId: w.customerId, salespersonId: w.owner.userId, salePrice: 15_000,
      saleDate: Date.now(), status: "COMPLETED",
    })
  );
}

type RowOptions = { name?: string; supplierId?: Id<"suppliers">; version?: number };

async function addPayable(w: World, vehicleId: Id<"vehicles">, options: RowOptions = {}) {
  const saleId = await insertSale(w, vehicleId);
  const now = Date.now();
  return await w.t.run((ctx) =>
    ctx.db.insert("vehicleSupplierPayables", {
      orgId: w.orgId, vehicleId, saleId, sourcedFromName: options.name ?? SUPPLIER_NAME,
      ...(options.supplierId ? { supplierId: options.supplierId } : {}),
      ...(options.version === undefined ? {} : { supplierSnapshotVersion: options.version }),
      amountDue: 8_000, currency: "JOD", status: "PENDING", createdBy: w.owner.userId, createdAt: now, updatedAt: now,
    })
  );
}

async function addReceivable(w: World, vehicleId: Id<"vehicles">, options: RowOptions = {}) {
  const saleId = await insertSale(w, vehicleId);
  const now = Date.now();
  return await w.t.run((ctx) =>
    ctx.db.insert("vehicleSupplierReceivables", {
      orgId: w.orgId, vehicleId, saleId, sourcedFromName: options.name ?? SUPPLIER_NAME, amountDue: 2_000, currency: "JOD",
      status: "OPEN", createdBy: w.owner.userId, createdAt: now, updatedAt: now,
    })
  );
}

/** A supplier-borne expense and the one cost recovery it opens: the shape of the production car with money. */
async function addRecoveryWithExpense(w: World, vehicleId: Id<"vehicles">, options: RowOptions = {}) {
  const now = Date.now();
  const expenseId = await w.t.run((ctx) =>
    ctx.db.insert("expenses", {
      orgId: w.orgId, vehicleId, title: "Transport cost", amount: 300, date: now - 60_000, category: "TRANSPORT",
      status: "PAID", paymentMethod: "CASH", costBearer: "SUPPLIER",
    } as never)
  );
  return await w.t.run((ctx) =>
    ctx.db.insert("supplierCostRecoveries", {
      orgId: w.orgId, vehicleId, expenseId, origin: "EXPENSE", sourcedFromName: options.name ?? SUPPLIER_NAME,
      ...(options.version === undefined ? {} : { supplierSnapshotVersion: options.version }),
      amountDueMinor: 300_000, amountRecoveredMinor: 0, currency: "JOD", receiptSeq: 0, status: "OPEN",
      sourceEventKey: `expense:${expenseId}:created`, createdBy: w.owner.userId, createdAt: now, updatedAt: now,
    } as never)
  );
}

/** A supplier-borne expense with no recovery row (not yet paid): the only money on the car, and it carries no name. */
async function addSupplierExpenseOnly(w: World, vehicleId: Id<"vehicles">) {
  await w.t.run((ctx) =>
    ctx.db.insert("expenses", {
      orgId: w.orgId, vehicleId, title: "Supplier-borne repair", amount: 100, date: Date.now(), category: "REPAIR",
      status: "PENDING", costBearer: "SUPPLIER",
    } as never)
  );
}

async function addHeldConcession(w: World, vehicleId: Id<"vehicles">) {
  const now = Date.now();
  await w.t.run(async (ctx) => {
    const companyId = await ctx.db.insert("financeCompanies", {
      orgId: w.orgId, name: "Test Bank", isActive: true, profitRate: 5.5, maxTermMonths: 72, gracePeriodMonths: 3,
    });
    const quoteId = await ctx.db.insert("quotes", {
      orgId: w.orgId, vehicleId, customerId: w.customerId, vehiclePrice: 12000, downPayment: 2000, totalFinancedAmount: 10000,
      termMonths: 24, status: "DRAFT", companyId, createdBy: w.owner.userId, createdAt: now,
    });
    await ctx.db.insert("financeApplications", {
      orgId: w.orgId, customerId: w.customerId, vehicleId, companyId, quoteId, salespersonId: w.owner.userId, status: "APPROVED",
      createdAt: now, updatedAt: now, supplierGapShareMinor: 400_000,
    });
  });
}

const linkOnVehicle = (who: World["owner"], w: World, vehicleId: Id<"vehicles">, supplierId: Id<"suppliers">) =>
  who.as.mutation(api.vehicles.update, { orgId: w.orgId, vehicleId, sourceType: "SOURCED", sourcedSupplierId: supplierId });

async function refusalOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return (error as ThrownDomainError).data;
  }
  return undefined;
}

const allTables = Object.keys(schema.tables);
const moneyTables = [
  "vehicleSupplierPayables", "vehicleSupplierReceivables", "supplierCostRecoveries", "expenses",
  "accountingEvents", "pendingAccountingEvents", "journalEntries", "journalLines",
];

const vehicleRow = (w: World, id: Id<"vehicles">) => w.t.run((ctx) => ctx.db.get(id));
const auditRows = (w: World) =>
  w.t.run(async (ctx) => (await ctx.db.query("adminAuditLog").take(500)).filter((row) => row.action === FIRST_LINK_AUDIT_ACTION));

/** Runs the refused call and proves it carried the code AND changed nothing at all. */
async function expectRefusedAndUnchanged(w: World, call: () => Promise<unknown>, code: string) {
  const before = await dbSnapshot(w.t, allTables);
  const refusal = await refusalOf(call());
  expect(typeof refusal === "object" ? refusal?.code : refusal).toBe(code);
  expect(await dbSnapshot(w.t, allTables)).toEqual(before);
}

async function repairEverything(w: World) {
  const total = { repaired: 0, unresolved: 0 };
  for (const phase of ["PAYABLES", "RECEIVABLES", "RECOVERIES", "CONCESSIONS"] as const) {
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard += 1) {
      const page: { status: string; cursor: string | null; repaired: number; unresolved: number } = await w.t.mutation(
        internal.supplierIdentityRepair.repairPage,
        { orgId: w.orgId, phase, cursor }
      );
      total.repaired += page.repaired;
      total.unresolved += page.unresolved;
      if (page.status === "READY") break;
      cursor = page.cursor;
    }
  }
  return total;
}

async function releaseCount(w: World) {
  let unresolved = 0;
  for (const phase of ["PAYABLES", "RECEIVABLES", "RECOVERIES", "CONCESSIONS", "VEHICLES"] as const) {
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard += 1) {
      const page: { status: string; cursor: string | null; unresolved: number } = await w.t.query(
        internal.supplierIdentityRepair.countPage,
        { orgId: w.orgId, phase, cursor }
      );
      unresolved += page.unresolved;
      if (page.status === "READY") break;
      cursor = page.cursor;
    }
  }
  return unresolved;
}

describe("first supplier link: an unlinked SOURCED car with money, linked by a finance manager", () => {
  test("production shape (a cost recovery and its supplier-borne expense): linked, audited, nothing posted, then repaired and counted clean", async () => {
    const w = await seedWorld("prod");
    const vehicleId = await insertUnlinkedCar(w);
    const recoveryId = await addRecoveryWithExpense(w, vehicleId);
    expect(await releaseCount(w)).toBeGreaterThan(0);
    const moneyBefore = await dbSnapshot(w.t, moneyTables);

    await linkOnVehicle(w.finance, w, vehicleId, w.supplierId);

    expect(await vehicleRow(w, vehicleId)).toMatchObject({ sourcedSupplierId: w.supplierId, sourcedFromName: SUPPLIER_NAME });
    expect(await dbSnapshot(w.t, moneyTables)).toEqual(moneyBefore);
    const audit = await auditRows(w);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ targetTable: "vehicles", targetId: vehicleId, orgId: w.orgId, actorUserId: w.finance.userId });
    expect(audit[0].after).toMatchObject({ sourcedSupplierId: w.supplierId });

    const repair = await repairEverything(w);
    expect(repair).toEqual({ repaired: 1, unresolved: 0 });
    expect((await w.t.run((ctx) => ctx.db.get(recoveryId)))?.supplierId).toBe(w.supplierId);
    expect(await releaseCount(w)).toBe(0);
  });

  test("a sold car with a payable and a receivable: linked, repaired, then the payable settles and the release count is clean", async () => {
    const w = await seedWorld("sold");
    const vehicleId = await insertUnlinkedCar(w, { status: "SOLD" });
    const payableId = await addPayable(w, vehicleId);
    await addReceivable(w, vehicleId);
    const stuck = await refusalOf(
      w.owner.as.mutation(api.sourcingPayables.markPaid, { orgId: w.orgId, payableId, paymentMethod: "CASH", idempotencyKey: "sold-before" })
    );
    expect(typeof stuck === "object" ? stuck?.code : undefined).toBe(SUPPLIER_ERROR.IDENTITY_UNRESOLVED);

    await linkOnVehicle(w.finance, w, vehicleId, w.supplierId);
    expect((await auditRows(w))[0].after).toMatchObject({ nameMatchedOn: "DISPLAY_NAME", rowsChecked: { payables: 1, receivables: 1, recoveries: 0 } });
    expect(await repairEverything(w)).toEqual({ repaired: 2, unresolved: 0 });
    await w.owner.as.mutation(api.sourcingPayables.markPaid, { orgId: w.orgId, payableId, paymentMethod: "CASH", idempotencyKey: "sold-after" });
    expect((await w.t.run((ctx) => ctx.db.get(payableId)))?.status).toBe("PAID");
    expect(await releaseCount(w)).toBe(0);
  });

  test("a supplier-borne expense alone (no recovery row yet): the car's own name confirms the picked supplier", async () => {
    const w = await seedWorld("expense_only");
    const vehicleId = await insertUnlinkedCar(w);
    await addSupplierExpenseOnly(w, vehicleId);
    await linkOnVehicle(w.finance, w, vehicleId, w.supplierId);
    expect((await vehicleRow(w, vehicleId))?.sourcedSupplierId).toBe(w.supplierId);

    const w2 = await seedWorld("expense_only_wrong");
    const car2 = await insertUnlinkedCar(w2, { name: "Somebody Else Ltd" });
    await addSupplierExpenseOnly(w2, car2);
    await expectRefusedAndUnchanged(w2, () => linkOnVehicle(w2.finance, w2, car2, w2.supplierId), NOT_PROVEN);
  });

  test("an alias of the picked supplier confirms the old name stored on the car and the rows", async () => {
    const w = await seedWorld("alias");
    await renameSupplier(w.t, w.supplierId, "Al-Safeer International");
    await w.t.run((ctx) =>
      ctx.db.insert("supplierAliases", {
        orgId: w.orgId, supplierId: w.supplierId, alias: SUPPLIER_NAME, aliasKey: "al safeer trading co", source: "MANUAL",
        status: "RETIRED", createdBy: w.owner.userId, createdAt: Date.now(),
      })
    );
    const vehicleId = await insertUnlinkedCar(w);
    await addPayable(w, vehicleId);
    await linkOnVehicle(w.finance, w, vehicleId, w.supplierId);
    expect(await vehicleRow(w, vehicleId)).toMatchObject({ sourcedSupplierId: w.supplierId, sourcedFromName: "Al-Safeer International" });
    expect((await auditRows(w))[0].after).toMatchObject({ nameMatchedOn: "ALIAS" });
  });

  test("control: an unlinked car with NO money links as before, for an ordinary editor, with no first-link audit", async () => {
    const w = await seedWorld("nomoney");
    const vehicleId = await insertUnlinkedCar(w, { name: "Typed At Intake" });
    await linkOnVehicle(w.editor, w, vehicleId, w.supplierId);
    expect(await vehicleRow(w, vehicleId)).toMatchObject({ sourcedSupplierId: w.supplierId, sourcedFromName: SUPPLIER_NAME });
    expect(await auditRows(w)).toHaveLength(0);
  });
});

describe("first supplier link: every condition that is missing refuses, with a code, and writes nothing", () => {
  test("the car's stored name does not match the picked supplier", async () => {
    const w = await seedWorld("car_name");
    const vehicleId = await insertUnlinkedCar(w, { name: "Different Name LLC" });
    await addPayable(w, vehicleId, { name: "Different Name LLC" });
    await expectRefusedAndUnchanged(w, () => linkOnVehicle(w.finance, w, vehicleId, w.supplierId), NOT_PROVEN);
  });

  test("the car matches but ONE money row carries a different name", async () => {
    const w = await seedWorld("row_name");
    const vehicleId = await insertUnlinkedCar(w);
    await addPayable(w, vehicleId);
    await addReceivable(w, vehicleId, { name: "Different Name LLC" });
    await expectRefusedAndUnchanged(w, () => linkOnVehicle(w.finance, w, vehicleId, w.supplierId), NOT_PROVEN);
  });

  test("a recovery row with a different name refuses even when the payable matches", async () => {
    const w = await seedWorld("recovery_name");
    const vehicleId = await insertUnlinkedCar(w);
    await addPayable(w, vehicleId);
    await addRecoveryWithExpense(w, vehicleId, { name: "Different Name LLC" });
    await expectRefusedAndUnchanged(w, () => linkOnVehicle(w.finance, w, vehicleId, w.supplierId), NOT_PROVEN);
  });

  test.each([["empty", ""], ["blank", "   "]])("a money row with a %s stored name has no evidence and refuses", async (_label, name) => {
    const w = await seedWorld(`noname_${_label}`);
    const vehicleId = await insertUnlinkedCar(w);
    await addPayable(w, vehicleId, { name });
    await expectRefusedAndUnchanged(w, () => linkOnVehicle(w.finance, w, vehicleId, w.supplierId), NOT_PROVEN);
  });

  test("a car with no stored name at all has nothing to confirm the pick against", async () => {
    const w = await seedWorld("car_noname");
    const vehicleId = await insertUnlinkedCar(w);
    await w.t.run((ctx) => ctx.db.patch(vehicleId, { sourcedFromName: undefined } as never));
    await addPayable(w, vehicleId);
    await expectRefusedAndUnchanged(w, () => linkOnVehicle(w.finance, w, vehicleId, w.supplierId), NOT_PROVEN);
  });

  test("a row already bound to a DIFFERENT supplier refuses (the car cannot contradict its own rows)", async () => {
    const w = await seedWorld("row_other_id");
    const other = await seedSupplier(w.t, { orgId: w.orgId, userId: w.owner.userId, displayName: "Other Motors" });
    const vehicleId = await insertUnlinkedCar(w);
    await addPayable(w, vehicleId, { supplierId: other });
    await expectRefusedAndUnchanged(w, () => linkOnVehicle(w.finance, w, vehicleId, w.supplierId), NOT_PROVEN);
  });

  test("a row whose recorded snapshot version is ahead of the master refuses (the repair would refuse it too)", async () => {
    const w = await seedWorld("row_version");
    const vehicleId = await insertUnlinkedCar(w);
    await addPayable(w, vehicleId, { version: 9 });
    await expectRefusedAndUnchanged(w, () => linkOnVehicle(w.finance, w, vehicleId, w.supplierId), NOT_PROVEN);
  });

  test("a car with more id-less rows than the proof can read refuses (fail closed), even though every row matches", async () => {
    const w = await seedWorld("bound");
    const vehicleId = await insertUnlinkedCar(w);
    const saleId = await insertSale(w, vehicleId);
    const now = Date.now();
    await w.t.run(async (ctx) => {
      for (let i = 0; i < 101; i += 1) {
        await ctx.db.insert("vehicleSupplierReceivables", {
          orgId: w.orgId, vehicleId, saleId, sourcedFromName: SUPPLIER_NAME, amountDue: 10, currency: "JOD",
          status: "OPEN", createdBy: w.owner.userId, createdAt: now, updatedAt: now,
        });
      }
    });
    await expectRefusedAndUnchanged(w, () => linkOnVehicle(w.finance, w, vehicleId, w.supplierId), NOT_PROVEN);
  });

  test("a payable of ANOTHER organization on this vehicle id is not vouched for (fail closed)", async () => {
    const w = await seedWorld("row_org");
    const vehicleId = await insertUnlinkedCar(w);
    await addReceivable(w, vehicleId);
    const saleId = await insertSale(w, vehicleId);
    const now = Date.now();
    await w.t.run((ctx) =>
      ctx.db.insert("vehicleSupplierPayables", {
        orgId: w.otherOrgId, vehicleId, saleId, sourcedFromName: SUPPLIER_NAME, amountDue: 8_000, currency: "JOD",
        status: "PENDING", createdBy: w.owner.userId, createdAt: now, updatedAt: now,
      })
    );
    await expectRefusedAndUnchanged(w, () => linkOnVehicle(w.finance, w, vehicleId, w.supplierId), NOT_PROVEN);
  });

  test("the caller holds edit:vehicles but not manage:finance", async () => {
    const w = await seedWorld("perm");
    const vehicleId = await insertUnlinkedCar(w);
    await addPayable(w, vehicleId);
    await expectRefusedAndUnchanged(w, () => linkOnVehicle(w.editor, w, vehicleId, w.supplierId), NEEDS_FINANCE_MANAGER);
  });

  test("a held supplier concession refuses first, with its own refusal", async () => {
    const w = await seedWorld("held");
    const vehicleId = await insertUnlinkedCar(w);
    await addPayable(w, vehicleId);
    await addHeldConcession(w, vehicleId);
    await expectRefusedAndUnchanged(w, () => linkOnVehicle(w.finance, w, vehicleId, w.supplierId), SUPPLIER_CONCESSION_REFUSALS.HELD_BY_DEAL);
  });

  test("another organization's supplier is not found, with the same refusal as a missing id", async () => {
    const w = await seedWorld("foreign");
    const foreign = await seedSupplier(w.t, { orgId: w.otherOrgId, userId: w.owner.userId, displayName: SUPPLIER_NAME });
    const vehicleId = await insertUnlinkedCar(w);
    await addPayable(w, vehicleId);
    await expectRefusedAndUnchanged(w, () => linkOnVehicle(w.finance, w, vehicleId, foreign), SUPPLIER_ERROR.NOT_FOUND);
  });

  test("an inactive supplier takes no new link", async () => {
    const w = await seedWorld("inactive");
    await w.t.run((ctx) => ctx.db.patch(w.supplierId, { status: "INACTIVE" }));
    const vehicleId = await insertUnlinkedCar(w);
    await addPayable(w, vehicleId);
    await expectRefusedAndUnchanged(w, () => linkOnVehicle(w.finance, w, vehicleId, w.supplierId), SUPPLIER_ERROR.INACTIVE);
  });

  test("an EXISTING link stays frozen once money exists, even for a finance manager and even to a supplier with the same name", async () => {
    const w = await seedWorld("frozen");
    const twin = await seedSupplier(w.t, { orgId: w.orgId, userId: w.owner.userId, displayName: "Al-Safeer Trading Co." });
    const vehicleId = await insertUnlinkedCar(w, { linkedTo: w.supplierId });
    await addPayable(w, vehicleId, { supplierId: w.supplierId });
    await expectRefusedAndUnchanged(w, () => linkOnVehicle(w.finance, w, vehicleId, twin), SUPPLIER_ERROR.LINK_FROZEN);
    expect((await vehicleRow(w, vehicleId))?.sourcedSupplierId).toBe(w.supplierId);
    expect(SUPPLIER_LINK_FROZEN_MESSAGE.length).toBeGreaterThan(0);
  });

  test("a car that is not SOURCED cannot take a consignment link by this door", async () => {
    const w = await seedWorld("stock");
    const vehicleId = await insertUnlinkedCar(w);
    await w.t.run((ctx) => ctx.db.patch(vehicleId, { sourceType: "STOCK" } as never));
    await addPayable(w, vehicleId);
    const before = await dbSnapshot(w.t, allTables);
    await expect(linkOnVehicle(w.finance, w, vehicleId, w.supplierId)).rejects.toBeTruthy();
    expect(await dbSnapshot(w.t, allTables)).toEqual(before);
  });
});

describe("first supplier link: the shared check refuses on its own, whatever a door does before it", () => {
  // The doors above also refuse these cases earlier (the ownership-change pilot block, the role-conflict
  // check, the later held-terms guard). These tests call the shared check directly, so removing its own
  // condition is caught even though another guard would still stop the door.
  const financeRole = { name: "Finance Manager", permissions: FINANCE_MANAGER_PERMISSIONS };

  async function callShared(w: World, vehicleId: Id<"vehicles">) {
    try {
      await w.t.run(async (ctx) => {
        const vehicle = (await ctx.db.get(vehicleId))!;
        const link = await snapshotSupplier(ctx, w.orgId, w.supplierId);
        await assertSupplierLinkChangeAllowed(ctx, w.orgId, vehicle, link, { role: financeRole as never });
      });
    } catch (error) {
      return (error as ThrownDomainError).data;
    }
    return undefined;
  }

  test("a car that is not SOURCED is frozen, not first-linked", async () => {
    const w = await seedWorld("shared_stock");
    const vehicleId = await insertUnlinkedCar(w);
    await w.t.run((ctx) => ctx.db.patch(vehicleId, { sourceType: "STOCK" } as never));
    await addPayable(w, vehicleId);
    const refusal = await callShared(w, vehicleId);
    expect(typeof refusal === "object" ? refusal?.code : refusal).toBe(SUPPLIER_ERROR.LINK_FROZEN);
  });

  test("a held supplier concession refuses before the money check", async () => {
    const w = await seedWorld("shared_held");
    const vehicleId = await insertUnlinkedCar(w);
    await addPayable(w, vehicleId);
    await addHeldConcession(w, vehicleId);
    expect(await callShared(w, vehicleId)).toBe(SUPPLIER_CONCESSION_REFUSALS.HELD_BY_DEAL);
  });
});

describe("first supplier link: a sales-originated edit request gains no such power", () => {
  test("requestUpdate by an editor is refused before a request is stored", async () => {
    const w = await seedWorld("req");
    const vehicleId = await insertUnlinkedCar(w);
    await addPayable(w, vehicleId);
    await expectRefusedAndUnchanged(
      w,
      () => w.editor.as.mutation(api.vehicleEdits.requestUpdate, { orgId: w.orgId, vehicleId, payload: { sourcedSupplierId: w.supplierId } }),
      NEEDS_FINANCE_MANAGER
    );
  });

  test("approval of a pending request refuses even for the owner, and the request stays pending", async () => {
    const w = await seedWorld("approve");
    const vehicleId = await insertUnlinkedCar(w);
    await addPayable(w, vehicleId);
    const requestId = await w.t.run((ctx) =>
      ctx.db.insert("vehicleEdits", {
        orgId: w.orgId, vehicleId, requestedBy: w.editor.userId, type: "UPDATE", status: "PENDING", createdAt: Date.now(),
        payload: { sourcedSupplierId: w.supplierId },
      })
    );
    await expectRefusedAndUnchanged(
      w,
      () => w.owner.as.mutation(api.vehicleEdits.resolve, { orgId: w.orgId, requestId, status: "APPROVED" }),
      NEEDS_FINANCE_MANAGER
    );
    expect((await w.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("PENDING");
  });
});

describe("first supplier link: the refusal texts name a step that exists and really works", () => {
  const english: Record<string, string> = commonEn;
  const arabic: Record<string, string> = commonAr;

  test.each([NEEDS_FINANCE_MANAGER, NOT_PROVEN])("%s has an English text equal to the server message and an Arabic text", async (code) => {
    const w = await seedWorld(`text_${code}`);
    const vehicleId = await insertUnlinkedCar(w, code === NOT_PROVEN ? { name: "Different Name LLC" } : {});
    await addPayable(w, vehicleId, code === NOT_PROVEN ? { name: "Different Name LLC" } : {});
    const refusal = await refusalOf(linkOnVehicle(code === NOT_PROVEN ? w.finance : w.editor, w, vehicleId, w.supplierId));
    const data = typeof refusal === "object" ? refusal : undefined;
    expect(data?.code).toBe(code);
    expect(english[`ServerError_${code}`]).toBe(data?.message);
    expect(arabic[`ServerError_${code}`]).toBeTruthy();
    expect(arabic[`ServerError_${code}`]).not.toBe(english[`ServerError_${code}`]);
  });

  test("the unresolved-identity text sends the user to a finance manager, and doing exactly that clears the refusal", async () => {
    const w = await seedWorld("step");
    const vehicleId = await insertUnlinkedCar(w, { status: "SOLD" });
    const payableId = await addPayable(w, vehicleId);
    const markPaid = (key: string) =>
      w.owner.as.mutation(api.sourcingPayables.markPaid, { orgId: w.orgId, payableId, paymentMethod: "CASH", idempotencyKey: key });

    const refusal = await refusalOf(markPaid("step-1"));
    const data = typeof refusal === "object" ? refusal : undefined;
    expect(data?.code).toBe(SUPPLIER_ERROR.IDENTITY_UNRESOLVED);
    for (const text of [data?.message ?? "", english.ServerError_SUPPLIER_IDENTITY_UNRESOLVED, english.ServerError_SUPPLIER_CONCESSION_BASIS_UNBOUND]) {
      expect(text).toMatch(/finance manager/i);
      expect(text).not.toMatch(/reviewed correction/i);
    }
    for (const text of [arabic.ServerError_SUPPLIER_IDENTITY_UNRESOLVED, arabic.ServerError_SUPPLIER_CONCESSION_BASIS_UNBOUND]) {
      expect(text).not.toMatch(/تصحيحاً مراجعاً/);
    }

    // The step the text names: a finance manager links the vehicle, then the repair binds the row.
    await linkOnVehicle(w.finance, w, vehicleId, w.supplierId);
    await repairEverything(w);
    await markPaid("step-2");
    expect((await w.t.run((ctx) => ctx.db.get(payableId)))?.status).toBe("PAID");
  });
});
