import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
/**
 * Whether `accountingDate` can be posted into right now, as data rather than an
 * exception, so callers that need to branch on the answer don't have to catch
 * and string-match. `waiting: true` marks the blockers that clear on their own
 * once an operator opens the relevant period — as opposed to a CLOSED/LOCKED
 * period, which is a deliberate refusal that will not resolve by itself. The
 * accounting outbox relies on that distinction to decide whether an entry is
 * failing or merely queued (see accountingOutbox.drainEntries).
 */
export type PostingAllowed =
  | { ok: true; periodId: Id<"accountingPeriods"> }
  | { ok: false; waiting: boolean; reason: string };



/**
 * The first period (in startDate order) that starts on or before
 * `startAtOrBefore` and satisfies `accept`.
 *
 * startDate is an index range; endDate / status are checked in memory over the
 * stream, which stops at the first match. An org has few periods.
 */
export async function findFirstPeriodStartingBy(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  startAtOrBefore: number,
  accept: (period: Doc<"accountingPeriods">) => boolean
): Promise<Doc<"accountingPeriods"> | null> {
  const stream = ctx.db
    .query("accountingPeriods")
    .withIndex("by_org_startDate", (q) => q.eq("orgId", orgId).lte("startDate", startAtOrBefore));
  for await (const period of stream) {
    if (accept(period)) return period;
  }
  return null;
}

export async function checkPostingAllowed(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  accountingDate: number
): Promise<PostingAllowed> {
  const period = await findFirstPeriodStartingBy(
    ctx,
    orgId,
    accountingDate,
    (p) => p.endDate >= accountingDate
  );

  if (!period) {
    return {
      ok: false,
      waiting: true,
      reason: `No accounting period found for date ${new Date(accountingDate).toISOString().slice(0, 10)}. Create and open a period first.`,
    };
  }
  const label = `${period.fiscalYear}-${String(period.periodNumber).padStart(2, "0")}`;
  if (period.status === "CLOSED" || period.status === "LOCKED") {
    return {
      ok: false,
      waiting: false,
      reason: `Accounting period ${label} is ${period.status}. Posting into closed or locked periods is not allowed.`,
    };
  }
  if (period.status === "FUTURE") {
    return {
      ok: false,
      waiting: true,
      reason: `Accounting period ${label} has not been opened yet.`,
    };
  }
  return { ok: true, periodId: period._id };
}

export async function assertPostingAllowed(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  accountingDate: number
): Promise<Id<"accountingPeriods">> {
  const result = await checkPostingAllowed(ctx, orgId, accountingDate);
  if (!result.ok) {
    throw new ConvexError(result.reason);
  }
  return result.periodId;
}

export async function getOpenPeriodForDate(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  date: number
): Promise<{ _id: Id<"accountingPeriods">; fiscalYear: number; periodNumber: number } | null> {
  const period = await findFirstPeriodStartingBy(
    ctx,
    orgId,
    date,
    (p) => p.endDate >= date && p.status === "OPEN"
  );
  if (!period) return null;
  return { _id: period._id, fiscalYear: period.fiscalYear, periodNumber: period.periodNumber };
}
