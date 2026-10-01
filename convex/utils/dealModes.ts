import { throwAppError, AppErrorCode } from "./errors";
import type { DealMode } from "./financedSaleRecognition";

/**
 * SCRUM-495 (OR-6 / OR-7): LEASE and INTERNAL_INSTALLMENT are no longer offered. Schema and readers keep
 * both, so a legacy row still renders; every door that would create or finalize one refuses here, once.
 */
export const RETIRED_DEAL_MODES = ["LEASE", "INTERNAL_INSTALLMENT"] as const satisfies readonly DealMode[];

export type RetiredDealMode = (typeof RETIRED_DEAL_MODES)[number];

export const RETIRED_DEAL_MODE_MESSAGE =
  "Lease and in-house instalment deals are no longer offered. Choose cash or a finance company.";

/** SCRUM-504. Must equal `ServerError_FINANCED_SALE_REQUIRES_DEAL` (en) in lib/i18n/domains/sales.ts. */
export const FINANCED_SALE_REQUIRES_DEAL_MESSAGE =
  "A financed sale can only be created through the deal, with its finance application. Start the deal from the quote instead of recording a financed sale directly.";

/**
 * SCRUM-504: a FINANCED sale exists only through the Deal (`applications.finalizeDeal`), which
 * always carries the finance application. Every sale-creating door refuses a FINANCED type with
 * no application, so no printed document can state financing the customer's quote never priced.
 * Call inside the idempotent run, never on a path that exits a legacy row (cancel, delete, or
 * a change to CASH).
 */
export function assertFinancedSaleHasDeal(
  financingType: string | null | undefined,
  applicationId: unknown
): void {
  if (financingType === "FINANCED" && !applicationId) {
    throwAppError(AppErrorCode.FINANCED_SALE_REQUIRES_DEAL, FINANCED_SALE_REQUIRES_DEAL_MESSAGE);
  }
}

/** True when `mode` names a deal mode the dealership no longer operates. Absent modes are not retired. */
export function isRetiredDealMode(mode: string | null | undefined): mode is RetiredDealMode {
  return mode != null && (RETIRED_DEAL_MODES as readonly string[]).includes(mode);
}

/** Refuses a retired mode. Call BEFORE the door's first write; never on a path that exits a legacy row (cancel, reject). */
export function assertOperatedDealMode(mode: string | null | undefined): void {
  if (isRetiredDealMode(mode)) throwAppError(AppErrorCode.DEAL_MODE_RETIRED, RETIRED_DEAL_MODE_MESSAGE);
}
