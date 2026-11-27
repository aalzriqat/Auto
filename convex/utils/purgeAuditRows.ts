/**
 * SCRUM-1023 Phase 1b (owner ruling A, 2026-11-27): audit rows that mention purged records are deleted with them.
 * READ-ONLY. Pure except `readOrgLessAdminAudit`, which charges its one read against the shared budget.
 *
 * Every audit table that names its subject by a plain string (not a `v.id`, so the closure cannot join it) is listed in
 * PURGE_AUDIT_SUBJECT with the one field that holds the subject. After the closure has built the FINAL set:
 *  - a row whose subject is a purged id joins the set (it is the history of a record that is going away);
 *  - a row whose subject is NOT purged but that mentions a purged id anywhere else (a "before"/"after" snapshot, a
 *    description) is the history of a KEPT record: deleting it would erase that record's trail, so the manifest refuses
 *    (AUDIT_MIXED_SUBJECT, via `findSurvivors`' audit count) instead of guessing;
 *  - a joined row that also names a kept record is deleted all the same and listed apart (`auditRowsMentioningKept`),
 *    so the owner sees which deleted rows carried a kept record's id.
 * An audit row never pulls anything INTO the purge: it joins last, and its ids are never grown from.
 *
 * The org-less gap: `adminAuditLog.orgId` is optional (platform-level actions carry none), so the `by_org` read of the
 * organization misses those rows. Ids are globally unique, so a row with no organization whose subject is a purged id
 * is certainly about a purged record; `readOrgLessAdminAudit` reads them through the same index with `orgId` equal to
 * `undefined`. Convex documents index ranges over present fields only: that an index range on `undefined` returns the
 * rows that lack the field is project precedent plus the convex-test behaviour, NOT something the official docs state.
 */
import type { QueryCtx } from "../_generated/server";
import { PURGE_AUDIT_SUBJECT } from "./purgeImpactMap";
import type { ReadBudget } from "./purgeBudget";
import type { PurgeSet, Row, TokenIndex } from "./purgeSurvivors";

export interface AuditKept { table: string; ids: string[] }

const byText = (a: string, b: string): number => a.localeCompare(b);

/** Reads the admin audit rows that carry no organization. Returns an OVER_BOUND detail when it cannot read them completely. */
export async function readOrgLessAdminAudit(
  ctx: QueryCtx, budget: ReadBudget, tableRows: Map<string, Row[]>, perTableCap: number,
): Promise<string | null> {
  const known = tableRows.get("adminAuditLog");
  if (!known) return null; // the organization's own rows were not read completely: that table already refused
  const limit = Math.min(perTableCap + 1, budget.room());
  if (limit === 0 || !budget.reserve(1)) { budget.stop(); return "the read budget was exhausted"; }
  const rows = await ctx.db.query("adminAuditLog").withIndex("by_org", (b) => b.eq("orgId", undefined)).take(limit);
  budget.record(rows.length);
  if (rows.length > perTableCap) return `the organization-less rows are too many to scan completely (cap ${perTableCap})`;
  if (rows.length === limit && limit < perTableCap + 1) { budget.stop(); return "the read budget was exhausted"; }
  tableRows.set("adminAuditLog", [...known, ...rows]);
  return null;
}

/** Ids of every scanned row that is NOT in the purge set and is not itself an audit row: the "kept records" an audit row can name. */
function keptIds(set: PurgeSet, tableRows: ReadonlyMap<string, Row[]>): Set<string> {
  const kept = new Set<string>();
  for (const [table, rows] of tableRows) {
    if (table in PURGE_AUDIT_SUBJECT) continue;
    for (const row of rows) if (!set.has(row._id)) kept.add(row._id);
  }
  return kept;
}

/** Joins every audit row whose subject is purged and returns the joined rows that also name a kept record. */
export function selectAuditRows(set: PurgeSet, tableRows: ReadonlyMap<string, Row[]>, tok: TokenIndex): AuditKept[] {
  const kept = keptIds(set, tableRows);
  const mentioning: AuditKept[] = [];
  for (const [table, field] of Object.entries(PURGE_AUDIT_SUBJECT)) {
    const joined: Row[] = [];
    for (const row of tableRows.get(table) ?? []) {
      const subject = row[field];
      if (typeof subject === "string" && set.has(subject)) joined.push(row);
    }
    const ids: string[] = [];
    for (const row of joined) {
      set.add(table, row._id);
      if (tok.of(row).some((t) => kept.has(t))) ids.push(row._id);
    }
    if (ids.length > 0) mentioning.push({ table, ids: ids.toSorted(byText) });
  }
  return mentioning.toSorted((a, b) => byText(a.table, b.table));
}
