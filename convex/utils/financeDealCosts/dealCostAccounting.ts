import { ConvexError } from "convex/values";
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { SystemKey } from "../defaultChart";

/** Ledger and economics operations supplied by the registered cost functions. */
export interface DealCostAccounting {
  dealCustodyAccountingReadiness(
    ctx: QueryCtx | MutationCtx,
    orgId: Id<"organizations">,
  ): Promise<
    | { ready: true }
    | { ready: false; reason: "CHART_NOT_INITIALIZED" | "ACCOUNT_UNMAPPED" | "ACCOUNT_CODE_CONFLICT"; systemKey?: SystemKey }
  >;
  ensureFinancedSettlementAccounts(ctx: MutationCtx, orgId: Id<"organizations">, actorId: Id<"users">): Promise<void>;
  isChartInitialized(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">): Promise<boolean>;
  isSystemAccountMapped(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">, systemKey: SystemKey): Promise<boolean>;
  recomputeEconomicsForApplication(ctx: MutationCtx, applicationId: Id<"financeApplications">): Promise<void>;
}

/**
 * The custody money boundary: refuses before anything is written when the
 * org's ledger cannot take the posting. A movement recorded "operationally
 * only" would present un-posted cash as accounted for — exactly what the
 * read-only custody screen existed to avoid — so the refusal is here, at the
 * mutation, and the screen reads the same predicate to explain a disabled
 * button (`listDealCosts.custodyAccounting`).
 */
export async function assertCustodyAccountingReady(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  action: string,
  accounting: DealCostAccounting
): Promise<void> {
  const readiness = await accounting.dealCustodyAccountingReadiness(ctx, orgId);
  if (readiness.ready) return;
  const why: Record<typeof readiness.reason, string> = {
    CHART_NOT_INITIALIZED:
      "The chart of accounts has not been initialized for this organization, so cash cannot be posted.",
    ACCOUNT_UNMAPPED: `The "${readiness.systemKey}" system account is missing or inactive in the chart of accounts.`,
    ACCOUNT_CODE_CONFLICT: `The chart of accounts has a custom account on the code reserved for "${readiness.systemKey}"; resolve it under Accounting > Chart of Accounts.`,
  };
  throw new ConvexError(`${why[readiness.reason]} Set up accounting before ${action}; nothing has been recorded.`);
}
