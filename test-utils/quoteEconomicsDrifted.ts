import { QUOTE_ECONOMICS_DRIFTED_MESSAGE } from "../convex/utils/quoteEconomicsAnchor";
import { expectAppError } from "./expectAppError";

/** SCRUM-528: `attempt` was refused because the quote's economics no longer match the application's frozen snapshot. */
export const expectQuoteEconomicsDrifted = (attempt: Promise<unknown>): Promise<void> =>
  expectAppError(attempt, "QUOTE_ECONOMICS_DRIFTED", QUOTE_ECONOMICS_DRIFTED_MESSAGE);
