import { paginationOptsValidator } from "convex/server";
import { ConvexError, v, type Infer } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { SUPPLIER_NOT_FOUND_MESSAGE } from "./utils/supplierRegistry";
import { supplierNavigationFailure, supplierVehicleHref, supplierVehicleLabel } from "./utils/supplierNavigation";
import { createSupplierReadCache, readCached, type SupplierReadCache } from "./utils/supplierReadCache";
import { boundedCount } from "./utils/paginationBounds";

const MAX_ROWS = 50;
const MAX_BYTES = 1024 * 1024;
const vehicleRow = v.object({ id: v.string(), vehicleId: v.id("vehicles"), label: v.string(),
  model: v.union(v.literal("SOURCED"), v.literal("OWNED_ON_ACCOUNT")), status: v.string(), href: v.union(v.string(), v.null()) });

type VehicleRow = Infer<typeof vehicleRow>;
function project(vehicle: Doc<"vehicles">, model: "SOURCED" | "OWNED_ON_ACCOUNT", permissions: readonly string[], id: string = vehicle._id) {
  return { id, vehicleId: vehicle._id, label: supplierVehicleLabel(vehicle), model, status: vehicle.status,
    href: supplierVehicleHref(vehicle.orgId, vehicle._id, permissions) };
}
async function ownedVehicle(ctx: QueryCtx, orgId: Id<"organizations">, payable: Doc<"vehicleSupplierPayables">, cache: SupplierReadCache) {
  if (payable.origin === "OPENING" || payable.saleId) return null;
  // A stopped join must refuse the page, rather than advance the cursor over unread vehicles.
  const vehicle = await readCached(ctx, cache.vehicles, payable.vehicleId);
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
      const numItems = boundedCount(args.paginationOpts.numItems, MAX_ROWS);
      const maximumRowsRead = boundedCount(args.paginationOpts.maximumRowsRead ?? MAX_ROWS, MAX_ROWS);
      const maximumBytesRead = boundedCount(args.paginationOpts.maximumBytesRead ?? MAX_BYTES, MAX_BYTES);
      const options = { ...args.paginationOpts, numItems, maximumRowsRead, maximumBytesRead };
      let result;
      const page: VehicleRow[] = [];
      if (args.kind === "SOURCED") {
        result = await ctx.db.query("vehicles").withIndex("by_org_and_sourcedSupplierId", q => q.eq("orgId", args.orgId).eq("sourcedSupplierId", args.supplierId)).order("desc").paginate(options);
        page.push(...result.page.filter(vehicle => !vehicle.isDeleted && vehicle.sourceType === "SOURCED").map(vehicle => project(vehicle, "SOURCED", role.permissions)));
      } else {
        result = await ctx.db.query("vehicleSupplierPayables").withIndex("by_org_and_supplierId_and_status", q => q.eq("orgId", args.orgId).eq("supplierId", args.supplierId)).order("desc").paginate(options);
        const cache = createSupplierReadCache();
        for (const payable of result.page) {
          const vehicle = await ownedVehicle(ctx, args.orgId, payable, cache);
          if (vehicle) page.push(project(vehicle, "OWNED_ON_ACCOUNT", role.permissions, payable._id));
        }
      }
      return { ...result, page, pageStatus: result.pageStatus ?? null, splitCursor: result.splitCursor ?? null };
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      return supplierNavigationFailure(error);
    }
  },
});
