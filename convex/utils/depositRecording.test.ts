import { describe, expect, test } from "vitest";
import { displayableDepositReference } from "./depositRecording";

// SCRUM-629 F-23: the customer tile showed "Deposit <record id>" as if it were a
// receipt number. The stored reference stays (deposits.ts matches on it); the
// screen is never handed it.
describe("displayableDepositReference", () => {
  test("the machine key a recorded deposit carries is never displayed", () => {
    expect(displayableDepositReference("Deposit k57a9x2m3qv8r1t0bz4n6c")).toBeUndefined();
  });

  test("a reference a person wrote is displayed unchanged", () => {
    expect(displayableDepositReference("REC-1042")).toBe("REC-1042");
    expect(displayableDepositReference("Deposit slip 17 / cash")).toBe("Deposit slip 17 / cash");
  });

  test("no reference stays no reference", () => {
    expect(displayableDepositReference(undefined)).toBeUndefined();
  });
});
