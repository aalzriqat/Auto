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
 *  2. each table of the impact map is read once through its org-leading index
 *     under a hard cap. A table too big to read completely REFUSES: an
 *     incomplete scan would be a silent miss.
 *  3. closure: a STRUCTURAL / LEDGER / DERIVED row joins the set when any id
 *     token in it is already in the set (an id as a field, inside an array, a
 *     payload, a link, a sourceId or an idempotency key); repeated to fixpoint.
 *  4. survivors: a REFUSE_IF_REFERENCED row that mentions the set is a surviving
 *     reference -> refusal, listed by table. AUDIT rows are counted, not removed.
 *  5. the ledger proof (`purgeManifestLedger`): complete reversed pairs, zero net
 *     per account except owner-approved exceptions, open periods, snapshot room.
 */
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { PURGE_IMPACT_MAP, PURGE_ORG_INDEX, type PurgeImpactClass } from "./purgeImpactMap";
import {
  checkLedger,
  checkPairs,
  type AccountNet,
  type ApprovedException,
  type ExceptionItem,
  type LedgerRefusal,
  type SnapshotAdjustment,
} from "./purgeManifestLedger";

export type { ApprovedException } from "./purgeManifestLedger";

export type ManifestRefusalCode =
  | LedgerRefusal["code"]
  | "ROOT_NOT_FOUND"
  | "ROOT_NOT_ELIGIBLE"
  | "EXCEPTION_ROOT_NOT_IN_PURGE"
  | "SURVIVING_REFERENCE"
  | "NO_ROOTS";

export interface ManifestRefusal {
  code: ManifestRefusalCode;
  table: string;
  detail: string;
  count: number;
}

export interface PurgeRoots {
  saleIds: string[];
  applicationIds: string[];
  expenseIds: string[];
  /** TREASURY_TRANSFER accountingEvents: a transfer has no table of its own. */
  transferEventIds: string[];
}

export interface PurgeManifest {
  ok: boolean;
  refusals: ManifestRefusal[];
  idsByTable: Record<string, string[]>;
  countsByTable: Record<string, number>;
  /** Rows that mention the purge set but are never removed (immutable audit logs). */
  auditRowsByTable: Record<string, number>;
  survivingReferences: Array<{ table: string; count: number; ids: string[] }>;
  accountNet: AccountNet[];
  exceptionItems: ExceptionItem[];
  snapshotAdjustments: SnapshotAdjustment[];
  closedPeriodHits: string[];
  totals: { tables: number; rows: number; journals: number; journalLines: number; events: number; docsRead: number };
}

type Row = { _id: string } & Record<string, unknown>;

const PER_TABLE_CAP = 6000;
const TOTAL_READ_BUDGET = 24000;
// Production ids are lowercase alphanumeric; convex-test ids carry the table name (mixed case).
const ID_TOKEN = /[0-9A-Za-z;]{5,}/g;
/** Ids listed per surviving-reference table in the output. */
const SURVIVOR_SAMPLE = 25;

const JOINABLE: ReadonlySet<PurgeImpactClass> = new Set<PurgeImpactClass>(["STRUCTURAL", "LEDGER", "DERIVED"]);

function tokensOf(row: Row): string[] {
  return JSON.stringify(row).match(ID_TOKEN) ?? [];
}

/**
 * One localized cast: the table name is data here (the impact map), so the
 * generated per-table types cannot apply. Every table read this way is covered
 * by the census test, which proves each name exists and has its org-leading index.
 */
async function readOrgTable(
  ctx: QueryCtx, table: string, orgId: Id<"organizations">, cap: number,
): Promise<Row[]> {
  const index = PURGE_ORG_INDEX[table];
  // `as "sales"` / `as "by_org"` only satisfy the compiler; the runtime names are the map's.
  const rows = await ctx.db.query(table as "sales").withIndex(index as "by_org", (b) => b.eq("orgId", orgId)).take(cap + 1);
  return rows;
}


interface Run {
  ctx: QueryCtx;
  orgId: Id<"organizations">;
  refusals: ManifestRefusal[];
  purge: Set<string>;
  rootIds: Set<string>;
  idsByTable: Map<string, Set<string>>;
  rowRoots: Map<string, Set<string>>;
  docsRead: number;
}

const refuseIn = (run: Run, code: ManifestRefusalCode, table: string, detail: string, count = 1): void => {
  run.refusals.push({ code, table, detail, count });
};
const charge = (run: Run, n: number): boolean => { run.docsRead += n; return run.docsRead <= TOTAL_READ_BUDGET; };
const addRow = (run: Run, table: string, id: string): void => {
  run.purge.add(id);
  const set = run.idsByTable.get(table) ?? new Set<string>();
  set.add(id);
  run.idsByTable.set(table, set);
};

type RootTable = "sales" | "financeApplications" | "expenses" | "accountingEvents";

/** Loads one root, refuses it when missing or not in a purgeable state, otherwise adds it. */
async function loadRoot<T extends RootTable>(
  run: Run, table: T, raw: string, label: string, notEligible: (row: Doc<T>) => string | null,
): Promise<void> {
  const id = run.ctx.db.normalizeId(table, raw);
  const row = id ? await run.ctx.db.get(id) : null;
  charge(run, 1);
  if (!row || row.orgId !== run.orgId) { refuseIn(run, "ROOT_NOT_FOUND", table, `${label} does not exist in this organization`); return; }
  const why = notEligible(row as Doc<T>);
  if (why) { refuseIn(run, "ROOT_NOT_ELIGIBLE", table, why); return; }
  addRow(run, table, row._id);
  run.rootIds.add(row._id);
}

async function loadRoots(run: Run, roots: PurgeRoots, approved: ReadonlyArray<ApprovedException>): Promise<void> {
  if (roots.saleIds.length + roots.applicationIds.length + roots.expenseIds.length + roots.transferEventIds.length === 0) {
    refuseIn(run, "NO_ROOTS", "roots", "no root was named");
  }
  for (const raw of roots.saleIds) {
    await loadRoot(run, "sales", raw, "a sale root", (r) => (r.isDeleted === true && r.status === "CANCELLED" ? null : "a sale root is not deleted and cancelled"));
  }
  for (const raw of roots.applicationIds) {
    await loadRoot(run, "financeApplications", raw, "an application root", (r) => (r.status === "CANCELLED" ? null : "an application root is not CANCELLED"));
  }
  for (const raw of roots.expenseIds) {
    await loadRoot(run, "expenses", raw, "an expense root", (r) => (r.isDeleted === true ? null : "an expense root is not deleted"));
  }
  for (const raw of roots.transferEventIds) {
    await loadRoot(run, "accountingEvents", raw, "a transfer root", (r) =>
      (r.eventType === "TREASURY_TRANSFER" && r.status === "REVERSED" ? null : "a transfer root is not a REVERSED treasury transfer"));
  }
  for (const ex of approved) {
    if (!run.rootIds.has(ex.rootId)) refuseIn(run, "EXCEPTION_ROOT_NOT_IN_PURGE", "approvedExceptions", "an approved exception names a root that is not in the purge set");
  }
}

/** Reads every scanned table once; a table that cannot be read completely refuses. */
async function readTables(run: Run): Promise<Map<string, Row[]>> {
  const tableRows = new Map<string, Row[]>();
  for (const table of Object.keys(PURGE_ORG_INDEX)) {
    const rows = await readOrgTable(run.ctx, table, run.orgId, PER_TABLE_CAP);
    if (rows.length > PER_TABLE_CAP || !charge(run, rows.length)) {
      refuseIn(run, "OVER_BOUND", table, `the table is too large to scan completely (cap ${PER_TABLE_CAP}, budget ${TOTAL_READ_BUDGET})`);
      continue;
    }
    tableRows.set(table, rows);
  }
  return tableRows;
}

/** Which roots a joining row belongs to: the roots it names, plus those of purged rows it names. */
function rootsOfRow(run: Run, tokens: string[]): Set<string> {
  const mentioned = new Set<string>();
  for (const t of tokens) {
    if (run.rootIds.has(t)) mentioned.add(t);
    for (const inherited of run.rowRoots.get(t) ?? []) mentioned.add(inherited);
  }
  return mentioned;
}

/** Grows the purge set to a fixpoint: a joinable row joins when any id token in it is already purged. */
function growClosure(run: Run, tableRows: Map<string, Row[]>, tok: (row: Row) => string[]): void {
  let grew = true;
  while (grew) {
    grew = false;
    for (const [table, rows] of tableRows) {
      if (!JOINABLE.has(PURGE_IMPACT_MAP[table])) continue;
      for (const row of rows) {
        if (run.purge.has(row._id)) continue;
        const tokens = tok(row);
        if (!tokens.some((t) => run.purge.has(t))) continue;
        addRow(run, table, row._id);
        run.rowRoots.set(row._id, rootsOfRow(run, tokens));
        grew = true;
      }
    }
  }
}

/** Survivors that mention the set refuse; audit rows that mention it are only counted. */
function findSurvivors(run: Run, tableRows: Map<string, Row[]>, tok: (row: Row) => string[]) {
  const survivingReferences: PurgeManifest["survivingReferences"] = [];
  const auditRowsByTable: Record<string, number> = {};
  for (const [table, rows] of tableRows) {
    const cls = PURGE_IMPACT_MAP[table];
    if (cls !== "REFUSE_IF_REFERENCED" && cls !== "AUDIT") continue;
    const hits = rows.filter((r) => tok(r).some((t) => run.purge.has(t)));
    if (hits.length === 0) continue;
    if (cls === "AUDIT") { auditRowsByTable[table] = hits.length; continue; }
    survivingReferences.push({ table, count: hits.length, ids: hits.slice(0, SURVIVOR_SAMPLE).map((r) => r._id).sort((a, b) => a.localeCompare(b)) });
    refuseIn(run, "SURVIVING_REFERENCE", table, "a row that must survive mentions a purged id", hits.length);
  }
  survivingReferences.sort((a, b) => a.table.localeCompare(b.table));
  return { survivingReferences, auditRowsByTable };
}

/** Loads the purged events and journals (a journal named by a purged event joins too). */
async function loadLedgerRows(run: Run) {
  const events = new Map<string, Doc<"accountingEvents">>();
  for (const id of run.idsByTable.get("accountingEvents") ?? []) {
    const doc = await run.ctx.db.get(id as Id<"accountingEvents">);
    charge(run, 1);
    if (doc && doc.orgId === run.orgId) events.set(id, doc);
  }
  const journals = new Map<string, Doc<"journalEntries">>();
  for (const id of run.idsByTable.get("journalEntries") ?? []) {
    const doc = await run.ctx.db.get(id as Id<"journalEntries">);
    charge(run, 1);
    if (doc && doc.orgId === run.orgId) journals.set(id, doc);
  }
  for (const e of events.values()) {
    if (!e.journalEntryId || journals.has(e.journalEntryId)) continue;
    const j = await run.ctx.db.get(e.journalEntryId);
    charge(run, 1);
    if (j && j.orgId === run.orgId) { journals.set(j._id, j); addRow(run, "journalEntries", j._id); }
  }
  return { events, journals };
}

/** Events of an approved exception root that are allowed to have no reversal. */
function unreversedExceptionEvents(run: Run, events: Map<string, Doc<"accountingEvents">>, approved: ReadonlyArray<ApprovedException>): Set<string> {
  const exceptionRoots = new Set(approved.map((a) => a.rootId));
  const allowed = new Set<string>();
  for (const e of events.values()) {
    const belongs = [...(run.rowRoots.get(e._id) ?? [])].some((r) => exceptionRoots.has(r));
    if (belongs && e.eventType !== "JOURNAL_REVERSAL" && e.status !== "REVERSED") allowed.add(e._id);
  }
  return allowed;
}

export async function buildPurgeManifest(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  roots: PurgeRoots,
  approved: ReadonlyArray<ApprovedException>,
): Promise<PurgeManifest> {
  const run: Run = {
    ctx, orgId, refusals: [], purge: new Set(), rootIds: new Set(), idsByTable: new Map(), rowRoots: new Map(), docsRead: 0,
  };
  await loadRoots(run, roots, approved);
  const tableRows = await readTables(run);
  const tokenCache = new Map<string, string[]>();
  const tok = (row: Row): string[] => {
    const hit = tokenCache.get(row._id);
    if (hit) return hit;
    const t = tokensOf(row);
    tokenCache.set(row._id, t);
    return t;
  };
  growClosure(run, tableRows, tok);
  const { survivingReferences, auditRowsByTable } = findSurvivors(run, tableRows, tok);

  const { events, journals } = await loadLedgerRows(run);
  const ledgerRefusals: LedgerRefusal[] = [];
  checkPairs(events, journals, ledgerRefusals, unreversedExceptionEvents(run, events, approved));
  const ledger = await checkLedger(ctx, orgId, journals, (n) => charge(run, n), approved);
  run.refusals.push(...ledgerRefusals, ...ledger.refusals);
  for (const id of ledger.lineIds) addRow(run, "journalLines", id);

  const out: Record<string, string[]> = {};
  const counts: Record<string, number> = {};
  let rowsTotal = 0;
  for (const [table, set] of [...run.idsByTable].sort((a, b) => a[0].localeCompare(b[0]))) {
    out[table] = [...set].sort((a, b) => a.localeCompare(b));
    counts[table] = set.size;
    rowsTotal += set.size;
  }
  return {
    ok: run.refusals.length === 0,
    refusals: dedupe(run.refusals),
    idsByTable: out,
    countsByTable: counts,
    auditRowsByTable,
    survivingReferences,
    accountNet: ledger.accountNet,
    exceptionItems: ledger.exceptionItems,
    snapshotAdjustments: ledger.snapshotAdjustments,
    closedPeriodHits: ledger.closedPeriodHits,
    totals: {
      tables: Object.keys(out).length, rows: rowsTotal, journals: journals.size,
      journalLines: ledger.lineIds.length, events: events.size, docsRead: run.docsRead,
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
  return [...m.values()].sort((a, b) => (a.code + a.table).localeCompare(b.code + b.table));
}
