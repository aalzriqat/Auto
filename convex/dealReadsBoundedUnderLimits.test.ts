import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS } from "./utils/permissions";
import { MAX_COST_BASIS_EXPENSES } from "./utils/vehicleCostBasis";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.*s");

/**
 * SCRUM-708 - the heavy deal READ doors under the platform's per-transaction
 * ceilings.
 *
 * `convexTest` enforces no limit by default, so a handler that `.collect()`s a
 * per-deal table passes every ordinary suite and fails in production only once a
 * deal is large enough. `transactionLimits: true` enforces the real ceilings
 * (16 MiB read, 32,000 documents read, 4,096 index ranges).
 *
 * Doors:
 *  - applications.dealCockpit           financed deal cockpit
 *  - dealWorkspace.financedDealCockpit  the cockpit + appraisal / pending-deposit-request reads
 *  - dealOverview.financedDealOverview  the deal's financial overview (cockpit + fees + cost basis)
 *  - sales.dealCockpit                  cash / sale cockpit
 *
 * Three kinds of test, deliberately kept apart:
 *  1. LARGE REALISTIC DEAL - hundreds of rows in every related table at once.
 *     Every door must resolve to a payload with its key fields. The test does
 *     NOT record how much of each ceiling was used: convex-test enforces the
 *     ceilings but exposes no usage counters, so "resolves" is the only signal.
 *  2. BOUNDED READ PROOF - the one per-deal read that is capped by design
 *     (`financedDealOverview` reads the vehicle's expenses with `.take(cap + 1)`)
 *     is fed more bytes than the read ceiling. It resolves only while the cap
 *     holds; making it `.collect()` fails this test (mutation-proven, see report).
 *     Over the cap the served cost basis is WITHHELD as `TOO_MANY_ROWS` (asserted
 *     explicitly), and a case AT the cap asserts the real computed cost basis, so
 *     removing the cost-basis projection cannot pass on a bare non-null check.
 *  3. FINDING - reads that are UNBOUNDED today. They are not reachable at a
 *     realistic row count (it takes >4,000 rows of ~4 KB free text on ONE deal
 *     to trip the 16 MiB ceiling), but they are unbounded by construction, so
 *     each is pinned: when someone bounds the read, the pin fails and is to be
 *     flipped into an ordinary resolves-test.
 */

/** ~4 KB of free text. 4,500 rows of it is ~18 MiB, past the 16 MiB read ceiling. */
const FAT = "x".repeat(4_000);
const FAT_ROWS = 4_500;
const CHUNK = 450; // ~1.8 MiB written per transaction, under the 16 MiB write ceiling
const SMALL = "Customer asked for the file to be re-checked.";
/** Realistic heavy per-table row count for one deal. */
const HEAVY_ROWS = 300;
const READ_LIMIT_ERROR = /Read too much data in a single function execution|Scanned too many documents/;

type T = ReturnType<typeof convexTestWithComponents<typeof schema>>;
type Inserter = { db: { insert: (table: string, value: unknown) => Promise<unknown> } };

async function bulk(t: T, count: number, insert: (db: Inserter["db"], i: number) => Promise<unknown>) {
  for (let start = 0; start < count; start += CHUNK) {
    const end = Math.min(count, start + CHUNK);
    await t.run(async (ctx) => {
      for (let i = start; i < end; i++) await insert((ctx as unknown as Inserter).db, i);
    });
  }
}

async function seedBase() {
  const t = convexTestWithComponents(schema, MODULES, { transactionLimits: true });
  const now = Date.now();
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Limits Dealer", createdAt: now }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: now, updatedAt: now })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "limits_owner", email: "limits@example.com", name: "Limits Owner" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Big", lastName: "Deal" }));
  const asOwner = t.withIdentity({ subject: "limits_owner", clerkId: "limits_owner" });
  return { t, orgId, userId, customerId, asOwner, now };
}
type Base = Awaited<ReturnType<typeof seedBase>>;

async function seedVehicle(s: Base, kind: "STOCK" | "SOURCED") {
  return await s.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: s.orgId,
      vin: `LIMITS${kind}0000001`,
      make: "Toyota",
      model: "Camry",
      year: 2024,
      mileage: 100,
      color: "White",
      fuelType: "Gasoline",
      transmission: "Automatic",
      sellingPrice: 10_500,
      status: "AVAILABLE",
      ...(kind === "STOCK"
        ? { sourceType: "STOCK" as const, purchasePrice: 9_500 }
        : { sourceType: "SOURCED" as const, sourcedFromName: "Amman Importer", sourceCost: 9_000 }),
    })
  );
}

/**
 * `preDealCapitalized` rows are registered BEFORE the application (the cost basis
 * only counts rows whose `_creationTime` precedes the application's), each
 * capitalizing 1 major unit.
 */
async function seedFinancedDeal(opts: { preDealCapitalized?: number } = {}) {
  const s = await seedBase();
  const vehicleId = await seedVehicle(s, "STOCK");
  const pre = opts.preDealCapitalized ?? 0;
  if (pre > 0) {
    await bulk(s.t, pre, (db, i) =>
      db.insert("expenses", {
        orgId: s.orgId, vehicleId, title: `Prep ${i}`, amount: 1, date: s.now, category: "REPAIR",
        status: "PAID", accountingTreatment: "CAPITALIZED_INVENTORY", capitalizedAmount: 1,
      })
    );
    // `_creationTime` is millisecond-resolution: make the application strictly later than every row.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const quoteId = await s.t.run((ctx) =>
    ctx.db.insert("quotes", {
      orgId: s.orgId,
      customerId: s.customerId,
      vehicleId,
      vehiclePrice: 10_500,
      downPayment: 500,
      termMonths: 60,
      status: "ACCEPTED",
      createdBy: s.userId,
      createdAt: s.now,
    })
  );
  const applicationId = await s.t.run((ctx) =>
    ctx.db.insert("financeApplications", {
      orgId: s.orgId,
      quoteId,
      customerId: s.customerId,
      vehicleId,
      salespersonId: s.userId,
      status: "APPROVED",
      createdAt: s.now,
      updatedAt: s.now,
    })
  );
  return { ...s, vehicleId, quoteId, applicationId };
}
type Financed = Awaited<ReturnType<typeof seedFinancedDeal>>;

/** Per-table fillers for a financed deal: `n` rows each carrying `text` in a free-text field. */
const FINANCED_TABLES: Record<string, (s: Financed, n: number, text: string) => Promise<void>> = {
  applicationStatusLog: (s, n, text) =>
    bulk(s.t, n, (db, i) =>
      db.insert("applicationStatusLog", {
        orgId: s.orgId, applicationId: s.applicationId, toStatus: "UNDER_REVIEW",
        changedBy: s.userId, changedAt: s.now + i, note: text,
      })
    ),
  financeAppraisals: (s, n, text) =>
    bulk(s.t, n, (db, i) =>
      db.insert("financeAppraisals", {
        orgId: s.orgId, applicationId: s.applicationId, vehicleId: s.vehicleId,
        appraisalAmountMinor: 1_000 + i, currency: "JOD", providerType: "INDEPENDENT",
        appraisedAt: s.now + i, isReappraisal: i > 0, status: "SUPERSEDED", notes: text,
        recordedBy: s.userId, recordedAt: s.now + i,
      })
    ),
  postDatedCheques: (s, n, text) =>
    bulk(s.t, n, (db, i) =>
      db.insert("postDatedCheques", {
        orgId: s.orgId, customerId: s.customerId, applicationId: s.applicationId, bank: "Bank",
        chequeNumber: `CH${i}`, chequeDate: s.now, amount: 1, status: "CANCELLED", notes: text,
        createdBy: s.userId, createdAt: s.now, updatedAt: s.now,
      })
    ),
  financeDealFees: (s, n, text) =>
    bulk(s.t, n, (db) =>
      db.insert("financeDealFees", {
        orgId: s.orgId, applicationId: s.applicationId, feeType: "LICENSING", description: text,
        currency: "JOD", paidBy: "DEALER", paidTo: "GOVERNMENT",
        accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE", includedInQuotation: false,
        deductedFromSettlement: false, refundable: false, source: "MANUAL",
        createdBy: s.userId, createdAt: s.now, updatedAt: s.now,
      })
    ),
  applicationDocuments: async (s, n, text) => {
    const ruleId = await s.t.run((ctx) =>
      ctx.db.insert("companyDocumentRules", { orgId: s.orgId, documentName: "ID", isRequired: true })
    );
    await bulk(s.t, n, (db) =>
      db.insert("applicationDocuments", {
        orgId: s.orgId, applicationId: s.applicationId, ruleId, status: "REJECTED", rejectionReason: text,
      })
    );
  },
  companyDocumentRules: (s, n, text) =>
    bulk(s.t, n, (db, i) =>
      db.insert("companyDocumentRules", {
        orgId: s.orgId, documentName: `Rule ${i}`, isRequired: false, description: text,
      })
    ),
  deposits: (s, n, text) =>
    bulk(s.t, n, (db) =>
      db.insert("deposits", {
        orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, quoteId: s.quoteId,
        amount: 1, amountMinor: 1_000, currency: "JOD", status: "REFUNDED", holdActive: false,
        notes: text, createdBy: s.userId, createdAt: s.now,
      })
    ),
  depositRequests: (s, n, text) =>
    bulk(s.t, n, (db, i) =>
      db.insert("depositRequests", {
        orgId: s.orgId, quoteId: s.quoteId, customerId: s.customerId, vehicleId: s.vehicleId,
        amount: 1, amountMinor: 1_000, currency: "JOD", note: text, status: "PENDING",
        requestedBy: s.userId, requestedAt: s.now, idempotencyKey: `k${i}`,
      })
    ),
  vehicleSupplierPayables: (s, n, text) =>
    bulk(s.t, n, (db) =>
      db.insert("vehicleSupplierPayables", {
        orgId: s.orgId, vehicleId: s.vehicleId, sourcedFromName: text, amountDue: 1, currency: "JOD",
        status: "CANCELLED", createdBy: s.userId, createdAt: s.now, updatedAt: s.now,
      })
    ),
  expenses: (s, n, text) =>
    bulk(s.t, n, (db, i) =>
      db.insert("expenses", {
        orgId: s.orgId, vehicleId: s.vehicleId, title: `Repair ${i}`, amount: 1, date: s.now,
        category: "REPAIR", status: "PAID", notes: text,
      })
    ),
};

const FINANCED_DOORS = {
  "applications.dealCockpit": (s: Financed) =>
    s.asOwner.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId: s.applicationId }),
  "dealWorkspace.financedDealCockpit": (s: Financed) =>
    s.asOwner.query(api.dealWorkspace.financedDealCockpit, { orgId: s.orgId, applicationId: s.applicationId }),
  "dealOverview.financedDealOverview": (s: Financed) =>
    s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId: s.applicationId }),
} as const;

async function seedCashSale(kind: "STOCK" | "SOURCED") {
  const s = await seedBase();
  await s.t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId: s.orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] })
  );
  const vehicleId = await seedVehicle(s, kind);
  const saleId: Id<"sales"> = await s.t.run((ctx) =>
    ctx.db.insert("sales", {
      orgId: s.orgId, vehicleId, customerId: s.customerId, salespersonId: s.userId,
      salePrice: 10_500, saleDate: s.now, status: "COMPLETED",
    } as never)
  );
  return { ...s, vehicleId, saleId };
}
type Cash = Awaited<ReturnType<typeof seedCashSale>>;

const CASH_TABLES: Record<string, { kind: "STOCK" | "SOURCED"; patchRoute?: boolean; fill: (s: Cash, n: number, text: string) => Promise<void> }> = {
  "owned car expenses": {
    kind: "STOCK",
    fill: (s, n, text) =>
      bulk(s.t, n, (db, i) =>
        db.insert("expenses", {
          orgId: s.orgId, vehicleId: s.vehicleId, title: `Repair ${i}`, amount: 1, date: s.now,
          category: "REPAIR", status: "PAID", notes: text,
        })
      ),
  },
  "consigned (through dealership) supplier payables": {
    kind: "SOURCED",
    fill: (s, n, text) =>
      bulk(s.t, n, (db) =>
        db.insert("vehicleSupplierPayables", {
          orgId: s.orgId, vehicleId: s.vehicleId, saleId: s.saleId, sourcedFromName: text, amountDue: 1,
          currency: "JOD", status: "CANCELLED", createdBy: s.userId, createdAt: s.now, updatedAt: s.now,
        })
      ),
  },
  "consigned (direct to supplier) supplier receivables": {
    kind: "SOURCED",
    patchRoute: true,
    fill: (s, n, text) =>
      bulk(s.t, n, (db) =>
        db.insert("vehicleSupplierReceivables", {
          orgId: s.orgId, vehicleId: s.vehicleId, saleId: s.saleId, sourcedFromName: text, amountDue: 1,
          currency: "JOD", status: "CANCELLED", createdBy: s.userId, createdAt: s.now, updatedAt: s.now,
        })
      ),
  },
};

async function seedCashTable(name: string, n: number, text: string) {
  const spec = CASH_TABLES[name];
  const s = await seedCashSale(spec.kind);
  if (spec.patchRoute) {
    await s.t.run((ctx) => ctx.db.patch(s.saleId, { supplierSettlementRoute: "DIRECT_TO_SUPPLIER" } as never));
  }
  await spec.fill(s, n, text);
  return s;
}

// ---------------------------------------------------------------------------
// 1. A large REALISTIC deal: every related table heavy at once, limits enforced.
// ---------------------------------------------------------------------------
describe("large realistic deal resolves under the platform limits (limits ENFORCED)", () => {
  test.each(Object.keys(FINANCED_DOORS) as Array<keyof typeof FINANCED_DOORS>)(
    `%s with ${HEAVY_ROWS} rows in every related table`,
    async (door) => {
      const s = await seedFinancedDeal();
      for (const fill of Object.values(FINANCED_TABLES)) await fill(s, HEAVY_ROWS, SMALL);
      const result = await FINANCED_DOORS[door](s);
      if (door !== "dealOverview.financedDealOverview") {
        expect(result).toMatchObject({ dealKind: "FINANCED", applicationId: s.applicationId, status: "APPROVED" });
      }
      if (door === "dealWorkspace.financedDealCockpit") {
        const workspace = result as { pendingDepositRequests: unknown[] };
        expect(workspace.pendingDepositRequests.length).toBeGreaterThan(0);
      }
      if (door === "dealOverview.financedDealOverview") {
        // HEAVY_ROWS (300) expenses are past the 200-row cost-basis cap: the basis is WITHHELD
        // with an explicit reason, never a prefix sum and never silently absent.
        const overview = result as { vehicleCostBasis: unknown; financialSummary: unknown };
        expect(overview.financialSummary).not.toBeNull();
        expect(overview.vehicleCostBasis).toMatchObject({ available: false, reason: "TOO_MANY_ROWS" });
      }
    },
    240_000
  );

  test("sales.dealCockpit with heavy expenses on an owned car", async () => {
    const s = await seedCashTable("owned car expenses", HEAVY_ROWS, SMALL);
    const cockpit = await s.asOwner.query(api.sales.dealCockpit, { orgId: s.orgId, saleId: s.saleId });
    expect(cockpit).toMatchObject({ dealKind: "CASH", saleId: s.saleId, status: "COMPLETED" });
  }, 240_000);

  test.each(["consigned (through dealership) supplier payables", "consigned (direct to supplier) supplier receivables"])(
    "sales.dealCockpit with heavy %s",
    async (name) => {
      const s = await seedCashTable(name, HEAVY_ROWS, SMALL);
      const cockpit = await s.asOwner.query(api.sales.dealCockpit, { orgId: s.orgId, saleId: s.saleId });
      expect(cockpit).toMatchObject({ dealKind: "CASH", saleId: s.saleId, status: "COMPLETED" });
    },
    240_000
  );
});

// ---------------------------------------------------------------------------
// 2. The read that IS bounded by design, fed past the read ceiling.
// ---------------------------------------------------------------------------
describe("bounded read proof (limits ENFORCED)", () => {
  test("financedDealOverview reads the vehicle's expenses with a cap: 4,500 x ~4 KB rows (~18 MiB) still resolve", async () => {
    const s = await seedFinancedDeal();
    await FINANCED_TABLES.expenses(s, FAT_ROWS, FAT);
    const overview = await FINANCED_DOORS["dealOverview.financedDealOverview"](s);
    // Resolving is not enough: the over-cap reason must be the explicit TOO_MANY_ROWS refusal.
    expect(overview).toMatchObject({ vehicleCostBasis: { available: false, reason: "TOO_MANY_ROWS" } });
  }, 240_000);

  test("AT the cap (200 pre-deal capitalized rows) the cost basis is really computed, not withheld", async () => {
    const s = await seedFinancedDeal({ preDealCapitalized: MAX_COST_BASIS_EXPENSES });
    const overview = (await FINANCED_DOORS["dealOverview.financedDealOverview"](s)) as {
      vehicleCostBasis: {
        available: boolean; consigned: boolean; baseMinor: number; eligibleExpensesMinor: number;
        totalBeforeDealMinor: number; lineDetail: string; expenses: unknown[];
      };
    };
    const basis = overview.vehicleCostBasis;
    expect(basis).toMatchObject({ available: true, consigned: false, lineDetail: "SERVED" });
    // Purchase price 9,500 major; each of the 200 rows capitalizes 1 major - same scale for both.
    const scale = basis.baseMinor / 9_500;
    expect(Number.isInteger(scale) && scale > 0).toBe(true);
    expect(basis.expenses).toHaveLength(MAX_COST_BASIS_EXPENSES);
    expect(basis.eligibleExpensesMinor).toBe(MAX_COST_BASIS_EXPENSES * scale);
    expect(basis.totalBeforeDealMinor).toBe(basis.baseMinor + basis.eligibleExpensesMinor);
  }, 240_000);

  test("ONE past the cap (201 rows) flips the same deal to TOO_MANY_ROWS", async () => {
    const s = await seedFinancedDeal({ preDealCapitalized: MAX_COST_BASIS_EXPENSES + 1 });
    const overview = await FINANCED_DOORS["dealOverview.financedDealOverview"](s);
    expect(overview).toMatchObject({ vehicleCostBasis: { available: false, reason: "TOO_MANY_ROWS" } });
  }, 240_000);
});

// ---------------------------------------------------------------------------
// 3. FINDING: reads that are unbounded today. Each is pinned at ~18 MiB of one
//    table on one deal. NOT reachable at a realistic row count; pinned so the
//    gap is visible and flips to a resolves-test the day the read is capped.
// ---------------------------------------------------------------------------
describe("FINDING: per-deal reads that are unbounded today (limits ENFORCED)", () => {
  test.each([
    "applicationStatusLog",
    "financeAppraisals",
    "postDatedCheques",
    "financeDealFees",
    "applicationDocuments",
    "companyDocumentRules",
    "deposits",
    "vehicleSupplierPayables",
  ])("FINDING: applications.dealCockpit collects every %s row of the deal", async (table) => {
    const s = await seedFinancedDeal();
    await FINANCED_TABLES[table](s, FAT_ROWS, FAT);
    await expect(FINANCED_DOORS["applications.dealCockpit"](s)).rejects.toThrow(READ_LIMIT_ERROR);
  }, 240_000);

  test("FINDING: dealWorkspace.financedDealCockpit collects every PENDING depositRequests row of the quote", async () => {
    const s = await seedFinancedDeal();
    await FINANCED_TABLES.depositRequests(s, FAT_ROWS, FAT);
    // The cockpit it composes does not read this table, so the throw below is the wrapper's own read.
    await expect(FINANCED_DOORS["applications.dealCockpit"](s)).resolves.not.toBeNull();
    await expect(FINANCED_DOORS["dealWorkspace.financedDealCockpit"](s)).rejects.toThrow(READ_LIMIT_ERROR);
  }, 240_000);

  test.each(Object.keys(CASH_TABLES))("FINDING: sales.dealCockpit collects every %s row", async (name) => {
    const s = await seedCashTable(name, FAT_ROWS, FAT);
    await expect(s.asOwner.query(api.sales.dealCockpit, { orgId: s.orgId, saleId: s.saleId })).rejects.toThrow(
      READ_LIMIT_ERROR
    );
  }, 240_000);
});
