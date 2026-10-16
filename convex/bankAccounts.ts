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
import { NO_ACCOUNTING_DATE_SENTINEL } from "./accountingReports";

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
 * Documents one getBookBalance call may read - periods, snapshots, lines and
 * entry lookups together - before it reports BALANCE_HISTORY_INCOMPLETE. A
 * placeholder set well under Convex's per-query read limits; it is not measured
 * on a real deployment, so calibrate it on a preview before relying on it.
 */
export const BOOK_BALANCE_READ_BUDGET = 4000;

class ReadBudgetExhausted extends Error {}

/**
 * A control-account line whose date disagrees with its own entry's date or lies
 * outside the entry's period. The control (read by entry) and attribution (read
 * by line) then select different rows, so their nets could cancel into a false OK.
 */
class InconsistentHistory extends Error {}

/**
 * What the status/date checks need from an entry; null when the entry row is missing.
 * `periodId` is optional in the schema; an entry without one has no period to bound its lines.
 */
type EntryFacts = { counts: boolean; accountingDate: number; periodId: Id<"accountingPeriods"> | undefined } | null;

function entryFacts(entry: Doc<"journalEntries">): EntryFacts {
  return {
    counts: entry.status === "POSTED" || entry.status === "REVERSED",
    accountingDate: entry.accountingDate,
    periodId: entry.periodId,
  };
}

/**
 * A line must carry its entry's accounting date, inside the bounds of the entry's
 * period. `endDate` is inclusive (posting assigns the exact end instant to the period).
 * No period (entry without a periodId, or one not read) is a disagreement: fail closed.
 */
function assertLineMatchesEntry(
  lineDate: number,
  entryDate: number,
  period: { startDate: number; endDate: number } | undefined
): void {
  if (lineDate !== entryDate || !period || lineDate < period.startDate || lineDate > period.endDate) {
    throw new InconsistentHistory();
  }
}

function chargeDocs(budget: { remaining: number }, count: number): void {
  if (count > budget.remaining) throw new ReadBudgetExhausted();
  budget.remaining -= count;
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
 * The bounded read behind getBookBalance (exported so the budget can be
 * exercised directly). Every read - banks, chart account, periods, control
 * snapshots, the control account's lines and each entry lookup - spends one
 * shared budget. When it runs out the balance is withheld as
 * BALANCE_HISTORY_INCOMPLETE; history that could not be measured is never OK.
 * The same status covers a counted control line whose date or period disagrees
 * with its entry (InconsistentHistory), whatever the net.
 * The control total keeps ACC-2: elapsed periods come from the account's
 * snapshots, the containing period from its snapshot only while it is
 * certified and has no later-dated entry, otherwise from its own entries and
 * their lines.
 */
export async function computeBookBalance(ctx: QueryCtx, orgId: Id<"organizations">, asOf: number, budgetDocs: number) {
  const budget = { remaining: budgetDocs };
  let target: Doc<"bankAccounts"> | undefined;
  try {
    const accounts = await takeWithinBudget(budget, ctx.db.query("bankAccounts").withIndex("by_org", (q) => q.eq("orgId", orgId)));
    target = accounts.find((a) => a.isReconciliationTarget && !a.isDeleted);
    if (!target) return null;
    const currency = target.currency;

    const bankChartAccountId = await resolveBankControlAccount(ctx, orgId, budget);

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
        const futureEntry = await ctx.db
          .query("journalEntries")
          .withIndex("by_org_period_date", (q) => q.eq("orgId", orgId).eq("periodId", containing._id).gt("accountingDate", asOf))
          .first();
        if (!futureEntry) {
          snapshotPeriodIds.add(containing._id);
          containingFromLines = false;
        }
      }
    }

    // Authoritative control total (BANK_ACCOUNT is a DEBIT-normal asset).
    const snapshots = await takeWithinBudget(
      budget,
      ctx.db
        .query("accountBalanceSnapshots")
        .withIndex("by_org_account_currency_period_shard", (q) =>
          q.eq("orgId", orgId).eq("accountId", bankChartAccountId).eq("currency", currency)
        )
    );
    let controlNetMinor = 0;
    for (const s of snapshots) {
      if (snapshotPeriodIds.has(s.periodId)) controlNetMinor += s.runningDebitMinor - s.runningCreditMinor;
    }
    // Draft/validated entries are not ledger activity; REVERSED originals are
    // (their reversal is a separate entry). Each entry's status, date and period are
    // read and charged once: the control block below caches the entries it reads, the
    // attribution loop looks up only the rest.
    const entryFactsById = new Map<string, EntryFacts>();
    const periodsById = new Map(periods.map((p) => [p._id, p]));
    // A containing period with no usable snapshot takes its control exactly as
    // getCumulativeBalancesAsOf does: POSTED/REVERSED entries of that period dated on
    // or before asOf (by ENTRY date), then each entry's lines on the control account.
    // Attribution below still reads lines by LINE date. A control line whose date or
    // period disagrees with its entry throws InconsistentHistory (reported as
    // BALANCE_HISTORY_INCOMPLETE) even when the nets would cancel; any other
    // difference leaves control != identified and the balance is withheld.
    if (containing && containingFromLines) {
      const entries = await takeWithinBudget(
        budget,
        ctx.db
          .query("journalEntries")
          .withIndex("by_org_period_date", (q) =>
            q.eq("orgId", orgId).eq("periodId", containing._id).lte("accountingDate", asOf)
          )
      );
      for (const entry of entries) {
        const facts = entryFacts(entry);
        entryFactsById.set(entry._id, facts);
        if (!facts?.counts) continue;
        const entryLines = await takeWithinBudget(
          budget,
          ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id))
        );
        for (const l of entryLines) {
          if (l.accountId !== bankChartAccountId || l.currency !== currency) continue;
          // Withheld whatever the net: offsetting entries must not cancel a date disagreement.
          assertLineMatchesEntry(l.accountingDate, entry.accountingDate, containing);
          controlNetMinor += l.debitMinor - l.creditMinor;
        }
      }
    }

    // Valid attribution = a same-org bank (deleted banks still own their
    // history) in the line's own currency; a JOD line naming a USD bank is
    // not a physical identity for that line.
    const bankCurrencyById = new Map<string, string>(accounts.map((a) => [a._id, a.currency]));
    // Only the control account's own lines, bounded by date on the index
    // (the -1 "no date" sentinel is excluded, as in getPostedLines).
    const lines = await takeWithinBudget(
      budget,
      ctx.db
        .query("journalLines")
        .withIndex("by_org_account_date", (q) =>
          q
            .eq("orgId", orgId)
            .eq("accountId", bankChartAccountId)
            .gt("accountingDate", NO_ACCOUNTING_DATE_SENTINEL)
            .lte("accountingDate", asOf)
        )
    );
    let targetNetMinor = 0;
    let identifiedNetMinor = 0;
    // Counted by line, not by net: equal-and-opposite unidentified lines net
    // to zero but are still activity with no physical bank behind it.
    let unattributedLineCount = 0;
    for (const line of lines) {
      if (line.currency !== currency) continue;
      let facts = entryFactsById.get(line.journalEntryId);
      if (facts === undefined) {
        chargeDocs(budget, 1);
        const entry = await ctx.db.get(line.journalEntryId);
        facts = entry ? entryFacts(entry) : null;
        entryFactsById.set(line.journalEntryId, facts);
      }
      if (!facts?.counts) continue;
      assertLineMatchesEntry(
        line.accountingDate,
        facts.accountingDate,
        facts.periodId ? periodsById.get(facts.periodId) : undefined
      );
      if (!line.bankAccountId || bankCurrencyById.get(line.bankAccountId) !== line.currency) {
        unattributedLineCount += 1;
        continue;
      }
      const netMinor = line.debitMinor - line.creditMinor;
      identifiedNetMinor += netMinor;
      if (line.bankAccountId === target._id) targetNetMinor += netMinor;
    }

    const base = { bankAccountId: target._id, name: target.name, currency, asOf };
    const unmatchedMinor = controlNetMinor - identifiedNetMinor;
    if (unmatchedMinor !== 0 || unattributedLineCount > 0) {
      return {
        ...base,
        status: "UNATTRIBUTED_GL_ACTIVITY" as const,
        balanceMinor: null,
        unmatchedMinor,
        unattributedLineCount,
      };
    }
    return { ...base, status: "OK" as const, balanceMinor: targetNetMinor, unmatchedMinor: 0, unattributedLineCount: 0 };
  } catch (error) {
    if (!(error instanceof ReadBudgetExhausted || error instanceof InconsistentHistory)) throw error;
    return {
      bankAccountId: target?._id ?? null,
      name: target?.name ?? null,
      currency: target?.currency ?? null,
      asOf,
      status: "BALANCE_HISTORY_INCOMPLETE" as const,
      balanceMinor: null,
      unmatchedMinor: null,
      unattributedLineCount: null,
    };
  }
}
