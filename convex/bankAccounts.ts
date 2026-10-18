/**
 * Phase 41 — Bank Accounts
 *
 * Bank accounts are reference/reconciliation records, not new GL control
 * accounts — there remains exactly one SYSTEM_KEYS.BANK_ACCOUNT control
 * account (see convex/utils/defaultChart.ts). Only one bank account per org
 * may be the reconciliation target; its "book balance" is derived from the
 * GL at query time (see getBookBalance), never posted as a journal entry, so
 * this file never touches the posting engine. The legacy
 * `openingBalanceMinor` field is reference metadata only; new nonzero values
 * are refused so a starting amount cannot be mistaken for a posted balance.
 */
import { v, ConvexError } from "convex/values";
import { query, MutationCtx, QueryCtx } from "./_generated/server";
import { mutation } from "./functions";
import { Doc, Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import { AppErrorCode, throwAppError } from "./utils/errors";
import { bankAggregateNamespace, readAttributionRange, readControlRange } from "./accounting/bankLineAggregate";

export const BANK_OPENING_BALANCE_VIA_GL_MESSAGE =
  "This bank form cannot set a book balance. For initial setup, create every bank before posting the one-time opening journal in Accounting Setup.";

function refuseReferenceOpeningBalance(amount: number | undefined): void {
  if (amount !== undefined && amount !== 0) {
    throwAppError(AppErrorCode.BANK_OPENING_BALANCE_VIA_GL, BANK_OPENING_BALANCE_VIA_GL_MESSAGE);
  }
}

export const list = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const accounts = await ctx.db
      .query("bankAccounts")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    return accounts.filter((a) => !a.isDeleted);
  },
});

export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    name: v.string(),
    bankName: v.optional(v.string()),
    iban: v.optional(v.string()),
    accountNumber: v.optional(v.string()),
    currency: v.string(),
    openingBalanceMinor: v.optional(v.number()),
    openingBalanceDate: v.optional(v.number()),
    isReconciliationTarget: v.optional(v.boolean()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const now = Date.now();

    if ((args.openingBalanceMinor !== undefined && !Number.isFinite(args.openingBalanceMinor)) ||
      (args.openingBalanceDate !== undefined && !Number.isFinite(args.openingBalanceDate))) {
      throw new ConvexError("Opening balance and date must be valid numbers.");
    }
    refuseReferenceOpeningBalance(args.openingBalanceMinor);

    if (args.isReconciliationTarget) {
      await clearOtherReconciliationTargets(ctx, args.orgId);
    }

    return await ctx.db.insert("bankAccounts", {
      orgId: args.orgId,
      name: args.name,
      bankName: args.bankName,
      iban: args.iban,
      accountNumber: args.accountNumber,
      currency: args.currency,
      openingBalanceMinor: 0,
      openingBalanceDate: args.openingBalanceDate ?? now,
      isActive: true,
      isReconciliationTarget: args.isReconciliationTarget ?? false,
      notes: args.notes,
      createdBy: user._id,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    bankAccountId: v.id("bankAccounts"),
    name: v.optional(v.string()),
    bankName: v.optional(v.string()),
    iban: v.optional(v.string()),
    accountNumber: v.optional(v.string()),
    openingBalanceMinor: v.optional(v.number()),
    openingBalanceDate: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const account = await ctx.db.get(args.bankAccountId);
    if (!account || account.orgId !== args.orgId || account.isDeleted) {
      throw new ConvexError("Bank account not found in this organization.");
    }
    if (args.openingBalanceMinor !== undefined && !Number.isFinite(args.openingBalanceMinor)) {
      throw new ConvexError("Opening balance must be a valid number.");
    }
    if (args.openingBalanceDate !== undefined && !Number.isFinite(args.openingBalanceDate)) {
      throw new ConvexError("Opening balance date must be a valid number.");
    }
    if (args.openingBalanceMinor !== undefined) {
      throwAppError(AppErrorCode.BANK_OPENING_BALANCE_VIA_GL, BANK_OPENING_BALANCE_VIA_GL_MESSAGE);
    }

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.name !== undefined) patch.name = args.name;
    if (args.bankName !== undefined) patch.bankName = args.bankName;
    if (args.iban !== undefined) patch.iban = args.iban;
    if (args.accountNumber !== undefined) patch.accountNumber = args.accountNumber;
    if (args.openingBalanceDate !== undefined) patch.openingBalanceDate = args.openingBalanceDate;
    if (args.notes !== undefined) patch.notes = args.notes;

    await ctx.db.patch(args.bankAccountId, patch);
  },
});

async function clearOtherReconciliationTargets(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  exceptId?: Id<"bankAccounts">
) {
  const accounts = await ctx.db
    .query("bankAccounts")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
  for (const account of accounts) {
    if (account.isReconciliationTarget && account._id !== exceptId) {
      await ctx.db.patch(account._id, { isReconciliationTarget: false, updatedAt: Date.now() });
    }
  }
}

export const setReconciliationTarget = mutation({
  args: {
    orgId: v.id("organizations"),
    bankAccountId: v.id("bankAccounts"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const account = await ctx.db.get(args.bankAccountId);
    if (!account || account.orgId !== args.orgId || account.isDeleted) {
      throw new ConvexError("Bank account not found in this organization.");
    }
    await clearOtherReconciliationTargets(ctx, args.orgId, args.bankAccountId);
    await ctx.db.patch(args.bankAccountId, { isReconciliationTarget: true, updatedAt: Date.now() });
  },
});

export const deactivate = mutation({
  args: {
    orgId: v.id("organizations"),
    bankAccountId: v.id("bankAccounts"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const account = await ctx.db.get(args.bankAccountId);
    if (!account || account.orgId !== args.orgId || account.isDeleted) {
      throw new ConvexError("Bank account not found in this organization.");
    }
    await ctx.db.patch(args.bankAccountId, {
      isActive: false,
      isReconciliationTarget: false,
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: user._id.toString(),
      updatedAt: Date.now(),
    });
  },
});

/**
 * Book balance for the org's reconciliation-target bank account (SCRUM-54).
 * The GL is the sole authority: the balance is the cumulative net of the
 * BANK_ACCOUNT control lines whose journal line names this physical bank
 * (`bankAccountId`). `openingBalanceMinor` is reference metadata and is never
 * added — an opening already posted to the GL would be counted twice.
 *
 * The control account's own cumulative total (elapsed periods from that
 * account's snapshots; the containing period from its snapshot only while it is
 * certified and has no later-dated entry, otherwise from that period's POSTED or
 * REVERSED entries dated on or before asOf and their lines, as the shared
 * reader selects them) must be
 * fully explained by identified lines, and no relevant line may lack a known
 * same-org bank (even when its net is zero). Otherwise the balance is withheld
 * (`balanceMinor: null`), never inferred by amount/date and never assigned to
 * the target. `unmatchedMinor` is a net diagnostic; `unattributedLineCount`
 * distinguishes net-zero unattributed activity.
 *
 * Every read spends one shared document budget (see `computeBookBalance`). When
 * it is exhausted, or a control line disagrees with its entry's date or period,
 * the status is `BALANCE_HISTORY_INCOMPLETE` with a null balance and null
 * diagnostics: the history could not be verified, so it is never reported OK.
 */
export const getBookBalance = query({
  args: {
    orgId: v.id("organizations"),
    asOf: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const asOf = args.asOf ?? Date.now();
    try {
      return await computeBookBalance(ctx, args.orgId, asOf, BOOK_BALANCE_READ_BUDGET);
    } catch (error) {
      console.error("Failed to read the bank book balance", error);
      return incompleteBankBalance(asOf);
    }
  },
});

/** One bounded result per visible physical bank for the bank accounts table. */
export const listBookBalances = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const asOf = Date.now();
    try {
      return (await computeBankBalances(ctx, args.orgId, asOf, BOOK_BALANCE_READ_BUDGET)).rows;
    } catch (error) {
      console.error("Failed to read bank book balances", error);
      return [incompleteBankBalance(asOf)];
    }
  },
});

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
type BankBalanceRow = {
  bankAccountId: Id<"bankAccounts"> | null;
  name: string | null;
  currency: string | null;
  isDeleted: boolean;
  asOf: number;
  status: "OK" | "UNATTRIBUTED_GL_ACTIVITY" | "BALANCE_HISTORY_INCOMPLETE";
  balanceMinor: number | null;
  unmatchedMinor: number | null;
  unattributedLineCount: number | null;
};

function incompleteBankBalance(asOf: number): BankBalanceRow {
  return {
    bankAccountId: null, name: null, currency: null, isDeleted: false, asOf,
    status: "BALANCE_HISTORY_INCOMPLETE", balanceMinor: null,
    unmatchedMinor: null, unattributedLineCount: null,
  };
}

async function computeBankBalances(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  asOf: number,
  budgetDocs: number,
  targetOnly = false,
): Promise<{ targetBankId: Id<"bankAccounts"> | null; rows: BankBalanceRow[] }> {
  if (!Number.isSafeInteger(asOf)) throw new ConvexError("The balance date must be valid.");
  const budget = { remaining: budgetDocs };
  let accounts: Doc<"bankAccounts">[] = [];
  let targetBankId: Id<"bankAccounts"> | null = null;
  try {
    accounts = await takeWithinBudget(budget, ctx.db.query("bankAccounts").withIndex("by_org", (q) => q.eq("orgId", orgId)));
    const targetBank = accounts.find((bank) => bank.isReconciliationTarget && !bank.isDeleted);
    targetBankId = targetBank?._id ?? null;
    const reportBanks = targetOnly ? (targetBank ? [targetBank] : []) : accounts;
    if (reportBanks.length === 0) return { targetBankId, rows: [] };
    const currencies = new Set(reportBanks.map((bank) => bank.currency));
    const bankChartAccountId = await resolveBankControlAccount(ctx, orgId, budget);
    const namespace = await readyBankAggregateNamespace(ctx, orgId, bankChartAccountId, budget);

    const periods = await takeWithinBudget(
      budget,
      ctx.db.query("accountingPeriods").withIndex("by_org_startDate", (q) => q.eq("orgId", orgId).lte("startDate", asOf)),
    );
    const snapshotPeriodIds = new Set<string>(periods.filter((period) => period.endDate <= asOf).map((period) => period._id));
    const containing = periods.find((period) => period.startDate <= asOf && asOf < period.endDate);
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

    const controlNetByCurrency = new Map<string, number>();
    const identifiedNetByCurrency = new Map<string, number>();
    const unattributedCountByCurrency = new Map<string, number>();
    const netByBankId = new Map<string, number>();
    for (const currency of currencies) {
      // Certified elapsed periods remain snapshot-authoritative (ACC-2).
      const snapshots = await takeWithinBudget(
        budget,
        ctx.db.query("accountBalanceSnapshots")
          .withIndex("by_org_account_currency_period_shard", (q) =>
            q.eq("orgId", orgId).eq("accountId", bankChartAccountId).eq("currency", currency)
          ),
      );
      let controlNetMinor = 0;
      for (const snapshot of snapshots) {
        if (snapshotPeriodIds.has(snapshot.periodId)) {
          controlNetMinor += snapshot.runningDebitMinor - snapshot.runningCreditMinor;
        }
      }
      if (containing && containingFromLines) {
        const partial = await readControlRange(ctx, namespace, bankChartAccountId, currency, {
          fromInclusive: containing.startDate, through: asOf,
        });
        controlNetMinor += partial.netMinor;
      }
      if (!Number.isSafeInteger(controlNetMinor)) throw new InconsistentHistory();
      controlNetByCurrency.set(currency, controlNetMinor);

      // Counts expose equal-and-opposite legacy lines that have zero net.
      const allControl = await readControlRange(ctx, namespace, bankChartAccountId, currency, { through: asOf });
      let identifiedCount = 0;
      let identifiedNetMinor = 0;
      for (const bank of accounts) {
        if (bank.currency !== currency) continue;
        const identified = await readAttributionRange(ctx, namespace, bankChartAccountId, currency, bank._id, { through: asOf });
        identifiedCount += identified.count;
        identifiedNetMinor += identified.netMinor;
        netByBankId.set(bank._id, identified.netMinor);
      }
      const unmatchedCount = allControl.count - identifiedCount;
      if (unmatchedCount < 0 || !Number.isSafeInteger(identifiedNetMinor) || !Number.isSafeInteger(identifiedCount)) {
        throw new InconsistentHistory();
      }
      identifiedNetByCurrency.set(currency, identifiedNetMinor);
      unattributedCountByCurrency.set(currency, unmatchedCount);
    }

    const rows: BankBalanceRow[] = reportBanks.map((bank) => {
      const base = { bankAccountId: bank._id, name: bank.name, currency: bank.currency, isDeleted: bank.isDeleted === true, asOf };
      const unmatchedMinor = (controlNetByCurrency.get(bank.currency) ?? 0) - (identifiedNetByCurrency.get(bank.currency) ?? 0);
      if (!Number.isSafeInteger(unmatchedMinor)) throw new InconsistentHistory();
      const unattributedLineCount = unattributedCountByCurrency.get(bank.currency) ?? 0;
      if (unmatchedMinor !== 0 || unattributedLineCount > 0) {
        return { ...base, status: "UNATTRIBUTED_GL_ACTIVITY" as const, balanceMinor: null, unmatchedMinor, unattributedLineCount };
      }
      return {
        ...base, status: "OK" as const, balanceMinor: netByBankId.get(bank._id) ?? 0,
        unmatchedMinor: 0, unattributedLineCount: 0,
      };
    });
    return { targetBankId, rows: rows.filter((row) => !row.isDeleted || row.status !== "OK" || row.balanceMinor !== 0) };
  } catch (error) {
    if (!(error instanceof ReadBudgetExhausted || error instanceof InconsistentHistory)) {
      console.error("Bank book balances could not be verified", { orgId, error });
    }
    if (accounts.length === 0) return { targetBankId: null, rows: [incompleteBankBalance(asOf)] };
    const rows: BankBalanceRow[] = accounts
      .filter((bank) => !targetOnly || bank._id === targetBankId)
      .map((bank) => ({
        bankAccountId: bank._id, name: bank.name, currency: bank.currency, isDeleted: bank.isDeleted === true,
        asOf, status: "BALANCE_HISTORY_INCOMPLETE", balanceMinor: null, unmatchedMinor: null, unattributedLineCount: null,
      }));
    return { targetBankId, rows };
  }
}

export async function computeBookBalance(ctx: QueryCtx, orgId: Id<"organizations">, asOf: number, budgetDocs: number) {
  const { targetBankId, rows } = await computeBankBalances(ctx, orgId, asOf, budgetDocs, true);
  if (!targetBankId) return rows.find((row) => row.bankAccountId === null) ?? null;
  return rows.find((row) => row.bankAccountId === targetBankId) ?? null;
}