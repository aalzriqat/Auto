import { Doc, Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";

/**
 * Whether a sale's financing is PROVEN, rather than merely asserted by a field.
 *
 * ⚠️ CX-B/CX-C, SCRUM-107. `saleEconomics` withholds a financed DIRECT row's
 * frozen margin unless the row carries both a verified supplier receipt and a
 * financing application — the receipt is the AMOUNT, the application is its
 * PROVENANCE. The provenance half was implemented as
 * `sale.applicationId !== undefined` at four separate call sites.
 *
 * Convex ids carry no referential integrity. `!== undefined` therefore proves
 * only that sixteen bytes are present in a column — not that they name a row,
 * not that the row belongs to this organization, and not that it has anything
 * to do with this sale. A deleted application, an application from another
 * tenant, and an application finalized on a completely different car all read
 * as "financing verified" and released the margin this PR exists to withhold.
 *
 * ONE verifier, exported once and used by every reader, because four
 * hand-written copies of a rule is how one gets fixed and the others do not.
 */
export function applicationProvesFinancing(
  application: Doc<"financeApplications"> | null,
  sale: Pick<Doc<"sales">, "_id" | "orgId">
): boolean {
  // Dangling: the id names nothing. `/admin`'s raw-JSON editor and a partially
  // failed `hardDeleteOrg` both leave exactly this.
  if (application === null) return false;
  // Foreign: another tenant's application cannot substantiate this org's money,
  // and reading one at all is the cross-tenant shape this codebase re-checks
  // server-side everywhere else.
  if (application.orgId !== sale.orgId) return false;
  // Unrelated: an application finalized on a DIFFERENT sale is real, same-org
  // financing — for another car. It proves nothing about this one.
  //
  // Absence of `finalizedSaleId` is deliberately NOT disqualifying. It is a
  // convenience pointer written at finalization, so a legitimately linked
  // application can lack it (it is optional, and no index exists to search by
  // it). Requiring it would withhold a fully derivable margin because a
  // denormalized field was stale — failing in the opposite direction, which is
  // the second half of the same finding.
  if (
    application.finalizedSaleId !== undefined &&
    application.finalizedSaleId !== sale._id
  ) {
    return false;
  }
  return true;
}

/**
 * The subset of `sales` whose financing application is proven, resolved in one
 * pass.
 *
 * Batched rather than per-sale on purpose. The reporting and dashboard readers
 * iterate every sale in a window, and a `ctx.db.get` inside those loops is an
 * N+1 read on a live-subscribed query — the exact pattern that put this
 * codebase's DB I/O where it is. Distinct application ids are fetched once, so
 * the cost is bounded by applications referenced, not by sales scanned.
 */
export async function verifiedFinancingApplicationSaleIds(
  ctx: QueryCtx,
  sales: ReadonlyArray<Doc<"sales">>
): Promise<Set<Id<"sales">>> {
  const distinctIds = new Set<Id<"financeApplications">>();
  for (const sale of sales) {
    if (sale.applicationId !== undefined) distinctIds.add(sale.applicationId);
  }

  const applications = new Map<Id<"financeApplications">, Doc<"financeApplications"> | null>();
  for (const applicationId of distinctIds) {
    applications.set(applicationId, await ctx.db.get(applicationId));
  }

  const verified = new Set<Id<"sales">>();
  for (const sale of sales) {
    if (sale.applicationId === undefined) continue;
    const application = applications.get(sale.applicationId) ?? null;
    if (applicationProvesFinancing(application, sale)) verified.add(sale._id);
  }
  return verified;
}

/** The single-sale form of {@link verifiedFinancingApplicationSaleIds}. */
export async function hasVerifiedFinancingApplication(
  ctx: QueryCtx,
  sale: Doc<"sales">
): Promise<boolean> {
  if (sale.applicationId === undefined) return false;
  return applicationProvesFinancing(await ctx.db.get(sale.applicationId), sale);
}
