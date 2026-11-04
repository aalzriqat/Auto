import type { TransactionMetrics } from "convex/server";
import {
  VERIFICATION_RESERVE_BYTES,
  VERIFICATION_RESERVE_DOCUMENTS,
  VERIFICATION_RESERVE_QUERIES,
} from "../accounting/accountSnapshots";

/**
 * A byte-aware bounded read (SCRUM-869 Finding 2).
 *
 * A row cap bounds documents, not bytes. Convex lets one function read 16 MiB, 32,000 documents and 4,096 index ranges, metered
 * for the whole transaction (https://docs.convex.dev/production/state/limits), and a document may be up to 1 MiB, so 100 rows
 * with long free-text fields can pass the row cap and still throw "Read too much data in a single function execution". The
 * documented remedy is to ask the transaction how much room it has left, `ctx.meta.getTransactionMetrics()`
 * (https://docs.convex.dev/database/writing-data, "Checking transaction headroom"), and stop reading before the next read could
 * exceed it. This is the same decision `VerificationBudget.hasHeadroom` makes in accounting/accountSnapshots.ts for the SCRUM-889
 * verification pass, with the same reserve policy, so the two stay consistent; this module serves readers that stream a list.
 *
 * Fail closed: a context that cannot report its metrics has no headroom. The check reads the metrics afresh every time, so other
 * readers running in the same transaction are seen as they spend. `getTransactionMetrics` is asked once per document; the
 * documentation states no cost for it and the real backend's cost is for the release rehearsal to measure (SCRUM-762).
 */

/** The largest a single Convex document can be, https://docs.convex.dev/production/state/limits: what one more read can cost. */
const MAX_DOCUMENT_BYTES = 1024 * 1024;

/** The part of a query or mutation context the check needs. A context without it is one whose headroom cannot be read. */
export type HeadroomCtx = { meta?: { getTransactionMetrics?: () => Promise<TransactionMetrics> } };

/**
 * True when the transaction can take one more read of a worst-case document (1 MiB) and still leave the reserve for the
 * caller's remaining work: 2 MiB, 2,000 documents and 256 queries, the policy of the SCRUM-889 verification pass.
 */
export async function hasReadHeadroom(ctx: HeadroomCtx): Promise<boolean> {
  const read = ctx.meta?.getTransactionMetrics;
  if (typeof read !== "function") return false;
  const metrics = await read.call(ctx.meta);
  return (
    metrics.bytesRead.remaining >= MAX_DOCUMENT_BYTES + VERIFICATION_RESERVE_BYTES &&
    metrics.documentsRead.remaining >= 1 + VERIFICATION_RESERVE_DOCUMENTS &&
    metrics.databaseQueries.remaining >= 1 + VERIFICATION_RESERVE_QUERIES
  );
}

export interface BoundedStreamRead<D> {
  /** Up to `limit + 1` documents: one past the limit tells the caller the stream held more than it asked for. */
  docs: D[];
  /** True when the read stopped because the transaction could not take another document. `docs` is then partial. */
  outOfHeadroom: boolean;
}

/**
 * Reads `source` one document at a time, asking the transaction for headroom before every document, and stops at `limit + 1`
 * documents. A `take(n)` page cannot stop part-way, so a list of large documents has to be streamed for a refusal to land before
 * the limit does. The caller decides what a partial read means (here: an incomplete section with its totals withheld).
 */
export async function readBoundedStream<D>(
  ctx: HeadroomCtx,
  source: AsyncIterable<D>,
  limit: number,
): Promise<BoundedStreamRead<D>> {
  const iterator = source[Symbol.asyncIterator]();
  const docs: D[] = [];
  try {
    while (docs.length <= limit) {
      if (!(await hasReadHeadroom(ctx))) return { docs, outOfHeadroom: true };
      const next = await iterator.next();
      if (next.done) break;
      docs.push(next.value);
    }
    return { docs, outOfHeadroom: false };
  } finally {
    await iterator.return?.();
  }
}
