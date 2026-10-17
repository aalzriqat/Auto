"use client";

import { useMemo } from "react";
import { useQueries, type RequestForQueries } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * The payment to the finance company that must be on the books BEFORE the deal
 * is finalized (SCRUM-411 P2-01), as the server judges it: the state, whether
 * this caller may record it, and the figures when the caller may see money.
 */
export type PreFinalizeForward = NonNullable<
  FunctionReturnType<typeof api.financeCompanyForward.preFinalizeForwardStatus>
>;

/**
 * Read WITHOUT throwing, for the reason `useClosingReadiness` does: the frontend
 * auto-deploys from main while the Convex backend is deployed by hand, so this
 * screen can meet a backend that has no `preFinalizeForwardStatus`. `useQuery`
 * would throw that during render and take the whole deal screen to the error
 * boundary; here only the payment step loses its verdict (`undefined`), and
 * `finalizeDeal` and `recordFinanceCompanyForward` re-judge it on the server
 * either way.
 *
 * `undefined` while loading, skipped, unavailable, or when the server says the
 * question does not arise (the deal is not an approved, unfinalized one).
 *
 * `planReady` is whether the deal is ready to close. It is asked either way, because
 * a recorded payment must stay visible (`onBooksForwardId`) and must keep Cancel
 * withheld (`blocksCancel`) even when the deal is no longer ready to close - say its
 * deposit was refunded afterwards; only the plan itself is skipped while not ready.
 */
export function usePreFinalizeForward(
  args: { orgId: Id<"organizations">; applicationId: Id<"financeApplications">; planReady: boolean } | "skip"
): PreFinalizeForward | undefined {
  const skip = args === "skip";
  const orgId = skip ? null : args.orgId;
  const applicationId = skip ? null : args.applicationId;
  const planReady = skip ? null : args.planReady;
  const queries = useMemo((): RequestForQueries => {
    if (orgId === null || applicationId === null || planReady === null) return {};
    return {
      status: { query: api.financeCompanyForward.preFinalizeForwardStatus, args: { orgId, applicationId, planReady } },
    };
  }, [orgId, applicationId, planReady]);
  const result: unknown = useQueries(queries).status;
  if (result instanceof Error || result === null) return undefined;
  return result as PreFinalizeForward | undefined;
}
