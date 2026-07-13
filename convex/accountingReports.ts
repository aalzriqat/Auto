/**
 * Phase 5 — Ledger-backed financial reports
 *
 * All reports are computed from posted journalLines (the GL), not from the
 * legacy transactions table.  Reports only include POSTED journal entries.
 */
import { v } from "convex/values";
import { query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { QueryCtx } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { fromMinorUnits, scaleForCurrency } from "./utils/money";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import { requireFeature } from "./subscriptions";
import { getCumulativeBalancesAsOf } from "./accounting/accountSnapshots";

/**
 * GL Phase 14 note on aggregation: every aggregate below keys on
 * (accountId, line.currency), never accountId alone — minor units in
 * different currencies are different units and must not be summed. For a
 * single-currency org this collapses to exactly the pre-Phase-14 output.
 * The legacy top-level totals are kept as the org-currency subtotal, with
 * the full picture in totalsByCurrency.
 */
function currencyKey(accountId: string, currency: string): string {
  return `${accountId}__${currency}`;
}

/**
 * Latest defined rate for from→to at or before asOf. Direction is explicit:
 * a JOD→USD rate does not imply USD→JOD.
 */
async function getLatestRate(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  fromCurrency: string,
  toCurrency: string,
  asOf: number
): Promise<number | null> {
  const rate = await ctx.db
    .query("exchangeRates")
    .withIndex("by_org_pair", (q) =>
      q.eq("orgId", orgId).eq("fromCurrency", fromCurrency).eq("toCurrency", toCurrency).lte("asOfDate", asOf)
    )
    .order("desc")
    .first();
  return rate?.rate ?? null;
}

/** Display-only translation — books never convert. Scale shift keeps the result in the target currency's minor units. */
function translateMinor(amountMinor: number, rate: number, fromCurrency: string, toCurrency: string): number {
  return Math.round(amountMinor * rate * Math.pow(10, scaleForCurrency(toCurrency) - scaleForCurrency(fromCurrency)));
}

/** Resolve the organization's display currency (defaults to JOD). */
async function getOrgCurrencyForReports(ctx: QueryCtx, orgId: Id<"organizations">): Promise<string> {
  const settings = await ctx.db
    .query("orgSettings")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
  return settings?.currency ?? "JOD";
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

export async function getPostedLines(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  fromDate?: number,
  toDate?: number
) {
  // Include REVERSED entries too, not just POSTED ones: a reversed entry's
  // own lines are still real, immutable historical postings — its status
  // just means a *separate*, independently-posted reversal entry later
  // cancelled it out. Excluding it here would keep the reversal's inverted
  // lines while silently dropping the original half of the pair, turning a
  // net-zero cancellation into a one-sided, wrong balance.
  const entries = await ctx.db
    .query("journalEntries")
    .withIndex("by_org_date", (q) => q.eq("orgId", orgId))
    .filter((q) => q.or(q.eq(q.field("status"), "POSTED"), q.eq(q.field("status"), "REVERSED")))
    .collect();

  const entryIds = new Set(entries.map((e) => e._id));

  const allLines = await ctx.db
    .query("journalLines")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .filter((q) => {
      const afterFrom = fromDate !== undefined ? q.gte(q.field("accountingDate"), fromDate) : q.neq(q.field("accountingDate"), -1);
      const beforeTo = toDate !== undefined ? q.lte(q.field("accountingDate"), toDate) : q.neq(q.field("accountingDate"), -1);
      return q.and(afterFrom, beforeTo);
    })
    .collect();

  return allLines.filter((l) => entryIds.has(l.journalEntryId));
}

// ─── Trial Balance ────────────────────────────────────────────────────────────

export const trialBalance = query({
  args: {
    orgId: v.id("organizations"),
    fromDate: v.optional(v.number()),
    toDate: v.optional(v.number()),
    // Optional display translation through org-defined exchange rates.
    reportingCurrency: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    // Include all accounts (active and inactive) so historical postings on
    // deactivated accounts still appear in the trial balance.
    const accounts = await ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    const accountMap = new Map(accounts.map((a) => [a._id as string, a]));

    const orgCurrency = await getOrgCurrencyForReports(ctx, args.orgId);

    const totals = new Map<string, { accountId: string; currency: string; debitMinor: number; creditMinor: number }>();
    if (args.fromDate === undefined) {
      // GL Phase 18: the common case (cumulative since inception through
      // toDate, which is what "trial balance" conventionally means) reads
      // running snapshots instead of collecting every journal line ever
      // posted.
      const balances = await getCumulativeBalancesAsOf(ctx, args.orgId, args.toDate ?? Date.now());
      for (const b of balances) {
        totals.set(currencyKey(b.accountId, b.currency), { accountId: b.accountId, currency: b.currency, debitMinor: b.debitMinor, creditMinor: b.creditMinor });
      }
    } else {
      // A two-sided bounded range isn't a snapshot-as-of computation (it
      // would need snapshot(toDate) − snapshot(justBeforeFromDate)); kept as
      // the original full scan since this is a non-standard trial-balance
      // shape, not the path the acceptance gate targets.
      const lines = await getPostedLines(ctx, args.orgId, args.fromDate, args.toDate);
      for (const line of lines) {
        const key = currencyKey(line.accountId, line.currency);
        const existing = totals.get(key) ?? { accountId: line.accountId as string, currency: line.currency, debitMinor: 0, creditMinor: 0 };
        existing.debitMinor += line.debitMinor;
        existing.creditMinor += line.creditMinor;
        totals.set(key, existing);
      }
    }

    const reportingCurrency = args.reportingCurrency?.toUpperCase();
    const rateAsOf = args.toDate ?? Date.now();
    const missingRates = new Set<string>();

    const rows = [];
    for (const t of totals.values()) {
      const account = accountMap.get(t.accountId);
      if (!account) continue;
      if (t.debitMinor === 0 && t.creditMinor === 0) continue;
      const netMinor = account.normalBalance === "DEBIT"
        ? t.debitMinor - t.creditMinor
        : t.creditMinor - t.debitMinor;

      let translatedNetMinor: number | undefined;
      if (reportingCurrency) {
        if (t.currency === reportingCurrency) {
          translatedNetMinor = netMinor;
        } else {
          const rate = await getLatestRate(ctx, args.orgId, t.currency, reportingCurrency, rateAsOf);
          if (rate === null) missingRates.add(t.currency);
          else translatedNetMinor = translateMinor(netMinor, rate, t.currency, reportingCurrency);
        }
      }

      rows.push({
        accountId: account._id,
        code: account.code,
        name: account.name,
        nameAr: account.nameAr,
        type: account.type,
        normalBalance: account.normalBalance,
        debitMinor: t.debitMinor,
        creditMinor: t.creditMinor,
        netMinor,
        currency: t.currency,
        netDisplay: fromMinorUnits(netMinor, t.currency),
        translatedNetMinor,
      });
    }
    rows.sort((a, b) => a.code.localeCompare(b.code) || a.currency.localeCompare(b.currency));

    const byCurrency = new Map<string, { totalDebits: number; totalCredits: number }>();
    for (const r of rows) {
      const c = byCurrency.get(r.currency) ?? { totalDebits: 0, totalCredits: 0 };
      c.totalDebits += r.debitMinor;
      c.totalCredits += r.creditMinor;
      byCurrency.set(r.currency, c);
    }
    const totalsByCurrency = Array.from(byCurrency.entries()).map(([currency, c]) => ({
      currency,
      totalDebits: c.totalDebits,
      totalCredits: c.totalCredits,
      isBalanced: c.totalDebits === c.totalCredits,
    }));

    // Legacy top-level totals = the org-currency subtotal (identical output
    // for single-currency orgs); isBalanced demands EVERY currency balances.
    const orgTotals = byCurrency.get(orgCurrency) ?? { totalDebits: 0, totalCredits: 0 };
    return {
      rows,
      totalDebits: orgTotals.totalDebits,
      totalCredits: orgTotals.totalCredits,
      isBalanced: totalsByCurrency.every((c) => c.isBalanced),
      currency: orgCurrency,
      totalsByCurrency,
      reportingCurrency: reportingCurrency ?? null,
      missingRates: Array.from(missingRates),
    };
  },
});

// ─── Income Statement (P&L) ───────────────────────────────────────────────────

export const incomeStatement = query({
  args: {
    orgId: v.id("organizations"),
    fromDate: v.number(),
    toDate: v.number(),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const accounts = await ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    const lines = await getPostedLines(ctx, args.orgId, args.fromDate, args.toDate);
    const orgCurrency = await getOrgCurrencyForReports(ctx, args.orgId);

    const accountMap = new Map(accounts.map((a) => [a._id as string, a]));
    const totals = new Map<string, { accountId: string; currency: string; netMinor: number }>();

    for (const line of lines) {
      const account = accountMap.get(line.accountId);
      if (!account) continue;
      const type = account.type;
      if (!["REVENUE", "COGS", "EXPENSE", "OTHER_INCOME", "OTHER_EXPENSE"].includes(type)) continue;

      const key = currencyKey(line.accountId, line.currency);
      const existing = totals.get(key) ?? { accountId: line.accountId as string, currency: line.currency, netMinor: 0 };
      existing.netMinor += account.normalBalance === "CREDIT"
        ? line.creditMinor - line.debitMinor
        : line.debitMinor - line.creditMinor;
      totals.set(key, existing);
    }

    const rowsFor = (type: string) => {
      const rows = [];
      for (const t of totals.values()) {
        const account = accountMap.get(t.accountId);
        if (!account || account.type !== type || t.netMinor === 0) continue;
        rows.push({
          accountId: account._id, code: account.code, name: account.name, nameAr: account.nameAr,
          type: account.type, netMinor: t.netMinor, currency: t.currency,
        });
      }
      rows.sort((a, b) => a.code.localeCompare(b.code) || a.currency.localeCompare(b.currency));
      return rows;
    };

    const sumFor = (type: string, currency: string) => {
      let sum = 0;
      for (const t of totals.values()) {
        const account = accountMap.get(t.accountId);
        if (account && account.type === type && t.currency === currency) sum += t.netMinor;
      }
      return sum;
    };

    const currencies = Array.from(new Set(Array.from(totals.values()).map((t) => t.currency)));
    if (!currencies.includes(orgCurrency)) currencies.push(orgCurrency);

    const totalsByCurrency = currencies.map((currency) => {
      const totalRevenue = sumFor("REVENUE", currency);
      const totalCogs = sumFor("COGS", currency);
      const grossProfit = totalRevenue - totalCogs;
      const totalExpenses = sumFor("EXPENSE", currency);
      const totalOtherIncome = sumFor("OTHER_INCOME", currency);
      const totalOtherExpenses = sumFor("OTHER_EXPENSE", currency);
      return {
        currency, totalRevenue, totalCogs, grossProfit, totalExpenses, totalOtherIncome, totalOtherExpenses,
        netIncome: grossProfit - totalExpenses + totalOtherIncome - totalOtherExpenses,
      };
    });

    // Legacy top-level figures = org-currency subtotal (unchanged for
    // single-currency orgs); other currencies live in totalsByCurrency.
    const org = totalsByCurrency.find((c) => c.currency === orgCurrency)!;

    return {
      revenueRows: rowsFor("REVENUE"),
      cogsRows: rowsFor("COGS"),
      expenseRows: rowsFor("EXPENSE"),
      otherIncomeRows: rowsFor("OTHER_INCOME"),
      otherExpenseRows: rowsFor("OTHER_EXPENSE"),
      totalRevenue: org.totalRevenue,
      totalCogs: org.totalCogs,
      grossProfit: org.grossProfit,
      totalExpenses: org.totalExpenses,
      totalOtherIncome: org.totalOtherIncome,
      totalOtherExpenses: org.totalOtherExpenses,
      netIncome: org.netIncome,
      currency: orgCurrency,
      totalsByCurrency,
    };
  },
});

// ─── Balance Sheet ────────────────────────────────────────────────────────────

export const balanceSheet = query({
  args: {
    orgId: v.id("organizations"),
    asOfDate: v.number(),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const accounts = await ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    // GL Phase 18: sums running snapshots for every fully-elapsed period plus
    // a bounded scan of just the containing period's own entries, instead of
    // collecting every journal line the org has ever posted.
    const balances = await getCumulativeBalancesAsOf(ctx, args.orgId, args.asOfDate);
    const orgCurrency = await getOrgCurrencyForReports(ctx, args.orgId);

    const accountMap = new Map(accounts.map((a) => [a._id as string, a]));
    const totals = new Map<string, { accountId: string; currency: string; netMinor: number }>();

    // Net balance per (account, currency) — all types, P&L included for net income.
    for (const balance of balances) {
      const account = accountMap.get(balance.accountId);
      if (!account) continue;
      if (balance.debitMinor === 0 && balance.creditMinor === 0) continue;
      const key = currencyKey(balance.accountId, balance.currency);
      const netMinor = account.normalBalance === "DEBIT"
        ? balance.debitMinor - balance.creditMinor
        : balance.creditMinor - balance.debitMinor;
      totals.set(key, { accountId: balance.accountId, currency: balance.currency, netMinor });
    }

    const rowsFor = (type: string) => {
      const rows = [];
      for (const t of totals.values()) {
        const account = accountMap.get(t.accountId);
        if (!account || account.type !== type || t.netMinor === 0) continue;
        rows.push({
          accountId: account._id, code: account.code, name: account.name, nameAr: account.nameAr,
          type: account.type, netMinor: t.netMinor, currency: t.currency,
        });
      }
      rows.sort((a, b) => a.code.localeCompare(b.code) || a.currency.localeCompare(b.currency));
      return rows;
    };

    const assetRows = rowsFor("ASSET");
    const liabilityRows = rowsFor("LIABILITY");
    const equityRows = rowsFor("EQUITY");

    const currencies = Array.from(new Set(Array.from(totals.values()).map((t) => t.currency)));
    if (!currencies.includes(orgCurrency)) currencies.push(orgCurrency);

    const totalsByCurrency = currencies.map((currency) => {
      let totalAssets = 0, totalLiabilities = 0, totalEquity = 0, netIncomeMinor = 0;
      for (const t of totals.values()) {
        if (t.currency !== currency) continue;
        const account = accountMap.get(t.accountId);
        if (!account) continue;
        if (account.type === "ASSET") totalAssets += t.netMinor;
        else if (account.type === "LIABILITY") totalLiabilities += t.netMinor;
        else if (account.type === "EQUITY") totalEquity += t.netMinor;
        else if (account.type === "REVENUE" || account.type === "OTHER_INCOME") netIncomeMinor += t.netMinor;
        else if (account.type === "COGS" || account.type === "EXPENSE" || account.type === "OTHER_EXPENSE") netIncomeMinor -= t.netMinor;
      }
      return {
        currency, totalAssets, totalLiabilities, totalEquity, netIncomeMinor,
        // Assets = Liabilities + Equity + Current-period Net Income (pre-close)
        isBalanced: totalAssets === totalLiabilities + totalEquity + netIncomeMinor,
      };
    });

    // Legacy top-level figures = org-currency subtotal; the equation must
    // hold in EVERY currency for the sheet to count as balanced.
    const org = totalsByCurrency.find((c) => c.currency === orgCurrency)!;

    return {
      assetRows, liabilityRows, equityRows,
      totalAssets: org.totalAssets,
      totalLiabilities: org.totalLiabilities,
      totalEquity: org.totalEquity,
      netIncomeMinor: org.netIncomeMinor,
      isBalanced: totalsByCurrency.every((c) => c.isBalanced),
      currency: orgCurrency,
      totalsByCurrency,
    };
  },
});

// ─── AR Aging ─────────────────────────────────────────────────────────────────

type AgingBuckets = { current: number; days30: number; days60: number; days90: number; over90: number };
type AgingRow = {
  receivableId: string;
  customerId: string | undefined;
  dueDate: number;
  originalAmountMinor: number;
  outstandingMinor: number;
  ageDays: number;
  bucket: string;
};

export const arAging = query({
  args: {
    orgId: v.id("organizations"),
    asOfDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const asOfDate = args.asOfDate ?? Date.now();

    // Scan every receivable issued on or before asOfDate regardless of its
    // CURRENT status — a receivable that was open as of asOfDate but has since
    // been fully paid must still appear in a historical report; filtering by
    // by_org_status (current status) would make it invisible. "Outstanding as
    // of asOfDate" is instead derived purely from allocations that themselves
    // existed by that date (below), which is what actually makes this correct.
    const allReceivables = await ctx.db
      .query("receivableDocuments")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.lte(q.field("issueDate"), asOfDate))
      .collect();

    const byCurrency = new Map<string, { buckets: AgingBuckets; rows: AgingRow[] }>();

    for (const rec of allReceivables) {
      // Only count allocations that existed as of asOfDate — an allocation
      // (or reversal) made after asOfDate must not affect a historical figure.
      const activeAllocations = await ctx.db
        .query("paymentAllocations")
        .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", rec._id))
        .filter((q) =>
          q.and(
            q.eq(q.field("status"), "ACTIVE"),
            q.lte(q.field("createdAt"), asOfDate)
          )
        )
        .collect();
      const allocated = activeAllocations.reduce((s, a) => s + a.amountMinor, 0);
      const outstanding = Math.max(0, rec.originalAmountMinor - allocated);
      if (outstanding === 0) continue;

      const ageDays = Math.floor((asOfDate - rec.dueDate) / 86400_000);
      let bucket: keyof AgingBuckets;
      if (ageDays <= 0) { bucket = "current"; }
      else if (ageDays <= 30) { bucket = "days30"; }
      else if (ageDays <= 60) { bucket = "days60"; }
      else if (ageDays <= 90) { bucket = "days90"; }
      else { bucket = "over90"; }

      const entry = byCurrency.get(rec.currency) ?? {
        buckets: { current: 0, days30: 0, days60: 0, days90: 0, over90: 0 },
        rows: [],
      };
      entry.buckets[bucket] += outstanding;
      entry.rows.push({
        receivableId: rec._id,
        customerId: rec.customerId?.toString(),
        dueDate: rec.dueDate,
        originalAmountMinor: rec.originalAmountMinor,
        outstandingMinor: outstanding,
        ageDays,
        bucket,
      });
      byCurrency.set(rec.currency, entry);
    }

    // Different currencies' minor units (e.g. JOD fils vs USD cents) are never
    // summed together — each currency gets its own bucket set and total.
    const currencies = [...byCurrency.keys()].sort();
    return {
      currencies,
      byCurrency: Object.fromEntries(
        currencies.map((currency) => {
          const entry = byCurrency.get(currency)!;
          return [
            currency,
            {
              rows: entry.rows,
              buckets: entry.buckets,
              totalOutstandingMinor: Object.values(entry.buckets).reduce((s, v) => s + v, 0),
            },
          ];
        })
      ),
    };
  },
});

// ─── Subledger-to-GL Reconciliation ──────────────────────────────────────────

export type SubledgerReconciliationResult = {
  currencies: string[];
  byCurrency: Record<
    string,
    { glArBalanceMinor: number; subledgerOutstandingMinor: number; discrepancyMinor: number; isReconciled: boolean }
  >;
  isReconciled: boolean;
};

/**
 * Shared with accountingPeriods.ts's close-checklist, which needs the same
 * AR-vs-GL check as of a period's end date without duplicating the logic.
 */
export async function computeSubledgerReconciliation(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  toDate: number | undefined
): Promise<SubledgerReconciliationResult> {
    // GL total for AR accounts — cumulative from inception to toDate so the
    // basis matches the subledger outstanding balance (not period movement).
    const accounts = await ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org_type", (q) => q.eq("orgId", orgId).eq("type", "ASSET"))
      .filter((q) => q.neq(q.field("systemKey"), null))
      .collect();

    const arAccountIds = new Set(accounts.filter((a) =>
      a.systemKey === SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS ||
      a.systemKey === SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES
    ).map((a) => a._id));

    const lines = await getPostedLines(ctx, orgId, undefined, toDate);
    const arLines = lines.filter((l) => arAccountIds.has(l.accountId));
    // Never sum minor units across currencies (JOD fils + USD cents is not a
    // meaningful number) — accumulate each currency's GL balance separately.
    const glByCurrency = new Map<string, number>();
    for (const l of arLines) {
      glByCurrency.set(l.currency, (glByCurrency.get(l.currency) ?? 0) + l.debitMinor - l.creditMinor);
    }

    // Subledger total — scan every receivable issued on or before toDate
    // regardless of its CURRENT status, same reasoning as arAging: a
    // receivable open as of toDate but since fully paid must still count.
    const effectiveAsOf = toDate ?? Date.now();
    const allRecs = await ctx.db
      .query("receivableDocuments")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .filter((q) => q.lte(q.field("issueDate"), effectiveAsOf))
      .collect();

    const subByCurrency = new Map<string, number>();
    for (const rec of allRecs) {
      const activeAllocations = await ctx.db
        .query("paymentAllocations")
        .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", rec._id))
        .filter((q) =>
          q.and(
            q.eq(q.field("status"), "ACTIVE"),
            q.lte(q.field("createdAt"), effectiveAsOf)
          )
        )
        .collect();
      const allocated = activeAllocations.reduce((s, a) => s + a.amountMinor, 0);
      const outstanding = Math.max(0, rec.originalAmountMinor - allocated);
      subByCurrency.set(rec.currency, (subByCurrency.get(rec.currency) ?? 0) + outstanding);
    }

    const currencies = [...new Set([...glByCurrency.keys(), ...subByCurrency.keys()])].sort();
    const byCurrency = Object.fromEntries(
      currencies.map((currency) => {
        const glArBalanceMinor = glByCurrency.get(currency) ?? 0;
        const subledgerOutstandingMinor = subByCurrency.get(currency) ?? 0;
        const discrepancyMinor = glArBalanceMinor - subledgerOutstandingMinor;
        return [currency, { glArBalanceMinor, subledgerOutstandingMinor, discrepancyMinor, isReconciled: discrepancyMinor === 0 }];
      })
    );

    return {
      currencies,
      byCurrency,
      isReconciled: currencies.every((c) => byCurrency[c].isReconciled),
    };
}

export const subledgerReconciliation = query({
  args: {
    orgId: v.id("organizations"),
    // No fromDate: both sides are cumulative balances from inception to toDate
    // (not period movement), so a "from" bound has no meaningful effect here —
    // a prior version accepted one but silently ignored it, which is worse
    // than not accepting it at all.
    toDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    return computeSubledgerReconciliation(ctx, args.orgId, args.toDate);
  },
});
