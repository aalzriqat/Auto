import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { isSystemOwnerRole, normalizeRoleName, PERMISSIONS } from "./utils/permissions";
import { addBalanceMinor, supportedCurrencyScale } from "./utils/money";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import { getControlAccountBalancesAsOf } from "./accounting/accountSnapshots";
import { BOOK_BALANCE_READ_BUDGET, computeBankBalances } from "./accounting/bankBookBalances";

const liquidityAmount = v.object({
  currency: v.string(),
  balanceMinor: v.union(v.number(), v.null()),
});

type LiquidityAmount = { currency: string; balanceMinor: number | null };
type ControlAmount = { currency: string; debitMinor: number; creditMinor: number };

function sumByCurrency(amounts: LiquidityAmount[]): LiquidityAmount[] {
  const totals = new Map<string, number | null>();
  for (const { currency, balanceMinor } of amounts) {
    const previous = totals.get(currency);
    const sum = previous === null || balanceMinor === null ? null : (previous ?? 0) + balanceMinor;
    totals.set(currency, Number.isSafeInteger(sum) ? sum : null);
  }
  return [...totals].sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, balanceMinor]) => ({ currency, balanceMinor }));
}

function cashAmounts(currency: string, rows: ControlAmount[] | null) {
  if (rows === null) return { complete: false, figures: [{ currency, balanceMinor: null }] };
  const balances = new Map([[currency, 0]]);
  for (const row of rows) {
    balances.set(row.currency, addBalanceMinor(row.debitMinor, -row.creditMinor));
  }
  const figures = [...balances].sort(([left], [right]) => left.localeCompare(right)).map(([code, balanceMinor]) => ({
    currency: code,
    balanceMinor: supportedCurrencyScale(code) === null ? null : balanceMinor,
  }));
  return { complete: true, figures };
}

async function readLiquidityControls(ctx: QueryCtx, orgId: Id<"organizations">, asOf: number) {
  const controls = (systemKey: typeof SYSTEM_KEYS.CASH_ON_HAND | typeof SYSTEM_KEYS.BANK_ACCOUNT) =>
    ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", q =>
      q.eq("orgId", orgId).eq("systemKey", systemKey)).take(2);
  const [settings, cashAccounts, bankAccounts] = await Promise.all([
    ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique(),
    controls(SYSTEM_KEYS.CASH_ON_HAND),
    controls(SYSTEM_KEYS.BANK_ACCOUNT),
  ]);
  const currency = settings?.currency ?? "JOD";
  const cashId = cashAccounts.length === 1 && cashAccounts[0].active ? cashAccounts[0]._id : null;
  const bankId = bankAccounts.length === 1 && bankAccounts[0].active ? bankAccounts[0]._id : null;
  const ids = [cashId, bankId].filter(id => id !== null);
  if (!ids.length) return { cash: cashAmounts(currency, null), bankLedger: null };
  const result = await getControlAccountBalancesAsOf(
    ctx, orgId, ids, asOf, BOOK_BALANCE_READ_BUDGET, true,
  );
  // A bank history that exhausts the shared proof budget must not hide independently verified cash.
  const cashResult = result.status !== "OK" && cashId && bankId
    ? await getControlAccountBalancesAsOf(ctx, orgId, [cashId], asOf, BOOK_BALANCE_READ_BUDGET, true)
    : result;
  const bankLedger = bankId && result.status === "OK" ? result.balances.filter(row => row.accountId === bankId) : null;
  // A line can disprove empty history. Its amount never substitutes for a closed snapshot.
  const unprovedEmptyBank = bankId && bankLedger?.length === 0 && await ctx.db.query("journalLines")
    .withIndex("by_org_account_date", q => q.eq("orgId", orgId).eq("accountId", bankId).lte("accountingDate", asOf))
    .first();
  return {
    cash: cashAmounts(currency, cashId && cashResult.status === "OK"
      ? cashResult.balances.filter(row => row.accountId === cashId) : null),
    bankLedger: unprovedEmptyBank ? null : bankLedger,
  };
}

const bankFigure = v.object({ id: v.id("bankAccounts"), balanceMinor: v.number() });

function liquidityDate(requestedAsOf?: number) {
  const now = Date.now();
  return requestedAsOf !== undefined && Number.isSafeInteger(requestedAsOf)
    ? Math.min(now, Math.max(now - 120_000, requestedAsOf))
    : now;
}

function verifiedBankFigures(banks: Awaited<ReturnType<typeof computeBankBalances>>) {
  return banks.flatMap(bank => bank.status === "OK" && !bank.isDeleted &&
    bank.bankAccountId !== null && bank.balanceMinor !== null &&
    bank.currency !== null && supportedCurrencyScale(bank.currency) !== null
    ? [{ id: bank.bankAccountId, balanceMinor: bank.balanceMinor }] : []);
}

function bankTotalsByCurrency(banks: Awaited<ReturnType<typeof computeBankBalances>>, ledger: ControlAmount[] | null) {
  if (ledger === null) return null;
  const figures: LiquidityAmount[] = [];
  for (const bank of banks) {
    // An unidentified result means the full inventory could not be measured.
    if (bank.currency === null) return null;
    figures.push({
      currency: bank.currency,
      balanceMinor: bank.status === "OK" && supportedCurrencyScale(bank.currency) !== null
        ? bank.balanceMinor : null,
    });
  }
  const totals = new Map(sumByCurrency(figures).map(row => [row.currency, row.balanceMinor]));
  for (const { currency, debitMinor, creditMinor } of ledger) {
    // A posted currency without a bank row is unverified even when its debits and credits offset.
    if (!totals.has(currency) && debitMinor === 0 && creditMinor === 0) continue;
    if (totals.get(currency) !== addBalanceMinor(debitMinor, -creditMinor)) totals.set(currency, null);
  }
  return [...totals].sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, balanceMinor]) => ({ currency, balanceMinor }));
}

export const bankInventory = query({
  args: { orgId: v.id("organizations"), paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(v.object({
      id: v.id("bankAccounts"), name: v.string(), active: v.boolean(), currency: v.string(),
    })),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(v.union(v.literal("SplitRecommended"), v.literal("SplitRequired"), v.null())),
  }),
  handler: async (ctx, { orgId, paginationOpts }) => {
    const { membership, role } = await requireTenantAuth(ctx, orgId);
    if (role.orgId !== orgId || role.isDeleted || membership.impersonationGrantId ||
        (!isSystemOwnerRole(role) &&
          !(normalizeRoleName(role.name) === "MANAGER" && role.permissions.includes(PERMISSIONS.VIEW_REPORTS)))) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const result = await ctx.db.query("bankAccounts").withIndex("by_org_deleted", (q) => q.eq("orgId", orgId).lt("isDeleted", true))
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
    banks: v.union(v.null(), v.array(bankFigure)),
    bankTotals: v.union(v.null(), v.array(liquidityAmount)),
    cashAndBankTotals: v.union(v.null(), v.array(liquidityAmount)),
  })),
  handler: async (ctx, { orgId, asOf: requestedAsOf }) => {
    const { membership, role } = await requireTenantAuth(ctx, orgId);
    if (role.orgId !== orgId || role.isDeleted || membership.impersonationGrantId ||
        (!isSystemOwnerRole(role) &&
          !(normalizeRoleName(role.name) === "MANAGER" && role.permissions.includes(PERMISSIONS.VIEW_REPORTS)))) return null;

    const unavailable = { cash: [], banks: null, bankTotals: null, cashAndBankTotals: null };
    try {
      const asOf = liquidityDate(requestedAsOf);
      const org = await ctx.db.get(orgId);
      if (!org || (org.financialResetGeneration ?? 0) !== (org.financialResetCompletedGeneration ?? 0)) {
        return unavailable;
      }
      const [{ cash, bankLedger }, bankBalances] = await Promise.all([
        readLiquidityControls(ctx, orgId, asOf),
        computeBankBalances(ctx, orgId, asOf, BOOK_BALANCE_READ_BUDGET),
      ]);
      const bankTotals = bankTotalsByCurrency(bankBalances, bankLedger);
      return {
        cash: cash.figures,
        banks: verifiedBankFigures(bankBalances),
        bankTotals,
        cashAndBankTotals: cash.complete && bankTotals ? sumByCurrency([...cash.figures, ...bankTotals]) : null,
      };
    } catch (error) {
      console.error("Dashboard liquidity could not be verified", { orgId, error });
      return unavailable;
    }
  },
});

export const bankBalancesForPage = query({
  args: { orgId: v.id("organizations"), bankIds: v.array(v.id("bankAccounts")), asOf: v.optional(v.number()) },
  returns: v.array(bankFigure),
  handler: async (ctx, { orgId, bankIds, asOf }) => {
    const { membership, role } = await requireTenantAuth(ctx, orgId);
    if (role.orgId !== orgId || role.isDeleted || membership.impersonationGrantId ||
        (!isSystemOwnerRole(role) &&
          !(normalizeRoleName(role.name) === "MANAGER" && role.permissions.includes(PERMISSIONS.VIEW_REPORTS)))) return [];
    if (bankIds.length > 12) throw new ConvexError("Choose up to 12 bank accounts.");
    const selected = await Promise.all([...new Set(bankIds)].map(id => requireOwnedRow(ctx, orgId, "bankAccounts", id)));
    const visible = selected.filter(bank => !bank.isDeleted);
    return verifiedBankFigures(await computeBankBalances(ctx, orgId, liquidityDate(asOf), BOOK_BALANCE_READ_BUDGET, visible));
  },
});
