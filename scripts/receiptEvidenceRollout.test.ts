import { describe, expect, test, vi } from "vitest";
import { runReceiptEvidenceBackfill } from "./receiptEvidenceRollout";

const fail = (reason: string): never => { throw new Error(reason); };
const limits = { now: () => 0, startedAt: 0, timeoutMs: 1_000, fail };

describe("receipt evidence rollout", () => {
  test("uses the release operator's exact internal action and counts completed pages", () => {
    const convex = vi.fn()
      .mockReturnValueOnce({ ok: true, value: { checkedCount: 100, isDone: false, continueCursor: "1" } })
      .mockReturnValueOnce({ ok: true, value: { checkedCount: 3, isDone: true, continueCursor: null } });
    expect(runReceiptEvidenceBackfill({ ...limits, convex })).toBe("103 existing receipt references indexed.");
    expect(convex.mock.calls).toEqual([
      [["run", "receiptEvidenceBackfill:runPage", '{"cursor":null}']],
      [["run", "receiptEvidenceBackfill:runPage", '{"cursor":"1"}']],
    ]);
  });

  test.each([undefined, {}, { checkedCount: 0, isDone: false, continueCursor: "1" },
    { checkedCount: 101, isDone: true, continueCursor: null }])("rejects incomplete or invalid page evidence %#", (value) => {
    expect(() => runReceiptEvidenceBackfill({ ...limits, convex: () => ({ ok: true, value }) }))
      .toThrow(/unrecognised result/);
  });

  test("fails at the release deadline and refuses a cursor that stays on the same page", () => {
    const convex = vi.fn(() => ({ ok: true as const, value: { checkedCount: 100, isDone: false, continueCursor: "1" } }));
    expect(() => runReceiptEvidenceBackfill({ ...limits, convex, now: () => 1_000 })).toThrow(/deadline/);
    expect(convex).not.toHaveBeenCalled();
    expect(() => runReceiptEvidenceBackfill({ ...limits, convex })).toThrow(/stopped advancing/);
    expect(convex).toHaveBeenCalledTimes(2);
  });
});
