import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { getOrgCurrency } from "../accounting/workflowHooks";
import { acquireVehicle, assertAcquirable, releaseRootIfNoLiveBasis, resolveOwnership } from "../commitments";
import { releaseReservationDepositHold } from "./commitmentWriters";
import { getActiveDepositHolds, getDefaultReservationExpiry, syncVehicleHoldStatus } from "./depositHelpers";
import {
  type DepositMethod,
  amountToMinorOrThrow,
  normalizeCurrency,
  recordHeldDeposit,
  requireDepositMethod,
} from "./depositRecording";
import { notifyManagers } from "./notifications";
import { requireOwnedRow } from "./tenancy";
import { ConvexError } from "convex/values";

type VehicleReservationInput = {
  orgId: Id<"organizations">;
  vehicleId: Id<"vehicles">;
  customerId: Id<"customers">;
  depositBankAccountId?: Id<"bankAccounts">;
  dealQuoteId?: Id<"quotes">;
  dealDepositId?: Id<"deposits">;
  depositAmount?: number;
  depositMethod?: DepositMethod;
  expiresAt?: number;
  idempotencyKey: string;
};

export async function insertVehicleReservation(
  ctx: MutationCtx,
  args: VehicleReservationInput,
  user: Doc<"users">,
) {
  const vehicle = await requireOwnedRow(ctx, args.orgId, "vehicles", args.vehicleId, "Vehicle not found in this organization.");
  if (vehicle.isDeleted) {
    throw new ConvexError("Vehicle not found in this organization.");
  }

  const customer = await requireOwnedRow(ctx, args.orgId, "customers", args.customerId, "Customer not found in this organization.");
  if (customer.isDeleted) {
    throw new ConvexError("Customer not found in this organization.");
  }

  const now = Date.now();
  if (args.expiresAt !== undefined && args.expiresAt <= now) {
    throw new ConvexError("Reservation expiry must be in the future.");
  }
  const resolvedExpiresAt = args.expiresAt ?? (await getDefaultReservationExpiry(ctx, args.orgId, now));

  const hasDeposit = args.depositAmount !== undefined;
  if (!hasDeposit && args.depositBankAccountId) {
    throw new ConvexError("A reservation without a deposit cannot name a receiving bank.");
  }
  const currency = hasDeposit ? normalizeCurrency(await getOrgCurrency(ctx, args.orgId)) : undefined;
  // SCRUM-445: a deposit's method is asked, never defaulted to CASH.
  // SCRUM-469: with no deposit there is no money and so no method to judge or
  // store; it is undefined, not a fabricated CASH.
  const method = hasDeposit ? requireDepositMethod(args.depositMethod) : undefined;
  const amountMinor = hasDeposit
    ? amountToMinorOrThrow(args.depositAmount!, currency!, "Reservation deposit amount")
    : undefined;

  // ACTIVE-only and streamed, not a fixed page. `by_org_vehicle` returned
  // oldest-first over every status, so on a vehicle with 100+ historical
  // released/expired reservations a live one fell outside the window — the
  // expiry sweep below missed it and the duplicate check further down let a
  // second active reservation be written on top of it. Narrowing to ACTIVE
  // alone does not close that: a reservation stays ACTIVE until this very
  // sweep expires it, so unswept rows can still fill a page ahead of the live
  // one. Collecting the whole ACTIVE range is bounded in practice — a vehicle
  // holds at most one live reservation, and the rest are rows this loop is
  // about to retire.
  const existingReservations = await ctx.db
    .query("vehicleReservations")
    .withIndex("by_org_vehicle_status", (q) =>
      q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId).eq("status", "ACTIVE")
    )
    .collect();
  for (const reservation of existingReservations) {
    if (reservation.expiresAt !== undefined && reservation.expiresAt <= now) {
      await releaseReservationDepositHold(ctx, {
        orgId: args.orgId,
        reservation,
        reason: "reservation expired during reservation attempt",
      });
      await ctx.db.patch(reservation._id, {
        status: "EXPIRED",
        expiredAt: now,
      });
      // Same reasoning as the cron sweep: this is the last door that can
      // close the expired deal's root. It runs BEFORE the acquisition below,
      // so the next customer is not refused a car nobody holds any more.
      await releaseRootIfNoLiveBasis(ctx, {
        orgId: args.orgId,
        vehicleId: reservation.vehicleId,
        reason: "reservation expired",
        decisionNow: now,
      });
    }
  }
  await syncVehicleHoldStatus(ctx, args.vehicleId, user._id);
  const currentVehicle = await ctx.db.get(args.vehicleId);
  if (!currentVehicle || currentVehicle.isDeleted || currentVehicle.orgId !== args.orgId) {
    throw new ConvexError("Vehicle not found in this organization.");
  }
  // SOURCING is reservable: a special-order car is located for a specific
  // customer, so reserving one is the whole point of the flow.
  //
  // RESERVED has to be accepted too, and the ordering above is why. The
  // `syncVehicleHoldStatus` call on the line before this promotes any vehicle
  // that already carries a deposit hold to RESERVED — so by the time the
  // status is re-read, a car being reserved *because* a deposit was taken on
  // it always reads RESERVED. Rejecting that threw and rolled the promotion
  // back with it, leaving the vehicle exactly as it started: the sourced car
  // this flow exists to reserve could never get past this line. Reserving on
  // top of someone else's deposit is still refused, just below.
  const reservableStatuses = ["AVAILABLE", "SOURCING", "RESERVED"];
  if (!reservableStatuses.includes(currentVehicle.status)) {
    throw new ConvexError("Vehicle must be available or on order before it can be reserved.");
  }
  // Every row here was ACTIVE when read; the loop above may since have
  // patched some to EXPIRED, and those are exactly the ones whose expiry has
  // passed — so the expiry comparison, not the now-stale in-memory `status`,
  // is what distinguishes a reservation that still stands.
  if (existingReservations.some(
    (reservation) => reservation.expiresAt === undefined || reservation.expiresAt > now
  )) {
    throw new ConvexError("Vehicle already has an active reservation.");
  }
  // A hold belonging to a different customer still blocks the reservation —
  // accepting RESERVED above must not let customer B reserve a car that
  // customer A's deposit is holding.
  //
  // Resolved through getActiveDepositHolds so a *secondary* vehicle on a
  // multi-vehicle quote is covered too: those are recorded only in
  // depositVehicleHolds, so querying deposits.by_vehicle_hold alone reported
  // car 2 of a three-car deal as unheld and would have let a second customer
  // reserve it out from under the first.
  const holdingDeposits = await getActiveDepositHolds(ctx, args.vehicleId);
  if (
    holdingDeposits.some(
      (deposit) => deposit.orgId === args.orgId && deposit.customerId !== args.customerId
    )
  ) {
    throw new ConvexError("Another customer's deposit is currently holding this vehicle.");
  }

  // SCRUM-195: the AUTHORITY decides, and it decides before anything is
  // written. The three checks above are real and stay — but each answers a
  // different question (where the car IS, whether an older reservation
  // stands, whether a deposit holds it) and none of them answers "whose deal
  // is this car on". A reservation has no quote yet, so it presents no
  // lineage: it may only take a car that is genuinely FREE.
  await assertAcquirable(ctx, {
    orgId: args.orgId,
    vehicleId: args.vehicleId,
    lineage: { quoteId: args.dealQuoteId, depositId: args.dealDepositId },
    // This door can present a deposit as its proof WITHOUT a quote, so the
    // authority would otherwise have no one to check the proof against. The
    // customer being reserved for is the operation's own participant — it
    // proves nothing by itself, and is used only to refuse.
    actingCustomerId: args.customerId,
    vehicle: currentVehicle,
  });

  const reservationId = await ctx.db.insert("vehicleReservations", {
    orgId: args.orgId,
    vehicleId: args.vehicleId,
    customerId: args.customerId,
    depositAmount: args.depositAmount,
    depositAmountMinor: amountMinor,
    depositCurrency: currency,
    depositMethod: hasDeposit ? method : undefined,
    expiresAt: resolvedExpiresAt,
    status: "ACTIVE",
    reservedBy: user._id,
    reservedAt: now,
  });

  let reservationDepositId: Id<"deposits"> | undefined;
  if (hasDeposit && amountMinor !== undefined && currency !== undefined && method !== undefined) {
    const depositId = await recordHeldDeposit(ctx, {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      customerId: args.customerId,
      reservationId,
      amount: args.depositAmount!,
      amountMinor,
      currency,
      method,
      bankAccountId: args.depositBankAccountId,
      actorId: user._id,
      now,
      sourceLabel: `reservation ${reservationId}`,
      // A reservation's deposit holds exactly the car it was taken on, and
      // this door writes no `depositVehicleHolds` rows — so the row's own
      // `holdActive` IS the hold. DIRECT.
      usesVehicleHoldRows: false,
    });
    await ctx.db.patch(reservationId, { depositId });
    reservationDepositId = depositId;
  }

  // SCRUM-195: a standalone reservation is a deal in its own right and opens
  // its own root. A later quote joins that root only by adopting the
  // reservation explicitly.
  //
  // ⚠️ THE EVIDENCE IS THE RESERVATION, NOT ITS DEPOSIT. The deposit taken
  // alongside is carried as context and is deliberately NOT the defining
  // reference: treating it as one is how a consumed reservation episode came
  // back as a live DEPOSIT-kind claim on a second root, silently, with the
  // reservation reference simply absent (SCRUM-200).
  await acquireVehicle(ctx, {
    orgId: args.orgId,
    vehicleId: args.vehicleId,
    customerId: args.customerId,
    createdBy: user._id,
    evidence: {
      kind: "RESERVATION",
      reservationId,
      ...(reservationDepositId ? { depositId: reservationDepositId } : {}),
    },
    // A reservation on a car this deal already holds JOINS that deal on the
    // proof presented; a reservation on a FREE car opens the deal's root and
    // is known by this reservation from then on.
    lineage: {
      reservationId,
      quoteId: args.dealQuoteId,
      depositId: args.dealDepositId,
    },
    vehicle: currentVehicle,
  });

  await syncVehicleHoldStatus(ctx, args.vehicleId, user._id);

  return reservationId;
}

export async function expireVehicleReservations(
  ctx: MutationCtx,
  args: { limit?: number },
) {
  const now = Date.now();
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
  const reservations = await ctx.db
    .query("vehicleReservations")
    .withIndex("by_status_expiresAt", (q) =>
      q.eq("status", "ACTIVE").lte("expiresAt", now)
    )
    .take(limit);

  for (const reservation of reservations) {
    if (reservation.expiresAt === undefined || reservation.expiresAt > now) continue;

    // ⚠️ THIS IS THE ONLY CROSS-TENANT LOOP IN THE SYSTEM, AND ONE MUTATION IS
    // ONE TRANSACTION. The query above ranges on `by_status_expiresAt` with no
    // orgId, so a single batch spans every dealership on the deployment. A
    // throw on the last row therefore un-does every earlier row — belonging to
    // other people's dealerships — and because the offending reservation never
    // reaches EXPIRED, the next sweep selects it again. One corrupt car
    // starves reservation expiry for everyone, permanently.
    //
    // So ownership is read HERE, before this row writes anything, and the
    // AMBIGUOUS case is decided rather than thrown.
    //
    // ⚠️ WHAT IS WITHHELD IS ONLY THE ROOT DECISION. The reservation's clock
    // expiry is an objective fact about time, not about who owns the car, so
    // it is still materialized below exactly as it would be for any other
    // row — deposit hold lifted, reservation EXPIRED, projection synced.
    // Leaving the row ACTIVE "until someone fixes the roots" is what made the
    // failure permanent rather than transient.
    //
    // ⚠️ AND IT IS A TYPED DECISION, NOT A RESCUE. It branches on the
    // canonical authority's own `Ownership.kind`, never on a try/catch around
    // the finalizer and never on the wording of an error message. A blanket
    // catch here would swallow the real bugs this sweep should surface, and a
    // string match would fail silently the first time someone improves the
    // copy. Two OPEN roots is one car promised to two deals; refusing to
    // choose stays correct — it just must not take other tenants down with it.
    const ownership = await resolveOwnership(ctx, reservation.orgId, reservation.vehicleId);
    const rootDecisionWithheld = ownership.kind === "AMBIGUOUS";

    // Money already changed hands (عربون) — expiry only lifts the vehicle
    // hold. A manager still has to decide REFUNDED vs. FORFEITED via
    // deposits.release, same human-in-the-loop as every other deposit
    // resolution (see deposits.ts release/void).
    const releasedDeposit = await releaseReservationDepositHold(ctx, {
      orgId: reservation.orgId,
      reservation,
      reason: "reservation expired by sweep",
    });
    if (releasedDeposit) {
      const [vehicle, customer] = await Promise.all([
        ctx.db.get(reservation.vehicleId),
        ctx.db.get(reservation.customerId),
      ]);
      const vehicleLabel = vehicle
        ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`.trim()
        : "Vehicle";
      const customerLabel = customer
        ? `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() || "Customer"
        : "Customer";
      await notifyManagers(
        ctx,
        reservation.orgId,
        "deposit.expired",
        { vehicleLabel, customerLabel, amount: String(releasedDeposit.amount) },
        { link: `/${reservation.orgId}/vehicles?highlightId=${reservation.vehicleId}` }
      );
    }
    await ctx.db.patch(reservation._id, {
      status: "EXPIRED",
      expiredAt: now,
    });
    await syncVehicleHoldStatus(ctx, reservation.vehicleId);

    if (rootDecisionWithheld) {
      // Loudly, not silently. The corruption is left byte-identical for a
      // human to repair, and this line is the only record that the sweep
      // knowingly declined to act on it.
      console.error(
        "SCRUM-195 expireReservations: ambiguous commitment ownership — reservation expired, root decision withheld",
        {
          orgId: reservation.orgId,
          vehicleId: reservation.vehicleId,
          reservationId: reservation._id,
          openRootCount: ownership.kind === "AMBIGUOUS" ? ownership.roots.length : 0,
        }
      );
      continue;
    }

    // SCRUM-195 M3. WITHOUT THIS THE ROOT IS LOCKED FOREVER. Once a
    // reservation is EXPIRED, `releaseReservation` refuses it (it requires
    // ACTIVE), so no operator door can ever release the root it opened. The
    // sweep that ends the basis is the only place left that can close it.
    await releaseRootIfNoLiveBasis(ctx, {
      orgId: reservation.orgId,
      vehicleId: reservation.vehicleId,
      reason: "reservation expired",
      decisionNow: now,
    });
  }

  return { expired: reservations.length };
}

export function vehicleReservationFingerprint(args: VehicleReservationInput) {
  return JSON.stringify({
    vehicleId: args.vehicleId.toString(),
    customerId: args.customerId.toString(),
    depositAmount: args.depositAmount ?? null,
    depositMethod: args.depositMethod ?? null,
    depositBankAccountId: args.depositBankAccountId ?? null,
    dealQuoteId: args.dealQuoteId?.toString() ?? null,
    dealDepositId: args.dealDepositId?.toString() ?? null,
  });
}

export async function finishVehicleReservationRelease(
  ctx: MutationCtx,
  release: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    actorId: Id<"users">;
    now: number;
  },
) {
  const { orgId, vehicleId, actorId, now } = release;

  await syncVehicleHoldStatus(ctx, vehicleId, actorId);

  // SCRUM-195 M3. The reservation basis is gone; the root follows only if
  // nothing else holds the car. A finance application on the same deal
  // legitimately keeps it OPEN — releasing a reservation is not a decision to
  // abandon the deal.
  await releaseRootIfNoLiveBasis(ctx, {
    orgId: orgId,
    vehicleId: vehicleId,
    reason: "reservation released",
    decisionNow: now,
  });
}
