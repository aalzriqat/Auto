/**
 * Phase 14 tests — multi-currency reporting correctness.
 *
 * Acceptance gates: journal lines in different currencies on one account are
 * never summed as raw minor units (per-currency rows + subtotals), and
 * single-currency orgs see no behavioral change (that half of the gate is
 * additionally enforced by accountingPhase5.test.ts, which runs the same
 * reports against a JOD-only org and still passes untouched).
 *
 * Multi-currency lines are produced through a real domain flow: claim
 * currency is captured at creation from org settings, so flipping the org
 * currency between two claims yields JOD and USD postings on the same
 * accounts end-to-end.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedMultiCurrencyDealer() {
  const t = convexTest(schema, MODULE_GLOB);
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
  const settingsId = await t.run((ctx) =>
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

  // JOD claim: 750.000 JOD = 750_000 minor (scale 3), settled to the bank.
  const jodClaim = await asOwner.mutation(api.claims.add, {
    orgId, claimDate: Date.now(), financingEntity: "JOD FC", buyerName: "A", claimAmountMinor: 750_000,
  });
  await asOwner.mutation(api.claims.settle, { orgId, claimId: jodClaim, paymentMethod: "BANK_TRANSFER" });

  // Flip the org to USD, then a USD claim: 500.00 USD = 50_000 minor (scale 2).
  await t.run((ctx) => ctx.db.patch(settingsId, { currency: "USD" }));
  const usdClaim = await asOwner.mutation(api.claims.add, {
    orgId, claimDate: Date.now(), financingEntity: "USD FC", buyerName: "B", claimAmountMinor: 50_000,
  });
  await asOwner.mutation(api.claims.settle, { orgId, claimId: usdClaim, paymentMethod: "BANK_TRANSFER" });

  // Restore JOD as the org (reporting) currency.
  await t.run((ctx) => ctx.db.patch(settingsId, { currency: "JOD" }));

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
    const { t, orgId, asOwner } = await seedMultiCurrencyDealer();

    // A rejected claim posts CLAIM_WRITE_OFF_EXPENSE — do one in each currency.
    const jodClaim = await asOwner.mutation(api.claims.add, {
      orgId, claimDate: Date.now(), financingEntity: "JOD FC", buyerName: "C", claimAmountMinor: 120_000,
    });
    await asOwner.mutation(api.claims.reject, { orgId, claimId: jodClaim });

    const settings = await t.run(async (ctx) =>
      (await ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique())!
    );
    await t.run((ctx) => ctx.db.patch(settings._id, { currency: "USD" }));
    const usdClaim = await asOwner.mutation(api.claims.add, {
      orgId, claimDate: Date.now(), financingEntity: "USD FC", buyerName: "D", claimAmountMinor: 9_900,
    });
    await asOwner.mutation(api.claims.reject, { orgId, claimId: usdClaim });
    await t.run((ctx) => ctx.db.patch(settings._id, { currency: "JOD" }));

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
