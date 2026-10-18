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

export async function readControlRange(
  ctx: QueryCtx,
  namespace: string,
  accountId: Id<"chartOfAccounts">,
  currency: string,
  range: Range,
): Promise<{ count: number; netMinor: number }> {
  const bounds = {
    lower: { key: [accountId, currency, range.fromInclusive ?? Number.MIN_SAFE_INTEGER] as ControlKey, inclusive: true },
    upper: { key: [accountId, currency, range.through] as ControlKey, inclusive: true },
  };
  // One component call per measure covers every bucket.
  const queries = allBuckets(namespace).map((bucket) => ({ namespace: bucket, bounds }));
  const [counts, sums] = await Promise.all([control.countBatch(ctx, queries), control.sumBatch(ctx, queries)]);
  return sumBuckets(counts, sums, "control");
}

export async function readAttributionRange(
  ctx: QueryCtx,
  namespace: string,
  accountId: Id<"chartOfAccounts">,
  currency: string,
  bankAccountId: Id<"bankAccounts">,
  range: Range,
): Promise<{ count: number; netMinor: number }> {
  const bounds = {
    lower: { key: [accountId, currency, bankAccountId, range.fromInclusive ?? Number.MIN_SAFE_INTEGER] as AttributionKey, inclusive: true },
    upper: { key: [accountId, currency, bankAccountId, range.through] as AttributionKey, inclusive: true },
  };
  const queries = allBuckets(namespace).map((bucket) => ({ namespace: bucket, bounds }));
  const [counts, sums] = await Promise.all([attribution.countBatch(ctx, queries), attribution.sumBatch(ctx, queries)]);
  return sumBuckets(counts, sums, "attribution");
}

function sumBuckets(counts: number[], sums: number[], tree: string): { count: number; netMinor: number } {
  if (counts.length !== BANK_AGGREGATE_BUCKETS || sums.length !== BANK_AGGREGATE_BUCKETS) {
    throw new Error(`Bank aggregate ${tree} read did not cover every bucket.`);
  }
  let count = 0;
  let netMinor = 0;
  for (let bucket = 0; bucket < BANK_AGGREGATE_BUCKETS; bucket++) {
    if (!Number.isSafeInteger(sums[bucket])) throw new Error(`Bank aggregate ${tree} sum lost integer precision.`);
    count += counts[bucket];
    netMinor += sums[bucket];
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
