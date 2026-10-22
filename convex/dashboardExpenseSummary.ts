import { v } from "convex/values";
import { internalMutation } from "./functions";
import {
  applyContributions,
  contributionOf,
  expenseSummaryPage,
  latestSummaryState,
} from "./utils/dashboardExpenseSummary";

/**
 * SCRUM-807 operator entry points for the dashboard expense month summary.
 * No cron starts, repairs or deletes anything here; every generation and month
 * row is kept. See convex/utils/dashboardExpenseSummary.ts.
 */

const PAGE_SIZE = 64;
/** Rows sharing one `_creationTime` at a page edge. Far beyond any real tie. */
const TIE_LIMIT = 1000;

/**
 * Start a fresh generation and build it from the expenses as they are now.
 * Also the recovery path: a newer generation makes any older chain exit.
 */
export const begin = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, { orgId }) => {
    if (!await ctx.db.get("organizations", orgId)) throw new Error("Organization not found");
    const latest = await latestSummaryState(ctx, orgId);
    const generation = (latest?.generation ?? 0) + 1;
    await ctx.db.insert("dashboardExpenseSummaryState", { orgId, generation, phase: "BUILDING" });
    await ctx.scheduler.runAfter(0, expenseSummaryPage, { orgId, generation });
    return { generation };
  },
});

/**
 * Call and confirm before a raw import, which bypasses triggers. The dashboard
 * falls back to the capped raw reader until `begin` builds a new generation.
 */
export const blockForImport = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, { orgId }) => {
    const latest = await latestSummaryState(ctx, orgId);
    if (latest) await ctx.db.patch(latest._id, { phase: "BLOCKED" });
    else await ctx.db.insert("dashboardExpenseSummaryState", { orgId, generation: 1, phase: "BLOCKED" });
  },
});

/**
 * One page per transaction, ordered by creation time. `countedThrough` is the
 * creation time of the last row counted; the trigger maintains exactly the rows
 * at or before it, so each row is counted once whichever reaches it first.
 * Errors escape and roll the page back.
 */
export const buildPage = internalMutation({
  args: { orgId: v.id("organizations"), generation: v.number() },
  handler: async (ctx, { orgId, generation }) => {
    const latest = await latestSummaryState(ctx, orgId);
    if (!latest || latest.generation !== generation || latest.phase !== "BUILDING") return;
    const after = latest.countedThrough;
    const page = await ctx.db
      .query("expenses")
      .withIndex("by_org", (q) => (after === undefined ? q.eq("orgId", orgId) : q.eq("orgId", orgId).gt("_creationTime", after)))
      .take(PAGE_SIZE);
    const isDone = page.length < PAGE_SIZE;
    const rows = [...page];
    if (!isDone) {
      // Never end a page inside a group of equal creation times: the trigger's
      // test is `<=`, so every row at the boundary must be counted now.
      const edge = page[page.length - 1]._creationTime;
      const seen = new Set(page.map((row) => row._id));
      const ties = await ctx.db
        .query("expenses")
        .withIndex("by_org", (q) => q.eq("orgId", orgId).eq("_creationTime", edge))
        .take(TIE_LIMIT + 1);
      if (ties.length > TIE_LIMIT) throw new Error("Too many expenses share one creation time");
      for (const row of ties) if (!seen.has(row._id)) rows.push(row);
    }
    const items = [];
    for (const row of rows) {
      const c = contributionOf(row);
      if (c) items.push({ c, sign: 1 as const });
    }
    await applyContributions(ctx, orgId, generation, items);
    const countedThrough = page.length > 0 ? page[page.length - 1]._creationTime : after;
    await ctx.db.patch(latest._id, {
      phase: isDone ? "READY" : "BUILDING",
      ...(countedThrough === undefined ? {} : { countedThrough }),
    });
    if (!isDone) await ctx.scheduler.runAfter(0, expenseSummaryPage, { orgId, generation });
  },
});
