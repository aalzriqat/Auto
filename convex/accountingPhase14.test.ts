/**
 * Phase 14 tests — multi-currency reporting correctness.
 *
 * Acceptance gates: journal lines in different currencies on one account are
 * never summed as raw minor units (per-currency rows + subtotals), and
 * single-currency orgs see no behavioral change (that half of the gate is
 * additionally enforced by accountingPhase5.test.ts, which runs the same
 * reports against a JOD-only org and still passes untouched).
 *
 * ⚠️ THE PRODUCER CHANGED IN SCRUM-51, THE SUBJECT DID NOT. These lines used
 * to be produced by creating and settling a claim in each currency, because
 * claim currency was captured from org settings. Claims is retired as an
 * accounting authority (owner ruling c14514 / c14519) and its writers now
 * refuse, so the ledger is seeded directly here, as `accountingPhase5.test.ts`
 * seeds its own reports — plus the running balance snapshots these two reports
 * actually read, which phase 5 does not need and `seedJournal` explains below.
 * That is the right shape for a REPORT test: the subject is whether the report
 * splits one account's lines by currency, not which workflow wrote them.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { incrementAccountSnapshot } from "./accounting/accountSnapshots";

/**
 * Posts one balanced journal the way the posting engine does.
 *
 * ⚠️ THE SNAPSHOT IS NOT OPTIONAL. `trialBalance` and `balanceSheet` do not
 * read journal lines at all when asked for the cumulative position — GL Phase
 * 18 made them read the running `accountBalanceSnapshots` instead. A fixture
 * that inserts only entries and lines is therefore INVISIBLE to exactly the two
 * reports this suite exists to test, and its assertions would fail against a
 * perfectly correct report. So this calls the same `incrementAccountSnapshot`
 * the engine calls, rather than reimplementing what it does.
 */
async function seedJournal(
  t: ReturnType<typeof convexTestWithComponents>,
  orgId: Id<"organizations">,
  userId: Id<"users">,
  opts: {
    currency: string;
    scale: number;
    memo: string;
    lines: Array<{ systemKey: string; debitMinor: number; creditMinor: number }>;
  }
) {
  await t.run(async (ctx) => {
    const now = Date.now();
    const periods = await ctx.db.query("accountingPeriods").collect();
    const period = periods.find((p) => p.orgId === orgId);
    if (!period) throw new Error("no accounting period was opened for this org");
    const journalEntryId = await ctx.db.insert("journalEntries", {
      orgId,
      periodId: period._id,
      journalNumber: `JRN-${opts.memo}`,
      accountingDate: now,
      sourceType: "manual",
      sourceId: opts.memo,
      category: "SYSTEM",
      memo: opts.memo,
      status: "POSTED",
      currency: opts.currency,
      postedBy: userId,
      postedAt: now,
      createdAt: now,
    });
    let lineNumber = 1;
    for (const line of opts.lines) {
      // Collected rather than indexed: `ReturnType<typeof
      // convexTestWithComponents>` drops the schema type parameter, so
      // `withIndex` has no table types to read. The seeded chart is small and
      // this matches how the suite's other cross-file helpers are typed.
      const accounts = await ctx.db.query("chartOfAccounts").collect();
      const account = accounts.find(
        (a) => a.orgId === orgId && a.systemKey === line.systemKey
      );
      if (!account) throw new Error(`account ${line.systemKey} was not initialized`);
      await ctx.db.insert("journalLines", {
        orgId,
        journalEntryId,
        lineNumber: lineNumber++,
        accountId: account._id,
        debitMinor: line.debitMinor,
        creditMinor: line.creditMinor,
        currency: opts.currency,
        scale: opts.scale,
        accountingDate: now,
      });
      await incrementAccountSnapshot(ctx as unknown as MutationCtx, {
        orgId,
        accountId: account._id,
        currency: opts.currency,
        periodId: period._id,
        debitMinor: line.debitMinor,
        creditMinor: line.creditMinor,
      });
    }
  });
}

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedMultiCurrencyDealer() {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Phase14 Dealer", createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "p14_owner", email: "p14owner@example.com", name: "Owner" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "Owner",
      permissions: ["view:finance", "manage:finance"],
      isSystemOwnerRole: true,
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"],
    })
  );

  const asOwner = t.withIdentity({ subject: "p14_owner", clerkId: "p14_owner" });

  await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asOwner.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await asOwner.query(api.accountingPeriods.list, { orgId }))[0];
  await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  // The same two postings the retired claim flow produced: money into the
  // bank against finance-company AR, once in each currency, on the SAME two
  // accounts. 750.000 JOD is 750_000 minor at scale 3; 500.00 USD is 50_000
  // minor at scale 2 — deliberately different scales, so a report that summed
  // raw minor units would be caught by the totals rather than flattered.
  await seedJournal(t, orgId, userId, {
    currency: "JOD",
    scale: 3,
    memo: "JOD-BANK-RECEIPT",
    lines: [
      { systemKey: "BANK_ACCOUNT", debitMinor: 750_000, creditMinor: 0 },
      { systemKey: "ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", debitMinor: 0, creditMinor: 750_000 },
    ],
  });
  await seedJournal(t, orgId, userId, {
    currency: "USD",
    scale: 2,
    memo: "USD-BANK-RECEIPT",
    lines: [
      { systemKey: "BANK_ACCOUNT", debitMinor: 50_000, creditMinor: 0 },
      { systemKey: "ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", debitMinor: 0, creditMinor: 50_000 },
    ],
  });

  return { t, orgId, userId, asOwner };
}

describe("Phase 14 — trial balance", () => {
  test("one account with lines in two currencies produces two rows, never one raw sum", async () => {
    const { asOwner, orgId } = await seedMultiCurrencyDealer();

    const tb = await asOwner.query(api.accountingReports.trialBalance, { orgId });

    const bankRows = tb.rows.filter((r) => r.code === "1110");
    expect(bankRows).toHaveLength(2);

    const jodRow = bankRows.find((r) => r.currency === "JOD");
    const usdRow = bankRows.find((r) => r.currency === "USD");
    expect(jodRow?.debitMinor).toBe(750_000);
    expect(usdRow?.debitMinor).toBe(50_000);
    // The forbidden behavior: 750_000 + 50_000 in a single row.
    expect(bankRows.some((r) => r.debitMinor === 800_000)).toBe(false);

    const jodTotals = tb.totalsByCurrency.find((c) => c.currency === "JOD");
    const usdTotals = tb.totalsByCurrency.find((c) => c.currency === "USD");
    expect(jodTotals?.isBalanced).toBe(true);
    expect(usdTotals?.isBalanced).toBe(true);
    expect(tb.isBalanced).toBe(true);

    // Legacy top-level totals are the org-currency (JOD) subtotal.
    expect(tb.totalDebits).toBe(jodTotals?.totalDebits);
    expect(tb.currency).toBe("JOD");
  });

  test("reporting-currency translation applies defined rates and reports missing ones", async () => {
    const { asOwner, orgId } = await seedMultiCurrencyDealer();

    // No USD→JOD rate defined yet: USD rows are flagged, not silently dropped.
    const untranslated = await asOwner.query(api.accountingReports.trialBalance, {
      orgId, reportingCurrency: "JOD",
    });
    expect(untranslated.missingRates).toContain("USD");

    await asOwner.mutation(api.exchangeRates.setRate, {
      orgId, fromCurrency: "USD", toCurrency: "JOD", rate: 0.709,
    });

    const tb = await asOwner.query(api.accountingReports.trialBalance, {
      orgId, reportingCurrency: "JOD",
    });
    expect(tb.missingRates).toHaveLength(0);

    const usdBankRow = tb.rows.find((r) => r.code === "1110" && r.currency === "USD");
    // 50_000 USD-minor × 0.709 × 10^(3−2) = 354_500 JOD-minor.
    expect(usdBankRow?.translatedNetMinor).toBe(354_500);

    const jodBankRow = tb.rows.find((r) => r.code === "1110" && r.currency === "JOD");
    expect(jodBankRow?.translatedNetMinor).toBe(jodBankRow?.netMinor);
  });
});

describe("Phase 14 — balance sheet", () => {
  test("per-currency subtotals each satisfy the balance-sheet equation", async () => {
    const { asOwner, orgId } = await seedMultiCurrencyDealer();

    const bs = await asOwner.query(api.accountingReports.balanceSheet, { orgId, asOfDate: Date.now() });

    expect(bs.totalsByCurrency.length).toBeGreaterThanOrEqual(2);
    for (const c of bs.totalsByCurrency) {
      expect(c.isBalanced).toBe(true);
    }
    expect(bs.isBalanced).toBe(true);

    const bankRows = bs.assetRows.filter((r) => r.code === "1110");
    expect(bankRows).toHaveLength(2);
    expect(new Set(bankRows.map((r) => r.currency))).toEqual(new Set(["JOD", "USD"]));

    // Top-level figures are the org-currency slice, not a cross-currency sum.
    const jod = bs.totalsByCurrency.find((c) => c.currency === "JOD");
    expect(bs.totalAssets).toBe(jod?.totalAssets);
  });
});

describe("Phase 14 — income statement", () => {
  test("P&L rows and subtotals split by currency", async () => {
    const { t, orgId, userId, asOwner } = await seedMultiCurrencyDealer();

    // A write-off in each currency, the postings a rejected claim used to
    // produce. Seeded directly for the reason given at the top of the file.
    await seedJournal(t, orgId, userId, {
      currency: "JOD",
      scale: 3,
      memo: "JOD-WRITE-OFF",
      lines: [
        { systemKey: "CLAIM_WRITE_OFF_EXPENSE", debitMinor: 120_000, creditMinor: 0 },
        { systemKey: "ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", debitMinor: 0, creditMinor: 120_000 },
      ],
    });
    await seedJournal(t, orgId, userId, {
      currency: "USD",
      scale: 2,
      memo: "USD-WRITE-OFF",
      lines: [
        { systemKey: "CLAIM_WRITE_OFF_EXPENSE", debitMinor: 9_900, creditMinor: 0 },
        { systemKey: "ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", debitMinor: 0, creditMinor: 9_900 },
      ],
    });

    const now = Date.now();
    const is = await asOwner.query(api.accountingReports.incomeStatement, {
      orgId, fromDate: now - 7 * 24 * 60 * 60 * 1000, toDate: now + 1000,
    });

    const writeOffRows = is.otherExpenseRows.filter((r) => r.code === "6700");
    expect(writeOffRows).toHaveLength(2);
    expect(writeOffRows.find((r) => r.currency === "JOD")?.netMinor).toBe(120_000);
    expect(writeOffRows.find((r) => r.currency === "USD")?.netMinor).toBe(9_900);

    const jod = is.totalsByCurrency.find((c) => c.currency === "JOD");
    const usd = is.totalsByCurrency.find((c) => c.currency === "USD");
    expect(jod?.totalOtherExpenses).toBe(120_000);
    expect(usd?.totalOtherExpenses).toBe(9_900);

    // Legacy top-level = org currency (JOD) only.
    expect(is.totalOtherExpenses).toBe(120_000);
  });
});
