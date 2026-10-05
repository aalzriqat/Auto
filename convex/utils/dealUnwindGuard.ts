import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { AppErrorCode, throwAppError } from "./errors";
import { DEAL_UNWIND_MESSAGES } from "./dealUnwindMessages";

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
