/**
 * GL Phase 18 — running account balance snapshots.
 *
 * incrementAccountSnapshot is called once per journal line from the two
 * places that ever insert into journalLines (postingEngine.ts and
 * reversals.ts), keeping a per-(account, currency, period) running total
 * synchronously up to date. getCumulativeBalancesAsOf then answers "what's
 * the balance of every account as of this date" in O(periods) + O(lines in
 * the single still-open containing period), instead of O(every line ever
 * posted).
 */
import { Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";

// Each (orgId, accountId, currency, periodId) counter is split across this
// many independent documents, chosen at random per increment. Convex OCC
// only conflicts when two writes touch the same document, so this bounds
// how much concurrent posting to one hot account can serialize — without
// it, every posting to e.g. CASH_ON_HAND across the whole org contends on
// a single row. The read side (getCumulativeBalancesAsOf) already sums
// every matching row regardless of how many there are, so this is the only
// place that needs to know shards exist. Kept a power of 2 so a single
// random byte maps onto it with no modulo bias.
const SHARD_COUNT = 8;

// Not a security decision (which shard a counter increment lands in has no
// security implication) — using the Web Crypto RNG instead of Math.random
// just avoids relying on a PRNG that static analysis (correctly, in
// general) treats as unsafe by default, at zero cost here. Same API this
// codebase already uses elsewhere for real security-sensitive tokens
// (convex/memberships.ts, convex/vehicles.ts).
function randomShard(): number {
  return crypto.getRandomValues(new Uint8Array(1))[0] % SHARD_COUNT;
}

export async function incrementAccountSnapshot(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    accountId: Id<"chartOfAccounts">;
    currency: string;
    periodId: Id<"accountingPeriods">;
    debitMinor: number;
    creditMinor: number;
  }
): Promise<void> {
  const shard = randomShard();
  const existing = await ctx.db
    .query("accountBalanceSnapshots")
    .withIndex("by_org_account_currency_period_shard", (q) =>
      q
        .eq("orgId", args.orgId)
        .eq("accountId", args.accountId)
        .eq("currency", args.currency)
        .eq("periodId", args.periodId)
        .eq("shard", shard)
    )
    .unique();

  const now = Date.now();
  if (existing) {
    await ctx.db.patch(existing._id, {
      runningDebitMinor: existing.runningDebitMinor + args.debitMinor,
      runningCreditMinor: existing.runningCreditMinor + args.creditMinor,
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("accountBalanceSnapshots", {
      orgId: args.orgId,
      accountId: args.accountId,
      currency: args.currency,
      periodId: args.periodId,
      shard,
      runningDebitMinor: args.debitMinor,
      runningCreditMinor: args.creditMinor,
      updatedAt: now,
    });
  }
}

export interface CumulativeBalance {
  accountId: Id<"chartOfAccounts">;
  currency: string;
  debitMinor: number;
  creditMinor: number;
}

/**
 * Sums snapshots for every period that ends on/before asOfDate (safe in
 * full — a closed-out period's snapshot never changes again), plus a
 * bounded scan of just the one period whose date range actually contains
 * asOfDate (if any) for lines up to that specific date. Periods with a
 * startDate after asOfDate are irrelevant and skipped entirely.
 */
export async function getCumulativeBalancesAsOf(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  asOfDate: number
): Promise<CumulativeBalance[]> {
  const periods = await ctx.db
    .query("accountingPeriods")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();

  const fullyElapsedPeriods = periods.filter((p) => p.endDate <= asOfDate);
  const containingPeriod = periods.find((p) => p.startDate <= asOfDate && asOfDate < p.endDate);

  const totals = new Map<string, CumulativeBalance>();
  const addTo = (accountId: Id<"chartOfAccounts">, currency: string, debitMinor: number, creditMinor: number) => {
    const key = `${accountId}__${currency}`;
    const existing = totals.get(key) ?? { accountId, currency, debitMinor: 0, creditMinor: 0 };
    existing.debitMinor += debitMinor;
    existing.creditMinor += creditMinor;
    totals.set(key, existing);
  };

  for (const period of fullyElapsedPeriods) {
    const snapshots = await ctx.db
      .query("accountBalanceSnapshots")
      .withIndex("by_org_period", (q) => q.eq("orgId", orgId).eq("periodId", period._id))
      .collect();
    for (const s of snapshots) {
      addTo(s.accountId, s.currency, s.runningDebitMinor, s.runningCreditMinor);
    }
  }

  if (containingPeriod) {
    // Bounded to this one period's own entries via the indexed by_org_period
    // lookup — not a date-filtered scan of every journalLine the org has
    // ever posted, which wouldn't actually be indexed on date across all
    // accounts and would silently re-introduce the full-scan problem.
    // Include REVERSED entries too — same reasoning as accountingReports.ts's
    // getPostedLines: a reversed entry's own lines are still real historical
    // postings, cancelled out by a separately-posted reversal entry, not
    // erased. Filtering to POSTED-only here would keep the reversal's
    // inverted lines while dropping the original, breaking net-zero.
    const entriesInPeriod = (
      await ctx.db
        .query("journalEntries")
        .withIndex("by_org_period", (q) => q.eq("orgId", orgId).eq("periodId", containingPeriod._id))
        .collect()
    ).filter((e) => (e.status === "POSTED" || e.status === "REVERSED") && e.accountingDate <= asOfDate);

    for (const entry of entriesInPeriod) {
      const lines = await ctx.db
        .query("journalLines")
        .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id))
        .collect();
      for (const line of lines) {
        addTo(line.accountId, line.currency, line.debitMinor, line.creditMinor);
      }
    }
  }

  return Array.from(totals.values());
}
