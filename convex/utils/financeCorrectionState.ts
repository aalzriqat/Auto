import type { Doc } from "../_generated/dataModel";
import { AppErrorCode, throwAppError } from "./errors";
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
): void {
  if (expected !== undefined && expected !== economicsStamp(app)) {
    throwAppError(AppErrorCode.DEAL_CORRECTION_STALE, "This deal changed since you opened the correction. Review the current details and try again.");
  }
}
