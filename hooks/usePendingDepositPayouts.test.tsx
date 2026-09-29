/**
 * SCRUM-469 R4-01 — an explicit dismissal of a payout that MAY have committed
 * must retire that payout's command identity, or a later "new" payout with the
 * same method and a stale generation replays the earlier one and moves no money.
 */
import { describe, expect, test, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePendingDepositPayouts } from "./usePendingDepositPayouts";

const payout = { resolution: "REFUNDED" as const, method: "CASH", intent: "release-deposit:dep_1:REFUNDED:CASH:gen0" };

describe("usePendingDepositPayouts retirement", () => {
  test("dismiss retires the RECORDED intent, then clears the entry", () => {
    const retire = vi.fn();
    const { result } = renderHook(() => usePendingDepositPayouts(retire));
    act(() => result.current.record("dep_1", payout));

    act(() => result.current.dismiss("dep_1"));

    expect(retire).toHaveBeenCalledTimes(1);
    expect(retire).toHaveBeenCalledWith(payout.intent);
    expect(result.current.check("dep_1", "REFUNDED", "BANK_TRANSFER")).toEqual({ status: "go" });
  });

  test("dismiss of a deposit with nothing recorded retires nothing", () => {
    const retire = vi.fn();
    const { result } = renderHook(() => usePendingDepositPayouts(retire));
    act(() => result.current.dismiss("dep_1"));
    expect(retire).not.toHaveBeenCalled();
  });

  test("confirm does NOT retire (callers retire on success themselves)", () => {
    const retire = vi.fn();
    const { result } = renderHook(() => usePendingDepositPayouts(retire));
    act(() => result.current.record("dep_1", payout));

    act(() => result.current.confirm("dep_1"));

    expect(retire).not.toHaveBeenCalled();
    expect(result.current.check("dep_1", "REFUNDED", "CASH")).toEqual({ status: "go" });
  });

  test("control: an exact retry before dismissal returns the recorded intent and retires nothing", () => {
    const retire = vi.fn();
    const { result } = renderHook(() => usePendingDepositPayouts(retire));
    act(() => result.current.record("dep_1", payout));
    expect(result.current.check("dep_1", "REFUNDED", "CASH")).toEqual({ status: "go", recordedIntent: payout.intent });
    expect(retire).not.toHaveBeenCalled();
  });
});
