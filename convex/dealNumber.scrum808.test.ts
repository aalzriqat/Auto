/**
 * SCRUM-808: every deal carries a readable per-organization deal number; the Convex id stays its identity.
 *
 * Invariants under test:
 * - a new deal is numbered at creation, through the real doors (`sales.createDraft`, `applications.createFromQuote`),
 *   from its organization's counter, with no reuse and independently per organization;
 * - a sale finalized from an application is the same deal and carries the application's number;
 * - a refused creation hands out no number (the counter write rolls back with it);
 * - a counter that fell behind refuses instead of issuing a duplicate;
 * - the deploy backfill numbers legacy rows in creation order, is bounded, resumable and idempotent;
 * - a number resolves only inside the caller's organization, only for a caller with `view:sales`.
 *
 * Evidence boundary: convex-test runs mutations one at a time, so it cannot exercise two concurrent creations racing
 * for one counter. That property rests on Convex's serializable OCC (docs.convex.dev/database/advanced/occ): both
 * transactions read the counter row (or the empty index range where it would be), so a second commit is retried
 * against the first one's write. What is tested here is that the number is allocated in the creating transaction and
 * nowhere else.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { finalizeAsOwner, readyDeal, seedFinancedDealership } from "../test-utils/financedDealFixture";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { formatDealNumber, parseDealNumberQuery } from "./utils/dealNumberFormat";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");

const ALL_PERMS = [
  "create:sales", "view:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "approve:requests",
  "view:finance_applications", "create:finance_application",
  "review:finance_application", "approve:finance_application",
  "finalize:financed_deal", "confirm:finance_disbursement",
  "verify:finance_documents", "register:vehicle_handover",
  "register:expected_payment",
  "manage:finance", "view:finance",
  "view:commissions", "manage:commissions",
  "view:reports", "manage:settings",
];

async function seedDealership(t: ReturnType<typeof convexTestWithComponents>, tag: string) {
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S808 ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_owner`, email: `${tag}.o@example.com`, name: "owner" }));
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const as = t.withIdentity({ subject: `${tag}_owner`, clerkId: `${tag}_owner` });
  const blindRoleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "BLIND", permissions: ["view:vehicles"] }));
  const blindId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_blind`, email: `${tag}.b@example.com`, name: "blind" }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: blindId, roleId: blindRoleId }));
  const blind = t.withIdentity({ subject: `${tag}_blind`, clerkId: `${tag}_blind` });
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"] })
  );
  await as.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await as.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(fiscalYear, 0, 1), endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999), fiscalYear, periodNumber: 1,
  });
  const period = (await as.query(api.accountingPeriods.list, { orgId }))[0];
  await as.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag }));
  let vins = 0;
  const mkVehicle = () =>
    t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: `VIN808${tag}${++vins}`, make: "Kia", model: "Sportage", year: 2024, mileage: 10,
        color: "Blue", fuelType: "Gasoline", transmission: "Automatic",
        sellingPrice: 13_000, status: "AVAILABLE", sourceType: "STOCK" as const, purchasePrice: 10_000,
      })
    );
  return { t, orgId, userId, as, blind, customerId, mkVehicle };
}
type Seeded = Awaited<ReturnType<typeof seedDealership>>;

async function cashDraft(s: Seeded, vehicleId?: Id<"vehicles">) {
  return await s.as.mutation(api.sales.createDraft, {
    idempotencyKey: crypto.randomUUID(), orgId: s.orgId, vehicleId: vehicleId ?? (await s.mkVehicle()), customerId: s.customerId,
    salespersonId: s.userId, salePrice: 13_000, saleDate: Date.now(), financingType: "CASH",
  });
}

async function application(s: Seeded) {
  const quoteId = await s.as.mutation(api.quotes.saveQuote, {
    orgId: s.orgId, customerId: s.customerId, vehicleId: await s.mkVehicle(),
    vehiclePrice: 12_000, downPayment: 0, termMonths: 48,
    mode: "MANUAL_FINANCE_COMPANY", manualProviderName: "Other finance option", manualAdminFees: 0, manualProfitRate: 5,
  } as never);
  return await s.as.mutation(api.applications.createFromQuote, { orgId: s.orgId, quoteId });
}

const numberOf = (s: Seeded, id: Id<"sales"> | Id<"financeApplications">) =>
  s.t.run(async (ctx) => (await ctx.db.get(id))?.dealNumber);
const counterOf = (s: Seeded) =>
  s.t.run(async (ctx) =>
    (await ctx.db.query("dealNumberCounters").take(10)).find((row) => row.orgId === s.orgId)?.lastNumber
  );

describe("SCRUM-808 display format and typed lookup", () => {
  test("pads to six digits and keeps growing past 999999, never wrapping", () => {
    expect(formatDealNumber(1)).toBe("D-000001");
    expect(formatDealNumber(123)).toBe("D-000123");
    expect(formatDealNumber(999_999)).toBe("D-999999");
    expect(formatDealNumber(1_000_000)).toBe("D-1000000");
  });

  test.each([undefined, null, 0, -1, 1.5, Number.NaN])("an absent or invalid number formats as null: %s", (value) => {
    expect(formatDealNumber(value as number | null | undefined)).toBeNull();
  });

  test.each([
    ["D-000123", 123], ["d-123", 123], ["D123", 123], ["#123", 123], ["123", 123], [" 7 ", 7],
    ["د-١٢٣", null], ["١٢٣", 123], ["۱۲۳", 123], ["D-٠٠٠١٢٣", 123], ["１２３", 123], ["Ｄ-０００１２３", 123],
    ["", null], ["0", null], ["D-", null], ["Kia", null], ["12a", null], ["1234567890123456", null],
  ])("parses %j as %s", (input, expected) => {
    expect(parseDealNumberQuery(input)).toBe(expected);
  });
});

describe("SCRUM-808 deal number at creation", () => {
  test("cash drafts and finance applications share one per-organization sequence, in creation order", async () => {
    const s = await seedDealership(convexTestWithComponents(schema, MODULES), "seq");
    const first = await cashDraft(s);
    const app = await application(s);
    const third = await cashDraft(s);
    expect([await numberOf(s, first), await numberOf(s, app), await numberOf(s, third)]).toEqual([1, 2, 3]);
    expect(await counterOf(s)).toBe(3);
  });

  test("two organizations number independently, and the same number resolves only inside its own organization", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const a = await seedDealership(t, "orga");
    const b = await seedDealership(t, "orgb");
    const saleA = await cashDraft(a);
    const saleB = await cashDraft(b);
    expect(await numberOf(a, saleA)).toBe(1);
    expect(await numberOf(b, saleB)).toBe(1);
    expect(await a.as.query(api.dealNumbers.find, { orgId: a.orgId, query: "D-000001" })).toEqual({ kind: "sale", id: saleA, dealNumber: 1 });
    expect(await b.as.query(api.dealNumbers.find, { orgId: b.orgId, query: "1" })).toEqual({ kind: "sale", id: saleB, dealNumber: 1 });
    // Org A's member asking about org B is refused by tenancy, never answered with B's deal.
    await expect(a.as.query(api.dealNumbers.find, { orgId: b.orgId, query: "1" })).rejects.toThrow();
  });

  test("a sale finalized from an application carries the application's number and takes no new one", async () => {
    // The pilot's configured-financier path (manual finance approval is refused during the pilot).
    const s = await seedFinancedDealership("fin808", {
      modules: MODULES, ownerPerms: ALL_PERMS, actors: {}, label: "S808", vinPrefix: "VIN808F",
    });
    let vins = 0;
    const draft = async () =>
      await s.owner.as.mutation(api.sales.createDraft, {
        idempotencyKey: crypto.randomUUID(), orgId: s.orgId, customerId: s.customerId, salespersonId: s.owner.userId,
        vehicleId: await s.t.run((ctx) =>
          ctx.db.insert("vehicles", {
            orgId: s.orgId, vin: `VIN808C${++vins}`, make: "Kia", model: "Rio", year: 2024, mileage: 10, color: "Red",
            fuelType: "Gasoline", transmission: "Automatic", sellingPrice: 9_000, status: "AVAILABLE",
            sourceType: "STOCK" as const, purchasePrice: 7_000,
          })
        ),
        salePrice: 9_000, saleDate: Date.now(), financingType: "CASH",
      });
    const read = (id: Id<"sales"> | Id<"financeApplications">) => s.t.run(async (ctx) => (await ctx.db.get(id))?.dealNumber);
    const before = await draft();
    const { applicationId } = await readyDeal(s);
    await finalizeAsOwner(s, applicationId);
    const saleId = await s.t.run(async (ctx) => (await ctx.db.get(applicationId))?.finalizedSaleId);
    expect(saleId).toBeDefined();
    expect(await read(before)).toBe(1);
    expect(await read(applicationId)).toBe(2);
    expect(await read(saleId!)).toBe(2);
    // The number opens the canonical deal: the application, not its sale row.
    expect(await s.owner.as.query(api.dealNumbers.find, { orgId: s.orgId, query: "D-000002" })).toEqual({
      kind: "application", id: applicationId, dealNumber: 2,
    });
    expect(await read(await draft())).toBe(3);
  });

  test("a refused creation hands out no number", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const s = await seedDealership(t, "refused");
    const other = await seedDealership(t, "refusedb");
    await cashDraft(s);
    // Another organization's car: refused, so nothing the transaction wrote, the counter included, is kept.
    await expect(cashDraft(s, await other.mkVehicle())).rejects.toThrow();
    expect(await counterOf(s)).toBe(1);
    expect(await numberOf(s, await cashDraft(s))).toBe(2);
  });

  test("a counter that fell behind refuses instead of issuing a duplicate", async () => {
    const s = await seedDealership(convexTestWithComponents(schema, MODULES), "behind");
    const first = await cashDraft(s);
    await s.t.run(async (ctx) => {
      const counter = (await ctx.db.query("dealNumberCounters").take(10)).find((row) => row.orgId === s.orgId);
      await ctx.db.patch(counter!._id, { lastNumber: 0 });
    });
    await expect(cashDraft(s)).rejects.toThrow("already in use");
    expect(await numberOf(s, first)).toBe(1);
  });

  test("lookup and global search need view:sales; an unknown or non-numeric query finds nothing", async () => {
    const s = await seedDealership(convexTestWithComponents(schema, MODULES), "perm");
    const saleId = await cashDraft(s);
    await expect(s.blind.query(api.dealNumbers.find, { orgId: s.orgId, query: "1" })).rejects.toThrow();
    expect((await s.blind.query(api.search.globalSearch, { orgId: s.orgId, query: "1" })).deals).toEqual([]);
    expect((await s.as.query(api.search.globalSearch, { orgId: s.orgId, query: "1" })).deals).toEqual([
      { kind: "sale", id: saleId, dealNumber: 1 },
    ]);
    expect(await s.as.query(api.dealNumbers.find, { orgId: s.orgId, query: "2" })).toBeNull();
    expect(await s.as.query(api.dealNumbers.find, { orgId: s.orgId, query: "Kia" })).toBeNull();
    // A soft-deleted sale is not found by its number.
    await s.t.run((ctx) => ctx.db.patch(saleId, { isDeleted: true }));
    expect(await s.as.query(api.dealNumbers.find, { orgId: s.orgId, query: "1" })).toBeNull();
  });
});

describe("SCRUM-808 deploy backfill (dealNumberBackfill:runPage)", () => {
  /** Legacy rows exactly as they were stored before this release: no deal number. */
  async function legacyWorld() {
    const t = convexTestWithComponents(schema, MODULES);
    const a = await seedDealership(t, "lega");
    const b = await seedDealership(t, "legb");
    const quoteOf = async (s: Seeded) =>
      await s.as.mutation(api.quotes.saveQuote, {
        orgId: s.orgId, customerId: s.customerId, vehicleId: await s.mkVehicle(),
        vehiclePrice: 12_000, downPayment: 0, termMonths: 48,
        mode: "MANUAL_FINANCE_COMPANY", manualProviderName: "Other", manualAdminFees: 0, manualProfitRate: 5,
      } as never);
    const sale = async (s: Seeded, applicationId?: Id<"financeApplications">) => {
      const vehicleId = await s.mkVehicle();
      return await t.run((ctx) =>
        ctx.db.insert("sales", {
          orgId: s.orgId, vehicleId, customerId: s.customerId, salespersonId: s.userId, salePrice: 1000,
          saleDate: Date.now(), status: "COMPLETED", ...(applicationId ? { applicationId } : {}),
        })
      );
    };
    const app = async (s: Seeded) => {
      const quoteId = await quoteOf(s);
      const vehicleId = await s.mkVehicle();
      return await t.run((ctx) =>
        ctx.db.insert("financeApplications", {
          orgId: s.orgId, quoteId, customerId: s.customerId, vehicleId, salespersonId: s.userId, status: "APPROVED",
          createdAt: Date.now(), updatedAt: Date.now(),
        } as never)
      ) as Id<"financeApplications">;
    };
    // Interleaved across both organizations and both tables, in this creation order.
    const a1 = await sale(a);
    const b1 = await app(b);
    const a2 = await app(a);
    const a3 = await sale(a, a2); // finalized from a2: the same deal
    const b2 = await sale(b);
    const a4 = await sale(a);
    const deleted = await sale(b);
    await t.run((ctx) => ctx.db.patch(deleted, { isDeleted: true }));
    return { t, a, b, a1, a2, a3, a4, b1, b2, deleted };
  }

  const runToEnd = async (t: ReturnType<typeof convexTestWithComponents>, numItems: number) => {
    let cursor: string | null = null;
    let pages = 0;
    let numbered = 0;
    for (;;) {
      const page: { numberedCount: number; checkedCount: number; isDone: boolean; continueCursor: string } = await t.mutation(
        internal.dealNumberBackfill.runPage,
        { cursor, numItems },
      );
      pages++;
      numbered += page.numberedCount;
      expect(page.checkedCount).toBeLessThanOrEqual(2 * numItems);
      if (page.isDone) return { pages, numbered };
      expect(page.continueCursor).not.toBe(cursor);
      cursor = page.continueCursor;
      expect(pages).toBeLessThan(50);
    }
  };

  test("numbers legacy rows per organization in creation order across both tables, a finalized sale sharing its application's number", async () => {
    const w = await legacyWorld();
    const result = await runToEnd(w.t, 1);
    expect(result.numbered).toBe(7);
    expect(result.pages).toBeGreaterThan(1);
    expect([await numberOf(w.a, w.a1), await numberOf(w.a, w.a2), await numberOf(w.a, w.a3), await numberOf(w.a, w.a4)]).toEqual([1, 2, 2, 3]);
    expect([await numberOf(w.b, w.b1), await numberOf(w.b, w.b2), await numberOf(w.b, w.deleted)]).toEqual([1, 2, 3]);
    expect(await counterOf(w.a)).toBe(3);
    expect(await counterOf(w.b)).toBe(3);
  });

  test("a re-run reads nothing and changes nothing; a new deal continues the sequence", async () => {
    const w = await legacyWorld();
    await runToEnd(w.t, 2);
    const again = await w.t.mutation(internal.dealNumberBackfill.runPage, { cursor: null, numItems: 100 });
    expect(again).toMatchObject({ numberedCount: 0, checkedCount: 0, isDone: true });
    expect(await numberOf(w.a, await cashDraft(w.a))).toBe(4);
  });

  test("resumes after an interruption without renumbering, and a deal created mid-walk keeps the number it was given", async () => {
    const w = await legacyWorld();
    const first = await w.t.mutation(internal.dealNumberBackfill.runPage, { cursor: null, numItems: 1 });
    expect(first.isDone).toBe(false);
    expect(await numberOf(w.a, w.a1)).toBe(1);
    // A deal created between pages takes the next number at creation.
    const live = await cashDraft(w.a);
    expect(await numberOf(w.a, live)).toBe(2);
    // The walk restarts from scratch (a fresh deploy) rather than from its cursor: still no duplicate.
    await runToEnd(w.t, 3);
    const numbersA = await w.t.run(async (ctx) =>
      (await ctx.db.query("sales").withIndex("by_org", (q) => q.eq("orgId", w.a.orgId)).collect()).map((r) => r.dealNumber)
    );
    expect(numbersA.sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual([1, 2, 3, 4]);
    expect(await numberOf(w.a, w.a2)).toBe(3);
    expect(await numberOf(w.a, w.a3)).toBe(3);
    expect(await numberOf(w.a, live)).toBe(2);
  });

  test("an invalid cursor is refused", async () => {
    const w = await legacyWorld();
    await expect(w.t.mutation(internal.dealNumberBackfill.runPage, { cursor: "page-two" })).rejects.toThrow("cursor");
  });
});
