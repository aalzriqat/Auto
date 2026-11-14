import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { isSystemOwnerRole, normalizeRoleName, PERMISSIONS } from "./utils/permissions";
import { addBalanceMinor, supportedCurrencyScale } from "./utils/money";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import { getControlAccountBalancesAsOf } from "./accounting/accountSnapshots";
import { BOOK_BALANCE_READ_BUDGET, computeBankBalances } from "./accounting/bankBookBalances";

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

export const bankInventory = query({
  args: { orgId: v.id("organizations"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { orgId, paginationOpts }) => {
    const { membership, role } = await requireTenantAuth(ctx, orgId);
    if (role.orgId !== orgId || role.isDeleted || membership.impersonationGrantId ||
        (!isSystemOwnerRole(role) &&
          !(normalizeRoleName(role.name) === "MANAGER" && role.permissions.includes(PERMISSIONS.VIEW_REPORTS)))) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const result = await ctx.db.query("bankAccounts").withIndex("by_org", (q) => q.eq("orgId", orgId))
      .filter((q) => q.neq(q.field("isDeleted"), true))
      .paginate({
        ...paginationOpts, numItems: Math.min(paginationOpts.numItems, 30),
        maximumRowsRead: 1_000, maximumBytesRead: 1_000_000,
      });
    return {
      ...result,
      page: result.page.map((bank) => ({ id: bank._id, name: bank.name, active: bank.isActive, currency: bank.currency })),
    };
  },
});

export const liquidity = query({
  args: { orgId: v.id("organizations"), asOf: v.optional(v.number()) },
  returns: v.union(v.null(), v.object({
    cash: v.array(liquidityAmount),
    banks: v.union(v.null(), v.array(v.object({
      id: v.id("bankAccounts"),
      balanceMinor: v.number(),
    }))),
  })),
  handler: async (ctx, { orgId, asOf: requestedAsOf }) => {
    const { membership, role } = await requireTenantAuth(ctx, orgId);
    if (role.orgId !== orgId || role.isDeleted || membership.impersonationGrantId ||
        (!isSystemOwnerRole(role) &&
          !(normalizeRoleName(role.name) === "MANAGER" && role.permissions.includes(PERMISSIONS.VIEW_REPORTS)))) {
      return null;
    }

    try {
      const now = Date.now();
      const asOf = requestedAsOf !== undefined && Number.isSafeInteger(requestedAsOf)
        ? Math.min(now, Math.max(now - 120_000, requestedAsOf))
        : now;
      const org = await ctx.db.get(orgId);
      if (!org || (org.financialResetGeneration ?? 0) !== (org.financialResetCompletedGeneration ?? 0)) {
        return { cash: [], banks: null };
      }
      const [cash, bankBalances] = await Promise.all([
        readDashboardCash(ctx, orgId, asOf),
        computeBankBalances(ctx, orgId, asOf, BOOK_BALANCE_READ_BUDGET),
      ]);
      return {
        cash,
        banks: bankBalances.flatMap((bank) => bank.status === "OK" && !bank.isDeleted &&
          bank.bankAccountId !== null && bank.balanceMinor !== null &&
          bank.currency !== null && supportedCurrencyScale(bank.currency) !== null
          ? [{ id: bank.bankAccountId, balanceMinor: bank.balanceMinor }] : []),
      };
    } catch (error) {
      console.error("Dashboard liquidity could not be verified", { orgId, error });
      return { cash: [], banks: null };
    }
  },
});
