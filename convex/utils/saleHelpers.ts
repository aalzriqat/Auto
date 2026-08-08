import { MutationCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";
import { Doc } from "../_generated/dataModel";
import { recordLeadActivity } from "./leadActivity";

export async function markVehicleAsSold(
  ctx: MutationCtx,
  vehicleId: Id<"vehicles">
): Promise<void> {
  await ctx.db.patch(vehicleId, { status: "SOLD" as const });
}

/**
 * Puts a vehicle back on the lot after its sale is cancelled/reversed.
 *
 * A SOURCED (drop-ship) car that has NOT arrived has never been owned — it is
 * located at another dealer on a customer's behalf and only ever credits
 * AP-Suppliers, never Vehicle Inventory. Blanket-restoring it to AVAILABLE
 * presented a car the dealership does not possess as owned stock on the lot,
 * and counted its cost as owned inventory value. It goes back to SOURCING
 * instead, where the special order resumes.
 *
 * A sourced car that HAS arrived is physically on the lot, so it returns to
 * AVAILABLE like any other. Sending it back to SOURCING would drop it out of
 * the public marketplace (marketplaceBrowse only lists AVAILABLE/SOLD) even
 * though it is sitting there ready to sell.
 */
export async function restoreVehicleFromSale(
  ctx: MutationCtx,
  vehicleId: Id<"vehicles">
): Promise<void> {
  const vehicle = await ctx.db.get(vehicleId);
  if (!vehicle || vehicle.status !== "SOLD") return;

  // `preHoldStatus` is a snapshot, and two things can make it wrong by the time
  // a sale is cancelled:
  //
  //  - The car arrived after the hold was taken. The snapshot still says
  //    SOURCING, but the car is physically on the lot, and SOURCING would drop
  //    it out of the public marketplace (marketplaceBrowse lists AVAILABLE/SOLD
  //    only) while it sits there ready to sell.
  //  - The dealership bought the car outright, flipping sourceType to STOCK.
  //    That needs no status transition, so the workflow guard permits it and
  //    the stale snapshot would park owned stock in the sourcing lifecycle.
  //
  // Both mean the same thing: a SOURCING snapshot only still applies to a car
  // that is genuinely still sourced and still elsewhere. Mirrors the identical
  // guard in resolveHoldTargetStatus (utils/depositHelpers.ts).
  const stillOnOrder = vehicle.sourceType === "SOURCED" && vehicle.arrivedAt == null;
  const snapshot = vehicle.preHoldStatus === "SOURCING" && !stillOnOrder
    ? undefined
    : vehicle.preHoldStatus;

  await ctx.db.patch(vehicleId, {
    status: snapshot ?? (stillOnOrder ? ("SOURCING" as const) : ("AVAILABLE" as const)),
    preHoldStatus: undefined,
  });
}

export async function createSaleTransaction(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    salePrice: number;
    saleDate: number;
    vehicle: Doc<"vehicles">;
    customer: Doc<"customers">;
    /** Amount already booked as separate DEPOSIT transactions for this deal — subtracted so it isn't double-counted as revenue. */
    previouslyCollected?: number;
    /**
     * Accounting turnover, when it differs from the sale price — the margin on
     * a consigned sale. Omitted for owned stock, where the two are the same.
     */
    recognizedRevenue?: number;
    idempotencyKey?: string;
  }
): Promise<void> {
  const vehicleLabel = `${args.vehicle.year} ${args.vehicle.make} ${args.vehicle.model}`.trim();
  const customerLabel =
    `${args.customer.firstName ?? ""} ${args.customer.lastName ?? ""}`.trim() || "Customer";
  const vinLabel = args.vehicle.vin ? ` (VIN: ${args.vehicle.vin})` : "";

  await ctx.db.insert("transactions", {
    orgId: args.orgId,
    type: "IN",
    amount: args.salePrice - (args.previouslyCollected ?? 0),
    // Kept as the gross so the operational ledger still says what the deal was
    // worth. What must NOT come from it is turnover: getProfitAndLoss sums this
    // category as revenue, which reported a consigned sale at its sticker price
    // while the sales report reported the margin — the same month, two answers.
    ...(args.recognizedRevenue !== undefined &&
    args.recognizedRevenue !== args.salePrice - (args.previouslyCollected ?? 0)
      ? { recognizedRevenueAmount: args.recognizedRevenue }
      : {}),
    // The deal at face value, kept separately because `amount` above is net of
    // whatever was already collected. Without it the P&L had to infer the gross
    // from a net figure and reported a smaller deal for every customer who put
    // money down.
    grossTransactionValueAmount: args.salePrice,
    date: args.saleDate,
    category: "VEHICLE_SALE",
    description: `Sale of vehicle ${vehicleLabel} to ${customerLabel}${vinLabel}`,
    vehicleId: args.vehicleId,
    customerId: args.customer._id,
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
      await recordLeadActivity(ctx, {
        orgId: args.orgId,
        leadId: args.leadId,
        action: "STAGE_CHANGED",
        actorLabel: "Sale recorded",
        field: "stage",
        fromValue: lead.stage,
        toValue: "WON",
      });
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
    await recordLeadActivity(ctx, {
      orgId: args.orgId,
      leadId: lead._id,
      action: "STAGE_CHANGED",
      actorLabel: "Sale recorded",
      field: "stage",
      fromValue: lead.stage,
      toValue: "WON",
    });
  }
}
