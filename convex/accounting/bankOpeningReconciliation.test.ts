import { expect, test } from "vitest";
import { compareBankStatementDate } from "./bankOpeningReconciliation";

const opening = Date.UTC(2026, 10, 24);

test.each([
  { statement: Date.UTC(2026, 10, 23, 23, 59), cutoff: opening, expected: "UNAVAILABLE" },
  { statement: NaN, cutoff: opening, expected: "UNAVAILABLE" },
  { statement: opening, cutoff: undefined, expected: "UNAVAILABLE" },
  { statement: Date.UTC(2026, 10, 24, 23, 59), cutoff: opening, expected: "SAME_DAY" },
  { statement: Date.UTC(2026, 10, 25), cutoff: opening, expected: "AFTER_OPENING" },
] as const)("classifies the statement day $statement against $cutoff as $expected", ({ statement, cutoff, expected }) => {
  expect(compareBankStatementDate(statement, cutoff)).toBe(expected);
});
