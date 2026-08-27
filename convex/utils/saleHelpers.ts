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
/**
 * The customer who physically has this car and has not been recorded returning
 * it — or null when nobody does.
 *
 * ⚠️ Only a DEAD deal counts. A live handed-over deal is the ordinary state of
 * every financed sale between handover and finalization, and the commitment
 * authority is already holding the car for that customer; treating it as an
 * outstanding custody question would refuse the deal its own completion.
 * What this looks for is the case nothing else covers: the deal collapsed
 * AFTER the car left, so there is no sale, no claim, and no record of it
 * coming back.
 *
 * Streams rather than paging — a car with more applications than an arbitrary
 * limit must not read as having none.
 */
export async function customerHoldingHandedOverVehicle(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<Id<"customers"> | null> {
  for await (const app of ctx.db
    .query("financeApplications")
    .withIndex("by_vehicle", (q) => q.eq("vehicleId", vehicleId))) {
    if (app.orgId !== orgId) continue;
    if (!app.vehicleHandoverAt) continue;
    if (app.vehicleReturnedAt) continue;
    if (!(await handedOverDealIsDead(ctx, app))) continue;
    return app.customerId;
  }
  return null;
}

/**
 * Did the deal this handover belongs to actually END?
 *
 * ⚠️ THERE ARE TWO DOORS INTO A REVERSAL AND ONLY ONE SETS THE APPLICATION TO
 * CANCELLED. `applications.cancelApplication` does; `sales.update` with status
 * CANCELLED reverses the sale and leaves the application CLOSED. `sales.update`
 * says so itself: "this is the other door into the same reversal, and a lock
 * bolted on only one of them is not a lock."
 *
 * The custody gate was bolted onto one door. Through the other, a car that had
 * been handed over came back to the lot with no holder recorded, and a rival
 * sale completed on a vehicle sitting in somebody's driveway.
 *
 * Exported because the gate and its REMEDY must agree exactly — a rule whose
 * way out recognises fewer cases than the rule itself is a dead end, which is a
 * defect this same lane has already produced once.
 */
export async function handedOverDealIsDead(
  ctx: MutationCtx,
  app: Doc<"financeApplications">
): Promise<boolean> {
  if (app.status === "CANCELLED") return true;
  if (!app.finalizedSaleId) return false;
  const sale = await ctx.db.get(app.finalizedSaleId);
  return sale?.orgId === app.orgId && sale?.status === "CANCELLED";
}

export async function restoreVehicleFromSale(
  ctx: MutationCtx,
  vehicleId: Id<"vehicles">,
  opts?: {
    /**
     * The car left the lot on this deal. It is coming back out of a sale, not
     * back from a hold — so it is not lot stock until somebody says it is.
     */
    wasHandedOver?: boolean;
  }
): Promise<void> {
  const vehicle = await ctx.db.get(vehicleId);
  if (!vehicle || vehicle.status !== "SOLD") return;

  // A car in a customer's driveway is not AVAILABLE, whatever the snapshot
  // says. IN_INSPECTION is where it honestly is: back in the dealership's
  // hands on paper, not yet checked. ⚠️ This is the PROJECTION only — the
  // enforcement is `customerHoldingHandedOverVehicle` at the completion door,
  // because `utils/depositHelpers` is explicit that IN_INSPECTION describes
  // where a car is and never whether it is spoken for.
  if (opts?.wasHandedOver) {
    await ctx.db.patch(vehicleId, { status: "IN_INSPECTION", preHoldStatus: undefined });
    return;
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
