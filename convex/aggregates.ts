import { TableAggregate } from "@convex-dev/aggregate";
import { Triggers } from "convex-helpers/server/triggers";
import { components } from "./_generated/api";
import { DataModel, Id } from "./_generated/dataModel";

/**
 * Maintained counts for vehicles, so the dashboard can answer "how many" and
 * "how old" without reading the rows.
 *
 * `vehicles.getAgingBuckets` used to iterate every AVAILABLE vehicle's full
 * document to build a four-bucket histogram. Per Convex's own per-function
 * breakdown it was 1.19 GB of database bandwidth.
 *
 * ## What this does and does not buy
 *
 * It cuts the *bytes read per execution*, not the number of executions. The
 * B-tree's interior nodes are themselves documents, so a write that patches a
 * node inside a range the query reads still invalidates the subscription — the
 * dashboard re-runs about as often as it did against the index scan. What
 * changes is that a re-run reads ~15-20 node documents instead of every
 * matching vehicle row.
 *
 * Genuinely reducing the *rate* of re-execution is a different change
 * (decoupling the tiles from a live query), and is deliberately not attempted
 * here.
 *
 * ## Key layout
 *
 * `namespace` is the orgId, so one org's counts are never read or invalidated
 * by another org's writes — the same tenant boundary the tables have.
 *
 * `sortKey` is `[deletedFlag, status, createdAt]`, a prefix-ordered tuple:
 *
 * - `deletedFlag` (0 = live, 1 = soft-deleted) keeps soft-deleted rows *in* the
 *   tree rather than removing them. That matters: a soft delete is a `patch`,
 *   so the trigger sees an update and moves the key, which is exactly one
 *   B-tree operation. Removing-on-delete would need the trigger to reason about
 *   whether the row was previously counted, which is where drift creeps in.
 * - `status` lets a bounded read count just AVAILABLE vehicles.
 * - `createdAt` makes the age buckets pure range counts.
 *
 * `sumValue` is `createdAt` *offset by `SUM_EPOCH`*, so average age within a
 * bucket comes from `sum / count` instead of reading the rows.
 *
 * The offset is not cosmetic. The component keeps a running `sum` on every
 * B-tree node and, when a node splits, asserts that the incrementally
 * accumulated sum equals the re-associated `left + right + pivot` within 1e-5,
 * throwing a plain `Error("bad sum split")` — which rolls back the dealer's
 * whole mutation — when it doesn't. Raw epoch milliseconds are ~1.78e12, so a
 * node's sum crosses 2^53 (where float64 stops representing integers exactly)
 * at roughly 5,000 rows, and a full height-2 node holds up to 4,912. That is a
 * ~2% margin today which shrinks every year as `createdAt` grows, going
 * negative around Feb 2028 — at which point any org with a few thousand
 * lifetime vehicle rows starts failing *writes*. Offsetting to a recent epoch
 * drops the magnitude to ~1e10 and buys ~900,000 rows of headroom.
 *
 * Changing SUM_EPOCH later invalidates every stored sum and requires clearing
 * and rebuilding the tree, so it is fixed here deliberately.
 *
 * ## Invariant
 *
 * Every write to `vehicles` must go through a mutation built by
 * `convex/functions.ts`, whose wrapped `ctx.db` fires the trigger that keeps
 * this tree in step with the table. `convex/aggregateWiring.test.ts` fails the
 * build if any Convex module takes a mutation builder straight from
 * `_generated/server`, because such a mutation would write the table and
 * silently skip the tree.
 */
export const vehiclesByOrg = new TableAggregate<{
  Namespace: Id<"organizations">;
  Key: [number, string, number];
  DataModel: DataModel;
  TableName: "vehicles";
}>(components.vehiclesByOrg, {
  namespace: (doc) => doc.orgId,
  sortKey: (doc) => [
    doc.isDeleted === true ? 1 : 0,
    doc.status,
    vehicleCreatedAt(doc),
  ],
  sumValue: (doc) => vehicleCreatedAt(doc) - SUM_EPOCH,
});

/**
 * `createdAt` is optional on older vehicle rows; `getAgingBuckets` has always
 * fallen back to `_creationTime` for those. The aggregate has to use the exact
 * same expression, or a backfilled row would land in a different bucket than
 * the row scan put it in.
 */
export function vehicleCreatedAt(doc: {
  createdAt?: number;
  _creationTime: number;
}): number {
  return doc.createdAt ?? doc._creationTime;
}

/**
 * Origin the aggregate's stored sums are measured from. Keeps node sums far
 * below 2^53 — see the note on `sumValue` above. 2023-11-14T22:13:20Z, chosen
 * to predate every row in the system.
 */
export const SUM_EPOCH = 1_700_000_000_000;

/** Sort-key prefix for live (non-soft-deleted) vehicles in a given status. */
export const LIVE = 0;
export const SOFT_DELETED = 1;

/**
 * The trigger registrations that keep every aggregate above in step with its
 * table.
 *
 * Declared here, next to the aggregates themselves, rather than inside
 * `convex/functions.ts`, so that both the production mutation builders and the
 * test harness can install the *same* instance. `convex-test`'s `t.run` hands
 * out a raw `ctx.db` that fires no triggers, so a test that seeds through it
 * would leave the tree describing a table state that no longer exists — and the
 * next real mutation on that row would collide on a stale key. Sharing the
 * registrations lets `test-utils/convexTest.ts` wrap `t.run` too, so seeding in
 * a test behaves exactly like a write in production.
 *
 * `idempotentTrigger`, not `trigger`, and the difference matters in production.
 * The strict trigger throws DELETE_MISSING_KEY when it updates a row the tree
 * has never seen — which is every pre-existing vehicle in the window between
 * this deploying and `migrations.backfillVehicleAggregate` finishing. That
 * would not merely misreport a count: it would make editing a vehicle fail
 * outright for real dealers, for as long as the backfill took. Trading a
 * possibly-stale count for a write that always succeeds is the right way round
 * — the count is a dashboard tile, the write is someone's job.
 */
export const aggregateTriggers = new Triggers<DataModel>();

aggregateTriggers.register("vehicles", vehiclesByOrg.idempotentTrigger());
