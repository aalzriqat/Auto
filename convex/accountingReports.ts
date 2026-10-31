import { createOpeningSettlementReader } from "./utils/openingSettlementBasis";
import {readOpeningUnallocatedLiabilities} from "./utils/openingUnallocatedLiabilities";
import { loadOpeningSourceIdentity } from "./utils/openingSourceIdentity";
import { UNEXPLAINED_OPENING_DIFFERENCE_LABEL } from "./utils/closeWarnings";
import { openingPayableBasis } from "./utils/openingSupplierBasis";
import { openingCommissionRemainingAsOf } from "./utils/openingCommissionBasis";
/**
 * Phase 5 — Ledger-backed financial reports
 *
 * All reports are computed from posted journalLines (the GL), not from the
 * legacy transactions table.  Reports only include POSTED journal entries.
 */
import { v, ConvexError } from "convex/values";
import { resolvePrepaidScheduleSource } from "./utils/openingPrepaidBasis";
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
import { settlementView } from "./utils/supplierSettlement";
import { AP_AFFECTING_BY_EVENT_TYPE } from "./accounting/postingRules";

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

/** accountingDate value historical queries treat as "no date" when a range bound is open. */
export const NO_ACCOUNTING_DATE_SENTINEL = -1;

/**
 * Concatenate index reads and put them back in insertion (_creationTime) order,
 * or by `primary` first when given, with _creationTime as the tiebreak.
 */
function mergeByCreation<T extends { _creationTime: number }>(parts: T[][], primary?: (row: T) => number): T[] {
  return parts
    .flat()
    .sort((a, b) => (primary ? primary(a) - primary(b) : 0) || a._creationTime - b._creationTime);
}

export async function getPostedLines(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  fromDate?: number,
  toDate?: number,
  options?: { preferBulkRead?: boolean }
) {
  // Leave headroom under Convex's per-transaction index-range limit for the
  // rest of the report. Lines sharing a parent require only one point read.
  const maxTargetedParents = 512;
  const excludeSentinel = fromDate === undefined || toDate === undefined;
  const eligibility = await ctx.db.query("journalReportEligibility")
    .withIndex("by_org", q => q.eq("orgId", orgId)).unique();
  if (eligibility?.phase === "READY") {
    const lines = await ctx.db.query("journalLines")
      .withIndex("by_org_reportPosted_date", q => {
        const scoped = q.eq("orgId", orgId).eq("reportPosted", true);
        if (fromDate !== undefined && toDate !== undefined) return scoped.gte("accountingDate", fromDate).lte("accountingDate", toDate);
        if (fromDate !== undefined) return scoped.gte("accountingDate", fromDate);
        if (toDate !== undefined) return scoped.lte("accountingDate", toDate);
        return scoped;
      }).collect();
    return mergeByCreation([lines.filter(line => !excludeSentinel || line.accountingDate !== NO_ACCOUNTING_DATE_SENTINEL)]);
  }
  const lineQuery = () => ctx.db
    .query("journalLines")
    .withIndex("by_org_date", (q) => {
      const scoped = q.eq("orgId", orgId);
      if (fromDate !== undefined && toDate !== undefined) {
        return scoped.gte("accountingDate", fromDate).lte("accountingDate", toDate);
      }
      if (fromDate !== undefined) return scoped.gte("accountingDate", fromDate);
      if (toDate !== undefined) return scoped.lte("accountingDate", toDate);
      return scoped;
    });

  // Read the requested lines once. A two-sided window with a bounded number
  // of parent entries can avoid reading every posted entry in the organization.
  // Cumulative callers can retain the bulk parent scan.
  const hasDateBound = fromDate !== undefined && toDate !== undefined;
  const inRange = await lineQuery().collect();
  const parentIds = hasDateBound && !options?.preferBulkRead
    ? [...new Set(inRange.map((line) => line.journalEntryId))]
    : [];
  if (hasDateBound && !options?.preferBulkRead && parentIds.length <= maxTargetedParents) {
    const parents = await Promise.all(parentIds.map((id) => ctx.db.get("journalEntries", id)));
    const allowedIds = new Set<Id<"journalEntries">>();
    for (const parent of parents) {
      if (parent?.orgId === orgId && (parent.status === "POSTED" || parent.status === "REVERSED")) {
        allowedIds.add(parent._id);
      }
    }
    return mergeByCreation([
      inRange.filter(
        (line) => (!excludeSentinel || line.accountingDate !== NO_ACCOUNTING_DATE_SENTINEL) && allowedIds.has(line.journalEntryId)
      ),
    ]);
  }

  // Include REVERSED entries too, not just POSTED ones: a reversed entry's
  // own lines are still real, immutable historical postings — its status
  // just means a *separate*, independently-posted reversal entry later
  // cancelled it out. Excluding it here would keep the reversal's inverted
  // lines while silently dropping the original half of the pair, turning a
  // net-zero cancellation into a one-sided, wrong balance.
  const [postedEntries, reversedEntries] = await Promise.all(
    (["POSTED", "REVERSED"] as const).map((status) =>
      ctx.db
        .query("journalEntries")
        .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", status))
        .collect()
    )
  );
  const entryIds = new Set<Id<"journalEntries">>();
  for (const e of postedEntries) entryIds.add(e._id);
  for (const e of reversedEntries) entryIds.add(e._id);

  // With an open bound, a line carrying the -1 sentinel date stays excluded.
  // Callers expect insertion order; the date index returns accountingDate order.
  return mergeByCreation([
    inRange.filter(
      (l) => (!excludeSentinel || l.accountingDate !== NO_ACCOUNTING_DATE_SENTINEL) && entryIds.has(l.journalEntryId)
    ),
  ]);
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

/** Shared native GL flow reader for authenticated accounting report handlers.
 * Closed balance consumers separately use accountSnapshots. */
export async function computeIncomeStatement(ctx: QueryCtx, args: {
  orgId: Id<"organizations">; fromDate: number; toDate: number;
}) {
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
}

export const incomeStatement = query({
  args: {
    orgId: v.id("organizations"),
    fromDate: v.number(),
    toDate: v.number(),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    return computeIncomeStatement(ctx, args);
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
 *
 * Two index reads: never cancelled and issued by asOfDate, plus cancelled
 * after asOfDate (issueDate applied in memory; it follows an inequality).
 */
async function getReceivablesAsOf(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  asOfDate: number
) {
  const [neverCancelled, cancelledAfter] = await Promise.all([
    ctx.db
      .query("receivableDocuments")
      .withIndex("by_org_cancelledAt_issueDate", (q) =>
        q.eq("orgId", orgId).eq("cancelledAt", undefined).lte("issueDate", asOfDate)
      )
      .collect(),
    ctx.db
      .query("receivableDocuments")
      .withIndex("by_org_cancelledAt_issueDate", (q) => q.eq("orgId", orgId).gt("cancelledAt", asOfDate))
      .collect(),
  ]);
  // Both streams are in issueDate order, not insertion order, so the merge sort stays.
  return mergeByCreation([neverCancelled, cancelledAfter.filter((r) => r.issueDate <= asOfDate)]);
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
//
// Customer Deposits is the exception since SCRUM-858 (round-1 review F2): it
// refuses to compare when any deposit-side activity is dated after `toDate`
// and reports UNAVAILABLE instead of a difference (see
// hasDepositActivityAfter). The A/P case is tracked as SCRUM-876.

export type GlVsSubledgerResult = {
  attributionStatus?: "ATTRIBUTED" | "UNALLOCATED" | "UNAVAILABLE";
  heldOpeningMinor?: Record<string,number>;
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
    .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "ACTIVE"))
    .collect();

  const subByCurrency = new Map<string, number>();
  for (const s of active) {
    const source = await resolvePrepaidScheduleSource(ctx, orgId, s._id);
    if (source.kind === "UNAVAILABLE") throw new ConvexError(source.reason);
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
    const source = await resolvePrepaidScheduleSource(ctx, orgId, s._id);
    if (source.kind === "UNAVAILABLE") throw new ConvexError(source.reason);
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

/**
 * SCRUM-651 (D-42). The AP-Suppliers subledger and its honesty about what it could see.
 *
 * AVAILABLE: `byCurrency` / `isReconciled` are the real comparison.
 * UNAVAILABLE: the whole truth could not be read, so NOTHING is claimed - `isReconciled` is false
 * and `currencies` / `byCurrency` are empty. A consumer that only reads `isReconciled` can
 * therefore never mistake "could not check" for "reconciled"; `status` / `unavailableReason` say why.
 */
export type SupplierPayablesReconciliationResult = GlVsSubledgerResult & {
  status: "AVAILABLE" | "UNAVAILABLE";
  unavailableReason?: SupplierPayablesUnavailableReason;
};

/**
 * SCRUM-876. POST_CUTOFF_ACTIVITY: the subledger and the GL cannot be shown to be measured at the
 * cutoff (a native payable row moved after it, or the AP control account holds a line dated after it).
 * INVALID_DATE: the cutoff is not a finite instant.
 */
type SupplierPayablesUnavailableReason =
  | "OVER_LIMIT"
  | "PENDING_POSTINGS"
  | "OPENING_SOURCE_UNAVAILABLE"
  | "POST_CUTOFF_ACTIVITY"
  | "INVALID_DATE";

/**
 * How many supplier-payable rows (all open-balance statuses and CANCELLED together) and, separately, how many
 * outbox events / drafts one reconciliation reads before it declares itself UNAVAILABLE. The whole
 * figure is needed to be true, so a truncated read is refused rather than summed. 4,000 sits well
 * under the Convex 16,384-documents-per-function ceiling. The limit bounds only this function's own
 * payable, outbox and draft reads; it does not budget the GL read (computeGlBalanceByCurrency reads
 * every posted line via getPostedLines) or the rest of the period-close checklist. Fully paid rows
 * still count toward it.
 */
const SUPPLIER_PAYABLES_RECON_READ_LIMIT = 4000;

/**
 * Every status that can carry an open balance, in read order. Exhaustive over the schema's status
 * union, so a new payable status fails typecheck until it is classified. CANCELLED is the one
 * status whose AP credit is reversed.
 */
const SUPPLIER_PAYABLE_STATUS_CARRIES_BALANCE = {
  PENDING: true,
  NOT_YET_DUE: true,
  DUE_ON_SALE: true,
  PARTIALLY_PAID: true,
  DISPUTED: true,
  PAID: true,
  CANCELLED: false,
} satisfies Record<Doc<"vehicleSupplierPayables">["status"], boolean>;
const SUPPLIER_PAYABLE_OPEN_STATUSES = (
  Object.keys(SUPPLIER_PAYABLE_STATUS_CARRIES_BALANCE) as Array<keyof typeof SUPPLIER_PAYABLE_STATUS_CARRIES_BALANCE>
).filter((status) => SUPPLIER_PAYABLE_STATUS_CARRIES_BALANCE[status]);
/** Open statuses first, then CANCELLED (see the cancelled-row guard in computeSupplierPayablesReconciliation). */
const SUPPLIER_PAYABLE_RECON_READ_STATUSES: ReadonlyArray<Doc<"vehicleSupplierPayables">["status"]> = [
  ...SUPPLIER_PAYABLE_OPEN_STATUSES,
  "CANCELLED",
];

/** Posting event types whose rule touches ACCOUNTS_PAYABLE_SUPPLIERS (classified in postingRules.ts). */
const AP_AFFECTING_EVENT_TYPES: ReadonlySet<string> = new Set(
  Object.entries(AP_AFFECTING_BY_EVENT_TYPE)
    .filter(([, affectsAp]) => affectsAp)
    .map(([eventType]) => eventType)
);

async function hasPendingApAffectingPosting(
  ctx: QueryCtx,
  events: Array<Doc<"pendingAccountingEvents">>
): Promise<boolean> {
  // Postings need no reads, so settle them first.
  const reversals: Array<Doc<"pendingAccountingEvents">> = [];
  for (const event of events) {
    if (event.kind === "REVERSE") reversals.push(event);
    else if (!event.eventType || AP_AFFECTING_EVENT_TYPES.has(event.eventType)) return true;
  }
  // A queued reversal inherits the AP effect of the event it reverses. One that cannot be
  // resolved is treated as AP-affecting: unknown must not read as safe.
  const originalIds = new Set<NonNullable<Doc<"pendingAccountingEvents">["originalEventId"]>>();
  for (const event of reversals) {
    if (!event.originalEventId) return true;
    originalIds.add(event.originalEventId);
  }
  const originals = await Promise.all([...originalIds].map((id) => ctx.db.get(id)));
  return originals.some((original) => !original || AP_AFFECTING_EVENT_TYPES.has(original.eventType));
}

/**
 * A manual journal or opening-balance draft still awaiting approval that touches the AP account
 * will move the GL when approved, so the comparison is not final. "over" = could not read them all.
 */
async function pendingApDraftState(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  readLimit: number
): Promise<"NONE" | "PENDING" | "OVER_LIMIT"> {
  const [apAccount, manual, opening] = await Promise.all([
    ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS))
      .unique(),
    ctx.db
      .query("manualJournalDrafts")
      .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING_APPROVAL"))
      .take(readLimit + 1),
    ctx.db
      .query("openingBalanceDrafts")
      .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING_APPROVAL"))
      .take(readLimit + 1),
  ]);
  if (!apAccount) return "NONE";
  if (manual.length > readLimit || opening.length > readLimit) return "OVER_LIMIT";

  const touchesAp = [...manual, ...opening].some((d) => d.lines.some((line) => line.accountId === apAccount._id));
  return touchesAp ? "PENDING" : "NONE";
}

async function supplierPayableOpenBalanceAsOf(
  ctx: QueryCtx,
  request: Readonly<{ orgId: Id<"organizations">; payable: Doc<"vehicleSupplierPayables">; cutoff: number }>,
): Promise<
  | { status: "AVAILABLE"; openMinor: number | null; accountId?: Id<"chartOfAccounts"> }
  | { status: "UNAVAILABLE"; reason: "OPENING_SOURCE_UNAVAILABLE" | "OVER_LIMIT" }
> {
  const { orgId, payable: p, cutoff } = request;
  let openMinor: number;
  let basis;
  try {
    basis = await openingPayableBasis(ctx, orgId, p);
  } catch {
    return { status: "UNAVAILABLE", reason: "OPENING_SOURCE_UNAVAILABLE" };
  }
  if (basis) {
    if (basis.asOfDate > cutoff) return { status: "AVAILABLE", openMinor: null, accountId: basis.accountId };
    const payments = await ctx.db
      .query("openingPayablePayments")
      .withIndex("by_payable", (q) => q.eq("payableId", p._id))
      .take(101);
    if (payments.length > 100) return { status: "UNAVAILABLE", reason: "OVER_LIMIT" };
    if (
      payments.some(
        (payment) =>
          payment.orgId !== orgId ||
          payment.openingBalanceDraftId !== basis.draftId ||
          payment.openingRowKey !== basis.rowKey ||
          !Number.isSafeInteger(payment.amountMinor) ||
          payment.amountMinor <= 0 ||
          payment.currency !== p.currency,
      )
    )
      return { status: "UNAVAILABLE", reason: "OPENING_SOURCE_UNAVAILABLE" };
    const paid = payments
      .filter(
        (payment) =>
          payment.occurredAt <= cutoff &&
          (payment.status !== "REVERSED" || (payment.reversedAt !== undefined && payment.reversedAt > cutoff)),
      )
      .reduce((sum, payment) => sum + payment.amountMinor, 0);
    openMinor = basis.amountMinor - paid;
  } else openMinor = toMinorUnits(p.amountDue, p.currency) - toMinorUnits(settlementView(p).amountPaid, p.currency);
  return { status: "AVAILABLE", openMinor, accountId: basis?.accountId };
}

/** True when a lifecycle stamp is after the cutoff, or is not a finite instant (it cannot be placed before it). */
const stampAfter = (stamp: number | undefined, cutoff: number): boolean =>
  stamp !== undefined && (!Number.isFinite(stamp) || stamp > cutoff);

/** True when any lifecycle stamp on a LIVE native row is after the cutoff. */
function nativePayableMovedAfter(payable: Doc<"vehicleSupplierPayables">, cutoff: number): boolean {
  return [payable.createdAt, payable.updatedAt, payable.paidAt, payable.disputedAt, payable.cancelledAt].some((stamp) =>
    stampAfter(stamp, cutoff),
  );
}

/**
 * True when a CANCELLED native row cannot be placed on the cutoff's side of its own life: it was written
 * after the cutoff, or it was cancelled after it. Such a row contributes nothing now but stood for its
 * AP credit at the cutoff, and its reversal is dated after the cutoff, so neither side can be restated.
 * Cancellation stamps `cancelledAt` and `updatedAt` together; a legacy row without `cancelledAt` is
 * placed by `updatedAt`. A row cancelled at or before the cutoff and merely touched later still
 * contributes zero at the cutoff, so a later `updatedAt` alone does not refuse it.
 */
function cancelledNativePayableMovedAfter(payable: Doc<"vehicleSupplierPayables">, cutoff: number): boolean {
  return stampAfter(payable.createdAt, cutoff) || stampAfter(payable.cancelledAt ?? payable.updatedAt, cutoff);
}

export async function computeSupplierPayablesReconciliation(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  toDate: number | undefined,
  opts: {
    readLimit?: number;
    /** PENDING + FAILED outbox rows the caller already read (period close shares them); read here if omitted. */
    outboxEvents?: Array<Doc<"pendingAccountingEvents">>;
  } = {}
): Promise<SupplierPayablesReconciliationResult> {
  const readLimit = opts.readLimit ?? SUPPLIER_PAYABLES_RECON_READ_LIMIT;
  const unavailable = (unavailableReason: SupplierPayablesUnavailableReason): SupplierPayablesReconciliationResult => ({
    currencies: [],
    byCurrency: {},
    isReconciled: false,
    status: "UNAVAILABLE",
    unavailableReason,
  });

  // ONE cutoff for the row guard and the ledger read. NaN and +/-Infinity pass `v.number()`, and every
  // comparison against NaN is false, so an unchecked value would read as "nothing is later".
  const cutoff = toDate ?? Date.now();
  if (!Number.isFinite(cutoff)) return unavailable("INVALID_DATE");

  // 1. Postings still in flight: the GL side is about to move, so a comparison now is not the truth.
  // The outbox and draft reads are independent, so they run together; the verdicts below are
  // still taken in the original order (outbox over-limit, queued posting, drafts).
  const readOutbox = async (): Promise<Array<Doc<"pendingAccountingEvents">> | null> => {
    const [queued, failed] = await Promise.all(
      (["PENDING", "FAILED"] as const).map((status) =>
        ctx.db
          .query("pendingAccountingEvents")
          .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", status))
          .take(readLimit + 1)
      )
    );
    return queued.length > readLimit || failed.length > readLimit ? null : [...queued, ...failed];
  };
  const [outboxEvents, drafts] = await Promise.all([
    opts.outboxEvents ?? readOutbox(),
    pendingApDraftState(ctx, orgId, readLimit),
  ]);
  if (!outboxEvents) return unavailable("OVER_LIMIT");
  if (await hasPendingApAffectingPosting(ctx, outboxEvents)) return unavailable("PENDING_POSTINGS");
  if (drafts === "OVER_LIMIT") return unavailable("OVER_LIMIT");
  if (drafts === "PENDING") return unavailable("PENDING_POSTINGS");

  // 2. Every payable, under one shared bound. Status is a label, not the balance: a payable leaves
  // PENDING on a partial payment or a dispute while the liability stands. CANCELLED rows are read last
  // (open-status verdicts keep their precedence) and contribute no balance, but a native one cancelled
  // after the cutoff stood for its AP credit at it (SCRUM-876), so they are read under the same bound.
  const rows: Array<Doc<"vehicleSupplierPayables">> = [];
  for (const status of SUPPLIER_PAYABLE_RECON_READ_STATUSES) {
    const budget = readLimit - rows.length;
    const batch = await ctx.db
      .query("vehicleSupplierPayables")
      .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", status))
      .take(budget + 1);
    if (batch.length > budget) return unavailable("OVER_LIMIT");
    rows.push(...batch);
  }

  // Signed open balance in minor units. Deliberately NOT clamped: an overpaid row is a real
  // negative that the GL carries (AP in debit), and a legacy PAID row with no amountPaid is read by
  // settlementView as fully paid (contributes 0). Soft-deleted vehicles do not matter - the
  // liability does not go away with the car.
  const subByCurrency = new Map<string, number>();
  const controlAccounts = new Set<Id<"chartOfAccounts">>();
  const canonical = await ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey",q=>q.eq("orgId",orgId).eq("systemKey",SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS)).unique();
  if(canonical)controlAccounts.add(canonical._id);
  let hasNativeRow = false;
  for (const p of rows) {
    if (p.status === "CANCELLED") {
      // No balance now, and an opening-basis row keeps its own dated reconstruction (never read here).
      if (p.origin === "OPENING") continue;
      hasNativeRow = true;
      if (cancelledNativePayableMovedAfter(p, cutoff)) return unavailable("POST_CUTOFF_ACTIVITY");
      continue;
    }
    const balance = await supplierPayableOpenBalanceAsOf(ctx, { orgId, payable: p, cutoff });
    if (balance.status === "UNAVAILABLE") return unavailable(balance.reason);
    if (balance.accountId) controlAccounts.add(balance.accountId);
    else {
      // A native row is only its CURRENT state (one cumulative `amountPaid`, one `updatedAt`). It stands
      // for the cutoff only when nothing on it moved after the cutoff; it cannot be restated to it.
      hasNativeRow = true;
      if (nativePayableMovedAfter(p, cutoff)) return unavailable("POST_CUTOFF_ACTIVITY");
    }
    if (balance.openMinor === null) continue;
    const openMinor = balance.openMinor;
    subByCurrency.set(p.currency, (subByCurrency.get(p.currency) ?? 0) + openMinor);
  }
  for (const [currency, minor] of subByCurrency) {
    if (minor === 0) subByCurrency.delete(currency);
  }

  // A native payable's AP credit is dated by its sale/acquisition, which can be after the row was written
  // (sales.create accepts a future saleDate). A GL line on the control account dated after the cutoff is
  // therefore invisible to the GL read while the row already counts its effect. A cancelled native row
  // counts too: its credit can be dated after the cutoff while its reversal is dated before it.
  if (hasNativeRow && canonical) {
    const laterLine = await ctx.db
      .query("journalLines")
      .withIndex("by_org_account_date", (q) => q.eq("orgId", orgId).eq("accountId", canonical._id).gt("accountingDate", cutoff))
      .first();
    if (laterLine) return unavailable("POST_CUTOFF_ACTIVITY");
  }

  const glByCurrency=new Map<string,number>();
  for(const balance of await getCumulativeBalancesAsOf(ctx,orgId,cutoff)){
    if(!controlAccounts.has(balance.accountId))continue;
    glByCurrency.set(balance.currency,(glByCurrency.get(balance.currency)??0)+balance.creditMinor-balance.debitMinor);
  }
  return { ...combineGlAndSubledger(glByCurrency, subByCurrency), status: "AVAILABLE" };
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

/**
 * SCRUM-858 S1 (owner ruling 2026-10-28, c23884): a deposit-liability difference in an organization
 * that has an opening balance is REPORTED under the owner's label. Nothing here writes: no journal,
 * plug, clearing line or equity entry is ever created to force the two sides to agree.
 */
export type CustomerDepositsReconciliationResult = GlVsSubledgerResult & {
  /**
   * AVAILABLE: `byCurrency` / `isReconciled` are the real comparison.
   * UNAVAILABLE: nothing is claimed. `isReconciled` is false, `currencies` / `byCurrency` are empty and
   * no difference is invented, so a consumer reading only `isReconciled` can never take "could not
   * check" for "reconciled". `unavailableReason` says why.
   */
  status: "AVAILABLE" | "UNAVAILABLE";
  unavailableReason?: "POST_CUTOFF_ACTIVITY" | "INVALID_DATE" | "OPENING_SOURCE_UNAVAILABLE";
  unexplainedOpeningDifference: {
    label: { en: string; ar: string };
    /** Currencies whose GL and subledger sides disagree. */
    currencies: string[];
  } | null;
};

async function labelDepositsOpeningDifference(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  result: GlVsSubledgerResult
): Promise<CustomerDepositsReconciliationResult> {
  const currencies = result.currencies.filter((currency) => result.byCurrency[currency].discrepancyMinor !== 0);
  if (currencies.length === 0) return { ...result, status: "AVAILABLE", unexplainedOpeningDifference: null };
  const source = await loadOpeningSourceIdentity(ctx, orgId);
  const hasOpeningHistory = source.headers.length > 0 || source.status !== "ABSENT";
  return {
    ...result,
    status: "AVAILABLE",
    unexplainedOpeningDifference: hasOpeningHistory
      ? { label: { ...UNEXPLAINED_OPENING_DIFFERENCE_LABEL }, currencies }
      : null,
  };
}

function unavailableDepositsReconciliation(
  unavailableReason: NonNullable<CustomerDepositsReconciliationResult["unavailableReason"]>
): CustomerDepositsReconciliationResult {
  return {
    currencies: [],
    byCurrency: {},
    isReconciled: false,
    attributionStatus: "UNAVAILABLE",
    status: "UNAVAILABLE",
    unavailableReason,
    unexplainedOpeningDifference: null,
  };
}

/** True when any stamp is strictly after the cutoff. A stamp equal to the cutoff is ON it, and the GL read includes it. */
function isAfterCutoff(cutoff: number, ...stamps: Array<number | undefined>): boolean {
  return stamps.some((stamp) => stamp !== undefined && stamp > cutoff);
}

/** The deposit row's own lifecycle stamps: received, resolved (refunded, applied, forfeited, voided) or deleted. */
function depositRowMovedAfter(deposit: Doc<"deposits">, cutoff: number): boolean {
  return isAfterCutoff(cutoff, deposit.createdAt, deposit.resolvedAt, deposit.deletedAt);
}

function applicationMovedAfter(application: Doc<"depositApplications">, cutoff: number): boolean {
  return isAfterCutoff(cutoff, application.appliedAt, application.reversalStartedAt, application.reversedAt);
}

function holdMovedAfter(hold: Doc<"depositVehicleHolds">, cutoff: number): boolean {
  return isAfterCutoff(cutoff, hold.createdAt, hold.allocatedAt, hold.resolvedAt);
}

type DepositActivityScan = "CLEAR" | "POST_CUTOFF_ACTIVITY" | "OPENING_SOURCE_UNAVAILABLE";

/**
 * The accounting date an OPENING deposit carries in the GL: the opening journal is dated at the draft's
 * `asOfDate` (SCRUM-858 S1, openingAllocations posts `date: plan.asOfDate`), while the row's own
 * `createdAt` is the approval time. A row approved today for an opening dated tomorrow therefore exists
 * on the subledger side while the GL has not yet recorded its credit.
 *
 * UNREADABLE when the draft the row points at is gone or is not POSTED: the row cannot be dated, so
 * nothing about it can be compared.
 */
async function openingDatesVerdict(
  ctx: QueryCtx,
  deposits: ReadonlyArray<Doc<"deposits">>,
  cutoff: number
): Promise<"CLEAR" | "LATER" | "UNREADABLE"> {
  const draftIds = new Set<Id<"openingBalanceDrafts">>();
  for (const deposit of deposits) {
    if (deposit.openingBalanceDraftId !== undefined) draftIds.add(deposit.openingBalanceDraftId);
  }
  let verdict: "CLEAR" | "LATER" | "UNREADABLE" = "CLEAR";
  for (const draftId of draftIds) {
    const draft = await ctx.db.get(draftId);
    if (draft === null || draft.status !== "POSTED") return "UNREADABLE";
    if (isAfterCutoff(cutoff, draft.asOfDate)) verdict = "LATER";
  }
  return verdict;
}

async function depositChildrenMovedAfter(
  ctx: QueryCtx,
  deposit: Doc<"deposits">,
  cutoff: number
): Promise<boolean> {
  const applications = await ctx.db
    .query("depositApplications")
    .withIndex("by_deposit", (q) => q.eq("depositId", deposit._id))
    .collect();
  if (applications.some((application) => applicationMovedAfter(application, cutoff))) return true;
  const holds = await ctx.db
    .query("depositVehicleHolds")
    .withIndex("by_deposit", (q) => q.eq("depositId", deposit._id))
    .collect();
  return holds.some((hold) => holdMovedAfter(hold, cutoff));
}

/**
 * Whether anything on the deposit side is dated AFTER `cutoff`: a row created, resolved or deleted, an
 * opening row whose opening date is later, an application made or reversed, or a hold allocated or
 * resolved. The caller resolves ONE cutoff (an omitted `toDate` is "now") and uses the same value for
 * the GL read, so the guard and the ledger can never disagree about which instant is being compared.
 *
 * Why this is a refusal and not a reconstruction. The GL side is read as of the cutoff; the subledger
 * side is the CURRENT state of the deposit rows. The two agree only when nothing on the deposit side
 * has moved since. The deposit side cannot be restated to an earlier date from what is recorded:
 * `releasedAmountMinor` is one cumulative figure with no per-release date, `resolvedAt` is overwritten
 * by whichever event came last, and an opening row is created when it is approved but dated at the
 * opening date in the GL. Any restated figure would be a guess presented as a balance, so the
 * comparison is declared UNAVAILABLE instead (the AP-Suppliers control does the same when it cannot
 * see everything). Applications carry their own dates (`appliedAt` equals the journal's accounting
 * date), so this scan is exact about what is "later".
 */
async function scanDepositActivityAfter(
  ctx: QueryCtx,
  deposits: ReadonlyArray<Doc<"deposits">>,
  cutoff: number
): Promise<DepositActivityScan> {
  if (deposits.some((deposit) => depositRowMovedAfter(deposit, cutoff))) return "POST_CUTOFF_ACTIVITY";
  const opening = await openingDatesVerdict(ctx, deposits, cutoff);
  if (opening === "UNREADABLE") return "OPENING_SOURCE_UNAVAILABLE";
  if (opening === "LATER") return "POST_CUTOFF_ACTIVITY";
  for (const deposit of deposits) {
    if (await depositChildrenMovedAfter(ctx, deposit, cutoff)) return "POST_CUTOFF_ACTIVITY";
  }
  return "CLEAR";
}

/** Outstanding subledger liability per currency for every row that could still owe something. */
async function outstandingDepositsByCurrency(
  ctx: QueryCtx,
  allRows: ReadonlyArray<Doc<"deposits">>,
  orgCurrency: string
): Promise<Map<string, number>> {
  // A HELD row usually owes; an APPLIED, REFUNDED or FORFEITED one can too, when only part of it went.
  // VOIDED rows never received money in the first place.
  const candidates = allRows.filter((d) => d.isDeleted !== true && d.status !== "VOIDED");
  const byCurrency = new Map<string, number>();
  for (const d of candidates) {
    const currency = d.currency ?? orgCurrency;
    const outstanding = await outstandingDepositMinor(ctx, d, currency);
    if (outstanding === 0) continue;
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + outstanding);
  }
  return byCurrency;
}

/**
 * The control accounts the deposit liability lives on (the native Customer Deposits account plus the
 * account of every held opening deposit pool) and the held opening pools' amounts per currency.
 */
async function depositControlsAndHeldOpening(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  heldRows: ReadonlyArray<{ purpose: string; accountId: Id<"chartOfAccounts">; currency: string; amountMinor: number }>
): Promise<{ controls: Set<Id<"chartOfAccounts">>; heldOpeningMinor: Record<string, number> }> {
  const controls = new Set<Id<"chartOfAccounts">>();
  const native = await ctx.db
    .query("chartOfAccounts")
    .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY))
    .unique();
  if (native) controls.add(native._id);
  const heldOpeningMinor: Record<string, number> = {};
  for (const row of heldRows) {
    if (row.purpose !== "CUSTOMER_DEPOSIT") continue;
    controls.add(row.accountId);
    heldOpeningMinor[row.currency] = (heldOpeningMinor[row.currency] ?? 0) + row.amountMinor;
  }
  return { controls, heldOpeningMinor };
}

/** GL credit minus debit on the customer-deposit control accounts, per currency, as of the cutoff. */
async function depositControlGlByCurrency(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  controls: ReadonlySet<Id<"chartOfAccounts">>,
  cutoff: number
): Promise<Map<string, number>> {
  const byCurrency = new Map<string, number>();
  for (const balance of await getCumulativeBalancesAsOf(ctx, orgId, cutoff)) {
    if (!controls.has(balance.accountId)) continue;
    byCurrency.set(balance.currency, (byCurrency.get(balance.currency) ?? 0) + balance.creditMinor - balance.debitMinor);
  }
  return byCurrency;
}

export async function computeCustomerDepositsReconciliation(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  toDate: number | undefined
): Promise<CustomerDepositsReconciliationResult> {
  // ONE effective cutoff for the guard, the opening-pool read and the ledger read. An omitted `toDate`
  // is "now", and "now" gets the same activity guard as an explicit date: a sale dated tomorrow, or an
  // opening dated tomorrow, is later than now exactly as it is later than any earlier cutoff.
  // NaN and +/-Infinity pass `v.number()`, and every comparison against NaN is false, so an unchecked
  // value would read as "nothing is later" and be handed to the ledger read as a cutoff.
  const cutoff = toDate ?? Date.now();
  if (!Number.isFinite(cutoff)) return unavailableDepositsReconciliation("INVALID_DATE");
  const orgCurrency = await getOrgCurrencyForReports(ctx, orgId);
  const allRows = await ctx.db
    .query("deposits")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
  const scan = await scanDepositActivityAfter(ctx, allRows, cutoff);
  if (scan !== "CLEAR") return unavailableDepositsReconciliation(scan);

  const subByCurrency = await outstandingDepositsByCurrency(ctx, allRows, orgCurrency);

  const held = await readOpeningUnallocatedLiabilities(ctx, orgId, cutoff);
  if (held.status === "UNAVAILABLE") return unavailableDepositsReconciliation("OPENING_SOURCE_UNAVAILABLE");
  const { controls, heldOpeningMinor } = await depositControlsAndHeldOpening(ctx, orgId, held.rows);
  for (const [currency, amountMinor] of Object.entries(heldOpeningMinor)) {
    subByCurrency.set(currency, (subByCurrency.get(currency) ?? 0) + amountMinor);
  }
  const glByCurrency = await depositControlGlByCurrency(ctx, orgId, controls, cutoff);
  return labelDepositsOpeningDifference(ctx, orgId, {
    ...combineGlAndSubledger(glByCurrency, subByCurrency),
    heldOpeningMinor,
    attributionStatus: Object.keys(heldOpeningMinor).length ? "UNALLOCATED" : "ATTRIBUTED",
  });
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
  const asOfDate = toDate ?? Date.now();
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
  const { bySale: recognizedBySale, byLine: recognizedByLine } = await computeRecognizedCommissionAsOf(
    ctx,
    orgId,
    asOfDate
  );

  const subledgerMinor = new Map<string, number>();
  // Extra deal commission lines are their own subledger: each owes the payable
  // until payroll pays it. Settled at or before the reporting date means the GL
  // had already cleared it; a removed line has recognized nothing left (its
  // reversal is netted in the recognition read).
  for (const [lineId, recognized] of recognizedByLine) {
    const normalized = ctx.db.normalizeId("dealCommissionLines", lineId);
    const line = normalized ? await ctx.db.get(normalized) : null;
    if (!line || line.orgId !== orgId) continue;
    if (line.paidAt !== undefined && line.paidAt <= asOfDate) continue;
    for (const [currency, minor] of recognized) {
      subledgerMinor.set(currency, (subledgerMinor.get(currency) ?? 0) + minor);
    }
  }
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
    if (sale.commissionPaidAt != null && sale.commissionPaidAt <= asOfDate) {
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

  const openingRows = await ctx.db.query("openingCommissionLiabilities").withIndex("by_org", q => q.eq("orgId", orgId)).take(101);
  if (openingRows.length > 100) throw new ConvexError("Opening commission reconciliation is unavailable.");
  const controlAccounts = new Set<Id<"chartOfAccounts">>();
  const canonical = await ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", q => q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.COMMISSION_PAYABLE)).unique();
  if (canonical) controlAccounts.add(canonical._id);
  const openingReader = createOpeningSettlementReader(ctx, orgId);
  for (const row of openingRows) {
    const source = await openingCommissionRemainingAsOf(ctx, orgId, row._id, asOfDate, openingReader);
    if (source.kind !== "AVAILABLE") throw new ConvexError(source.reason);
    controlAccounts.add(source.accountId);
    subledgerMinor.set(row.currency, (subledgerMinor.get(row.currency) ?? 0) + source.remainingMinor);
  }

  const subByCurrency = new Map<string, number>();
  // `!== 0`, not `> 0`: a negative total is exactly the kind of discrepancy this
  // report exists to surface, and suppressing it reported a clean zero instead.
  for (const [currency, minor] of subledgerMinor) {
    if (minor !== 0) subByCurrency.set(currency, minor);
  }

  // Match the actual balance-sheet consumer: closed balances use native snapshots.
  const glByCurrency = new Map<string, number>();
  const balances = await getCumulativeBalancesAsOf(ctx, orgId, asOfDate);
  for (const balance of balances) {
    if (!controlAccounts.has(balance.accountId)) continue;
    const account = await ctx.db.get(balance.accountId);
    if (!account || account.orgId !== orgId) throw new ConvexError("Commission control account is unavailable.");
    const minor = account.normalBalance === "CREDIT" ? balance.creditMinor - balance.debitMinor : balance.debitMinor - balance.creditMinor;
    if (!Number.isSafeInteger(minor)) throw new ConvexError("Commission control balance is unavailable.");
    glByCurrency.set(balance.currency, (glByCurrency.get(balance.currency) ?? 0) + minor);
  }
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
): Promise<{ bySale: Map<string, Map<string, number>>; byLine: Map<string, Map<string, number>> }> {
  // by_org_eventType_status_date loads one event type, one status, for just its
  // own window instead of the org's whole history (this runs inside the close
  // checklist). POSTED and REVERSED are two reads merged back into accountingDate order.
  const inWindow = async (eventType: "COMMISSION_ACCRUED" | "COMMISSION_ADJUSTED") => {
    const read = (status: "POSTED" | "REVERSED") =>
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org_eventType_status_date", (q) => {
          const scoped = q.eq("orgId", orgId).eq("eventType", eventType).eq("status", status);
          return toDate === undefined ? scoped : scoped.lte("accountingDate", toDate);
        })
        .collect();
    const [posted, reversed] = await Promise.all([read("POSTED"), read("REVERSED")]);
    return mergeByCreation([posted, reversed], (e) => e.accountingDate);
  };

  const recognized = new Map<string, Map<string, number>>();
  // Extra deal commission lines carry `payload.lineId`. They are kept apart from
  // the sale's own commission so the divergence control (recognized vs the
  // decided sale amount) is not disturbed by them.
  const recognizedLines = new Map<string, Map<string, number>>();
  const add = (saleId: unknown, minor: unknown, currency: string, lineId?: string) => {
    if (typeof saleId !== "string" || typeof minor !== "number" || !Number.isFinite(minor)) return;
    const target = lineId !== undefined ? recognizedLines : recognized;
    const key = lineId ?? saleId;
    const byCurrency = target.get(key) ?? new Map<string, number>();
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + minor);
    target.set(key, byCurrency);
  };

  const wasLiveAt = async (event: Doc<"accountingEvents">): Promise<boolean> => {
    if (event.status !== "REVERSED") return true;
    if (!event.reversedByEventId) return false;
    const reversal = await ctx.db.get(event.reversedByEventId);
    if (!reversal || reversal.orgId !== orgId) return false;
    return toDate !== undefined && reversal.accountingDate > toDate;
  };

  for (const e of await inWindow("COMMISSION_ACCRUED")) {
    if (await wasLiveAt(e)) add(e.payload?.saleId, e.payload?.amountMinor, e.currency, e.sourceType === "dealCommissionLines" ? e.sourceId : undefined);
  }
  for (const e of await inWindow("COMMISSION_ADJUSTED")) {
    if (await wasLiveAt(e)) add(e.payload?.saleId, e.payload?.deltaMinor, e.currency);
  }
  return { bySale: recognized, byLine: recognizedLines };
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
  const { bySale: recognized } = await computeRecognizedCommissionAsOf(ctx, orgId, undefined);
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
