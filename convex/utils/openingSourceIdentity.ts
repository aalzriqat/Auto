import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";

type OpeningHeader = Doc<"openingBalanceDrafts">;
type OpeningJournal = Doc<"journalEntries">;
export type OpeningSourceIdentity = {
  headers: OpeningHeader[];
} & (
  | { status: "AVAILABLE"; parent: OpeningHeader; journal: OpeningJournal }
  | { status: "ABSENT" | "UNAVAILABLE"; parent: null; journal: null }
);

/** Retained history proves references, never current authority. Enumerate one
 * beyond each bound so an incomplete inventory cannot prove ordinary origin. */
export async function loadOpeningSourceIdentity(
  ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">,
): Promise<OpeningSourceIdentity> {
  const limit = 100;
  const [headers, journals] = await Promise.all([
    ctx.db.query("openingBalanceDrafts").withIndex("by_org_status", q =>
      q.eq("orgId", orgId).eq("status", "POSTED")).take(limit + 1),
    ctx.db.query("journalEntries").withIndex("by_org_source", q =>
      q.eq("orgId", orgId).eq("sourceType", "cutover").eq("sourceId", String(orgId))).take(limit + 1),
  ]);
  const unavailable = (): OpeningSourceIdentity => ({ headers, status: "UNAVAILABLE", parent: null, journal: null });
  if (headers.length > limit || journals.length > limit || headers.some(header =>
    header.orgId !== orgId || (header.allocations?.length ?? 0) > limit ||
    (header.allocationResults?.length ?? 0) > limit)) return unavailable();
  const live = journals.filter(journal => journal.category === "OPENING_BALANCE" && journal.status === "POSTED");
  if (live.length === 0) return { headers, status: "ABSENT", parent: null, journal: null };
  if (live.length !== 1) return unavailable();
  const journal = live[0];
  const owners = headers.filter(header => header.journalEntryId === journal._id);
  if (owners.length !== 1 || owners[0].asOfDate !== journal.accountingDate ||
    owners[0].currency !== undefined && owners[0].currency !== journal.currency) return unavailable();
  return { headers, status: "AVAILABLE", parent: owners[0], journal };
}
