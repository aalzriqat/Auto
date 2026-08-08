import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { SYSTEM_KEYS } from "./utils/defaultChart";

const jod = (major: number): number => Math.round(major * 1000);

const ACCOUNTS = [
  { key: SYSTEM_KEYS.SALES_REVENUE, code: "4000", name: "Sales Revenue", type: "REVENUE", normal: "CREDIT" },
  { key: SYSTEM_KEYS.COST_OF_VEHICLES_SOLD, code: "5000", name: "Cost of Vehicles Sold", type: "COGS", normal: "DEBIT" },
  { key: SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS, code: "1200", name: "AR — Customers", type: "ASSET", normal: "DEBIT" },
  { key: SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS, code: "2100", name: "AP — Suppliers", type: "LIABILITY", normal: "CREDIT" },
  { key: SYSTEM_KEYS.VEHICLE_INVENTORY, code: "1400", name: "Vehicle Inventory", type: "ASSET", normal: "DEBIT" },
] as const;

interface SeedOptions {
  sourceCost?: number | undefined;
  salePrice?: number;
  /** Post the journal the way the live principal path does. */
  postJournal?: boolean;
  purchasePrice?: number;
  reliefToInventory?: boolean;
  cogsOverride?: number;
  /** A second, perfectly readable sale in the same org — proves the scan continues. */
  secondSalePrice?: number;
}

async function seed(options: SeedOptions = {}) {
  const t = convexTest(schema, import.meta.glob("./**/*.ts"));
  const salePrice = options.salePrice ?? 12_500;
  const sourceCost = options.sourceCost === undefined && !("sourceCost" in options) ? 9_500 : options.sourceCost;

  const ids = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "Bloom Cars", createdAt: Date.now() });
    const userId = await ctx.db.insert("users", { clerkId: "impact_1", email: "o@x.com" });
    const accountIds = new Map<string, Id<"chartOfAccounts">>();
    for (const a of ACCOUNTS) {
      accountIds.set(
        a.key,
        await ctx.db.insert("chartOfAccounts", {
          orgId, code: a.code, name: a.name,
          type: a.type as "REVENUE" | "COGS" | "ASSET" | "LIABILITY",
          normalBalance: a.normal as "DEBIT" | "CREDIT",
          isControlAccount: false, allowManualPosting: true, active: true,
          systemKey: a.key, createdAt: Date.now(), updatedAt: Date.now(),
        })
      );
    }
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId, vin: "VINSRC1", make: "Toyota", model: "Camry", year: 2024, mileage: 12,
      color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: salePrice,
      status: "SOLD", sourceType: "SOURCED", sourcedFromName: "Amman Importer Co",
      ...(sourceCost === undefined ? {} : { sourceCost }),
      ...(options.purchasePrice ? { purchasePrice: options.purchasePrice } : {}),
    });
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "Fin", lastName: "Cust" });
    const saleId = await ctx.db.insert("sales", {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice, saleDate: Date.now(), status: "COMPLETED", financingType: "FINANCED",
    });

    // An unreadable price cannot have posted a journal — `jod(NaN)` is NaN, and
    // seeding lines from it would be asserting about entries nobody could make.
    if (options.postJournal !== false && Number.isFinite(salePrice)) {
      const entryId = await ctx.db.insert("journalEntries", {
        orgId, journalNumber: "JE-1", accountingDate: Date.now(),
        sourceType: "sales", sourceId: saleId, category: "SYSTEM",
        memo: "Vehicle sale completed", status: "POSTED", currency: "JOD",
        postedBy: userId, postedAt: Date.now(), createdAt: Date.now(),
      });
      const cogs = options.cogsOverride ?? sourceCost ?? 0;
      const lines: Array<[string, number, number]> = [
        [SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS, jod(salePrice), 0],
        [SYSTEM_KEYS.SALES_REVENUE, 0, jod(salePrice)],
      ];
      if (cogs > 0) {
        lines.push([SYSTEM_KEYS.COST_OF_VEHICLES_SOLD, jod(cogs), 0]);
        lines.push([
          options.reliefToInventory ? SYSTEM_KEYS.VEHICLE_INVENTORY : SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS,
          0, jod(cogs),
        ]);
      }
      let lineNumber = 1;
      for (const [key, debitMinor, creditMinor] of lines) {
        await ctx.db.insert("journalLines", {
          orgId, journalEntryId: entryId, lineNumber: lineNumber++,
          accountId: accountIds.get(key)!, debitMinor, creditMinor,
          currency: "JOD", scale: 3, accountingDate: Date.now(),
        });
      }
    }
    if (options.secondSalePrice !== undefined) {
      const vehicle2 = await ctx.db.insert("vehicles", {
        orgId, vin: "VINSRC2", make: "Toyota", model: "Corolla", year: 2024, mileage: 8,
        color: "Grey", fuelType: "Gas", transmission: "Auto", sellingPrice: options.secondSalePrice,
        status: "SOLD", sourceType: "SOURCED", sourcedFromName: "Amman Importer Co",
        sourceCost: 9_500,
      });
      const sale2 = await ctx.db.insert("sales", {
        orgId, vehicleId: vehicle2, customerId, salespersonId: userId,
        salePrice: options.secondSalePrice, saleDate: Date.now(), status: "COMPLETED",
        financingType: "FINANCED",
      });
      const entry2 = await ctx.db.insert("journalEntries", {
        orgId, journalNumber: "JE-2", accountingDate: Date.now(),
        sourceType: "sales", sourceId: sale2, category: "SYSTEM",
        memo: "Vehicle sale completed", status: "POSTED", currency: "JOD",
        postedBy: userId, postedAt: Date.now(), createdAt: Date.now(),
      });
      const secondLines: Array<[string, number, number]> = [
        [SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS, jod(options.secondSalePrice), 0],
        [SYSTEM_KEYS.SALES_REVENUE, 0, jod(options.secondSalePrice)],
        [SYSTEM_KEYS.COST_OF_VEHICLES_SOLD, jod(9_500), 0],
        [SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS, 0, jod(9_500)],
      ];
      let secondLineNumber = 1;
      for (const [key, debitMinor, creditMinor] of secondLines) {
        await ctx.db.insert("journalLines", {
          orgId, journalEntryId: entry2, lineNumber: secondLineNumber++,
          accountId: accountIds.get(key)!, debitMinor, creditMinor,
          currency: "JOD", scale: 3, accountingDate: Date.now(),
        });
      }
    }

    return { orgId, saleId, vehicleId };
  });

  const report = await t.query(internal.sourcedAgentImpact.sourcedSaleImpactReport, {
    orgId: ids.orgId,
  });
  return { t, ids, org: report.orgs[0]! };
}

describe("sourced-sale impact report", () => {
  test("states the margin the dealership may recognize and what the gross posting overstated", async () => {
    const { org } = await seed();
    const row = org.rows[0]!;

    expect(org.sourcedSalesFound).toBe(1);
    expect(row.grossTransactionMinor).toBe(jod(12_500));
    expect(row.supplierEntitlementMinor).toBe(jod(9_500));
    expect(row.dealershipMarginMinor).toBe(jod(3_000));

    // What is on the books today.
    expect(row.posted.revenueMinor).toBe(jod(12_500));
    expect(row.posted.cogsMinor).toBe(jod(9_500));
    expect(row.posted.customerArMinor).toBe(jod(12_500));

    // What agent accounting says it should have been.
    expect(row.shouldBe.commissionRevenueMinor).toBe(jod(3_000));
    expect(row.shouldBe.cogsMinor).toBe(0);

    // The overstatement is the supplier's entitlement, in three places at once.
    expect(row.overstatement.revenueMinor).toBe(jod(9_500));
    expect(row.overstatement.cogsMinor).toBe(jod(9_500));
    expect(row.overstatement.customerArMinor).toBe(jod(9_500));
  });

  test("proves the correction is a reclassification, not a change in profit", async () => {
    const { org } = await seed();
    const row = org.rows[0]!;

    // The claim the whole migration rests on: gross posting and agent posting
    // reach the same bottom line. If this ever fails the row is flagged instead.
    expect(row.posted.grossProfitMinor).toBe(row.dealershipMarginMinor);
    expect(row.flags).not.toContain("PROFIT_WOULD_CHANGE");
    expect(org.anomalyCount).toBe(0);
    expect(org.migratableCount).toBe(1);
  });

  test("flags a row whose correction WOULD move profit, instead of migrating it", async () => {
    // COGS posted at something other than the supplier's entitlement — the two
    // no longer reconcile, so correcting it silently would restate profit.
    const { org } = await seed({ cogsOverride: 8_000 });
    const row = org.rows[0]!;

    expect(row.posted.grossProfitMinor).toBe(jod(4_500));
    expect(row.dealershipMarginMinor).toBe(jod(3_000));
    expect(row.flags).toContain("PROFIT_WOULD_CHANGE");
    expect(org.anomalyCount).toBe(1);
    expect(org.migratableCount).toBe(0);
  });

  test("refuses to invent a margin when no supplier entitlement is recorded", async () => {
    const { org } = await seed({ sourceCost: undefined });
    const row = org.rows[0]!;

    // Defaulting the entitlement to zero would claim the entire 12,500 as the
    // dealership's margin — the same overstatement, pointing the other way.
    expect(row.supplierEntitlementMinor).toBeNull();
    expect(row.dealershipMarginMinor).toBeNull();
    expect(row.overstatement.revenueMinor).toBeNull();
    expect(row.flags).toContain("NO_SOURCE_COST");
    expect(org.migratableCount).toBe(0);
  });

  test("flags a car carrying two DIFFERENT cost figures", async () => {
    // Requirement 8: two numbers for what the car cost, and nothing that says
    // which one the supplier is actually owed. Correcting the sale would mean
    // asserting one of them, which is a decision about somebody's money.
    const { org } = await seed({ purchasePrice: 9_000 });
    expect(org.rows[0]!.flags).toContain("SOURCED_COST_CONFLICT");
    expect(org.migratableCount).toBe(0);
  });

  test("flags inventory relief taken on a car the dealership never owned", async () => {
    const { org } = await seed({ reliefToInventory: true });
    expect(org.rows[0]!.flags).toContain("INVENTORY_RELIEVED_ON_CONSIGNED_CAR");
  });

  test("flags a completed sourced sale that never posted a journal at all", async () => {
    const { org } = await seed({ postJournal: false });
    const row = org.rows[0]!;
    expect(row.flags).toContain("NO_POSTED_JOURNAL");
    expect(row.posted.revenueMinor).toBe(0);
    expect(org.migratableCount).toBe(0);
  });

  test("flags an unreadable amount instead of aborting the whole report", async () => {
    // Convex accepts NaN for a `v.number()` field, so a sale price can be
    // genuinely unreadable on a live row. `toMinorUnits` throws on it, and the
    // throw escaped the per-sale loop: the entire production impact report
    // returned nothing, for every org, naming no sale. An accountant preparing
    // a migration got an error instead of the 41 rows that were perfectly fine.
    //
    // The row itself must still fail closed — any flag disqualifies it from
    // automatic correction — but it must be REPORTED, not hidden by killing the
    // scan around it.
    const { org } = await seed({ salePrice: Number.NaN });
    const row = org.rows[0]!;

    expect(org.sourcedSalesFound).toBe(1);
    expect(row.flags).toContain("UNREADABLE_AMOUNT");
    // Nothing derived from an amount nobody can read is asserted as a number.
    expect(row.grossTransactionMinor).toBeNull();
    expect(row.dealershipMarginMinor).toBeNull();
  });

  test("keeps scanning the rows either side of a bad one", async () => {
    // The point of the flag: one unreadable sale must cost you that sale, not
    // the report. Two sales in one org, the first unreadable.
    const { org } = await seed({ salePrice: Number.NaN, secondSalePrice: 12_500 });

    expect(org.sourcedSalesFound).toBe(2);
    const bad = org.rows.find((r) => r.flags.includes("UNREADABLE_AMOUNT"));
    const good = org.rows.find((r) => !r.flags.includes("UNREADABLE_AMOUNT"));
    expect(bad).toBeTruthy();
    expect(good?.grossTransactionMinor).toBe(jod(12_500));
    expect(good?.dealershipMarginMinor).toBe(jod(3_000));
  });

  test("flags an unreadable PURCHASE price too, not just the sale price", async () => {
    // NaN is falsy, so a `> 0` short-circuit hides it — but Infinity is truthy
    // and threw straight through the same loop, aborting the same report from a
    // different field. The first fix caught only the field its test used.
    const { org } = await seed({ purchasePrice: Number.POSITIVE_INFINITY });
    const row = org.rows[0]!;

    expect(org.sourcedSalesFound).toBe(1);
    expect(row.flags).toContain("UNREADABLE_AMOUNT");
  });

  test("leaves owned stock out of the report entirely", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const orgId = await t.run(async (ctx) => {
      const org = await ctx.db.insert("organizations", { name: "Bloom Cars", createdAt: Date.now() });
      const userId = await ctx.db.insert("users", { clerkId: "impact_2", email: "o2@x.com" });
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId: org, vin: "VINOWN1", make: "Kia", model: "Rio", year: 2023, mileage: 30,
        color: "Red", fuelType: "Gas", transmission: "Auto", sellingPrice: 9_000,
        status: "SOLD", sourceType: "STOCK", purchasePrice: 7_000,
      });
      const customerId = await ctx.db.insert("customers", { orgId: org, firstName: "A", lastName: "B" });
      await ctx.db.insert("sales", {
        orgId: org, vehicleId, customerId, salespersonId: userId,
        salePrice: 9_000, saleDate: Date.now(), status: "COMPLETED",
      });
      return org;
    });

    const report = await t.query(internal.sourcedAgentImpact.sourcedSaleImpactReport, { orgId });
    expect(report.orgs[0]!.sourcedSalesFound).toBe(0);
  });
});
