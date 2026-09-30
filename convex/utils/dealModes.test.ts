import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import {
  RETIRED_DEAL_MODES,
  RETIRED_DEAL_MODE_MESSAGE,
  assertOperatedDealMode,
  isRetiredDealMode,
} from "./dealModes";

describe("dealModes (SCRUM-495)", () => {
  test("the retired set is exactly LEASE and INTERNAL_INSTALLMENT", () => {
    expect([...RETIRED_DEAL_MODES].sort()).toEqual(["INTERNAL_INSTALLMENT", "LEASE"]);
  });

  test("the message is the one every door states", () => {
    expect(RETIRED_DEAL_MODE_MESSAGE).toBe(
      "Lease and in-house instalment deals are no longer offered. Choose cash or a finance company."
    );
  });

  test.each(["LEASE", "INTERNAL_INSTALLMENT"])("%s is refused with a ConvexError carrying the message", (mode) => {
    expect(isRetiredDealMode(mode)).toBe(true);
    try {
      assertOperatedDealMode(mode);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ConvexError);
      expect((error as ConvexError<string>).data).toBe(RETIRED_DEAL_MODE_MESSAGE);
    }
  });

  test.each(["CASH", "CONFIGURED_FINANCE_COMPANY", "MANUAL_FINANCE_COMPANY", "FINANCED", undefined, null])(
    "%s passes",
    (mode) => {
      expect(isRetiredDealMode(mode)).toBe(false);
      expect(() => assertOperatedDealMode(mode)).not.toThrow();
    }
  );
});
