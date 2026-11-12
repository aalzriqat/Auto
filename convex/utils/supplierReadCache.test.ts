import { afterEach, expect, test, vi } from "vitest";
import type { WithoutSystemFields } from "convex/server";
import type { Doc } from "../_generated/dataModel";
import { convexTestWithComponents } from "../../test-utils/convexTest";
import schema from "../schema";
import { createSupplierReadCache, readCached, type CachedTable } from "./supplierReadCache";

afterEach(() => vi.useRealTimers());

async function cacheFixture() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(100);
  const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
  const ids = await t.run(async ctx => {
    const orgId = await ctx.db.insert("organizations", { name: "Cache contract", createdAt: 100 });
    const foreignOrg = await ctx.db.insert("organizations", { name: "Other cache contract", createdAt: 100 });
    const userId = await ctx.db.insert("users", { clerkId: "cache-contract", email: "cache@example.test" });
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "Synthetic", lastName: "Buyer" });
    const vehicleId = await ctx.db.insert("vehicles", { orgId, make: "Toyota", model: "Camry", year: 2024, mileage: 1, color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: 13, status: "AVAILABLE" });
    const companyId = await ctx.db.insert("financeCompanies", { orgId, name: "Synthetic", isActive: true, profitRate: 5, maxTermMonths: 72, gracePeriodMonths: 3 });
    const quoteId = await ctx.db.insert("quotes", { orgId, vehicleId, customerId, vehiclePrice: 12, downPayment: 2, totalFinancedAmount: 10, termMonths: 24, status: "DRAFT", companyId, createdBy: userId, createdAt: 100 });
    return { orgId, foreignOrg, userId, customerId, vehicleId, companyId, quoteId };
  });
  return { t, ...ids };
}

type CacheFixture = Awaited<ReturnType<typeof cacheFixture>>;
type CacheCase<T extends CachedTable> = { at: number; stored: WithoutSystemFields<Doc<T>>; expected: WithoutSystemFields<Doc<T>> };

async function exactCacheContract<T extends CachedTable>(f: CacheFixture, table: T, cache: Map<Doc<T>["_id"], Doc<T> | null>, cells: readonly CacheCase<T>[]) {
  const expectations: { id: Doc<T>["_id"]; document: Doc<T> | null }[] = [];
  for (const cell of cells) {
    vi.setSystemTime(cell.at);
    const id = await f.t.run(ctx => ctx.db.insert(table, cell.stored));
    expectations.push({ id, document: { ...cell.expected, _id: id, _creationTime: cell.at } as Doc<T> });
  }
  vi.setSystemTime(5000);
  const missing = await f.t.run(ctx => ctx.db.insert(table, cells[0]!.stored));
  await f.t.run(ctx => ctx.db.delete(missing));
  expectations.push({ id: missing, document: null });
  await f.t.run(async ctx => {
    const reads = vi.spyOn(ctx.db, "get"); // Call-through database boundary; no dependency implementation is mocked.
    try {
      for (let first = 0; first < expectations.length; first += 1) {
        cache.clear();
        const ordered = [...expectations.slice(first), ...expectations.slice(0, first)];
        const start = reads.mock.calls.length;
        for (const path of ["miss", "hit"]) {
          for (const cell of ordered) {
            expect(await readCached(ctx, cache, cell.id), table + "/" + first + "/" + path + "/" + cell.id).toStrictEqual(cell.document);
            if (path === "miss") expect(await readCached(ctx, cache, cell.id), table + ": immediate same-phase hit").toStrictEqual(cell.document);
          }
        }
        expect(reads.mock.calls.length - start, table + ": one real get per distinct id including missing").toBe(4);
        expect(reads.mock.calls.slice(start).map(([id]) => id), table + ": asserted miss ordering for every rotation").toStrictEqual(ordered.map(cell => cell.id));
      }
    } finally { reads.mockRestore(); }
  });
}

test("supplier cache preserves exact vehicle identity deletion and foreign ownership on misses and hits", async () => {
  expect.assertions(56);
  const f = await cacheFixture();
  await exactCacheContract(f, "vehicles", createSupplierReadCache().vehicles, [
    { at: 1000, stored: { orgId: f.orgId, make: "Toyota", model: "Camry", year: 2024, mileage: 1, color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: 13, status: "AVAILABLE" }, expected: { orgId: f.orgId, make: "Toyota", model: "Camry", year: 2024, mileage: 1, color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: 13, status: "AVAILABLE" } },
    { at: 2000, stored: { orgId: f.orgId, make: "BMW", model: "M3", year: 2023, mileage: 2, color: "Blue", fuelType: "Gas", transmission: "Auto", sellingPrice: 14, status: "SOLD", isDeleted: true }, expected: { orgId: f.orgId, make: "BMW", model: "M3", year: 2023, mileage: 2, color: "Blue", fuelType: "Gas", transmission: "Auto", sellingPrice: 14, status: "SOLD", isDeleted: true } },
    { at: 3000, stored: { orgId: f.foreignOrg, make: "BMW", model: "M5", year: 2022, mileage: 3, color: "Red", fuelType: "Gas", transmission: "Auto", sellingPrice: 15, status: "AVAILABLE" }, expected: { orgId: f.foreignOrg, make: "BMW", model: "M5", year: 2022, mileage: 3, color: "Red", fuelType: "Gas", transmission: "Auto", sellingPrice: 15, status: "AVAILABLE" } },
  ]);
});

test("supplier cache preserves exact sale identity deletion and foreign ownership on misses and hits", async () => {
  expect.assertions(56);
  const f = await cacheFixture();
  await exactCacheContract(f, "sales", createSupplierReadCache().sales, [
    { at: 1000, stored: { orgId: f.orgId, vehicleId: f.vehicleId, customerId: f.customerId, salespersonId: f.userId, salePrice: 12, saleDate: 100, status: "COMPLETED", dealNumber: 943 }, expected: { orgId: f.orgId, vehicleId: f.vehicleId, customerId: f.customerId, salespersonId: f.userId, salePrice: 12, saleDate: 100, status: "COMPLETED", dealNumber: 943 } },
    { at: 2000, stored: { orgId: f.orgId, vehicleId: f.vehicleId, customerId: f.customerId, salespersonId: f.userId, salePrice: 12, saleDate: 100, status: "COMPLETED", isDeleted: true }, expected: { orgId: f.orgId, vehicleId: f.vehicleId, customerId: f.customerId, salespersonId: f.userId, salePrice: 12, saleDate: 100, status: "COMPLETED", isDeleted: true } },
    { at: 3000, stored: { orgId: f.foreignOrg, vehicleId: f.vehicleId, customerId: f.customerId, salespersonId: f.userId, salePrice: 12, saleDate: 100, status: "COMPLETED" }, expected: { orgId: f.foreignOrg, vehicleId: f.vehicleId, customerId: f.customerId, salespersonId: f.userId, salePrice: 12, saleDate: 100, status: "COMPLETED" } },
  ]);
});

test("supplier cache preserves exact application identity state and foreign ownership on misses and hits", async () => {
  expect.assertions(56);
  const f = await cacheFixture();
  await exactCacheContract(f, "financeApplications", createSupplierReadCache().applications, [
    { at: 1000, stored: { orgId: f.orgId, vehicleId: f.vehicleId, customerId: f.customerId, companyId: f.companyId, quoteId: f.quoteId, salespersonId: f.userId, status: "CLOSED", createdAt: 100, updatedAt: 100 }, expected: { orgId: f.orgId, vehicleId: f.vehicleId, customerId: f.customerId, companyId: f.companyId, quoteId: f.quoteId, salespersonId: f.userId, status: "CLOSED", createdAt: 100, updatedAt: 100 } },
    { at: 2000, stored: { orgId: f.orgId, vehicleId: f.vehicleId, customerId: f.customerId, companyId: f.companyId, quoteId: f.quoteId, salespersonId: f.userId, status: "CLOSED", createdAt: 100, updatedAt: 100 }, expected: { orgId: f.orgId, vehicleId: f.vehicleId, customerId: f.customerId, companyId: f.companyId, quoteId: f.quoteId, salespersonId: f.userId, status: "CLOSED", createdAt: 100, updatedAt: 100 } },
    { at: 3000, stored: { orgId: f.foreignOrg, vehicleId: f.vehicleId, customerId: f.customerId, companyId: f.companyId, quoteId: f.quoteId, salespersonId: f.userId, status: "CLOSED", createdAt: 100, updatedAt: 100 }, expected: { orgId: f.foreignOrg, vehicleId: f.vehicleId, customerId: f.customerId, companyId: f.companyId, quoteId: f.quoteId, salespersonId: f.userId, status: "CLOSED", createdAt: 100, updatedAt: 100 } },
  ]);
});

test("supplier cache preserves exact expense identity deletion and foreign ownership on misses and hits", async () => {
  expect.assertions(56);
  const f = await cacheFixture();
  await exactCacheContract(f, "expenses", createSupplierReadCache().expenses, [
    { at: 1000, stored: { orgId: f.orgId, vehicleId: f.vehicleId, title: "Synthetic expense", amount: 20, date: 100, category: "TRANSPORT", status: "PAID" }, expected: { orgId: f.orgId, vehicleId: f.vehicleId, title: "Synthetic expense", amount: 20, date: 100, category: "TRANSPORT", status: "PAID" } },
    { at: 2000, stored: { orgId: f.orgId, vehicleId: f.vehicleId, title: "Deleted expense", amount: 21, date: 100, category: "TRANSPORT", status: "PAID", isDeleted: true }, expected: { orgId: f.orgId, vehicleId: f.vehicleId, title: "Deleted expense", amount: 21, date: 100, category: "TRANSPORT", status: "PAID", isDeleted: true } },
    { at: 3000, stored: { orgId: f.foreignOrg, vehicleId: f.vehicleId, title: "Foreign expense", amount: 22, date: 100, category: "TRANSPORT", status: "PAID" }, expected: { orgId: f.foreignOrg, vehicleId: f.vehicleId, title: "Foreign expense", amount: 22, date: 100, category: "TRANSPORT", status: "PAID" } },
  ]);
});

test("supplier cache preserves exact opening identity status and foreign ownership on misses and hits", async () => {
  expect.assertions(56);
  const f = await cacheFixture();
  await exactCacheContract(f, "openingBalanceDrafts", createSupplierReadCache().openings, [
    { at: 1000, stored: { orgId: f.orgId, status: "POSTED", lines: [], asOfDate: 100, createdBy: f.userId, createdAt: 100 }, expected: { orgId: f.orgId, status: "POSTED", lines: [], asOfDate: 100, createdBy: f.userId, createdAt: 100 } },
    { at: 2000, stored: { orgId: f.orgId, status: "VOIDED", lines: [], asOfDate: 100, createdBy: f.userId, createdAt: 100 }, expected: { orgId: f.orgId, status: "VOIDED", lines: [], asOfDate: 100, createdBy: f.userId, createdAt: 100 } },
    { at: 3000, stored: { orgId: f.foreignOrg, status: "POSTED", lines: [], asOfDate: 100, createdBy: f.userId, createdAt: 100 }, expected: { orgId: f.foreignOrg, status: "POSTED", lines: [], asOfDate: 100, createdBy: f.userId, createdAt: 100 } },
  ]);
});
