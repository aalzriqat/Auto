"use client";

import { useMemo } from "react";
import { useQueries, type RequestForQueries } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { ClosingReadinessView } from "./DealClosingReadinessList";
import { usePreFinalizeForward } from "./usePreFinalizeForward";

export type ClosingReadinessRead = {
  /** The server's verdict; `undefined` while loading, skipped, or unavailable. */
  readiness: ClosingReadinessView | undefined;
  /**
   * The read itself failed — most often a backend deployed before
   * `getClosingReadiness` existed. The panel says so; nothing else changes.
   */
  serviceUnavailable: boolean;
};

/**
 * The deal's closing readiness, read WITHOUT throwing (SCRUM-414 Codex R2).
 *
 * The frontend auto-deploys from main while the Convex backend is deployed by
 * hand, so this screen can meet a backend that has no
 * `applications.getClosingReadiness`. `useQuery` throws an errored result
 * during render, which would take the whole deal screen to the app error
 * boundary. `useQueries` hands the error back as a value instead, so only the
 * readiness panel loses its verdict and every other cockpit action keeps
 * working. `finalizeDeal` re-checks readiness on the server either way.
 */
export function useClosingReadiness(
  args: { orgId: Id<"organizations">; applicationId: Id<"financeApplications"> } | "skip"
): ClosingReadinessRead {
  const skip = args === "skip";
  const orgId = skip ? null : args.orgId;
  const applicationId = skip ? null : args.applicationId;
  const queries = useMemo((): RequestForQueries => {
    if (orgId === null || applicationId === null) return {};
    return { readiness: { query: api.applications.getClosingReadiness, args: { orgId, applicationId } } };
  }, [orgId, applicationId]);
  const result: unknown = useQueries(queries).readiness;
  if (result instanceof Error) return { readiness: undefined, serviceUnavailable: true };
  return { readiness: result as ClosingReadinessView | undefined, serviceUnavailable: false };
}

/**
 * Why the close cannot be taken — and it takes BOTH conditions, because the
 * two interact rather than merely coexisting.
 *
 * `setSupplierSettlementRoute` requires `manage:supplier_settlement`, and the
 * review dialog hides its selector without it. So telling a caller who lacks
 * that permission to "record the route" sends them to a screen with nothing
 * on it — the dead end this issue exists to remove, rebuilt out of two correct
 * sentences.
 *
 * Since SCRUM-407 the close itself is an accountant's act
 * (`confirm:finance_disbursement`), so the two permissions are no longer the
 * same one: the route is judged on who may RECORD it, the close on who may
 * CLOSE, each against the server's own gate.
 *
 * A loaded closing-readiness verdict that is not READY is a prerequisite too:
 * `finalizeDeal` re-runs the same evaluator and would refuse, so the action is
 * withheld and the readiness list above names what is left.
 *
 * A readiness READ that failed withholds it as well (S414-R2-SKEW-1): most
 * often that is a backend deployed before `getClosingReadiness`, and such a
 * backend's `finalizeDeal` predates the redacted refusals — its currency-drift
 * refusal names both currencies to a caller who may close but not read money.
 * The close is offered only once a verdict has LOADED; a read still in flight
 * is handled by the caller, which keeps the step at its blocker meanwhile.
 *
 * A caller who may close but may not READ the readiness has no verdict at all
 * — the query is skipped — so the close is withheld from them too (S414-R3-1,
 * Option A), named last: the route and the close permission are the more
 * useful things to say when they also apply. Every default role holding
 * `confirm:finance_disbursement` holds `view:finance_applications`, so this
 * reaches only custom roles, and tells them which access is missing.
 *
 * Extracted rather than left as a nested ternary so the combinations are
 * enumerable, and testable, one line each.
 */
export function finalizeUnavailableReasonKey({
  routeRequired,
  canRecordRoute,
  readinessBlocksClose,
  readinessUnreadable,
  forwardReasonKey,
  canClose,
  canReadReadiness,
}: Readonly<{
  routeRequired: boolean;
  canRecordRoute: boolean;
  readinessBlocksClose: boolean;
  readinessUnreadable: boolean;
  /**
   * SCRUM-411 P2-01: `finalizeDeal` refuses until the deposit and the
   * contribution owed to the finance company are on the books for the plan it
   * would freeze. Judged after the readiness (the server cannot form the plan
   * before the deal is ready to close) and before the close permission, because
   * the payment is a fact about the deal that someone other than the closer may
   * have to act on.
   */
  forwardReasonKey: string | undefined;
  canClose: boolean;
  canReadReadiness: boolean;
}>): string | undefined {
  if (routeRequired && !canRecordRoute) return "FinalizeNeedsRouteAndPermission";
  if (routeRequired) return "FinalizeNeedsSettlementRoute";
  if (readinessUnreadable) return "FinalizeWaitsForReadiness";
  if (readinessBlocksClose) return "FinalizeNeedsClosingReadiness";
  if (forwardReasonKey !== undefined) return forwardReasonKey;
  if (!canClose) return "FinalizeNeedsPermission";
  if (!canReadReadiness) return "FinalizeNeedsReadinessAccess";
  return undefined;
}

/**
 * Why an already-open close confirmation may not be submitted — or `undefined`
 * when the cockpit holds a loaded, open READY verdict (S414-R3-1).
 *
 * The dialog outlives the verdict it was opened on: a read that fails, or a
 * verdict that turns BLOCKED, must stop the submit rather than let an older
 * backend's detailed refusal through. Mirrors `finalizeAllowedByReadiness`.
 */
export function finalizeReadinessHoldReasonKey({
  canReadReadiness,
  readiness,
  readinessUnreadable,
}: Readonly<{
  canReadReadiness: boolean;
  readiness: { open: boolean; state: string } | undefined;
  readinessUnreadable: boolean;
}>): string | undefined {
  if (!canReadReadiness) return "FinalizeNeedsReadinessAccess";
  if (readinessUnreadable || readiness === undefined || !readiness.open)
    return "FinalizeWaitsForReadiness";
  if (readiness.state !== "READY") return "FinalizeNeedsClosingReadiness";
  return undefined;
}

export function useFinancedClosingReadiness({
  orgId,
  applicationId,
  deal,
  canViewApplications,
}: Readonly<{
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  deal: Readonly<{ status: string }> | null | undefined;
  canViewApplications: boolean;
}>) {
  // The deal's automatic closing readiness (SCRUM-407) — the same evaluator
  // `finalizeDeal` re-runs, so the panel previews the server's verdict. Same
  // read permission as the cost record; the server redacts the detail below
  // the finance tier itself. Read without throwing: a backend deployed before
  // this query existed costs the panel its verdict, not the screen its life
  // (SCRUM-414 Codex R2).
  const {
    readiness: closingReadiness,
    serviceUnavailable: closingReadinessServiceUnavailable,
  } = useClosingReadiness(
    canViewApplications && deal ? { orgId, applicationId } : "skip",
  );
  /**
   * The ONE readiness condition the close is offered AND submitted under
   * (S414-R2-SKEW-1, S414-R3-1): a successfully loaded, open READY verdict. A
   * skipped, loading, failed, closed, BLOCKED or UNAVAILABLE read withholds it,
   * so an older backend's detailed refusal never reaches a caller without
   * money-read authority through this screen. The server re-checks regardless.
   */
  const finalizeReadinessHoldKey = finalizeReadinessHoldReasonKey({
    canReadReadiness: canViewApplications,
    readiness: closingReadiness,
    readinessUnreadable: closingReadinessServiceUnavailable,
  });
  const finalizeAllowedByReadiness = finalizeReadinessHoldKey === undefined;
  // SCRUM-411 P2-01: the deposit and the contribution owed to the finance company
  // are paid BEFORE the close. The server judges it against the plan the close
  // would freeze (the cockpit's own `forward` block only knows a frozen plan, so
  // it says nothing about an approved deal that is not finalized yet). Asked while
  // the deal is APPROVED; the plan it judges is formed from the same inputs the
  // readiness already evaluated, so `planReady` tells the server to skip that second
  // derivation until the deal is ready to close. The payment itself (which one to take
  // back, and that Cancel must wait) is answered either way (SCRUM-411 B1). Read
  // without throwing like the readiness above.
  const preFinalizeForward = usePreFinalizeForward(
    canViewApplications && deal?.status === "APPROVED"
      ? { orgId, applicationId, planReady: finalizeAllowedByReadiness }
      : "skip",
  );

  return {
    closingReadiness,
    closingReadinessServiceUnavailable,
    finalizeReadinessHoldKey,
    finalizeAllowedByReadiness,
    preFinalizeForward,
  };
}
