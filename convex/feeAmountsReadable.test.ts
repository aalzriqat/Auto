import { describe, expect, test } from "vitest";
import type { Doc } from "./_generated/dataModel";
import { summarizeFees, unreadableFeeAmounts } from "./financeDealCosts";

/**
 * The readable-total contract on a deal's cost lines.
 *
 * `summarizeFees` accumulates unchecked and `v.number()` admits NaN, Infinity,
 * fractions, negatives and unsafe integers, so a legacy or raw-edited line
 * turns every total into a non-figure that still looks like a number. The
 * contract is that a publisher reads `amountsUnreadable` (or calls
 * `unreadableFeeAmounts` on the raw rows) and serves `null` with the reason.
 */
let seq = 0;
function fee(overrides: Partial<Doc<"financeDealFees">>): Doc<"financeDealFees"> {
  seq += 1;
  return {
    _id: `fee${seq}` as Doc<"financeDealFees">["_id"],
    _creationTime: seq,
    orgId: "org1" as Doc<"financeDealFees">["orgId"],
    applicationId: "app1" as Doc<"financeDealFees">["applicationId"],
    feeType: "OTHER_CLOSING_EXPENSE",
    currency: "JOD",
    paidBy: "DEALER",
    paidTo: "OTHER",
    accountingTreatment: "SELLING_EXPENSE",
    includedInQuotation: false,
    deductedFromSettlement: false,
    refundable: false,
    source: "MANUAL",
    createdBy: "u1" as Doc<"financeDealFees">["createdBy"],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as Doc<"financeDealFees">;
}

const CORRUPT: Array<[string, number]> = [
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["a fraction of a fils", 90_000.5],
  ["a negative amount", -90_000],
  ["an unsafe integer", Number.MAX_SAFE_INTEGER + 2],
];

describe("unreadableFeeAmounts", () => {
  test("valid lines, with and without actuals, are readable", () => {
    expect(
      unreadableFeeAmounts([
        fee({ actualAmountMinor: 90_000, reconciledAt: 5 }),
        fee({ estimatedAmountMinor: 250_000 }),
        fee({}),
        fee({ actualAmountMinor: 0 }),
      ])
    ).toBeNull();
  });

  test.each(CORRUPT)("a live line whose ACTUAL is %s makes the totals unreadable", (_label, amount) => {
    expect(unreadableFeeAmounts([fee({ actualAmountMinor: 90_000 }), fee({ actualAmountMinor: amount })])).toBe("UNSAFE_AMOUNT");
  });

  test.each(CORRUPT)("a live line whose ESTIMATE is %s makes the totals unreadable", (_label, amount) => {
    expect(unreadableFeeAmounts([fee({ estimatedAmountMinor: amount })])).toBe("UNSAFE_AMOUNT");
  });

  test("a VOIDED corrupt line is not live and does not withhold the totals", () => {
    expect(unreadableFeeAmounts([fee({ actualAmountMinor: Number.NaN, voidedAt: 9 }), fee({ actualAmountMinor: 1 })])).toBeNull();
  });

  test("safe operands that overflow between them are unreadable — on the actual side and on the estimate side", () => {
    const nearMax = Number.MAX_SAFE_INTEGER - 1;
    expect(unreadableFeeAmounts([fee({ actualAmountMinor: nearMax }), fee({ actualAmountMinor: 2 })])).toBe("UNSAFE_AMOUNT");
    expect(unreadableFeeAmounts([fee({ estimatedAmountMinor: nearMax }), fee({ estimatedAmountMinor: 2 })])).toBe("UNSAFE_AMOUNT");
    expect(unreadableFeeAmounts([fee({ actualAmountMinor: nearMax }), fee({ actualAmountMinor: 1 })])).toBeNull();
  });
});

describe("summarizeFees carries the contract", () => {
  test("a readable set reports null and stays fully reconciled when every line is checked", () => {
    const s = summarizeFees([fee({ actualAmountMinor: 90_000, reconciledAt: 5 })]);
    expect(s.amountsUnreadable).toBeNull();
    expect(s.actualTotalMinor).toBe(90_000);
    expect(s.fullyReconciled).toBe(true);
  });

  test("a NaN actual names the reason, and a corrupt line is never called reconciled", () => {
    const s = summarizeFees([
      fee({ actualAmountMinor: 90_000, reconciledAt: 5 }),
      fee({ actualAmountMinor: Number.NaN, reconciledAt: 5 }),
    ]);
    expect(s.amountsUnreadable).toBe("UNSAFE_AMOUNT");
    // The unchecked accumulation is exactly why the flag exists.
    expect(Number.isNaN(s.actualTotalMinor)).toBe(true);
    expect(s.fullyReconciled).toBe(false);
  });
});
