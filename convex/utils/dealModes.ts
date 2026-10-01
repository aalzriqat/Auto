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

/** True when `mode` names a deal mode the dealership no longer operates. Absent modes are not retired. */
export function isRetiredDealMode(mode: string | null | undefined): mode is RetiredDealMode {
  return mode != null && (RETIRED_DEAL_MODES as readonly string[]).includes(mode);
}

/** Refuses a retired mode. Call BEFORE the door's first write; never on a path that exits a legacy row (cancel, reject). */
export function assertOperatedDealMode(mode: string | null | undefined): void {
  if (isRetiredDealMode(mode)) throwAppError(AppErrorCode.DEAL_MODE_RETIRED, RETIRED_DEAL_MODE_MESSAGE);
}
