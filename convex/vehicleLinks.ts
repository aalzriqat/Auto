import { v, type Infer } from "convex/values";
import { api } from "./_generated/api";
import { query } from "./_generated/server";
import schema from "./schema";
import { PERMISSIONS } from "./utils/permissions";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";

const supplierVehicle = v.object({
  ...schema.tables.vehicles.validator.fields,
  _id: v.id("vehicles"),
  _creationTime: v.number(),
  imageUrls: v.array(v.union(v.string(), v.null())),
  addedByName: v.union(v.string(), v.null()),
  pendingStatusRequest: v.union(schema.tables.vehicleStatusRequests.validator.fields.requestedStatus, v.null()),
});

export const getSupplierTarget = query({
  args: { orgId: v.id("organizations"), linkValue: v.string() },
  returns: v.union(supplierVehicle, v.null()),
  handler: async (ctx, { orgId, linkValue }): Promise<Infer<typeof supplierVehicle> | null> => {
    await requireTenantAuth(ctx, orgId, [PERMISSIONS.VIEW_VEHICLES]);
    const vehicleId = ctx.db.normalizeId("vehicles", linkValue);
    if (!vehicleId) return null;
    const vehicle = await requireOwnedRow(ctx, orgId, "vehicles", vehicleId);
    if (vehicle.isDeleted) return null;
    return ctx.runQuery(api.vehicles.get, { orgId, vehicleId });
  },
});
