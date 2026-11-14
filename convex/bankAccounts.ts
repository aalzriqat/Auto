import { addBalanceMinor, isUnsafeBalanceError } from "./utils/money";
/**
 * Phase 41 — Bank Accounts
 *
 * Bank accounts are reference/reconciliation records, not new GL control
 * accounts — there remains exactly one SYSTEM_KEYS.BANK_ACCOUNT control
 * account (see convex/utils/defaultChart.ts). Only one bank account per org
 * may be the reconciliation target; its "book balance" is derived from the
 * GL at query time (see getBookBalance), never posted as a journal entry, so
 * this file never touches the posting engine. `openingBalanceMinor` is
 * reference metadata only.
 */
import { v, ConvexError } from "convex/values";
import { query, MutationCtx, QueryCtx } from "./_generated/server";
import { mutation } from "./functions";
import { Doc, Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import { computeBankOpeningReconciliation } from "./accounting/bankOpeningReconciliation";
import { BANK_AGGREGATE_LAYOUT, bankAggregateNamespace, readAttributionRanges, readControlRanges } from "./accounting/bankLineAggregate";

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
    openingBalanceMinor: v.number(),
    openingBalanceDate: v.number(),
    isReconciliationTarget: v.optional(v.boolean()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const now = Date.now();

    if (!Number.isFinite(args.openingBalanceMinor) || !Number.isFinite(args.openingBalanceDate)) {
      throw new ConvexError("Opening balance and date must be valid numbers.");
    }

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
      openingBalanceMinor: args.openingBalanceMinor,
      openingBalanceDate: args.openingBalanceDate,
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

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.name !== undefined) patch.name = args.name;
    if (args.bankName !== undefined) patch.bankName = args.bankName;
    if (args.iban !== undefined) patch.iban = args.iban;
    if (args.accountNumber !== undefined) patch.accountNumber = args.accountNumber;
    if (args.openingBalanceMinor !== undefined) patch.openingBalanceMinor = args.openingBalanceMinor;
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
    return await computeBookBalance(ctx, args.orgId, args.asOf ?? Date.now(), BOOK_BALANCE_READ_BUDGET);
  },
});

/**
 * SCRUM-858 S5 (owner ruling c23884): per-bank opening reconciliation. Each bank's posted opening line against the
 * balance the dealer stated for it, the Σ of bank lines against the bank control's opening debit, and any
 * difference under the owner's label. Read-only: it posts nothing and changes no balance.
 */
export const openingReconciliation = query({
  args: { orgId: v.id("organizations") },
  returns: v.object({
    status: v.union(v.literal("OK"), v.literal("NO_OPENING"), v.literal("OPENING_PROOF_UNAVAILABLE")),
    currency: v.union(v.string(), v.null()),
    asOfDate: v.union(v.number(), v.null()),
    banks: v.array(v.object({
      bankAccountId: v.id("bankAccounts"),
      name: v.string(),
      currency: v.string(),
      openingLineMinor: v.union(v.number(), v.null()),
      referenceOpeningMinor: v.number(),
      differenceMinor: v.union(v.number(), v.null()),
    })),
    controlOpeningMinor: v.union(v.number(), v.null()),
    bankLinesTotalMinor: v.union(v.number(), v.null()),
    unattributedOpeningMinor: v.union(v.number(), v.null()),
    unexplainedOpeningDifference: v.union(v.object({
      label: v.object({ en: v.string(), ar: v.string() }),
      currencies: v.array(v.object({
        currency: v.string(),
        differenceMinor: v.number(),
        absoluteDifferenceMinor: v.number(),
      })),
    }), v.null()),
  }),
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    return await computeBankOpeningReconciliation(ctx, args.orgId);
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
const bankBalanceStatus = v.union(
  v.literal("OK"), v.literal("UNATTRIBUTED_GL_ACTIVITY"), v.literal("BALANCE_HISTORY_INCOMPLETE"),
);

const bankBalanceFields = {
  bankAccountId: v.union(v.id("bankAccounts"), v.null()),
  name: v.union(v.string(), v.null()),
  currency: v.union(v.string(), v.null()),
  asOf: v.number(),
  status: bankBalanceStatus,
  balanceMinor: v.union(v.number(), v.null()),
  unmatchedMinor: v.union(v.number(), v.null()),
  unattributedLineCount: v.union(v.number(), v.null()),
};

export const listBookBalances = query({
  args: { orgId: v.id("organizations") },
  returns: v.array(v.object({ ...bankBalanceFields, isDeleted: v.boolean() })),
  handler: async (ctx, { orgId }) => {
    await requireTenantAuth(ctx, orgId, [PERMISSIONS.VIEW_FINANCE]);
    return await computeBankBalances(ctx, orgId, Date.now(), BOOK_BALANCE_READ_BUDGET);
  },
});

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
