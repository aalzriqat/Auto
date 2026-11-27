/**
 * SCRUM-1023 Phase 1: the ledger half of the purge dry run. READ-ONLY.
 *
 * Given the accounting events, journal entries and lines the purge would
 * remove, this proves (or refuses) the invariants that keep every account
 * balance identical after the removal, EXCEPT where the owner approved a named
 * balance change:
 *
 *  - every purged event is half of a complete reversed pair, both halves purged,
 *    unless it belongs to an owner-approved exception root;
 *  - the purged journals net to ZERO per (period, account, currency, bank),
 *    except the per-account amounts the owner approved for an exception root;
 *    any other non-zero net, and any approved amount that does not match, refuses;
 *  - none of them sits in a CLOSED or LOCKED period;
 *  - each running snapshot the removal would reduce is large enough to take it.
 *
 * Precedent: `accounting/reversals.ts` posts the inverted pair and bumps the
 * same running snapshots, so removing BOTH halves and subtracting their gross
 * debits and credits restores exactly the pre-posting state. The invariant that
 * makes that true is "net zero per account"; this module checks it instead of
 * assuming it. An approved exception is the one place the net is allowed to be
 * non-zero, and it is only allowed for the exact amount named, so a typo or a
 * second hidden entry still refuses.
 */
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

export type LedgerRefusalCode =
  | "INCOMPLETE_REVERSAL_PAIR"
  | "UNREVERSED_EVENT"
  | "JOURNAL_NOT_PAIRED"
  | "NONZERO_NET"
  | "EXCEPTION_MISMATCH"
  | "CLOSED_PERIOD"
  | "PERIOD_UNKNOWN"
  | "SNAPSHOT_UNDERFLOW"
  | "OVER_BOUND";

export interface LedgerRefusal {
  code: LedgerRefusalCode;
  table: string;
  detail: string;
  count: number;
}

/** One account's balance change the owner has approved for one purge root. */
export interface ApprovedAccountDelta {
  accountId: string;
  currency: string;
  /** Omit for a non-bank account. */
  bankAccountId?: string;
  /** Expected (debit - credit) of the removed lines, in minor units. */
  netMinor: number;
}

export interface ApprovedException {
  /** The purge root (sale, application, expense or transfer event id) the amounts belong to. */
  rootId: string;
  accountDeltas: ApprovedAccountDelta[];
}

export interface AccountNet {
  periodId: string;
  accountId: string;
  currency: string;
  bankAccountId: string | null;
  debitMinor: number;
  creditMinor: number;
  netMinor: number;
}

/** The itemized, explicitly approved balance change: expected versus found. */
export interface ExceptionItem {
  accountId: string;
  accountCode: string;
  currency: string;
  bankAccountId: string | null;
  expectedNetMinor: number;
  actualNetMinor: number;
  /** Both nets are (debit - credit) of the REMOVED lines; the balance moves by the opposite sign. */
  matches: boolean;
}

export interface SnapshotAdjustment {
  periodId: string;
  accountId: string;
  currency: string;
  debitMinor: number;
  creditMinor: number;
  snapshotRows: number;
  snapshotDebitMinor: number;
  snapshotCreditMinor: number;
}

export interface LedgerFindings {
  refusals: LedgerRefusal[];
  accountNet: AccountNet[];
  exceptionItems: ExceptionItem[];
  snapshotAdjustments: SnapshotAdjustment[];
  closedPeriodHits: string[];
  lineIds: string[];
  linesByJournal: Map<string, Doc<"journalLines">[]>;
}

/** Lines of one journal read by `by_journal_entry`; a longer journal is refused, never truncated. */
const LINES_PER_JOURNAL_CAP = 100;
/** Snapshot shards per (account, currency, period): 8 today; the read is bounded well above that. */
const SNAPSHOT_SHARD_CAP = 64;

function refuse(out: LedgerRefusal[], code: LedgerRefusalCode, table: string, detail: string, count = 1): void {
  out.push({ code, table, detail, count });
}

const netKey = (accountId: string, currency: string, bank: string | null | undefined): string =>
  `${accountId}|${currency}|${bank ?? ""}`;

/**
 * Pair completeness of events and journals. `allowedUnreversedEventIds` are the
 * events of approved exception roots: they have no reversal, by the owner's
 * ruling, and their journals need none either.
 */
export function checkPairs(
  events: ReadonlyMap<string, Doc<"accountingEvents">>,
  journals: ReadonlyMap<string, Doc<"journalEntries">>,
  out: LedgerRefusal[],
  allowedUnreversedEventIds: ReadonlySet<string> = new Set(),
): void {
  const allowedJournalIds = new Set<string>();
  for (const e of events.values()) {
    if (allowedUnreversedEventIds.has(e._id)) {
      if (e.journalEntryId) allowedJournalIds.add(e.journalEntryId);
      if (e.eventType === "JOURNAL_REVERSAL" || e.status === "REVERSED") {
        refuse(out, "EXCEPTION_MISMATCH", "accountingEvents", "an approved exception names an event that is already reversed");
      }
      continue;
    }
    if (e.eventType === "JOURNAL_REVERSAL") {
      if (!e.reversalOfEventId || !events.has(e.reversalOfEventId)) {
        refuse(out, "INCOMPLETE_REVERSAL_PAIR", "accountingEvents", "a reversal whose original is not in the purge set");
      }
    } else if (e.status !== "REVERSED") {
      refuse(out, "UNREVERSED_EVENT", "accountingEvents", `a ${e.status} ${e.eventType} event that was never reversed`);
    } else if (!e.reversedByEventId || !events.has(e.reversedByEventId)) {
      refuse(out, "INCOMPLETE_REVERSAL_PAIR", "accountingEvents", "an original whose reversal is not in the purge set");
    }
  }
  for (const j of journals.values()) {
    if (allowedJournalIds.has(j._id)) continue;
    const paired =
      (j.status === "REVERSED" && !!j.reversedByJournalEntryId && journals.has(j.reversedByJournalEntryId)) ||
      (j.category === "REVERSAL" && !!j.reversalOfJournalEntryId && journals.has(j.reversalOfJournalEntryId));
    if (!paired) refuse(out, "JOURNAL_NOT_PAIRED", "journalEntries", `a ${j.status}/${j.category} journal without its pair`);
  }
}

export async function checkLedger(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  journals: ReadonlyMap<string, Doc<"journalEntries">>,
  charge: (docs: number) => boolean,
  approved: ReadonlyArray<ApprovedException> = [],
): Promise<LedgerFindings> {
  const refusals: LedgerRefusal[] = [];
  const linesByJournal = new Map<string, Doc<"journalLines">[]>();
  const lineIds: string[] = [];
  const net = new Map<string, AccountNet>();
  const closed = new Set<string>();
  const periodStatus = new Map<string, string>();

  for (const journal of journals.values()) {
    if (!journal.periodId) {
      refuse(refusals, "PERIOD_UNKNOWN", "journalEntries", "a purged journal has no accounting period");
      continue;
    }
    if (!periodStatus.has(journal.periodId)) {
      const period = await ctx.db.get(journal.periodId);
      periodStatus.set(journal.periodId, period && period.orgId === orgId ? period.status : "MISSING");
    }
    const status = periodStatus.get(journal.periodId);
    if (status !== "OPEN") {
      closed.add(journal.periodId);
      refuse(refusals, status === "MISSING" ? "PERIOD_UNKNOWN" : "CLOSED_PERIOD", "journalEntries", `a purged journal is in a ${status} period`);
    }
    const lines = await ctx.db.query("journalLines")
      .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", journal._id)).take(LINES_PER_JOURNAL_CAP + 1);
    if (!charge(lines.length)) { refuse(refusals, "OVER_BOUND", "journalLines", "the read budget was exhausted"); break; }
    if (lines.length > LINES_PER_JOURNAL_CAP) {
      refuse(refusals, "OVER_BOUND", "journalLines", `a journal has more than ${LINES_PER_JOURNAL_CAP} lines`);
      continue;
    }
    linesByJournal.set(journal._id, lines);
    for (const line of lines) {
      lineIds.push(line._id);
      if (line.orgId !== orgId) { refuse(refusals, "JOURNAL_NOT_PAIRED", "journalLines", "a line belongs to another organization"); continue; }
      const key = `${journal.periodId}|${netKey(line.accountId, line.currency, line.bankAccountId)}`;
      const row = net.get(key) ?? {
        periodId: journal.periodId, accountId: line.accountId, currency: line.currency,
        bankAccountId: line.bankAccountId ?? null, debitMinor: 0, creditMinor: 0, netMinor: 0,
      };
      row.debitMinor += line.debitMinor;
      row.creditMinor += line.creditMinor;
      row.netMinor = row.debitMinor - row.creditMinor;
      net.set(key, row);
    }
  }

  const accountNet = [...net.values()].sort((a, b) =>
    (a.periodId + a.accountId + a.currency + (a.bankAccountId ?? "")).localeCompare(b.periodId + b.accountId + b.currency + (b.bankAccountId ?? "")));

  // Expected net per (account, currency, bank), summed over every approved exception.
  const expected = new Map<string, number>();
  for (const ex of approved) {
    for (const d of ex.accountDeltas) {
      const k = netKey(d.accountId, d.currency, d.bankAccountId);
      expected.set(k, (expected.get(k) ?? 0) + d.netMinor);
    }
  }
  const actualByKey = new Map<string, { accountId: string; currency: string; bank: string | null; net: number }>();
  for (const r of accountNet) {
    const k = netKey(r.accountId, r.currency, r.bankAccountId);
    const cur = actualByKey.get(k) ?? { accountId: r.accountId, currency: r.currency, bank: r.bankAccountId, net: 0 };
    cur.net += r.netMinor;
    actualByKey.set(k, cur);
  }
  // A key with an approved expectation is compared in total; every other key must net to zero per period.
  const unapproved = accountNet.filter((r) => r.netMinor !== 0 && !expected.has(netKey(r.accountId, r.currency, r.bankAccountId)));
  if (unapproved.length > 0) {
    refuse(refusals, "NONZERO_NET", "journalLines", "the purged journals do not net to zero per account", unapproved.length);
  }
  const codeCache = new Map<string, string>();
  const codeOf = async (accountId: string): Promise<string> => {
    if (!codeCache.has(accountId)) {
      const acct = await ctx.db.get(accountId as Id<"chartOfAccounts">);
      codeCache.set(accountId, acct && acct.orgId === orgId ? `${acct.code} ${acct.name}` : "UNKNOWN");
    }
    return codeCache.get(accountId) ?? "UNKNOWN";
  };
  const exceptionItems: ExceptionItem[] = [];
  const keys = new Set<string>([...expected.keys()]);
  for (const k of keys) {
    const [accountId, currency, bank] = k.split("|");
    const actualNet = actualByKey.get(k)?.net ?? 0;
    const expectedNet = expected.get(k) ?? 0;
    const matches = actualNet === expectedNet;
    if (!matches) refuse(refusals, "EXCEPTION_MISMATCH", "journalLines", "an approved account change does not match the purged lines");
    exceptionItems.push({
      accountId, accountCode: await codeOf(accountId), currency, bankAccountId: bank ? bank : null,
      expectedNetMinor: expectedNet, actualNetMinor: actualNet, matches,
    });
  }
  exceptionItems.sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  // Snapshots are keyed (account, currency, period), not by bank, so fold the bank dimension away.
  const gross = new Map<string, { periodId: string; accountId: string; currency: string; d: number; c: number }>();
  for (const r of accountNet) {
    const key = `${r.periodId}|${r.accountId}|${r.currency}`;
    const g = gross.get(key) ?? { periodId: r.periodId, accountId: r.accountId, currency: r.currency, d: 0, c: 0 };
    g.d += r.debitMinor;
    g.c += r.creditMinor;
    gross.set(key, g);
  }
  const snapshotAdjustments: SnapshotAdjustment[] = [];
  for (const g of gross.values()) {
    const rows = await ctx.db.query("accountBalanceSnapshots")
      .withIndex("by_org_account_currency_period_shard", (q) =>
        q.eq("orgId", orgId).eq("accountId", g.accountId as Id<"chartOfAccounts">).eq("currency", g.currency).eq("periodId", g.periodId as Id<"accountingPeriods">))
      .take(SNAPSHOT_SHARD_CAP + 1);
    if (!charge(rows.length) || rows.length > SNAPSHOT_SHARD_CAP) { refuse(refusals, "OVER_BOUND", "accountBalanceSnapshots", "too many snapshot shards to read"); continue; }
    const sd = rows.reduce((s, r) => s + r.runningDebitMinor, 0);
    const sc = rows.reduce((s, r) => s + r.runningCreditMinor, 0);
    if (sd < g.d || sc < g.c) refuse(refusals, "SNAPSHOT_UNDERFLOW", "accountBalanceSnapshots", "a running snapshot is smaller than what the purge would subtract");
    snapshotAdjustments.push({
      periodId: g.periodId, accountId: g.accountId, currency: g.currency, debitMinor: g.d, creditMinor: g.c,
      snapshotRows: rows.length, snapshotDebitMinor: sd, snapshotCreditMinor: sc,
    });
  }
  snapshotAdjustments.sort((a, b) => (a.periodId + a.accountId + a.currency).localeCompare(b.periodId + b.accountId + b.currency));
  return { refusals, accountNet, exceptionItems, snapshotAdjustments, closedPeriodHits: [...closed].sort((a, b) => a.localeCompare(b)), lineIds: lineIds.sort((a, b) => a.localeCompare(b)), linesByJournal };
}
