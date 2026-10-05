import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { acquireVehicle, assertAcquirable } from "../commitments";
import { holdVehicleForDeposit } from "./depositHelpers";
import {
  assertNoQuoteLinkedReservationDeposit,
  assertReservationAdoptableWithoutDeposit,
} from "./depositRequestGuards";
import {
  amountToMinorOrThrow,
  recordHeldDeposit,
  type DepositMethod,
} from "./depositRecording";

/**
 * Sum of what the quote's deposits still hold, in minor units. Released parts
 * come off, so a partly refunded deposit does not block putting the money down
 * again.
 */
export async function activeQuoteDepositMinor(
  ctx: MutationCtx,
  quoteId: Id<"quotes">,
  currency: string
): Promise<number> {
  const existingDeposits = await ctx.db
    .query("deposits")
    .withIndex("by_quote", (q) => q.eq("quoteId", quoteId))
    .collect();
  return existingDeposits.reduce((sum, deposit) => {
    if (deposit.isDeleted === true) return sum;
    if (deposit.status !== "HELD" && deposit.status !== "APPLIED") return sum;
    const rowMinor = deposit.amountMinor ?? amountToMinorOrThrow(deposit.amount, currency);
    return sum + Math.max(0, rowMinor - (deposit.releasedAmountMinor ?? 0));
  }, 0);
}

/**
 * SCRUM-444 — THE money-moving body of "take a deposit against a quote",
 * lifted out of `deposits.create` so the two authorised doors (`deposits.create`
 * and `depositRequests.confirm`) run identical code and cannot drift.
 *
 * ⚠️ NO AUTHORISATION HERE. Both callers must already have required
 * CONFIRM_FINANCE_DISBURSEMENT; this function posts DEPOSIT_RECEIVED and
 * acquires the vehicle commitment for whoever calls it. Nor is it idempotent on
 * its own — callers wrap it in `runWithIdempotency`.
 *
 * Every refusal (over-deposit, commitment) happens BEFORE the first write.
 */
export async function postQuoteDeposit(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    quote: Doc<"quotes">;
    amount: number;
    amountMinor: number;
    currency: string;
    method: DepositMethod;
    notes?: string;
    idempotencyKey: string;
    actorId: Id<"users">;
    adoptReservationId?: Id<"vehicleReservations">;
  }
): Promise<Id<"deposits">> {
  const { quote } = args;
  // SCRUM-444 R-B: a funded reservation is never adopted; release its deposit first.
  if (args.adoptReservationId) {
    await assertReservationAdoptableWithoutDeposit(ctx, {
      orgId: args.orgId,
      reservationId: args.adoptReservationId,
    });
  }
  // SCRUM-444 F1: fail closed on a receipt this quote's totals cannot see.
  await assertNoQuoteLinkedReservationDeposit(ctx, quote);
  const quoteAmountMinor = amountToMinorOrThrow(quote.vehiclePrice, args.currency, "Quote amount");
  const existingActiveMinor = await activeQuoteDepositMinor(ctx, quote._id, args.currency);
  if (existingActiveMinor + args.amountMinor > quoteAmountMinor) {
    throw new ConvexError("Total deposits cannot exceed the quote amount.");
  }

  // A multi-vehicle quote holds every vehicle on the deal, not just the first.
  const depositVehicleItems = quote.vehicleItems ?? [{ vehicleId: quote.vehicleId }];

  // SCRUM-195: ask the AUTHORITY before moving a car's status; it refuses
  // BEFORE any side effect.
  // SCRUM-641: each car is read ONCE here and the document is handed to the authority checks and the
  // hold below, so the liveness guard costs no extra read per car.
  const loadedVehicles = new Map<Id<"vehicles">, Doc<"vehicles">>();
  for (const item of depositVehicleItems) {
    const vehicle = (await ctx.db.get(item.vehicleId)) ?? undefined;
    if (vehicle) loadedVehicles.set(item.vehicleId, vehicle);
    await assertAcquirable(ctx, {
      orgId: args.orgId,
      vehicleId: item.vehicleId,
      lineage: { quoteId: quote._id, adoptReservationId: args.adoptReservationId },
      vehicle,
    });
  }
  for (const item of depositVehicleItems) {
    await holdVehicleForDeposit(ctx, item.vehicleId, loadedVehicles.get(item.vehicleId));
  }

  const now = Date.now();
  const depositId = await recordHeldDeposit(ctx, {
    orgId: args.orgId,
    vehicleId: quote.vehicleId,
    customerId: quote.customerId,
    quoteId: quote._id,
    amount: args.amount,
    amountMinor: args.amountMinor,
    currency: args.currency,
    method: args.method,
    idempotencyKey: args.idempotencyKey,
    notes: args.notes,
    actorId: args.actorId,
    now,
    sourceLabel: `quote ${quote._id}`,
    // SCRUM-208 — the same condition that decides whether hold rows are written.
    usesVehicleHoldRows: depositVehicleItems.length > 1,
  });

  // SCRUM-195: record WHOSE deal now holds each car, on the strength of THIS deposit.
  const episodeByVehicle = new Map<string, Id<"vehicleCommitmentClaims">>();
  for (const item of depositVehicleItems) {
    const { claimId } = await acquireVehicle(ctx, {
      orgId: args.orgId,
      vehicleId: item.vehicleId,
      customerId: quote.customerId,
      createdBy: args.actorId,
      evidence: { kind: "DEPOSIT", depositId },
      lineage: { quoteId: quote._id, adoptReservationId: args.adoptReservationId },
      vehicle: loadedVehicles.get(item.vehicleId),
    });
    episodeByVehicle.set(String(item.vehicleId), claimId);
  }

  // Only multi-vehicle deposits need a join row per vehicle.
  if (depositVehicleItems.length > 1) {
    for (const item of depositVehicleItems) {
      const sourceCommitmentClaimId = episodeByVehicle.get(String(item.vehicleId));
      if (!sourceCommitmentClaimId) {
        throw new Error(
          `no commitment episode was recorded for vehicle ${item.vehicleId} on deposit ${depositId}`
        );
      }
      await ctx.db.insert("depositVehicleHolds", {
        orgId: args.orgId,
        depositId,
        vehicleId: item.vehicleId,
        active: true,
        createdAt: now,
        sourceCommitmentClaimId,
      });
    }
  }

  return depositId;
}
