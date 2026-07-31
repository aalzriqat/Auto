import { TableAggregate } from "@convex-dev/aggregate";
import { Triggers } from "convex-helpers/server/triggers";
import { components } from "./_generated/api";
import { DataModel, Id } from "./_generated/dataModel";
import { validateVinChecksum } from "../lib/vinHelpers";

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
 * `sortKey` is `[deletedFlag, sourcedFlag, status, createdAt]`, a prefix-ordered
 * tuple:
 *
 * - `deletedFlag` (0 = live, 1 = soft-deleted) keeps soft-deleted rows *in* the
 *   tree rather than removing them. That matters: a soft delete is a `patch`,
 *   so the trigger sees an update and moves the key, which is exactly one
 *   B-tree operation. Removing-on-delete would need the trigger to reason about
 *   whether the row was previously counted, which is where drift creeps in.
 * - `sourcedFlag` (0 = own stock, 1 = sourced/drop-ship) exists because
 *   `dashboard.stats` counts inventory as `sourceType !== "SOURCED"` — it is
 *   reporting cars the dealer actually holds. `sourceType` is optional, and
 *   both `undefined` and `"STOCK"` mean own stock, so the flag is
 *   `=== "SOURCED" ? 1 : 0` to match the filter exactly rather than
 *   three-valued. It sits *above* `status` so "every status, own stock only" is
 *   one contiguous range; below it, that read would need one range per status.
 * - `status` lets a bounded read count just AVAILABLE vehicles.
 * - `createdAt` makes the age buckets pure range counts.
 *
 * Adding `sourcedFlag` changed the key, which invalidates every stored position
 * — see `migrations.rebuildVehicleAggregates`, which must run once per deployment
 * that already had the old three-element key.
 *
 * `sumValue` is `createdAt` *offset by `SUM_EPOCH`*, so average age within a
 * bucket comes from `sum / count` instead of reading the rows.
 *
 * Two things about that sum are load-bearing.
 *
 * **It must be an integer.** The component keeps a running sum per B-tree node
 * and, before splitting one, asserts the incrementally accumulated sum equals
 * the re-associated `left + right + pivot` within an *absolute* 1e-5 — throwing
 * a plain `Error("bad sum split")`, which rolls back the dealer's whole
 * mutation, when it doesn't. `createdAt` is absent on legacy rows and on
 * everything `importBulk` and the approval-workflow create insert, so
 * `vehicleCreatedAt` falls back to `_creationTime` — which Convex makes
 * *fractional* to keep it unique per document. Summing fractional values at a
 * magnitude of ~1e13 accumulates reassociation drift far past 1e-5, and an
 * affected org can no longer create, edit, sell or delete any vehicle at all
 * from around 250 rows, permanently, with no self-recovery. `Math.floor` makes
 * every summand integral; day-granularity `avgDays` cannot notice, and the sort
 * key keeps full precision.
 *
 * **It must stay well under 2^53**, past which float64 stops representing
 * integers exactly and the same assertion fires. Raw epoch milliseconds are
 * ~1.79e12, so a node's sum would cross 2^53 at roughly 5,000 rows while a full
 * height-2 node holds up to 4,912 — no margin at all. Offsetting to a recent
 * epoch leaves ~8.6e10 per row today, i.e. ~105,000 rows in one node, and that
 * headroom shrinks each year as `createdAt` grows (~69,000 by 2028).
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
  Key: [number, number, string, number];
  DataModel: DataModel;
  TableName: "vehicles";
}>(components.vehiclesByOrg, {
  namespace: (doc) => doc.orgId,
  sortKey: (doc) => [
    doc.isDeleted === true ? 1 : 0,
    isSourced(doc) ? 1 : 0,
    doc.status,
    vehicleCreatedAt(doc),
  ],
  sumValue: (doc) => Math.floor(vehicleCreatedAt(doc)) - SUM_EPOCH,
});

/**
 * Whether a vehicle is sourced on demand from another dealer rather than held
 * as the dealer's own stock. `sourceType` is optional; `undefined` predates the
 * field and means own stock, which is why this is not `!== "STOCK"`.
 *
 * Exported so the aggregate key and `dashboard.stats` cannot drift apart on
 * what "inventory" means.
 */
export function isSourced(doc: { sourceType?: "STOCK" | "SOURCED" }): boolean {
  return doc.sourceType === "SOURCED";
}

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

/** Sort-key prefix for live (non-soft-deleted) rows. */
export const LIVE = 0;
export const SOFT_DELETED = 1;

/** Own stock vs. sourced-on-demand, as encoded in `vehiclesByOrg`'s key. */
export const OWN_STOCK = 0;
export const SOURCED = 1;

/** Present/absent flags, as encoded in the data-quality keys below. */
export const ABSENT = 0;
export const PRESENT = 1;

/** VIN check-digit outcome, as encoded in `vehicleQualityByOrg`'s key. */
export const VIN_OK = 0;
export const VIN_INVALID = 1;

/**
 * How a customer row came to exist, as encoded in `customersByOrg`'s key.
 * DIRECT means the dealership created it; SOCIAL means Instagram/Facebook
 * ingestion did.
 */
export const DIRECT = 0;
export const SOCIAL = 1;

/**
 * Counts of vehicles whose stored VIN fails its ISO 3779 check digit, for the
 * dashboard's data-quality nudge card. `dataQualityStats` used to read up to
 * 2,000 vehicle documents to produce this single number.
 *
 * ## Why this is a separate tree from `vehiclesByOrg`
 *
 * Every other key element in this file is a *stored field*, so the tree can
 * only be wrong if a write skips the trigger — which `aggregateWiring.test.ts`
 * makes impossible. This one is a *computed predicate*: it calls
 * `validateVinChecksum`. If that function's behaviour ever changes, every
 * stored key silently becomes wrong, with no failing write and no signal.
 *
 * Isolating it means such a change invalidates one small tree used by one
 * nudge card, rather than the inventory tree that the dashboard's headline
 * counts and the aging histogram both depend on. `vinChecksumPinned.test.ts`
 * turns that silent hazard into a build failure.
 *
 * Folding it into `vehiclesByOrg` as a fifth key element was the alternative.
 * It would need to sit above `createdAt` to be countable, which doubles the
 * ranges every aging-bucket and inventory read has to scan — 16 instead of 8 —
 * to marginalise a dimension none of them care about.
 *
 * `sortKey` is `[deletedFlag, vinInvalidFlag]`. Vehicles with no VIN at all
 * count as valid: the card nudges about VINs that look wrong, not missing ones.
 */
export const vehicleQualityByOrg = new TableAggregate<{
  Namespace: Id<"organizations">;
  Key: [number, number];
  DataModel: DataModel;
  TableName: "vehicles";
}>(components.vehicleQualityByOrg, {
  namespace: (doc) => doc.orgId,
  sortKey: (doc) => [doc.isDeleted === true ? 1 : 0, hasVinWarning(doc) ? 1 : 0],
});

/**
 * Whether a vehicle's VIN is present but fails its check digit — the exact
 * predicate `dataQualityStats` reported by scanning rows.
 *
 * Exported so the aggregate key and the pinning test share one definition.
 */
export function hasVinWarning(doc: { vin?: string }): boolean {
  return !!doc.vin && !validateVinChecksum(doc.vin);
}

/**
 * Counts of customers missing a phone number or an email address, for the same
 * nudge card. Replaces a scan of up to 2,000 customer documents.
 *
 * `sortKey` is `[deletedFlag, socialFlag, hasPhone, hasEmail]`.
 *
 * ## Why `socialFlag` is in the key
 *
 * The Instagram and Facebook ingestion paths materialise a customer row per
 * inbound interaction, named after the sender's handle with no phone and no
 * email — on production that is roughly one every five minutes. Counting them
 * made the nudge card structurally unactionable: it reported ~450 of 470
 * customers "missing a phone number", when the dealer has no phone number to
 * enter and never did. A card that cannot reach zero is not a nudge, it is
 * furniture. Excluding them lets the number mean "records you can actually go
 * and fix".
 *
 * The flag sits directly under `deletedFlag` so "live, not social" is a prefix
 * every one of the card's reads shares.
 *
 * Empty strings count as missing, matching the falsy check the row scan used —
 * a customer saved with `phone: ""` was never a customer with a phone number.
 *
 * Adding `socialFlag` changed the key, so any deployment that already seeded
 * this tree needs `migrations.rebuildCustomerAggregate`.
 */
export const customersByOrg = new TableAggregate<{
  Namespace: Id<"organizations">;
  Key: [number, number, number, number];
  DataModel: DataModel;
  TableName: "customers";
}>(components.customersByOrg, {
  namespace: (doc) => doc.orgId,
  sortKey: (doc) => [
    doc.isDeleted === true ? 1 : 0,
    isSocialOriginated(doc) ? SOCIAL : DIRECT,
    doc.phone ? PRESENT : ABSENT,
    doc.email ? PRESENT : ABSENT,
  ],
});

/**
 * Whether a customer row was created by social ingestion rather than entered by
 * the dealership.
 *
 * Keys off the linked account id, not `source`. Both are stamped at creation by
 * `instagramEngagement.ts` and `facebookEngagement.ts`, but `source` is a free
 * `v.string()` that any other code path — or a future import — could set to
 * "Instagram" without the row being a social contact at all. The id fields are
 * written in exactly two places in the whole repo, both of them the ingestion
 * paths themselves, which makes this predicate mean what it says.
 *
 * A social contact who later shares a phone number keeps the flag. That is
 * deliberate and costs nothing: having a phone already takes them out of the
 * "missing phone" count, and re-classifying a row as the dealer fills it in
 * would move it between key prefixes on every edit for no benefit.
 */
export function isSocialOriginated(doc: {
  instagramUserId?: string;
  facebookUserId?: string;
}): boolean {
  return !!doc.instagramUserId || !!doc.facebookUserId;
}

/**
 * Counts of leads by pipeline stage, for `dashboard.stats`' "active leads"
 * tile. Replaces a scan of up to 1,000 lead documents.
 *
 * `sortKey` is `[deletedFlag, stage]` — the raw stage, deliberately, rather
 * than a precomputed "is open" flag. "Active" means *not* WON and *not* LOST,
 * and baking that rule into the key would mean any change to the pipeline (a
 * new terminal stage, a renamed one) silently mis-sorts every stored row with
 * nothing to catch it. Keeping the stage verbatim leaves the business rule in
 * the query, where changing it is just a different subtraction.
 */
export const leadsByOrg = new TableAggregate<{
  Namespace: Id<"organizations">;
  Key: [number, string];
  DataModel: DataModel;
  TableName: "leads";
}>(components.leadsByOrg, {
  namespace: (doc) => doc.orgId,
  sortKey: (doc) => [doc.isDeleted === true ? 1 : 0, doc.stage],
});

/**
 * Membership count per org, for `dashboard.stats`' "team members" tile.
 *
 * `memberships` has no soft-delete column — a removed member's row is deleted
 * outright — so the whole namespace is the count and the key carries no flags.
 * `_creationTime` is used as the key rather than a constant so the tree stays
 * ordered by something meaningful and a future "members joined this month"
 * read is a range rather than a rebuild.
 */
export const membershipsByOrg = new TableAggregate<{
  Namespace: Id<"organizations">;
  Key: number;
  DataModel: DataModel;
  TableName: "memberships";
}>(components.membershipsByOrg, {
  namespace: (doc) => doc.orgId,
  sortKey: (doc) => doc._creationTime,
});

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
aggregateTriggers.register("vehicles", vehicleQualityByOrg.idempotentTrigger());
aggregateTriggers.register("customers", customersByOrg.idempotentTrigger());
aggregateTriggers.register("leads", leadsByOrg.idempotentTrigger());
aggregateTriggers.register("memberships", membershipsByOrg.idempotentTrigger());
