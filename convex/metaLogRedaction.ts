// SCRUM-842: redaction of a Meta user id out of retained `webhookLogs` rows.
//
// A signed deauthorize or data-deletion callback names one Meta user. Rows
// written before SCRUM-842 carry that id in their summary (and may carry it in
// `error`), and SCRUM-807 forbids deleting operational history, so the id is
// replaced with fixed text and the row stays. The disposition is a coordinator
// decision (authority delegated by the owner), not an owner ruling.
//
// Bounded and resumable. One transaction examines at most
// META_LOG_REDACTION_PAGE_SIZE rows of ONE source (`<platform>-oauth`) through
// the existing `by_source_and_eventId` index: no table scan, no new index on
// `webhookLogs`. The HTTP callback does exactly one such page, then returns.
// Anything longer is carried by a job row, one page per scheduled run:
//
//   request:  page 1 -> [done?] yes: finish (receipt complete, nothing stored)
//                               no:  insert job {cursor}, schedule run(jobId)
//   run(jobId): page N -> [done?] yes: delete job + complete receipt, ONE transaction
//                                no:  patch cursor, schedule run(jobId)
//   sweep (cron): a job quiet for META_LOG_REDACTION_STALL_MS gets run(jobId) again
//
// Why this shape (Convex limits: https://docs.convex.dev/production/state/limits;
// HTTP actions are not retried: https://docs.convex.dev/functions/http-actions#limits):
// - Work per request is one page, never "the whole source", so no request can run
//   out of budget part-way and strand the rest.
// - The continuation lives in the database, not in the request. A mutation that
//   schedules a function commits the schedule atomically with its writes
//   (https://docs.convex.dev/scheduling/scheduled-functions), and a scheduled
//   mutation is retried by Convex, so a dead request, a dead isolate or a replayed
//   callback cannot lose it. The sweep covers a chain that still died.
// - The scheduled argument is the JOB's own document id. Convex keeps a finished
//   scheduled function and its arguments readable for 7 days, so the Meta user id
//   and the receipt code must never be arguments; the job id is opaque and points
//   at a row that no longer exists after completion.
// - The Meta user id sits in the job row only while pages remain. Redaction is a
//   no-op on a redacted row, so every page, run, sweep and replay is idempotent.
import { v } from "convex/values";
import type { Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./functions";
import {
  META_LOG_REDACTION_PAGE_SIZE,
  metaOauthLogSource,
  redactMetaUserIdInText,
  type MetaPlatform,
} from "./utils/metaUserIdRedaction";

/** A job nobody has advanced for this long has lost its chain; the sweep restarts it. */
export const META_LOG_REDACTION_STALL_MS = 15 * 60 * 1000;
/** Stalled jobs restarted per sweep run (a sweep that finds more simply continues next time). */
export const META_LOG_REDACTION_SWEEP_BATCH = 50;

interface RedactionStartArgs {
  platform: MetaPlatform;
  metaUserId: string;
  /** The deletion receipt to mark complete once the last page is redacted. */
  receiptCode?: string;
}

/** What one page reports back: whether it was the last, and where the next starts. */
export const metaLogRedactionPageResult = v.object({
  isDone: v.boolean(),
  continueCursor: v.union(v.string(), v.null()),
});
export type MetaLogRedactionPageResult = Infer<typeof metaLogRedactionPageResult>;

/** Redacts one page of one platform's callback log source. Never schedules, never completes. */
async function redactOnePage(
  ctx: MutationCtx,
  platform: MetaPlatform,
  metaUserId: string,
  cursor: string | null,
): Promise<MetaLogRedactionPageResult> {
  const page = await ctx.db
    .query("webhookLogs")
    .withIndex("by_source_and_eventId", (q) => q.eq("source", metaOauthLogSource(platform)))
    .paginate({ numItems: META_LOG_REDACTION_PAGE_SIZE, cursor });

  for (const row of page.page) {
    const summary = redactMetaUserIdInText(row.summary, metaUserId);
    const error = row.error === undefined ? undefined : redactMetaUserIdInText(row.error, metaUserId);
    if (summary !== row.summary || error !== row.error) {
      await ctx.db.patch(row._id, { summary, ...(error === undefined ? {} : { error }) });
    }
  }
  return { isDone: page.isDone, continueCursor: page.isDone ? null : page.continueCursor };
}

/** The status page must not say "processed" while rows still carry the id: only the last page calls this. */
async function completeReceipt(ctx: MutationCtx, receiptCode: string | undefined): Promise<void> {
  if (receiptCode === undefined) return;
  const receipt = await ctx.db
    .query("metaDataDeletionRequests")
    .withIndex("by_code", (q) => q.eq("code", receiptCode))
    .first();
  if (receipt && receipt.completedAt === undefined) {
    await ctx.db.patch(receipt._id, { completedAt: Date.now() });
  }
}

/**
 * Starts the redaction for one Meta user inside the caller's transaction: redacts
 * the first page and, when the source has more, stores the job and schedules its
 * next page in the same commit. A source of one page stores nothing at all.
 */
export async function startMetaLogRedaction(ctx: MutationCtx, args: RedactionStartArgs): Promise<void> {
  const page = await redactOnePage(ctx, args.platform, args.metaUserId, null);
  if (page.isDone) {
    await completeReceipt(ctx, args.receiptCode);
    return;
  }
  const jobId = await ctx.db.insert("metaLogRedactionJobs", {
    platform: args.platform,
    metaUserId: args.metaUserId,
    receiptCode: args.receiptCode,
    cursor: page.continueCursor,
    updatedAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.metaLogRedaction.runMetaLogRedactionJob, { jobId });
}

/** One page of a stored job. Gone job = already finished (a duplicate chain, or a sweep that raced the last page). */
async function advanceJob(ctx: MutationCtx, jobId: Id<"metaLogRedactionJobs">): Promise<void> {
  const job = await ctx.db.get(jobId);
  if (!job) return;
  const page = await redactOnePage(ctx, job.platform, job.metaUserId, job.cursor);
  if (page.isDone) {
    // Completion and erasure of the identifier are one transaction: the receipt
    // can never read "complete" while the job still holds the id, or the reverse.
    await completeReceipt(ctx, job.receiptCode);
    await ctx.db.delete(jobId);
    return;
  }
  await ctx.db.patch(jobId, { cursor: page.continueCursor, updatedAt: Date.now() });
  await ctx.scheduler.runAfter(0, internal.metaLogRedaction.runMetaLogRedactionJob, { jobId });
}

/** The public face of the start step for the deauthorize callback (no receipt). */
export const startMetaLogRedactionForUser = internalMutation({
  args: {
    platform: v.union(v.literal("facebook"), v.literal("instagram")),
    metaUserId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await startMetaLogRedaction(ctx, args);
    return null;
  },
});

/** Advances one stored job by one page and schedules the next. Argument: the job's own id only. */
export const runMetaLogRedactionJob = internalMutation({
  args: { jobId: v.id("metaLogRedactionJobs") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await advanceJob(ctx, args.jobId);
    return null;
  },
});

/**
 * Cron backstop: restarts a job whose chain died (a scheduled run that threw, a
 * deployment that dropped it). Reads only the `by_updatedAt` index range older than
 * the stall threshold, so with no job it reads nothing. Touching `updatedAt` first
 * keeps the next sweep from restarting a chain that is merely running.
 */
export const resumeStalledMetaLogRedactionJobs = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const now = Date.now();
    const stalled = await ctx.db
      .query("metaLogRedactionJobs")
      .withIndex("by_updatedAt", (q) => q.lt("updatedAt", now - META_LOG_REDACTION_STALL_MS))
      .take(META_LOG_REDACTION_SWEEP_BATCH);
    for (const job of stalled) {
      await ctx.db.patch(job._id, { updatedAt: now });
      await ctx.scheduler.runAfter(0, internal.metaLogRedaction.runMetaLogRedactionJob, { jobId: job._id });
    }
    return null;
  },
});
