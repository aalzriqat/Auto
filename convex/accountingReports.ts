/**
 * Phase 5 — Ledger-backed financial reports
 *
 * All reports are computed from posted journalLines (the GL), not from the
 * legacy transactions table.  Reports only include POSTED journal entries.
 */
import { v } from "convex/values";
import { query } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { QueryCtx } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { fromMinorUnits, scaleForCurrency, toMinorUnits } from "./utils/money";
import { SYSTEM_KEYS, SystemKey } from "./utils/defaultChart";
import { liveAppliedMinorForDeposit } from "./utils/depositApplications";
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

/**
 * What the dealership still owes on a reservation deposit, row by row.
 *
 * A `deposits` row is no longer all-or-nothing. Its money is applied per car on
 * a multi-vehicle quote and can be released in part, so `status` records only
 * whichever thing happened last: a row stays HELD until its LAST slice is
 * consumed, and one that has been part-refunded stays HELD too.
 *
 * The GL, meanwhile, debits Customer Deposits per slice, at the moment each one
 * is applied or paid back. So the two sides only agree if the subledger side is
 * computed as the outstanding remainder rather than the row's face value.
 * Reading face value made every multi-car deal mid-life, and permanently any
 * deal with a zero-share car or a partial refund, report "customer deposits do
 * not reconcile" — turning the one control that detects a real deposit-liability
 * error into noise an accountant has to acknowledge at every close.
 *
 * Rows that are no longer HELD are included when something is still owed on
 * them, for the same reason: the status is not the balance.
 */
async function outstandingDepositMinor(
  ctx: QueryCtx,
  deposit: Doc<"deposits">,
  currency: string
): Promise<number> {
  const face = deposit.amountMinor ?? toMinorUnits(deposit.amount, currency);
  const appliedToSales = await liveAppliedMinorForDeposit(ctx, deposit._id);
  const paidOut = deposit.releasedAmountMinor ?? 0;

  const holds = await ctx.db
    .query("depositVehicleHolds")
    .withIndex("by_deposit", (q) => q.eq("depositId", deposit._id))
    .collect();
  // OTHER is deliberately NOT here. It records a treatment the system does not
  // post, so the GL keeps the credit — dropping it from this side would leave
  // the two apart from the moment it is chosen. Mirrors
  // recordUnpostedDepositTreatment: the liability stays on the books awaiting a
  // manual journal.
  //
  // Known limit: this is right until that manual journal is posted. Once an
  // accountant debits Customer Deposits by hand the GL drops and this side does
  // not, and nothing records that it happened — so the pair goes out of balance
  // with no way to clear it. No UI sends OTHER today (QuoteDepositManager's
  // treatments omit it), so the state is reachable only through the API.
  const slicesFinalized = holds
    .filter(
      (hold) =>
        hold.allocationStatus === "RESOLVED" &&
        (hold.resolutionTreatment === "REFUND_TO_CUSTOMER" ||
          hold.resolutionTreatment === "FORFEITED")
    )
    .reduce((sum, hold) => sum + (hold.allocatedAmountMinor ?? 0), 0);

  const accountedFor = appliedToSales + paidOut + slicesFinalized;

  // A row resolved before any of this existed carries no per-slice evidence at
  // all: no application rows, no `releasedAmountMinor`, no hold treatments. Its
  // status is the only record of what happened, and it says the whole row went.
  // Without this every historical applied, refunded and forfeited deposit would
  // reappear as an outstanding liability the moment this deploys.
  const resolvedWithoutSliceRecord = deposit.status !== "HELD" && accountedFor === 0;
  if (resolvedWithoutSliceRecord) return 0;

  const outstanding = face - accountedFor;
  if (outstanding < 0) {
    // More has been relieved than the row ever held. Nothing reachable does
    // that today, and if something starts to, this is the control that is
    // supposed to say so — clamping it to zero would hide exactly the class of
    // error the reconciliation exists to catch.
    console.error(
      `Deposit ${deposit._id} has been relieved by ${accountedFor} against a face value of ${face}.`
    );
  }
  return outstanding;
}

export async function computeCustomerDepositsReconciliation(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  toDate: number | undefined
): Promise<GlVsSubledgerResult> {
  const orgCurrency = await getOrgCurrencyForReports(ctx, orgId);
  // Every row that could still owe something. A HELD row usually does; an
  // APPLIED, REFUNDED or FORFEITED one can too, when only part of it went.
  // VOIDED rows never received money in the first place.
  const candidates = (
    await ctx.db
      .query("deposits")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect()
  ).filter((d) => d.isDeleted !== true && d.status !== "VOIDED");

  const subByCurrency = new Map<string, number>();
  for (const d of candidates) {
    const currency = d.currency ?? orgCurrency;
    const outstanding = await outstandingDepositMinor(ctx, d, currency);
    if (outstanding === 0) continue;
    subByCurrency.set(currency, (subByCurrency.get(currency) ?? 0) + outstanding);
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
  toDate: number | undefined,
  /** See computeCommissionRecognitionDivergence — the same shared read. */
  provided?: { sales?: Doc<"sales">[] }
): Promise<GlVsSubledgerResult> {
  // No org-currency read here: the subledger side is keyed by the currency each
  // entry was POSTED in, so today's org currency plays no part.
  const sales =
    provided?.sales ??
    (await ctx.db
      .query("sales")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect());

  // BOTH SIDES ARE EVALUATED AS OF `toDate`. The GL side always was
  // (getPostedLines filters accountingDate <= toDate); the subledger side used
  // to read current state, and mixing the two is what made correct books look
  // wrong. A commission accrued on 28 July and paid on 2 August, reconciled at
  // 31 July: the GL correctly still carries the liability, while current state
  // says the sale is paid and drops it — a difference reported on books that
  // are right. Paying a month's commissions before closing that month is the
  // normal workflow, so that fired on most closes. It matters because closing
  // requires acknowledging every warning verbatim (accountingPeriods.close),
  // and a warning that cries wolf is how a real one later gets clicked through.
  //
  // Deliberately NOT isCommissionOwed (convex/utils/commission.ts): that is the
  // shared CURRENT-state rule the commissions page and the payroll sweep use,
  // and it is right for them. A point-in-time report cannot use it — it would
  // have to ask "was this owed then", which the predicate cannot express.
  const recognizedBySale = await computeRecognizedCommissionAsOf(ctx, orgId, toDate);

  const subledgerMinor = new Map<string, number>();
  for (const sale of sales) {
    if (sale.isDeleted === true) continue;
    // What the GL had recognized for this sale as of the reporting date. Summed
    // from the ENTRIES, not the sale's live commissionAmount: a correction can
    // land in a later period than the accrual it corrects (when the sale's own
    // period has since closed), so the live amount would charge the whole
    // corrected figure against a window whose GL holds only part of it.
    //
    // Absent means nothing was recognized by then — the liability did not exist
    // yet, so it belongs on neither side. A cancelled sale lands here too: its
    // reversal removes the recognition as of the reversal date.
    const recognized = recognizedBySale.get(sale._id);
    if (recognized === undefined) continue;
    // Settled at or before the reporting date, so the GL had already cleared it.
    if (sale.commissionPaidAt != null && (toDate === undefined || sale.commissionPaidAt <= toDate)) {
      continue;
    }
    // Keyed by the currency each entry was POSTED in, not the org's current
    // one. The GL side splits by currency, so folding everything into today's
    // org currency would make the two disagree permanently after a currency
    // change — and would compare scale-3 minors (JOD/KWD/BHD/OMR) against
    // scale-2 ones as if they were the same unit.
    for (const [currency, minor] of recognized) {
      subledgerMinor.set(currency, (subledgerMinor.get(currency) ?? 0) + minor);
    }
  }

  const subByCurrency = new Map<string, number>();
  // `!== 0`, not `> 0`: a negative total is exactly the kind of discrepancy this
  // report exists to surface, and suppressing it reported a clean zero instead.
  for (const [currency, minor] of subledgerMinor) {
    if (minor !== 0) subByCurrency.set(currency, minor);
  }

  const glByCurrency = await computeGlBalanceByCurrency(ctx, orgId, SYSTEM_KEYS.COMMISSION_PAYABLE, toDate);
  return combineGlAndSubledger(glByCurrency, subByCurrency);
}

/**
 * Commission recognized in the GL per sale, as of `toDate` — accrual plus every
 * correction, minus anything a reversal had already backed out by then.
 *
 * An entry counts when it was dated at or before the reporting date and was
 * still live at that moment. "Still live" is not the same as `status ===
 * "POSTED"` today: a July accrual reversed in August was POSTED throughout
 * July, and dropping it because the row now reads REVERSED would understate
 * July against a GL that still carries it. So a REVERSED entry counts too,
 * unless its reversal itself landed at or before the reporting date.
 */
async function computeRecognizedCommissionAsOf(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  toDate: number | undefined
): Promise<Map<string, Map<string, number>>> {
  // by_org_eventType_date exists for exactly this — it loads one event type for
  // just its own window instead of the org's whole history. Going through
  // by_org_eventType and filtering afterwards scanned every commission event a
  // dealership had ever posted, twice, inside a live query that also runs
  // inside the close checklist.
  const inWindow = async (eventType: "COMMISSION_ACCRUED" | "COMMISSION_ADJUSTED") =>
    await ctx.db
      .query("accountingEvents")
      .withIndex("by_org_eventType_date", (q) => {
        const scoped = q.eq("orgId", orgId).eq("eventType", eventType);
        return toDate === undefined ? scoped : scoped.lte("accountingDate", toDate);
      })
      .filter((q) => q.or(q.eq(q.field("status"), "POSTED"), q.eq(q.field("status"), "REVERSED")))
      .collect();

  const recognized = new Map<string, Map<string, number>>();
  const add = (saleId: unknown, minor: unknown, currency: string) => {
    if (typeof saleId !== "string" || typeof minor !== "number" || !Number.isFinite(minor)) return;
    const byCurrency = recognized.get(saleId) ?? new Map<string, number>();
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + minor);
    recognized.set(saleId, byCurrency);
  };

  const wasLiveAt = async (event: Doc<"accountingEvents">): Promise<boolean> => {
    if (event.status !== "REVERSED") return true;
    if (!event.reversedByEventId) return false;
    const reversal = await ctx.db.get(event.reversedByEventId);
    if (!reversal || reversal.orgId !== orgId) return false;
    return toDate !== undefined && reversal.accountingDate > toDate;
  };

  for (const e of await inWindow("COMMISSION_ACCRUED")) {
    if (await wasLiveAt(e)) add(e.payload?.saleId, e.payload?.amountMinor, e.currency);
  }
  for (const e of await inWindow("COMMISSION_ADJUSTED")) {
    if (await wasLiveAt(e)) add(e.payload?.saleId, e.payload?.deltaMinor, e.currency);
  }
  return recognized;
}

/**
 * Sales that owe a commission whose RECOGNIZED total does not equal the amount
 * decided on the sale row — the independent control the reconciliation above
 * cannot be.
 *
 * That reconciliation compares the GL against amounts derived from the same
 * posted events, which makes it strong on settlement and reversal drift but
 * blind to the one thing this change introduces: signed-delta arithmetic. If a
 * delta were ever computed against the wrong base — a stale amount, an
 * interrupted sequence, or an amount edited straight through the admin
 * raw-JSON editor, which can write `sales` rows — the GL and that subledger
 * would be wrong by the same amount and reconcile perfectly.
 *
 * Comparing recognition against the DECIDED amount closes that hole, and also
 * catches a commission that was never recognized at all.
 *
 * Sales with an entry still in the outbox are excluded: recognition there is
 * pending rather than wrong, and the close checklist already reports unposted
 * events as a blocker in its own right.
 */
/** Minor units, or null when the value cannot be expressed as such. */
function safeToMinorUnits(amount: number | undefined, currency: string): number | null {
  if (amount == null || !Number.isFinite(amount)) return null;
  try {
    const minor = toMinorUnits(amount, currency);
    return Number.isSafeInteger(minor) ? minor : null;
  } catch {
    return null;
  }
}

export async function computeCommissionRecognitionDivergence(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  // Threaded in by computeCloseChecklist, which has already collected both in
  // the same transaction. Re-reading them there meant the org's whole sales
  // table twice and both outbox statuses twice, on top of six other full-table
  // reconciliations. Crossing Convex's read limit does not just drop this
  // warning: `close` recomputes the checklist before it builds its blockers, so
  // the period could not be closed at all, and the owner override meant to be
  // the escape hatch is never reached.
  //
  // The recognition history is deliberately NOT shared. This control reads it
  // as of now while the reconciliation reads it as of the period end, so one
  // map cannot serve both without silently giving one of them the wrong answer.
  provided?: {
    pendingEvents?: Doc<"pendingAccountingEvents">[];
    sales?: Doc<"sales">[];
  }
): Promise<{
  unrecognizedCount: number;
  divergentCount: number;
  /** Unrecognized AND in a CLOSED/LOCKED period, so the backfill cannot fix them. */
  strandedCount: number;
  /** Unrecognized AND no period covers the sale date, so nothing will ever post them. */
  noPeriodCount: number;
  currency: string;
}> {
  const orgCurrency = await getOrgCurrencyForReports(ctx, orgId);
  const sales =
    provided?.sales ??
    (await ctx.db
      .query("sales")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect());

  // NOT isCommissionOwed. Payment does not reverse the accrual, so a commission
  // recognized at the wrong figure is still wrong after it is paid — and the
  // owed-only filter dropped it the moment it was settled, which is precisely
  // when nobody would look again. Cancelled sales ARE excluded: their entries
  // are reversed, so recognition of zero against a surviving commissionAmount
  // is correct rather than missing. Drafts are excluded because nothing is
  // owed or recognized on them yet.
  const candidates = sales.filter(
    (s) =>
      s.isDeleted !== true &&
      s.status === "COMPLETED" &&
      s.commissionAmount != null &&
      s.commissionAmount > 0
  );
  if (candidates.length === 0) {
    return {
      unrecognizedCount: 0,
      divergentCount: 0,
      strandedCount: 0,
      noPeriodCount: 0,
      currency: orgCurrency,
    };
  }

  // CURRENT state on both sides, deliberately — unlike the payable
  // reconciliation above, which is point-in-time on both sides.
  //
  // Bounding recognition at the period end while comparing it against the
  // sale's CURRENT amount mixes two bases: a sale completed after the period
  // reads as "never recognized", and a correction posted after the period makes
  // the period read as divergent. Neither can be cleared by anything — the
  // events exist, so re-running the backfill changes nothing — and both land on
  // a warning that must be acknowledged verbatim at every close.
  //
  // This control asks "does what the ledger recognized match what was decided",
  // which is a question about now, not about a date. Its cost is one bounded
  // read of the org's commission events; the duplicate outbox reads that made
  // the checklist expensive are threaded in above.
  const recognized = await computeRecognizedCommissionAsOf(ctx, orgId, undefined);
  const outbox =
    provided?.pendingEvents ??
    (
      await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING"))
        .collect()
    ).concat(
      await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "FAILED"))
        .collect()
    );

  // Parsed once into the set of sale ids with a commission entry still in the
  // outbox. Scanning every queued key per candidate sale was O(sales × queued)
  // and rebuilt the key list on each iteration.
  const salesWithQueuedEntry = new Set<string>();
  for (const p of outbox) {
    const accrual = /^commission_accrued_(.+)$/.exec(p.idempotencyKey);
    if (accrual) salesWithQueuedEntry.add(accrual[1]);
    const adjustment = /^commission_adjusted_(.+)_\d+$/.exec(p.idempotencyKey);
    if (adjustment) salesWithQueuedEntry.add(adjustment[1]);
  }

  let unrecognizedCount = 0;
  let divergentCount = 0;
  let strandedCount = 0;
  let noPeriodCount = 0;
  // Loaded once rather than a checkPostingAllowed call per sale: this runs
  // inside the close checklist, where read count is the constraint that decides
  // whether a period can be closed at all.
  const periods = await ctx.db
    .query("accountingPeriods")
    .withIndex("by_org_startDate", (q) => q.eq("orgId", orgId))
    .collect();
  for (const sale of candidates) {
    if (salesWithQueuedEntry.has(sale._id)) continue;
    const byCurrency = recognized.get(sale._id);
    // Read the ORG-CURRENCY total only. Summing across currencies adds scale-3
    // JOD minor units to scale-2 USD ones, which is not a number — the same
    // hazard recognizedCommissionMinor, recognizedCommissionForSale and the
    // payable reconciliation each guard against explicitly. After an org
    // currency change it manufactured a divergence out of arithmetic, on a
    // warning that has to be acknowledged verbatim at every close.
    //
    // Recognition in some OTHER currency is real and must not be silently
    // dropped either: it is a genuine divergence, because the sale's decided
    // amount is expressed in the org currency and the ledger holds something
    // that cannot be compared with it.
    const recognizedMinor = byCurrency?.get(orgCurrency) ?? 0;
    const recognizedInOtherCurrency = byCurrency
      ? [...byCurrency.entries()].some(([cur, minor]) => cur !== orgCurrency && minor !== 0)
      : false;
    if (recognizedInOtherCurrency) {
      divergentCount++;
      continue;
    }
    // Never recognized at all is a DIFFERENT problem from recognized at the
    // wrong figure, and reporting them under one message made the deploy-time
    // backlog read as ledger corruption. One is fixed by running the backfill;
    // the other needs a human to work out what happened.
    // Convertibility is checked BEFORE the not-recognized branch. An amount the
    // ledger cannot express is a divergence whatever its recognition is, and
    // the backfill refuses it (isConvertibleAmount) — so routing it to "run the
    // backfill" named a remedy that can never clear the warning.
    const decided = safeToMinorUnits(sale.commissionAmount, orgCurrency);
    if (decided === null) {
      divergentCount++;
      continue;
    }
    if (recognizedMinor === 0 && byCurrency !== undefined) {
      // Entries EXIST and net to zero, against a decided amount that is
      // positive. The backfill finds the posted accrual and skips this sale as
      // already recognized, so routing it to "run the backfill" would be the
      // fourth version of an instruction that cannot clear its own warning.
      // A human has to work out how the sale's amount and its entries parted
      // company. Absence of the map key — not a zero total — is what actually
      // means "never recognized".
      divergentCount++;
      continue;
    }
    if (recognizedMinor === 0) {
      // Only counted when the backfill could actually fix it — i.e. the
      // commission is still unpaid. A commission SETTLED before commission GL
      // hooks existed has no entries and never will: the backfill skips it
      // (isCommissionOwed requires an unpaid commission), so counting it here
      // named a remedy that provably cannot clear the warning, on a line that
      // must be acknowledged verbatim at every close, forever.
      if (sale.commissionPaidAt == null) {
        // Same rule once more, one level deeper. The backfill ALSO skips a sale
        // whose own period is CLOSED or LOCKED (skippedClosedPeriod), so telling
        // an accountant to run it would be the third version of that same empty
        // instruction. These need the period reopened — or the commission zeroed
        // — before any backfill can touch them, so they are counted apart.
        const period = periods.find(
          (p) => p.startDate <= sale.saleDate && p.endDate >= sale.saleDate
        );
        if (!period) {
          // No period covers this sale at all. The backfill does enqueue these
          // ("queues harmlessly"), but harmless is only true if a period is
          // eventually created — otherwise the row sits PENDING forever, and an
          // unposted event dated in the past is a HARD close blocker for every
          // period after it. An org importing historical sales at go-live hits
          // exactly this, and nothing in the product tells them the fix is to
          // create a period covering the old dates.
          noPeriodCount++;
        } else if (period.status === "CLOSED" || period.status === "LOCKED") {
          strandedCount++;
        } else {
          unrecognizedCount++;
        }
      }
      continue;
    }
    if (recognizedMinor !== decided) {
      divergentCount++;
    }
  }
  return { unrecognizedCount, divergentCount, strandedCount, noPeriodCount, currency: orgCurrency };
}

export const commissionPayableReconciliation = query({
  args: { orgId: v.id("organizations"), toDate: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    return computeCommissionPayableReconciliation(ctx, args.orgId, args.toDate);
  },
});
