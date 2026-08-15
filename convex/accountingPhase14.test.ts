/**
 * Phase 14 tests — multi-currency reporting correctness.
 *
 * Acceptance gates: journal lines in different currencies on one account are
 * never summed as raw minor units (per-currency rows + subtotals), and
 * single-currency orgs see no behavioral change (that half of the gate is
 * additionally enforced by accountingPhase5.test.ts, which runs the same
 * reports against a JOD-only org and still passes untouched).
 *
 * Multi-currency lines are produced through the manual-journal flow: journal
 * currency is resolved at approval from org settings, so flipping the org
 * currency between two journals yields JOD and USD postings on the same
 * accounts end-to-end, through the real posting engine.
 *
 * These were originally produced through the claim lifecycle, which SCRUM-51
 * retired (Claims was a second finance-company AR authority). The manual
 * journals below post the identical account movements — Dr Bank / Cr AR —
 * Finance Companies, and Dr Claim Write-off / Cr AR — Finance Companies — so
 * every assertion in this file is unchanged.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

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

  // A manual journal is posted by one finance user and approved by another
  // (segregation of duties is unbypassable for manual journals).
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "p14_approver", email: "p14approver@example.com", name: "Approver" })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));
  const asApprover = t.withIdentity({ subject: "p14_approver", clerkId: "p14_approver" });

  /**
   * Control accounts (Bank, AR) refuse manual posting in the default chart —
   * that control is covered by `manualJournalControlAccounts.test.ts`. This
   * file is about per-currency *reporting*, so the flag is relaxed here as seed
   * setup to get two-currency lines onto the exact accounts the assertions
   * below name.
   */
  async function accountId(systemKey: string) {
    const account = await t.run((ctx) =>
      ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", systemKey))
        .unique()
    );
    if (!account) throw new Error(`No account for systemKey ${systemKey}`);
    if (!account.allowManualPosting) {
      await t.run((ctx) => ctx.db.patch(account._id, { allowManualPosting: true }));
    }
    return account._id;
  }

  /** Posts Dr `debitKey` / Cr `creditKey` in whatever currency the org is on. */
  async function postJournal(key: string, debitKey: string, creditKey: string, amountMinor: number) {
    const draft = await asOwner.mutation(api.financialAudit.createManualJournal, {
      orgId,
      memo: `p14 ${key}`,
      idempotencyKey: `p14_${key}`,
      lines: [
        { accountId: await accountId(debitKey), debitMinor: amountMinor, creditMinor: 0 },
        { accountId: await accountId(creditKey), debitMinor: 0, creditMinor: amountMinor },
      ],
    });
    await asApprover.mutation(api.financialAudit.approveManualJournal, {
      orgId,
      draftId: draft.draftId,
    });
  }

  // JOD: 750.000 JOD = 750_000 minor (scale 3) into the bank.
  await postJournal("jod_bank", "BANK_ACCOUNT", "ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", 750_000);

  // Flip the org to USD, then post 500.00 USD = 50_000 minor (scale 2).
  await t.run((ctx) => ctx.db.patch(settingsId, { currency: "USD" }));
  await postJournal("usd_bank", "BANK_ACCOUNT", "ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", 50_000);

  // Restore JOD as the org (reporting) currency.
  await t.run((ctx) => ctx.db.patch(settingsId, { currency: "JOD" }));

  return { t, orgId, userId, asOwner, settingsId, postJournal };
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
    const { t, orgId, asOwner, settingsId, postJournal } = await seedMultiCurrencyDealer();

    // CLAIM_WRITE_OFF_EXPENSE (6700) needs lines in each currency.
    await postJournal("jod_writeoff", "CLAIM_WRITE_OFF_EXPENSE", "ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", 120_000);

    await t.run((ctx) => ctx.db.patch(settingsId, { currency: "USD" }));
    await postJournal("usd_writeoff", "CLAIM_WRITE_OFF_EXPENSE", "ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", 9_900);
    await t.run((ctx) => ctx.db.patch(settingsId, { currency: "JOD" }));

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
