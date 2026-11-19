import { createElement, type ReactNode } from "react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";

/** Same query-result boundary as the jsdom visual fixtures; no Convex client or credentials. */
const queryResults = new Map<string, unknown>([
  ["vehicles:listAll", []],
  ["orgSettings:get", { currency: "JOD" }],
]);
export function useQuery(reference: FunctionReference<"query">, args: unknown) {
  return args === "skip" ? undefined : queryResults.get(getFunctionName(reference));
}
export function usePaginatedQuery() {
  return { results: [], status: "Exhausted", isLoading: false, loadMore: () => undefined };
}
export function useMutation(reference: FunctionReference<"mutation">) {
  return async (args: Record<string, unknown>) => {
    // JSON transport deliberately preserves Convex's undefined value for an exact key assertion.
    const response = await fetch("/mutation", {
      method: "POST",
      body: JSON.stringify({ name: getFunctionName(reference), args }, (_key, value: unknown) =>
        value === undefined ? "__undefined__" : value),
    });
    if (!response.ok) throw new ConvexError({
      code: "SUPPLIER_PAYABLE_PAID_CANCEL_REFUSED", message: "synthetic server refusal",
    });
    return undefined;
  };
}
export function useOrg() { return { activeOrgId: "fixture-org" }; }
export default function Link({ href, children }: Readonly<{ href: string; children: ReactNode }>) {
  return createElement("a", { href }, children);
}
