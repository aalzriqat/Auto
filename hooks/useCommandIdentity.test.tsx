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
   * SCRUM-313 — the GENERATION-AWARE identity for `deposits.release`, and the
   * reason `renew()` no longer exists.
   *
   * This command pays out whatever is currently FREE on the row, so two genuine
   * payouts of the same deposit with the same decision are byte-identical
   * requests: content cannot separate them. Both naive answers are wrong.
   * A permanently-held key makes the second genuine payout replay the first's
   * stored result (money not moved, success reported). A per-attempt key
   * (`renew`) fixes that by surrendering retry safety entirely.
   *
   * The server keeps an authoritative monotonic discriminator — `releaseCount`,
   * bumped inside the same patch that moves the money — so the GENERATION goes
   * into the intent and `for()` does the rest.
   */
  const releaseIntent = (depositId: string, resolution: string, method: string, generation: number) =>
    `release-deposit:${depositId}:${resolution}:${method}:gen${generation}`;

  test("a lost response inside ONE generation reuses the identity — the retry is one command", () => {
    const { result } = renderHook(() => useCommandIdentity());
    const intent = releaseIntent("dep_1", "REFUNDED", "CASH", 0);

    const lostAttempt = result.current.for(intent);
    // No retire() — the response never came back. This is the whole case.
    const retry = result.current.for(intent);

    expect(retry).toBe(lostAttempt);
  });

  test("an ADVANCED generation is a different intent, so a second genuine payout is a new command", () => {
    const { result } = renderHook(() => useCommandIdentity());

    // The free part today...
    const firstPayout = result.current.for(releaseIntent("dep_1", "REFUNDED", "CASH", 0));
    // ...and the rest once the car it was held against falls away. The server
    // has advanced releaseCount to 1, so the client observes a new generation.
    const secondPayout = result.current.for(releaseIntent("dep_1", "REFUNDED", "CASH", 1));

    expect(secondPayout).not.toBe(firstPayout);
  });

  test("a STALE generation still cannot suppress a genuine payout after a success", () => {
    // The failure mode a generation alone would NOT close. The payout succeeded
    // and the key was retired, but the client's `releaseCount` query has not yet
    // caught up, so the operator's next genuine payout computes the SAME intent
    // string. It must still be a new command — which it is, because `for()`
    // mints afresh once the slot is retired. Generation handles the LOST
    // response; retire-on-success handles the stale read. Neither alone is
    // enough, which is why both are in the mechanism.
    const { result } = renderHook(() => useCommandIdentity());
    const staleIntent = releaseIntent("dep_1", "REFUNDED", "CASH", 0);

    const firstPayout = result.current.for(staleIntent);
    act(() => result.current.retire(staleIntent));
    const secondPayout = result.current.for(staleIntent);

    expect(secondPayout).not.toBe(firstPayout);
  });

  test("the refund METHOD is part of the identity — a changed decision is a new command", () => {
    const { result } = renderHook(() => useCommandIdentity());
    const toCash = result.current.for(releaseIntent("dep_1", "REFUNDED", "CASH", 0));
    const toBank = result.current.for(releaseIntent("dep_1", "REFUNDED", "BANK_TRANSFER", 0));
    // Reusing one key here would put the same key on genuinely different
    // content, which the server refuses outright — a rejection the operator
    // cannot clear rather than a duplicate payment, but still a defect.
    expect(toBank).not.toBe(toCash);
  });

  test("there is NO per-attempt mint on the identity API", () => {
    const { result } = renderHook(() => useCommandIdentity());
    // `renew` was removed rather than left unused: an available per-attempt mint
    // is an invitation, and it wore the same shape as the safe `for()` at the
    // call site — which is exactly how the client-lifetime ratchet came to
    // report zero per-attempt callers while every release caller was one.
    expect((result.current as Record<string, unknown>).renew).toBeUndefined();
    expect(Object.keys(result.current).sort((a, b) => a.localeCompare(b))).toEqual([
      "for",
      "retire",
    ]);
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
