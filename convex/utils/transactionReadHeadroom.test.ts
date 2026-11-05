/**
 * SCRUM-869 Finding 2: the byte-aware bounded read. convex-test's `transactionLimits` only approximates the 16 MiB ceiling, so the
 * budget decision is pinned here with hand-set metrics and literals from the platform limits
 * (https://docs.convex.dev/production/state/limits) and the reserve policy shared with the SCRUM-889 verification pass: one
 * 1 MiB document + a 2 MiB reserve, 1 + 2,000 documents, 1 + 256 queries. Evidence boundary: this proves the decision logic, not the
 * Convex backend's metering (SCRUM-762 owns that).
 */
import { describe, expect, test } from "vitest";
import { hasReadHeadroom, readBoundedStream } from "./transactionReadHeadroom";

const MIB = 1024 * 1024;
type M = { bytes: number; docs: number; queries: number };
const AMPLE: M = { bytes: 16 * MIB, docs: 32_000, queries: 4_096 };
const metricsOf = (m: M) => {
  const unlimited = { used: 0, remaining: Number.MAX_SAFE_INTEGER };
  return {
    bytesRead: { used: 0, remaining: m.bytes },
    documentsRead: { used: 0, remaining: m.docs },
    databaseQueries: { used: 0, remaining: m.queries },
    bytesWritten: unlimited,
    documentsWritten: unlimited,
    functionsScheduled: unlimited,
    scheduledFunctionArgsBytes: unlimited,
  };
};
const ctxOf = (read: () => M) => ({ meta: { getTransactionMetrics: async () => metricsOf(read()) } });

async function* numbers(count: number, onNext?: (index: number) => void) {
  for (let i = 0; i < count; i += 1) {
    onNext?.(i);
    yield i;
  }
}

describe("hasReadHeadroom", () => {
  const edge: M = { bytes: 3 * MIB, docs: 2_001, queries: 257 };

  test("admits a read at exactly 1 MiB + 2 MiB, 1 + 2,000 documents and 1 + 256 queries, and refuses one below any of them", async () => {
    expect(await hasReadHeadroom(ctxOf(() => edge))).toBe(true);
    expect(await hasReadHeadroom(ctxOf(() => ({ ...edge, bytes: 3 * MIB - 1 })))).toBe(false);
    expect(await hasReadHeadroom(ctxOf(() => ({ ...edge, docs: 2_000 })))).toBe(false);
    expect(await hasReadHeadroom(ctxOf(() => ({ ...edge, queries: 256 })))).toBe(false);
    expect(await hasReadHeadroom(ctxOf(() => AMPLE))).toBe(true);
  });

  test("a context that cannot report its metrics has no headroom: it fails closed", async () => {
    expect(await hasReadHeadroom({})).toBe(false);
    expect(await hasReadHeadroom({ meta: {} })).toBe(false);
  });
});

describe("readBoundedStream", () => {
  test("CONTROL: ample headroom reads everything up to the limit, and does not flag the headroom", async () => {
    const read = await readBoundedStream(ctxOf(() => AMPLE), numbers(3), 5);
    expect(read).toEqual({ docs: [0, 1, 2], outOfHeadroom: false });
  });

  test("reads one document past the limit so the caller can tell 'over the limit' from 'exactly the limit', and no more", async () => {
    let pulled = 0;
    const read = await readBoundedStream(ctxOf(() => AMPLE), numbers(50, () => (pulled += 1)), 5);
    expect(read.docs).toEqual([0, 1, 2, 3, 4, 5]);
    expect(read.outOfHeadroom).toBe(false);
    expect(pulled).toBe(6);
  });

  test("stops before the read that the transaction could not take, keeping what it has, and says so", async () => {
    // The transaction reports ample room for the first two documents, then only what an edge read needs less one byte.
    let documentsPulled = 0;
    const read = await readBoundedStream(
      ctxOf(() => (documentsPulled < 2 ? AMPLE : { bytes: 3 * MIB - 1, docs: 32_000, queries: 4_096 })),
      numbers(10, () => (documentsPulled += 1)),
      100,
    );
    expect(read).toEqual({ docs: [0, 1], outOfHeadroom: true });
    expect(documentsPulled).toBe(2);
  });

  test("the metrics are read afresh before every document, never cached across reads", async () => {
    let metricReads = 0;
    const ctx = { meta: { getTransactionMetrics: async () => { metricReads += 1; return metricsOf(AMPLE); } } };
    await readBoundedStream(ctx, numbers(4), 100);
    // One look before each of the four documents and one before the read that finds the stream empty.
    expect(metricReads).toBe(5);
  });

  test("no headroom to start with: nothing is pulled from the stream", async () => {
    let pulled = 0;
    const read = await readBoundedStream({}, numbers(5, () => (pulled += 1)), 100);
    expect(read).toEqual({ docs: [], outOfHeadroom: true });
    expect(pulled).toBe(0);
  });
});
