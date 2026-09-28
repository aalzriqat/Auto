"use client";

import { useMemo } from "react";
import { useQueries, type RequestForQueries } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { ClosingReadinessView } from "./DealClosingReadinessList";

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
