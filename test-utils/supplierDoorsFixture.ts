/**
 * SCRUM-869 S1: one fixture for the three supplier-settlement doors (supplier payable payment,
 * consignment margin receipt, cost-recovery receipt). The caller must `vi.mock("./rateLimit", ...)`
 * exactly as the other money suites do.
 */
import { convexTestWithComponents } from "./convexTest";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { ALL_PERMISSIONS } from "../convex/utils/permissions";
import { SYSTEM_KEYS } from "../convex/utils/defaultChart";
import { seedBank } from "./bankFixture";

export const SCALE = 1000; // JOD minor units per major unit

export type SupplierT = ReturnType<typeof convexTestWithComponents>;

export async function addSupplierOrg(t: SupplierT, tag: string, permissions: string[] = ALL_PERMISSIONS) {
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S869 ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_owner`, email: `${tag}@example.test`, name: `S869 ${tag}` })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Owner", permissions, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );
  const as = t.withIdentity({ subject: `${tag}_owner`, clerkId: `${tag}_owner` });
  await as.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await as.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear,
    periodNumber: 1,
  });
  const period = (await as.query(api.accountingPeriods.list, { orgId }))[0];
  await as.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  return { orgId, userId, as, periodId: period._id };
}

/** A second user of the same org who may only view finance. */
export async function addViewOnlyUser(t: SupplierT, orgId: Id<"organizations">, tag: string) {
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_viewer`, email: `${tag}v@example.test` }));
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Viewer", permissions: ["view:finance"] }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  return t.withIdentity({ subject: `${tag}_viewer`, clerkId: `${tag}_viewer` });
}

export async function seedSupplierDoors(tag = "s869") {
  const t = convexTestWithComponents(schema, import.meta.glob("../convex/**/*.*s"));
  const org = await addSupplierOrg(t, tag);
  const viewer = await addViewOnlyUser(t, org.orgId, tag);
  const other = await addSupplierOrg(t, `${tag}x`);
  const supplierId = await t.run((ctx) =>
    ctx.db.insert("suppliers", {
      orgId: org.orgId,
      displayName: "Amman Importer Co",
      displayNameKey: "amman importer co",
      status: "ACTIVE",
      version: 1,
      origin: "MANUAL",
      createdBy: org.userId,
      createdAt: Date.now(),
      updatedBy: org.userId,
      updatedAt: Date.now(),
    })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: org.orgId, vin: `VIN${tag}`, make: "Toyota", model: "Camry", year: 2024, mileage: 10,
      color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: 12_500, status: "SOLD",
      sourceType: "SOURCED", sourcedSupplierId: supplierId, sourcedFromName: "Amman Importer Co", sourceCost: 9_500,
    } as never)
  );
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId: org.orgId, firstName: "Jane", lastName: "Doe" }));
  const saleId = await t.run((ctx) =>
    ctx.db.insert("sales", {
      orgId: org.orgId, vehicleId, customerId, salespersonId: org.userId,
      salePrice: 12_500, saleDate: Date.now(), status: "COMPLETED",
    })
  );
  return { t, ...org, viewer, other, supplierId, vehicleId, saleId };
}
export type SupplierDoors = Awaited<ReturnType<typeof seedSupplierDoors>>;

export async function insertPayable(s: SupplierDoors, amountDue: number) {
  return await s.t.run((ctx) =>
    ctx.db.insert("vehicleSupplierPayables", {
      orgId: s.orgId, vehicleId: s.vehicleId, saleId: s.saleId, supplierId: s.supplierId, supplierSnapshotVersion: 1, sourcedFromName: "Amman Importer Co",
      amountDue, currency: "JOD", status: "PENDING", createdBy: s.userId, createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
}

export async function insertReceivable(s: SupplierDoors, amountDue: number) {
  return await s.t.run((ctx) =>
    ctx.db.insert("vehicleSupplierReceivables", {
      orgId: s.orgId, vehicleId: s.vehicleId, saleId: s.saleId, supplierId: s.supplierId, supplierSnapshotVersion: 1, sourcedFromName: "Amman Importer Co",
      amountDue, currency: "JOD", status: "OPEN", createdBy: s.userId, createdAt: Date.now(), updatedAt: Date.now(),
    } as never)
  );
}

/** Pays a supplier-borne expense in cash; that opens exactly one cost recovery. */
export async function openRecovery(s: SupplierDoors, amountMajor: number) {
  const expenseId = (await s.as.mutation(api.expenses.create, {
    orgId: s.orgId, vehicleId: s.vehicleId, title: "Transport from the supplier's yard", amount: amountMajor,
    date: Date.now() - 60_000, category: "TRANSPORT", status: "PAID", paymentMethod: "CASH",
    costBearer: "SUPPLIER", idempotencyKey: crypto.randomUUID(),
  } as never)) as Id<"expenses">;
  const recovery = await s.t.run((ctx) =>
    ctx.db.query("supplierCostRecoveries").withIndex("by_org_expense", (q) => q.eq("orgId", s.orgId).eq("expenseId", expenseId)).first()
  );
  return { expenseId, recoveryId: recovery!._id };
}

export { seedBank };

/** Net debit minus credit per system key, plus a per-entry balance check. */
export async function ledgerOf(t: SupplierT, orgId: Id<"organizations">) {
  return await t.run(async (ctx) => {
    const accounts = (await ctx.db.query("chartOfAccounts").collect()).filter((a) => a.orgId === orgId);
    const keyOf = new Map<string, string>();
    for (const a of accounts) if (a.systemKey) keyOf.set(a._id, a.systemKey);
    const entries = (await ctx.db.query("journalEntries").collect()).filter(
      (e) => e.orgId === orgId && (e.status === "POSTED" || e.status === "REVERSED")
    );
    const lines = await ctx.db.query("journalLines").collect();
    const net: Record<string, number> = {};
    let unbalancedEntries = 0;
    for (const entry of entries) {
      let debit = 0;
      let credit = 0;
      for (const l of lines.filter((x) => x.journalEntryId === entry._id)) {
        const key = keyOf.get(l.accountId) ?? "unkeyed";
        net[key] = (net[key] ?? 0) + l.debitMinor - l.creditMinor;
        debit += l.debitMinor;
        credit += l.creditMinor;
      }
      if (debit !== credit) unbalancedEntries++;
    }
    return { net, unbalancedEntries, entryCount: entries.length };
  });
}

export const KEYS = SYSTEM_KEYS;
