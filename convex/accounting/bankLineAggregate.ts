import { DirectAggregate } from "@convex-dev/aggregate";
import { components } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type ControlKey = [Id<"chartOfAccounts">, string, number];
type AttributionKey = [Id<"chartOfAccounts">, string, Id<"bankAccounts">, number];

const control = new DirectAggregate<{
  Namespace: string;
  Key: ControlKey;
  Id: Id<"journalLines">;
}>(components.bankControlByDate);

const attribution = new DirectAggregate<{
  Namespace: string;
  Key: AttributionKey;
  Id: Id<"journalLines">;
}>(components.bankAttributionByDate);

/**
 * Lines of one org are spread over hash buckets, each its own component
 * namespace. Keys are dated, so in a single tree every posting lands on the
 * same rightmost node and concurrent postings in one org fail on OCC; across
 * buckets they touch different trees. Reads sum the buckets.
 */
export const BANK_AGGREGATE_BUCKETS = 16;
/** Bumped when the tree layout changes; a state from another layout is never READY. */
export const BANK_AGGREGATE_LAYOUT = 2;

export function bankAggregateNamespace(
  orgId: Id<"organizations">,
  resetGeneration: number,
  mappingGeneration: number,
): string {
  return `${orgId}:${resetGeneration}:${mappingGeneration}:L${BANK_AGGREGATE_LAYOUT}`;
}

/** Deterministic FNV-1a hash of a document id, for spreading writes. */
export function idHash(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function bucketNamespace(namespace: string, bucket: number): string {
  return `${namespace}#${bucket}`;
}

function lineNamespace(namespace: string, lineId: Id<"journalLines">): string {
  return bucketNamespace(namespace, idHash(lineId) % BANK_AGGREGATE_BUCKETS);
}

function allBuckets(namespace: string): string[] {
  return Array.from({ length: BANK_AGGREGATE_BUCKETS }, (_, bucket) => bucketNamespace(namespace, bucket));
}

export type BankAggregateLine = {
  id: Id<"journalLines">;
  accountId: Id<"chartOfAccounts">;
  currency: string;
  accountingDate: number;
  bankAccountId?: Id<"bankAccounts">;
  netMinor: number;
};

/** The caller has already validated the posted parent and period facts. */
export async function addBankControlLine(
  ctx: MutationCtx,
  line: BankAggregateLine,
  namespace: string,
): Promise<void> {
  if (!Number.isSafeInteger(line.netMinor)) throw new Error("Bank aggregate line amount exceeds safe integer precision.");
  namespace = lineNamespace(namespace, line.id);
  await control.insertIfDoesNotExist(ctx, {
    namespace,
    key: [line.accountId, line.currency, line.accountingDate],
    id: line.id,
    sumValue: line.netMinor,
  });
  if (line.bankAccountId) {
    await attribution.insertIfDoesNotExist(ctx, {
      namespace,
      key: [line.accountId, line.currency, line.bankAccountId, line.accountingDate],
      id: line.id,
      sumValue: line.netMinor,
    });
  }
}

export async function removeBankControlLine(
  ctx: MutationCtx,
  line: BankAggregateLine,
  namespace: string,
): Promise<void> {
  namespace = lineNamespace(namespace, line.id);
  await control.deleteIfExists(ctx, {
    namespace,
    key: [line.accountId, line.currency, line.accountingDate],
    id: line.id,
  });
  if (line.bankAccountId) {
    await attribution.deleteIfExists(ctx, {
      namespace,
      key: [line.accountId, line.currency, line.bankAccountId, line.accountingDate],
      id: line.id,
    });
  }
}

type Range = { fromInclusive?: number; through: number };
type Totals = { count: number; netMinor: number };

/**
 * Count and sum of every query in ONE component call.
 *
 * The client's countBatch and sumBatch each run the same aggregateBetweenBatch
 * walk and keep half of its answer, so asking for both walked every bucket
 * twice. countBatch is used only to build the walk's arguments; the walk's
 * full {count, sum} rows are captured on their way back.
 */
async function countAndSumBatch<K extends ControlKey | AttributionKey>(
  ctx: QueryCtx,
  aggregate: DirectAggregate<{ Namespace: string; Key: K; Id: Id<"journalLines"> }>,
  queries: { namespace: string; bounds: { lower: { key: K; inclusive: true }; upper: { key: K; inclusive: true } } }[],
): Promise<{ count: number; sum: number }[]> {
  let rows: unknown;
  let walks = 0;
  await aggregate.countBatch({
    runQuery: async (fn, args) => {
      walks += 1;
      rows = await ctx.runQuery(fn, args);
      return rows;
    },
  } as QueryCtx, queries);
  if (walks !== 1 || !Array.isArray(rows) || rows.length !== queries.length ||
      rows.some((row) => !Number.isSafeInteger(row?.count) || row.count < 0 || !Number.isSafeInteger(row?.sum))) {
    throw new Error("Bank aggregate batch read returned an unexpected shape.");
  }
  return rows as { count: number; sum: number }[];
}

/** Totals for each range of the bank control tree, every bucket, one walk. */
export async function readControlRanges(
  ctx: QueryCtx,
  namespace: string,
  accountId: Id<"chartOfAccounts">,
  currency: string,
  ranges: Range[],
): Promise<Totals[]> {
  const buckets = allBuckets(namespace);
  const queries = ranges.flatMap((range) => buckets.map((bucket) => ({
    namespace: bucket,
    bounds: {
      lower: { key: [accountId, currency, range.fromInclusive ?? Number.MIN_SAFE_INTEGER] as ControlKey, inclusive: true as const },
      upper: { key: [accountId, currency, range.through] as ControlKey, inclusive: true as const },
    },
  })));
  const rows = await countAndSumBatch(ctx, control, queries);
  return ranges.map((_, index) => sumBuckets(rows.slice(index * buckets.length, (index + 1) * buckets.length), "control"));
}

/** Totals for each physical bank's range of the attribution tree, every bucket, one walk. */
export async function readAttributionRanges(
  ctx: QueryCtx,
  namespace: string,
  accountId: Id<"chartOfAccounts">,
  currency: string,
  banks: { bankAccountId: Id<"bankAccounts">; range: Range }[],
): Promise<Totals[]> {
  const buckets = allBuckets(namespace);
  const queries = banks.flatMap(({ bankAccountId, range }) => buckets.map((bucket) => ({
    namespace: bucket,
    bounds: {
      lower: { key: [accountId, currency, bankAccountId, range.fromInclusive ?? Number.MIN_SAFE_INTEGER] as AttributionKey, inclusive: true as const },
      upper: { key: [accountId, currency, bankAccountId, range.through] as AttributionKey, inclusive: true as const },
    },
  })));
  const rows = await countAndSumBatch(ctx, attribution, queries);
  return banks.map((_, index) => sumBuckets(rows.slice(index * buckets.length, (index + 1) * buckets.length), "attribution"));
}

function sumBuckets(rows: { count: number; sum: number }[], tree: string): Totals {
  if (rows.length !== BANK_AGGREGATE_BUCKETS) {
    throw new Error(`Bank aggregate ${tree} read did not cover every bucket.`);
  }
  let count = 0;
  let netMinor = 0;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.sum)) throw new Error(`Bank aggregate ${tree} sum lost integer precision.`);
    count += row.count;
    netMinor += row.sum;
  }
  if (!Number.isSafeInteger(netMinor)) throw new Error(`Bank aggregate ${tree} sum lost integer precision.`);
  return { count, netMinor };
}

export async function clearBankAggregateNamespace(ctx: MutationCtx, namespace: string): Promise<void> {
  await Promise.all(allBuckets(namespace).flatMap((bucket) => [
    control.clear(ctx, { namespace: bucket }),
    attribution.clear(ctx, { namespace: bucket }),
  ]));
}
