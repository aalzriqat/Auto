import type { ReactNode } from "react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";

/** Offline browser boundary only. Keep this outside the backend compiler's test-utils include. */
export function useQuery(reference: FunctionReference<"query">, args: unknown) {
  if (args === "skip") return undefined;
  if (getFunctionName(reference) === "suppliers:get") return {
    _id: "supplier", displayName: "Fixture supplier", status: "ACTIVE", version: 1, revision: 1,
    contact: { phone: "0790000000" }, aliases: [],
  };
  return undefined;
}
export function useMutation() { return (args: Record<string, unknown>) => {
  if (args.displayName === "Duplicate supplier") return Promise.reject(new ConvexError({ code: "SUPPLIER_DUPLICATE_CANDIDATES", message: "Confirm identity", candidates: [{ supplierId: "existing", displayName: "Existing supplier", status: "ACTIVE", reasons: ["SAME_NAME"] }] }));
  return Promise.resolve({ supplierId: "created", version: 1, revision: 2 });
}; }
export function usePermissions() { return { isLoading: false, hasPermission: (permission: string) => ["view:finance", "manage:finance"].includes(permission) }; }
export default function Link({ href, children, ...props }: Readonly<{ href: string; children: ReactNode }>) { return <a href={href} {...props}>{children}</a>; }
