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
const PLACEHOLDER_NAMES = new Set([
  "other finance option", "other", "others", "n/a", "na", "none", "unknown", "manual", "-",
  // WEB: the manual-quote wizard sends the translated "OtherFinanceOption" label
  // (lib/i18n/domains/sales.ts: "Others" / "أخرى"), so the Arabic UI's
  // placeholder is an equally invented name.
  "أخرى", "خيار تمويل آخر",
  // MOBILE: the sales wizard saves these as `manualProviderName`
  // (apps/mobile/src/features/workspace/salesWizard/SalesWizardScreen.tsx:
  // "Other provider" / "جهة أخرى"), and shows the "(manual)" display variants.
  "other provider", "جهة أخرى", "others (manual)", "جهة أخرى (يدوي)",
]);

export const MANUAL_PAYER_NAME_MAX_LENGTH = 120;

/** OR-12: a manual company's shortfall is never routed to the company. One message, two enforcement points. */
export const MANUAL_GAP_TO_FINANCIER_REFUSAL =
  "On a manual finance company deal the shortfall is settled with the dealership only: the customer pays it to the dealership, or the dealership absorbs it. It cannot be assigned to the finance company.";

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

/**
 * SCRUM-27 R1: the letter, G, the MANUAL basis and the derived gap are ONE unit.
 * True only when all four are present together and G equals the letter's amount.
 */
export function isManualLetterUnitIntact(
  app: Pick<
    Doc<"financeApplications">,
    "manualApproval" | "approvedPurchaseBasis" | "approvedDealerPurchaseAmountMinor" | "rawAppraisalGapMinor"
  >
): boolean {
  return (
    app.manualApproval !== undefined &&
    app.approvedPurchaseBasis === "MANUAL" &&
    app.approvedDealerPurchaseAmountMinor === app.manualApproval.approvedAmountMinor &&
    app.rawAppraisalGapMinor !== undefined
  );
}

/**
 * The manual finance company's name as every reader shows it: the letter's name
 * once the manager has entered it (the only payer identity from then on), the
 * quote-time provider label only before that. SCRUM-27.
 */
export function manualPayerLabel(
  app: Pick<
    Doc<"financeApplications">,
    "companyId" | "quoteModeAtSubmission" | "manualApproval" | "manualFinanceSnapshot"
  >
): string | undefined {
  return manualPayerOf(app)?.name ?? app.manualFinanceSnapshot?.providerName;
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
