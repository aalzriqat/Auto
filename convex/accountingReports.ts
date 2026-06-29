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
import { fromMinorUnits } from "./utils/money";

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function getPostedLines(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  fromDate?: number,
  toDate?: number
) {
  const entries = await ctx.db
    .query("journalEntries")
    .withIndex("by_org_date", (q) => q.eq("orgId", orgId))
    .filter((q) => q.eq(q.field("status"), "POSTED"))
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
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);

    // Include all accounts (active and inactive) so historical postings on
    // deactivated accounts still appear in the trial balance.
    const accounts = await ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    const lines = await getPostedLines(ctx, args.orgId, args.fromDate, args.toDate);

    const totals = new Map<string, { debitMinor: number; creditMinor: number }>();

    for (const line of lines) {
      const key = line.accountId;
      const existing = totals.get(key) ?? { debitMinor: 0, creditMinor: 0 };
      existing.debitMinor += line.debitMinor;
      existing.creditMinor += line.creditMinor;
      totals.set(key, existing);
    }

    const rows = accounts.map((account) => {
      const t = totals.get(account._id) ?? { debitMinor: 0, creditMinor: 0 };
      const netMinor = account.normalBalance === "DEBIT"
        ? t.debitMinor - t.creditMinor
        : t.creditMinor - t.debitMinor;
      return {
        accountId: account._id,
        code: account.code,
        name: account.name,
        nameAr: account.nameAr,
        type: account.type,
        normalBalance: account.normalBalance,
        debitMinor: t.debitMinor,
        creditMinor: t.creditMinor,
        netMinor,
        netDisplay: fromMinorUnits(netMinor, "JOD"),
      };
    }).filter((r) => r.debitMinor > 0 || r.creditMinor > 0);

    const totalDebits = rows.reduce((s, r) => s + r.debitMinor, 0);
    const totalCredits = rows.reduce((s, r) => s + r.creditMinor, 0);
    const isBalanced = totalDebits === totalCredits;

    return { rows, totalDebits, totalCredits, isBalanced };
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

    const accounts = await ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    const lines = await getPostedLines(ctx, args.orgId, args.fromDate, args.toDate);

    const accountMap = new Map(accounts.map((a) => [a._id, a]));
    const totals = new Map<string, number>();

    for (const line of lines) {
      const account = accountMap.get(line.accountId);
      if (!account) continue;
      const type = account.type;
      if (!["REVENUE", "COGS", "EXPENSE", "OTHER_INCOME", "OTHER_EXPENSE"].includes(type)) continue;

      const existing = totals.get(line.accountId) ?? 0;
      const net = account.normalBalance === "CREDIT"
        ? line.creditMinor - line.debitMinor
        : line.debitMinor - line.creditMinor;
      totals.set(line.accountId, existing + net);
    }

    const revenueAccounts = accounts.filter((a) => a.type === "REVENUE");
    const cogsAccounts = accounts.filter((a) => a.type === "COGS");
    const expenseAccounts = accounts.filter((a) => a.type === "EXPENSE");
    const otherIncomeAccounts = accounts.filter((a) => a.type === "OTHER_INCOME");
    const otherExpenseAccounts = accounts.filter((a) => a.type === "OTHER_EXPENSE");

    const toRows = (accts: typeof accounts) =>
      accts
        .map((a) => ({ accountId: a._id, code: a.code, name: a.name, nameAr: a.nameAr, type: a.type, netMinor: totals.get(a._id) ?? 0 }))
        .filter((r) => r.netMinor !== 0);

    const totalRevenue = revenueAccounts.reduce((s, a) => s + (totals.get(a._id) ?? 0), 0);
    const totalCogs = cogsAccounts.reduce((s, a) => s + (totals.get(a._id) ?? 0), 0);
    const grossProfit = totalRevenue - totalCogs;
    const totalExpenses = expenseAccounts.reduce((s, a) => s + (totals.get(a._id) ?? 0), 0);
    const totalOtherIncome = otherIncomeAccounts.reduce((s, a) => s + (totals.get(a._id) ?? 0), 0);
    const totalOtherExpenses = otherExpenseAccounts.reduce((s, a) => s + (totals.get(a._id) ?? 0), 0);
    const netIncome = grossProfit - totalExpenses + totalOtherIncome - totalOtherExpenses;

    return {
      revenueRows: toRows(revenueAccounts),
      cogsRows: toRows(cogsAccounts),
      expenseRows: toRows(expenseAccounts),
      otherIncomeRows: toRows(otherIncomeAccounts),
      otherExpenseRows: toRows(otherExpenseAccounts),
      totalRevenue,
      totalCogs,
      grossProfit,
      totalExpenses,
      totalOtherIncome,
      totalOtherExpenses,
      netIncome,
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

    const accounts = await ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    const lines = await getPostedLines(ctx, args.orgId, undefined, args.asOfDate);

    const accountMap = new Map(accounts.map((a) => [a._id, a]));
    const totals = new Map<string, number>();

    // Compute net balance per account (all types including P&L for net income)
    for (const line of lines) {
      const account = accountMap.get(line.accountId);
      if (!account) continue;
      const existing = totals.get(line.accountId) ?? 0;
      const net = account.normalBalance === "DEBIT"
        ? line.debitMinor - line.creditMinor
        : line.creditMinor - line.debitMinor;
      totals.set(line.accountId, existing + net);
    }

    const toRows = (accts: typeof accounts) =>
      accts
        .map((a) => ({ accountId: a._id, code: a.code, name: a.name, nameAr: a.nameAr, type: a.type, netMinor: totals.get(a._id) ?? 0 }))
        .filter((r) => r.netMinor !== 0);

    const assetRows = toRows(accounts.filter((a) => a.type === "ASSET"));
    const liabilityRows = toRows(accounts.filter((a) => a.type === "LIABILITY"));
    const equityRows = toRows(accounts.filter((a) => a.type === "EQUITY"));

    const totalAssets = assetRows.reduce((s, r) => s + r.netMinor, 0);
    const totalLiabilities = liabilityRows.reduce((s, r) => s + r.netMinor, 0);
    const totalEquity = equityRows.reduce((s, r) => s + r.netMinor, 0);

    // Current-period net income: Revenue + OtherIncome - COGS - Expense - OtherExpense
    // Folded into equity for the balance-sheet equation before period closing.
    let netIncomeMinor = 0;
    for (const account of accounts) {
      const net = totals.get(account._id) ?? 0;
      if (account.type === "REVENUE" || account.type === "OTHER_INCOME") {
        netIncomeMinor += net;
      } else if (account.type === "COGS" || account.type === "EXPENSE" || account.type === "OTHER_EXPENSE") {
        netIncomeMinor -= net;
      }
    }

    return {
      assetRows, liabilityRows, equityRows,
      totalAssets, totalLiabilities, totalEquity, netIncomeMinor,
      // Assets = Liabilities + Equity + Current-period Net Income (pre-close)
      isBalanced: totalAssets === totalLiabilities + totalEquity + netIncomeMinor,
    };
  },
});

// ─── AR Aging ─────────────────────────────────────────────────────────────────

export const arAging = query({
  args: {
    orgId: v.id("organizations"),
    asOfDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);

    const asOfDate = args.asOfDate ?? Date.now();

    // Only include receivables issued on or before asOfDate for historical accuracy
    const openReceivables = await ctx.db
      .query("receivableDocuments")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "OPEN"))
      .filter((q) => q.lte(q.field("issueDate"), asOfDate))
      .collect();

    const partialReceivables = await ctx.db
      .query("receivableDocuments")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "PARTIALLY_PAID"))
      .filter((q) => q.lte(q.field("issueDate"), asOfDate))
      .collect();

    const allOpen = [...openReceivables, ...partialReceivables];

    const buckets = { current: 0, days30: 0, days60: 0, days90: 0, over90: 0 };
    const rows: Array<{
      receivableId: string;
      customerId: string | undefined;
      dueDate: number;
      originalAmountMinor: number;
      outstandingMinor: number;
      ageDays: number;
      bucket: string;
    }> = [];

    for (const rec of allOpen) {
      // Only count allocations that existed as of asOfDate
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
      type AgingBucket = keyof typeof buckets;
      let bucket: AgingBucket;
      if (ageDays <= 0) { bucket = "current"; }
      else if (ageDays <= 30) { bucket = "days30"; }
      else if (ageDays <= 60) { bucket = "days60"; }
      else if (ageDays <= 90) { bucket = "days90"; }
      else { bucket = "over90"; }
      buckets[bucket] += outstanding;

      rows.push({
        receivableId: rec._id,
        customerId: rec.customerId?.toString(),
        dueDate: rec.dueDate,
        originalAmountMinor: rec.originalAmountMinor,
        outstandingMinor: outstanding,
        ageDays,
        bucket,
      });
    }

    return { rows, buckets, totalOutstandingMinor: Object.values(buckets).reduce((s, v) => s + v, 0) };
  },
});

// ─── Subledger-to-GL Reconciliation ──────────────────────────────────────────

export const subledgerReconciliation = query({
  args: {
    orgId: v.id("organizations"),
    fromDate: v.optional(v.number()),
    toDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);

    // GL total for AR accounts — cumulative from inception to toDate so the
    // basis matches the subledger outstanding balance (not period movement).
    const accounts = await ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org_type", (q) => q.eq("orgId", args.orgId).eq("type", "ASSET"))
      .filter((q) => q.neq(q.field("systemKey"), null))
      .collect();

    const arAccountIds = new Set(accounts.filter((a) =>
      a.systemKey === "accounts_receivable_customers" || a.systemKey === "accounts_receivable_finance_companies"
    ).map((a) => a._id));

    const lines = await getPostedLines(ctx, args.orgId, undefined, args.toDate);
    const arLines = lines.filter((l) => arAccountIds.has(l.accountId));
    const glArBalanceMinor = arLines.reduce((s, l) => s + l.debitMinor - l.creditMinor, 0);

    // Subledger total (open + partial receivables issued on or before toDate)
    const effectiveAsOf = args.toDate ?? Date.now();
    const openRecs = await ctx.db
      .query("receivableDocuments")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "OPEN"))
      .filter((q) => q.lte(q.field("issueDate"), effectiveAsOf))
      .collect();
    const partialRecs = await ctx.db
      .query("receivableDocuments")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "PARTIALLY_PAID"))
      .filter((q) => q.lte(q.field("issueDate"), effectiveAsOf))
      .collect();

    let subledgerOutstandingMinor = 0;
    for (const rec of [...openRecs, ...partialRecs]) {
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
      subledgerOutstandingMinor += Math.max(0, rec.originalAmountMinor - allocated);
    }

    const discrepancyMinor = glArBalanceMinor - subledgerOutstandingMinor;

    return {
      glArBalanceMinor,
      subledgerOutstandingMinor,
      discrepancyMinor,
      isReconciled: discrepancyMinor === 0,
    };
  },
});
