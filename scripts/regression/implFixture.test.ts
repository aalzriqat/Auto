import { expect, test } from "vitest";

// Executable check that scenarioRecord.test.ts points its fixture records at.
test("fixture check runs", () => {
  expect(1 + 1).toBe(2);
});
