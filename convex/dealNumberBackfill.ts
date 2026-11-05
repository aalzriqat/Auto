import { ConvexError, v } from "convex/values";
import { internalMutation } from "./functions";
import { Doc } from "./_generated/dataModel";
import { MutationCtx } from "./_generated/server";
import { dealNumberForNewSale, ensureApplicationDealNumber } from "./utils/dealNumber";

/**
 * SCRUM-808: numbers the deals created before deal numbers existed. Run by the Deploy production rollout
 * (`scripts/rolloutRelease.mjs`, `runDealNumberBackfillPhase` in `scripts/releaseGuard.ts`), page by page through the
 * operator key, until `isDone`. Decision record: docs/adr/2026-11-04-per-organization-deal-number.md.
 *
 * Order: the unnumbered rows of both deal tables are walked together in creation order (`by_dealNumber` with the
 * number unset), so every organization's deals are numbered in the order they were created (an application before
 * the sale finalized from it, which then carries the same number). A numbered row leaves the unset range, so each page
 * starts at the earliest row still unnumbered; the cursor only counts pages. A deal created after the deploy and before the walk reaches older rows takes the next number
 * at creation, so it can be numbered below an older deal the walk numbers later; uniqueness never depends on order.
 *
 * Bounded: at most `numItems` rows of each table per call. Resumable and idempotent: a row that already has a number is
 * never read, and numbers come only from the organization's counter (`allocateDealNumber`), never from a count, so a
 * re-run or a deal created while the walk is running cannot be given a number that is already in use.
 */

const DEFAULT_PAGE = 100;
const MAX_PAGE = 200;

type DealRow = { table: "financeApplications"; doc: Doc<"financeApplications"> } | { table: "sales"; doc: Doc<"sales"> };

// Every row read is unnumbered (the reads below are the unset range of `by_dealNumber`).
async function numberRow(ctx: MutationCtx, row: DealRow): Promise<void> {
  if (row.table === "financeApplications") {
    await ensureApplicationDealNumber(ctx, row.doc);
    return;
  }
  // Same rule as a sale created today: it carries its application's number, or takes the next one. A legacy sale whose
  // application is gone takes the next number rather than refusing the walk.
  const dealNumber = await dealNumberForNewSale(ctx, { orgId: row.doc.orgId, applicationId: row.doc.applicationId });
  await ctx.db.patch(row.doc._id, { dealNumber });
}

export const runPage = internalMutation({
  args: {
    numItems: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({
    numberedCount: v.number(),
    checkedCount: v.number(),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const numItems = Math.min(Math.max(Math.floor(args.numItems ?? DEFAULT_PAGE), 1), MAX_PAGE);
    if (args.cursor && !/^\d{1,9}$/.test(args.cursor)) throw new ConvexError("The deal number backfill cursor is not valid.");
    const pagesDone = args.cursor ? Number(args.cursor) : 0;

    // Only rows without a number are read (`dealNumber` unset sorts as its own range, ordered by creation time). A row
    // this page numbers leaves that range, so every page starts at the earliest row still unnumbered, and a re-run on a
    // later deploy, after the walk has finished, reads nothing.
    const applications = await ctx.db
      .query("financeApplications")
      .withIndex("by_dealNumber", (q) => q.eq("dealNumber", undefined))
      .take(numItems);
    const applicationsFull = applications.length === numItems;
    // Sales past the last application of a full read would be dropped below, so they are not read at all.
    // `_creationTime` is the implicit last column of every index (https://docs.convex.dev/database/reading-data/indexes).
    const applicationsEnd = applicationsFull ? applications[applications.length - 1]._creationTime : Infinity;
    const sales = await ctx.db
      .query("sales")
      .withIndex("by_dealNumber", (q) => q.eq("dealNumber", undefined).lte("_creationTime", applicationsEnd))
      .take(numItems);

    // A short read reached the end of its table (or, for sales, of the bound above). Past the last row of a full read,
    // the other table's rows may not be next in creation order, so only rows up to the earliest full read's last
    // creation time are numbered this page. That boundary is a row of the page, so a page that is not done always
    // numbers at least one row.
    const salesFull = sales.length === numItems;
    const isDone = !applicationsFull && !salesFull;
    const cutoff = Math.min(applicationsEnd, salesFull ? sales[sales.length - 1]._creationTime : Infinity);

    const rows: DealRow[] = [
      ...applications.map((doc) => ({ table: "financeApplications" as const, doc })),
      ...sales.map((doc) => ({ table: "sales" as const, doc })),
    ]
      .filter((row) => row.doc._creationTime <= cutoff)
      // An application sorts before a sale created in the same instant: the sale may carry its number.
      .sort((a, b) => a.doc._creationTime - b.doc._creationTime || (a.table === "financeApplications" ? -1 : 1));

    for (const row of rows) await numberRow(ctx, row);
    // The position is the index range itself; the cursor only counts pages, so it always advances.
    return { numberedCount: rows.length, checkedCount: rows.length, isDone, continueCursor: String(pagesDone + 1) };
  },
});
