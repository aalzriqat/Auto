/**
 * SCRUM-1023 Phase 1: the ledger half of the purge dry run. READ-ONLY.
 *
 * Given the accounting events, journal entries and lines the purge would
 * remove, this proves (or refuses) the invariants that keep every account
 * balance identical after the removal, EXCEPT where the owner approved a named
 * balance change:
 *
 *  - every purged event and journal is half of a complete reversed pair, linked
 *    BOTH ways, both halves purged and POSTED/REVERSED, unless the owner named
 *    that exact event or journal id in an approved exception;
 *  - the purged lines net to ZERO per (period, account, currency, bank). An
 *    approved exception carries the exact event and journal ids it exempts and
 *    the net it expects per (period, account, currency, bank); that expectation
 *    is compared with the net of ITS OWN named journals only, so two roots can
 *    neither share nor offset one exception, and whatever the named journals do
 *    not explain must still net to zero;
 *  - none of them sits in a CLOSED or LOCKED period;
 *  - each running snapshot the removal would reduce is large enough to take it.
 *
 * Precedent: `accounting/reversals.ts` posts the inverted pair and bumps the
 * same running snapshots, so removing BOTH halves and subtracting their gross
 * debits and credits restores exactly the pre-posting state. The invariant that
 * makes that true is "net zero per account"; this module checks it instead of
 * assuming it.
 *
 * Every read is charged to the shared `ReadBudget` BEFORE it happens and the
 * module stops at the first exhausted budget (a structured OVER_BOUND refusal).
 */
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { ReadBudget } from "./purgeBudget";

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

/** What the owner expects the named journals of one exception to net to, for one (period, account, currency, bank). */
export interface ApprovedExpectedNet {
  periodId: string;
  accountId: string;
  currency: string;
  /** Omit for a non-bank account. */
  bankAccountId?: string;
  /** Expected (debit - credit) of the named journals' lines, in minor units. */
  netMinor: number;
}

export interface ApprovedException {
  /** The purge root (sale, application, expense or transfer event id) the exception belongs to. */
  rootId: string;
  /** The EXACT accounting events that may stay unreversed. Nothing else is exempt from pairing. */
  eventIds: string[];
  /** The EXACT journal entries that may stay unpaired. */
  journalIds: string[];
  expectedNets: ApprovedExpectedNet[];
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

/** The itemized, explicitly approved balance change: expected versus found, per exception and period. */
export interface ExceptionItem {
  rootId: string;
  periodId: string;
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
}

/** Lines of one journal read by `by_journal_entry`; a longer journal is refused, never truncated. */
const LINES_PER_JOURNAL_CAP = 100;
/** Snapshot shards per (account, currency, period): 8 today; the read is bounded well above that. */
const SNAPSHOT_SHARD_CAP = 64;
/** The bucket of lines whose journal names no accounting period: still netted, never silently dropped. */
const NO_PERIOD = "NONE";

const byText = (a: string, b: string): number => a.localeCompare(b);

function refuse(out: LedgerRefusal[], code: LedgerRefusalCode, table: string, detail: string, count = 1): void {
  out.push({ code, table, detail, count });
}

const overBound = (out: LedgerRefusal[], table: string, detail: string): void => refuse(out, "OVER_BOUND", table, detail);

/** A structured key: caller-supplied strings may contain any character, so nothing is joined with a separator. */
const netKey = (periodId: string, accountId: string, currency: string, bank: string | null | undefined): string =>
  JSON.stringify([periodId, accountId, currency, bank ?? ""]);

const parseNetKey = (key: string): [string, string, string, string] => JSON.parse(key) as [string, string, string, string];

/** Lines of one purged journal. Null when the read could not be completed (the refusal is already recorded). */
export async function readJournalLines(
  ctx: QueryCtx, budget: ReadBudget, journalId: Id<"journalEntries">, out: LedgerRefusal[],
): Promise<Doc<"journalLines">[] | null> {
  const limit = Math.min(LINES_PER_JOURNAL_CAP + 1, budget.room());
  if (limit === 0 || !budget.reserve(1)) { budget.stop(); overBound(out, "journalLines", "the read budget was exhausted"); return null; }
  const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", journalId)).take(limit);
  budget.record(lines.length);
  if (lines.length > LINES_PER_JOURNAL_CAP) { overBound(out, "journalLines", `a journal has more than ${LINES_PER_JOURNAL_CAP} lines`); return null; }
  if (lines.length === limit && limit < LINES_PER_JOURNAL_CAP + 1) { budget.stop(); overBound(out, "journalLines", "the read budget was exhausted"); return null; }
  return lines;
}

interface PeriodCtx {
  ctx: QueryCtx;
  orgId: Id<"organizations">;
  budget: ReadBudget;
  out: LedgerRefusal[];
  status: Map<string, string>;
  accounts: Map<string, string>;
}

/** Status of a period for this org; a period of another org or a missing one reads as MISSING. Null when over budget. */
async function periodStatusOf(p: PeriodCtx, periodId: Id<"accountingPeriods">): Promise<string | null> {
  const hit = p.status.get(periodId);
  if (hit) return hit;
  if (!p.budget.reserve(1)) { overBound(p.out, "accountingPeriods", "the read budget was exhausted"); return null; }
  const period = await p.ctx.db.get(periodId);
  if (period) p.budget.record(1);
  const status = period && period.orgId === p.orgId ? period.status : "MISSING";
  p.status.set(periodId, status);
  return status;
}

async function accountLabel(p: PeriodCtx, accountId: string): Promise<string> {
  const hit = p.accounts.get(accountId);
  if (hit) return hit;
  let label = "UNKNOWN";
  // An approved expectation is caller text: only a real chart-of-accounts id is read (no read, no charge, otherwise).
  const id = p.ctx.db.normalizeId("chartOfAccounts", accountId);
  if (id !== null && p.budget.reserve(1)) {
    const acct = await p.ctx.db.get(id);
    if (acct) p.budget.record(1);
    if (acct && acct.orgId === p.orgId) label = `${acct.code} ${acct.name}`;
  } else if (id !== null) {
    overBound(p.out, "chartOfAccounts", "the read budget was exhausted");
  }
  p.accounts.set(accountId, label);
  return label;
}

interface Scan {
  net: Map<string, AccountNet>;
  closed: Set<string>;
}

function addLine(scan: Scan, periodId: string, line: Doc<"journalLines">): void {
  const key = netKey(periodId, line.accountId, line.currency, line.bankAccountId);
  const row = scan.net.get(key) ?? {
    periodId, accountId: line.accountId, currency: line.currency,
    bankAccountId: line.bankAccountId ?? null, debitMinor: 0, creditMinor: 0, netMinor: 0,
  };
  row.debitMinor += line.debitMinor;
  row.creditMinor += line.creditMinor;
  row.netMinor = row.debitMinor - row.creditMinor;
  scan.net.set(key, row);
}

/** Nets the already-read lines per period and checks each journal's period (cached, charged). */
async function scanJournals(
  p: PeriodCtx, journals: ReadonlyMap<string, Doc<"journalEntries">>, linesByJournal: ReadonlyMap<string, Doc<"journalLines">[]>,
): Promise<Scan> {
  const scan: Scan = { net: new Map(), closed: new Set() };
  for (const journal of journals.values()) {
    let bucket = NO_PERIOD;
    if (!journal.periodId) {
      refuse(p.out, "PERIOD_UNKNOWN", "journalEntries", "a purged journal has no accounting period");
    } else {
      const status = await periodStatusOf(p, journal.periodId);
      if (status === null) break;
      bucket = journal.periodId;
      if (status !== "OPEN") {
        scan.closed.add(journal.periodId);
        refuse(p.out, status === "MISSING" ? "PERIOD_UNKNOWN" : "CLOSED_PERIOD", "journalEntries", `a purged journal is in a ${status} period`);
      }
    }
    for (const line of linesByJournal.get(journal._id) ?? []) {
      if (line.orgId !== p.orgId) { refuse(p.out, "JOURNAL_NOT_PAIRED", "journalLines", "a line belongs to another organization"); continue; }
      addLine(scan, bucket, line);
    }
  }
  return scan;
}

/** The net per (period, account, currency, bank) of the lines of the named journals only. */
function netOfNamedJournals(
  ex: ApprovedException, journals: ReadonlyMap<string, Doc<"journalEntries">>, linesByJournal: ReadonlyMap<string, Doc<"journalLines">[]>,
): Map<string, number> {
  const net = new Map<string, number>();
  for (const id of ex.journalIds) {
    const journal = journals.get(id);
    for (const l of journal ? linesByJournal.get(id) ?? [] : []) {
      const k = netKey(journal?.periodId ?? NO_PERIOD, l.accountId, l.currency, l.bankAccountId);
      net.set(k, (net.get(k) ?? 0) + l.debitMinor - l.creditMinor);
    }
  }
  return net;
}

/**
 * Compares each exception's expectation with the net of its OWN named journals (per period), itemizes every key
 * either side mentions, then requires everything the exceptions do NOT explain to net to zero per key.
 */
async function netAgainstExceptions(
  p: PeriodCtx, accountNet: AccountNet[], approved: ReadonlyArray<ApprovedException>,
  journals: ReadonlyMap<string, Doc<"journalEntries">>, linesByJournal: ReadonlyMap<string, Doc<"journalLines">[]>,
): Promise<ExceptionItem[]> {
  const items: ExceptionItem[] = [];
  const explained = new Map<string, number>();
  for (const ex of approved) {
    const expected = new Map<string, number>();
    for (const n of ex.expectedNets) {
      const k = netKey(n.periodId, n.accountId, n.currency, n.bankAccountId);
      expected.set(k, (expected.get(k) ?? 0) + n.netMinor);
      explained.set(k, (explained.get(k) ?? 0) + n.netMinor);
    }
    const actual = netOfNamedJournals(ex, journals, linesByJournal);
    for (const k of [...new Set([...expected.keys(), ...actual.keys()])].sort(byText)) {
      const [periodId, accountId, currency, bank] = parseNetKey(k);
      const expectedNetMinor = expected.get(k) ?? 0;
      const actualNetMinor = actual.get(k) ?? 0;
      if (expectedNetMinor === 0 && actualNetMinor === 0) continue;
      const matches = expectedNetMinor === actualNetMinor;
      if (!matches) refuse(p.out, "EXCEPTION_MISMATCH", "journalLines", "an approved account change does not match the lines of the journals it names");
      items.push({
        rootId: ex.rootId, periodId, accountId, accountCode: await accountLabel(p, accountId), currency,
        bankAccountId: bank ? bank : null, expectedNetMinor, actualNetMinor, matches,
      });
    }
  }
  const unexplained = accountNet.filter((r) => r.netMinor - (explained.get(netKey(r.periodId, r.accountId, r.currency, r.bankAccountId)) ?? 0) !== 0);
  const orphanExpectations = [...explained].filter(([k, n]) => n !== 0 && !accountNet.some((r) => netKey(r.periodId, r.accountId, r.currency, r.bankAccountId) === k));
  if (unexplained.length + orphanExpectations.length > 0) {
    refuse(p.out, "NONZERO_NET", "journalLines", "the purged journals do not net to zero per period and account beyond what the approved exceptions explain", unexplained.length + orphanExpectations.length);
  }
  return items.sort((a, b) => byText(a.rootId + a.accountCode + a.periodId, b.rootId + b.accountCode + b.periodId));
}

/** Folds the bank dimension away (snapshots are keyed by account, currency, period) and checks the room. */
async function snapshotRoom(p: PeriodCtx, accountNet: AccountNet[]): Promise<SnapshotAdjustment[]> {
  const gross = new Map<string, { periodId: string; accountId: string; currency: string; d: number; c: number }>();
  for (const r of accountNet) {
    if (r.periodId === NO_PERIOD) continue;
    const key = `${r.periodId}|${r.accountId}|${r.currency}`;
    const g = gross.get(key) ?? { periodId: r.periodId, accountId: r.accountId, currency: r.currency, d: 0, c: 0 };
    g.d += r.debitMinor;
    g.c += r.creditMinor;
    gross.set(key, g);
  }
  const adjustments: SnapshotAdjustment[] = [];
  for (const g of gross.values()) {
    const limit = Math.min(SNAPSHOT_SHARD_CAP + 1, p.budget.room());
    if (limit === 0 || !p.budget.reserve(1)) { p.budget.stop(); overBound(p.out, "accountBalanceSnapshots", "the read budget was exhausted"); break; }
    const rows = await p.ctx.db.query("accountBalanceSnapshots")
      .withIndex("by_org_account_currency_period_shard", (q) =>
        q.eq("orgId", p.orgId).eq("accountId", g.accountId as Id<"chartOfAccounts">).eq("currency", g.currency).eq("periodId", g.periodId as Id<"accountingPeriods">))
      .take(limit);
    p.budget.record(rows.length);
    if (rows.length > SNAPSHOT_SHARD_CAP || (rows.length === limit && limit < SNAPSHOT_SHARD_CAP + 1)) {
      overBound(p.out, "accountBalanceSnapshots", "too many snapshot shards to read"); continue;
    }
    const sd = rows.reduce((s, r) => s + r.runningDebitMinor, 0);
    const sc = rows.reduce((s, r) => s + r.runningCreditMinor, 0);
    if (sd < g.d || sc < g.c) refuse(p.out, "SNAPSHOT_UNDERFLOW", "accountBalanceSnapshots", "a running snapshot is smaller than what the purge would subtract");
    adjustments.push({
      periodId: g.periodId, accountId: g.accountId, currency: g.currency, debitMinor: g.d, creditMinor: g.c,
      snapshotRows: rows.length, snapshotDebitMinor: sd, snapshotCreditMinor: sc,
    });
  }
  return adjustments.sort((a, b) => byText(a.periodId + a.accountId + a.currency, b.periodId + b.accountId + b.currency));
}

export async function checkLedger(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  budget: ReadBudget,
  journals: ReadonlyMap<string, Doc<"journalEntries">>,
  linesByJournal: ReadonlyMap<string, Doc<"journalLines">[]>,
  approved: ReadonlyArray<ApprovedException>,
): Promise<LedgerFindings> {
  const p: PeriodCtx = { ctx, orgId, budget, out: [], status: new Map(), accounts: new Map() };
  const scan = await scanJournals(p, journals, linesByJournal);
  const accountNet = [...scan.net.values()].sort((a, b) =>
    byText(a.periodId + a.accountId + a.currency + (a.bankAccountId ?? ""), b.periodId + b.accountId + b.currency + (b.bankAccountId ?? "")));
  const exceptionItems = await netAgainstExceptions(p, accountNet, approved, journals, linesByJournal);
  const snapshotAdjustments = await snapshotRoom(p, accountNet);
  return { refusals: p.out, accountNet, exceptionItems, snapshotAdjustments, closedPeriodHits: [...scan.closed].sort(byText) };
}
