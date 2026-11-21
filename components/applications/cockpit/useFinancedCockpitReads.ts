import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

export function useFinancedCockpitReads({
  orgId,
  applicationId,
  canViewApplications,
  canViewDealCosts,
}: Readonly<{
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  canViewApplications: boolean;
  canViewDealCosts: boolean;
}>) {
  /**
   * The financed read model, served by the `dealWorkspace` wrapper rather than
   * by `applications.dealCockpit` directly.
   *
   * The wrapper composes that same authority through `ctx.runQuery` — one query
   * for the client, one read snapshot — and adds the two facts this screen
   * could not previously answer: who actually appraised the vehicle, and
   * whether a stopped deal is still sitting on the customer's money. Nothing
   * about the spine changed, which is why the cash rail below still calls
   * `sales.dealCockpit` and renders through the same view.
   */
  const deal = useQuery(api.dealWorkspace.financedDealCockpit, {
    orgId,
    applicationId,
  });

  /**
   * ---- The facts and commands the Review dialog used to own ----------------
   *
   * `applications.get` is the query that dialog reads, authorized on the same
   * `view:sales` as the cockpit query, so nothing here widens who may see what.
   * It carries the workflow facts the stage rail does not: the recorded
   * settlement route and whether the direct route is available, the
   * disbursement evidence, the deal's deposits, and the pinned economics
   * currency the disbursement figures are denominated in. `documents.getForApplication`
   * requires `view:finance_applications` and THROWS otherwise, so it is
   * skipped for a caller without it — the same discipline as `getEconomics`.
   *
   * Every mutation below is the one the Review dialog calls. The caller moved;
   * the authority did not. No new economic command exists on this screen.
   */
  const app = useQuery(api.applications.get, { orgId, applicationId });
  const documents = useQuery(
    api.documents.getForApplication,
    canViewApplications && deal ? { orgId, applicationId } : "skip",
  );
  // Round 3 (S417-R3-1): files kept for requirements removed after the upload,
  // view only — the same permission and the same skip as the active list.
  const documentHistory = useQuery(
    api.documents.getHistoryForApplication,
    canViewApplications && deal ? { orgId, applicationId } : "skip",
  );
  // The bundled cost read requires both grants, including while permissions load.
  const dealCosts = useQuery(
    api.financeDealCosts.listDealCosts,
    canViewDealCosts && deal ? { orgId, applicationId } : "skip",
  );

  /**
   * The financial overview — a sibling read model composed on the server from
   * the cockpit's own money payload plus the vehicle's pre-deal cost basis.
   * Gated by the same permission the cockpit itself takes (view:sales); the
   * server withholds each half by its own permission (view:finance,
   * view:cost_price) and returns null for it, never a zero.
   */
  const overview = useQuery(
    api.dealOverview.financedDealOverview,
    deal ? { orgId, applicationId } : "skip",
  );

  return { deal, app, documents, documentHistory, dealCosts, overview };
}
