/**
 * SCRUM-998 #17: ONE place returns the deposit split of the payment to the finance company, so the two readers
 * (the pre-sale status and the cockpit) cannot disagree about E. Held deposit H = forwarded (H - E) + kept (E).
 * Evidence boundary: pure function, no database.
 */
import { describe, expect, test } from "vitest";
import { forwardDepositSplit, forwardPaymentFigures } from "./forwardPaymentFigures";

describe("forwardDepositSplit", () => {
  test("held deposit is forwarded plus excess (hand-worked: 1,500,000 + 240,000 = 1,740,000)", () => {
    expect(forwardDepositSplit({ forwardDepositMinor: 1_500_000, approvalExcessMinor: 240_000 })).toEqual({
      heldDepositMinor: 1_740_000,
      depositForwardedMinor: 1_500_000,
      approvalExcessMinor: 240_000,
    });
  });

  test("no excess: E is 0 and held equals forwarded", () => {
    expect(forwardDepositSplit({ forwardDepositMinor: 200_000 })).toEqual({
      heldDepositMinor: 200_000,
      depositForwardedMinor: 200_000,
      approvalExcessMinor: 0,
    });
  });

  test("a held deposit the plan reports that differs from forwarded + E is refused, never shown", () => {
    expect(() =>
      forwardDepositSplit({ forwardDepositMinor: 1_500_000, approvalExcessMinor: 240_000, expectedHeldMinor: 1_700_000 }),
    ).toThrow(/held deposit/i);
  });

  test("the pre-sale figures are built from the same split and assert the plan's own H", () => {
    const plan = {
      forwardDueMinor: 1_500_000,
      forwardDepositMinor: 1_500_000,
      forwardContributionMinor: 0,
      approvalExcessMinor: 240_000,
      depositLiabilityAppliedMinor: 1_740_000,
    };
    expect(forwardPaymentFigures(plan, 0)).toEqual({
      dueMinor: 1_500_000,
      depositMinor: 1_500_000,
      approvalExcessMinor: 240_000,
      contributionMinor: 0,
      onBooksMinor: 0,
    });
    expect(() => forwardPaymentFigures({ ...plan, depositLiabilityAppliedMinor: 1_000_000 }, 0)).toThrow(/held deposit/i);
  });
});
