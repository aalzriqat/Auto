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
import { getDocumentSize } from "convex/values";
import type { TransactionMetrics } from "convex/server";
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
   * The verification pass would read more documents, or more bytes, than its budgets allow, or the transaction
   * has too little read headroom left to take the next read and still leave its caller a reserve (SCRUM-889).
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
 * Budget: that extra read is bounded two ways, and is refused with OVER_LIMIT before it would exceed either.
 * Convex caps one function at 32,000 documents scanned, 16 MiB read and 4,096 index ranges,
 * https://docs.convex.dev/production/state/limits, and meters all three for the whole transaction:
 *   - Caller caps, upper bounds that hold whatever else the transaction did. `readLimit` counts documents (one per
 *     control-account line read and one per parent entry fetched); `readBytesLimit` counts their `getDocumentSize`,
 *     the size formula Convex's own metering is built on (https://docs.convex.dev/database/types). A document count
 *     alone does not bound bytes: `journalLines.description` and `journalEntries.memo` are unbounded strings.
 *   - The transaction's own headroom, asked of `ctx.meta.getTransactionMetrics()` before EVERY read
 *     (https://docs.convex.dev/database/writing-data, "Checking transaction headroom"). A fixed cap cannot see what
 *     the rest of the transaction has already spent: the entry walk in this function reads the same lines the
 *     pass reads again, and (SCRUM-889 round 5) 16 balanced journals with 400,000-character descriptions fit the
 *     16 MiB limit for the walk alone while leaving no room for a second pass, so a 4 MiB cap still ended in a
 *     "Read too much data in a single function execution" throw. A read is refused unless the transaction can still
 *     take one more worst-case document (1 MiB) AND keep `VERIFICATION_RESERVE_*` free for the caller's remaining
 *     work. A context whose metrics cannot be read is refused too; the guard never fails open.
 * The lines are read as a stream, one `next()` at a time, and each document is charged as it arrives, so a refusal
 * stops the read at the budget plus one document; a single `take(n)` page cannot stop part-way. Because every
 * read is preceded by a fresh metrics read, nothing is cached across reads: concurrent readers in the same
 * transaction (the period-close checklist runs several reconciliations together) are seen as they spend.
 *
 * Evidence boundary: the headroom check is proven against convex-test's emulation of the 16 MiB limit
 * (`transactionLimits: true`), not against the Convex backend. Three things only the real backend can show are
 * deferred to the release rehearsal (SCRUM-762): that its metering matches `getDocumentSize`, the cost of one
 * `getTransactionMetrics` call per read (the documentation states no cost), and that a streamed `next()` does not
 * read ahead past one document. The reserve is a policy for the caller's later and concurrent work, not a proof
 * about it: a concurrent reader that spends more than the reserve between this guard's check and its read can
 * still exhaust the limit, as it could without this pass.
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
/** The accounts whose lines and parent entries are verified, and the caller's document and byte caps for that verification. */
type LedgerCheck = { accountIds: ReadonlyArray<Id<"chartOfAccounts">>; readLimit: number; readBytesLimit: number };

/** The largest a single Convex document can be, https://docs.convex.dev/production/state/limits: what one more read can cost. */
const MAX_DOCUMENT_BYTES = 1024 * 1024;
/**
 * What the transaction must still be able to read after a verification read, so the caller's later work and the
 * readers running beside it in the same transaction are not starved by this pass. The figures follow the reserve
 * the custody proof already holds back (CUSTODY_PROOF_CALLER_RESERVE_* in utils/custodySourceLedger.ts). They are
 * a policy, not a derivation: nothing here knows what the caller will read next. Exported for the tests that pin
 * the boundary.
 */
export const VERIFICATION_RESERVE_BYTES = 2 * 1024 * 1024;
export const VERIFICATION_RESERVE_DOCUMENTS = 2_000;
export const VERIFICATION_RESERVE_QUERIES = 256;

/** The part of a query or mutation context the headroom check needs. A context without it is one whose headroom cannot be read. */
type HeadroomCtx = { meta?: { getTransactionMetrics?: () => Promise<TransactionMetrics> } };

/** The size Convex's own read metering is built on (`getDocumentSize`), not a JSON approximation of it. */
function documentSize(doc: object): number {
  return getDocumentSize(doc as Parameters<typeof getDocumentSize>[0]);
}

/**
 * The read budget of one verification pass: the caller's document and byte caps, and the transaction's own headroom.
 * `hasHeadroom` is asked before every read; the `charge*` methods account for a document after it arrives, and
 * return false once a cap is passed.
 */
class VerificationBudget {
  private remainingDocs: number;
  private remainingBytes: number;

  constructor(
    private readonly ctx: HeadroomCtx,
    check: LedgerCheck
  ) {
    this.remainingDocs = check.readLimit;
    this.remainingBytes = check.readBytesLimit;
  }

  /**
   * True when the transaction can take one more read of a worst-case document and still leave the reserve.
   * Read fresh every time (see getCumulativeBalancesAsOfChecked). Fails closed: a context that cannot report its
   * metrics has no headroom.
   */
  async hasHeadroom(): Promise<boolean> {
    const read = this.ctx.meta?.getTransactionMetrics;
    if (typeof read !== "function") return false;
    const metrics = await read.call(this.ctx.meta);
    return (
      metrics.bytesRead.remaining >= MAX_DOCUMENT_BYTES + VERIFICATION_RESERVE_BYTES &&
      metrics.documentsRead.remaining >= 1 + VERIFICATION_RESERVE_DOCUMENTS &&
      metrics.databaseQueries.remaining >= 1 + VERIFICATION_RESERVE_QUERIES
    );
  }

  /** One control-account line read: one document and its bytes. */
  chargeLine(line: object): boolean {
    this.remainingDocs -= 1;
    this.remainingBytes -= documentSize(line);
    return this.remainingDocs >= 0 && this.remainingBytes >= 0;
  }

  /** One parent entry about to be fetched: charged a document before the fetch, its bytes after (see chargeParentBytes). */
  chargeParentFetch(): boolean {
    this.remainingDocs -= 1;
    return this.remainingDocs >= 0;
  }

  chargeParentBytes(parent: object): boolean {
    this.remainingBytes -= documentSize(parent);
    return this.remainingBytes >= 0;
  }
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
 * that is not one of `knownEntryIds`. Every read is first admitted by the transaction's own headroom
 * (`VerificationBudget.hasHeadroom`), and every line read and parent fetched is charged to `check.readLimit` (one
 * document each) and to `check.readBytesLimit` (its `getDocumentSize`); the first read that the transaction cannot
 * take, or that takes either cap below zero, answers OVER_LIMIT and nothing further is read. Lines arrive as a
 * stream, one `next()` at a time, so the read stops there. A parent is charged one document before it is fetched and
 * its bytes once it is, so the bytes can pass the cap by at most that one parent (a document is at most 1 MiB). The
 * headroom is checked before the line AND before the parent, so a parent the transaction cannot take is not fetched.
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
  const budget = new VerificationBudget(ctx, check);
  const resolvedElsewhere = new Set<Id<"journalEntries">>();
  for (const accountId of new Set(check.accountIds)) {
    const outcome = await verifyAccountLines(ctx, { orgId, accountId, periodStartDate, asOfDate, knownEntryIds, resolvedElsewhere, budget });
    if (outcome !== "OK") return outcome;
  }
  return "OK";
}

/** One checked account's lines in the period's range, streamed one document at a time, each admitted, charged and resolved. */
async function verifyAccountLines(
  ctx: QueryCtx,
  request: Readonly<{
    orgId: Id<"organizations">;
    accountId: Id<"chartOfAccounts">;
    periodStartDate: number;
    asOfDate: number;
    knownEntryIds: ReadonlySet<Id<"journalEntries">>;
    resolvedElsewhere: Set<Id<"journalEntries">>;
    budget: VerificationBudget;
  }>
): Promise<ReadOutcome> {
  const { orgId, accountId, periodStartDate, asOfDate, knownEntryIds, resolvedElsewhere, budget } = request;
  const lines = ctx.db
    .query("journalLines")
    .withIndex("by_org_account_date", (q) =>
      q.eq("orgId", orgId).eq("accountId", accountId).gte("accountingDate", periodStartDate).lte("accountingDate", asOfDate)
    )[Symbol.asyncIterator]();
  for (;;) {
    if (!(await budget.hasHeadroom())) return "OVER_LIMIT";
    const next = await lines.next();
    if (next.done) return "OK";
    if (!budget.chargeLine(next.value)) return "OVER_LIMIT";
    const entryId = next.value.journalEntryId;
    if (knownEntryIds.has(entryId) || resolvedElsewhere.has(entryId)) continue;
    const outcome = await resolveParentEntry(ctx, orgId, entryId, budget);
    if (outcome !== "OK") return outcome;
    resolvedElsewhere.add(entryId);
  }
}

/**
 * A line whose parent is not one of this organization's entries in the period: a same-org entry of another period or
 * date is outside this sum (as before); a missing or foreign one is an inconsistency.
 */
async function resolveParentEntry(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  entryId: Id<"journalEntries">,
  budget: VerificationBudget
): Promise<ReadOutcome> {
  if (!(await budget.hasHeadroom()) || !budget.chargeParentFetch()) return "OVER_LIMIT";
  const parent = await ctx.db.get(entryId);
  if (!parent || parent.orgId !== orgId) return "INCONSISTENT_REFERENCE";
  return budget.chargeParentBytes(parent) ? "OK" : "OVER_LIMIT";
}

async function readCumulativeBalances(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  asOfDate: number,
  /** When given, the journal-line path verifies line and parent ownership within document and byte caps and the transaction's read headroom (see getCumulativeBalancesAsOfChecked). */
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