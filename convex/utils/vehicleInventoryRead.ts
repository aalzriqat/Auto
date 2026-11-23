import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { projectVehicleForRole } from "./vehicleCostVisibility";
import type { VehicleLifecycleStatus } from "./vehicleStatusGuards";
import type { PaginationOptions } from "convex/server";

const VEHICLE_SELECTOR_LIMIT = 50;
const RECENT_VEHICLE_SEARCH_WINDOW = 200;

function vehicleMatchesSearch(vehicle: Doc<"vehicles">, searchTerm: string) {
  const lowerSearchTerm = searchTerm.toLowerCase();
  return (
    vehicle.make.toLowerCase().includes(lowerSearchTerm) ||
    vehicle.model.toLowerCase().includes(lowerSearchTerm) ||
    String(vehicle.year).includes(lowerSearchTerm) ||
    (vehicle.vin?.toLowerCase().includes(lowerSearchTerm) ?? false)
  );
}

async function collectVehicleMatches(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  searchTerm: string,
): Promise<Doc<"vehicles">[]> {
  const matchesById = new Map<Id<"vehicles">, Doc<"vehicles">>();
  const addMatch = (vehicle: Doc<"vehicles">) => {
    if (vehicle.isDeleted || matchesById.has(vehicle._id)) return;
    matchesById.set(vehicle._id, vehicle);
  };

  const recentVehicles = await ctx.db
    .query("vehicles")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .filter((q) => q.neq(q.field("isDeleted"), true))
    .order("desc")
    .take(
      searchTerm.length >= 2
        ? RECENT_VEHICLE_SEARCH_WINDOW
        : VEHICLE_SELECTOR_LIMIT,
    );

  for (const vehicle of recentVehicles) {
    if (!searchTerm || vehicleMatchesSearch(vehicle, searchTerm)) {
      addMatch(vehicle);
    }
    if (matchesById.size >= VEHICLE_SELECTOR_LIMIT) break;
  }

  if (searchTerm.length >= 2 && matchesById.size < VEHICLE_SELECTOR_LIMIT) {
    const [makeMatches, modelMatches, vinMatches] = await Promise.all([
      ctx.db
        .query("vehicles")
        .withSearchIndex("search_make", (q) =>
          q.search("make", searchTerm).eq("orgId", orgId),
        )
        .filter((q) => q.neq(q.field("isDeleted"), true))
        .take(VEHICLE_SELECTOR_LIMIT),
      ctx.db
        .query("vehicles")
        .withSearchIndex("search_model", (q) =>
          q.search("model", searchTerm).eq("orgId", orgId),
        )
        .filter((q) => q.neq(q.field("isDeleted"), true))
        .take(VEHICLE_SELECTOR_LIMIT),
      ctx.db
        .query("vehicles")
        .withSearchIndex("search_vin", (q) =>
          q.search("vin", searchTerm).eq("orgId", orgId),
        )
        .filter((q) => q.neq(q.field("isDeleted"), true))
        .take(VEHICLE_SELECTOR_LIMIT),
    ]);

    for (const vehicle of [...makeMatches, ...modelMatches, ...vinMatches]) {
      addMatch(vehicle);
      if (matchesById.size >= VEHICLE_SELECTOR_LIMIT) break;
    }
  }

  return Array.from(matchesById.values());
}

export async function readVehicleSelectorOptions(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  search: string,
) {
  const matches = await collectVehicleMatches(ctx, orgId, search.trim());
  return matches.map((v) => ({
    _id: v._id,
    year: v.year,
    make: v.make,
    model: v.model,
    vin: v.vin,
    status: v.status,
  }));
}

export async function readVehicleInventoryPage(
  ctx: QueryCtx,
  args: { orgId: Id<"organizations">; status?: VehicleLifecycleStatus; paginationOpts: PaginationOptions },
  role: Doc<"roles">,
) {
  let q;

  if (args.status) {
    q = ctx.db.query("vehicles").withIndex("by_org_status", (q) =>
      q.eq("orgId", args.orgId).eq("status", args.status!)
    ).filter(q => q.neq(q.field("isDeleted"), true));
  } else {
    q = ctx.db.query("vehicles").withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter(q => q.neq(q.field("isDeleted"), true));
  }

  const pageResult = await q.order("desc").paginate(args.paginationOpts);

  const pendingRequests = await ctx.db
    .query("vehicleStatusRequests")
    .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "PENDING"))
    .collect();

  const pendingMap = new Map<string, string>();
  for (const req of pendingRequests) {
    pendingMap.set(req.vehicleId, req.requestedStatus);
  }

  const page = await Promise.all(
    pageResult.page.map(async (vehicle) => {
      const imageUrls = await Promise.all(
        (vehicle.imageIds ?? []).map((id) => ctx.storage.getUrl(id))
      );
      const addedByUser = vehicle.addedBy ? await ctx.db.get(vehicle.addedBy) : null;
      return {
        ...projectVehicleForRole(vehicle, role),
        imageUrls,
        addedByName: addedByUser?.name ?? addedByUser?.email ?? null,
        pendingStatusRequest: pendingMap.get(vehicle._id) ?? null
      };
    })
  );

  return { ...pageResult, page };
}

export async function readVehicleInventoryList(
  ctx: QueryCtx,
  args: {
    orgId: Id<"organizations">;
    status?: VehicleLifecycleStatus;
    includeReserved?: boolean;
    sourceType?: "STOCK" | "SOURCED";
  },
  role: Doc<"roles">,
) {
  let vehicles;

  if (args.status === "AVAILABLE" && args.includeReserved) {
    const [availableVehicles, reservedVehicles] = await Promise.all([
      ctx.db.query("vehicles").withIndex("by_org_status", (q) =>
        q.eq("orgId", args.orgId).eq("status", "AVAILABLE")
      ).filter(q => q.neq(q.field("isDeleted"), true)).order("desc").take(200),
      ctx.db.query("vehicles").withIndex("by_org_status", (q) =>
        q.eq("orgId", args.orgId).eq("status", "RESERVED")
      ).filter(q => q.neq(q.field("isDeleted"), true)).order("desc").take(200),
    ]);
    vehicles = [...availableVehicles, ...reservedVehicles];
  } else if (args.status) {
    vehicles = await ctx.db.query("vehicles").withIndex("by_org_status", (q) =>
      q.eq("orgId", args.orgId).eq("status", args.status!)
    ).filter(q => q.neq(q.field("isDeleted"), true)).order("desc").take(200);
  } else {
    vehicles = await ctx.db.query("vehicles").withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter(q => q.neq(q.field("isDeleted"), true)).order("desc").take(200);
  }

  const pendingRequests = await ctx.db
    .query("vehicleStatusRequests")
    .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "PENDING"))
    .collect();

  const pendingMap = new Map<string, string>();
  for (const req of pendingRequests) {
    pendingMap.set(req.vehicleId, req.requestedStatus);
  }

  if (args.sourceType) {
    // Treat null/undefined sourceType as "STOCK" (all pre-existing vehicles
    // have no sourceType field; they are dealer-owned stock by definition).
    vehicles = vehicles.filter((v) => (v.sourceType ?? "STOCK") === args.sourceType);
  }

  return await Promise.all(
    vehicles.map(async (vehicle) => {
      const docUrls = await Promise.all(
        (vehicle.imageIds || []).map((id) => ctx.storage.getUrl(id))
      );

      return {
        ...projectVehicleForRole(vehicle, role),
        pendingStatusRequest: pendingMap.get(vehicle._id) || null,
        imageUrls: docUrls,
      };
    })
  );
}
