import type { WizardData } from "./types";

/**
 * The finance state a profit-approval request carried when it was submitted.
 *
 * Mirrors `wizardSnapshotValidator` in `convex/approvals.ts`. Every field is
 * optional because the snapshot is only fully populated once the salesperson
 * has opened the finance panel.
 */
export interface ApprovalWizardSnapshot {
  paymentType?: string;
  vehiclePrice?: number;
  desiredProfit?: number;
  downPayment?: number;
  termMonths?: number;
  selectedCompanyId?: string;
  manualProfitRate?: number;
  manualInsuranceRate?: number;
  manualExecutionCommission?: number;
  manualExecutionFees?: number;
  manualIncludesCommissionInDebt?: boolean;
}

/**
 * Rebuilds the wizard's starting state from an approved profit request.
 *
 * Every field the snapshot carries has to be restored, not just the headline
 * figures. `Step1QuoteSetup` seeds its own state from this object with
 * defaulting initialisers — `initialData.manualProfitRate || 0`,
 * `initialData.manualIncludesCommissionInDebt ?? true` — so a field left out
 * here is not merely absent, it is silently reset to a default. Dropping the
 * five manual finance overrides meant a salesperson resumed an approved deal
 * whose profit recomputed to something other than the figure the manager had
 * actually approved, with nothing on screen to indicate it had changed.
 *
 * Kept as a pure function, separate from the page, so that correspondence can
 * be tested without mounting the wizard.
 */
export function buildInitialDraftFromApproval(
  vehicleId: string,
  snapshot: ApprovalWizardSnapshot,
): Partial<WizardData> {
  return {
    vehicleId,
    vehiclePrice: snapshot.vehiclePrice,
    desiredProfit: snapshot.desiredProfit,
    downPayment: snapshot.downPayment,
    termMonths: snapshot.termMonths,
    selectedCompanyId: snapshot.selectedCompanyId,
    manualProfitRate: snapshot.manualProfitRate,
    manualInsuranceRate: snapshot.manualInsuranceRate,
    manualExecutionCommission: snapshot.manualExecutionCommission,
    manualExecutionFees: snapshot.manualExecutionFees,
    manualIncludesCommissionInDebt: snapshot.manualIncludesCommissionInDebt,
  };
}

/**
 * The snapshot fields that describe restorable wizard state.
 *
 * `paymentType` is excluded deliberately: it selects which wizard opens rather
 * than seeding a field inside it. The test asserts this list against
 * `buildInitialDraftFromApproval`'s output so that adding a field to the
 * snapshot without restoring it fails a test instead of silently losing data
 * on resume — which is exactly how the original five went missing.
 */
export const RESTORABLE_SNAPSHOT_FIELDS: readonly (keyof ApprovalWizardSnapshot)[] = [
  "vehiclePrice",
  "desiredProfit",
  "downPayment",
  "termMonths",
  "selectedCompanyId",
  "manualProfitRate",
  "manualInsuranceRate",
  "manualExecutionCommission",
  "manualExecutionFees",
  "manualIncludesCommissionInDebt",
];
