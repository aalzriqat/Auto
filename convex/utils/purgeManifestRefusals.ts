/**
 * SCRUM-1023 Phase 1: the refusals about approved exceptions and shared rows, split out of `purgeManifest.ts` (size
 * ceiling). Pure: each pushes its refusals into `out`; none reads the database.
 */
import type { ApprovedException } from "./purgeManifestLedger";
import { strayExemptions } from "./purgeManifestPairs";
import { reachableFrom, type ManifestRefusal, type ManifestRefusalCode, type PurgeSet, type Row, type TokenIndex } from "./purgeSurvivors";

const refuse = (out: ManifestRefusal[], code: ManifestRefusalCode, table: string, detail: string, count = 1): void => {
  out.push({ code, table, detail, count });
};

export function refuseExceptions(
  out: ManifestRefusal[], set: PurgeSet, approved: ReadonlyArray<ApprovedException>, events: ReadonlyMap<string, unknown>, journals: ReadonlyMap<string, unknown>,
): void {
  for (const ex of approved) {
    if (!set.rootIds.has(ex.rootId)) refuse(out, "EXCEPTION_ROOT_NOT_IN_PURGE", "approvedExceptions", "an approved exception names a rootId that is not one of the root ids of this purge: rootId must be an id passed in saleIds, applicationIds, expenseIds, transferEventIds, payrollRunIds or depositIds; for custody cash under a finance application it is the APPLICATION id, never the deal id or the custody record id");
  }
  const strays = strayExemptions(approved, events, journals);
  if (strays > 0) refuse(out, "EXCEPTION_ROOT_NOT_IN_PURGE", "approvedExceptions", "an approved exception names an event or journal that is not in the purge set", strays);
}

export function refuseShared(out: ManifestRefusal[], shared: ReadonlyMap<string, string>): void {
  const perTable = new Map<string, number>();
  for (const table of shared.values()) perTable.set(table, (perTable.get(table) ?? 0) + 1);
  for (const [table, count] of perTable) {
    refuse(out, "SHARED_WITH_LIVE", table, "a row of the purge also names a live sale, application or expense that is not purged", count);
  }
}

/** An exception's ids must belong to ITS root's deal: reachable from the root without passing through another root. */
export function refuseUnreachable(
  out: ManifestRefusal[], set: PurgeSet, approved: ReadonlyArray<ApprovedException>, tableRows: ReadonlyMap<string, Row[]>, tok: TokenIndex,
): void {
  for (const ex of approved) {
    if (!set.rootIds.has(ex.rootId)) continue;
    const reach = reachableFrom(set, tableRows, tok, ex.rootId);
    const strangers = [...ex.eventIds, ...ex.journalIds].filter((id) => set.has(id) && !reach.has(id));
    if (strangers.length > 0) {
      refuse(out, "EXCEPTION_NOT_FROM_ROOT", "approvedExceptions", "an approved exception names an event or journal that its root does not reach", strangers.length);
    }
  }
}