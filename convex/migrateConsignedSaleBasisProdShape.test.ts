/**
 * A dry run over data shaped like production's, printed rather than merely
 * asserted.
 *
 * Production (kindly-hound-172, read 2026-08-07 by the prior session) carries
 * 42 SOURCED vehicles of which 2 have sold, and 39 of the 42 also carry a
 * `purchasePrice` — which is why the flag was narrowed to SOURCED_COST_CONFLICT
 * rather than "sourced but has a purchase price", a rule that would have
 * disqualified every migratable row.
 *
 * What this pins is the property the operator needs before running it for real:
 * a correction dated into a period that does not exist QUEUES, and the dry run
 * must say so rather than reporting a bare "would correct" count. It is
 * production-SHAPED, not production — nothing here has been run against the
 * real deployment, and the impact report on real books is still outstanding.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { SYSTEM_KEYS } from "./utils/defaultChart";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");
const SCALE = 1000;

const PERMS = [
  "view:sales", "create:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "manage:finance", "view:finance",
];

/** Last year: no accounting period covers it, exactly like a closed book. */
const HISTORICAL = Date.UTC(new Date().getUTCFullYear() - 1, 8, 14);

async function seedProdShapedDealer() {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Prod Shape", createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "ps_u", email: "ps@e.com", name: "Owner" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: PERMS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"],
    })
  );

  const asUser = t.withIdentity({ subject: "ps_u", clerkId: "ps_u" });
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });

  // Only the CURRENT year is open, as on production. The historical sales below
  // therefore have no period to post into.
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

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: "Prod" })
  );

  return { t, orgId, userId, asUser, customerId };
}

type Seed = Awaited<ReturnType<typeof seedProdShapedDealer>>;

async function seedSourcedVehicle(
  s: Seed,
  opts: {
    vin: string;
    sold: boolean;
    sourceCost?: number;
    purchasePrice?: number;
    salePrice?: number;
    withLedgerRow?: boolean;
  }
) {
  const salePrice = opts.salePrice ?? 12_500;
  const vehicleId = await s.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: s.orgId, vin: opts.vin, make: "Toyota", model: "Camry", year: 2023, mileage: 40_000,
      color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: salePrice,
      status: opts.sold ? "SOLD" : "AVAILABLE",
      sourceType: "SOURCED", sourcedFromName: "Amman Importer Co",
      ...(opts.sourceCost === undefined ? {} : { sourceCost: opts.sourceCost }),
      ...(opts.purchasePrice === undefined ? {} : { purchasePrice: opts.purchasePrice }),
    })
  );
  if (!opts.sold) return { vehicleId, saleId: null };

  const saleId = await s.t.run((ctx) =>
    ctx.db.insert("sales", {
      orgId: s.orgId, vehicleId, customerId: s.customerId, salespersonId: s.userId,
      salePrice, saleDate: HISTORICAL, status: "COMPLETED",
    })
  );

  const cogs = opts.sourceCost ?? opts.purchasePrice ?? 0;
  await s.t.run(async (ctx) => {
    const byKey = new Map(
      (await ctx.db.query("chartOfAccounts").collect())
        .filter((a) => a.orgId === s.orgId && a.systemKey)
        .map((a) => [a.systemKey!, a._id])
    );
    const entryId = await ctx.db.insert("journalEntries", {
      orgId: s.orgId, journalNumber: `LEG-${opts.vin}`, accountingDate: HISTORICAL,
      sourceType: "sales", sourceId: saleId, category: "SYSTEM",
      memo: "Legacy principal posting", status: "POSTED", currency: "JOD",
      postedBy: s.userId, postedAt: HISTORICAL, createdAt: HISTORICAL,
    });
    const lines: Array<[string, number, number]> = [
      [SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS, salePrice * SCALE, 0],
      [SYSTEM_KEYS.SALES_REVENUE, 0, salePrice * SCALE],
      [SYSTEM_KEYS.COST_OF_VEHICLES_SOLD, cogs * SCALE, 0],
      [SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS, 0, cogs * SCALE],
    ];
    let n = 1;
    for (const [key, debitMinor, creditMinor] of lines) {
      if (debitMinor === 0 && creditMinor === 0) continue;
      await ctx.db.insert("journalLines", {
        orgId: s.orgId, journalEntryId: entryId, lineNumber: n++,
        accountId: byKey.get(key)!, debitMinor, creditMinor,
        currency: "JOD", scale: 3, accountingDate: HISTORICAL,
      });
    }
  });

  if (opts.withLedgerRow) {
    await s.t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId: s.orgId, type: "IN" as const, amount: salePrice, date: HISTORICAL,
        category: "VEHICLE_SALE", description: `Sale of ${opts.vin}`,
        vehicleId, customerId: s.customerId,
      })
    );
  }
  return { vehicleId, saleId };
}

describe("a dry run over production's shape", () => {
  async function seedFleet() {
    const s = await seedProdShapedDealer();
    // The two sold ones: one clean, one whose supplier cost and purchase price
    // disagree — the SOURCED_COST_CONFLICT the impact report flags.
    await seedSourcedVehicle(s, { vin: "PS-SOLD-CLEAN", sold: true, sourceCost: 9_500, withLedgerRow: true });
    await seedSourcedVehicle(s, {
      vin: "PS-SOLD-CONFLICT", sold: true, sourceCost: 9_500, purchasePrice: 8_000, withLedgerRow: true,
    });
    // Unsold stock, most of it also carrying a purchase price, as on production.
    for (let i = 0; i < 40; i += 1) {
      await seedSourcedVehicle(s, {
        vin: `PS-STOCK-${i}`, sold: false, sourceCost: 9_000,
        ...(i < 37 ? { purchasePrice: 8_800 } : {}),
      });
    }
    return s;
  }

  test("reports what it would do, and does not write", async () => {
    const s = await seedFleet();

    const dry = await s.t.mutation(
      internal.migrateConsignedSaleBasis.migrateConsignedSaleBasis,
      { orgId: s.orgId, dryRun: true }
    );

    // eslint-disable-next-line no-console
    console.log("PRODUCTION-SHAPED DRY RUN:", JSON.stringify(dry, null, 2));

    expect(dry.status).toBe("COMPLETE");
    expect(dry.consignedSalesFound).toBe(2);
    expect(dry.corrected).toBe(1);
    expect(dry.flagged).toBe(1);
    // The point of the exercise: dated into a year with no open period, so it
    // would queue. A dry run that could not say this is what let a queued
    // correction be recorded as complete.
    expect(dry.queuedNow).toBe(1);
    expect(dry.postedNow).toBe(0);
    expect(dry.reportingBasisBackfilled).toBe(1);

    expect(await s.t.run((ctx) => ctx.db.query("consignedSaleCorrections").collect())).toHaveLength(0);
    expect(
      await s.t.run(async (ctx) =>
        (await ctx.db.query("financialAuditLog").collect()).filter(
          (a) => a.actionType === "MIGRATE_TRANSACTION"
        )
      )
    ).toHaveLength(0);
  });

  test("the real run lands exactly where the dry run said it would", async () => {
    const s = await seedFleet();

    const dry = await s.t.mutation(
      internal.migrateConsignedSaleBasis.migrateConsignedSaleBasis,
      { orgId: s.orgId, dryRun: true }
    );
    const real = await s.t.mutation(
      internal.migrateConsignedSaleBasis.migrateConsignedSaleBasis,
      { orgId: s.orgId }
    );

    // eslint-disable-next-line no-console
    console.log("PRODUCTION-SHAPED REAL RUN:", JSON.stringify(real, null, 2));

    const comparable = (r: typeof dry) => ({
      consignedSalesFound: r.consignedSalesFound,
      corrected: r.corrected,
      flagged: r.flagged,
      postedNow: r.postedNow,
      queuedNow: r.queuedNow,
      requiresReconciliation: r.requiresReconciliation,
      reportingBasisBackfilled: r.reportingBasisBackfilled,
    });
    expect(comparable(real)).toEqual(comparable(dry));
    expect(real.netIncomeDeltaMinor).toBe(0);

    const correction = await s.t.run((ctx) =>
      ctx.db.query("consignedSaleCorrections").collect()
    );
    expect(correction).toHaveLength(1);
    // Queued, and recorded as queued.
    expect(correction[0]!.status).toBe("PENDING_POSTING");
    expect(correction[0]!.correctionJournalEntryId).toBeUndefined();
  });

  test("the reporting basis is restated even while the journal waits", async () => {
    // The two ledgers fail independently. Holding the P&L fix hostage to a
    // period that happens to be shut would leave the back-book disagreeing with
    // itself for as long as the outbox is backed up.
    const s = await seedFleet();
    await s.t.mutation(internal.migrateConsignedSaleBasis.migrateConsignedSaleBasis, {
      orgId: s.orgId,
    });

    const restated = await s.t.run(async (ctx) =>
      (await ctx.db.query("transactions").collect()).filter(
        (tx) => tx.orgId === s.orgId && tx.recognizedRevenueAmount !== undefined
      )
    );
    expect(restated).toHaveLength(1);
    expect(restated[0]!.recognizedRevenueAmount).toBe(3_000);
    expect(restated[0]!.amount).toBe(12_500);
  });
});
