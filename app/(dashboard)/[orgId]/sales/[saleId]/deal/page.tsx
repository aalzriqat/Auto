import { RoleGuard } from "@/components/auth/RoleGuard";
import { SaleDealCockpitClient } from "./client";

export const metadata = {
  title: "Deal | AutoFlow",
  description: "Track a sale end to end",
};

/**
 * THE deal screen. Canonical for both cash and financed sales.
 *
 * A financed sale is rendered here too, by delegating its money to the
 * application-keyed query — the application URL redirects here once the sale
 * exists, so a deal has one address rather than two.
 *
 * `deal` is a STATIC leaf under the dynamic `[saleId]`, matching the sibling
 * `print` route. A dynamic leaf here breaks `pnpm lint` with 71 unrelated
 * `no-html-link-for-pages` errors in the dealer-site files.
 *
 * Guarded on `view:sales`, identically to the financed route. The money panel
 * needs `view:finance` on top of that and is withheld by the SERVER rather than
 * by this guard — a salesperson can follow their own deal without seeing what
 * the dealership made on it, and a guard here could only choose between the
 * whole screen and none of it.
 */
export default function CashDealPage() {
  return (
    <RoleGuard permissions={["view:sales"]}>
      <SaleDealCockpitClient />
    </RoleGuard>
  );
}
