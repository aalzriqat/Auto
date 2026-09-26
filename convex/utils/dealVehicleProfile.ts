import { QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";

/**
 * What the deal cockpit's vehicle card may show about the car (SCRUM-372).
 *
 * An ALLOWLIST, not a projection of the row: the vehicle document also holds
 * purchase price, source and landed cost, minimum profit and free-text notes,
 * and a salesperson who can see the deal is not entitled to any of those. Only
 * the identifying attributes below leave the backend, and only the FIRST
 * image, resolved to a URL — never the raw storage ids.
 */
export interface DealVehicleProfile {
  make: string;
  model: string;
  year: number;
  color: string;
  mileage: number;
  /** Null when the vehicle has no image or the stored file no longer resolves. */
  photoUrl: string | null;
}

/**
 * Null unless the caller may view vehicles, and the vehicle exists, belongs to
 * `orgId` and is not soft-deleted. The cockpit queries authorize on VIEW_SALES,
 * which a custom role can hold without VIEW_VEHICLES — the permission every
 * other vehicle-photo reader requires — so the caller's right is passed in and
 * checked here, not assumed from the deal's. The deal's own tenancy check does
 * not cover the vehicle row it points at either, so the org is re-checked too,
 * both before any storage URL is minted.
 */
export async function projectDealVehicleProfile(
  ctx: QueryCtx,
  vehicle: Doc<"vehicles"> | null,
  orgId: Id<"organizations">,
  canViewVehicles: boolean,
): Promise<DealVehicleProfile | null> {
  if (!canViewVehicles) return null;
  if (!vehicle || vehicle.orgId !== orgId || vehicle.isDeleted) return null;

  const firstImageId = vehicle.imageIds?.[0];
  let photoUrl: string | null = null;
  if (firstImageId) {
    try {
      photoUrl = await ctx.storage.getUrl(firstImageId);
    } catch (error) {
      // A missing photo must never take the deal page down with it.
      console.error(error);
      photoUrl = null;
    }
  }

  return {
    make: vehicle.make,
    model: vehicle.model,
    year: vehicle.year,
    color: vehicle.color,
    mileage: vehicle.mileage,
    photoUrl,
  };
}
