import { type MutationCtx } from "../../_generated/server";
import { type Id } from "../../_generated/dataModel";
import { postDomainEvent } from "./posting";
import { makeReversalHook } from "./reversal";
import { type AcquisitionCorrectionType } from "../postingRules";

// ─── Vehicle inventory capitalization ─────────────────────────────────────────
export async function hookVehicleAcquired(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    costMinor: number;
    currency: string;
    paymentMethod?: string;
    bankAccountId?: Id<"bankAccounts">;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "VEHICLE_ACQUIRED",
    sourceType: "vehicles",
    sourceId: args.vehicleId.toString(),
    idempotencyKey: `vehicle_acquired_${args.vehicleId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      vehicleId: args.vehicleId.toString(),
      costMinor: args.costMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
      bankAccountId: args.bankAccountId,
    },
  });
}

export async function hookTradeInAccepted(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    saleId: Id<"sales">;
    customerId: Id<"customers">;
    tradeInValueMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "TRADE_IN_ACCEPTED",
    sourceType: "vehicles",
    sourceId: args.vehicleId.toString(),
    idempotencyKey: `trade_in_accepted_${args.saleId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      vehicleId: args.vehicleId.toString(),
      saleId: args.saleId.toString(),
      customerId: args.customerId.toString(),
      tradeInValueMinor: args.tradeInValueMinor,
      currency: args.currency,
    },
  });
}

/**
 * Reverses the TRADE_IN_ACCEPTED entry when the sale it was part of is
 * cancelled. reversalKey includes saleId, not just vehicleId — the same
 * vehicle can be traded in again on a later sale once its purchasePrice is
 * cleared, and a vehicle-only key would collide with an earlier trade-in's
 * reversal, causing reverseAccountingEvent's own idempotency check to report
 * "already reversed" without ever reversing the second sale's entry.
 */
export const hookTradeInReversed = makeReversalHook<{ vehicleId: Id<"vehicles">; saleId: Id<"sales"> }>({
  eventType: "TRADE_IN_ACCEPTED",
  sourceType: "vehicles",
  sourceId: (a) => a.vehicleId.toString(),
  reversalKey: (a) => `trade_in_reversed_${a.vehicleId}_${a.saleId}`,
  pendingPostKey: (a) => `trade_in_accepted_${a.saleId}`,
});

/**
 * Each landed-cost edit is its own economic event (upsertLandedCosts replaces
 * the whole items list every save), so the idempotency/source key includes
 * `editToken` — a caller-supplied per-edit discriminator (the landed-cost
 * row's updatedAt after the patch) rather than being derived from vehicleId
 * alone, which would collide across edits.
 */
export async function hookVehicleLandedCostCapitalized(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    editToken: string;
    /** Per-account signed deltas — see VehicleLandedCostCapitalizedPayload. */
    accountDeltas: Array<{ paymentMethod?: string; bankAccountId?: Id<"bankAccounts">; deltaMinor: number }>;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "VEHICLE_LANDED_COST_CAPITALIZED",
    sourceType: "vehicleLandedCosts",
    sourceId: `${args.vehicleId}_${args.editToken}`,
    idempotencyKey: `landed_cost_${args.vehicleId}_${args.editToken}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      vehicleId: args.vehicleId.toString(),
      // Net total kept at the top level too — accountingMigration.ts's
      // backfill reads this scalar to exclude already-posted landed-cost
      // amounts from its opening-balance calculation without needing to
      // know about the per-account breakdown.
      deltaMinor: args.accountDeltas.reduce((sum, d) => sum + d.deltaMinor, 0),
      accountDeltas: args.accountDeltas,
      currency: args.currency,
    },
  });
}

export async function hookVehicleAcquisitionCostCorrected(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    correctionToken: string;
    deltaMinor: number;
    currency: string;
    correctionType?: AcquisitionCorrectionType;
    paymentMethod?: string;
    bankAccountId?: Id<"bankAccounts">;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "VEHICLE_ACQUISITION_COST_CORRECTED",
    sourceType: "vehicleCostCorrections",
    sourceId: `${args.vehicleId}_${args.correctionToken}`,
    idempotencyKey: `vehicle_cost_corrected_${args.vehicleId}_${args.correctionToken}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      vehicleId: args.vehicleId.toString(),
      deltaMinor: args.deltaMinor,
      currency: args.currency,
      correctionType: args.correctionType,
      paymentMethod: args.paymentMethod,
      bankAccountId: args.bankAccountId?.toString(),
    },
  });
}

export async function hookVehiclePrepExpenseReclassified(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    expenseId: Id<"expenses">;
    vehicleId: Id<"vehicles">;
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "VEHICLE_PREP_EXPENSE_RECLASSIFIED",
    sourceType: "expenses",
    sourceId: args.expenseId.toString(),
    idempotencyKey: `vehicle_prep_expense_reclassified_${args.expenseId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      vehicleId: args.vehicleId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
    },
  });
}
