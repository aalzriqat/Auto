/**
 * SCRUM-57 — the CALLER half of the invariant.
 *
 * The server refusing an unidentified economic command is only half the job.
 * If the client mints a fresh identity on every attempt, every retry is a new
 * command and the server's deduplication never fires — types stay green while
 * money still moves twice. These tests pin the lifecycle that makes the
 * server-side guarantee mean something.
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { useCommandIdentity } from "./useCommandIdentity";

describe("useCommandIdentity", () => {
  test("the same intent yields the SAME identity across retries", () => {
    const { result } = renderHook(() => useCommandIdentity());
    const first = result.current.for("pay-commission:sale_1");
    const retry = result.current.for("pay-commission:sale_1");
    expect(retry).toBe(first);
  });

  test("a rerender does NOT regenerate the identity mid-intent", () => {
    const { result, rerender } = renderHook(() => useCommandIdentity());
    const first = result.current.for("pay-commission:sale_1");
    rerender();
    rerender();
    expect(result.current.for("pay-commission:sale_1")).toBe(first);
  });

  test("a FAILED attempt keeps its identity, so the retry is the same command", () => {
    const { result } = renderHook(() => useCommandIdentity());
    const intent = "clear-cheque:chq_1";
    const attempt1 = result.current.for(intent);
    // Simulated failure: nothing is retired, exactly as the callers do.
    const attempt2 = result.current.for(intent);
    expect(attempt2).toBe(attempt1);
  });

  test("after success the identity is retired, so a NEW intent gets a NEW identity", () => {
    const { result } = renderHook(() => useCommandIdentity());
    const intent = "release-deposit:dep_1:REFUNDED";

    const firstPayout = result.current.for(intent);
    act(() => result.current.retire(intent));
    const secondPayout = result.current.for(intent);

    // The VehicleDetailsDialog incident in reverse: two genuine payouts that
    // are identical in every recorded fact must NOT share a command identity.
    expect(secondPayout).not.toBe(firstPayout);
  });

  /**
   * The regression test for the stale-identity defect found in review and
   * reproduced against `deposits.release`.
   *
   * `deposits.release` pays whatever is FREE on the row, so two genuine payouts
   * of the same deposit with the same resolution are byte-identical requests
   * and the server's fingerprint cannot separate them. If the first response is
   * lost, `retire` never runs — and a HELD identity would then hand the next
   * genuine payout the first one's stored result: no money moved, success
   * reported. `renew` is what makes each user-initiated attempt its own command.
   */
  test("renew mints a new identity even when the previous one was never retired", () => {
    const { result } = renderHook(() => useCommandIdentity());
    const intent = "release-deposit:dep_1:REFUNDED";

    const lostAttempt = result.current.renew(intent);
    // No retire() — this is the lost-response case, the whole point.
    const nextGenuinePayout = result.current.renew(intent);

    expect(nextGenuinePayout).not.toBe(lostAttempt);
  });

  test("renew replaces the held identity rather than leaving a stale one behind", () => {
    const { result } = renderHook(() => useCommandIdentity());
    const intent = "release-deposit:dep_1:REFUNDED";

    result.current.for(intent);
    const renewed = result.current.renew(intent);
    // A subsequent read within the SAME attempt must see the renewed identity,
    // so a transport-level retry of that attempt is still one command.
    expect(result.current.for(intent)).toBe(renewed);
  });

  test("different intents never share an identity", () => {
    const { result } = renderHook(() => useCommandIdentity());
    const a = result.current.for("clear-cheque:chq_1");
    const b = result.current.for("clear-cheque:chq_2");
    expect(a).not.toBe(b);
  });

  test("the identity carries its intent, so a stored command is traceable", () => {
    const { result } = renderHook(() => useCommandIdentity());
    expect(result.current.for("clear-cheque:chq_9")).toMatch(/^clear-cheque:chq_9:/);
  });

  test("retiring one intent does not disturb another in flight", () => {
    const { result } = renderHook(() => useCommandIdentity());
    const held = result.current.for("intent-a");
    act(() => result.current.retire("intent-b"));
    expect(result.current.for("intent-a")).toBe(held);
  });
});
