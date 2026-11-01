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
  return (await readCumulativeBalances(ctx, orgId, asOfDate, undefined)).balances;
}

export type CheckedCumulativeBalances =
  | { status: "OK"; balances: CumulativeBalance[] }
  /**
   * A journal line in the journal-line path is not consistent with its organization (SCRUM-889): it carries
   * another organization's id, or a line on one of the checked accounts names a parent entry that is missing
   * or belongs to another organization. Skipping or summing it could report an unreconciled ledger as
   * reconciled, so no balance is returned.
   */
  | { status: "INCONSISTENT_REFERENCE" }
  /**
   * The verification pass would read more documents, or more serialized bytes, than its budgets allow (SCRUM-889).
   * A partial verification cannot show the ledger is consistent, so no balance is returned.
   */
  | { status: "OVER_LIMIT" };

/**
 * getCumulativeBalancesAsOf plus an organization-consistency check on the journal-line path (SCRUM-889),
 * for a caller that compares the result to a subledger and so must not read a corrupt link as "reconciled".
 *
 * `getCumulativeBalancesAsOf` walks the organization's own entries and adds every child line it finds
 * through `by_journal_entry`, without checking the line's own `orgId`; and a line whose parent is missing
 * or foreign is never reached from that walk. Convex's `db.get` and `by_journal_entry` do not scope by
 * tenant, so the function has to (https://docs.convex.dev/database/reading-data; OWASP API1:2023). Here:
 *   - a line under one of this organization's entries that carries another `orgId` is an inconsistency;
 *   - every organization-scoped line on `accountIds` in the period's date range (the same
 *     `by_org_account_date` index the bounded reader uses) whose parent entry is not one of the entries
 *     already read must resolve to an existing entry of this organization, else it is an inconsistency.
 * Closed-period and certified-snapshot balances are read from snapshots, as before; no line is read there.
 * The extra line read happens only for `accountIds` and only when the journal-line path runs.
 *
 * Budget: that extra read is charged against two budgets, and is refused with OVER_LIMIT before it would exceed
 * either (the discipline of getControlAccountBalancesAsOf). Convex caps one function at 32,000 documents scanned
 * and 16 MiB read, https://docs.convex.dev/production/state/limits, and meters both, so both are budgeted:
 *   - `readLimit` counts documents: one per control-account line read and one per parent entry fetched;
 *   - `readBytesLimit` counts the serialized size (see `serializedSize`) of those same documents. A document
 *     count alone does not bound bytes: `journalLines.description` and `journalEntries.memo` are unbounded
 *     strings, so a few documents can pass the document budget and still carry megabytes (SCRUM-889 round 4:
 *     12 balanced journals with 400,000-character descriptions made the pass read the lines the entry walk had
 *     already read, and the query threw "Read too much data in a single function execution" instead of answering).
 * The lines are read as a stream (`for await`) and each document is charged as it arrives, so a refusal stops the
 * read at the budget plus one document; a single `take(n)` page cannot stop part-way. The caller chooses
 * `readBytesLimit` well under 16 MiB because the budget does not cover the unchanged walk over the period's
 * entries and lines, which getCumulativeBalancesAsOf also does, and that walk plus this pass share the one limit.
 *
 * Evidence boundary: the byte budget is proven against convex-test's emulation of the 16 MiB limit
 * (`transactionLimits: true`), not against the Convex backend. The real-backend measurement, which also fixes
 * whether `serializedSize` over- or under-counts what Convex meters, cannot be produced before merge and is
 * deferred to the release rehearsal (SCRUM-762).
 */
export async function getCumulativeBalancesAsOfChecked(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  asOfDate: number,
  accountIds: ReadonlyArray<Id<"chartOfAccounts">>,
  readLimit: number,
  readBytesLimit: number
): Promise<CheckedCumulativeBalances> {
  const read = await readCumulativeBalances(ctx, orgId, asOfDate, { accountIds, readLimit, readBytesLimit });
  return read.outcome === "OK" ? { status: "OK", balances: read.balances } : { status: read.outcome };
}

type BalanceAdder = (accountId: Id<"chartOfAccounts">, currency: string, debitMinor: number, creditMinor: number) => void;
type ReadOutcome = "OK" | "INCONSISTENT_REFERENCE" | "OVER_LIMIT";
/** The accounts whose lines and parent entries are verified, and the document and byte budgets for that verification. */
type LedgerCheck = { accountIds: ReadonlyArray<Id<"chartOfAccounts">>; readLimit: number; readBytesLimit: number };

/**
 * The UTF-8 size of a document's JSON form, which the byte budget charges. An approximation of what Convex meters
 * (its accounting is internal and not documented to the byte), chosen to be on the conservative side: JSON text
 * repeats every field name, so it is at least as large as the stored value for the string-heavy documents that
 * matter here. Journal documents hold no bigint, which JSON.stringify would reject.
 */
function serializedSize(doc: unknown): number {
  return new TextEncoder().encode(JSON.stringify(doc)).length;
}

async function addPeriodSnapshots(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  periodId: Id<"accountingPeriods">,
  addTo: BalanceAdder
): Promise<void> {
  const snapshots = await ctx.db
    .query("accountBalanceSnapshots")
    .withIndex("by_org_period", (q) => q.eq("orgId", orgId).eq("periodId", periodId))
    .collect();
  for (const s of snapshots) {
    addTo(s.accountId, s.currency, s.runningDebitMinor, s.runningCreditMinor);
  }
}

/** Adds every line of `entries`. With `checkLineOrg`, returns false at the first line that carries another organization's id. */
async function addEntryLines(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  entries: ReadonlyArray<{ _id: Id<"journalEntries"> }>,
  addTo: BalanceAdder,
  checkLineOrg: boolean
): Promise<boolean> {
  for (const entry of entries) {
    const lines = await ctx.db
      .query("journalLines")
      .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id))
      .collect();
    for (const line of lines) {
      if (checkLineOrg && line.orgId !== orgId) return false;
      addTo(line.accountId, line.currency, line.debitMinor, line.creditMinor);
    }
  }
  return true;
}

/**
 * Line-first: the entry walk never visits a line whose parent is missing or owned by another organization, so
 * this reads the organization's own lines on the checked accounts in the period's range and resolves each parent
 * that is not one of `knownEntryIds`. Every line read and every parent fetched is charged to `check.readLimit`
 * (one document each) and to `check.readBytesLimit` (its `serializedSize`); the first document that takes either
 * budget below zero answers OVER_LIMIT and nothing further is read. Lines arrive as a stream so the read stops
 * there; a parent is charged one document before it is fetched and its bytes once it is, so the bytes can pass
 * the budget by at most that one parent (a document is at most 1 MiB, far under the 16 MiB function limit).
 */
async function verifyControlLineParents(
  ctx: QueryCtx,
  request: Readonly<{
    orgId: Id<"organizations">;
    periodStartDate: number;
    asOfDate: number;
    check: LedgerCheck;
    knownEntryIds: ReadonlySet<Id<"journalEntries">>;
  }>
): Promise<ReadOutcome> {
  const { orgId, periodStartDate, asOfDate, check, knownEntryIds } = request;
  let remainingDocs = check.readLimit;
  let remainingBytes = check.readBytesLimit;
  const resolvedElsewhere = new Set<Id<"journalEntries">>();
  for (const accountId of new Set(check.accountIds)) {
    const accountLines = ctx.db
      .query("journalLines")
      .withIndex("by_org_account_date", (q) =>
        q.eq("orgId", orgId).eq("accountId", accountId).gte("accountingDate", periodStartDate).lte("accountingDate", asOfDate)
      );
    for await (const line of accountLines) {
      remainingDocs -= 1;
      remainingBytes -= serializedSize(line);
      if (remainingDocs < 0 || remainingBytes < 0) return "OVER_LIMIT";
      if (knownEntryIds.has(line.journalEntryId) || resolvedElsewhere.has(line.journalEntryId)) continue;
      // Not one of this organization's entries in the period: a same-org entry of another period or date
      // is outside this sum (as before); a missing or foreign one is an inconsistency.
      remainingDocs -= 1;
      if (remainingDocs < 0) return "OVER_LIMIT";
      const parent = await ctx.db.get(line.journalEntryId);
      if (!parent || parent.orgId !== orgId) return "INCONSISTENT_REFERENCE";
      remainingBytes -= serializedSize(parent);
      if (remainingBytes < 0) return "OVER_LIMIT";
      resolvedElsewhere.add(line.journalEntryId);
    }
  }
  return "OK";
}

async function readCumulativeBalances(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  asOfDate: number,
  /** When given, the journal-line path verifies line and parent ownership within a document and a byte budget (see getCumulativeBalancesAsOfChecked). */
  check: LedgerCheck | undefined
): Promise<{ balances: CumulativeBalance[]; outcome: ReadOutcome }> {
  const periods = await ctx.db
    .query("accountingPeriods")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();

  const fullyElapsedPeriods = periods.filter((p) => p.endDate <= asOfDate);
  const containingPeriod = periods.find((p) => p.startDate <= asOfDate && asOfDate < p.endDate);

  const totals = new Map<string, CumulativeBalance>();
  const addTo: BalanceAdder = (accountId, currency, debitMinor, creditMinor) => {
    const key = `${accountId}__${currency}`;
    const existing = totals.get(key) ?? { accountId, currency, debitMinor: 0, creditMinor: 0 };
    existing.debitMinor += debitMinor;
    existing.creditMinor += creditMinor;
    totals.set(key, existing);
  };

  for (const period of fullyElapsedPeriods) {
    await addPeriodSnapshots(ctx, orgId, period._id, addTo);
  }

  if (containingPeriod) {
    // Retained periods lack a snapshot-completeness certificate. Keep their
    // journal-line path; absence of a future entry says nothing about older
    // lines missing from snapshots. Newly created periods start empty and
    // every posting path updates their snapshots in the same mutation.
    if (containingPeriod.snapshotFastPathEligible) {
      // The indexed probe reads at most one entry. A future-dated posting
      // requires the original date-bounded journal-line calculation.
      const futureEntry = await ctx.db
        .query("journalEntries")
        .withIndex("by_org_period_date", (q) =>
          q.eq("orgId", orgId).eq("periodId", containingPeriod._id).gt("accountingDate", asOfDate)
        )
        .first();
      if (!futureEntry) {
        await addPeriodSnapshots(ctx, orgId, containingPeriod._id, addTo);
        return { balances: Array.from(totals.values()), outcome: "OK" };
      }
    }

    // On a partial-period read, narrow the range by accounting date before
    // loading entries. Include REVERSED entries too: their original lines
    // remain postings, offset by a separately posted reversal.
    const allEntriesInPeriod = await ctx.db
      .query("journalEntries")
      .withIndex("by_org_period_date", (q) =>
        q.eq("orgId", orgId).eq("periodId", containingPeriod._id).lte("accountingDate", asOfDate)
      )
      .collect();
    const entriesInPeriod = allEntriesInPeriod.filter((e) => e.status === "POSTED" || e.status === "REVERSED");

    if (!(await addEntryLines(ctx, orgId, entriesInPeriod, addTo, check !== undefined))) {
      return { balances: [], outcome: "INCONSISTENT_REFERENCE" };
    }

    if (check) {
      const outcome = await verifyControlLineParents(ctx, {
        orgId,
        periodStartDate: containingPeriod.startDate,
        asOfDate,
        check,
        knownEntryIds: new Set(allEntriesInPeriod.map((e) => e._id)),
      });
      if (outcome !== "OK") return { balances: [], outcome };
    }
  }

  return { balances: Array.from(totals.values()), outcome: "OK" };
}
export type BoundedControlBalances =
  | {
      status: "OK";
      balances: CumulativeBalance[];
      /**
       * Accounts that have at least one journal line dated AFTER `asOfDate`. For these the balance is
       * only "as of" the date by the line dates; a caller that pairs it with a current-state subledger
       * (whose rows already include whatever those later lines belong to) must not call it a comparison.
       */
      accountsWithLaterLines: Array<Id<"chartOfAccounts">>;
    }
  | { status: "OVER_LIMIT" }
  /**
   * A line's `journalEntryId` names an entry that is missing or belongs to another organization (SCRUM-889).
   * `ctx.db.get` does not scope by tenant, and skipping the line could report an unreconciled ledger as
   * reconciled, so no balance is returned.
   */
  | { status: "INCONSISTENT_REFERENCE" };

/**
 * The same answer as getCumulativeBalancesAsOf, kept to the given accounts and counted against a
 * budget. getCumulativeBalancesAsOf reads every snapshot of every account (and, for a period without
 * a snapshot certificate, every journal line in it) before a caller can discard the accounts it does
 * not want. This reads only through the indexes that start with the account: the account's snapshots
 * (`by_org_account_currency_period_shard`) and, for the journal-line path, its lines
 * (`by_org_account_date`). Every document it reads - periods, snapshots, the future-entry probe, lines
 * and their entries - is charged to `readLimit`; if the next read would exceed it, nothing partial is
 * returned (OVER_LIMIT). Read-only. A bounded read here is still one Convex query, so the caller
 * stays inside the documents-per-function ceiling by choosing `readLimit` well under it.
 *
 * Which date governs (SCRUM-869 r3 M2): a line is in the balance by its OWN `accountingDate`, the way
 * getPostedLines includes it. The snapshot path is keyed by the entry's period, not by line dates, and
 * a certified period is read from snapshots only when no ENTRY is dated after `asOfDate`; so a line
 * dated after `asOfDate` inside an earlier-dated entry would be in a snapshot sum but not in the
 * line-date answer. Rather than guess, every account is probed for lines dated after `asOfDate` and
 * reported in `accountsWithLaterLines` (one indexed read each, charged only when it finds one).
 */
export async function getControlAccountBalancesAsOf(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  accountIds: ReadonlyArray<Id<"chartOfAccounts">>,
  asOfDate: number,
  readLimit: number
): Promise<BoundedControlBalances> {
  let remaining = readLimit;
  const over: BoundedControlBalances = { status: "OVER_LIMIT" };
  // A read of `rows` documents is allowed only while the budget covers it; callers `take(remaining + 1)`
  // so a result longer than the budget is detected without reading further.
  const charge = (rows: number): boolean => {
    remaining -= rows;
    return remaining >= 0;
  };

  const periods = await ctx.db
    .query("accountingPeriods")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .take(remaining + 1);
  if (!charge(periods.length)) return over;

  const fullyElapsedPeriods = periods.filter((p) => p.endDate <= asOfDate);
  const containingPeriod = periods.find((p) => p.startDate <= asOfDate && asOfDate < p.endDate);

  const snapshotPeriods = new Set<Id<"accountingPeriods">>(fullyElapsedPeriods.map((p) => p._id));
  let journalPeriod: (typeof periods)[number] | undefined;
  if (containingPeriod) {
    // Same rule as getCumulativeBalancesAsOf: a certified period with no entry dated after asOfDate is
    // summed from its snapshots; any other containing period is rebuilt from journal lines.
    let useSnapshots = false;
    if (containingPeriod.snapshotFastPathEligible) {
      const futureEntry = await ctx.db
        .query("journalEntries")
        .withIndex("by_org_period_date", (q) =>
          q.eq("orgId", orgId).eq("periodId", containingPeriod._id).gt("accountingDate", asOfDate)
        )
        .first();
      if (!charge(futureEntry ? 1 : 0)) return over;
      useSnapshots = !futureEntry;
    }
    if (useSnapshots) snapshotPeriods.add(containingPeriod._id);
    else journalPeriod = containingPeriod;
  }

  const totals = new Map<string, CumulativeBalance>();
  const addTo = (accountId: Id<"chartOfAccounts">, currency: string, debitMinor: number, creditMinor: number) => {
    const key = `${accountId}__${currency}`;
    const existing = totals.get(key) ?? { accountId, currency, debitMinor: 0, creditMinor: 0 };
    existing.debitMinor += debitMinor;
    existing.creditMinor += creditMinor;
    totals.set(key, existing);
  };

  const entryStatusCache = new Map<Id<"journalEntries">, boolean>();
  const accountsWithLaterLines: Array<Id<"chartOfAccounts">> = [];
  for (const accountId of new Set(accountIds)) {
    const later = await ctx.db
      .query("journalLines")
      .withIndex("by_org_account_date", (q) => q.eq("orgId", orgId).eq("accountId", accountId).gt("accountingDate", asOfDate))
      .first();
    if (later) {
      if (!charge(1)) return over;
      accountsWithLaterLines.push(accountId);
    }
    const snapshots = await ctx.db
      .query("accountBalanceSnapshots")
      .withIndex("by_org_account_currency_period_shard", (q) => q.eq("orgId", orgId).eq("accountId", accountId))
      .take(remaining + 1);
    if (!charge(snapshots.length)) return over;
    for (const s of snapshots) {
      if (snapshotPeriods.has(s.periodId)) addTo(s.accountId, s.currency, s.runningDebitMinor, s.runningCreditMinor);
    }

    if (journalPeriod) {
      const period = journalPeriod;
      // Include REVERSED entries too: their original lines remain postings, offset by a separately
      // posted reversal (as getCumulativeBalancesAsOf does).
      const lines = await ctx.db
        .query("journalLines")
        .withIndex("by_org_account_date", (q) =>
          q.eq("orgId", orgId).eq("accountId", accountId).gte("accountingDate", period.startDate).lte("accountingDate", asOfDate)
        )
        .take(remaining + 1);
      if (!charge(lines.length)) return over;
      for (const line of lines) {
        let counts = entryStatusCache.get(line.journalEntryId);
        if (counts === undefined) {
          if (!charge(1)) return over;
          const entry = await ctx.db.get(line.journalEntryId);
          if (!entry || entry.orgId !== orgId) return { status: "INCONSISTENT_REFERENCE" };
          counts = entry.periodId === period._id && (entry.status === "POSTED" || entry.status === "REVERSED");
          entryStatusCache.set(line.journalEntryId, counts);
        }
        if (counts) addTo(line.accountId, line.currency, line.debitMinor, line.creditMinor);
      }
    }
  }

  return { status: "OK", balances: Array.from(totals.values()), accountsWithLaterLines };
}