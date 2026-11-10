import type { QueryCtx } from "../_generated/server";
import type { CachedTable } from "./supplierReadCache";
import type { Doc, Id } from "../_generated/dataModel";

/** The predicate lifted from supplierNavigation.owned; callers retain their own read budgets. */
export function ownedSupplierDocument<T extends object>(
  doc: T | null,
  orgId: Id<"organizations">,
): T | null {
  if (!doc || !("orgId" in doc) || doc.orgId !== orgId) return null;
  if ("isDeleted" in doc && doc.isDeleted) return null;
  return doc;
}

/** Direct joins retain the caller's database snapshot; no cache or extra read is introduced. */
export async function readOwned<T extends CachedTable>(
  ctx: Pick<QueryCtx, "db">,
  orgId: Id<"organizations">,
  id: Id<T> | undefined,
): Promise<Doc<T> | null> {
  return id ? ownedSupplierDocument(await ctx.db.get(id), orgId) : null;
}

/** Kept here so the ceiling-bound receivable reader shares the same stored-target rule. */
export async function receivableVehicleMetadata(
  ctx: Pick<QueryCtx, "db">,
  orgId: Id<"organizations">,
  id: Id<"vehicles">,
) {
  const vehicle = await readOwned(ctx, orgId, id);
  return {
    vehicleLabel: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`.trim() : "Vehicle",
    vin: vehicle?.vin,
  };
}
