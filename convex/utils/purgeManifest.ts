/**
 * SCRUM-1023 Phase 1: builds the purge DRY-RUN manifest. READ-ONLY, bounded.
 *
 * It never writes. Starting only from the explicit roots the caller names, it
 * grows the purge set to a fixpoint, then PROVES the removal is safe or says
 * exactly why not (a refusal is a normal return value, so the owner reads every
 * reason at once instead of fixing them one thrown error at a time).
 *
 * Mechanism, in the order the checks run:
 *  1. every root exists in this org and is in a purgeable state (deleted /
 *     cancelled / reversed). A live record is refused, never "approximately" purged.
 *  2. each table of the impact map (and the three root tables, as survivors) is
 *     read once through its org-leading index under a hard budget. A table too
 *     big to read completely, or a spent budget, REFUSES (OVER_BOUND) and the
 *     scan stops: an incomplete scan would be a silent miss.
 *  3. closure to a fixpoint, ledger included: a STRUCTURAL / LEDGER / DERIVED
 *     row joins when an id token in it is already in the set, UNLESS it also
 *     names a live sale/application/expense (SHARED_WITH_LIVE). Purged events
 *     bring their journals, purged journals bring their lines, and those line
 *     ids are tokens that pull in their bank aggregate items, so the survivor
 *     check below sees the FINAL set.
 *  4. commercial deals only the purged roots point at join; kept rows tied by
 *     one clearable link field become field clears; other kept rows that
 *     mention the set (root tables, REFUSE_IF_REFERENCED, the organization row)
 *     are surviving references. Audit rows whose SUBJECT is purged leave with it; one about a KEPT record that only mentions a purged id refuses (AUDIT_MIXED_SUBJECT).
 *  5. purged rows in a live money state refuse unless the owner approved the id.
 *  6. the ledger proof (`purgeManifestLedger`): complete reversed pairs linked
 *     both ways, zero net per period and account except owner-approved
 *     exceptions pinned to exact ids, open periods, snapshot room.
 */
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { PURGE_ORG_INDEX, PURGE_ROOT_SURVIVOR_INDEX } from "./purgeImpactMap";
import { readOrgLessAdminAudit, selectAuditRows, type AuditKept } from "./purgeAuditRows";
import { refuseExceptions, refuseShared, refuseUnreachable } from "./purgeManifestRefusals";
import { checkConfirmedPaymentEvidence, type ConfirmedPaymentEvidence } from "./purgeEvidence";
import { checkHandover, type HandoverOverride } from "./purgeHandover";
import { joinOwnedChildren, proveExplicitRoots, sharedExplicitRoots, type RootProof } from "./purgeRootProofs";
import { DEFAULT_PURGE_LIMITS, ReadBudget, type PurgeLimits } from "./purgeBudget";
import { checkPairs, normalizeApproved } from "./purgeManifestPairs";
import {
  checkLedger, readJournalLines,
  type AccountNet, type ApprovedException, type ExceptionItem, type LedgerRefusal, type SnapshotAdjustment,
} from "./purgeManifestLedger";
import {
  checkLiveStates, findSurvivors, growClosure, joinForwardLinked, namesLiveRoot, PurgeSet, sharedRoots, storageRefs, TokenIndex,
  type FieldClear, type ManifestRefusal, type ManifestRefusalCode, type Row, type StorageRef, type SurvivingReference,
} from "./purgeSurvivors";

export type { ApprovedException } from "./purgeManifestLedger";
export type { PurgeLimits } from "./purgeBudget";
export type { ManifestRefusal, ManifestRefusalCode } from "./purgeSurvivors";

export interface PurgeRoots {
  saleIds: string[];
  applicationIds: string[];
  expenseIds: string[];
  /** TREASURY_TRANSFER accountingEvents: a transfer has no table of its own. */
  transferEventIds: string[];
  /** Phase 1b: CANCELLED payroll runs that never posted or paid anything. */
  payrollRunIds?: string[];
  /** Phase 1b: fully REFUNDED deposits whose receipt and refund net to zero. */
  depositIds?: string[];
}

export interface PurgeManifest {
  ok: boolean;
  refusals: ManifestRefusal[];
  idsByTable: Record<string, string[]>;
  countsByTable: Record<string, number>;
  /** Audit rows that mention the purge set but are about a KEPT record: they refuse (AUDIT_MIXED_SUBJECT), never deleted. */
  auditRowsByTable: Record<string, number>;
  /** Phase 1b: audit rows that leave with the purge (their subject is purged) but also name a kept record. */
  auditRowsMentioningKept: AuditKept[];
  /** Phase 1b: every CONFIRMED lender payment of a purged application, itemized (no personal data). */
  confirmedPaymentEvidence: ConfirmedPaymentEvidence[];
  handoverOverrides: HandoverOverride[];
  /** Phase 1b: what proved each payroll-run and deposit root eligible. */
  rootProofs: RootProof[];
  survivingReferences: SurvivingReference[];
  /** Kept rows whose ONE link field into the purge set Phase 2 empties (instead of refusing). */
  fieldClears: FieldClear[];
  /** Storage files of purged rows, for Phase 2 to delete. */
  storageIds: StorageRef[];
  accountNet: AccountNet[];
  exceptionItems: ExceptionItem[];
  snapshotAdjustments: SnapshotAdjustment[];
  closedPeriodHits: string[];
  totals: { tables: number; rows: number; journals: number; journalLines: number; events: number; docsRead: number; rangesRead: number };
}

type RootTable = "sales" | "financeApplications" | "expenses" | "accountingEvents" | "payrollRuns" | "deposits";
const byText = (a: string, b: string): number => a.localeCompare(b);

interface Run {
  ctx: QueryCtx;
  orgId: Id<"organizations">;
  budget: ReadBudget;
  refusals: ManifestRefusal[];
  set: PurgeSet;
}

const refuseIn = (run: Run, code: ManifestRefusalCode, table: string, detail: string, count = 1): void => {
  run.refusals.push({ code, table, detail, count });
};

const overBound = (run: Run, table: string, detail: string): void => refuseIn(run, "OVER_BOUND", table, detail);

/**
 * One localized cast: the table name is data here (the impact map), so the
 * generated per-table types cannot apply. Every table read this way is covered
 * by the census test, which proves each name exists and has its org-leading index.
 */
async function readOrgTable(ctx: QueryCtx, table: string, index: string, orgId: Id<"organizations">, limit: number): Promise<Row[]> {
  // `as "sales"` / `as "by_org"` only satisfy the compiler; the runtime names are the map's.
  return await ctx.db.query(table as "sales").withIndex(index as "by_org", (b) => b.eq("orgId", orgId)).take(limit);
}

/** Loads one root, refuses it when missing or not in a purgeable state, otherwise adds it. */
async function loadRoot<T extends RootTable>(
  run: Run, table: T, raw: string, label: string, notEligible: (row: Doc<T>) => string | null,
): Promise<void> {
  const id = run.ctx.db.normalizeId(table, raw);
  let row: Doc<T> | null = null;
  if (id) {
    if (!run.budget.reserve(1)) { overBound(run, table, "the read budget was exhausted"); return; }
    row = await run.ctx.db.get(id);
    if (row) run.budget.record(1);
  }
  if (!row || row.orgId !== run.orgId) { refuseIn(run, "ROOT_NOT_FOUND", table, `${label} does not exist in this organization`); return; }
  const why = notEligible(row as Doc<T>);
  if (why) { refuseIn(run, "ROOT_NOT_ELIGIBLE", table, why); return; }
  run.set.addRoot(table, row._id);
}

async function loadRoots(run: Run, roots: PurgeRoots): Promise<void> {
  const named = roots.saleIds.length + roots.applicationIds.length + roots.expenseIds.length + roots.transferEventIds.length
    + (roots.payrollRunIds?.length ?? 0) + (roots.depositIds?.length ?? 0);
  if (named === 0) refuseIn(run, "NO_ROOTS", "roots", "no root was named");

  await loadInOrder(run, "sales", roots.saleIds, "a sale root", (r) => (r.isDeleted === true && r.status === "CANCELLED" ? null : "a sale root is not deleted and cancelled"));
  await loadInOrder(run, "financeApplications", roots.applicationIds, "an application root", (r) => (r.status === "CANCELLED" ? null : "an application root is not CANCELLED"));
  await loadInOrder(run, "expenses", roots.expenseIds, "an expense root", (r) => (r.isDeleted === true ? null : "an expense root is not deleted"));
  await loadInOrder(run, "accountingEvents", roots.transferEventIds, "a transfer root", (r) =>
    (r.eventType === "TREASURY_TRANSFER" && r.status === "REVERSED" ? null : "a transfer root is not a REVERSED treasury transfer"));
  await loadInOrder(run, "payrollRuns", roots.payrollRunIds ?? [], "a payroll run root", (r) => (r.status === "CANCELLED" ? null : "a payroll run root is not CANCELLED"));
  await loadInOrder(run, "deposits", roots.depositIds ?? [], "a deposit root", () => null); // eligibility is proveExplicitRoots' job
}

/** One table's roots, strictly in order: each load reserves read budget first, so which root exhausts it must stay deterministic (Promise.all would interleave the refusals). */

function loadInOrder<T extends RootTable>(
  run: Run, table: T, raws: ReadonlyArray<string>, label: string, notEligible: (row: Doc<T>) => string | null,
): Promise<void> {
  return raws.reduce<Promise<void>>(async (previous, raw) => {
    await previous;
    await loadRoot(run, table, raw, label, notEligible);
  }, Promise.resolve());
}
/**
 * Reads every scanned table once (then the root tables, as survivors); a table that cannot be read completely refuses,
 * and a spent budget ends the scan: nothing is read past it.
 */
async function readTables(run: Run, perTableCap: number): Promise<Map<string, Row[]>> {
  const tableRows = new Map<string, Row[]>();
  const plan = [...Object.entries(PURGE_ORG_INDEX), ...Object.entries(PURGE_ROOT_SURVIVOR_INDEX)];
  for (const [table, index] of plan) {
    const limit = Math.min(perTableCap + 1, run.budget.room());
    if (limit === 0 || !run.budget.reserve(1)) { run.budget.stop(); overBound(run, table, "the read budget was exhausted"); break; }
    const rows = await readOrgTable(run.ctx, table, index, run.orgId, limit);
    run.budget.record(rows.length);
    if (rows.length > perTableCap) { overBound(run, table, `the table is too large to scan completely (cap ${perTableCap})`); continue; }
    if (rows.length === limit && limit < perTableCap + 1) { run.budget.stop(); overBound(run, table, "the read budget was exhausted"); break; }
    tableRows.set(table, rows);
  }
  const orgLess = run.budget.exhausted ? null : await readOrgLessAdminAudit(run.ctx, run.budget, tableRows, perTableCap);
  if (orgLess) overBound(run, "adminAuditLog", orgLess);
  return tableRows;
}

/** The organization row has no org index: one `db.get`, token-checked like a scanned table. */
async function readOrganization(run: Run): Promise<Row | null> {
  if (!run.budget.reserve(1)) { overBound(run, "organizations", "the read budget was exhausted"); return null; }
  const org = await run.ctx.db.get(run.orgId);
  if (org) run.budget.record(1);
  return org;
}

interface Grown {
  linesByJournal: Map<string, Doc<"journalLines">[]>;
  ledgerRefusals: LedgerRefusal[];
}

/**
 * The closure with the ledger inside it: purged events bring their journals, purged journals bring their lines, and
 * a line id is a token that pulls in its bank aggregate item, so the survivor check only ever sees the final set.
 */
async function growWithLedger(
  run: Run, tableRows: ReadonlyMap<string, Row[]>, tok: TokenIndex, rootClassIds: ReadonlySet<string>, shared: Map<string, string>,
): Promise<Grown> {
  const grown: Grown = { linesByJournal: new Map(), ledgerRefusals: [] };
  const eventRows = new Map((tableRows.get("accountingEvents") ?? []).map((r) => [r._id, r]));
  const journalRows = new Map((tableRows.get("journalEntries") ?? []).map((r) => [r._id, r]));
  const skipped = new Set<string>();
  for (;;) {
    growClosure(run.set, tableRows, tok, rootClassIds, shared);
    for (const id of run.set.byTable.get("accountingEvents") ?? []) {
      const named = (eventRows.get(id) as Doc<"accountingEvents"> | undefined)?.journalEntryId;
      const journal = named ? journalRows.get(named) : undefined;
      if (!named || !journal || run.set.has(named) || shared.has(named)) continue;
      // A journal reached only by this forward link passes the same join guard as every other row.
      if (namesLiveRoot(tok.of(journal), run.set, rootClassIds)) shared.set(named, "journalEntries");
      else run.set.add("journalEntries", named);
    }
    const pending = [...(run.set.byTable.get("journalEntries") ?? [])].filter((id) => !grown.linesByJournal.has(id) && !skipped.has(id)).sort(byText);
    if (pending.length === 0 || run.budget.exhausted) return grown;
    for (const id of pending) {
      const lines = await readJournalLines(run.ctx, run.budget, id as Id<"journalEntries">, grown.ledgerRefusals);
      if (lines === null) { skipped.add(id); if (run.budget.exhausted) return grown; continue; }
      grown.linesByJournal.set(id, lines);
      for (const line of lines) {
        if (line.orgId !== run.orgId) continue;
        if (namesLiveRoot(tok.of(line as Row), run.set, rootClassIds)) shared.set(line._id, "journalLines");
        else run.set.add("journalLines", line._id);
      }
    }
  }
}

/** The purged rows of one ledger table (the rows came from that table's own scan, so the casts below are exact). */
function purgedRows(run: Run, tableRows: ReadonlyMap<string, Row[]>, table: string): Row[] {
  const purged = run.set.byTable.get(table) ?? new Set<string>();
  return (tableRows.get(table) ?? []).filter((row) => purged.has(row._id));
}

export async function buildPurgeManifest(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  roots: PurgeRoots,
  approvedRaw: ReadonlyArray<ApprovedException>,
  approvedLiveRowIds: ReadonlyArray<string> = [],
  approvedFieldClearIds: ReadonlyArray<string> = [],
  limits: PurgeLimits = DEFAULT_PURGE_LIMITS,
): Promise<PurgeManifest> {
  const approved = normalizeApproved(approvedRaw);
  const run: Run = { ctx, orgId, budget: new ReadBudget(limits), refusals: [], set: new PurgeSet() };
  await loadRoots(run, roots);
  const tableRows = run.budget.exhausted ? new Map<string, Row[]>() : await readTables(run, limits.perTableCap);
  const organization = run.budget.exhausted ? null : await readOrganization(run);
  const tok = new TokenIndex();
  const rootClassIds = new Set(Object.keys(PURGE_ROOT_SURVIVOR_INDEX).flatMap((t) => (tableRows.get(t) ?? []).map((r) => r._id)));
  const shared = new Map<string, string>();
  joinOwnedChildren(run.set, tableRows);
  const grown = await growWithLedger(run, tableRows, tok, rootClassIds, shared);
  sharedRoots(run.set, tableRows, tok, rootClassIds, shared);
  sharedExplicitRoots(run.set, tableRows, tok, rootClassIds, shared);
  joinForwardLinked(run.set, tableRows, tok);
  // Audit rows join LAST, after the closure: they delete with their subject and never grow the set.
  const auditRowsMentioningKept = selectAuditRows(run.set, tableRows, tok);
  const survivors = findSurvivors(run.set, tableRows, tok, organization, approvedFieldClearIds);
  for (const s of survivors.survivingReferences) refuseIn(run, "SURVIVING_REFERENCE", s.table, "a row that must survive mentions a purged id", s.count);
  for (const [table, count] of Object.entries(survivors.auditRowsByTable)) {
    refuseIn(run, "AUDIT_MIXED_SUBJECT", table, "an audit row about a KEPT record quotes a purged id: deleting it would erase that record's history, so the owner must rule on it", count);
  }
  refuseShared(run.refusals, shared);
  const events = new Map(purgedRows(run, tableRows, "accountingEvents").map((r) => [r._id, r as Doc<"accountingEvents">]));
  const journals = new Map(purgedRows(run, tableRows, "journalEntries").map((r) => [r._id, r as Doc<"journalEntries">]));
  const ledgerRefusals: LedgerRefusal[] = [...grown.ledgerRefusals];
  let confirmedPaymentEvidence: ConfirmedPaymentEvidence[] = [];
  let handoverOverrides: HandoverOverride[] = [];
  let rootProofs: RootProof[] = [];
  let proven: { eventIds: ReadonlySet<string>; journalIds: ReadonlySet<string> } = { eventIds: new Set(), journalIds: new Set() };
  // A spent budget means the scan is incomplete: checks that compare against what was read would only add noise.
  if (!run.budget.exhausted) {
    for (const [table, count] of Object.entries(survivors.needsApproval)) {
      refuseIn(run, "FIELD_CLEAR_NEEDS_APPROVAL", table, "a kept row links to the purge by one field; emptying it changes behaviour, so only an owner-approved id may be cleared", count);
    }
    if (survivors.unusedApprovals.length > 0) {
      refuseIn(run, "APPROVED_ROW_NOT_IN_PURGE", "approvedFieldClearIds", "an approved field-clear id is not a clear this purge lists", survivors.unusedApprovals.length);
    }
    checkLiveStates(run.set, tableRows, approvedLiveRowIds, run.refusals);
    confirmedPaymentEvidence = checkConfirmedPaymentEvidence(run.set, tableRows, tok, approvedLiveRowIds, run.refusals);
    handoverOverrides = checkHandover(run.set, tableRows, tok, approvedLiveRowIds, run.refusals);
    const proofs = proveExplicitRoots(run.set, tableRows, tok, rootClassIds);
    run.refusals.push(...proofs.refusals);
    rootProofs = proofs.proofs;
    proven = { eventIds: proofs.exemptEventIds, journalIds: proofs.exemptJournalIds };
    refuseExceptions(run.refusals, run.set, approved, events, journals);
    refuseUnreachable(run.refusals, run.set, approved, tableRows, tok);
    checkPairs(events, journals, approved, ledgerRefusals, proven);
  }
  const ledger = run.budget.exhausted
    ? { refusals: [], accountNet: [], exceptionItems: [], snapshotAdjustments: [], closedPeriodHits: [] }
    : await checkLedger(ctx, orgId, run.budget, journals, grown.linesByJournal, approved);
  run.refusals.push(...ledgerRefusals, ...ledger.refusals);

  const out: Record<string, string[]> = {};
  const counts: Record<string, number> = {};
  let rowsTotal = 0;
  for (const [table, set] of [...run.set.byTable].sort((a, b) => byText(a[0], b[0]))) {
    out[table] = [...set].sort(byText);
    counts[table] = set.size;
    rowsTotal += set.size;
  }
  return {
    ok: run.refusals.length === 0,
    refusals: dedupe(run.refusals),
    idsByTable: out,
    countsByTable: counts,
    auditRowsByTable: survivors.auditRowsByTable,
    auditRowsMentioningKept,
    confirmedPaymentEvidence,
    handoverOverrides,
    rootProofs,
    survivingReferences: survivors.survivingReferences,
    fieldClears: survivors.fieldClears,
    storageIds: storageRefs(run.set, tableRows),
    accountNet: ledger.accountNet,
    exceptionItems: ledger.exceptionItems,
    snapshotAdjustments: ledger.snapshotAdjustments,
    closedPeriodHits: ledger.closedPeriodHits,
    totals: {
      tables: Object.keys(out).length, rows: rowsTotal, journals: journals.size,
      journalLines: counts.journalLines ?? 0, events: events.size, docsRead: run.budget.docs, rangesRead: run.budget.ranges,
    },
  };
}

/** Same code+table+detail collapse into one refusal with a count. */
function dedupe(list: ManifestRefusal[]): ManifestRefusal[] {
  const m = new Map<string, ManifestRefusal>();
  for (const r of list) {
    const k = `${r.code}|${r.table}|${r.detail}`;
    const cur = m.get(k);
    if (cur) cur.count += r.count; else m.set(k, { ...r });
  }
  return [...m.values()].sort((a, b) => byText(a.code + a.table, b.code + b.table));
}
