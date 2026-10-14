import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isMinorAmount } from "./financingEconomics";

/**
 * SCRUM-766 PR-B: the evidence that the customer paid the finance company
 * directly. Only CONFIRMED rows count; `recomputeAndPatchEconomics` reads the
 * total from here, so the stored contribution cannot drift from the rows.
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
 * The confirmed total, in the deal's currency. A row that cannot be read as an
 * amount in that currency fails the recompute rather than being skipped: a
 * skipped row would silently under-credit, a guessed one over-credit.
 */
export function confirmedCustomerPaymentTotalMinor(
  rows: ReadonlyArray<Doc<"customerFinanceCompanyPayments">>,
  currency: string
): number {
  let total = 0;
  for (const row of rows) {
    if (row.status !== "CONFIRMED") continue;
    if (!isMinorAmount(row.amountMinor) || row.currency !== currency) {
      throw new ConvexError(
        "A recorded payment from the customer to the finance company on this deal cannot be read in the deal's currency, so its economics cannot be recomputed. An accountant reviews the payment record."
      );
    }
    total += row.amountMinor;
  }
  if (!isMinorAmount(total)) {
    throw new ConvexError(
      "The customer's recorded payments to the finance company on this deal add up to an unreadable amount, so its economics cannot be recomputed. An accountant reviews the payment record."
    );
  }
  return total;
}
