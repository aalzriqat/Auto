/* eslint-disable */
// @ts-nocheck
/**
 * The two shipped call forms the v1 detector never saw (Codex CS-1, SCRUM-178).
 *
 * Both are copied from the real tree so the extractor is exercised against the
 * REAL Convex SDK and the REAL generated `api`, not a local stand-in:
 *
 *   - `useQueries` request map built inside `useMemo`
 *     (components/applications/cockpit/useClosingReadiness.ts)
 *   - a function reference held in a const alias behind
 *     `as unknown as {...}` and then handed to `useQuery`
 *     (components/search/GlobalSearchModal.tsx)
 */
import { useMemo } from "react";
import { useQueries, useQuery } from "convex/react";
import type { FunctionReference } from "convex/server";
import { api } from "@/convex/_generated/api";

export function UseQueriesInUseMemo(args: { orgId: string; applicationId: string } | "skip") {
  const skip = args === "skip";
  const orgId = skip ? null : args.orgId;
  const applicationId = skip ? null : args.applicationId;
  const queries = useMemo(() => {
    if (orgId === null || applicationId === null) return {};
    return { readiness: { query: api.applications.getClosingReadiness, args: { orgId, applicationId } } };
  }, [orgId, applicationId]);
  return useQueries(queries).readiness;
}

const globalSearchQuery = (api as unknown as {
  search: {
    globalSearch: FunctionReference<"query", "public", { orgId: string; query: string }, unknown>;
  };
}).search.globalSearch;

export function AliasedReference(props: { orgId?: string; text: string }) {
  return useQuery(
    globalSearchQuery,
    props.text.length < 2 || !props.orgId ? "skip" : { orgId: props.orgId, query: props.text }
  );
}
