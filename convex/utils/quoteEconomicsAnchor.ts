import type { Doc } from "../_generated/dataModel";
import { pricingSnapshotsEqual } from "./financingEconomics";
import { throwAppError, AppErrorCode } from "./errors";
import { isManualFinanceApplication } from "./manualFinancePayer";

/** SCRUM-528. Must equal `ServerError_QUOTE_ECONOMICS_DRIFTED` (en) in lib/i18n/domains/sales.ts. No figures: it names the way out. */
export const QUOTE_ECONOMICS_DRIFTED_MESSAGE =
  "The quotation's pricing no longer matches the pricing frozen on this finance application, so the deal cannot be finalized. Cancel the finance application and start again from a new quotation.";

type AnchorApp = Pick<
  Doc<"financeApplications">,
  "customerQuotePricingSnapshot" | "companyId" | "quoteModeAtSubmission"
>;
type AnchorQuote = Pick<
  Doc<"quotes">,
  "vehiclePrice" | "downPayment" | "totalFinancedAmount" | "termMonths" | "customerQuotePricingSnapshot"
>;

/**
 * SCRUM-528. Once a finance application exists, the sale `finalizeDeal` builds (price, down payment,
 * loan amount, term) comes only from quote economics that still agree with the economics frozen on
 * the application at `createFromQuote`. Any disagreement refuses, before the first write.
 *
 * - Snapshot present: the quote's top-level figures AND its own snapshot must equal it exactly
 *   (`saveQuote` fills both from the same variables, so strict equality is correct).
 * - Snapshot absent on a deal that finalizes as financed (finance-company mode, a company, or a manual
 *   application): nothing to anchor to, so it fails closed. A cash deal has no finance application
 *   economics and is not compared.
 */
export function assertQuoteEconomicsMatchFrozen(
  app: AnchorApp,
  quote: AnchorQuote,
  mode: string | undefined
): void {
  const snap = app.customerQuotePricingSnapshot;
  if (snap) {
    const agrees =
      quote.vehiclePrice === snap.vehiclePrice &&
      quote.downPayment === snap.downPayment &&
      quote.totalFinancedAmount === snap.totalFinancedAmount &&
      quote.termMonths === snap.termMonths &&
      pricingSnapshotsEqual(snap, quote.customerQuotePricingSnapshot);
    if (!agrees) throwAppError(AppErrorCode.QUOTE_ECONOMICS_DRIFTED, QUOTE_ECONOMICS_DRIFTED_MESSAGE);
    return;
  }
  const financed =
    mode === "CONFIGURED_FINANCE_COMPANY" ||
    mode === "MANUAL_FINANCE_COMPANY" ||
    !!app.companyId ||
    isManualFinanceApplication(app);
  if (financed) throwAppError(AppErrorCode.QUOTE_ECONOMICS_DRIFTED, QUOTE_ECONOMICS_DRIFTED_MESSAGE);
}
