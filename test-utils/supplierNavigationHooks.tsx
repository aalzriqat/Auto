import type { ReactNode } from "react";
import { getFunctionName, type FunctionReference } from "convex/server";

/** Offline browser boundary only. The real supplier components and discard guard are bundled unchanged. */
export function useQuery(reference: FunctionReference<"query">, args: unknown) {
  if (args === "skip") return undefined;
  if (getFunctionName(reference) === "suppliers:get") return {
    _id: "supplier", displayName: "Fixture supplier", status: "ACTIVE", version: 1, revision: 1,
    contact: { phone: "0790000000" }, aliases: [],
  };
  return undefined;
}
export function useMutation() { return async () => ({ supplierId: "supplier", version: 1, revision: 2 }); }
export function usePermissions() { return { isLoading: false, hasPermission: (permission: string) => ["view:finance", "manage:finance"].includes(permission) }; }
export function useRouter() { return { push: (href: string) => window.history.pushState(window.history.state, "", href) }; }
export default function Link({ href, children, ...props }: Readonly<{ href: string; children: ReactNode }>) { return <a href={href} {...props}>{children}</a>; }
