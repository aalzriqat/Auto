import { RETIRED_DEAL_MODE_MESSAGE } from "../convex/utils/dealModes";
import { expectAppError } from "./expectAppError";

/** SCRUM-495: `attempt` was refused as a retired deal mode (code and exact message). */
export const expectRetiredDealMode = (attempt: Promise<unknown>): Promise<void> =>
  expectAppError(attempt, "DEAL_MODE_RETIRED", RETIRED_DEAL_MODE_MESSAGE);
