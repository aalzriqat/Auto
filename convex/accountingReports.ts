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
import { fromMinorUnits, scaleForCurrency, toMinorUnits } from "./utils/money";
import { SYSTEM_KEYS, SystemKey } from "./utils/defaultChart";
import { requireFeature } from "./subscriptions";
import { getCumulativeBalancesAsOf } from "./accounting/accountSnapshots";
import { computeVehicleCapitalizedCost } from "./utils/vehicleCost";
import { recognizedDueThroughDateMinor } from "./utils/expenseAmortization";

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

/**
 * Allocated amount as of a historical date, for every receivable in the org
 * at once. Reversing an allocation patches the original row's status to
 * REVERSED (in place) and inserts a separate marker row for the reversal —
 * so filtering live rows by `status === "ACTIVE"` reflects only the CURRENT
 * state, not the state as of an arbitrary past date. An allocation active on
 * asOfDate but reversed after it must still count; one reversed before
 * asOfDate must not.
 *
 * Scans `paymentAllocations` once per report call (via the `by_org` index)
 * instead of once per receivable — the previous per-receivable `by_receivable`
 * query was an N+1 that degrades on orgs with a large receivable history.
 */
async function getAllocatedAsOfByReceivable(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  asOfDate: number
): Promise<Map<string, number>> {
  const allAllocations = await ctx.db
    .query("paymentAllocations")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();

  const reversedAtByOriginal = new Map<string, number>();
  for (const a of allAllocations) {
    if (a.reversalOfAllocationId) {
      reversedAtByOriginal.set(a.reversalOfAllocationId, a.createdAt);
    }
  }

  const allocatedByReceivable = new Map<string, number>();
  for (const a of allAllocations) {
    if (a.reversalOfAllocationId) continue; // marker row, not an original allocation
    if (a.createdAt > asOfDate) continue; // didn't exist yet as of the date
    const reversedAt = reversedAtByOriginal.get(a._id);
    if (reversedAt !== undefined && reversedAt <= asOfDate) continue; // reversed by then
    const key = a.receivableDocumentId;
    allocatedByReceivable.set(key, (allocatedByReceivable.get(key) ?? 0) + a.amountMinor);
  }
  return allocatedByReceivable;
}

/**
 * Receivables issued on or before asOfDate that had NOT yet been cancelled as
 * of that date. Cancellation reverses a receivable's allocations (so
 * getAllocatedAsOfByReceivable stops counting them from cancelledAt onward),
 * but without also excluding the receivable itself here, it would reappear
 * as fully outstanding for every asOfDate on/after cancellation — even though
 * the GL side was already zeroed out by the same cancellation's reversal
 * journal (hookSaleCancelled). A receivable cancelled AFTER asOfDate must
 * still count, exactly like the CURRENT-status independence documented above
 * for arAging/subledgerReconciliation — only whether it was cancelled BY
 * asOfDate matters.
 */
async function getReceivablesAsOf(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  asOfDate: number
) {
  return await ctx.db
    .query("receivableDocuments")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .filter((q) =>
      q.and(
        q.lte(q.field("issueDate"), asOfDate),
        q.or(q.eq(q.field("cancelledAt"), undefined), q.gt(q.field("cancelledAt"), asOfDate))
      )
    )
    .collect();
}

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
    // The one exception is cancellation (getReceivablesAsOf) — a cancelled
    // receivable's reversed allocations stop counting as of cancelledAt, so
    // the receivable itself must also stop counting from cancelledAt onward,
    // or it would reappear as fully outstanding forever after cancellation.
    const allReceivables = await getReceivablesAsOf(ctx, args.orgId, asOfDate);
    const allocatedByReceivable = await getAllocatedAsOfByReceivable(ctx, args.orgId, asOfDate);

    const byCurrency = new Map<string, { buckets: AgingBuckets; rows: AgingRow[] }>();

    for (const rec of allReceivables) {
      const allocated = allocatedByReceivable.get(rec._id) ?? 0;
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
    const currencies = [...byCurrency.keys()].sort((a, b) => a.localeCompare(b));
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
    // receivable open as of toDate but since fully paid must still count
    // (and one cancelled by toDate must not — see getReceivablesAsOf).
    const effectiveAsOf = toDate ?? Date.now();
    const allRecs = await getReceivablesAsOf(ctx, orgId, effectiveAsOf);
    const allocatedByReceivable = await getAllocatedAsOfByReceivable(ctx, orgId, effectiveAsOf);

    const subByCurrency = new Map<string, number>();
    for (const rec of allRecs) {
      const allocated = allocatedByReceivable.get(rec._id) ?? 0;
      const outstanding = Math.max(0, rec.originalAmountMinor - allocated);
      subByCurrency.set(rec.currency, (subByCurrency.get(rec.currency) ?? 0) + outstanding);
    }

    const currencies = [...new Set([...glByCurrency.keys(), ...subByCurrency.keys()])].sort((a, b) => a.localeCompare(b));
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

// ─── Additional GL-vs-subledger reconciliation reports ────────────────────────
//
// These four cover the remaining subledgers that only have one side of the
// picture today (a subledger table but no GL comparison): Vehicle Inventory,
// AP-Suppliers, Customer Deposits Liability, and Commission Payable. Unlike
// arAging/subledgerReconciliation above, the subledger side here reflects
// CURRENT state, not a point-in-time reconstruction as of `toDate` — none of
// these four track historical state changes (e.g. a vehicle's status history
// isn't recorded), so building that rigor isn't possible without new audit
// tables. `toDate` only bounds the GL side; for the common case (an
// unspecified toDate, defaulting to now) both sides line up exactly. These
// are informational reports for the accountant to check manually — not
// period-close blockers.

export type GlVsSubledgerResult = {
  currencies: string[];
  byCurrency: Record<
    string,
    { glBalanceMinor: number; subledgerBalanceMinor: number; discrepancyMinor: number; isReconciled: boolean }
  >;
  isReconciled: boolean;
};

async function computeGlBalanceByCurrency(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  systemKey: SystemKey,
  toDate: number | undefined
): Promise<Map<string, number>> {
  const account = await ctx.db
    .query("chartOfAccounts")
    .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", systemKey))
    .unique();

  const glByCurrency = new Map<string, number>();
  if (!account) return glByCurrency;

  const lines = (await getPostedLines(ctx, orgId, undefined, toDate)).filter((l) => l.accountId === account._id);
  for (const l of lines) {
    const delta = account.normalBalance === "DEBIT" ? l.debitMinor - l.creditMinor : l.creditMinor - l.debitMinor;
    glByCurrency.set(l.currency, (glByCurrency.get(l.currency) ?? 0) + delta);
  }
  return glByCurrency;
}

function combineGlAndSubledger(
  glByCurrency: Map<string, number>,
  subByCurrency: Map<string, number>
): GlVsSubledgerResult {
  const currencies = [...new Set([...glByCurrency.keys(), ...subByCurrency.keys()])].sort((a, b) => a.localeCompare(b));
  const byCurrency = Object.fromEntries(
    currencies.map((currency) => {
      const glBalanceMinor = glByCurrency.get(currency) ?? 0;
      const subledgerBalanceMinor = subByCurrency.get(currency) ?? 0;
      const discrepancyMinor = glBalanceMinor - subledgerBalanceMinor;
      return [currency, { glBalanceMinor, subledgerBalanceMinor, discrepancyMinor, isReconciled: discrepancyMinor === 0 }];
    })
  );
  return { currencies, byCurrency, isReconciled: currencies.every((c) => byCurrency[c].isReconciled) };
}

/**
 * Shared with accountingPeriods.ts's close-checklist, same reason as
 * computeSubledgerReconciliation above.
 */
export async function computeVehicleInventoryReconciliation(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  toDate: number | undefined
): Promise<GlVsSubledgerResult> {
  const orgCurrency = await getOrgCurrencyForReports(ctx, orgId);
  const vehicles = await ctx.db
    .query("vehicles")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
  // Sourced/drop-ship vehicles never capitalize into Vehicle Inventory
  // (ruleSaleCompleted credits AP-Suppliers for them instead) — excluding
  // status SOLD/ARCHIVED leaves everything still physically in stock.
  const inStock = vehicles.filter((v) =>
    !v.isDeleted && v.sourceType !== "SOURCED" && v.status !== "SOLD" && v.status !== "ARCHIVED"
  );

  let subledgerMinor = 0;
  for (const vehicle of inStock) {
    const cost = await computeVehicleCapitalizedCost(ctx, vehicle);
    if (cost > 0) subledgerMinor += toMinorUnits(cost, orgCurrency);
  }

  const subByCurrency = new Map<string, number>();
  if (subledgerMinor > 0) subByCurrency.set(orgCurrency, subledgerMinor);

  const glByCurrency = await computeGlBalanceByCurrency(ctx, orgId, SYSTEM_KEYS.VEHICLE_INVENTORY, toDate);
  return combineGlAndSubledger(glByCurrency, subByCurrency);
}

export const vehicleInventoryReconciliation = query({
  args: { orgId: v.id("organizations"), toDate: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    return computeVehicleInventoryReconciliation(ctx, args.orgId, args.toDate);
  },
});

/**
 * Prepaid Expenses asset (GL) vs the unamortized remainder of every ACTIVE
 * prepaid schedule (subledger). Like the other four here the subledger side is
 * CURRENT state, so this is an informational report / close warning, not a
 * close blocker — but for a clean books it should be zero-discrepancy.
 */
export async function computePrepaidExpensesReconciliation(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  toDate: number | undefined
): Promise<GlVsSubledgerResult> {
  const active = await ctx.db
    .query("prepaidExpenseSchedules")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .filter((q) => q.eq(q.field("status"), "ACTIVE"))
    .collect();

  const subByCurrency = new Map<string, number>();
  for (const s of active) {
    const remaining = Math.max(s.totalMinor - s.recognizedMinor, 0);
    if (remaining > 0) subByCurrency.set(s.currency, (subByCurrency.get(s.currency) ?? 0) + remaining);
  }

  const glByCurrency = await computeGlBalanceByCurrency(ctx, orgId, SYSTEM_KEYS.PREPAID_EXPENSES, toDate);
  return combineGlAndSubledger(glByCurrency, subByCurrency);
}

export const prepaidExpensesReconciliation = query({
  args: { orgId: v.id("organizations"), toDate: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    return computePrepaidExpensesReconciliation(ctx, args.orgId, args.toDate);
  },
});

export type PrepaidRecognitionShortfallResult = {
  hasShortfall: boolean;
  scheduleCount: number; // schedules that are behind as of the date
  byCurrency: Record<string, number>; // unrecognized-but-due minor units, per currency
};

/**
 * How much prepaid recognition is DUE through `asOfDate` but has not yet been
 * recognized on the subledger. Unlike prepaidExpensesReconciliation (a
 * remaining-vs-GL current-state check that a stalled schedule still passes
 * because the GL and subledger fall behind together), this compares each
 * schedule's authoritative "should have recognized by now" figure against what
 * it actually has — so it catches a schedule the monthly cron never advanced
 * (e.g. an expense paid mid-period, with the period closed before the next
 * cron run). A positive shortfall means the period's P&L is missing expense
 * that belongs in it, which is a genuine books error, not a timing artifact —
 * hence a close BLOCKER rather than a warning.
 */
export async function computePrepaidRecognitionShortfall(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  asOfDate: number
): Promise<PrepaidRecognitionShortfallResult> {
  const schedules = await ctx.db
    .query("prepaidExpenseSchedules")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();

  const byCurrency: Record<string, number> = {};
  let scheduleCount = 0;
  for (const s of schedules) {
    if (s.status === "CANCELLED") continue;
    const dueMinor = recognizedDueThroughDateMinor(
      { totalMinor: s.totalMinor, termMonths: s.termMonths, startYearMonth: s.startYearMonth, currency: s.currency },
      { recognizedMinor: s.recognizedMinor, monthsRecognized: s.monthsRecognized ?? 0 },
      asOfDate
    );
    const shortfall = dueMinor - s.recognizedMinor;
    if (shortfall > 0) {
      byCurrency[s.currency] = (byCurrency[s.currency] ?? 0) + shortfall;
      scheduleCount++;
    }
  }

  return { hasShortfall: scheduleCount > 0, scheduleCount, byCurrency };
}

export async function computeSupplierPayablesReconciliation(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  toDate: number | undefined
): Promise<GlVsSubledgerResult> {
  const pending = await ctx.db
    .query("vehicleSupplierPayables")
    .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING"))
    .collect();

  const subByCurrency = new Map<string, number>();
  for (const p of pending) {
    const minor = toMinorUnits(p.amountDue, p.currency);
    subByCurrency.set(p.currency, (subByCurrency.get(p.currency) ?? 0) + minor);
  }

  const glByCurrency = await computeGlBalanceByCurrency(ctx, orgId, SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS, toDate);
  return combineGlAndSubledger(glByCurrency, subByCurrency);
}

export const supplierPayablesReconciliation = query({
  args: { orgId: v.id("organizations"), toDate: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    return computeSupplierPayablesReconciliation(ctx, args.orgId, args.toDate);
  },
});

export async function computeCustomerDepositsReconciliation(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  toDate: number | undefined
): Promise<GlVsSubledgerResult> {
  const orgCurrency = await getOrgCurrencyForReports(ctx, orgId);
  const held = await ctx.db
    .query("deposits")
    .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "HELD"))
    .collect();

  const subByCurrency = new Map<string, number>();
  for (const d of held) {
    if (d.isDeleted) continue;
    const currency = d.currency ?? orgCurrency;
    const minor = d.amountMinor ?? toMinorUnits(d.amount, currency);
    subByCurrency.set(currency, (subByCurrency.get(currency) ?? 0) + minor);
  }

  const glByCurrency = await computeGlBalanceByCurrency(ctx, orgId, SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY, toDate);
  return combineGlAndSubledger(glByCurrency, subByCurrency);
}

export const customerDepositsReconciliation = query({
  args: { orgId: v.id("organizations"), toDate: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    return computeCustomerDepositsReconciliation(ctx, args.orgId, args.toDate);
  },
});

export async function computeCommissionPayableReconciliation(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  toDate: number | undefined
): Promise<GlVsSubledgerResult> {
  const orgCurrency = await getOrgCurrencyForReports(ctx, orgId);
  const sales = await ctx.db
    .query("sales")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
  const owed = sales.filter((s) =>
    // Cancellation reverses the GL commission accrual (hookCommissionReversed)
    // but never clears commissionAmount on the sale row — without this
    // check a cancelled sale would still count in the subledger side while
    // its GL liability is already zero, permanently unreconciled.
    !s.isDeleted && s.status !== "CANCELLED" &&
    s.commissionAmount != null && s.commissionAmount > 0 && s.commissionPaidAt == null
  );

  let subledgerMinor = 0;
  for (const sale of owed) {
    subledgerMinor += toMinorUnits(sale.commissionAmount!, orgCurrency);
  }

  const subByCurrency = new Map<string, number>();
  if (subledgerMinor > 0) subByCurrency.set(orgCurrency, subledgerMinor);

  const glByCurrency = await computeGlBalanceByCurrency(ctx, orgId, SYSTEM_KEYS.COMMISSION_PAYABLE, toDate);
  return combineGlAndSubledger(glByCurrency, subByCurrency);
}

export const commissionPayableReconciliation = query({
  args: { orgId: v.id("organizations"), toDate: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    return computeCommissionPayableReconciliation(ctx, args.orgId, args.toDate);
  },
});
