import { FINANCED_SALE_REQUIRES_DEAL_MESSAGE } from "../convex/utils/dealModes";
import { expectAppError } from "./expectAppError";

/** SCRUM-504: `attempt` was refused because a FINANCED sale was named without the Deal's application. */
export const expectFinancedSaleRequiresDeal = (attempt: Promise<unknown>): Promise<void> =>
  expectAppError(attempt, "FINANCED_SALE_REQUIRES_DEAL", FINANCED_SALE_REQUIRES_DEAL_MESSAGE);
