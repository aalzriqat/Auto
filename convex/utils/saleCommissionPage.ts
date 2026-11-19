import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { deriveCommissionStatus, isCommissionOwed } from "./commission";
import { effectiveCommissionMode, isAutoCommissionMode } from "./commissionMode";
import { PERMISSIONS } from "./permissions";
import { projectSaleRow } from "./saleRowProjection";
import { requireTenantAuth } from "./tenancy";
import { vehicleHasCostBasis } from "./vehicleCost";

/**
 * Caches the in-flight promise rather than the resolved document. The hydration
 * loop runs its rows concurrently, so a cache that only records the value after
 * its own `await` is populated too late to prevent any of the duplicate reads it
 * exists for.
 */
export function makeDocCache<T extends TableNames>(read: (id: Id<T>) => Promise<Doc<T> | null>) {
  const cache = new Map<string, Promise<Doc<T> | null>>();
  return (id: Id<T>): Promise<Doc<T> | null> => {
    const hit = cache.get(id);
    if (hit) return hit;
    const pending = read(id);
    cache.set(id, pending);
    return pending;
  };
}

export async function commissionPage(
  ctx: QueryCtx,
  args: {
    orgId: Id<"organizations">;
    salespersonId?: Id<"users">;
    paidStatus?: "paid" | "unpaid" | "not_set";
  },
  paginationOpts: { numItems: number; cursor: string | null }
) {
  const { user, role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_COMMISSIONS]);

    // Without MANAGE_COMMISSIONS, a salesperson can only see their own
    // commissions — ignore whatever salespersonId was requested and force
    // it to the caller, regardless of org-wide view requested via "all".
    const canViewAll = role.permissions.includes(PERMISSIONS.MANAGE_COMMISSIONS);
    const salespersonId = canViewAll ? args.salespersonId : user._id;

    // In an automatic mode, a completed sale whose vehicle has no recorded cost
    // basis earns 0 commission (see C3 in saleCompletion). Surface those rows
    // too — flagged — so a manager notices the missing cost and can fix it.
    const orgSettings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
    const mode = effectiveCommissionMode(orgSettings);
    const isAutoMode = isAutoCommissionMode(mode);
    // MANUAL mode has no calculator: an amount only ever exists because somebody
    // typed it on this page. Listing only sales that already carry one is a
    // closed loop — the first amount can never be entered. So in MANUAL mode
    // every completed sale is listed, and the ones still undecided are the work
    // queue rather than an absence of records.
    const isManualMode = mode === "MANUAL";

    // Paginated on the sale-date index, newest first. A page reads a fixed
    // number of DOCUMENTS, not "however many it takes to find N matches" — the
    // difference matters most in the steady state a diligent manager creates,
    // where the review queue is empty and a match-counting scan would read the
    // dealership's entire history every time they open the page.
    //
    // The candidate rules run in JS rather than through `.filter()` so the page
    // size stays the read budget. A page may therefore come back short, or
    // empty, while more pages remain; that is what `isDone` is for.
    const salesQuery = salespersonId
      ? ctx.db
          .query("sales")
          .withIndex("by_org_salesperson_saleDate", (q) =>
            q.eq("orgId", args.orgId).eq("salespersonId", salespersonId)
          )
      : ctx.db.query("sales").withIndex("by_org_saleDate", (q) => q.eq("orgId", args.orgId));

    const pageResult = await salesQuery.order("desc").paginate(paginationOpts);

    const candidates = pageResult.page.filter((sale) => {
      if (sale.isDeleted) return false;
      const isVoid = sale.status === "CANCELLED" && (sale.commissionAmount ?? 0) > 0;
      const isCandidate =
        isCommissionOwed(sale) ||
        (sale.status === "COMPLETED" && sale.commissionPaidAt != null) ||
        // A cancelled sale keeps its amount as history. It is listed so the
        // record does not silently vanish, but it owes nothing — every total,
        // every action and the unpaid filter below exclude it.
        isVoid ||
        (isAutoMode && sale.status === "COMPLETED" && sale.commissionAmount == null) ||
        (isManualMode && sale.status === "COMPLETED");
      if (!isCandidate) return false;
      // "unpaid" means still settleable and not yet settled; "not_set" narrows
      // that to the rows awaiting a decision.
      if (args.paidStatus === "paid" && sale.commissionPaidAt == null) return false;
      if (args.paidStatus === "unpaid" && (sale.commissionPaidAt != null || isVoid)) return false;
      if (
        args.paidStatus === "not_set" &&
        (sale.commissionPaidAt != null || sale.commissionAmount != null || isVoid)
      ) {
        return false;
      }
      return true;
    });

    const getVehicle = makeDocCache<"vehicles">((id) => ctx.db.get("vehicles", id));
    const getCustomer = makeDocCache<"customers">((id) => ctx.db.get("customers", id));
    const getUser = makeDocCache<"users">((id) => ctx.db.get("users", id));

    const hydrated = await Promise.all(
      candidates.map(async (sale) => {
        const vehicle = await getVehicle(sale.vehicleId);
        // Only ever flag a sale whose commission was NEVER computed
        // (commissionAmount == null). A sale that already carries a real
        // commission — even if the vehicle's cost is later cleared — keeps its
        // amount and its Pay action and must not be pulled back into remediation.
        const missingPurchaseCost =
          isAutoMode &&
          sale.status === "COMPLETED" &&
          sale.commissionAmount == null &&
          (!vehicle || !vehicleHasCostBasis(vehicle));
        // The follow-up state to missingPurchaseCost: the cost has since been
        // fixed on the vehicle, but this sale completed while it was missing so
        // its commission was never computed (commissionAmount == null — AUTO
        // completion always stores a number, even 0, when a cost basis exists).
        // Surfaced so a manager can run recalculateCommission on it.
        const needsRecalculation =
          isAutoMode &&
          sale.status === "COMPLETED" &&
          sale.commissionPaidAt == null &&
          sale.commissionAmount == null &&
          vehicle != null &&
          vehicleHasCostBasis(vehicle);
        return { sale, vehicle, missingPurchaseCost, needsRecalculation };
      })
    );

    // Include sales that still owe a commission, the ones already settled, the
    // flagged AUTO fix-up rows, and (MANUAL) every completed sale so the
    // undecided ones are reachable at all.
    const listed = hydrated.filter(
      (h) =>
        isCommissionOwed(h.sale) ||
        (h.sale.status === "COMPLETED" && h.sale.commissionPaidAt != null) ||
        (h.sale.status === "CANCELLED" && (h.sale.commissionAmount ?? 0) > 0) ||
        h.missingPurchaseCost ||
        h.needsRecalculation ||
        (isManualMode && h.sale.status === "COMPLETED")
    );

    // Payroll only ever sweeps commissions for members who are still ACTIVE
    // (collectUnpaidCommissions), and approval hard-rejects a run containing an
    // offboarded one. Opening the manual entry point makes it possible to enter
    // an amount for someone who has left, which would then sit as "pending"
    // forever with no error anywhere.
    //
    // Built as the set payroll actually uses rather than "memberships carrying
    // an offboardingStatus": finalizeMembershipOffboardingJob DELETES the
    // membership once removal succeeds, so testing for the in-progress flag
    // would report a fully-departed salesperson as fine — precisely the case
    // where payroll will never pay them. Absent from the set is the condition.
    // See PR 3 for actually settling them.
    // Looked up per distinct salesperson ON THIS PAGE rather than by collecting
    // the org's whole membership table: the page itself reads a bounded number
    // of sale documents, so a full scan here would be the only unbounded read
    // left on the path — and a caller walking N pages would repeat it N times.
    const pageSalespersonIds = [...new Set(listed.map((h) => h.sale.salespersonId))];
    const offboardedSalespersonIds = new Set(
      (
        await Promise.all(
          pageSalespersonIds.map(async (userId) => {
            const membership = await ctx.db
              .query("memberships")
              .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", userId))
              .unique();
            // Absent counts as offboarded: the finalizer DELETES the row once
            // external removal succeeds, which is exactly when payroll stops
            // paying them.
            return membership && !membership.offboardingStatus ? null : (userId as string);
          })
        )
      ).filter((id): id is string => id !== null)
    );

    const page = await Promise.all(
      listed.map(async ({ sale, vehicle, missingPurchaseCost, needsRecalculation }) => {
        const customer = await getCustomer(sale.customerId);
        const salesperson = await getUser(sale.salespersonId);
        const paidBy = sale.commissionPaidBy ? await getUser(sale.commissionPaidBy) : null;
        // Whether an edit is worth OFFERING — not a guarantee that it will be
        // accepted. An amount already on the books is no longer refused (it is
        // corrected with an adjusting entry), but setCommissionAmount still
        // rejects a change whose entries have not posted yet, and no query
        // result can be authoritative about that: the outbox can drain, or a
        // period close can land, between this render and the click. The
        // mutation is the authority; the client surfaces its reason.
        const canSetAmount =
          isManualMode && sale.status === "COMPLETED" && sale.commissionPaidAt == null;
        return {
          ...projectSaleRow(sale, role),
          vehicleSummary: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : "Unknown",
          customerName: customer ? `${customer.firstName} ${customer.lastName}` : "Unknown",
          salespersonName: salesperson?.name ?? salesperson?.email ?? "Unknown",
          paidByName: paidBy?.name ?? paidBy?.email ?? null,
          missingPurchaseCost,
          needsRecalculation,
          commissionStatus: deriveCommissionStatus(sale),
          canSetAmount,
          salespersonOffboarded: offboardedSalespersonIds.has(sale.salespersonId),
        };
      })
    );

  return { ...pageResult, page };
}
