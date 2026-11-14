import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { isSystemOwnerRole, normalizeRoleName, PERMISSIONS } from "./utils/permissions";
import { addBalanceMinor, supportedCurrencyScale } from "./utils/money";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import { getControlAccountBalancesAsOf } from "./accounting/accountSnapshots";
import { BOOK_BALANCE_READ_BUDGET, computeBankBalances } from "./accounting/bankBookBalances";

const DASHBOARD_BANK_LIMIT = 250;
const liquidityAmount = v.object({
  currency: v.string(),
  balanceMinor: v.union(v.number(), v.null()),
});

async function readDashboardCash(ctx: QueryCtx, orgId: Id<"organizations">, asOf: number) {
  const [settings, controls] = await Promise.all([
    ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique(),
    ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) =>
      q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.CASH_ON_HAND)).take(2),
  ]);
  const currency = settings?.currency ?? "JOD";
  const unavailable = [{ currency, balanceMinor: null }];
  if (controls.length !== 1 || !controls[0].active) return unavailable;

  const result = await getControlAccountBalancesAsOf(
    ctx, orgId, [controls[0]._id], asOf, BOOK_BALANCE_READ_BUDGET, true,
  );
  if (result.status !== "OK") return unavailable;

  const balances = new Map([[currency, 0]]);
  for (const row of result.balances) {
    balances.set(row.currency, addBalanceMinor(row.debitMinor, -row.creditMinor));
  }
  return [...balances].sort(([left], [right]) => left.localeCompare(right)).map(([code, balanceMinor]) => ({
    currency: code,
    balanceMinor: supportedCurrencyScale(code) === null ? null : balanceMinor,
  }));
}

export const liquidity = query({
  args: { orgId: v.id("organizations") },
  returns: v.union(v.null(), v.object({
    cash: v.array(liquidityAmount),
    banks: v.union(v.null(), v.array(v.object({
      id: v.id("bankAccounts"),
      name: v.string(),
      active: v.boolean(),
      currency: v.string(),
      balanceMinor: v.union(v.number(), v.null()),
    }))),
  })),
  handler: async (ctx, { orgId }) => {
    const { membership, role } = await requireTenantAuth(ctx, orgId);
    if (role.orgId !== orgId || role.isDeleted || membership.impersonationGrantId ||
        (!isSystemOwnerRole(role) &&
          !(normalizeRoleName(role.name) === "MANAGER" && role.permissions.includes(PERMISSIONS.VIEW_REPORTS)))) {
      return null;
    }

    try {
      const asOf = Date.now();
      const [org, rows] = await Promise.all([
        ctx.db.get(orgId),
        ctx.db.query("bankAccounts").withIndex("by_org", (q) => q.eq("orgId", orgId))
          .take(DASHBOARD_BANK_LIMIT + 1),
      ]);
      if (!org || (org.financialResetGeneration ?? 0) !== (org.financialResetCompletedGeneration ?? 0)) {
        return { cash: [], banks: null };
      }
      const accounts = rows.filter((row) => !row.isDeleted);
      const listComplete = rows.length <= DASHBOARD_BANK_LIMIT;
      const [cash, bankBalances] = await Promise.all([
        readDashboardCash(ctx, orgId, asOf),
        listComplete && accounts.length > 0
          ? computeBankBalances(ctx, orgId, asOf, BOOK_BALANCE_READ_BUDGET)
          : [],
      ]);
      const verified = new Map(bankBalances.filter((bank) => bank.status === "OK")
        .map((bank) => [bank.bankAccountId, bank.balanceMinor]));
      return {
        cash,
        banks: listComplete ? accounts.map((account) => ({
          id: account._id,
          name: account.name,
          active: account.isActive,
          currency: account.currency,
          balanceMinor: supportedCurrencyScale(account.currency) !== null ? verified.get(account._id) ?? null : null,
        })).sort((left, right) => left.name.localeCompare(right.name)) : null,
      };
    } catch (error) {
      console.error("Dashboard liquidity could not be verified", { orgId, error });
      return { cash: [], banks: null };
    }
  },
});

