import { v } from "convex/values";
import { internalMutation } from "./functions";
import { eligibilityPage, isPostedParent } from "./utils/journalReportEligibility";

/** Call and confirm BLOCKED before privileged raw imports; begin only afterwards. */
export const blockForImport = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, { orgId }) => {
    if (!await ctx.db.get("organizations", orgId)) throw new Error("Organization not found");
    const state = await ctx.db.query("journalReportEligibility")
      .withIndex("by_org", q => q.eq("orgId", orgId)).unique();
    if (state) await ctx.db.patch(state._id, { phase: "BLOCKED", cursor: null });
    else await ctx.db.insert("journalReportEligibility", { orgId, phase: "BLOCKED", cursor: null });
  },
});

/** Operator-only start/recovery. No recurring cron or deletion of history. */
export const begin = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, { orgId }) => {
    if (!await ctx.db.get("organizations", orgId)) throw new Error("Organization not found");
    const state = await ctx.db.query("journalReportEligibility")
      .withIndex("by_org", q => q.eq("orgId", orgId)).unique();
    if (state) await ctx.db.patch(state._id, { phase: "BUILDING", cursor: null });
    else await ctx.db.insert("journalReportEligibility", { orgId, phase: "BUILDING", cursor: null });
    await ctx.scheduler.runAfter(0, eligibilityPage, { orgId });
  },
});

/** One stable native page per transaction; errors escape and roll back. */
export const backfillPage = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, { orgId }) => {
    const state = await ctx.db.query("journalReportEligibility")
      .withIndex("by_org", q => q.eq("orgId", orgId)).unique();
    if (!state || state.phase !== "BUILDING") return;
    const page = await ctx.db.query("journalLines")
      .withIndex("by_org", q => q.eq("orgId", orgId))
      .paginate({ cursor: state.cursor, numItems: 64 });
    for (const line of page.page) {
      const parent = await ctx.db.get("journalEntries", line.journalEntryId);
      const reportPosted = parent?.orgId === orgId && isPostedParent(parent);
      if (line.reportPosted !== reportPosted) await ctx.db.patch(line._id, { reportPosted });
    }
    await ctx.db.patch(state._id, {
      phase: page.isDone ? "READY" : "BUILDING",
      cursor: page.isDone ? null : page.continueCursor,
    });
    if (!page.isDone) await ctx.scheduler.runAfter(0, eligibilityPage, { orgId });
  },
});
