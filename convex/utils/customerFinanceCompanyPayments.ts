import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isMinorAmount } from "./financingEconomics";

/**
 * SCRUM-766 PR-B: the evidence that the customer paid the finance company
 * directly. Only CONFIRMED rows of the CURRENT agreement count;
 * `recomputeAndPatchEconomics` reads the total from here, so the stored
 * contribution cannot drift from the rows.
 *
 * Bounded: a row is recorded only while fewer than this many exist on a deal
 * (voided rows included - they are history, not deleted), so the one read below
 * is complete by construction.
 */
export const MAX_CUSTOMER_FINANCE_COMPANY_PAYMENT_ROWS = 50;

export async function loadCustomerFinanceCompanyPayments(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  applicationId: Id<"financeApplications">
): Promise<Array<Doc<"customerFinanceCompanyPayments">>> {
  return await ctx.db
    .query("customerFinanceCompanyPayments")
    .withIndex("by_org_application", (q) => q.eq("orgId", orgId).eq("applicationId", applicationId))
    .take(MAX_CUSTOMER_FINANCE_COMPANY_PAYMENT_ROWS + 1);
}

/**
 * Whether a payment was confirmed against the agreement the deal holds NOW. A
 * deal with no agreement has no current rows: whatever is on file was confirmed
 * against one that has since been withdrawn.
 */
export function isCurrentAgreementPayment(
  row: Pick<Doc<"customerFinanceCompanyPayments">, "agreementResolvedAt">,
  app: Pick<Doc<"financeApplications">, "gapResolvedAt">
): boolean {
  return app.gapResolvedAt !== undefined && row.agreementResolvedAt === app.gapResolvedAt;
}

export interface CustomerPaymentEvidence {
  /** Confirmed against the current agreement: the only part that credits the contribution. */
  currentConfirmedMinor: number;
  /** Confirmed against an agreement that has since been withdrawn: on file, credits nothing, blocks closing. */
  priorConfirmedMinor: number;
}

/**
 * The confirmed totals, in the deal's currency, split by agreement. A row that
 * cannot be read as an amount in that currency fails the recompute rather than
 * being skipped: a skipped row would silently under-credit, a guessed one
 * over-credit.
 */
export function customerPaymentEvidenceOf(
  rows: ReadonlyArray<Doc<"customerFinanceCompanyPayments">>,
  app: Pick<Doc<"financeApplications">, "gapResolvedAt">,
  currency: string
): CustomerPaymentEvidence {
  let currentConfirmedMinor = 0;
  let priorConfirmedMinor = 0;
  for (const row of rows) {
    if (row.status !== "CONFIRMED") continue;
    if (!isMinorAmount(row.amountMinor) || row.currency !== currency) {
      throw new ConvexError(
        "A recorded payment from the customer to the finance company on this deal cannot be read in the deal's currency, so its economics cannot be recomputed. An accountant reviews the payment record."
      );
    }
    if (isCurrentAgreementPayment(row, app)) currentConfirmedMinor += row.amountMinor;
    else priorConfirmedMinor += row.amountMinor;
  }
  if (!isMinorAmount(currentConfirmedMinor) || !isMinorAmount(priorConfirmedMinor)) {
    throw new ConvexError(
      "The customer's recorded payments to the finance company on this deal add up to an unreadable amount, so its economics cannot be recomputed. An accountant reviews the payment record."
    );
  }
  return { currentConfirmedMinor, priorConfirmedMinor };
}

/**
 * A transfer reference compared as the bank prints it, not as it was typed:
 * surrounding and repeated spaces and letter case do not make a second transfer.
 */
export function normalizedPaymentReference(reference: string): string {
  return reference.trim().replace(/\s+/g, " ").toUpperCase();
}
