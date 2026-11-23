import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { LIVE, OWN_STOCK, SOURCED, SUM_EPOCH, vehiclesByOrg } from "../aggregates";

/** The stock kinds `getAgingBuckets` sums over, in key order. */
const STOCK_KINDS = [OWN_STOCK, SOURCED];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The vehicle aging histogram's four buckets, as inclusive age ranges in days
 * so they can be turned into createdAt bounds on the aggregate.
 * `maxAgeDays: null` is the open-ended oldest bucket.
 *
 * These boundaries are the ones the original row scan applied as
 * `days <= 30 | 60 | 90`; `vehicleAggregate.test.ts` pins both edges of every
 * bucket against that formula.
 */
const AGE_BUCKETS = [
  { bucket: "0-30" as const, minAgeDays: 0, maxAgeDays: 30 },
  { bucket: "31-60" as const, minAgeDays: 31, maxAgeDays: 60 },
  { bucket: "61-90" as const, minAgeDays: 61, maxAgeDays: 90 },
  { bucket: "90+" as const, minAgeDays: 91, maxAgeDays: null },
];

/**
 * Aggregate sort key for a live AVAILABLE vehicle of a given stock kind,
 * created at `createdAt`.
 *
 * The histogram counts own stock *and* sourced vehicles — that is what the row
 * scan it replaced did, since it never looked at `sourceType`. `sourcedFlag`
 * sits above `status` in the key, so "both kinds" is not one contiguous range;
 * each bucket therefore contributes one query per kind, and the pairs are
 * summed back together below. Both still land in a single batched round-trip.
 */
function agingKey(sourcedFlag: number, createdAt: number): [number, number, string, number] {
  return [LIVE, sourcedFlag, "AVAILABLE", createdAt];
}

export async function readVehicleAgingBuckets(
  ctx: QueryCtx,
  args: { orgId: Id<"organizations"> },
) {
  const now = Date.now();

  // Each bucket is a contiguous createdAt range *per stock kind*, so it is a
  // bounded count and a bounded sum against the B-tree — four buckets × two
  // kinds × (count + sum) = sixteen O(log n) reads in total, no vehicle
  // documents touched. Iterating every AVAILABLE vehicle to build this
  // histogram was 1.19 GB of database I/O.
  //
  // The kinds double the range count but not the round-trips: `countBatch`
  // and `sumBatch` each walk the tree once no matter how many bound pairs
  // they are handed, which is why they are used instead of per-bucket calls.
  //
  // Boundaries are derived from the row-scan's `ageDays <= 30 | 60 | 90`,
  // where ageDays = floor((now - createdAt) / DAY_MS):
  //   ageDays <= N  <=>  createdAt > now - (N + 1) * DAY_MS
  const queries = AGE_BUCKETS.flatMap(({ maxAgeDays, minAgeDays }) =>
    STOCK_KINDS.map((sourcedFlag) => ({
      namespace: args.orgId,
      bounds: {
        // An older vehicle has a *smaller* createdAt, so maxAgeDays gives the
        // lower bound of the range and minAgeDays the upper one.
        lower:
          maxAgeDays === null
            ? { key: agingKey(sourcedFlag, Number.MIN_SAFE_INTEGER), inclusive: true as const }
            : {
              key: agingKey(sourcedFlag, now - (maxAgeDays + 1) * DAY_MS),
              inclusive: false as const,
            },
        upper:
          minAgeDays === 0
            ? { key: agingKey(sourcedFlag, Number.MAX_SAFE_INTEGER), inclusive: true as const }
            : {
              key: agingKey(sourcedFlag, now - minAgeDays * DAY_MS),
              inclusive: true as const,
            },
      },
    })),
  );

  // Batched: `count` and `sum` each issue their own component round-trip, so
  // asking per bucket would be eight traversals of the same tree — enough to
  // read more than the row scan this replaces on a mid-sized org. Two batched
  // calls walk it twice regardless of how many buckets there are.
  const [counts, sums] = await Promise.all([
    vehiclesByOrg.countBatch(ctx, queries),
    vehiclesByOrg.sumBatch(ctx, queries),
  ]);

  return AGE_BUCKETS.map(({ bucket }, i) => {
    // Each bucket produced one query per stock kind, laid out contiguously by
    // the flatMap above, so bucket i owns [i * STOCK_KINDS.length, +len).
    const from = i * STOCK_KINDS.length;
    const slice = STOCK_KINDS.map((_, k) => from + k);
    const count = slice.reduce((acc, j) => acc + counts[j], 0);
    const sum = slice.reduce((acc, j) => acc + sums[j], 0);
    // Mean age from the mean createdAt (sums are stored offset by SUM_EPOCH,
    // so add it back). The row scan averaged already-floored ages and this
    // floors once at the end, so on a mixed bucket the two can differ by at
    // most a day — within what an "average days in stock" tile conveys, and
    // the only way to get an average without reading the rows.
    //
    // The scan also clamped each row's age at 0 before averaging, which this
    // cannot reproduce from a sum. Only a future-dated `createdAt` can tell
    // the difference, and no mutation produces one — every write path stamps
    // Date.now(). The admin raw-JSON editor can, so the clamp stays on the
    // result to keep a negative average from ever reaching the UI.
    const avgDays =
      count > 0
        ? Math.max(0, Math.round((now - (sum / count + SUM_EPOCH)) / DAY_MS))
        : 0;

    return { bucket, count, avgDays };
  });
}
