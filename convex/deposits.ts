import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { Doc } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { throwAppError, AppErrorCode } from "./utils/errors";
import {
  holdVehicleForDeposit,
  releaseAllVehiclesForDeposit,
  releaseHeldDeposit,
  maybeReleaseVehicleHold,
} from "./utils/depositHelpers";
import { notifyManagers, getActorName } from "./utils/notifications";
import { runWithIdempotency } from "./utils/idempotency";
import { hookDepositVoided, getOrgCurrency } from "./accounting/workflowHooks";
import {
  amountToMinorOrThrow,
  depositMethodValidator,
  methodOrDefault,
  normalizeCurrency,
  recordHeldDeposit,
} from "./utils/depositRecording";
import { voidCanonicalPayment } from "./subledger";
import { quoteDepositAllocation, validateAllocationTotals } from "./utils/depositAllocation";
import { toMinorUnits, assertFiniteNumber, scaleForCurrency } from "./utils/money";
import { auditLog } from "./financialAudit";

export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    quoteId: v.id("quotes"),
    amount: v.number(),
    currency: v.optional(v.string()),
    method: v.optional(depositMethodValidator),
    notes: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Recording a deposit while working a deal in the wizard is normal
    // day-to-day sales activity, not a committed sale — VIEW_SALES (held by
    // SALES/MANAGER/ACCOUNTANT/OWNER) is the right bar, same as quotes.ts.
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);
    const orgCurrency = normalizeCurrency(await getOrgCurrency(ctx, args.orgId));
    const currency = args.currency ? normalizeCurrency(args.currency) : orgCurrency;
    if (currency !== orgCurrency) {
      throw new ConvexError(`Deposit currency must match organization currency (${orgCurrency}).`);
    }
    const method = methodOrDefault(args.method);
    const amountMinor = amountToMinorOrThrow(args.amount, currency);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "deposits.create",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({
          quoteId: args.quoteId,
          amountMinor,
          currency,
          method,
          notes: args.notes ?? null,
        }),
      },
      async () => {
        const quote = await ctx.db.get(args.quoteId);
        if (!quote || quote.orgId !== args.orgId) {
          throwAppError(AppErrorCode.QUOTE_NOT_FOUND, "Quote not found in this organization.");
        }
        const quoteAmountMinor = amountToMinorOrThrow(quote.vehiclePrice, currency, "Quote amount");
        const existingDeposits = await ctx.db
          .query("deposits")
          .withIndex("by_quote", (q) => q.eq("quoteId", args.quoteId))
          .collect();
        const existingActiveMinor = existingDeposits.reduce((sum, deposit) => {
          if (deposit.isDeleted === true) return sum;
          if (deposit.status !== "HELD" && deposit.status !== "APPLIED") return sum;
          return sum + (deposit.amountMinor ?? amountToMinorOrThrow(deposit.amount, currency));
        }, 0);
        if (existingActiveMinor + amountMinor > quoteAmountMinor) {
          throw new ConvexError("Total deposits cannot exceed the quote amount.");
        }

        // Throws if a vehicle is SOLD/ARCHIVED; otherwise patches AVAILABLE -> RESERVED
        // (no-op if already RESERVED — parallel deposits are allowed). A multi-vehicle
        // quote holds every vehicle on the deal, not just the first one.
        const depositVehicleItems = quote.vehicleItems ?? [{ vehicleId: quote.vehicleId }];
        for (const item of depositVehicleItems) {
          await holdVehicleForDeposit(ctx, item.vehicleId);
        }

        const now = Date.now();
        const depositId = await recordHeldDeposit(ctx, {
          orgId: args.orgId,
          vehicleId: quote.vehicleId,
          customerId: quote.customerId,
          quoteId: args.quoteId,
          amount: args.amount,
          amountMinor,
          currency,
          method,
          idempotencyKey: args.idempotencyKey,
          notes: args.notes,
          actorId: user._id,
          now,
          sourceLabel: `quote ${args.quoteId}`,
        });

        // Only multi-vehicle deposits need a join row per vehicle — a
        // single-vehicle deposit is already fully tracked by the deposit's
        // own vehicleId + by_vehicle_hold index.
        if (depositVehicleItems.length > 1) {
          for (const item of depositVehicleItems) {
            await ctx.db.insert("depositVehicleHolds", {
              orgId: args.orgId,
              depositId,
              vehicleId: item.vehicleId,
              active: true,
              createdAt: now,
            });
          }
        }

        const actorName = await getActorName(ctx);
        await notifyManagers(
          ctx,
          args.orgId,
          "deposit.created",
          { actorName, amount: String(args.amount) },
          { link: `/${args.orgId}/vehicles?highlightId=${quote.vehicleId}` }
        );

        return depositId;
      }
    );
  },
});

export const release = mutation({
  args: {
    orgId: v.id("organizations"),
    depositId: v.id("deposits"),
    resolution: v.union(v.literal("REFUNDED"), v.literal("FORFEITED")),
    // Required when resolution is REFUNDED — real cash/bank/card/cheque moves
    // out, and the GL entry must credit the account it actually left from.
    refundMethod: v.optional(depositMethodValidator),
    notes: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // The permission is re-checked inside `releaseHeldDeposit` against the
    // actor, so the guard travels with the decision rather than with this entry
    // point. Kept here too because failing at the boundary is a better error.
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_REQUESTS]);
    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "deposits.release",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({
          depositId: args.depositId,
          resolution: args.resolution,
          refundMethod: args.refundMethod ?? null,
          notes: args.notes ?? null,
        }),
      },
      async () => {
        const deposit = await ctx.db.get(args.depositId);
        if (!deposit || deposit.orgId !== args.orgId) {
          throwAppError(AppErrorCode.DEPOSIT_NOT_FOUND, "Deposit not found in this organization.");
        }

        await releaseHeldDeposit(ctx, {
          orgId: args.orgId,
          depositId: args.depositId,
          resolution: args.resolution,
          actorId: user._id,
          refundMethod: args.refundMethod,
          notes: args.notes,
          idempotencyKey: args.idempotencyKey,
        });

        const actorName = await getActorName(ctx);
        await notifyManagers(
          ctx,
          args.orgId,
          "deposit.released",
          { actorName, amount: String(deposit.amount) },
          { link: `/${args.orgId}/vehicles?highlightId=${deposit.vehicleId}` }
        );

        return args.depositId;
      }
    );
  },
});

export const voidDeposit = mutation({
  args: {
    orgId: v.id("organizations"),
    depositId: v.id("deposits"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_REQUESTS]);

    const deposit = await ctx.db.get(args.depositId);
    if (!deposit || deposit.orgId !== args.orgId || deposit.isDeleted === true) {
      throwAppError(AppErrorCode.DEPOSIT_NOT_FOUND, "Deposit not found in this organization.");
    }
    if (deposit.status !== "HELD") {
      throwAppError(AppErrorCode.DEPOSIT_ALREADY_RESOLVED, "Only HELD deposits can be voided.");
    }

    const now = Date.now();
    await ctx.db.patch(args.depositId, {
      status: "VOIDED",
      isDeleted: true,
      deletedAt: now,
      deletedBy: user._id.toString(),
      holdActive: false,
      resolvedBy: user._id,
      resolvedAt: now,
      notes: args.reason !== undefined ? args.reason : deposit.notes,
    });

    // Voiding means "recorded in error" — every artifact written when the
    // deposit was recorded must be unwound, not just the operational row:
    // the canonical payment, the mirror collectionPayment, and the
    // DEPOSIT_RECEIVED GL posting.
    const canonicalPaymentId =
      deposit.canonicalPaymentId ??
      (
        await ctx.db
          .query("canonicalPayments")
          .withIndex("by_org_idempotency", (q) =>
            q.eq("orgId", args.orgId).eq("idempotencyKey", `deposit_received_${args.depositId}`)
          )
          .unique()
      )?._id;
    if (canonicalPaymentId) {
      await voidCanonicalPayment(ctx, {
        orgId: args.orgId,
        paymentId: canonicalPaymentId,
        actorId: user._id,
      });
    }

    const mirrorPayments = await ctx.db
      .query("collectionPayments")
      .withIndex("by_org_customer", (q) =>
        q.eq("orgId", args.orgId).eq("customerId", deposit.customerId)
      )
      .filter((q) => q.eq(q.field("reference"), `Deposit ${args.depositId}`))
      .collect();
    for (const mirrorPayment of mirrorPayments) {
      if (mirrorPayment.status !== "VOIDED") {
        await ctx.db.patch(mirrorPayment._id, {
          status: "VOIDED",
          voidedAt: now,
          voidedBy: user._id,
        });
      }
    }

    await hookDepositVoided(ctx, {
      orgId: args.orgId,
      depositId: args.depositId,
      reason: args.reason ?? "Deposit voided",
      actorId: user._id,
      reversalDate: now,
    });

    // A void means "recorded in error" — no money moved, so the original IN
    // transaction is erased rather than offset with a new OUT (which would
    // make the legacy table look like a refund instead of a reversal).
    const originalInTx = await ctx.db
      .query("transactions")
      .withIndex("by_org_vehicle", (q) =>
        q.eq("orgId", args.orgId).eq("vehicleId", deposit.vehicleId)
      )
      .filter((q) =>
        q.and(
          q.eq(q.field("depositId"), args.depositId),
          q.eq(q.field("type"), "IN"),
          q.neq(q.field("isDeleted"), true)
        )
      )
      .first();
    if (originalInTx) {
      await ctx.db.patch(originalInTx._id, {
        isDeleted: true,
        deletedAt: now,
        deletedBy: user._id.toString(),
      });
    }

    await releaseAllVehiclesForDeposit(ctx, deposit);

    return args.depositId;
  },
});

export const listByVehicle = query({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);

    const primaryDeposits = await ctx.db
      .query("deposits")
      .withIndex("by_vehicle_hold", (q) => q.eq("vehicleId", args.vehicleId))
      .order("desc")
      .take(50);

    // A vehicle can also be a secondary line item on a multi-vehicle deposit,
    // which only ever snapshots its primary vehicleId on the deposits row —
    // pull those in via the join table so this vehicle's deposit history is
    // complete, not just deposits where it happens to be the primary.
    const secondaryHolds = await ctx.db
      .query("depositVehicleHolds")
      .withIndex("by_vehicle_active", (q) => q.eq("vehicleId", args.vehicleId))
      .collect();
    const secondaryDeposits = await Promise.all(
      secondaryHolds.map((hold) => ctx.db.get(hold.depositId))
    );

    const byId = new Map<string, Doc<"deposits">>();
    for (const deposit of [...primaryDeposits, ...secondaryDeposits]) {
      if (deposit && deposit.orgId === args.orgId) {
        byId.set(deposit._id, deposit);
      }
    }

    return Array.from(byId.values()).sort((a, b) => b._creationTime - a._creationTime);
  },
});

/**
 * Records how much of a quote's reservation deposit belongs to each car on it.
 *
 * Required before any car on a multi-vehicle quote can be sold. The split is
 * the customer's decision — 5,000 across a 3,000 car and a 20,000 car might be
 * 3,000/2,000, or 1,000/2,000 with 2,000 left unassigned — and no rule the
 * system could apply would be more than a guess dressed as a fact. See
 * convex/utils/depositAllocation.ts.
 *
 * Idempotent by replacement: the allocation for the vehicles named here is set
 * to exactly what is passed. Vehicles left out keep whatever they had, so a
 * correction to one car does not silently zero the others.
 */
export const allocateToVehicles = mutation({
  args: {
    orgId: v.id("organizations"),
    quoteId: v.id("quotes"),
    allocations: v.array(
      v.object({
        vehicleId: v.id("vehicles"),
        /** Major units, in the organization's currency. Zero is a valid decision. */
        amount: v.number(),
      })
    ),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Same bar as recording the deposit itself: this is deal work, not a
    // financial approval — no money moves and nothing posts.
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    const quote = await ctx.db.get(args.quoteId);
    if (!quote || quote.orgId !== args.orgId) {
      throwAppError(AppErrorCode.QUOTE_NOT_FOUND, "Quote not found in this organization.");
    }

    const currency = normalizeCurrency(await getOrgCurrency(ctx, args.orgId));
    const summary = await quoteDepositAllocation(ctx, { quoteId: args.quoteId, currency });
    if (summary.heldTotalMinor === 0) {
      throw new ConvexError("This quote has no held reservation deposit to allocate.");
    }
    if (!summary.isMultiVehicle) {
      throw new ConvexError(
        "This quote covers a single vehicle, so its deposit is already allocated to it in full."
      );
    }

    // Every car named must actually be on this quote. Allocating a customer's
    // deposit against a car they did not reserve is not a typo worth accepting.
    const quoteVehicleIds = new Set(
      (quote.vehicleItems ?? [{ vehicleId: quote.vehicleId, unitPrice: quote.vehiclePrice }]).map(
        (item) => item.vehicleId.toString()
      )
    );
    const seen = new Set<string>();
    for (const allocation of args.allocations) {
      if (!quoteVehicleIds.has(allocation.vehicleId.toString())) {
        throw new ConvexError("An allocation names a vehicle that is not on this quote.");
      }
      assertFiniteNumber(allocation.amount, "allocation amount");
      if (seen.has(allocation.vehicleId.toString())) {
        throw new ConvexError("The same vehicle appears twice in the allocation.");
      }
      seen.add(allocation.vehicleId.toString());
    }

    const proposedByVehicle = new Map(
      args.allocations.map((a) => [a.vehicleId.toString(), toMinorUnits(a.amount, currency)])
    );

    // Vehicles not named here keep their existing allocation, so the invariant
    // is checked against the whole picture rather than only the part being
    // edited.
    const retainedMinor = summary.allocations
      .filter(
        (a) =>
          a.active &&
          a.status !== "APPLIED" &&
          a.status !== "RELEASED" &&
          a.allocatedMinor !== undefined &&
          !proposedByVehicle.has(a.vehicleId.toString())
      )
      .reduce((sum, a) => sum + (a.allocatedMinor ?? 0), 0);

    const check = validateAllocationTotals({
      heldTotalMinor: summary.heldTotalMinor,
      appliedMinor: summary.appliedMinor,
      releasedAwaitingDecisionMinor: summary.releasedAwaitingDecisionMinor,
      proposedMinor: [...proposedByVehicle.values(), retainedMinor],
    });
    if (!check.ok) throw new ConvexError(check.reason);

    const now = Date.now();
    let written = 0;
    for (const allocation of summary.allocations) {
      const proposed = proposedByVehicle.get(allocation.vehicleId.toString());
      if (proposed === undefined) continue;
      if (allocation.status === "APPLIED") {
        throw new ConvexError(
          "That vehicle's share of the deposit has already been applied to its completed sale and cannot be re-allocated. Cancel the sale first."
        );
      }
      if (allocation.status === "RELEASED") {
        throw new ConvexError(
          "That vehicle's share was released when it left the deal and needs an explicit decision before it can be used again."
        );
      }
      await ctx.db.patch(allocation.holdId, {
        allocatedAmountMinor: proposed,
        allocationStatus: "ALLOCATED",
        allocatedAt: now,
        allocatedBy: user._id,
      });
      written += 1;
    }

    await auditLog(ctx, {
      orgId: args.orgId,
      actorId: user._id,
      actionType: "ALLOCATE_DEPOSIT",
      resourceType: "quotes",
      resourceId: args.quoteId,
      description: `Allocated reservation deposit across ${written} vehicle(s) on the quote. Unallocated remainder: ${check.unallocatedMinor} minor units.`,
      after: {
        allocations: args.allocations.map((a) => ({
          vehicleId: a.vehicleId.toString(),
          amountMinor: toMinorUnits(a.amount, currency),
        })),
        unallocatedMinor: check.unallocatedMinor,
        notes: args.notes,
      },
    });

    return { vehiclesAllocated: written, unallocatedMinor: check.unallocatedMinor };
  },
});

/**
 * What happens to a vehicle's slice of the deposit when that vehicle leaves the
 * deal.
 *
 * Nothing happens to it automatically. A released slice does NOT flow back into
 * the pool for the next sale to absorb: the customer allocated that money
 * against a specific car, and moving it to a different one — or letting it be
 * consumed by whichever sale closes next — is a decision only they and the
 * dealership can make. Until this runs, the slice sits in
 * `releasedAwaitingDecisionMinor` and is unavailable to every other car.
 */
export const resolveReleasedAllocation = mutation({
  args: {
    orgId: v.id("organizations"),
    holdId: v.id("depositVehicleHolds"),
    treatment: v.union(
      v.literal("REALLOCATE_TO_VEHICLE"),
      v.literal("RETURN_TO_UNALLOCATED"),
      v.literal("REFUND_TO_CUSTOMER"),
      v.literal("FORFEITED"),
      v.literal("OTHER")
    ),
    /** Required for REALLOCATE_TO_VEHICLE — which car on the quote receives it. */
    toVehicleId: v.optional(v.id("vehicles")),
    /** Required for REFUND_TO_CUSTOMER — real money leaves, so the account it left must be known. */
    refundMethod: v.optional(depositMethodValidator),
    /** Required for OTHER, and recorded for every treatment. */
    reason: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Refund and forfeiture move or keep a customer's money, so they carry the
    // same approval bar as `deposits.release`. Re-allocating within the same
    // quote does not, and is deal work.
    const needsApproval =
      args.treatment === "REFUND_TO_CUSTOMER" || args.treatment === "FORFEITED";
    const { user } = await requireTenantAuth(
      ctx,
      args.orgId,
      needsApproval ? [PERMISSIONS.APPROVE_REQUESTS] : [PERMISSIONS.VIEW_SALES]
    );

    const hold = await ctx.db.get(args.holdId);
    if (!hold || hold.orgId !== args.orgId) {
      throw new ConvexError("Deposit allocation not found in this organization.");
    }
    if (hold.allocationStatus !== "RELEASED") {
      throw new ConvexError(
        "That allocation has not been released, so there is nothing to decide about it."
      );
    }
    const deposit = await ctx.db.get(hold.depositId);
    if (!deposit || deposit.orgId !== args.orgId) {
      throwAppError(AppErrorCode.DEPOSIT_NOT_FOUND, "Deposit not found in this organization.");
    }

    const amountMinor = hold.allocatedAmountMinor ?? 0;
    const now = Date.now();

    if (args.treatment === "REALLOCATE_TO_VEHICLE") {
      if (!args.toVehicleId) {
        throw new ConvexError("Name the vehicle that is to receive the released amount.");
      }
      const target = await ctx.db
        .query("depositVehicleHolds")
        .withIndex("by_deposit_vehicle", (q) =>
          q.eq("depositId", hold.depositId).eq("vehicleId", args.toVehicleId!)
        )
        .first();
      if (!target || !target.active) {
        throw new ConvexError(
          "That vehicle is not an active line on this deposit's quote, so it cannot receive the released amount."
        );
      }
      if (target.allocationStatus === "APPLIED") {
        throw new ConvexError(
          "That vehicle's sale is already complete; its share cannot be increased after the fact."
        );
      }
      await ctx.db.patch(target._id, {
        allocatedAmountMinor: (target.allocatedAmountMinor ?? 0) + amountMinor,
        allocationStatus: "ALLOCATED",
        allocatedAt: now,
        allocatedBy: user._id,
      });
    } else if (args.treatment === "REFUND_TO_CUSTOMER") {
      // Deliberately NOT posted here. A partial refund of a shared deposit row
      // is a different movement from releasing the whole deposit, and
      // `releaseHeldDeposit` resolves the entire row — posting a partial
      // release through a whole-row path would take the other cars' money with
      // it. The decision is recorded; the payout is an explicit entry.
      if (!args.refundMethod) {
        throw new ConvexError(
          "A refund needs the method the money is going out by — the deposit's own method may be one that cannot be paid out."
        );
      }
    } else if (args.treatment === "OTHER") {
      if (!args.reason?.trim()) {
        throw new ConvexError(
          "An 'other' treatment has to say what it is. Record the approved treatment and the reason for it."
        );
      }
    }
    // RETURN_TO_UNALLOCATED and FORFEITED need nothing extra here: clearing the
    // released slice below is exactly what returns it to the quote-level
    // unallocated balance, and a forfeiture is recorded rather than posted for
    // the same partial-row reason as a refund.

    await ctx.db.patch(hold._id, {
      allocatedAmountMinor: 0,
      releaseReason: args.reason?.trim(),
      resolvedAt: now,
      resolvedBy: user._id,
    });

    await auditLog(ctx, {
      orgId: args.orgId,
      actorId: user._id,
      actionType: "RESOLVE_DEPOSIT_ALLOCATION",
      resourceType: "depositVehicleHolds",
      resourceId: args.holdId,
      description: `Released deposit allocation of ${amountMinor} minor units resolved as ${args.treatment}.`,
      before: { vehicleId: hold.vehicleId.toString(), allocatedAmountMinor: amountMinor },
      after: {
        treatment: args.treatment,
        toVehicleId: args.toVehicleId?.toString(),
        refundMethod: args.refundMethod,
        reason: args.reason,
      },
      idempotencyKey: args.idempotencyKey,
    });

    return { amountMinor, treatment: args.treatment };
  },
});

/** The allocation picture for a quote, for the UI that has to fill it in. */
export const quoteAllocation = query({
  args: { orgId: v.id("organizations"), quoteId: v.id("quotes") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);
    const quote = await ctx.db.get(args.quoteId);
    if (!quote || quote.orgId !== args.orgId) return null;

    const currency = normalizeCurrency(await getOrgCurrency(ctx, args.orgId));
    const summary = await quoteDepositAllocation(ctx, { quoteId: args.quoteId, currency });

    const items = quote.vehicleItems ?? [
      { vehicleId: quote.vehicleId, unitPrice: quote.vehiclePrice },
    ];
    const vehicles = await Promise.all(
      items.map(async (item) => {
        const vehicle = await ctx.db.get(item.vehicleId);
        // The active hold if there is one, otherwise whatever became of it —
        // a released slice has `active: false` and is exactly the row somebody
        // has to make a decision about, so it cannot be filtered out of the
        // screen where that decision is made.
        const allocation =
          summary.allocations.find((a) => a.vehicleId === item.vehicleId && a.active) ??
          summary.allocations.find((a) => a.vehicleId === item.vehicleId);
        return {
          vehicleId: item.vehicleId,
          label: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`.trim() : "Vehicle",
          unitPrice: item.unitPrice,
          allocatedMinor: allocation?.allocatedMinor,
          status: allocation?.status,
          holdId: allocation?.holdId,
        };
      })
    );

    return {
      currency,
      // The scale comes from the server so the client never has its own copy of
      // which currencies have three decimals. Getting that list wrong is a 100x
      // error, and a duplicated list drifts.
      scale: scaleForCurrency(currency),
      isMultiVehicle: summary.isMultiVehicle,
      heldTotalMinor: summary.heldTotalMinor,
      allocatedMinor: summary.allocatedMinor,
      appliedMinor: summary.appliedMinor,
      releasedAwaitingDecisionMinor: summary.releasedAwaitingDecisionMinor,
      unallocatedMinor: summary.unallocatedMinor,
      vehicles,
      /** Cars that cannot be sold until somebody allocates their share. */
      vehiclesWithoutAllocation: summary.vehiclesWithoutAllocation,
    };
  },
});

/**
 * Takes a vehicle off a multi-vehicle deal and releases its share of the
 * deposit for an explicit decision.
 *
 * The share is NOT returned to the pool and NOT handed to the remaining cars.
 * The customer put that money against this specific car; where it goes next is
 * their decision and the dealership's, and until
 * `resolveReleasedAllocation` records one it counts as neither allocated nor
 * available.
 */
export const releaseVehicleAllocation = mutation({
  args: {
    orgId: v.id("organizations"),
    quoteId: v.id("quotes"),
    vehicleId: v.id("vehicles"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    const quote = await ctx.db.get(args.quoteId);
    if (!quote || quote.orgId !== args.orgId) {
      throwAppError(AppErrorCode.QUOTE_NOT_FOUND, "Quote not found in this organization.");
    }

    const deposits = await ctx.db
      .query("deposits")
      .withIndex("by_quote", (q) => q.eq("quoteId", args.quoteId))
      .collect();

    let releasedMinor = 0;
    let releasedHolds = 0;
    for (const deposit of deposits) {
      if (deposit.isDeleted === true || deposit.status !== "HELD") continue;
      const hold = await ctx.db
        .query("depositVehicleHolds")
        .withIndex("by_deposit_vehicle", (q) =>
          q.eq("depositId", deposit._id).eq("vehicleId", args.vehicleId)
        )
        .first();
      if (!hold || !hold.active) continue;
      if (hold.allocationStatus === "APPLIED") {
        throw new ConvexError(
          "That vehicle's share has already been applied to its completed sale. Cancel the sale before removing the vehicle from the deal."
        );
      }
      await ctx.db.patch(hold._id, {
        active: false,
        allocationStatus: "RELEASED",
        releaseReason: args.reason?.trim(),
      });
      releasedMinor += hold.allocatedAmountMinor ?? 0;
      releasedHolds += 1;
    }

    if (releasedHolds === 0) {
      throw new ConvexError("That vehicle holds no active share of this quote's deposit.");
    }

    await maybeReleaseVehicleHold(ctx, args.vehicleId);

    await auditLog(ctx, {
      orgId: args.orgId,
      actorId: user._id,
      actionType: "RESOLVE_DEPOSIT_ALLOCATION",
      resourceType: "vehicles",
      resourceId: args.vehicleId,
      description: `Released ${releasedMinor} minor units of the quote's reservation deposit when the vehicle left the deal. Awaiting an explicit decision.`,
      after: { quoteId: args.quoteId.toString(), releasedMinor, reason: args.reason },
    });

    return { releasedMinor };
  },
});
