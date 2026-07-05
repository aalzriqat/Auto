/**
 * Phase 41 — VAT Return summary.
 *
 * Output VAT = activity on SYSTEM_KEYS.SALES_TAX_PAYABLE (credited on sales,
 * per ruleSaleCompleted). Input VAT = activity on SYSTEM_KEYS.VAT_RECEIVABLE
 * (debited on expenses/supplier payments, per ruleExpensePosted /
 * ruleSupplierPaymentSettled). Follows the exact two-tier pattern already
 * used by convex/accountingReports.ts: a two-sided date range (the normal
 * shape for a VAT return period) does a full scan via getPostedLines; a
 * from-inception "as of" query reads the GL Phase 18 running snapshots.
 * This report is a summary for the accountant's own filing process, not a
 * jurisdiction-specific filing form.
 */
import { v } from "convex/values";
import { query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { QueryCtx } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { requireFeature } from "./subscriptions";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import { getPostedLines } from "./accountingReports";
import { getCumulativeBalancesAsOf } from "./accounting/accountSnapshots";

function currencyKey(accountId: string, currency: string): string {
  return `${accountId}__${currency}`;
}

async function findChartAccountId(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  systemKey: string
): Promise<Id<"chartOfAccounts"> | null> {
  const account = await ctx.db
    .query("chartOfAccounts")
    .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", systemKey))
    .unique();
  return account?._id ?? null;
}

export const generateVatSummary = query({
  args: {
    orgId: v.id("organizations"),
    fromDate: v.optional(v.number()),
    toDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const [outputAccountId, inputAccountId] = await Promise.all([
      findChartAccountId(ctx, args.orgId, SYSTEM_KEYS.SALES_TAX_PAYABLE),
      findChartAccountId(ctx, args.orgId, SYSTEM_KEYS.VAT_RECEIVABLE),
    ]);

    const totals = new Map<string, { accountId: string; currency: string; debitMinor: number; creditMinor: number }>();

    if (args.fromDate === undefined) {
      const balances = await getCumulativeBalancesAsOf(ctx, args.orgId, args.toDate ?? Date.now());
      for (const b of balances) {
        totals.set(currencyKey(b.accountId, b.currency), { accountId: b.accountId, currency: b.currency, debitMinor: b.debitMinor, creditMinor: b.creditMinor });
      }
    } else {
      const lines = await getPostedLines(ctx, args.orgId, args.fromDate, args.toDate);
      for (const line of lines) {
        if (line.accountId !== outputAccountId && line.accountId !== inputAccountId) continue;
        const key = currencyKey(line.accountId, line.currency);
        const existing = totals.get(key) ?? { accountId: line.accountId as string, currency: line.currency, debitMinor: 0, creditMinor: 0 };
        existing.debitMinor += line.debitMinor;
        existing.creditMinor += line.creditMinor;
        totals.set(key, existing);
      }
    }

    const byCurrency = new Map<string, { outputVatMinor: number; inputVatMinor: number }>();
    for (const t of totals.values()) {
      const entry = byCurrency.get(t.currency) ?? { outputVatMinor: 0, inputVatMinor: 0 };
      if (t.accountId === outputAccountId) {
        // SALES_TAX_PAYABLE is CREDIT-normal — collected VAT increases the credit side.
        entry.outputVatMinor += t.creditMinor - t.debitMinor;
      }
      if (t.accountId === inputAccountId) {
        // VAT_RECEIVABLE is DEBIT-normal — paid/reclaimable VAT increases the debit side.
        entry.inputVatMinor += t.debitMinor - t.creditMinor;
      }
      byCurrency.set(t.currency, entry);
    }

    const lines = [...byCurrency.entries()].map(([currency, v2]) => ({
      currency,
      outputVatMinor: v2.outputVatMinor,
      inputVatMinor: v2.inputVatMinor,
      netDueMinor: v2.outputVatMinor - v2.inputVatMinor,
    }));

    const orgSettings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
    const primaryCurrency = orgSettings?.currency ?? "JOD";
    const primary = lines.find((l) => l.currency === primaryCurrency) ?? {
      currency: primaryCurrency,
      outputVatMinor: 0,
      inputVatMinor: 0,
      netDueMinor: 0,
    };

    return {
      currency: primary.currency,
      outputVatMinor: primary.outputVatMinor,
      inputVatMinor: primary.inputVatMinor,
      netDueMinor: primary.netDueMinor,
      lines,
      fromDate: args.fromDate ?? null,
      toDate: args.toDate ?? Date.now(),
    };
  },
});
