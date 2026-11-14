import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { SYSTEM_KEYS } from "../utils/defaultChart";
import { addBalanceMinor, isUnsafeBalanceError } from "../utils/money";
import { BANK_AGGREGATE_LAYOUT, bankAggregateNamespace, readAttributionRanges, readControlRanges } from "./bankLineAggregate";

/**
 * Documents one getBookBalance call may read - periods, snapshots, lines and
 * entry lookups together - before it reports BALANCE_HISTORY_INCOMPLETE. A
 * placeholder set well under Convex's per-query read limits; it is not measured
 * on a real deployment, so calibrate it on a preview before relying on it.
 */
export const BOOK_BALANCE_READ_BUDGET = 4000;

class ReadBudgetExhausted extends Error {}

/** Missing or inconsistent readiness, history, precision, or accounting period facts. */
class InconsistentHistory extends Error {}

function chargeDocs(budget: { remaining: number }, count: number): void {
  if (count > budget.remaining) throw new ReadBudgetExhausted();
  budget.remaining -= count;
}

/** An aggregate can be read only after its full control-account history is projected. */
async function readyBankAggregateNamespace(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  accountId: Id<"chartOfAccounts">,
  budget: { remaining: number },
): Promise<string> {
  chargeDocs(budget, 1);
  const org = await ctx.db.get(orgId);
  if (!org) throw new InconsistentHistory();
  const resetGeneration = org.financialResetGeneration ?? 0;
  if ((org.financialResetCompletedGeneration ?? 0) !== resetGeneration) throw new InconsistentHistory();
  const mappingGeneration = org.bankAggregateMappingGeneration ?? 0;
  const namespace = bankAggregateNamespace(orgId, resetGeneration, mappingGeneration);
  const states = await takeWithinBudget(
    budget,
    ctx.db.query("bankBalanceAggregateStates").withIndex("by_org", (q) => q.eq("orgId", orgId)),
  );
  if (states.length > 1) throw new InconsistentHistory();
  const state = states[0];
  if (!state) {
    // Only a genuinely empty control history may use an empty tree without a
    // backfill certificate. This is the first-day organization path.
    chargeDocs(budget, 1);
    const first = await ctx.db.query("journalLines")
      .withIndex("by_org_account", (q) => q.eq("orgId", orgId).eq("accountId", accountId))
      .first();
    if (first) throw new InconsistentHistory();
    return namespace;
  }
  if (state.status !== "READY" || state.controlAccountId !== accountId ||
      state.resetGeneration !== resetGeneration || state.mappingGeneration !== mappingGeneration ||
      state.layout !== BANK_AGGREGATE_LAYOUT ||
      !Number.isSafeInteger(state.grossAbsMinor)) {
    throw new InconsistentHistory();
  }
  return namespace;
}

/** Reads at most the remaining budget; one row more proves the budget is exceeded. */
async function takeWithinBudget<T>(budget: { remaining: number }, query: { take(n: number): Promise<T[]> }): Promise<T[]> {
  const rows = await query.take(budget.remaining + 1);
  chargeDocs(budget, rows.length);
  return rows;
}

/**
 * `resolveSystemAccount(ctx, orgId, SYSTEM_KEYS.BANK_ACCOUNT)` with its read spent
 * from the shared budget (that helper uses an unbounded `.collect()`). The choice
 * is identical: the earliest-created ACTIVE row, a refusal when none is mapped, and
 * a refusal when only inactive rows exist. Keep the two in step.
 */
async function resolveBankControlAccount(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  budget: { remaining: number }
): Promise<Id<"chartOfAccounts">> {
  const systemKey = SYSTEM_KEYS.BANK_ACCOUNT;
  const accounts = await takeWithinBudget(
    budget,
    ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", systemKey))
  );
  if (accounts.length === 0) {
    throw new ConvexError(
      `System account "${systemKey}" is not mapped for this organization. Initialize the chart of accounts first.`
    );
  }
  const active = accounts.filter((a) => a.active);
  const candidates = active.length > 0 ? active : accounts;
  // `accounts` is non-empty (checked above), so `candidates` is too and its first row is a valid seed.
  const account = candidates.reduce((oldest, a) => (a._creationTime < oldest._creationTime ? a : oldest), candidates[0]);
  if (!account.active) {
    throw new ConvexError(`System account "${systemKey}" is inactive.`);
  }
  return account._id;
}

/**
 * Bounded book-balance read. Ordinary documents spend one shared read budget;
 * dated control and physical-bank attribution use certified aggregate ranges.
 * Elapsed periods retain authoritative snapshots (ACC-2). An uncertified
 * containing period uses its dated control aggregate. Missing backfill,
 * inconsistent history or exhausted budget withholds the balance.
 */
function incompleteBankBalance(asOf: number, bank?: Doc<"bankAccounts">) {
  return {
    bankAccountId: bank?._id ?? null, name: bank?.name ?? null, currency: bank?.currency ?? null,
    isDeleted: bank?.isDeleted === true, asOf, status: "BALANCE_HISTORY_INCOMPLETE" as const,
    balanceMinor: null, unmatchedMinor: null, unattributedLineCount: null,
  };
}

export async function computeBankBalances(
  ctx: QueryCtx, orgId: Id<"organizations">, asOf: number, budgetDocs: number, targetOnly = false,
) {
  if (!Number.isSafeInteger(asOf)) throw new ConvexError("The balance date must be valid.");
  const budget = { remaining: budgetDocs };
  let reportBanks: Doc<"bankAccounts">[] = [];
  try {
    const accounts = await takeWithinBudget(budget, ctx.db.query("bankAccounts").withIndex("by_org", (q) => q.eq("orgId", orgId)));
    const target = accounts.find((bank) => bank.isReconciliationTarget && !bank.isDeleted);
    reportBanks = targetOnly ? (target ? [target] : []) : accounts;
    if (reportBanks.length === 0) return [];
    const bankChartAccountId = await resolveBankControlAccount(ctx, orgId, budget);
    const namespace = await readyBankAggregateNamespace(ctx, orgId, bankChartAccountId, budget);

    const periods = await takeWithinBudget(
      budget,
      ctx.db.query("accountingPeriods").withIndex("by_org_startDate", (q) => q.eq("orgId", orgId).lte("startDate", asOf))
    );
    const snapshotPeriodIds = new Set<string>(periods.filter((p) => p.endDate <= asOf).map((p) => p._id));
    const containing = periods.find((p) => p.startDate <= asOf && asOf < p.endDate);
    let containingFromLines = false;
    if (containing) {
      containingFromLines = true;
      if (containing.snapshotFastPathEligible) {
        chargeDocs(budget, 1);
        const futureEntry = await ctx.db.query("journalEntries")
          .withIndex("by_org_period_date", (q) =>
            q.eq("orgId", orgId).eq("periodId", containing._id).gt("accountingDate", asOf)
          ).first();
        if (!futureEntry) {
          snapshotPeriodIds.add(containing._id);
          containingFromLines = false;
        }
      }
    }

    const rows = [];
    const banksByCurrency = new Map<string, Doc<"bankAccounts">[]>();
    for (const bank of accounts) {
      const banks = banksByCurrency.get(bank.currency);
      if (banks) banks.push(bank);
      else banksByCurrency.set(bank.currency, [bank]);
    }
    const currencies = new Set(reportBanks.map((bank) => bank.currency));
    for (const currency of currencies) {
      const banks = banksByCurrency.get(currency) ?? [];
      const reports = targetOnly ? reportBanks : banks;
      rows.push(...await readCurrencyBankBalances(ctx, {
        orgId, asOf, currency, budget, snapshotPeriodIds, namespace, bankChartAccountId, banks, reports,
        partialStart: containingFromLines ? containing?.startDate : undefined,
      }));
    }
    return rows.filter((row) => !row.isDeleted || row.status !== "OK" || row.balanceMinor !== 0);
  } catch (error) {
    if (!(error instanceof ReadBudgetExhausted || error instanceof InconsistentHistory || isUnsafeBalanceError(error))) {
      console.error("Bank book balances could not be verified", { orgId, error });
    }
    return reportBanks.length ? reportBanks.map((bank) => incompleteBankBalance(asOf, bank))
      : [incompleteBankBalance(asOf)];
  }
}

async function readCurrencyBankBalances(ctx: QueryCtx, options: {
  orgId: Id<"organizations">;
  asOf: number;
  currency: string;
  budget: { remaining: number };
  snapshotPeriodIds: ReadonlySet<string>;
  namespace: string;
  bankChartAccountId: Id<"chartOfAccounts">;
  banks: Doc<"bankAccounts">[];
  reports: Doc<"bankAccounts">[];
  partialStart?: number;
}) {
  const { orgId, asOf, currency, budget, snapshotPeriodIds, namespace, bankChartAccountId, banks, reports, partialStart } = options;
  // ACC-2: certified elapsed periods (and an eligible containing period)
  // retain their authoritative GL snapshots. Only an uncertified containing
  // period takes its control total from posted line aggregates.
  const snapshots = await takeWithinBudget(
    budget,
    ctx.db.query("accountBalanceSnapshots")
      .withIndex("by_org_account_currency_period_shard", (q) =>
        q.eq("orgId", orgId).eq("accountId", bankChartAccountId).eq("currency", currency)
      )
  );
  let snapshotDebitMinor = 0;
  let snapshotCreditMinor = 0;
  for (const snapshot of snapshots) {
    if (snapshotPeriodIds.has(snapshot.periodId)) {
      snapshotDebitMinor = addBalanceMinor(snapshotDebitMinor, snapshot.runningDebitMinor);
      snapshotCreditMinor = addBalanceMinor(snapshotCreditMinor, snapshot.runningCreditMinor);
    }
  }
  let controlNetMinor = addBalanceMinor(snapshotDebitMinor, -snapshotCreditMinor);
  if (!Number.isSafeInteger(controlNetMinor)) throw new InconsistentHistory();
  // Counts detect two equal-and-opposite legacy lines even when their net is
  // zero. Deactivated or soft-deleted banks still own their historical lines.
  // One walk per tree: the control ranges together, every bank together.
  const currentRange = partialStart !== undefined
    ? [{ fromInclusive: partialStart, through: asOf }]
    : [];
  const [controlTotals, attributions] = await Promise.all([
    readControlRanges(ctx, namespace, bankChartAccountId, currency, [{ through: asOf }, ...currentRange]),
    readAttributionRanges(ctx, namespace, bankChartAccountId, currency,
      banks.map((bank) => ({ bankAccountId: bank._id, range: { through: asOf } }))),
  ]);
  const allControl = controlTotals[0];
  if (currentRange.length > 0) {
    controlNetMinor = addBalanceMinor(controlNetMinor, controlTotals[1].netMinor);
    if (!Number.isSafeInteger(controlNetMinor)) throw new InconsistentHistory();
  }
  let identifiedCount = 0;
  let identifiedNetMinor = 0;
  for (const identified of attributions) {
    identifiedCount += identified.count;
    identifiedNetMinor = addBalanceMinor(identifiedNetMinor, identified.netMinor);

  }
  const unattributedLineCount = allControl.count - identifiedCount;
  if (unattributedLineCount < 0 ||
      !Number.isSafeInteger(identifiedNetMinor) || !Number.isSafeInteger(identifiedCount)) {
    throw new InconsistentHistory();
  }

  const unmatchedMinor = addBalanceMinor(controlNetMinor, -identifiedNetMinor);
  const hasUnattributed = unmatchedMinor !== 0 || unattributedLineCount > 0;
  const balances = new Map(banks.map((bank, index) => [bank._id, attributions[index].netMinor]));
  return reports.map((bank) => {
    const amount = balances.get(bank._id);
    if (amount === undefined || !Number.isSafeInteger(amount)) throw new InconsistentHistory();
    return {
      bankAccountId: bank._id, name: bank.name, currency, isDeleted: bank.isDeleted === true, asOf,
      status: hasUnattributed ? "UNATTRIBUTED_GL_ACTIVITY" as const : "OK" as const,
      balanceMinor: hasUnattributed ? null : amount, unmatchedMinor, unattributedLineCount,
    };
  });
}

export async function computeBookBalance(ctx: QueryCtx, orgId: Id<"organizations">, asOf: number, budgetDocs: number) {
  const [row] = await computeBankBalances(ctx, orgId, asOf, budgetDocs, true);
  if (!row) return null;
  const { isDeleted: ignored, ...balance } = row;
  void ignored;
  return balance;
}
