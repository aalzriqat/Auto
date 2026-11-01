// SCRUM-842: redaction of a Meta user id out of retained `webhookLogs` rows.
//
// A signed deauthorize or data-deletion callback names one Meta user. Rows
// written before SCRUM-842 carry that id in their summary (and may carry it in
// `error` and in the stored webhook body), and SCRUM-807 forbids deleting
// operational history, so the id is replaced with fixed text and the row stays.
// The disposition is a coordinator decision (authority delegated by the owner),
// not an owner ruling.
//
// Which ids: the id the callback named, plus every other id of the same account
// that the caller read before the disconnect cleared it (an Instagram account has
// a business account id and a different webhook account id; see
// `metaLogRedactionSources`). The job row stores them all, so the walk redacts all of them.
//
// Which rows: every `webhookLogs` source that can hold that platform's id, not only
// the callback source. `metaLogRedactionSources` lists them (`<platform>-oauth`, then
// `<platform>`: the delivery inbox, the auto-reply failures and the Instagram
// subscription failures). A receipt must not say "processed" while any of them still
// holds an id, so completion waits for the last page of the last source.
//
// Bounded and resumable. One transaction examines at most one page of ONE source
// through the existing `by_source_and_eventId` index: no table scan, no new index on
// `webhookLogs`, and exactly one paginated query (Convex allows one per function).
// A page is bounded by rows AND by bytes (`META_LOG_REDACTION_MAX_BYTES_READ`), because
// a delivery-inbox row can hold a 700,000-character webhook body and a page of 100 of
// them would exceed the 16 MiB a transaction may read. A page that reaches the byte
// budget is discarded unread and the job retries from the same cursor at half the
// size, down to one row (one document is at most 1 MiB, so one row always fits). The
// HTTP callback does exactly one such page, then returns. Everything else is carried
// by a job row that remembers where the walk is (`sourceIndex` + `cursor` +
// `pageSize`), one page per scheduled run:
//
//   request:  page 1 of source 0 -> insert job {sourceIndex, cursor, pageSize}, schedule run(jobId)
//   run(jobId): next page        -> more pages or more sources: patch position, schedule run(jobId)
//                                   last page of last source: delete job + complete receipt, ONE transaction
//   sweep (cron): a job quiet for META_LOG_REDACTION_STALL_MS gets run(jobId) again;
//                 a job that the sweep has had to restart META_LOG_REDACTION_WEDGED_AFTER_RESTARTS
//                 times without it moving is reported (see `resumeStalledMetaLogRedactionJobs`)
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
//   scheduled function and its arguments readable for 7 days, so a Meta user id
//   and the receipt code must never be arguments; the job id is opaque and points
//   at a row that no longer exists after completion.
// - The Meta user ids sit in the job row only while pages remain. Redaction is a
//   no-op on a redacted row, so every page, run, sweep and replay is idempotent.
// - A run reads the position from the job row inside its own transaction and writes
//   the next one back in that transaction, so two chains for one job (the live chain
//   and a sweep restart) never skip a page: Convex serialises their writes.
import { getDocumentSize, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./functions";
import { recordWebhookLog } from "./utils/webhookLog";
import {
  META_LOG_REDACTED_FIELDS,
  META_LOG_REDACTION_MAX_BYTES_READ,
  META_LOG_REDACTION_PAGE_SIZE,
  metaLogRedactionSources,
  metaOauthLogSource,
  nextRedactionPageSize,
  redactMetaUserIdInText,
  type MetaPlatform,
} from "./utils/metaUserIdRedaction";

/** A job nobody has advanced for this long has lost its chain; the sweep restarts it. */
export const META_LOG_REDACTION_STALL_MS = 15 * 60 * 1000;
/** Stalled jobs restarted per sweep run (a sweep that finds more simply continues next time). */
export const META_LOG_REDACTION_SWEEP_BATCH = 50;
/**
 * Sweep restarts, with no page committed in between, after which a job is reported as
 * wedged. The sweep runs every 30 minutes, so this is about four hours of failing
 * restarts: long enough for an outage to pass, short enough to be seen the same day.
 */
export const META_LOG_REDACTION_WEDGED_AFTER_RESTARTS = 8;
/** The most ids one job carries (the callback id plus the other ids of the same account). */
const MAX_REDACTED_IDS = 8;

interface RedactionStartArgs {
  platform: MetaPlatform;
  metaUserId: string;
  /** The account's other ids, read before the disconnect cleared them. */
  otherMetaUserIds?: readonly string[];
  /** The deletion receipt to mark complete once the last page is redacted. */
  receiptCode?: string;
}

/** Where the walk is: which source of `metaLogRedactionSources`, the cursor into it, and the page size to ask for. */
export interface MetaLogRedactionPosition {
  sourceIndex: number;
  cursor: string | null;
  pageSize: number;
}

/**
 * One step's outcome: the whole walk is finished, or the position the next step starts
 * at. After a page that reached the byte budget the position is the SAME one with a
 * smaller `pageSize`: nothing was read past, nothing was written.
 */
export type MetaLogRedactionStep = { done: true } | { done: false; next: MetaLogRedactionPosition };

const WALK_START: MetaLogRedactionPosition = { sourceIndex: 0, cursor: null, pageSize: META_LOG_REDACTION_PAGE_SIZE };

/** The ids to redact: the callback's id first, then the account's other ids, once each, bounded. */
function distinctIds(primary: string, others: readonly string[] | undefined): string[] {
  const ids = [primary];
  for (const id of others ?? []) {
    if (id.trim() !== "" && !ids.includes(id) && ids.length < MAX_REDACTED_IDS) ids.push(id);
  }
  return ids;
}

/**
 * Redacts one page of one source of one platform and says where the walk goes next.
 * Never schedules, never completes. Only this function reads `webhookLogs`, with one
 * paginated query, so a step is one query however many sources there are.
 */
export async function redactOneStep(
  ctx: MutationCtx,
  platform: MetaPlatform,
  metaUserIds: readonly string[],
  position: MetaLogRedactionPosition,
): Promise<MetaLogRedactionStep> {
  const sources = metaLogRedactionSources(platform);
  const source = sources[position.sourceIndex];
  if (source === undefined) {
    // A stored position the list no longer has: finishing here would call a walk that
    // never reached its sources "complete". Fail so the receipt stays pending.
    throw new Error("Meta log redaction position is outside the source list.");
  }
  const page = await ctx.db
    .query("webhookLogs")
    .withIndex("by_source_and_eventId", (q) => q.eq("source", source))
    .paginate({
      numItems: position.pageSize,
      cursor: position.cursor,
      maximumBytesRead: META_LOG_REDACTION_MAX_BYTES_READ,
    });
  if (page.pageStatus === "SplitRequired") {
    // Convex says this page reached the byte budget and may be incomplete. Nothing has
    // been written yet, so the page is thrown away and asked for again at half the size
    // from the same cursor: moving the cursor past it could skip rows the receipt would
    // then call redacted. One row cannot reach the budget (a document is at most 1 MiB),
    // so a one-row page that still does is a fault to surface, not to retry silently.
    if (position.pageSize <= 1) {
      throw new Error("Meta log redaction page was cut short by the read limit even at one row.");
    }
    return { done: false, next: { ...position, pageSize: Math.max(1, Math.floor(position.pageSize / 2)) } };
  }

  let bytesRead = 0;
  for (const row of page.page) {
    bytesRead += getDocumentSize(row);
    const patch: Partial<Pick<Doc<"webhookLogs">, (typeof META_LOG_REDACTED_FIELDS)[number]>> = {};
    for (const field of META_LOG_REDACTED_FIELDS) {
      const text = row[field];
      if (text === undefined) continue;
      let redacted = text;
      for (const metaUserId of metaUserIds) redacted = redactMetaUserIdInText(redacted, metaUserId);
      if (redacted !== text) patch[field] = redacted;
    }
    if (Object.keys(patch).length > 0) await ctx.db.patch(row._id, patch);
  }

  // The size for the next page follows what this one cost, so a run of small rows
  // goes back to the full page after a stretch of large ones.
  const pageSize = nextRedactionPageSize(page.page.length, bytesRead);
  if (!page.isDone) return { done: false, next: { sourceIndex: position.sourceIndex, cursor: page.continueCursor, pageSize } };
  const nextSource = position.sourceIndex + 1;
  if (nextSource < sources.length) return { done: false, next: { sourceIndex: nextSource, cursor: null, pageSize } };
  return { done: true };
}

/** The status page must not say "processed" while rows still carry an id: only the last page calls this. */
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
 * the first page of the first source and stores the job that carries the rest, with
 * its next page scheduled in the same commit. The receipt is completed only if that
 * first page was the whole walk, which `metaLogRedactionSources` (two sources) rules out.
 */
export async function startMetaLogRedaction(ctx: MutationCtx, args: RedactionStartArgs): Promise<void> {
  const metaUserIds = distinctIds(args.metaUserId, args.otherMetaUserIds);
  const step = await redactOneStep(ctx, args.platform, metaUserIds, WALK_START);
  if (step.done) {
    await completeReceipt(ctx, args.receiptCode);
    return;
  }
  const [, ...otherMetaUserIds] = metaUserIds;
  const jobId = await ctx.db.insert("metaLogRedactionJobs", {
    platform: args.platform,
    metaUserId: args.metaUserId,
    ...(otherMetaUserIds.length > 0 ? { otherMetaUserIds } : {}),
    receiptCode: args.receiptCode,
    sourceIndex: step.next.sourceIndex,
    cursor: step.next.cursor,
    pageSize: step.next.pageSize,
    updatedAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.metaLogRedaction.runMetaLogRedactionJob, { jobId });
}

/** One page of a stored job. Gone job = already finished (a duplicate chain, or a sweep that raced the last page). */
async function advanceJob(ctx: MutationCtx, jobId: Id<"metaLogRedactionJobs">): Promise<void> {
  const job = await ctx.db.get(jobId);
  if (!job) return;
  const step = await redactOneStep(ctx, job.platform, distinctIds(job.metaUserId, job.otherMetaUserIds), {
    sourceIndex: job.sourceIndex,
    cursor: job.cursor,
    pageSize: job.pageSize ?? META_LOG_REDACTION_PAGE_SIZE,
  });
  if (step.done) {
    // Completion and erasure of the identifiers are one transaction: the receipt
    // can never read "complete" while the job still holds an id, or the reverse.
    await completeReceipt(ctx, job.receiptCode);
    await ctx.db.delete(jobId);
    return;
  }
  await ctx.db.patch(jobId, {
    sourceIndex: step.next.sourceIndex,
    cursor: step.next.cursor,
    pageSize: step.next.pageSize,
    // A committed step is progress: the wedge count starts again.
    stalledRestarts: 0,
    updatedAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.metaLogRedaction.runMetaLogRedactionJob, { jobId });
}

/** The public face of the start step for the deauthorize callback (no receipt). */
export const startMetaLogRedactionForUser = internalMutation({
  args: {
    platform: v.union(v.literal("facebook"), v.literal("instagram")),
    metaUserId: v.string(),
    otherMetaUserIds: v.optional(v.array(v.string())),
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
 * keeps the next sweep from restarting a chain that is merely running. One sweep
 * restarts at most META_LOG_REDACTION_SWEEP_BATCH jobs; any further stalled job waits
 * for a later sweep (the cron runs every 30 minutes).
 *
 * A restart that does not move the job is counted (`stalledRestarts`; every committed
 * page resets it). At META_LOG_REDACTION_WEDGED_AFTER_RESTARTS the job is reported once
 * as an `error` row in the platform's `-oauth` webhook log (platform and count only, no
 * id) and every further restart writes an error line to the Convex logs, so a job that
 * can never finish is visible to an operator instead of retrying in silence. The
 * receipt stays pending: it is true, and it is not completed on a guess.
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
      const stalledRestarts = (job.stalledRestarts ?? 0) + 1;
      await ctx.db.patch(job._id, { updatedAt: now, stalledRestarts });
      if (stalledRestarts >= META_LOG_REDACTION_WEDGED_AFTER_RESTARTS) {
        // Fixed text: no id, no receipt code, no error text (a Convex error can quote arguments).
        console.error(`[meta-log-redaction] a ${job.platform} redaction job has not advanced in ${stalledRestarts} sweeps`);
        if (stalledRestarts === META_LOG_REDACTION_WEDGED_AFTER_RESTARTS) {
          await recordWebhookLog(ctx, {
            source: metaOauthLogSource(job.platform),
            status: "error",
            summary: `Retained-log redaction for a ${job.platform} deletion request has not advanced in ${stalledRestarts} restarts; its receipt stays pending`,
          });
        }
      }
      await ctx.scheduler.runAfter(0, internal.metaLogRedaction.runMetaLogRedactionJob, { jobId: job._id });
    }
    return null;
  },
});
