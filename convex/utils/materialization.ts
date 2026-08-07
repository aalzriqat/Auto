import type { Doc, Id } from "../_generated/dataModel";
import type { GenericDatabaseReader, GenericDatabaseWriter } from "convex/server";
import type { DataModel } from "../_generated/dataModel";

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
 * only affects how the state is *described* to staff; the reader already
 * refuses to trust anything that is not `completed`, so a wrong guess here
 * cannot produce a wrong inbox.
 */
export const MATERIALIZATION_STALL_MS = 5 * 60 * 1000;

export const SOCIAL_PLATFORMS = ["instagram", "facebook"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export type MaterializationStatus =
  | "notStarted"
  | "running"
  | "interrupted"
  | "failed"
  | "completed";

type AnyDb = GenericDatabaseReader<DataModel> | GenericDatabaseWriter<DataModel>;

/**
 * The state row for one org/platform at the current generation, or null.
 *
 * Uses `.first()` rather than `.unique()` on purpose. `.unique()` throws when
 * it finds duplicates, and this runs inside the Social Inbox read path — a
 * throw there is an outage, whereas reading one of two duplicate rows at worst
 * costs a fallback to the legacy path. The writer takes the same lookup before
 * inserting, so duplicates are not expected; this decides which way to be
 * wrong if they ever occur.
 */
export async function readMaterializationState(
  ctx: { db: AnyDb },
  orgId: Id<"organizations">,
  platform: SocialPlatform,
  generation: number = SOCIAL_CONVERSATION_GENERATION
): Promise<Doc<"socialMaterializationState"> | null> {
  return await ctx.db
    .query("socialMaterializationState")
    .withIndex("by_org_generation_platform", (q) =>
      q.eq("orgId", orgId).eq("generation", generation).eq("platform", platform)
    )
    .first();
}

/**
 * Describes a state row the way staff need to read it.
 *
 * `notStarted` and `completed`-with-zero-rows are the two states that look
 * identical from the table contents alone, and telling them apart is the whole
 * point of the record.
 */
export function describeMaterializationStatus(
  row: Doc<"socialMaterializationState"> | null,
  now: number
): MaterializationStatus {
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
 * 2. Every write path to `instagramEvents`/`facebookEvents` goes through the
 *    trigger-wrapped builders in `functions.ts`. That is not an assumption:
 *    `deferredThreadSync.test.ts` fails the build on any mutation that writes
 *    these tables without them.
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
 * the two mechanisms, and never by neither. The union is what makes COMPLETED
 * mean "current", which is what lets it unlock the reader.
 *
 * `socialMaterializationGate.test.ts` exercises exactly this: a message that
 * arrives between two pages of a live run, asserted present after completion.
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
 * interrupted, failed. The cost of being wrong in this direction is a slower
 * query; the cost of being wrong in the other direction is staff not seeing
 * customer messages.
 */
export async function socialConversationsReady(
  ctx: { db: AnyDb },
  orgId: Id<"organizations">
): Promise<boolean> {
  for (const platform of SOCIAL_PLATFORMS) {
    const row = await readMaterializationState(ctx, orgId, platform);
    if (!row || row.status !== "completed") return false;
  }
  return true;
}
