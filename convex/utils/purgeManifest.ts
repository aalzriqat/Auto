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

export async function buildPurgeManifest(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  roots: PurgeRoots,
  approved: ReadonlyArray<ApprovedException>,
): Promise<PurgeManifest> {
  const refusals: ManifestRefusal[] = [];
  const refuse = (code: ManifestRefusalCode, table: string, detail: string, count = 1): void => {
    refusals.push({ code, table, detail, count });
  };
  let docsRead = 0;
  const charge = (n: number): boolean => { docsRead += n; return docsRead <= TOTAL_READ_BUDGET; };

  const purge = new Set<string>();
  const rootIds = new Set<string>();
  const idsByTable = new Map<string, Set<string>>();
  const add = (table: string, id: string): void => {
    purge.add(id);
    const set = idsByTable.get(table) ?? new Set<string>();
    set.add(id);
    idsByTable.set(table, set);
  };

  // 1. roots ---------------------------------------------------------------
  if (roots.saleIds.length + roots.applicationIds.length + roots.expenseIds.length + roots.transferEventIds.length === 0) {
    refuse("NO_ROOTS", "roots", "no root was named");
  }
  for (const raw of roots.saleIds) {
    const id = ctx.db.normalizeId("sales", raw);
    const row = id ? await ctx.db.get(id) : null;
    charge(1);
    if (!row || row.orgId !== orgId) { refuse("ROOT_NOT_FOUND", "sales", "a sale root does not exist in this organization"); continue; }
    if (row.isDeleted !== true || row.status !== "CANCELLED") { refuse("ROOT_NOT_ELIGIBLE", "sales", "a sale root is not deleted and cancelled"); continue; }
    add("sales", row._id); rootIds.add(row._id);
  }
  for (const raw of roots.applicationIds) {
    const id = ctx.db.normalizeId("financeApplications", raw);
    const row = id ? await ctx.db.get(id) : null;
    charge(1);
    if (!row || row.orgId !== orgId) { refuse("ROOT_NOT_FOUND", "financeApplications", "an application root does not exist in this organization"); continue; }
    if (row.status !== "CANCELLED") { refuse("ROOT_NOT_ELIGIBLE", "financeApplications", "an application root is not CANCELLED"); continue; }
    add("financeApplications", row._id); rootIds.add(row._id);
  }
  for (const raw of roots.expenseIds) {
    const id = ctx.db.normalizeId("expenses", raw);
    const row = id ? await ctx.db.get(id) : null;
    charge(1);
    if (!row || row.orgId !== orgId) { refuse("ROOT_NOT_FOUND", "expenses", "an expense root does not exist in this organization"); continue; }
    if (row.isDeleted !== true) { refuse("ROOT_NOT_ELIGIBLE", "expenses", "an expense root is not deleted"); continue; }
    add("expenses", row._id); rootIds.add(row._id);
  }
  for (const raw of roots.transferEventIds) {
    const id = ctx.db.normalizeId("accountingEvents", raw);
    const row = id ? await ctx.db.get(id) : null;
    charge(1);
    if (!row || row.orgId !== orgId) { refuse("ROOT_NOT_FOUND", "accountingEvents", "a transfer root does not exist in this organization"); continue; }
    if (row.eventType !== "TREASURY_TRANSFER" || row.status !== "REVERSED") { refuse("ROOT_NOT_ELIGIBLE", "accountingEvents", "a transfer root is not a REVERSED treasury transfer"); continue; }
    add("accountingEvents", row._id); rootIds.add(row._id);
  }
  for (const ex of approved) {
    if (!rootIds.has(ex.rootId)) refuse("EXCEPTION_ROOT_NOT_IN_PURGE", "approvedExceptions", "an approved exception names a root that is not in the purge set");
  }

  // 2. read each table once --------------------------------------------------
  const tableRows = new Map<string, Row[]>();
  for (const table of Object.keys(PURGE_ORG_INDEX)) {
    const rows = await readOrgTable(ctx, table, orgId, PER_TABLE_CAP);
    if (rows.length > PER_TABLE_CAP || !charge(rows.length)) {
      refuse("OVER_BOUND", table, `the table is too large to scan completely (cap ${PER_TABLE_CAP}, budget ${TOTAL_READ_BUDGET})`);
      continue;
    }
    tableRows.set(table, rows);
  }

  // 3. closure ---------------------------------------------------------------
  const rowRoots = new Map<string, Set<string>>();
  const tokenCache = new Map<string, string[]>();
  const tok = (row: Row): string[] => {
    const hit = tokenCache.get(row._id);
    if (hit) return hit;
    const t = tokensOf(row);
    tokenCache.set(row._id, t);
    return t;
  };
  let grew = true;
  while (grew) {
    grew = false;
    for (const [table, rows] of tableRows) {
      if (!JOINABLE.has(PURGE_IMPACT_MAP[table])) continue;
      for (const row of rows) {
        if (purge.has(row._id)) continue;
        const tokens = tok(row);
        if (!tokens.some((t) => purge.has(t))) continue;
        add(table, row._id);
        // Which roots this row belongs to: the roots it names, plus those of purged rows it names.
        const mentioned = new Set<string>();
        for (const t of tokens) {
          if (rootIds.has(t)) mentioned.add(t);
          for (const inherited of rowRoots.get(t) ?? []) mentioned.add(inherited);
        }
        rowRoots.set(row._id, mentioned);
        grew = true;
      }
    }
  }

  // 4. survivors and audit -----------------------------------------------------
  const survivingReferences: PurgeManifest["survivingReferences"] = [];
  const auditRowsByTable: Record<string, number> = {};
  for (const [table, rows] of tableRows) {
    const cls = PURGE_IMPACT_MAP[table];
    if (cls !== "REFUSE_IF_REFERENCED" && cls !== "AUDIT") continue;
    const hits = rows.filter((r) => tok(r).some((t) => purge.has(t)));
    if (hits.length === 0) continue;
    if (cls === "AUDIT") { auditRowsByTable[table] = hits.length; continue; }
    survivingReferences.push({ table, count: hits.length, ids: hits.slice(0, SURVIVOR_SAMPLE).map((r) => r._id).sort((a, b) => a.localeCompare(b)) });
    refuse("SURVIVING_REFERENCE", table, "a row that must survive mentions a purged id", hits.length);
  }
  survivingReferences.sort((a, b) => a.table.localeCompare(b.table));

  // 5. ledger proof -------------------------------------------------------------
  const events = new Map<string, Doc<"accountingEvents">>();
  for (const id of idsByTable.get("accountingEvents") ?? []) {
    const doc = await ctx.db.get(id as Id<"accountingEvents">);
    charge(1);
    if (doc && doc.orgId === orgId) events.set(id, doc);
  }
  const journals = new Map<string, Doc<"journalEntries">>();
  for (const id of idsByTable.get("journalEntries") ?? []) {
    const doc = await ctx.db.get(id as Id<"journalEntries">);
    charge(1);
    if (doc && doc.orgId === orgId) journals.set(id, doc);
  }
  // A journal named by a purged event joins even if its own row never mentioned the set.
  for (const e of events.values()) {
    if (e.journalEntryId && !journals.has(e.journalEntryId)) {
      const j = await ctx.db.get(e.journalEntryId);
      charge(1);
      if (j && j.orgId === orgId) { journals.set(j._id, j); add("journalEntries", j._id); }
    }
  }
  const exceptionRoots = new Set(approved.map((a) => a.rootId));
  const allowedUnreversed = new Set<string>();
  for (const e of events.values()) {
    const roots2 = rowRoots.get(e._id);
    if (roots2 && [...roots2].some((r) => exceptionRoots.has(r)) && e.eventType !== "JOURNAL_REVERSAL" && e.status !== "REVERSED") {
      allowedUnreversed.add(e._id);
    }
  }
  const ledgerRefusals: LedgerRefusal[] = [];
  checkPairs(events, journals, ledgerRefusals, allowedUnreversed);
  const ledger = await checkLedger(ctx, orgId, journals, charge, approved);
  for (const r of [...ledgerRefusals, ...ledger.refusals]) refusals.push(r);
  for (const id of ledger.lineIds) add("journalLines", id);

  // 6. assemble -------------------------------------------------------------------
  const out: Record<string, string[]> = {};
  const counts: Record<string, number> = {};
  let rowsTotal = 0;
  for (const [table, set] of [...idsByTable].sort((a, b) => a[0].localeCompare(b[0]))) {
    out[table] = [...set].sort((a, b) => a.localeCompare(b));
    counts[table] = set.size;
    rowsTotal += set.size;
  }
  return {
    ok: refusals.length === 0,
    refusals: dedupe(refusals),
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
      journalLines: ledger.lineIds.length, events: events.size, docsRead,
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
