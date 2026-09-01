import { ConvexError } from "convex/values";
import { MutationCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";
import { Doc } from "../_generated/dataModel";
import { recordLeadActivity } from "./leadActivity";

/**
 * Marks a vehicle sold AND records which sale did it.
 *
 * The two are one write on purpose. A SOLD status whose owner is recorded
 * separately — or later — is a window in which the projection exists with no
 * author, and `restoreVehicleFromSale` refuses to act inside that window.
 */
export async function markVehicleAsSold(
  ctx: MutationCtx,
  vehicleId: Id<"vehicles">,
  saleId: Id<"sales">
): Promise<void> {
  await ctx.db.patch(vehicleId, { status: "SOLD" as const, soldBySaleId: saleId });
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
  vehicleId: Id<"vehicles">,
  saleId: Id<"sales">
): Promise<void> {
  const vehicle = await ctx.db.get(vehicleId);

  // Nothing to give back. The car is not sold, so this sale has no inventory
  // projection standing anywhere — a cancelled sale being tidied up later, or
  // a draft that never took the car off the lot.
  if (!vehicle || vehicle.status !== "SOLD") return;

  // ⚠️ OWNERSHIP IS PROVEN, NEVER INFERRED FROM THE STATUS — SCRUM-212.
  //
  // This used to take a vehicleId alone and free any SOLD car it was handed.
  // That reads the projection as its own authority, which it is not: once
  // sale A is cancelled the car can be sold again as B, and A's paperwork
  // then names a car that B owns. Freeing it there left B COMPLETED with its
  // GL posted against a car the lot was offering for sale.
  //
  // Refusing rather than returning quietly, because reaching here at all means
  // a caller believes it is reversing a projection it does not own. On fresh
  // data the fixed doors make that unreachable — teardown runs only inside the
  // one COMPLETED -> CANCELLED transition, where the car is provably still
  // this sale's — so this throw is the floor under that argument, not a case
  // the product is expected to hit. A silent no-op would instead leave a
  // cancelled sale beside a SOLD car and no signal that they disagree.
  //
  // A SOLD car with no owner recorded fails the same way and for the same
  // reason: missing authority is not permission. There is deliberately no
  // legacy fallback (c16229 item 5).
  //
  // ⚠️ THE TWO CAUSES GET DIFFERENT MESSAGES, because they are different facts
  // and only one of them names something the operator can act on. A single
  // message covering both told the operator the car "was sold again" and to
  // cancel that later sale — when for a car with no recorded owner there IS no
  // later sale, so the instruction pointed at nothing. The Sonnet MAX seat
  // reproduced that through the real cancellation door.
  if (vehicle.soldBySaleId === undefined) {
    throw new ConvexError(
      "This car does not record which sale marked it sold, so returning it to the lot cannot be done automatically — doing it blind could take the car from a different sale. Nothing is wrong with this sale; the car simply predates sale-ownership tracking. A manual correction is needed."
    );
  }
  if (String(vehicle.soldBySaleId) !== String(saleId)) {
    throw new ConvexError(
      "This car's current sale is not the sale being reversed, so it cannot be returned to the lot from here. It was sold again after this sale was cancelled, and that later sale still owns it — cancel that sale instead."
    );
  }

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
    // Cleared with the status it authorises. Leaving it behind would name a
    // sale that no longer owns a car that is no longer sold.
    soldBySaleId: undefined,
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
    /** Exact provenance, so cancellation can void THIS sale's row and no other. */
    saleId: Id<"sales">;
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
    // Revenue recognized in THIS period, independent of when the cash arrived.
    //
    // Written always now, on both bases, and never netted down by a عربون:
    // the full sale price on the dealership's own stock, the full agency
    // margin on a consigned car. `amount` above stays net, because that is the
    // operational cash figure other screens read — the two are different
    // questions and were previously answered with one number.
    //
    // It used to be omitted whenever it equalled `salePrice - previouslyCollected`,
    // which meant an owned sale with a deposit fell back to that net `amount`
    // and recognized less revenue than it earned, in a period chosen by when
    // the customer happened to pay.
    recognizedRevenueAmount:
      args.recognizedRevenue ?? args.salePrice,
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
    saleId: args.saleId,
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
