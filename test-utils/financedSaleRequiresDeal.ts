import { expect } from "vitest";
import { FINANCED_SALE_REQUIRES_DEAL_MESSAGE } from "../convex/utils/dealModes";

/**
 * SCRUM-504: asserts that `attempt` was refused because a FINANCED sale was named without the
 * Deal's finance application: BOTH the structured code and the exact message. Fails when the
 * call resolves, so a refusal can never be an accident of a passing call.
 */
export async function expectFinancedSaleRequiresDeal(attempt: Promise<unknown>): Promise<void> {
  const error = await attempt.then(
    () => {
      throw new Error("expected a FINANCED_SALE_REQUIRES_DEAL refusal but the call resolved");
    },
    (caught: unknown) => caught as { data?: { code?: string; message?: string } }
  );
  expect(error?.data?.code).toBe("FINANCED_SALE_REQUIRES_DEAL");
  expect(error?.data?.message).toBe(FINANCED_SALE_REQUIRES_DEAL_MESSAGE);
}
