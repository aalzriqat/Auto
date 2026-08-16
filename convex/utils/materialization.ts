import type { DataModel, Doc, Id } from "../_generated/dataModel";
import type { GenericDatabaseReader, GenericDatabaseWriter } from "convex/server";

/**
 * The materialisation shape `socialConversations` readers currently expect.
 *
 * Bump this whenever a change to what a `socialConversations` row *means*
 * makes previously-backfilled rows wrong — a new stored field the reader
 * depends on, a change to `conversationKey`, a change to how `unansweredCount`
 * is derived. Bumping it makes every org fall back to the legacy path until a
 * backfill for the new generation proves itself complete, which is exactly the
 * behaviour that would have prevented the incident this whole mechanism exists
 * for.
 *
 * Do NOT bump it for changes that leave existing rows correct (a new index, a
 * new filter over fields that are already stored) — an unnecessary bump sends
 * every tenant back to a full-table scan until someone notices.
 */
export const SOCIAL_CONVERSATION_GENERATION = 1;

/**
 * How long a `running` record may go without progress before it is reported as
 * interrupted rather than in-flight.
 *
 * A self-scheduled chain advances every few seconds, so minutes of silence
 * means the chain is gone — a throw that rolled its transaction back, a
 * deployment that landed mid-run, a transaction that hit a Convex limit. This
 * The reader is unaffected either way — it refuses to trust anything that is
 * not `completed` — so a wrong guess here cannot produce a wrong inbox.
 *
 * It is NOT purely descriptive, though. `startSocialConversationBackfills`
 * uses the same call to decide whether a chain is still advancing and should be
 * left alone, so this constant is also the redrive gate: lower it and a redrive
 * fences a live chain, raise it and a genuinely dead one stays unredriveable
 * for longer. Tune it with both effects in mind.
 */
export const MATERIALIZATION_STALL_MS = 5 * 60 * 1000;

export const SOCIAL_PLATFORMS = ["instagram", "facebook"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export type MaterializationStatus =
  | "notStarted"
  | "running"
  | "interrupted"
  | "failed"
  | "completed"
  /**
   * More than one state row for the same org, platform and generation. They
   * cannot both be right, so nothing downstream is permitted to guess which is.
   */
  | "ambiguous";

type AnyDb = GenericDatabaseReader<DataModel> | GenericDatabaseWriter<DataModel>;

/**
 * The state row for one org/platform/generation, or an explicit reason there
 * isn't exactly one.
 *
 * This deliberately does not return `Doc | null`. It used to, resolved with
 * `.first()`, on the reasoning that duplicates were unreachable through the
 * writer and that reading one of two "at worst costs a fallback to the legacy
 * path". The second half was simply false, and it was the half the safety
 * argument rested on. `.first()` returns the OLDEST row at equal index keys, so
 * a stale `completed` sitting beside a live `running` is exactly the pair it
 * resolves the wrong way: the gate sees `completed`, unlocks a table that is
 * still being built, and reports a short or empty inbox with total confidence.
 * That is the incident this mechanism exists to prevent, reached through the
 * one code path written to prevent it.
 *
 * `.unique()` is still not the answer — it throws, and a throw on the Social
 * Inbox read path is an outage. So: read one more row than may legitimately
 * exist, and report the contradiction as its own state for callers to fail
 * closed on.
 *
 * Duplicates should remain unreachable in normal operation, since Convex's
 * serializable transactions make the read-then-insert in
 * `beginConversationBackfill` safe against a concurrent one. This is about what
 * happens when that assumption is broken from outside it — a raw-JSON admin
 * edit, a data repair, a future writer — which is exactly when a safety gate is
 * being relied upon and exactly when it must not fail open.
 */
export async function lookupMaterializationState(
  ctx: { db: AnyDb },
  orgId: Id<"organizations">,
  platform: SocialPlatform,
  generation: number = SOCIAL_CONVERSATION_GENERATION
): Promise<
  | { kind: "missing"; row: null }
  | { kind: "unique"; row: Doc<"socialMaterializationState"> }
  | { kind: "ambiguous"; row: null }
> {
  // Two, not all: the only question is "exactly one or not", and an unbounded
  // read here would scale with whatever went wrong.
  const rows = await ctx.db
    .query("socialMaterializationState")
    .withIndex("by_org_generation_platform", (q) =>
      q.eq("orgId", orgId).eq("generation", generation).eq("platform", platform)
    )
    .take(2);

  if (rows.length === 0) return { kind: "missing", row: null };
  if (rows.length === 1) return { kind: "unique", row: rows[0] };
  return { kind: "ambiguous", row: null };
}

/**
 * Describes a lookup the way staff need to read it.
 *
 * `notStarted` and `completed`-with-zero-rows are the two states that look
 * identical from the table contents alone, and telling them apart is the whole
 * point of the record. `ambiguous` is reported rather than folded into
 * `notStarted` because the two want opposite operator responses: one is "run
 * the backfill", the other is "resolve the contradiction first, because a run
 * cannot".
 */
export function describeMaterializationStatus(
  lookup: Awaited<ReturnType<typeof lookupMaterializationState>>,
  now: number
): MaterializationStatus {
  if (lookup.kind === "ambiguous") return "ambiguous";
  const row = lookup.row;
  if (!row) return "notStarted";
  if (row.status === "completed") return "completed";
  if (row.status === "failed") return "failed";
  return now - row.lastProgressAt > MATERIALIZATION_STALL_MS ? "interrupted" : "running";
}

/**
 * Why COMPLETED is safe to trust — the transition-race argument.
 *
 * The worry is a message that lands while the backfill is finishing: present in
 * the events, absent from `socialConversations`, and the run marks COMPLETED
 * anyway. That cannot happen here, and the reason is structural rather than
 * lucky.
 *
 * 1. The trigger that maintains `socialConversations` is registered in
 *    `aggregates.ts` against both event tables and runs inside the same
 *    transaction as the write. It is live from the instant the code deploys —
 *    strictly before any backfill can be invoked, since the backfill is code
 *    from the same push.
 * 2. Every write path to `instagramEvents`/`facebookEvents` goes through a
 *    trigger-wrapped builder from `functions.ts`. That is enforced, not
 *    assumed: `aggregateWiring.test.ts` fails the build on a Convex module
 *    that imports a raw `mutation`/`internalMutation` instead.
 *
 *    One honest caveat. `socialBulkMutation` is deliberately wrapped with
 *    `deferredThreadTriggers`, which does NOT recompute conversations per
 *    write — bulk loops opt into it precisely to avoid O(N²) recomputes, and
 *    settle up by calling `syncDeferredSocialThreads` at the end.
 *    `deferredThreadSync.test.ts` fails the build if such a mutation never
 *    calls it, but it cannot prove the handler collected *every* thread it
 *    touched. Both current call sites do (`customers.mergeCustomers` collects
 *    loser and survivor; `setConversationVehicle` collects the pre-patch rows,
 *    and `vehicleId` is not part of the key). A future one that collects only
 *    some of what it patches would leave stale rows that COMPLETED would then
 *    vouch for. That is the residual risk in this argument, and it lives in the
 *    writer, not the gate.
 * 3. So an event arriving mid-run is materialised by its own write, whether or
 *    not the walk has reached it yet.
 * 4. And the walk cannot skip it either. Pagination is by index sort key, new
 *    rows take the largest `_creationTime`, and the cursor only moves forward —
 *    so a row inserted mid-run sorts after the cursor and is still visited.
 *    Visiting it again is harmless because `syncSocialConversation` is a full
 *    recompute of the thread, not an increment.
 * 5. COMPLETED is written only when `page.isDone` — pagination exhausted — and
 *    nowhere else.
 *
 * Points 3 and 4 together mean every event is materialised by at least one of
 * the two mechanisms, and never by neither.
 *
 * ## What COMPLETED does NOT prove, and what covers the gap
 *
 * The argument above is entirely about source coverage: every event has a row.
 * That is strictly weaker than what the reader needs, which is that the rows it
 * serves are exactly the current generation's — and the difference is not
 * academic. A backfill only ever visits threads reachable from source events,
 * and `syncSocialConversation` only deletes a row when it recomputes that row's
 * thread and finds it empty. A row that no source event maps to is therefore
 * never visited, never rebuilt and never deleted. Completion says nothing about
 * it, and neither does a force rebuild.
 *
 * That becomes deterministic rather than hypothetical on a generation bump: a
 * bump exists precisely for the case where `conversationKey` changes meaning,
 * so the old keys do not collide with the new ones. Nothing overwrites them.
 * They would sit in the table until the new generation reached COMPLETED and
 * then be served beside the real threads.
 *
 * The fence is therefore on the DATA as well as the claim: every row carries
 * its `generation`, every authoritative index leads with it, and the reader
 * selects one generation. Superseded rows become inert — wrong, but
 * unreachable, and sweepable whenever with no correctness deadline.
 *
 * ⚠️ One residual, stated plainly because it is the shape that bites. This
 * fences generation-MISMATCHED rows, not same-generation orphans. A stale row
 * whose thread still exists under the current key scheme is only ever corrected
 * by a write to that thread, so the bulk-writer risk in point 2 above — a
 * handler that patches events without collecting every thread it touched — is
 * not covered here and cannot be. `deferredThreadSync.test.ts` is what holds
 * that end, which is why its own fail-open history is treated as seriously as
 * the gate's.
 *
 * `socialMaterializationGate.test.ts` exercises both: a message that arrives
 * between two pages of a live run, asserted present after completion, and a
 * superseded-generation row asserted absent from a completed reader.
 */

/**
 * Whether the materialised `socialConversations` rows may be treated as the
 * authoritative source for this org.
 *
 * Both platforms must be proven complete at the current generation, because
 * the inbox lists them together: an org whose Instagram backfill finished and
 * whose Facebook backfill did not would show a confidently incomplete list,
 * which is the same defect as showing a confidently empty one.
 *
 * Fails closed on every uncertainty — missing row, wrong generation, running,
 * interrupted, failed, or contradictory duplicates. The cost of being wrong in
 * this direction is a slower query; the cost of being wrong in the other
 * direction is staff not seeing customer messages.
 */
export async function socialConversationsReady(
  ctx: { db: AnyDb },
  orgId: Id<"organizations">
): Promise<boolean> {
  for (const platform of SOCIAL_PLATFORMS) {
    const lookup = await lookupMaterializationState(ctx, orgId, platform);
    // `kind` first, and not merely for style: reading `.row` alone would treat
    // an ambiguous lookup as a missing one, which happens to be safe here and
    // would stop being safe the moment someone gave `ambiguous` a row to
    // report. The gate states its requirement instead of inheriting it.
    if (lookup.kind !== "unique" || lookup.row.status !== "completed") return false;
  }
  return true;
}
