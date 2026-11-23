import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { getOrgCurrency } from "../accounting/workflowHooks";
import { assertOpeningVehicleBasis } from "./openingVehicleBasis";
import { assertNoHeldSupplierConcession } from "./supplierConcession";
import { requireSupplierAmountMinor } from "./supplierPaymentAmounts";
import {
  hasVehicleAcquisitionAccountingExposure,
  hasVehicleLandedCostAccountingExposure,
} from "./vehicleAcquisition";
import { ConvexError } from "convex/values";

/** Read-only lock probes: known business refusals skip a row; unexpected failures abort the page. */
async function sourcedMirrorRepairLocked(ctx: MutationCtx, vehicle: Doc<"vehicles">): Promise<boolean> {
  if (vehicle.status === "SOLD" ||
      await hasVehicleAcquisitionAccountingExposure(ctx, vehicle.orgId, vehicle._id) ||
      await hasVehicleLandedCostAccountingExposure(ctx, vehicle.orgId, vehicle._id)) return true;
  try {
    await assertNoHeldSupplierConcession(ctx, vehicle.orgId, vehicle._id);
    return await assertOpeningVehicleBasis(ctx, vehicle.orgId, vehicle._id) === "POSTED";
  } catch (error) {
    if (error instanceof ConvexError) return true;
    throw error;
  }
}

type SourcedMirrorRepairOutcome = "UNCHANGED" | "INVALID" | "LOCKED" | "REPAIR";

async function sourcedMirrorRepairOutcome(ctx: MutationCtx, vehicle: Doc<"vehicles">): Promise<SourcedMirrorRepairOutcome> {
  if (vehicle.isDeleted || vehicle.sourceType !== "SOURCED" || vehicle.purchasePrice === vehicle.sourceCost) return "UNCHANGED";
  if (!await validSourcedMirrorCost(ctx, vehicle)) return "INVALID";
  return await sourcedMirrorRepairLocked(ctx, vehicle) ? "LOCKED" : "REPAIR";
}

async function validSourcedMirrorCost(ctx: MutationCtx, vehicle: Doc<"vehicles">): Promise<boolean> {
  const amount = vehicle.sourceCost;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return false;
  const currency = await getOrgCurrency(ctx, vehicle.orgId);
  try {
    requireSupplierAmountMinor(amount, currency);
    return true;
  } catch (error) {
    if (error instanceof ConvexError) return false;
    throw error;
  }
}

/** SCRUM-907. Internal rollout only, one native page per transaction; never rewrites posted cost history. */
export async function repairVehicleCostMirrors(
  ctx: MutationCtx,
  args: { cursor?: string | null; numItems?: number },
) {
  try {
    const size = args.numItems ?? 25;
    if (!Number.isSafeInteger(size) || size < 1 || size > 25) {
      throw new ConvexError("Invalid repair page size.");
    }
    const page = await ctx.db.query("vehicles").paginate({ numItems: size, cursor: args.cursor ?? null });
    // Probes only read; the page's patches then run together. Any unexpected failure still rejects the whole page.
    const outcomes = await Promise.all(page.page.map((vehicle) => sourcedMirrorRepairOutcome(ctx, vehicle)));
    const repairs = page.page.filter((_, index) => outcomes[index] === "REPAIR");
    await Promise.all(repairs.map((vehicle) => ctx.db.patch(vehicle._id, { purchasePrice: vehicle.sourceCost })));
    const count = (outcome: SourcedMirrorRepairOutcome): number => outcomes.filter((o) => o === outcome).length;
    return {
      scanned: page.page.length, updated: repairs.length, skippedLocked: count("LOCKED"), skippedInvalid: count("INVALID"),
      isDone: page.isDone, continueCursor: page.continueCursor,
    };
  } catch (error) {
    console.error("SOURCED cost mirror repair failed", error);
    // Throw, never return an error after a write: the entire page must roll back.
    throw new ConvexError("Unable to repair vehicle costs. Please try again later.");
  }
}
