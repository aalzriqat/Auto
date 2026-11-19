import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { economicsStamp } from "./financingEconomics";

export function financeCorrectionClosed(
  app: Pick<Doc<"financeApplications">, "status" | "finalizedSaleId">,
): boolean {
  return app.finalizedSaleId !== undefined ||
    app.status === "CLOSED" || app.status === "CANCELLED" || app.status === "REJECTED";
}

export function assertExpectedEconomicsStamp(
  app: Pick<Doc<"financeApplications">, "economicsRevision">,
  expected: string | undefined,
  required = false,
): void {
  if ((required || expected !== undefined) && expected !== economicsStamp(app)) {
    throwStaleDealCorrection("This deal changed since you opened the correction. Review the current details and try again.");
  }
}

export function throwStaleDealCorrection(message: string): never {
  throw new ConvexError({ code: "DEAL_CORRECTION_STALE", message });
}
