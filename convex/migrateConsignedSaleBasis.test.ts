/**
 * Restating historical consigned sales from principal to agent basis.
 *
 * The migration's entire licence to run unattended is that it cannot move
 * profit: the original posting booked gross revenue and a fabricated cost that
 * offset exactly, so removing both and recognizing the spread leaves net income
 * where it was. These tests hold it to that, hold it to correcting only what
 * the impact report says is safe, and hold it to being genuinely re-runnable —
 * not merely unlikely to double-post.
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

const PERMS = [
  "view:sales", "create:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "manage:finance", "view:finance",
  "view:commissions", "manage:commissions",
];

const SALE_PRICE = 12_500;
const ENTITLEMENT = 9_500;
const MARGIN = SALE_PRICE - ENTITLEMENT;
const SCALE = 1000;

async function seedDealer(tag: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Mig ${tag}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: "Mig User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: PERMS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );

  const asUser = t.withIdentity({ subject: `${tag}_u`, clerkId: `${tag}_u` });
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });

  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag })
  );

  return { t, orgId, userId, asUser, customerId };
}

/**
 * A consigned sale as the OLD code posted it: gross revenue, fabricated COGS
 * against AP-Suppliers, gross receivable from the customer. Written directly
 * because the current code refuses to post this — which is the point. The
 * migration exists for rows that are already on the books, and there is no
 * longer any way to create one through the application.
 */
async function seedLegacyPrincipalSale(
  s: Awaited<ReturnType<typeof seedDealer>>,
  opts: { vin: string; salePrice?: number; sourceCost?: number | undefined; cogs?: number; purchasePrice?: number }
) {
  const salePrice = opts.salePrice ?? SALE_PRICE;
  const cogsMajor = opts.cogs ?? ENTITLEMENT;
  const vehicleId = await s.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: s.orgId, vin: opts.vin, make: "Toyota", model: "Camry", year: 2024, mileage: 10,
      color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: salePrice,
      status: "SOLD", sourceType: "SOURCED", sourcedFromName: "Amman Importer Co",
      ...(opts.sourceCost === undefined ? {} : { sourceCost: opts.sourceCost }),
      ...(opts.purchasePrice ? { purchasePrice: opts.purchasePrice } : {}),
    })
  );
  const saleId = await s.t.run((ctx) =>
    ctx.db.insert("sales", {
      orgId: s.orgId, vehicleId, customerId: s.customerId, salespersonId: s.userId,
      salePrice, saleDate: Date.now(), status: "COMPLETED",
    })
  );

  await s.t.run(async (ctx) => {
    const accounts = (await ctx.db.query("chartOfAccounts").collect())
      .filter((a) => a.orgId === s.orgId);
    const byKey = new Map(accounts.filter((a) => a.systemKey).map((a) => [a.systemKey!, a._id]));
    const entryId = await ctx.db.insert("journalEntries", {
      orgId: s.orgId, journalNumber: `LEGACY-${opts.vin}`, accountingDate: Date.now(),
      sourceType: "sales", sourceId: saleId, category: "SYSTEM",
      memo: "Legacy principal posting", status: "POSTED", currency: "JOD",
      postedBy: s.userId, postedAt: Date.now(), createdAt: Date.now(),
    });
    const lines: Array<[string, number, number]> = [
      [SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS, salePrice * SCALE, 0],
      [SYSTEM_KEYS.SALES_REVENUE, 0, salePrice * SCALE],
      [SYSTEM_KEYS.COST_OF_VEHICLES_SOLD, cogsMajor * SCALE, 0],
      [SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS, 0, cogsMajor * SCALE],
    ];
    let n = 1;
    for (const [key, debitMinor, creditMinor] of lines) {
      if (debitMinor === 0 && creditMinor === 0) continue;
      await ctx.db.insert("journalLines", {
        orgId: s.orgId, journalEntryId: entryId, lineNumber: n++,
        accountId: byKey.get(key)!, debitMinor, creditMinor,
        currency: "JOD", scale: 3, accountingDate: Date.now(),
      });
    }
  });

  return { vehicleId, saleId };
}

/** Net movement per system key across the whole org's posted ledger. */
async function ledger(
  t: ReturnType<typeof convexTestWithComponents>,
  orgId: string
): Promise<Record<string, number>> {
  return await t.run(async (ctx) => {
    const accounts = (await ctx.db.query("chartOfAccounts").collect())
      .filter((a) => a.orgId === orgId);
    const keyByAccount = new Map<string, string>();
    for (const a of accounts) if (a.systemKey) keyByAccount.set(a._id, a.systemKey);

    const entries = (await ctx.db.query("journalEntries").collect())
      .filter((e) => e.orgId === orgId && e.status === "POSTED");
    const allLines = await ctx.db.query("journalLines").collect();

    const totals: Record<string, number> = {};
    for (const entry of entries) {
      for (const l of allLines.filter((x) => x.journalEntryId === entry._id)) {
        const key = keyByAccount.get(l.accountId);
        if (!key) continue;
        totals[key] = (totals[key] ?? 0) + l.debitMinor - l.creditMinor;
      }
    }
    return totals;
  });
}

function netIncome(l: Record<string, number>): number {
  // Revenue and expense are both signed as (debit − credit), so income is the
  // negation of revenue plus the expenses that reduce it.
  const revenue = -((l[SYSTEM_KEYS.SALES_REVENUE] ?? 0) + (l[SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE] ?? 0));
  const cogs = l[SYSTEM_KEYS.COST_OF_VEHICLES_SOLD] ?? 0;
  return revenue - cogs;
}

async function runMigration(
  s: Awaited<ReturnType<typeof seedDealer>>,
  opts: { dryRun?: boolean } = {}
) {
  return await s.t.mutation(internal.migrateConsignedSaleBasis.migrateConsignedSaleBasis, {
    orgId: s.orgId,
    ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
  });
}

describe("the correction itself", () => {
  test("removes the gross and the fabricated cost, recognizes the spread, and moves no profit", async () => {
    const s = await seedDealer("basic");
    await seedLegacyPrincipalSale(s, { vin: "VINMIG1", sourceCost: ENTITLEMENT });

    const before = await ledger(s.t, s.orgId);
    expect(before[SYSTEM_KEYS.SALES_REVENUE]).toBe(-SALE_PRICE * SCALE);
    expect(before[SYSTEM_KEYS.COST_OF_VEHICLES_SOLD]).toBe(ENTITLEMENT * SCALE);

    const report = await runMigration(s);
    expect(report.status).toBe("COMPLETE");
    expect(report.corrected).toBe(1);

    const after = await ledger(s.t, s.orgId);
    // Turnover and cost of sales both drop to nothing; only the spread remains.
    expect(after[SYSTEM_KEYS.SALES_REVENUE]).toBe(0);
    expect(after[SYSTEM_KEYS.COST_OF_VEHICLES_SOLD]).toBe(0);
    expect(after[SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE]).toBe(-MARGIN * SCALE);

    // The whole premise, asserted rather than assumed.
    expect(netIncome(after)).toBe(netIncome(before));
    expect(report.netIncomeDeltaMinor).toBe(0);
  });

  test("leaves the balance sheet alone, because nothing on it was wrong", async () => {
    const s = await seedDealer("bs");
    await seedLegacyPrincipalSale(s, { vin: "VINMIG2", sourceCost: ENTITLEMENT });

    const before = await ledger(s.t, s.orgId);
    await runMigration(s);
    const after = await ledger(s.t, s.orgId);

    // The principal posting debited AR for the gross and credited AP for the
    // entitlement — which is exactly what agent basis does on this route. A
    // correction that touched them would be introducing an error, not fixing one.
    expect(after[SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS])
      .toBe(before[SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS]);
    expect(after[SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS])
      .toBe(before[SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS]);
  });

  test("records what it did, linked to the entries it corrected", async () => {
    const s = await seedDealer("audit");
    const { saleId } = await seedLegacyPrincipalSale(s, { vin: "VINMIG3", sourceCost: ENTITLEMENT });

    await runMigration(s);

    const corrections = await s.t.run((ctx) =>
      ctx.db.query("consignedSaleCorrections").collect()
    );
    expect(corrections).toHaveLength(1);
    const c = corrections[0]!;
    expect(c.saleId).toBe(saleId);
    expect(c.revenueReclassifiedMinor).toBe(SALE_PRICE * SCALE);
    expect(c.commissionRecognizedMinor).toBe(MARGIN * SCALE);
    expect(c.cogsReversedMinor).toBe(ENTITLEMENT * SCALE);
    expect(c.netIncomeDeltaMinor).toBe(0);
    // Links back to the original posting rather than replacing it: both entries
    // stay on the books, which is the only version an auditor can follow.
    expect(c.originalJournalEntryIds).toHaveLength(1);
    expect(c.correctionJournalEntryId).toBeDefined();
    expect(c.correctionJournalEntryId).not.toBe(c.originalJournalEntryIds[0]);

    const audit = await s.t.run((ctx) =>
      ctx.db.query("financialAuditLog").collect()
    );
    const migrations = audit.filter((a) => a.actionType === "MIGRATE_TRANSACTION");
    expect(migrations).toHaveLength(1);
    expect(migrations[0]!.resourceId).toBe(saleId);
  });
});

describe("re-running it", () => {
  test("has zero additional financial effect", async () => {
    const s = await seedDealer("rerun");
    await seedLegacyPrincipalSale(s, { vin: "VINMIG4", sourceCost: ENTITLEMENT });

    const first = await runMigration(s);
    expect(first.corrected).toBe(1);
    const afterFirst = await ledger(s.t, s.orgId);

    const second = await runMigration(s);
    expect(second.corrected).toBe(0);
    expect(second.alreadyCorrected).toBe(1);

    // Not "close enough" — identical.
    expect(await ledger(s.t, s.orgId)).toEqual(afterFirst);
  });

  test("duplicates neither the correction record nor the audit trail", async () => {
    const s = await seedDealer("rerun2");
    await seedLegacyPrincipalSale(s, { vin: "VINMIG5", sourceCost: ENTITLEMENT });

    await runMigration(s);
    await runMigration(s);
    await runMigration(s);

    const corrections = await s.t.run((ctx) => ctx.db.query("consignedSaleCorrections").collect());
    expect(corrections).toHaveLength(1);
    const migrations = (await s.t.run((ctx) => ctx.db.query("financialAuditLog").collect()))
      .filter((a) => a.actionType === "MIGRATE_TRANSACTION");
    expect(migrations).toHaveLength(1);
  });

  test("a sale already on agent basis is left alone rather than counted as work", async () => {
    const s = await seedDealer("agentAlready");
    // Posted correctly by the current code — no vehicle revenue, no COGS.
    const vehicleId = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId, vin: "VINMIG6", make: "Kia", model: "Rio", year: 2023, mileage: 5,
        color: "Red", fuelType: "Gas", transmission: "Auto", sellingPrice: SALE_PRICE,
        status: "AVAILABLE", sourceType: "SOURCED",
        sourcedFromName: "Amman Importer Co", sourceCost: ENTITLEMENT,
      })
    );
    await s.asUser.mutation(api.sales.create, {
      orgId: s.orgId, vehicleId, customerId: s.customerId, salespersonId: s.userId,
      salePrice: SALE_PRICE, saleDate: Date.now(), status: "COMPLETED" as const,
    });

    const before = await ledger(s.t, s.orgId);
    const report = await runMigration(s);

    expect(report.alreadyAgentBasis).toBe(1);
    expect(report.corrected).toBe(0);
    expect(await ledger(s.t, s.orgId)).toEqual(before);
  });
});

describe("what it refuses to touch", () => {
  test("a sale with no supplier cost, because the margin cannot be derived", async () => {
    const s = await seedDealer("noCost");
    await seedLegacyPrincipalSale(s, { vin: "VINMIG7", sourceCost: undefined });

    const before = await ledger(s.t, s.orgId);
    const report = await runMigration(s);

    expect(report.flagged).toBe(1);
    expect(report.corrected).toBe(0);
    expect(await ledger(s.t, s.orgId)).toEqual(before);
  });

  test("a sale whose correction would move profit", async () => {
    // Posted COGS of 8,000 against an agreed entitlement of 9,500: gross profit
    // on the books is 4,500 but the real margin is 3,000. Correcting it would
    // move reported profit by 1,500 — a restatement, not a reclassification,
    // and not something to do to a dealership's books unattended.
    const s = await seedDealer("profitMove");
    await seedLegacyPrincipalSale(s, { vin: "VINMIG8", sourceCost: ENTITLEMENT, cogs: 8_000 });

    const before = await ledger(s.t, s.orgId);
    const report = await runMigration(s);

    expect(report.flagged).toBe(1);
    expect(report.corrected).toBe(0);
    expect(netIncome(await ledger(s.t, s.orgId))).toBe(netIncome(before));
  });

  test("a vehicle marked SOURCED that also carries an own purchase price", async () => {
    const s = await seedDealer("bothPrices");
    await seedLegacyPrincipalSale(s, {
      vin: "VINMIG9", sourceCost: ENTITLEMENT, purchasePrice: 9_000,
    });

    const report = await runMigration(s);
    expect(report.flagged).toBe(1);
    expect(report.corrected).toBe(0);
  });

  test("a dealer-owned sale, which was never misposted in the first place", async () => {
    const s = await seedDealer("owned");
    const vehicleId = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId, vin: "VINMIG10", make: "Kia", model: "Rio", year: 2023, mileage: 5,
        color: "Red", fuelType: "Gas", transmission: "Auto", sellingPrice: 8_000,
        status: "AVAILABLE", sourceType: "STOCK", purchasePrice: 6_000,
      })
    );
    await s.asUser.mutation(api.sales.create, {
      orgId: s.orgId, vehicleId, customerId: s.customerId, salespersonId: s.userId,
      salePrice: 8_000, saleDate: Date.now(), status: "COMPLETED" as const,
    });

    const before = await ledger(s.t, s.orgId);
    const report = await runMigration(s);

    expect(report.consignedSalesFound).toBe(0);
    expect(report.corrected).toBe(0);
    expect(await ledger(s.t, s.orgId)).toEqual(before);
  });
});

describe("the dry run", () => {
  test("reports exactly what the real run would correct, and writes nothing", async () => {
    const s = await seedDealer("dry");
    await seedLegacyPrincipalSale(s, { vin: "VINMIG11", sourceCost: ENTITLEMENT });
    await seedLegacyPrincipalSale(s, { vin: "VINMIG12", sourceCost: undefined });

    const before = await ledger(s.t, s.orgId);
    const dry = await runMigration(s, { dryRun: true });

    expect(dry.dryRun).toBe(true);
    expect(dry.corrected).toBe(1);
    expect(dry.flagged).toBe(1);
    expect(dry.revenueReclassifiedMinor).toBe(SALE_PRICE * SCALE);
    // Nothing moved, and nothing was recorded as having moved.
    expect(await ledger(s.t, s.orgId)).toEqual(before);
    expect(await s.t.run((ctx) => ctx.db.query("consignedSaleCorrections").collect())).toHaveLength(0);

    // And the real run then does precisely what the dry run promised.
    const real = await runMigration(s);
    expect(real.corrected).toBe(dry.corrected);
    expect(real.flagged).toBe(dry.flagged);
    expect(real.revenueReclassifiedMinor).toBe(dry.revenueReclassifiedMinor);
  });
});
