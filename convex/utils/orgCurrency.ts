import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireConfiguredCurrency } from "./money";

/**
 * The organization's STORED currency, or a typed `CURRENCY_NOT_CONFIGURED`
 * refusal. SCRUM-85 (SCRUM-760 c23812 ruling 9): this used to answer "JOD" for an
 * org with no settings row, which let a sale, receipt or journal be minted in a
 * currency nobody chose. There is no fallback; every caller fails closed.
 *
 * A LEAF module on purpose: it value-imports only `./money` (and types from
 * `_generated`), so accounting, reports, the audit trail and the VAT report can
 * all read the currency through one function without importing the accounting
 * hub or each other. `accounting/workflowHooks` re-exports it for its existing
 * callers.
 */
export async function getOrgCurrency(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">): Promise<string> {
  const settings = await ctx.db
    .query("orgSettings")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
  return requireConfiguredCurrency(settings);
}