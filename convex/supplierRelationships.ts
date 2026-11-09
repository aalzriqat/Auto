import { paginationOptsValidator, type PaginationOptions } from "convex/server";
import { ConvexError, v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { SUPPLIER_NOT_FOUND_MESSAGE } from "./utils/supplierRegistry";
import { hasReadHeadroom } from "./utils/transactionReadHeadroom";
import { supplierNavigationFailure, supplierVehicleHref, supplierVehicleLabel } from "./utils/supplierNavigation";

const MAX_ROWS = 50;
const MAX_BYTES = 1024 * 1024;
const vehicleRow = v.object({ vehicleId: v.id("vehicles"), label: v.string(),
  model: v.union(v.literal("SOURCED"), v.literal("OWNED_ON_ACCOUNT")), status: v.string(), href: v.union(v.string(), v.null()) });

function bounded(value: number | undefined, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return maximum;
  return Math.min(Math.max(1, Math.trunc(value)), maximum);
}
function pageOptions(options: PaginationOptions): PaginationOptions {
  return { numItems: bounded(options.numItems, MAX_ROWS), cursor: options.cursor,
    endCursor: options.endCursor,
    maximumRowsRead: bounded(options.maximumRowsRead, MAX_ROWS),
    maximumBytesRead: bounded(options.maximumBytesRead, MAX_BYTES) };
}
function project(vehicle: Doc<"vehicles">, model: "SOURCED" | "OWNED_ON_ACCOUNT", permissions: readonly string[]) {
  return { vehicleId: vehicle._id, label: supplierVehicleLabel(vehicle), model, status: vehicle.status,
    href: supplierVehicleHref(vehicle.orgId, vehicle._id, permissions) };
}
async function ownedVehicle(ctx: QueryCtx, orgId: Id<"organizations">, payable: Doc<"vehicleSupplierPayables">) {
  if (payable.origin === "OPENING" || payable.saleId) return null;
  // A stopped join must refuse the page, rather than advance the cursor over unread vehicles.
  if (!(await hasReadHeadroom(ctx))) throw new Error("Supplier relationship join has no read headroom");
  const vehicle = await ctx.db.get(payable.vehicleId);
  return vehicle && vehicle.orgId === orgId && !vehicle.isDeleted && vehicle.sourceType !== "SOURCED" ? vehicle : null;
}

/** One native paginate per invocation. Metadata allowlist intentionally contains no cost or price. */
export const vehicles = query({
  args: { orgId: v.id("organizations"), supplierId: v.id("suppliers"), kind: v.union(v.literal("SOURCED"), v.literal("OWNED")), paginationOpts: paginationOptsValidator },
  returns: v.object({ page: v.array(vehicleRow), isDone: v.boolean(), continueCursor: v.string(),
    pageStatus: v.union(v.literal("SplitRequired"), v.literal("SplitRecommended"), v.null()), splitCursor: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    try {
      const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
      await requireOwnedRow(ctx, args.orgId, "suppliers", args.supplierId, SUPPLIER_NOT_FOUND_MESSAGE);
      const options = pageOptions(args.paginationOpts);
      if (args.kind === "SOURCED") {
        const result = await ctx.db.query("vehicles").withIndex("by_org_and_sourcedSupplierId", q => q.eq("orgId", args.orgId).eq("sourcedSupplierId", args.supplierId)).order("desc").paginate(options);
        return { ...result, page: result.page.filter(vehicle => !vehicle.isDeleted && vehicle.sourceType === "SOURCED").map(vehicle => project(vehicle, "SOURCED", role.permissions)), pageStatus: result.pageStatus ?? null, splitCursor: result.splitCursor ?? null };
      }
      const result = await ctx.db.query("vehicleSupplierPayables").withIndex("by_org_and_supplierId_and_status", q => q.eq("orgId", args.orgId).eq("supplierId", args.supplierId)).order("desc").paginate(options);
      const page: ReturnType<typeof project>[] = [];
      const seen = new Set<string>();
      for (const payable of result.page) {
        const vehicle = await ownedVehicle(ctx, args.orgId, payable);
        if (!vehicle || seen.has(vehicle._id)) continue;
        seen.add(vehicle._id);
        page.push(project(vehicle, "OWNED_ON_ACCOUNT", role.permissions));
      }
      return { ...result, page, pageStatus: result.pageStatus ?? null, splitCursor: result.splitCursor ?? null };
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      return supplierNavigationFailure(error);
    }
  },
});
