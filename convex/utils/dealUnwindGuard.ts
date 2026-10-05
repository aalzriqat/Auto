import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { AppErrorCode, throwAppError } from "./errors";
import { DEAL_UNWIND_MESSAGES } from "./dealUnwindMessages";
import { chequesForApplication, isFcLineage } from "./fcCheque";
import { disbursementVersionOf, financeDisbursementKeys } from "./financeDisbursementKeys";

/**
 * SCRUM-693: while a deal is being unwound, no other command may move its
 * money around the unwind — re-disburse, re-forward, re-register the expected
 * payment, pay the commission, reopen custody or cancel the deal. Each such
 * command calls `assertNoActiveDealUnwind` before it writes anything.
 *
 * Kept apart from `dealUnwind.ts` so the guarded modules (applications,
 * financeCompanyForward, payroll, sales, collections) can import it without an
 * import cycle through the unwind commands.
 */

export async function activeDealUnwindFor(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  applicationId: Id<"financeApplications">
): Promise<Doc<"dealUnwinds"> | null> {
  return await ctx.db
    .query("dealUnwinds")
    .withIndex("by_org_application_status", (q) =>
      q.eq("orgId", orgId).eq("applicationId", applicationId).eq("status", "ACTIVE")
    )
    .first();
}

export async function assertNoActiveDealUnwind(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  applicationId: Id<"financeApplications">
): Promise<void> {
  if ((await activeDealUnwindFor(ctx, orgId, applicationId)) !== null) {
    throwAppError(AppErrorCode.DEAL_UNWIND_ACTIVE, DEAL_UNWIND_MESSAGES.DEAL_UNWIND_ACTIVE);
  }
}

export type PaidDealReversalRoute =
  | { route: "UNWIND"; method: "BANK_TRANSFER" | "CASH" }
  | { route: "CHEQUE" }
  | { route: "CHAIN_MISMATCH" }
  | { route: "INELIGIBLE" };

/**
 * SCRUM-693-F2: which reversal a paid deal's receipt goes through. Only a
 * SETTLED bank-transfer or cash receipt, on a deal with no finance-company
 * cheque, is unwound from the deal page. A cheque deal reverses through the
 * returned-cheque path, and a deal whose records disagree through a manual
 * correction. Start and a bare cancel both ask this, so they cannot drift.
 */
export async function paidDealReversalRoute(
  ctx: QueryCtx,
  app: Doc<"financeApplications">
): Promise<PaidDealReversalRoute> {
  const cheques = await chequesForApplication(ctx, app._id);
  if (
    app.expectedPaymentMethod === "CHEQUE" ||
    cheques.some(
      (row) => isFcLineage(row) && (row.status === "HELD" || row.status === "DEPOSITED" || row.status === "CLEARED")
    )
  ) {
    return { route: "CHEQUE" };
  }
  // The method of record is the one the receipt was posted with: the
  // canonical payment and the FINANCE_CASH_RECEIVED journal are fed by one
  // value (confirmDisbursement, SCRUM-599).
  const payment = await ctx.db
    .query("canonicalPayments")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", app.orgId).eq("idempotencyKey", financeDisbursementKeys(app._id, disbursementVersionOf(app)).paymentKey)
    )
    .unique();
  if (!payment || payment.status !== "SETTLED") return { route: "CHAIN_MISMATCH" };
  if (payment.method === "CHEQUE") return { route: "CHEQUE" };
  if (payment.method !== "BANK_TRANSFER" && payment.method !== "CASH") return { route: "INELIGIBLE" };
  return { route: "UNWIND", method: payment.method };
}

/** D1: commission collection and payment skip a sale that is being unwound. */
export async function saleHasActiveDealUnwind(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  saleId: Id<"sales">
): Promise<boolean> {
  const row = await ctx.db
    .query("dealUnwinds")
    .withIndex("by_org_sale_status", (q) => q.eq("orgId", orgId).eq("saleId", saleId).eq("status", "ACTIVE"))
    .first();
  return row !== null;
}
