import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { canReadVehicleCost, projectVehicleForRole } from "./vehicleCostVisibility";
import { ConvexError } from "convex/values";

export async function readVehicleExport(
  ctx: QueryCtx,
  args: { orgId: Id<"organizations"> },
  role: Doc<"roles">,
) {
  const canViewCostPrice = canReadVehicleCost(role);

  const orgVehicles = await ctx.db
    .query("vehicles")
    .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
    .collect();
  // In-memory filter of the already-loaded rows (not a database scan).
  const vehicles = orgVehicles.filter((vehicle) => vehicle.isDeleted !== true);

  const companies = await ctx.db
    .query("financeCompanies")
    .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
    .collect();
  const companyNameById = new Map(companies.map((c) => [c._id, c.name]));

  const valuations = await ctx.db
    .query("vehicleValuations")
    .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
    .collect();

  const valuationsByVehicle = new Map<string, Array<{ companyName: string; amount: number }>>();
  const valuationCompanyNames = new Set<string>();
  for (const valuation of valuations) {
    const companyName = companyNameById.get(valuation.companyId);
    if (!companyName) continue; // company deleted out from under the valuation
    valuationCompanyNames.add(companyName);
    const list = valuationsByVehicle.get(valuation.vehicleId) ?? [];
    list.push({ companyName, amount: valuation.valuationAmount });
    valuationsByVehicle.set(valuation.vehicleId, list);
  }

  return {
    vehicles: vehicles.map((vehicle) => {
      const sourceType = (vehicle.sourceType ?? "STOCK") as "STOCK" | "SOURCED";
      // "Cost" and "Sourced From" are chosen by sourceType, so an owned row never
      // exports a stale consignment cost or supplier left on it.
      const costValue = sourceType === "SOURCED" ? vehicle.sourceCost ?? vehicle.purchasePrice : vehicle.purchasePrice;
      const cost = canViewCostPrice ? costValue ?? null : null;
      return {
        make: vehicle.make,
        model: vehicle.model,
        year: vehicle.year,
        vin: vehicle.vin ?? "",
        color: vehicle.color ?? "",
        mileage: vehicle.mileage ?? null,
        cost,
        sellingPrice: vehicle.sellingPrice,
        sourceType,
        sourcedFrom: sourceType === "SOURCED" ? vehicle.sourcedFromName ?? "" : "",
        valuations: valuationsByVehicle.get(vehicle._id) ?? [],
      };
    }),
    valuationCompanyNames: Array.from(valuationCompanyNames),
  };
}

export async function readVehicleDetail(
  ctx: QueryCtx,
  args: { orgId: Id<"organizations">; vehicleId: Id<"vehicles"> },
  role: Doc<"roles">,
) {

  const vehicle = await ctx.db.get(args.vehicleId);
  if (!vehicle || vehicle.isDeleted || vehicle.orgId !== args.orgId) {
    throw new ConvexError("Vehicle not found in this organization.");
  }

  const imageUrls = await Promise.all(
    (vehicle.imageIds ?? []).map((id) => ctx.storage.getUrl(id))
  );
  const addedByUser = vehicle.addedBy ? await ctx.db.get(vehicle.addedBy) : null;
  const pendingRequest = await ctx.db
    .query("vehicleStatusRequests")
    .withIndex("by_vehicle", (q) => q.eq("vehicleId", args.vehicleId))
    .filter((q) => q.eq(q.field("status"), "PENDING"))
    .first();

  return {
    ...projectVehicleForRole(vehicle, role),
    imageUrls,
    addedByName: addedByUser?.name ?? addedByUser?.email ?? null,
    pendingStatusRequest: pendingRequest?.requestedStatus ?? null,
  };
}

export async function readVehicleByVin(
  ctx: QueryCtx,
  args: { orgId: Id<"organizations">; vin: string },
  role: Doc<"roles">,
) {

  const vehicle = await ctx.db
    .query("vehicles")
    .withIndex("by_org_vin", (q) =>
      q.eq("orgId", args.orgId).eq("vin", args.vin.trim().toUpperCase())
    )
    .unique();
  return vehicle && !vehicle.isDeleted ? projectVehicleForRole(vehicle, role) : null;
}

export async function readVehicleLandedCosts(
  ctx: QueryCtx,
  args: { orgId: Id<"organizations">; vehicleId: Id<"vehicles"> },
  role: Doc<"roles">,
) {

  const vehicle = await ctx.db.get(args.vehicleId);
  if (!vehicle || vehicle.isDeleted || vehicle.orgId !== args.orgId) {
    throw new ConvexError("Vehicle not found in this organization.");
  }

  // The landed-cost breakdown is cost by definition: a caller who may not read vehicle cost
  // gets the same answer as for a car with no breakdown, which the screens already handle.
  if (!canReadVehicleCost(role)) return null;

  return await ctx.db
    .query("vehicleLandedCosts")
    .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId))
    .unique();
}
