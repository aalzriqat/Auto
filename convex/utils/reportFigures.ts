import type { QueryCtx } from "../_generated/server";
import { getOrgCurrency } from "../accounting/workflowHooks";
import { loadReportDealFigures, type ReportInputs } from "./reportDealFigures";

/**
 * The loader plus the one org-currency read (a single db.query) the report callers also need for their own totals.
 * callsAlreadySpent is every other db.get and db.query call the calling query makes, before or after this one:
 * getSalesAndProfitReport passes 5 (user, org, membership, role, sales range) and getSalespersonPerformance passes 5 plus
 * one user get per salesperson. The rate limiter's component reads are not counted here; QUERY_CALL_RESERVE covers them.
 */
export async function loadReportFigures(ctx: QueryCtx, args: Omit<ReportInputs, "orgCurrency">) {
  const orgCurrency = await getOrgCurrency(ctx, args.orgId);
  const callsAlreadySpent = args.callsAlreadySpent + 1;
  return { orgCurrency, figures: await loadReportDealFigures(ctx, { ...args, orgCurrency, callsAlreadySpent }) };
}
