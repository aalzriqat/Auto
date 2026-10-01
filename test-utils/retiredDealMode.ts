import { expect } from "vitest";
import { RETIRED_DEAL_MODE_MESSAGE } from "../convex/utils/dealModes";

/**
 * SCRUM-495: asserts that `attempt` was refused as a retired deal mode: BOTH the structured
 * code and the exact message (a clean `toThrow(message)` would still pass on a different code).
 * Fails when the call resolves, so a refusal can never be an accident of a passing call.
 */
export async function expectRetiredDealMode(attempt: Promise<unknown>): Promise<void> {
  const error = await attempt.then(
    () => {
      throw new Error("expected a DEAL_MODE_RETIRED refusal but the call resolved");
    },
    (caught: unknown) => caught as { data?: { code?: string; message?: string } }
  );
  expect(error?.data?.code).toBe("DEAL_MODE_RETIRED");
  expect(error?.data?.message).toBe(RETIRED_DEAL_MODE_MESSAGE);
}
