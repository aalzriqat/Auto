/**
 * Phase 41 tests — VAT return summary.
 *
 * Output VAT = SALES_TAX_PAYABLE activity (credit-normal liability); input
 * VAT = VAT_RECEIVABLE activity (debit-normal asset). Seeds ledger lines
 * directly on both accounts to isolate the report's aggregation math from
 * the sale/expense flows that normally produce them (those are covered by
 * their own posting-rule tests).
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { getPostedLines } from "./accountingReports";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedDealer() {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Phase41 VAT Dealer", createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "p41v_owner", email: "p41vowner@example.com", name: "Owner" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "Owner", permissions: ["view:finance", "manage:finance"], isSystemOwnerRole: true,
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] })
  );

  const asOwner = t.withIdentity({ subject: "p41v_owner", clerkId: "p41v_owner" });
  // VAT_RECEIVABLE is in DEFAULT_CHART, so a freshly initialized chart already
  // has it — no separate seed needed (self-healing only matters for orgs
  // whose chart predates this key, covered by the posting-rule tests instead).
  await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });

  const salesTaxPayable = await t.run((ctx) =>
    ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", "SALES_TAX_PAYABLE"))
      .unique()
  );
  const vatReceivable = await t.run((ctx) =>
    ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", "VAT_RECEIVABLE"))
      .unique()
  );
  const suspense = await t.run((ctx) =>
    ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", "RETAINED_EARNINGS"))
      .unique()
  );

  async function seedLine(accountId: string, debitMinor: number, creditMinor: number, accountingDate: number) {
    const now = Date.now();
    const journalId = await t.run((ctx) =>
      ctx.db.insert("journalEntries", {
        orgId, journalNumber: `TEST-${accountingDate}-${Math.random()}`, accountingDate, sourceType: "test",
        sourceId: `test-${Math.random()}`, category: "SYSTEM", memo: "Test VAT line", status: "POSTED",
        currency: "JOD", postedBy: userId, postedAt: now, createdAt: now,
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("journalLines", {
        orgId, journalEntryId: journalId, lineNumber: 1, accountId: accountId as any,
        debitMinor, creditMinor, currency: "JOD", scale: 3, accountingDate,
      })
    );
    // Balancing suspense line so validateBalance-equivalent totals aren't
    // required here (this test seeds lines directly, not through
    // applyPostingRule), but keeps the ledger internally consistent.
    await t.run((ctx) =>
      ctx.db.insert("journalLines", {
        orgId, journalEntryId: journalId, lineNumber: 2, accountId: suspense!._id,
        debitMinor: creditMinor, creditMinor: debitMinor, currency: "JOD", scale: 3, accountingDate,
      })
    );
    return journalId;
  }

  return { t, orgId, userId, asOwner, salesTaxPayable: salesTaxPayable!, vatReceivable: vatReceivable!, seedLine };
}

describe("vatReport.generateVatSummary", () => {
  test("bounded ledger reads select only dated lines' authorized parent entries", async () => {
    const { t, orgId, userId, salesTaxPayable, seedLine } = await seedDealer();
    const date = Date.UTC(2025, 4, 10);
    const earlierDate = date - 86_400_000;
    const outside = Date.UTC(2024, 4, 10);
    await seedLine(salesTaxPayable._id, 0, 900_000, outside);
    const postedId = await seedLine(salesTaxPayable._id, 0, 50_000, date);
    const reversedId = await seedLine(salesTaxPayable._id, 10_000, 0, earlierDate);
    const draftId = await seedLine(salesTaxPayable._id, 0, 700_000, date);
    await t.run(async (ctx) => {
      await ctx.db.patch(reversedId, { status: "REVERSED", accountingDate: outside });
      await ctx.db.patch(draftId, { status: "DRAFT" });
      const foreignOrgId = await ctx.db.insert("organizations", { name: "Foreign ledger", createdAt: Date.now() });
      const foreignEntryId = await ctx.db.insert("journalEntries", {
        orgId: foreignOrgId, journalNumber: "FOREIGN-1", accountingDate: date, sourceType: "test",
        sourceId: "foreign-1", category: "SYSTEM", memo: "Foreign parent", status: "POSTED",
        currency: "JOD", postedBy: userId, postedAt: date, createdAt: date,
      });
      // A stale cross-tenant parent reference must be excluded just as the
      // original org-scoped journal-entry scan excluded it.
      await ctx.db.insert("journalLines", {
        orgId, journalEntryId: foreignEntryId, lineNumber: 1, accountId: salesTaxPayable._id,
        debitMinor: 0, creditMinor: 800_000, currency: "JOD", scale: 3, accountingDate: date,
      });
    });

    const { rows, queriedTables } = await t.run(async (ctx) => {
      const queriedTables: string[] = [];
      const originalQuery = ctx.db.query.bind(ctx.db);
      const db = {
        get: ctx.db.get.bind(ctx.db),
        query: (table: Parameters<typeof ctx.db.query>[0]) => {
          queriedTables.push(table);
          return originalQuery(table);
        },
      } as typeof ctx.db;
      const rows = await getPostedLines({ ...ctx, db }, orgId, earlierDate, date);
      return { rows, queriedTables };
    });

    expect(rows.map((row) => row.journalEntryId)).toEqual([postedId, postedId, reversedId, reversedId]);
    expect(queriedTables).not.toContain("journalEntries");
  });

  test("open upper bound ignores sentinel lines when choosing targeted parent reads", async () => {
    const { t, orgId, salesTaxPayable, seedLine } = await seedDealer();
    const date = Date.UTC(2025, 4, 10);
    const sentinelId = await seedLine(salesTaxPayable._id, 0, 1, -1);
    const preEpochId = await seedLine(salesTaxPayable._id, 0, 2, -100_000);
    const postedId = await seedLine(salesTaxPayable._id, 0, 50_000, date);
    await t.run(async (ctx) => {
      for (let lineNumber = 3; lineNumber <= 129; lineNumber++) {
        await ctx.db.insert("journalLines", {
          orgId, journalEntryId: sentinelId, lineNumber, accountId: salesTaxPayable._id,
          debitMinor: 0, creditMinor: 1, currency: "JOD", scale: 3, accountingDate: -1,
        });
      }
    });

    const { rows, queriedTables } = await t.run(async (ctx) => {
      const queriedTables: string[] = [];
      const originalQuery = ctx.db.query.bind(ctx.db);
      const db = {
        get: ctx.db.get.bind(ctx.db),
        query: (table: Parameters<typeof ctx.db.query>[0]) => {
          queriedTables.push(table);
          return originalQuery(table);
        },
      } as typeof ctx.db;
      const rows = await getPostedLines({ ...ctx, db }, orgId, undefined, date);
      return { rows, queriedTables };
    });

    expect(rows.map((row) => row.journalEntryId)).toEqual([preEpochId, preEpochId, postedId, postedId]);
    expect(queriedTables).not.toContain("journalEntries");
  });

  test("large dated ledger windows return every line beyond the targeted-read limit", async () => {
    const { t, orgId, salesTaxPayable, seedLine } = await seedDealer();
    const date = Date.UTC(2025, 4, 10);
    const journalId = await seedLine(salesTaxPayable._id, 0, 1, date);
    await t.run(async (ctx) => {
      for (let lineNumber = 3; lineNumber <= 129; lineNumber++) {
        await ctx.db.insert("journalLines", {
          orgId, journalEntryId: journalId, lineNumber, accountId: salesTaxPayable._id,
          debitMinor: 0, creditMinor: 1, currency: "JOD", scale: 3, accountingDate: date,
        });
      }
    });

    const rows = await t.run((ctx) => getPostedLines(ctx, orgId, date, date));
    expect(rows).toHaveLength(129);
    expect(rows.every((row) => row.journalEntryId === journalId)).toBe(true);
  });

  test("computes output VAT, input VAT, and net due for a bounded date range", async () => {
    const { orgId, asOwner, salesTaxPayable, vatReceivable, seedLine } = await seedDealer();
    const inRange = Date.now();

    // Output VAT: SALES_TAX_PAYABLE credited 50 (sale) then debited 10 (a cancellation reversal).
    await seedLine(salesTaxPayable._id, 0, 50_000, inRange);
    await seedLine(salesTaxPayable._id, 10_000, 0, inRange);
    // Input VAT: VAT_RECEIVABLE debited 15 (expense) and 5 (supplier payment).
    await seedLine(vatReceivable._id, 15_000, 0, inRange);
    await seedLine(vatReceivable._id, 5_000, 0, inRange);

    const summary = await asOwner.query(api.vatReport.generateVatSummary, {
      orgId, fromDate: inRange - 1, toDate: inRange + 1,
    });

    expect(summary.currency).toBe("JOD");
    expect(summary.outputVatMinor).toBe(40_000); // 50 - 10
    expect(summary.inputVatMinor).toBe(20_000); // 15 + 5
    expect(summary.netDueMinor).toBe(20_000); // 40 - 20
  });

  test("excludes activity outside the requested date range", async () => {
    const { orgId, asOwner, salesTaxPayable, seedLine } = await seedDealer();
    const inRange = Date.now();
    const outOfRange = inRange - 90 * 24 * 60 * 60 * 1000;

    await seedLine(salesTaxPayable._id, 0, 30_000, inRange);
    await seedLine(salesTaxPayable._id, 0, 999_000, outOfRange);

    const summary = await asOwner.query(api.vatReport.generateVatSummary, {
      orgId, fromDate: inRange - 1, toDate: inRange + 1,
    });
    expect(summary.outputVatMinor).toBe(30_000);
  });

  test("returns zeroed totals when there is no VAT activity yet", async () => {
    const { orgId, asOwner } = await seedDealer();
    const summary = await asOwner.query(api.vatReport.generateVatSummary, {
      orgId, fromDate: Date.now() - 1000, toDate: Date.now(),
    });
    expect(summary.outputVatMinor).toBe(0);
    expect(summary.inputVatMinor).toBe(0);
    expect(summary.netDueMinor).toBe(0);
    expect(summary.lines).toHaveLength(0);
  });

  test("rejects unauthenticated requests", async () => {
    const { t, orgId } = await seedDealer();
    await expect(
      t.query(api.vatReport.generateVatSummary, { orgId, fromDate: Date.now() - 1000, toDate: Date.now() })
    ).rejects.toThrow();
  });
});
