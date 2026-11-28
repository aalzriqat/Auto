/**
 * SCRUM-1023 Phase 1: the set-membership half of the purge dry run (PR #908 round 1). READ-ONLY, pure.
 *
 * Works on rows the manifest has ALREADY read (no database access here), so every read stays charged in one
 * place. It answers, for the purge set the closure built:
 *  - which rows may join (the join guard: a row that names a root of a DIFFERENT, live deal does not join, it is
 *    SHARED_WITH_LIVE, because deleting it would take live history with it);
 *  - which kept rows still mention the set (surviving references), which of those can instead have ONE link field
 *    emptied (field clears), and which audit rows about a KEPT record only mention the set (counted here, refused by the manifest as AUDIT_MIXED_SUBJECT; audit rows whose subject is purged are joined in purgeAuditRows.ts);
 *  - which purged rows are in a live money state (LIVE_STATE_ROW) unless the owner approved that exact id;
 *  - which commercial deals only the purged roots point at (they go with them);
 *  - which storage files the purged rows hold.
 */
import type { LedgerRefusalCode } from "./purgeManifestLedger";
import {
  PURGE_AUDIT_SUBJECT, PURGE_CLEARABLE_FIELDS, PURGE_IMPACT_MAP, PURGE_LIVE_STATES, PURGE_ROOT_SURVIVOR_INDEX, PURGE_STORAGE_FIELDS,
  type PurgeImpactClass,
} from "./purgeImpactMap";

export type ManifestRefusalCode =
  | LedgerRefusalCode
  | "ROOT_NOT_FOUND"
  | "ROOT_NOT_ELIGIBLE"
  | "EXCEPTION_ROOT_NOT_IN_PURGE"
  | "SURVIVING_REFERENCE"
  | "SHARED_WITH_LIVE"
  | "LIVE_STATE_ROW"
  | "LEGACY_TRANSACTION_ROW"
  | "FIELD_CLEAR_NEEDS_APPROVAL"
  | "EXCEPTION_NOT_FROM_ROOT"
  | "APPROVED_ROW_NOT_IN_PURGE"
  | "NO_ROOTS"
  // Phase 1b (owner rulings 2026-11-27, second set)
  | "AUDIT_MIXED_SUBJECT"
  | "PAYROLL_RUN_PAYMENT_EVIDENCE"
  | "PAYROLL_RUN_LEDGER_EFFECT"
  | "DEPOSIT_NOT_REFUNDED"
  | "DEPOSIT_REFUND_PROOF"
  | "CONFIRMED_PAYMENT_EVIDENCE"
  | "CONFIRMED_PAYMENT_LEDGER_LINK"
  | "HANDOVER_LIVE_CONSEQUENCE"
  // Phase 1c (owner ruling 2026-11-27, invariant I17): commitment roots and claims
  | "COMMITMENT_ROOT_NOT_CONSUMED"
  | "COMMITMENT_EVIDENCE_LIVE"
  | "COMMITMENT_ACTIVE_HOLD"
  | "COMMITMENT_SHARED_LINEAGE"
  | "COMMITMENT_CURRENT_FOR_VEHICLE";

export interface ManifestRefusal {
  code: ManifestRefusalCode;
  table: string;
  detail: string;
  count: number;
}

/** One link field Phase 2 empties, with the state that allowed it (so the owner can judge it) and, where one exists, its fixed consequence. */
export interface FieldClear {
  table: string;
  id: string;
  field: string;
  guardField: string;
  guardValue: string;
  treatment?: string;
  consequence?: string;
}
export interface StorageRef { table: string; id: string; storageId: string }
export interface SurvivingReference { table: string; count: number; ids: string[] }

export type Row = { _id: string } & Record<string, unknown>;

// Production ids are lowercase alphanumeric; convex-test ids carry the table name (mixed case).
const ID_TOKEN = /[0-9A-Za-z;]{5,}/g;
/** Ids listed per surviving-reference table in the output. */
const SURVIVOR_SAMPLE = 25;
const JOINABLE: ReadonlySet<PurgeImpactClass> = new Set<PurgeImpactClass>(["STRUCTURAL", "LEDGER", "DERIVED"]);

const byText = (a: string, b: string): number => a.localeCompare(b);
const NO_JUDGED: ReadonlySet<string> = new Set<string>();

/** Id-like tokens of a row, computed once per row. */
export class TokenIndex {
  private readonly cache = new Map<string, string[]>();

  of(row: Row): string[] {
    const hit = this.cache.get(row._id);
    if (hit) return hit;
    const tokens = JSON.stringify(row).match(ID_TOKEN) ?? [];
    this.cache.set(row._id, tokens);
    return tokens;
  }

  /** Tokens of a row with one top-level field removed (a field clear must leave no other link behind). */
  without(row: Row, field: string): string[] {
    const { [field]: _removed, ...rest } = row;
    return JSON.stringify(rest).match(ID_TOKEN) ?? [];
  }
}

/** The purge set: ids by table, plus the roots it grew from. */
export class PurgeSet {
  readonly ids = new Set<string>();
  readonly byTable = new Map<string, Set<string>>();
  readonly rootIds = new Set<string>();

  add(table: string, id: string): void {
    this.ids.add(id);
    const set = this.byTable.get(table) ?? new Set<string>();
    set.add(id);
    this.byTable.set(table, set);
  }

  addRoot(table: string, id: string): void {
    this.add(table, id);
    this.rootIds.add(id);
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }
}

/** A token of this row that is the id of a root-class row (sale, application, expense) the purge does NOT take. */
export const namesLiveRoot = (tokens: string[], set: PurgeSet, rootClassIds: ReadonlySet<string>): boolean =>
  tokens.some((t) => rootClassIds.has(t) && !set.has(t));

/**
 * Grows the purge set to a fixpoint: a joinable row joins when any id token in it is already purged AND it holds no
 * reference to a root-class row outside the set. A blocked row is recorded in `shared` (row id -> table).
 */
export function growClosure(
  set: PurgeSet, tableRows: ReadonlyMap<string, Row[]>, tok: TokenIndex, rootClassIds: ReadonlySet<string>, shared: Map<string, string>,
): void {
  let grew = true;
  while (grew) {
    grew = false;
    for (const [table, rows] of tableRows) {
      if (!JOINABLE.has(PURGE_IMPACT_MAP[table])) continue;
      for (const row of rows) {
        if (set.has(row._id) || shared.has(row._id)) continue;
        const tokens = tok.of(row);
        if (!tokens.some((t) => set.has(t))) continue;
        if (namesLiveRoot(tokens, set, rootClassIds)) { shared.set(row._id, table); continue; }
        set.add(table, row._id);
        grew = true;
      }
    }
  }
}

/** A root that itself names a root-class row outside the set (an application whose finalized sale is live) is shared. */
export function sharedRoots(
  set: PurgeSet, tableRows: ReadonlyMap<string, Row[]>, tok: TokenIndex, rootClassIds: ReadonlySet<string>, shared: Map<string, string>,
): void {
  for (const table of Object.keys(PURGE_ROOT_SURVIVOR_INDEX)) {
    for (const row of tableRows.get(table) ?? []) {
      if (set.rootIds.has(row._id) && namesLiveRoot(tok.of(row), set, rootClassIds)) shared.set(row._id, table);
    }
  }
}

/** Commercial deals only purged rows mention join the set; one a live row also holds stays (not a refusal). */
export function joinForwardLinked(set: PurgeSet, tableRows: ReadonlyMap<string, Row[]>, tok: TokenIndex): void {
  const deals = tableRows.get("commercialDeals") ?? [];
  if (deals.length === 0) return;
  const dealIds = new Set(deals.map((d) => d._id));
  const heldByPurged = new Set<string>();
  const heldByLive = new Set<string>();
  for (const [table, rows] of tableRows) {
    if (table === "commercialDeals") continue;
    for (const row of rows) {
      const purged = set.has(row._id);
      for (const t of tok.of(row)) {
        if (dealIds.has(t)) (purged ? heldByPurged : heldByLive).add(t);
      }
    }
  }
  for (const id of [...heldByPurged].sort(byText)) {
    if (!heldByLive.has(id)) set.add("commercialDeals", id);
  }
}

export interface SurvivorFindings {
  survivingReferences: SurvivingReference[];
  auditRowsByTable: Record<string, number>;
  fieldClears: FieldClear[];
  /** Rows that could be cleared but whose rule needs the owner's exact id and did not get it (count per table). */
  needsApproval: Record<string, number>;
  /** Approved clear ids that are not a clear this purge lists (stale or wrong). */
  unusedApprovals: string[];
}

/**
 * Can the row keep living with its one link field emptied? Only while that link is history, not the live authority,
 * and only when no OTHER field of the row names the purge set.
 */
function clearableField(table: string, row: Row, set: PurgeSet, tok: TokenIndex): FieldClear | null {
  const rule = PURGE_CLEARABLE_FIELDS[table];
  if (!rule) return null;
  const link = row[rule.field];
  if (typeof link !== "string" || !set.has(link)) return null;
  const state = String(row[rule.whenField]);
  if (rule.notIn?.includes(state)) return null;
  if (rule.in && !rule.in.includes(state)) return null;
  if (tok.without(row, rule.field).some((t) => set.has(t))) return null;
  const treatment = typeof row.resolutionTreatment === "string" ? row.resolutionTreatment : undefined;
  return {
    table, id: row._id, field: rule.field, guardField: rule.whenField, guardValue: state,
    ...(rule.ownerApproval && treatment ? { treatment } : {}),
    ...(rule.ownerApproval ? { consequence: rule.ownerApproval } : {}),
  };
}

/**
 * Kept rows that still mention the set refuse (root tables, REFUSE_IF_REFERENCED and the organization row), except a
 * row tied by one clearable link field, which becomes a field clear (a rule with `ownerApproval` only for an exact
 * approved id). An audit row (about a kept record) that mentions the set is only counted here; the manifest refuses it as AUDIT_MIXED_SUBJECT.
 */
export function findSurvivors(
  set: PurgeSet, tableRows: ReadonlyMap<string, Row[]>, tok: TokenIndex, organization: Row | null,
  approvedFieldClearIds: ReadonlyArray<string> = [],
  judged: ReadonlySet<string> = NO_JUDGED,
): SurvivorFindings {
  const survivingReferences: SurvivingReference[] = [];
  const auditRowsByTable: Record<string, number> = {};
  const fieldClears: FieldClear[] = [];
  const needsApproval: Record<string, number> = {};
  const approved = new Set(approvedFieldClearIds);
  const mentions = (r: Row): boolean => !set.has(r._id) && !judged.has(r._id) && tok.of(r).some((t) => set.has(t));
  for (const [table, rows] of tableRows) {
    const cls = PURGE_IMPACT_MAP[table];
    const isRoot = cls === "ROOT" || cls === "EXPLICIT_ROOT" || cls === "OWNED_CHILD";
    if (cls !== "REFUSE_IF_REFERENCED" && cls !== "AUDIT" && !isRoot) continue;
    const hits = rows.filter(mentions);
    if (hits.length === 0) continue;
    if (cls === "AUDIT") { auditRowsByTable[table] = hits.length; continue; }
    const stuck: Row[] = [];
    for (const row of hits) {
      const clear = clearableField(table, row, set, tok);
      if (!clear) stuck.push(row);
      else if (clear.consequence && !approved.has(row._id)) needsApproval[table] = (needsApproval[table] ?? 0) + 1;
      else fieldClears.push(clear);
    }
    if (stuck.length > 0) {
      survivingReferences.push({ table, count: stuck.length, ids: stuck.slice(0, SURVIVOR_SAMPLE).map((r) => r._id).sort(byText) });
    }
  }
  if (organization && mentions(organization)) survivingReferences.push({ table: "organizations", count: 1, ids: [organization._id] });
  survivingReferences.sort((a, b) => byText(a.table, b.table));
  fieldClears.sort((a, b) => byText(`${a.table}|${a.id}`, `${b.table}|${b.id}`));
  const listed = new Set(fieldClears.map((c) => c.id));
  const unusedApprovals = [...approved].filter((id) => !listed.has(id)).sort(byText);
  return { survivingReferences, auditRowsByTable, fieldClears, needsApproval, unusedApprovals };
}

/**
 * Purged rows in a live money state refuse unless the owner approved that exact row id; a stale approval refuses too.
 * A legacy `transactions` row that is not deleted feeds the P&L report and the dashboard, and the ledger net-zero proof
 * does not cover it, so it refuses the same way.
 */
export function checkLiveStates(
  set: PurgeSet, tableRows: ReadonlyMap<string, Row[]>, approvedLiveRowIds: ReadonlyArray<string>, out: ManifestRefusal[],
): void {
  const approved = new Set(approvedLiveRowIds);
  for (const [table, rule] of Object.entries(PURGE_LIVE_STATES)) {
    // A table with its own code (confirmed lender payments) is judged in purgeEvidence.ts, with limits on its approval.
    if (rule.code) continue;
    const purged = set.byTable.get(table);
    if (!purged) continue;
    const live = (tableRows.get(table) ?? []).filter((r) => purged.has(r._id) && rule.values.includes(String(r[rule.field])) && !approved.has(r._id));
    if (live.length > 0) {
      out.push({ code: "LIVE_STATE_ROW", table, detail: `a purged row is still ${rule.values.join("/")}: only an owner-approved id may be purged in that state`, count: live.length });
    }
  }
  const purgedTransactions = set.byTable.get("transactions");
  const liveTransactions = (tableRows.get("transactions") ?? []).filter((r) => purgedTransactions?.has(r._id) && r.isDeleted !== true && !approved.has(r._id));
  if (liveTransactions.length > 0) {
    out.push({ code: "LEGACY_TRANSACTION_ROW", table: "transactions", detail: "a purged legacy transaction is not deleted: it feeds the profit and loss report, so only an owner-approved id may be purged", count: liveTransactions.length });
  }
  const stale = approvedLiveRowIds.filter((id) => !set.has(id));
  if (stale.length > 0) {
    out.push({ code: "APPROVED_ROW_NOT_IN_PURGE", table: "approvedLiveRowIds", detail: "an approved live row id is not in the purge set", count: stale.length });
  }
}

/**
 * The purged rows reachable from one root through id tokens, without passing through another root. An exception may
 * only name events and journals of ITS root's deal; ids of another root's deal are not reachable from it.
 */
export function reachableFrom(set: PurgeSet, tableRows: ReadonlyMap<string, Row[]>, tok: TokenIndex, rootId: string): Set<string> {
  const edges = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    (edges.get(a) ?? edges.set(a, []).get(a)!).push(b);
    (edges.get(b) ?? edges.set(b, []).get(b)!).push(a);
  };
  for (const [table, rows] of tableRows) {
    // An audit row names its subject and anything it quotes: it must not bridge two deals into one reach.
    if (table in PURGE_AUDIT_SUBJECT) continue;
    for (const row of rows) {
      if (!set.has(row._id)) continue;
      for (const t of tok.of(row)) if (t !== row._id && set.has(t)) link(row._id, t);
    }
  }
  const seen = new Set<string>([rootId]);
  const queue = [rootId];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const n of edges.get(next) ?? []) {
      if (seen.has(n) || (set.rootIds.has(n) && n !== rootId)) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  return seen;
}

/** The storage files held by purged rows, so Phase 2 can delete them with the rows. */
export function storageRefs(set: PurgeSet, tableRows: ReadonlyMap<string, Row[]>): StorageRef[] {
  const out: StorageRef[] = [];
  for (const [table, fields] of Object.entries(PURGE_STORAGE_FIELDS)) {
    const purged = set.byTable.get(table);
    if (!purged) continue;
    for (const row of tableRows.get(table) ?? []) {
      if (!purged.has(row._id)) continue;
      for (const field of fields) {
        const value = row[field];
        const files = Array.isArray(value) ? value : [value];
        for (const f of files) if (typeof f === "string") out.push({ table, id: row._id, storageId: f });
      }
    }
  }
  return out.sort((a, b) => byText(`${a.table}|${a.id}|${a.storageId}`, `${b.table}|${b.id}|${b.storageId}`));
}
