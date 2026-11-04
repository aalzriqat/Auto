/**
 * SCRUM-869 feature 5 - the supplier "needs attention" view (ADR docs/adr/2026-11-04-supplier-attention-view.md).
 * Read-only. Evidence boundary: convex-test only, seeded rows. 9,500 JOD is 9_500_000 minor units.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { STATEMENT_FAMILY_LIMIT } from "./utils/supplierObligationDue";

const MODULES = import.meta.glob("./**/*.*s");
const DAY = 86_400_000;
const NOW = Date.parse("2026-06-15T09:00:00Z");

afterEach(() => {
  vi.useRealTimers();
});

type SupplierDb = { db: { insert: (table: "suppliers", doc: never) => Promise<Id<"suppliers">> } };
const insertSupplier = (ctx: SupplierDb, orgId: Id<"organizations">, userId: Id<"users">, displayName: string) =>
  ctx.db.insert("suppliers", {
    orgId, displayName, displayNameKey: displayName.toLowerCase(), status: "ACTIVE", origin: "MANUAL", version: 1,
    createdBy: userId, updatedBy: userId, createdAt: NOW, updatedAt: NOW,
  } as never);

async function seed(tag: string, permissions: string[] = ["view:finance"]) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `AT ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: "AT User" }));
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Finance", permissions }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asUser = t.withIdentity({ subject: `${tag}_u`, clerkId: `${tag}_u` });
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag }));
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VIN${tag}`, make: "Toyota", model: "Camry", year: 2024, mileage: 10, color: "White",
      fuelType: "Gas", transmission: "Auto", sellingPrice: 12_500, status: "AVAILABLE", sourceType: "SOURCED",
      sourcedFromName: "Amman Importer Co", sourceCost: 9_500,
    })
  );
  const supplierId = await t.run((ctx) => insertSupplier(ctx, orgId, userId, "Amman Importer Co"));
  return { t, orgId, userId, asUser, customerId, vehicleId, supplierId };
}
type Seed = Awaited<ReturnType<typeof seed>>;

const addPayable = (s: Seed, fields: Record<string, unknown> = {}) =>
  s.t.run((ctx) =>
    ctx.db.insert("vehicleSupplierPayables", {
      orgId: s.orgId, vehicleId: s.vehicleId, supplierId: s.supplierId, sourcedFromName: "Amman Importer Co", amountDue: 9_500,
      currency: "JOD", status: "DUE_ON_SALE", paymentDueDate: NOW - 10 * DAY, createdBy: s.userId, createdAt: NOW, updatedAt: NOW,
      ...fields,
    } as never)
  );

const addReceivable = async (s: Seed, fields: Record<string, unknown> = {}) => {
  const saleId = await s.t.run((ctx) =>
    ctx.db.insert("sales", {
      orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.userId,
      salePrice: 12_500, saleDate: NOW - 40 * DAY, status: "COMPLETED",
    } as never)
  );
  return await s.t.run((ctx) =>
    ctx.db.insert("vehicleSupplierReceivables", {
      orgId: s.orgId, vehicleId: s.vehicleId, saleId, supplierId: s.supplierId, sourcedFromName: "Amman Importer Co",
      amountDue: 3_000, currency: "JOD", status: "OPEN", agreedDueDate: NOW + 5 * DAY, createdBy: s.userId,
      createdAt: NOW, updatedAt: NOW, ...fields,
    } as never)
  );
};

const attention = (s: Seed, supplierId: Id<"suppliers"> = s.supplierId, nowMs = NOW) =>
  s.asUser.query(api.supplierStatement.attention, { orgId: s.orgId, supplierId, nowMs });

describe("SCRUM-869 supplier attention view", () => {
  test("an overdue payable is ALERTING at the step its day reached; a receivable not yet due is absent; sections stay apart", async () => {
    const s = await seed("alerting");
    await addPayable(s); // 10 days overdue -> OVERDUE_7
    await addReceivable(s); // due in 5 days -> NOT_YET
    const r = await attention(s);
    expect(r.payable.rows).toHaveLength(1);
    expect(r.payable.rows[0]).toMatchObject({
      kind: "PAYABLE", currency: "JOD", outstandingMinor: 9_500_000, status: "ALERTING", step: "OVERDUE_7", daysOverdue: 10,
    });
    expect(r.payable.rows[0]).not.toHaveProperty("heldReason");
    expect(r.receivable.rows).toEqual([]);
    expect(Object.keys(r).sort()).toEqual(["payable", "receivable", "supplierId"]);
  });

  test("a disputed payable is HELD for the dispute, not silently healthy; the same row undisputed alerts", async () => {
    const s = await seed("disputed");
    await addPayable(s, { status: "DISPUTED" });
    const r = await attention(s);
    expect(r.payable.rows).toHaveLength(1);
    expect(r.payable.rows[0]).toMatchObject({ status: "HELD", heldReason: "DISPUTED", disputedMinor: 9_500_000 });
    expect(r.payable.rows[0]).not.toHaveProperty("step");
  });

  test("an obligation with no due date is HELD for that reason", async () => {
    const s = await seed("nodue");
    await addPayable(s, { status: "PENDING", paymentDueDate: undefined });
    const r = await attention(s);
    expect(r.payable.rows).toHaveLength(1);
    expect(r.payable.rows[0]).toMatchObject({ status: "HELD", heldReason: "NO_DUE_DATE", dueDate: null });
  });

  test("a due receivable alerts in the receivable section only", async () => {
    const s = await seed("ar");
    await addReceivable(s, { agreedDueDate: NOW + DAY }); // due tomorrow -> T_MINUS_3
    const r = await attention(s);
    expect(r.payable.rows).toEqual([]);
    expect(r.receivable.rows[0]).toMatchObject({ kind: "RECEIVABLE", status: "ALERTING", step: "T_MINUS_3" });
  });

  test("another supplier's rows are excluded", async () => {
    const s = await seed("other");
    const otherId = await s.t.run((ctx) => insertSupplier(ctx, s.orgId, s.userId, "Other Co"));
    await addPayable(s, { supplierId: otherId });
    const r = await attention(s);
    expect(r.payable.rows).toEqual([]);
  });

  test("a family over the read bound reports complete=false", async () => {
    const s = await seed("bound");
    for (let i = 0; i < STATEMENT_FAMILY_LIMIT + 1; i++) await addPayable(s);
    const r = await attention(s);
    expect(r.payable.complete).toBe(false);
  });

  test("tenancy and permission: foreign supplier, other org, missing view:finance and a stale clock all refuse", async () => {
    const s = await seed("tenancy");
    const other = await s.t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", { name: "Other org", createdAt: NOW });
      return await insertSupplier(ctx, orgId, s.userId, "Foreign");
    });
    await expect(attention(s, other)).rejects.toThrow();
    await expect(attention(s, s.supplierId, NOW + 3 * DAY)).rejects.toThrow(/nowMs/);
    const noPerm = await seed("noperm", []);
    await expect(attention(noPerm)).rejects.toThrow();
  });
});
