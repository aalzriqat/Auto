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
// A dealer's own Disconnect, a reconnect to another account, an organisation deletion or an
// earlier callback clears those ids from the settings before the next callback arrives;
// `instagramAccountIdLinks` keeps the pair for 30 days after the last completed deletion (then the
// 30-minute sweep deletes it), because a webhook body that names the account can still arrive after
// the job that erased it has finished (`idsKnownFor` reads it back).
//
// Overlapping callbacks for one user: once a first callback has disconnected the account,
// a second one (Meta's retry, a deauthorize followed by a deletion request, a user asking
// twice) finds no connection and cannot read the account's other id. It would start a job
// holding only the id it named and complete its receipt while the first job, still pending,
// holds the other id and the stored webhook bodies still show it. So a starting job
// inherits the ids of every pending job of its platform that shares an id with it
// (`idsKnownFor`, which follows pending jobs and kept links together), and walks from the start with the union: its receipt is true
// on its own, whatever happens to the earlier job. Each job still completes only its own
// receipt. An earlier job does not learn a later job's new ids: its receipt answers for the
// ids captured by its own callback. If the union would exceed MAX_REDACTED_IDS, or more than
// META_LOG_REDACTION_MAX_PENDING_JOBS jobs are pending, the callback is refused (the whole
// transaction rolls back and Meta retries) instead of dropping an id.
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
import { ConvexError, getDocumentSize, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./functions";
import { recordWebhookLog } from "./utils/webhookLog";
import {
  META_LOG_DOCUMENT_BUDGET_BYTES,
  META_LOG_REDACTED_FIELDS,
  META_LOG_REDACTION_MAX_BYTES_READ,
  META_LOG_REDACTION_MAX_READABLE_WRITE_BYTES,
  META_LOG_REDACTION_PAGE_SIZE,
  metaLogRedactionSources,
  metaOauthLogSource,
  nextRedactionPageSize,
  REDACTED_META_USER,
  REDACTED_META_USER_COMPACT,
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
export const MAX_REDACTED_IDS = 8;

/** Fixed text: this error reaches a log line, so it names no id and no code. */
export const REDACTION_REFUSED = "The redaction could not be started. Please try again later.";

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

/**
 * The most pending jobs of one platform a callback reads to find the jobs that hold the
 * same user's ids. A job lives for minutes (one page per scheduled run), so the table is
 * normally empty; more than this many pending jobs on one platform is a backlog, and the
 * callback refuses (a 500, Meta retries) rather than redact on a partial view.
 */
export const META_LOG_REDACTION_MAX_PENDING_JOBS = 200;

/** The ids to redact: the callback's id first, then the account's other ids, once each, bounded. */
function distinctIds(primary: string, others: readonly string[] | undefined, limit = MAX_REDACTED_IDS): string[] {
  const ids = [primary];
  for (const id of others ?? []) {
    if (id.trim() !== "" && !ids.includes(id) && ids.length < limit) ids.push(id);
  }
  return ids;
}

/**
 * The ids of an Instagram account that `instagramAccountIdLinks` keeps against `id`: both of the
 * account's ids are kept as one row when the dealer lets go (Disconnect, a reconnect to another
 * account, an organisation deletion) or a callback disconnects it, and the row stays after the job
 * that erased it finished, because a webhook body that names the account can still arrive. It stays
 * for 30 days from the last completed deletion (INSTAGRAM_ID_LINK_RETENTION_MS), then the sweep
 * deletes it.
 * More than MAX_REDACTED_IDS rows against one id cannot all be read, and could not all be carried by
 * one job either, so the callback refuses instead of dropping one.
 */
async function idsLinkedTo(ctx: MutationCtx, id: string): Promise<string[]> {
  const rows = await linkRowsOf(ctx, id);
  if (rows.length > MAX_REDACTED_IDS) throw new ConvexError(REDACTION_REFUSED);
  return rows.flatMap((row) => [row.businessAccountId, row.webhookAccountId]);
}

/** The link rows that name `id` as either of the account's ids, at most MAX_REDACTED_IDS + 1 from each index. */
async function linkRowsOf(ctx: MutationCtx, id: string): Promise<Doc<"instagramAccountIdLinks">[]> {
  return [
    ...(await ctx.db
      .query("instagramAccountIdLinks")
      .withIndex("by_business_account_id", (q) => q.eq("businessAccountId", id))
      .take(MAX_REDACTED_IDS + 1)),
    ...(await ctx.db
      .query("instagramAccountIdLinks")
      .withIndex("by_webhook_account_id", (q) => q.eq("webhookAccountId", id))
      .take(MAX_REDACTED_IDS + 1)),
  ];
}

/**
 * How long the id pair of a finished Instagram deletion is kept. A record that outlives its purpose
 * is itself retained personal data, so it is bounded (GDPR Art. 5(1)(e), storage limitation:
 * https://gdpr-info.eu/art-5-gdpr/). 30 days covers Meta's callback retries and a user repeating the
 * request; after it a callback naming one id erases that id only. Each completion re-stamps.
 */
export const INSTAGRAM_ID_LINK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Link rows one sweep deletes; a longer queue simply continues on the next run (30 minutes later). */
export const INSTAGRAM_ID_LINK_PURGE_BATCH = 100;

/**
 * Starts the retention clock on the links a finished Instagram job read: every row that names one of
 * the job's ids (the same ranges `idsKnownFor` read, so exactly the rows that led the job to its ids).
 * Called in the transaction that completes the receipt, so the clock never starts while an id is
 * still stored. Other accounts' rows are never touched.
 */
async function stampLinksOf(ctx: MutationCtx, platform: MetaPlatform, ids: readonly string[]): Promise<void> {
  if (platform !== "instagram") return;
  const purgeAfter = Date.now() + INSTAGRAM_ID_LINK_RETENTION_MS;
  const stamped = new Set<Id<"instagramAccountIdLinks">>();
  for (const id of ids) {
    for (const row of await linkRowsOf(ctx, id)) {
      if (stamped.has(row._id)) continue;
      stamped.add(row._id);
      await ctx.db.patch(row._id, { purgeAfter });
    }
  }
}

/**
 * Deletes the links past `purgeAfter`, at most INSTAGRAM_ID_LINK_PURGE_BATCH per call, by the
 * `by_purge_after` index (https://docs.convex.dev/database/reading-data/indexes/). In Convex's
 * ordering `undefined < null < all other values` (https://docs.convex.dev/database/types), so a bare
 * `lte` would also match every row with no `purgeAfter`; the `gte(0)` lower bound excludes them.
 */
async function purgeExpiredInstagramIdLinks(ctx: MutationCtx, now: number): Promise<void> {
  const due = await ctx.db
    .query("instagramAccountIdLinks")
    .withIndex("by_purge_after", (q) => q.gte("purgeAfter", 0).lte("purgeAfter", now))
    .take(INSTAGRAM_ID_LINK_PURGE_BATCH);
  for (const row of due) await ctx.db.delete(row._id);
}

/**
 * Every id this user is known by, beyond `ids`: ONE fixpoint over the two places an id can be
 * remembered, so an id learned in either leads on through the other.
 *  - every pending job of this platform that holds a known id (a job reached through a second job's
 *    id is still the same user), and
 *  - for Instagram, every link kept against a known id (`instagramAccountIdLinks`).
 * Two separate passes missed an id that is reachable only by going job -> link (SCRUM-842 round 9).
 * Reads one platform's index range, at most META_LOG_REDACTION_MAX_PENDING_JOBS + 1 rows, and the
 * link ranges of at most MAX_REDACTED_IDS ids; a concurrent callback that inserts a job, or a
 * Disconnect that adds a link, in a range read here makes this transaction retry
 * (https://docs.convex.dev/database/advanced/occ), so two overlapping callbacks cannot both miss
 * each other. The set is checked against MAX_REDACTED_IDS as it grows, so a long chain never
 * makes the callback read more than the bound.
 */
async function idsKnownFor(ctx: MutationCtx, platform: MetaPlatform, ids: readonly string[]): Promise<string[]> {
  const pending = await ctx.db
    .query("metaLogRedactionJobs")
    .withIndex("by_platform", (q) => q.eq("platform", platform))
    .take(META_LOG_REDACTION_MAX_PENDING_JOBS + 1);
  if (pending.length > META_LOG_REDACTION_MAX_PENDING_JOBS) throw new ConvexError(REDACTION_REFUSED);
  const known = new Set(ids);
  const unlinked = pending.map((job) => distinctIds(job.metaUserId, job.otherMetaUserIds, Number.POSITIVE_INFINITY));
  const linksRead = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (let i = unlinked.length - 1; i >= 0; i -= 1) {
      if (!unlinked[i].some((id) => known.has(id))) continue;
      for (const id of unlinked[i]) known.add(id);
      unlinked.splice(i, 1);
      grew = true;
    }
    if (known.size > MAX_REDACTED_IDS) throw new ConvexError(REDACTION_REFUSED);
    if (platform !== "instagram") continue;
    for (const id of [...known]) {
      if (linksRead.has(id)) continue;
      linksRead.add(id);
      for (const linkedId of await idsLinkedTo(ctx, id)) {
        if (known.has(linkedId)) continue;
        known.add(linkedId);
        grew = true;
      }
      if (known.size > MAX_REDACTED_IDS) throw new ConvexError(REDACTION_REFUSED);
    }
  }
  return [...known].filter((id) => !ids.includes(id));
}
type RedactedFields = Partial<Pick<Doc<"webhookLogs">, (typeof META_LOG_REDACTED_FIELDS)[number]>>;

function redactFields(row: Doc<"webhookLogs">, metaUserIds: readonly string[], replacement: string): RedactedFields {
  const patch: RedactedFields = {};
  for (const field of META_LOG_REDACTED_FIELDS) {
    const text = row[field];
    if (text === undefined) continue;
    let redacted = text;
    for (const metaUserId of metaUserIds) redacted = redactMetaUserIdInText(redacted, metaUserId, replacement);
    if (redacted !== text) patch[field] = redacted;
  }
  return patch;
}

/**
 * The fields to patch on one row. The readable replacement text is longer than a short
 * id, so a row near the 1 MiB document limit that is packed with ids would grow past it
 * and Convex would refuse the write for ever (https://docs.convex.dev/production/state/limits;
 * halving a page cannot help one document). When the readable result would not fit the
 * budget, the row is redacted with a one-character replacement instead: that is never
 * longer than the id it replaces, so the document cannot grow and the id still goes.
 */
function redactedFieldsOf(
  row: Doc<"webhookLogs">,
  metaUserIds: readonly string[],
  readableBytesSoFar: number,
): { patch: RedactedFields; readableBytes: number } {
  const readable = redactFields(row, metaUserIds, REDACTED_META_USER);
  if (Object.keys(readable).length === 0) return { patch: readable, readableBytes: 0 };
  const size = getDocumentSize({ ...row, ...readable });
  // Two budgets: one document must fit the document limit, and the readable rewrites of one
  // page together must leave room, inside the 16 MiB a transaction may write, for the rows
  // that are still to be rewritten (each of those is at most as large as the row it replaces).
  if (size <= META_LOG_DOCUMENT_BUDGET_BYTES && readableBytesSoFar + size <= META_LOG_REDACTION_MAX_READABLE_WRITE_BYTES) {
    return { patch: readable, readableBytes: size };
  }
  return { patch: redactFields(row, metaUserIds, REDACTED_META_USER_COMPACT), readableBytes: 0 };
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
  let readableBytes = 0;
  for (const row of page.page) {
    bytesRead += getDocumentSize(row);
    const redaction = redactedFieldsOf(row, metaUserIds, readableBytes);
    readableBytes += redaction.readableBytes;
    const patch = redaction.patch;
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
  // The account may already be disconnected by an earlier callback whose job is still
  // pending, so the settings no longer supply the account's other id. That pending job
  // does: this job inherits its ids, so its receipt is complete only when EVERY id this
  // user is known by is erased, not only the one this callback named.
  const captured = distinctIds(args.metaUserId, args.otherMetaUserIds, Number.POSITIVE_INFINITY);
  const inherited = await idsKnownFor(ctx, args.platform, captured);
  const metaUserIds = distinctIds(args.metaUserId, [...captured.slice(1), ...inherited], Number.POSITIVE_INFINITY);
  // Dropping an id would let the receipt read "complete" with that id still stored.
  if (metaUserIds.length > MAX_REDACTED_IDS) throw new ConvexError(REDACTION_REFUSED);
  const step = await redactOneStep(ctx, args.platform, metaUserIds, WALK_START);
  if (step.done) {
    await completeReceipt(ctx, args.receiptCode);
    await stampLinksOf(ctx, args.platform, metaUserIds);
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
  const jobIds = distinctIds(job.metaUserId, job.otherMetaUserIds);
  const step = await redactOneStep(ctx, job.platform, jobIds, {
    sourceIndex: job.sourceIndex,
    cursor: job.cursor,
    pageSize: job.pageSize ?? META_LOG_REDACTION_PAGE_SIZE,
  });
  if (step.done) {
    // Completion and erasure of the identifiers are one transaction: the receipt
    // can never read "complete" while the job still holds an id, or the reverse.
    await completeReceipt(ctx, job.receiptCode);
    await stampLinksOf(ctx, job.platform, jobIds);
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
 *
 * The same run also calls `purgeExpiredInstagramIdLinks`, which deletes the
 * `instagramAccountIdLinks` rows whose `purgeAfter` has passed, at most
 * INSTAGRAM_ID_LINK_PURGE_BATCH (100) per run. `purgeAfter` is stamped 30 days after a
 * completed deletion receipt (SCRUM-842 c24305). The purge touches no webhook log and
 * no job row.
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
    // The same 30-minute run also ends the retention of finished deletions' id pairs.
    await purgeExpiredInstagramIdLinks(ctx, now);
    return null;
  },
});
