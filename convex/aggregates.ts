import { TableAggregate } from "@convex-dev/aggregate";
import { Triggers } from "convex-helpers/server/triggers";
import { components } from "./_generated/api";
import { DataModel, Id } from "./_generated/dataModel";

/**
 * Maintained counts for vehicles, so the dashboard can answer "how many" and
 * "how old" without reading the rows.
 *
 * `vehicles.getAgingBuckets` used to iterate every AVAILABLE vehicle's full
 * document to build a four-bucket histogram, and `dashboard.stats` /
 * `dashboard.dataQualityStats` read up to 2,000 more for counts. All three are
 * *live* queries on the dashboard landing page, so every vehicle write re-ran
 * them from scratch. Per Convex's own per-function breakdown those three were
 * 67% of this project's database bandwidth (9.6 GB of 14.27 GB).
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
 * `sumValue` is `createdAt`, so average age within a bucket comes from
 * `sum / count` instead of reading the rows.
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
  sumValue: (doc) => vehicleCreatedAt(doc),
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
