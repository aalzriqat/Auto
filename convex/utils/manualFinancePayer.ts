import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";

/**
 * SCRUM-27 - the ONE place that says who a MANUAL finance company is.
 *
 * A manual finance company has no party row: the manager types its name off the
 * approval letter. So its identity is the NAME, frozen on the application
 * (`manualApproval.financierName`) and copied - never re-derived - onto every
 * surface a configured company's id would appear on (receivable, journal lines,
 * canonical payment, forward rows, reports).
 *
 * "Manual" is a fact about the application, decided here and nowhere else:
 * no configured company on it, and it was submitted in MANUAL_FINANCE_COMPANY
 * mode. Callers must not re-derive it from `companyId` alone - an application
 * with no `companyId` is also a cash, lease or instalment deal.
 */
export type ManualFinanceApplicationShape = Pick<
  Doc<"financeApplications">,
  "companyId" | "quoteModeAtSubmission" | "manualApproval"
>;

/** The names the wizard invents when the operator types none. Never a real company. */
const PLACEHOLDER_NAMES = new Set(["other finance option", "other", "n/a", "na", "none", "unknown", "manual", "-"]);

export const MANUAL_PAYER_NAME_MAX_LENGTH = 120;

/** Is this application financed by a MANUAL finance company (whatever has or has not been entered yet)? */
export function isManualFinanceApplication(app: Pick<ManualFinanceApplicationShape, "companyId" | "quoteModeAtSubmission">): boolean {
  return app.companyId === undefined && app.quoteModeAtSubmission === "MANUAL_FINANCE_COMPANY";
}

/**
 * The payer of a manual application whose letter has been entered, or null when
 * the application is not manual or nothing has been entered. A null here is
 * "not known yet" and must never be read as "no payer".
 */
export function manualPayerOf(app: ManualFinanceApplicationShape): { name: string } | null {
  if (!isManualFinanceApplication(app)) return null;
  const name = app.manualApproval?.financierName;
  if (name === undefined) return null;
  return { name };
}

/** Trimmed, exactly as typed otherwise. Refuses blank and placeholder names before anything is written. */
export function normalizeManualPayerName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) {
    throw new ConvexError("Enter the finance company's name exactly as it appears on its approval letter.");
  }
  if (name.length > MANUAL_PAYER_NAME_MAX_LENGTH) {
    throw new ConvexError(`The finance company's name must be at most ${MANUAL_PAYER_NAME_MAX_LENGTH} characters.`);
  }
  if (PLACEHOLDER_NAMES.has(name.toLowerCase())) {
    throw new ConvexError("Enter the finance company's real name as it appears on its approval letter, not a placeholder.");
  }
  return name;
}
