import { describe, expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { seedOrgWithMember } from "../test-utils/seedOrg";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { PERMISSIONS } from "./utils/permissions";
import { SUPPLIER_ERROR, snapshotSupplier } from "./utils/supplierRegistry";

/**
 * SCRUM-868 P1: widen-only supplier identity fields, their indexes, and the supplier snapshot
 * helper. Design: docs/architecture/scrum868-supplier-identity-design.md, sections 4.3 and 8.
 *
 * Invariants under test:
 *  - N-widen: every document written before this change (no supplier id) is still valid, and a
 *    document that carries the new field is valid too. Nothing is required in storage.
 *  - N6: a foreign supplier id and a missing supplier id are refused identically (no existence
 *    oracle), and the organisation is the caller's, never the client's.
 *  - N3: the snapshot is the name the server read, and a later rename never changes a snapshot
 *    already taken.
 *  - N10: an inactive supplier takes no new use, but its row still resolves for existing references.
 *  - N4: taking a snapshot writes nothing.
 *
 * `convex-test` does not model the real push-time validation of a populated deployment (a disposable
 * preview seeded with old-shaped data is still needed), but it validates every insert against the
 * schema, so an old-shaped document being accepted here proves the new fields are optional.
 */

const MODULES = import.meta.glob("./**/*.*s");

function setup() {
  return convexTestWithComponents(schema, MODULES);
}
type T = ReturnType<typeof setup>;

const FINANCE = [PERMISSIONS.VIEW_FINANCE, PERMISSIONS.MANAGE_FINANCE];

let seq = 0;
const nextKey = (): string => `ident-${++seq}`;

type Refusal = { data: unknown; code: string | undefined };

async function refusal(promise: Promise<unknown>): Promise<Refusal> {
  try {
    await promise;
  } catch (error) {
    const data = (error as { data?: unknown }).data;
    const code =
      typeof data === "object" && data !== null && typeof (data as { code?: unknown }).code === "string"
        ? (data as { code: string }).code
        : undefined;
    return { data, code };
  }
  throw new Error("Expected the call to be refused, but it succeeded.");
}

async function seedOrg(t: T, label: string) {
  const seeded = await seedOrgWithMember(t, {
    clerkId: `ident-${label}-${nextKey()}`,
    permissions: FINANCE,
    orgName: `Org ${label}`,
    roleName: "ACCOUNTANT",
  });
  await t.mutation(internal.suppliers.initialiseRegistry, { orgId: seeded.orgId });
  return { orgId: seeded.orgId, acct: seeded.identity, userId: seeded.userId };
}
type Seed = Awaited<ReturnType<typeof seedOrg>>;

async function createSupplier(seed: Seed, displayName: string): Promise<Id<"suppliers">> {
  const { supplierId } = await seed.acct.mutation(api.suppliers.create, {
    orgId: seed.orgId,
    idempotencyKey: nextKey(),
    displayName,
  });
  return supplierId;
}

// ─── Schema: widen-only fields ────────────────────────────────────────────────────────────────

interface Fixture {
  orgId: Id<"organizations">;
  userId: Id<"users">;
  vehicleId: Id<"vehicles">;
  saleId: Id<"sales">;
  draftId: Id<"openingBalanceDrafts">;
  expenseId: Id<"expenses">;
  customerId: Id<"customers">;
  quoteId: Id<"quotes">;
  companyId: Id<"financeCompanies">;
  supplierId: Id<"suppliers">;
}

const NOW = 1_700_000_000_000;

async function buildFixture(t: T, seed: Seed): Promise<Fixture> {
  const supplierId = await createSupplier(seed, "Fixture Supplier");
  return t.run(async (ctx) => {
    const { orgId, userId } = seed;
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId, vin: `VIN-${nextKey()}`, make: "Toyota", model: "Camry", year: 2022, mileage: 1, color: "White",
      fuelType: "Petrol", transmission: "Automatic", purchasePrice: 8000, sellingPrice: 12000, status: "AVAILABLE",
    });
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "Dana", lastName: "Saleh" });
    const companyId = await ctx.db.insert("financeCompanies", {
      orgId, name: "Test Bank", isActive: true, profitRate: 5.5, maxTermMonths: 72, gracePeriodMonths: 3,
    });
    const quoteId = await ctx.db.insert("quotes", {
      orgId, vehicleId, customerId, vehiclePrice: 12000, downPayment: 2000, totalFinancedAmount: 10000,
      termMonths: 24, status: "DRAFT", companyId, createdBy: userId, createdAt: NOW,
    });
    const draftId = await ctx.db.insert("openingBalanceDrafts", {
      orgId, status: "POSTED", lines: [], asOfDate: 1, createdBy: userId, createdAt: 1,
    });
    // A sale and an expense are only ever referenced by id here; the cheapest valid rows are used.
    const saleId = await ctx.db.insert("sales", {
      orgId, vehicleId, customerId, salespersonId: userId, salePrice: 12000, saleDate: NOW, status: "COMPLETED",
    });
    const expenseId = await ctx.db.insert("expenses", { orgId, title: "Fixture expense", category: "OTHER", amount: 10, date: NOW });
    return { orgId, userId, vehicleId, saleId, draftId, expenseId, customerId, quoteId, companyId, supplierId };
  });
}

type Insert = (ctx: Parameters<Parameters<T["run"]>[0]>[0], f: Fixture, withIdentity: boolean) => Promise<unknown>;

const payableCommon = (f: Fixture) => ({
  orgId: f.orgId, sourcedFromName: "Gulf Motors", amountDue: 100, currency: "JOD", status: "PENDING" as const,
  createdBy: f.userId, createdAt: NOW, updatedAt: NOW,
});
const recoveryCommon = (f: Fixture) => ({
  orgId: f.orgId, sourcedFromName: "Gulf Motors", amountDueMinor: 100_000, amountRecoveredMinor: 0,
  currency: "JOD", receiptSeq: 0, status: "OPEN" as const, createdBy: f.userId, createdAt: NOW, updatedAt: NOW,
});
const stamp = (f: Fixture, withIdentity: boolean) =>
  withIdentity ? { supplierId: f.supplierId, supplierSnapshotVersion: 1 } : {};

/** One entry per stored shape that gains an identity field. Each is inserted old-shaped and new-shaped. */
const SHAPES: Array<{ label: string; table: string; insert: Insert; field: string }> = [
  {
    label: "vehicles (SOURCED)", table: "vehicles", field: "sourcedSupplierId",
    insert: (ctx, f, withIdentity) => ctx.db.insert("vehicles", {
      orgId: f.orgId, vin: `VIN-${nextKey()}`, make: "Kia", model: "Rio", year: 2021, mileage: 1, color: "Red",
      fuelType: "Petrol", transmission: "Automatic", purchasePrice: 7000, sellingPrice: 9000, status: "AVAILABLE",
      sourceType: "SOURCED", sourcedFromName: "Gulf Motors",
      ...(withIdentity ? { sourcedSupplierId: f.supplierId } : {}),
    }),
  },
  {
    label: "vehicleEdits payload (CREATE)", table: "vehicleEdits", field: "payload.sourcedSupplierId",
    insert: (ctx, f, withIdentity) => ctx.db.insert("vehicleEdits", {
      orgId: f.orgId, requestedBy: f.userId, type: "CREATE", status: "PENDING", createdAt: NOW,
      payload: {
        vin: "VIN-EDIT", sourceType: "SOURCED", sourcedFromName: "Gulf Motors", purchaseSupplierName: "Gulf Motors",
        ...(withIdentity ? { sourcedSupplierId: f.supplierId, purchaseSupplierId: f.supplierId } : {}),
      },
    }),
  },
  {
    label: "vehicleSupplierPayables (NATIVE)", table: "vehicleSupplierPayables", field: "supplierId",
    insert: (ctx, f, withIdentity) => ctx.db.insert("vehicleSupplierPayables", {
      ...payableCommon(f), vehicleId: f.vehicleId, ...stamp(f, withIdentity),
    }),
  },
  {
    label: "vehicleSupplierPayables (OPENING)", table: "vehicleSupplierPayables", field: "supplierId",
    insert: (ctx, f, withIdentity) => ctx.db.insert("vehicleSupplierPayables", {
      ...payableCommon(f), origin: "OPENING", openingBalanceDraftId: f.draftId, openingRowKey: `row-${nextKey()}`,
      openingKind: "SUPPLIER_PAYABLE", title: "Opening payable", ...stamp(f, withIdentity),
    }),
  },
  {
    label: "vehicleSupplierReceivables", table: "vehicleSupplierReceivables", field: "supplierId",
    insert: (ctx, f, withIdentity) => ctx.db.insert("vehicleSupplierReceivables", {
      orgId: f.orgId, vehicleId: f.vehicleId, saleId: f.saleId, sourcedFromName: "Gulf Motors", amountDue: 50,
      currency: "JOD", status: "OPEN", createdBy: f.userId, createdAt: NOW, updatedAt: NOW,
      ...stamp(f, withIdentity),
    }),
  },
  {
    label: "supplierCostRecoveries (EXPENSE)", table: "supplierCostRecoveries", field: "supplierId",
    insert: (ctx, f, withIdentity) => ctx.db.insert("supplierCostRecoveries", {
      ...recoveryCommon(f), vehicleId: f.vehicleId, expenseId: f.expenseId, sourceEventKey: `evt-${nextKey()}`,
      ...stamp(f, withIdentity),
    }),
  },
  {
    label: "supplierCostRecoveries (OPENING)", table: "supplierCostRecoveries", field: "supplierId",
    insert: (ctx, f, withIdentity) => ctx.db.insert("supplierCostRecoveries", {
      ...recoveryCommon(f), origin: "OPENING", openingBalanceDraftId: f.draftId, openingRowKey: `row-${nextKey()}`,
      title: "Opening claim", purpose: "CLAIM", ...stamp(f, withIdentity),
    }),
  },
  {
    label: "vehicleOwnershipConversions", table: "vehicleOwnershipConversions", field: "supplierId",
    insert: (ctx, f, withIdentity) => ctx.db.insert("vehicleOwnershipConversions", {
      orgId: f.orgId, vehicleId: f.vehicleId, fromSourceType: "SOURCED", toSourceType: "STOCK",
      supplierName: "Gulf Motors", convertedBy: f.userId, convertedAt: NOW,
      ...(withIdentity ? { supplierId: f.supplierId } : {}),
    }),
  },
  {
    label: "financeApplications.supplierGapBasis", table: "financeApplications", field: "supplierGapBasis.supplierId",
    insert: (ctx, f, withIdentity) => ctx.db.insert("financeApplications", {
      orgId: f.orgId, customerId: f.customerId, vehicleId: f.vehicleId, companyId: f.companyId,
      quoteId: f.quoteId, salespersonId: f.userId, status: "DRAFT", createdAt: NOW, updatedAt: NOW,
      supplierGapBasis: {
        contractEntitlementMinor: 1_000_000, currency: "JOD", supplierName: "Gulf Motors",
        ...(withIdentity ? { supplierId: f.supplierId } : {}),
      },
    }),
  },
];

describe("SCRUM-868 P1: supplier identity fields are widen-only", () => {
  test.each(SHAPES)("$label accepts an old document with no supplier id", async (shape) => {
    const t = setup();
    const seed = await seedOrg(t, "old");
    const fixture = await buildFixture(t, seed);
    const id = await t.run((ctx) => shape.insert(ctx, fixture, false) as Promise<Id<"vehicles">>);
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain(fixture.supplierId);
  });

  test.each(SHAPES)("$label accepts a document that carries the new supplier id", async (shape) => {
    const t = setup();
    const seed = await seedOrg(t, "new");
    const fixture = await buildFixture(t, seed);
    const id = await t.run((ctx) => shape.insert(ctx, fixture, true) as Promise<Id<"vehicles">>);
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(JSON.stringify(row)).toContain(fixture.supplierId);
  });

  test("a supplier id field refuses an id from another table (the field points at suppliers)", async () => {
    const t = setup();
    const seed = await seedOrg(t, "wrongtable");
    const fixture = await buildFixture(t, seed);
    await expect(
      t.run((ctx) =>
        ctx.db.insert("vehicleSupplierPayables", {
          ...payableCommon(fixture), vehicleId: fixture.vehicleId,
          supplierId: fixture.userId as unknown as Id<"suppliers">,
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("SCRUM-868 P1: indexes for the supplier identity fields", () => {
  test("the three subledgers are readable by organisation, supplier and status, and a row with no supplier id is not returned", async () => {
    const t = setup();
    const seed = await seedOrg(t, "idx");
    const f = await buildFixture(t, seed);
    const other = await createSupplier(seed, "Other Supplier");
    await t.run(async (ctx) => {
      await ctx.db.insert("vehicleSupplierPayables", { ...payableCommon(f), vehicleId: f.vehicleId, supplierId: f.supplierId });
      await ctx.db.insert("vehicleSupplierPayables", { ...payableCommon(f), vehicleId: f.vehicleId, supplierId: other });
      await ctx.db.insert("vehicleSupplierPayables", { ...payableCommon(f), vehicleId: f.vehicleId });
      await ctx.db.insert("vehicleSupplierReceivables", {
        orgId: f.orgId, vehicleId: f.vehicleId, saleId: f.saleId, sourcedFromName: "Gulf Motors", amountDue: 50,
        currency: "JOD", status: "OPEN", createdBy: f.userId, createdAt: NOW, updatedAt: NOW, supplierId: f.supplierId,
      });
      await ctx.db.insert("supplierCostRecoveries", {
        ...recoveryCommon(f), vehicleId: f.vehicleId, expenseId: f.expenseId, sourceEventKey: "k1", supplierId: f.supplierId,
      });
    });
    const found = await t.run(async (ctx) => ({
      payables: await ctx.db.query("vehicleSupplierPayables")
        .withIndex("by_org_and_supplierId_and_status", (q) => q.eq("orgId", f.orgId).eq("supplierId", f.supplierId).eq("status", "PENDING"))
        .collect(),
      receivables: await ctx.db.query("vehicleSupplierReceivables")
        .withIndex("by_org_and_supplierId_and_status", (q) => q.eq("orgId", f.orgId).eq("supplierId", f.supplierId).eq("status", "OPEN"))
        .collect(),
      recoveries: await ctx.db.query("supplierCostRecoveries")
        .withIndex("by_org_and_supplierId_and_status", (q) => q.eq("orgId", f.orgId).eq("supplierId", f.supplierId).eq("status", "OPEN"))
        .collect(),
    }));
    expect(found.payables).toHaveLength(1);
    expect(found.receivables).toHaveLength(1);
    expect(found.recoveries).toHaveLength(1);
  });

  test("vehicles are readable by organisation and consignment supplier", async () => {
    const t = setup();
    const seed = await seedOrg(t, "vidx");
    const f = await buildFixture(t, seed);
    const rows = await t.run(async (ctx) => {
      await ctx.db.insert("vehicles", {
        orgId: f.orgId, vin: "VIN-IDX-1", make: "Kia", model: "Rio", year: 2021, mileage: 1, color: "Red",
        fuelType: "Petrol", transmission: "Automatic", purchasePrice: 7000, sellingPrice: 9000, status: "AVAILABLE",
        sourceType: "SOURCED", sourcedFromName: "Gulf Motors", sourcedSupplierId: f.supplierId,
      });
      return ctx.db.query("vehicles")
        .withIndex("by_org_and_sourcedSupplierId", (q) => q.eq("orgId", f.orgId).eq("sourcedSupplierId", f.supplierId))
        .collect();
    });
    expect(rows).toHaveLength(1);
  });
});

// ─── Helper: snapshotSupplier ─────────────────────────────────────────────────────────────────

describe("SCRUM-868 P1: error codes", () => {
  test("the unresolved-identity codes are stable strings", () => {
    expect(SUPPLIER_ERROR.IDENTITY_REQUIRED).toBe("SUPPLIER_IDENTITY_REQUIRED");
    expect(SUPPLIER_ERROR.IDENTITY_UNRESOLVED).toBe("SUPPLIER_IDENTITY_UNRESOLVED");
    expect(SUPPLIER_ERROR.NOT_FOUND).toBe("SUPPLIER_NOT_FOUND");
  });
});

describe("SCRUM-868 P1: snapshotSupplier", () => {
  test("returns the id, the server-read display name and the master version", async () => {
    const t = setup();
    const seed = await seedOrg(t, "snap");
    const supplierId = await createSupplier(seed, "  Gulf   Motors  ");
    const row = await t.run((ctx) => ctx.db.get(supplierId));
    const snapshot = await t.run((ctx) => snapshotSupplier(ctx, seed.orgId, supplierId));
    expect(snapshot).toEqual({ supplierId, name: row!.displayName, version: row!.version });
    // The name is what the master stores (trimmed by the master on create), not anything the caller typed.
    expect(snapshot.name).toBe("Gulf   Motors");
  });

  test("takes no name argument: a client-typed name has no way in", () => {
    // Arity: (ctx, orgId, supplierId). A fourth value would be a client-controlled name or org.
    expect(snapshotSupplier.length).toBe(3);
  });

  test("a snapshot already taken does not change when the supplier is renamed", async () => {
    const t = setup();
    const seed = await seedOrg(t, "rename");
    const supplierId = await createSupplier(seed, "Old Name Trading");
    const before = await t.run((ctx) => snapshotSupplier(ctx, seed.orgId, supplierId));
    await seed.acct.mutation(api.suppliers.update, {
      orgId: seed.orgId, supplierId, expectedVersion: before.version, displayName: "New Name Trading",
      reason: "Legal rename",
    });
    const after = await t.run((ctx) => snapshotSupplier(ctx, seed.orgId, supplierId));
    expect(before.name).toBe("Old Name Trading");
    expect(after.name).toBe("New Name Trading");
    expect(after.version).toBeGreaterThan(before.version);
  });

  test("a foreign-organisation id and a missing id are refused with the same coded error", async () => {
    const t = setup();
    const a = await seedOrg(t, "A");
    const b = await seedOrg(t, "B");
    const foreign = await createSupplier(b, "Org B Only");
    const gone = await createSupplier(a, "Soon Gone");
    await t.run(async (ctx) => ctx.db.delete(gone)); // test-only removal; no convex/ function deletes a supplier

    const foreignRefusal = await refusal(t.run((ctx) => snapshotSupplier(ctx, a.orgId, foreign)));
    const missingRefusal = await refusal(t.run((ctx) => snapshotSupplier(ctx, a.orgId, gone)));
    expect(foreignRefusal.code).toBe("SUPPLIER_NOT_FOUND");
    expect(foreignRefusal.data).toEqual(missingRefusal.data);
    // The owner organisation still resolves it, so the refusal is about the org and not the id.
    await expect(t.run((ctx) => snapshotSupplier(ctx, b.orgId, foreign))).resolves.toMatchObject({ supplierId: foreign });
  });

  test("an absent supplier id is refused as SUPPLIER_IDENTITY_REQUIRED, with no fallback", async () => {
    const t = setup();
    const seed = await seedOrg(t, "required");
    for (const absent of [undefined, null]) {
      const refused = await refusal(t.run((ctx) => snapshotSupplier(ctx, seed.orgId, absent)));
      expect(refused.code).toBe("SUPPLIER_IDENTITY_REQUIRED");
    }
  });

  test("an inactive supplier is refused for new use, but its row and existing references still resolve", async () => {
    const t = setup();
    const seed = await seedOrg(t, "inactive");
    const f = await buildFixture(t, seed);
    const taken = await t.run((ctx) => snapshotSupplier(ctx, seed.orgId, f.supplierId));
    const payableId = await t.run((ctx) =>
      ctx.db.insert("vehicleSupplierPayables", {
        ...payableCommon(f), vehicleId: f.vehicleId, supplierId: f.supplierId, supplierSnapshotVersion: taken.version,
      }),
    );
    await seed.acct.mutation(api.suppliers.deactivate, { orgId: seed.orgId, supplierId: f.supplierId, reason: "Closed" });

    const refused = await refusal(t.run((ctx) => snapshotSupplier(ctx, seed.orgId, f.supplierId)));
    expect(refused.code).toBe("SUPPLIER_INACTIVE");

    const existing = await t.run(async (ctx) => {
      const payable = await ctx.db.get(payableId);
      return { payable, supplier: payable?.supplierId ? await ctx.db.get(payable.supplierId) : null };
    });
    expect(existing.payable?.supplierId).toBe(f.supplierId);
    expect(existing.supplier?.status).toBe("INACTIVE");
  });

  test("taking a snapshot writes nothing: no row added, changed or removed, and the registry version is unchanged", async () => {
    const t = setup();
    const seed = await seedOrg(t, "nowrite");
    const supplierId = await createSupplier(seed, "Read Only Co");
    const world = () =>
      t.run(async (ctx) => JSON.stringify({
        suppliers: await ctx.db.query("suppliers").take(100),
        aliases: await ctx.db.query("supplierAliases").take(100),
        registry: await ctx.db.query("supplierRegistryState").take(100),
        audit: await ctx.db.query("adminAuditLog").take(100),
        payables: await ctx.db.query("vehicleSupplierPayables").take(100),
        events: await ctx.db.query("accountingEvents").take(100),
      }));
    const before = await world();
    await t.run((ctx) => snapshotSupplier(ctx, seed.orgId, supplierId));
    await refusal(t.run((ctx) => snapshotSupplier(ctx, seed.orgId, undefined)));
    expect(await world()).toBe(before);
  });
});
