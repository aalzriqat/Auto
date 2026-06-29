import { MutationCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";
import { Doc } from "../_generated/dataModel";

export async function markVehicleAsSold(
  ctx: MutationCtx,
  vehicleId: Id<"vehicles">
): Promise<void> {
  await ctx.db.patch(vehicleId, { status: "SOLD" as const });
}

export async function restoreVehicleToAvailable(
  ctx: MutationCtx,
  vehicleId: Id<"vehicles">
): Promise<void> {
  const vehicle = await ctx.db.get(vehicleId);
  if (vehicle && vehicle.status === "SOLD") {
    await ctx.db.patch(vehicleId, { status: "AVAILABLE" as const });
  }
}

export async function createSaleTransaction(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    salePrice: number;
    saleDate: number;
    vehicle: Doc<"vehicles">;
    /** Amount already booked as separate DEPOSIT transactions for this deal — subtracted so it isn't double-counted as revenue. */
    previouslyCollected?: number;
    idempotencyKey?: string;
  }
): Promise<void> {
  await ctx.db.insert("transactions", {
    orgId: args.orgId,
    type: "IN",
    amount: args.salePrice - (args.previouslyCollected ?? 0),
    date: args.saleDate,
    category: "VEHICLE_SALE",
    description: `Sale of vehicle ${args.vehicle.year} ${args.vehicle.make} ${args.vehicle.model} (VIN: ${args.vehicle.vin})`,
    vehicleId: args.vehicleId,
    idempotencyKey: args.idempotencyKey,
  });
}

export async function closeLeadsAsWon(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    customerId: Id<"customers">;
    vehicleId: Id<"vehicles">;
    leadId?: Id<"leads">;
  }
): Promise<void> {
  if (args.leadId) {
    const lead = await ctx.db.get(args.leadId);
    if (lead && lead.orgId === args.orgId && lead.stage !== "WON" && lead.stage !== "LOST") {
      await ctx.db.patch(args.leadId, { stage: "WON" as const });
    }
    return;
  }

  // Fallback for sales/quotes created before the explicit leadId link existed.
  const leads = await ctx.db
    .query("leads")
    .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
    .filter((q) =>
      q.and(
        q.eq(q.field("customerId"), args.customerId),
        q.eq(q.field("vehicleId"), args.vehicleId),
        q.neq(q.field("stage"), "WON"),
        q.neq(q.field("stage"), "LOST")
      )
    )
    .collect();

  for (const lead of leads) {
    await ctx.db.patch(lead._id, { stage: "WON" as const });
  }
}
