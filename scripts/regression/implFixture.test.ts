import { expect, test } from "vitest";

// Executable check that scenarioRecord.test.ts points its fixture records at.
const fixtureSubject = (n: number) => n + n;

test("fixture check runs", () => {
  expect(fixtureSubject(1)).toBe(2);
});
