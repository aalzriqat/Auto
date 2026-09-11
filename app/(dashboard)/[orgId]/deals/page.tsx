import { RoleGuard } from "@/components/auth/RoleGuard";
import { DealsListClient } from "./client";

export const metadata = {
  title: "Deals | AutoFlow",
  description: "Every deal, cash or financed, and what each one is waiting on",
};

/**
 * The Deals list — one entry per canonical deal, opening the one deal screen.
 *
 * Guarded on `view:sales`, the permission both list queries and both deal
 * routes check. The legacy `/applications` list remains reachable by URL for
 * existing links; the navigation now lands here.
 */
export default function DealsPage() {
  return (
    <RoleGuard permissions={["view:sales"]}>
      <DealsListClient />
    </RoleGuard>
  );
}
