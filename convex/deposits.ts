import { acquireVehicle, assertAcquirable, evidenceForDepositHold } from "./commitments";
import { ConvexError, v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import { mutation } from "./functions";
import { Doc, type Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { throwAppError, AppErrorCode } from "./utils/errors";
import {
  holdVehicleForDeposit,
  releaseAllVehiclesForDeposit,
  releaseHeldDeposit,
  maybeReleaseVehicleHold,
  payOutDepositSlice,
  syncVehicleHoldStatus,
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
import {
  quoteDepositAllocation,
  validateAllocationTotals,
  assertQuoteDepositConservation,
} from "./utils/depositAllocation";
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
    /**
     * SCRUM-195: EXPLICIT proof that this deal continues the reservation
     * already holding the car. Naming the reservation is the only way that
     * continuation is recognised — the authority never infers it from the
     * customer and the vehicle matching.
     */
    adoptReservationId: v.optional(v.id("vehicleReservations")),
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
        // ⚠️ THE ADOPTION IS PART OF THE REQUEST, SO IT IS PART OF ITS IDENTITY.
        // Left out, two calls sharing an idempotency key but naming DIFFERENT
        // reservations — or one naming a reservation and one naming none — read
        // as the same request, and the second is answered from the first's
        // result. That is not a replay: it silently drops an affirmative claim
        // about which deal the money continues, and the authority never sees
        // the second call to refuse it.
        fingerprint: JSON.stringify({
          quoteId: args.quoteId,
          amountMinor,
          currency,
          method,
          notes: args.notes ?? null,
          adoptReservationId: args.adoptReservationId ?? null,
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
          const rowMinor =
            deposit.amountMinor ?? amountToMinorOrThrow(deposit.amount, currency);
          // Less whatever has been handed back. A row can now be released in
          // part and stay HELD, and counting it at face value meant a customer
          // whose deposit was partly refunded could not put the money down
          // again — the quote read as fully deposited when it was not.
          return sum + Math.max(0, rowMinor - (deposit.releasedAmountMinor ?? 0));
        }, 0);
        if (existingActiveMinor + amountMinor > quoteAmountMinor) {
          throw new ConvexError("Total deposits cannot exceed the quote amount.");
        }

        // Throws if a vehicle is SOLD/ARCHIVED; otherwise patches AVAILABLE -> RESERVED
        // (no-op if already RESERVED — parallel deposits are allowed). A multi-vehicle
        // quote holds every vehicle on the deal, not just the first one.
        const depositVehicleItems = quote.vehicleItems ?? [{ vehicleId: quote.vehicleId }];

        // SCRUM-195: ask the AUTHORITY before moving a car's status. Vehicle
        // status is an advisory projection (I4) — it says where a car IS, not
        // whose deal it belongs to, and two deals can both see AVAILABLE. The
        // commitment root is the lock, and it refuses BEFORE any side effect.
        //
        // The quote is the lineage PROOF, not the identity: presenting it says
        // "I am acting for the deal this quote belongs to". A quote with no
        // root has proven nothing, so a second independent quote for the same
        // customer on the same car is refused here, exactly as a rival's is.
        for (const item of depositVehicleItems) {
          await assertAcquirable(ctx, {
            orgId: args.orgId,
            vehicleId: item.vehicleId,
            lineage: { quoteId: args.quoteId, adoptReservationId: args.adoptReservationId },
          });
        }
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

        // SCRUM-195: record WHOSE deal now holds each car, on the strength of
        // THIS deposit. One episode per car per acquisition — a further
        // instalment on the same deal joins the same root and opens its own
        // episode, so the history says how the deal was built.
        const episodeByVehicle = new Map<string, Id<"vehicleCommitmentClaims">>();
        for (const item of depositVehicleItems) {
          const { claimId } = await acquireVehicle(ctx, {
            orgId: args.orgId,
            vehicleId: item.vehicleId,
            customerId: quote.customerId,
            createdBy: user._id,
            evidence: { kind: "DEPOSIT", depositId },
            lineage: { quoteId: args.quoteId, adoptReservationId: args.adoptReservationId },
          });
          episodeByVehicle.set(String(item.vehicleId), claimId);
        }

        // Only multi-vehicle deposits need a join row per vehicle — a
        // single-vehicle deposit is already fully tracked by the deposit's
        // own vehicleId + by_vehicle_hold index.
        if (depositVehicleItems.length > 1) {
          for (const item of depositVehicleItems) {
            // SCRUM-195: the slice names the episode it was created with, so
            // what this money is evidence OF can be read back exactly instead
            // of inferred from the surrounding row or searched for in history.
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
        // Deliberately NOT discriminated by how much of the row is left.
        //
        // A retry of one release and a second, genuinely different release both
        // arrive after the first has committed, so nothing in the row's state
        // can tell them apart — adding it would turn every retry into a hard
        // error. The key identifies ONE attempt, and a caller that reuses it
        // across two payouts gets the first one's result. That is why the
        // deposit screen sends no key at all: see VehicleDetailsDialog.
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
    // A row can now be released in part and stay HELD, so the status above no
    // longer means "nothing has happened to this money". Voiding says the
    // payment was recorded in error and reverses the receipt — which, after a
    // refund, leaves the books showing cash that went out against a receipt
    // that never came in, and soft-deletes the row out of every allocation
    // view while another car's share still points at it.
    if ((deposit.releasedAmountMinor ?? 0) > 0) {
      throw new ConvexError(
        "Part of this deposit has already been refunded or forfeited, so it cannot be voided as recorded in error. Voiding would reverse a receipt whose money has already left the business."
      );
    }
    const liveApplications = (
      await ctx.db
        .query("depositApplications")
        .withIndex("by_deposit", (q) => q.eq("depositId", args.depositId))
        .collect()
    ).filter((a) => a.status === "APPLIED" || a.status === "REVERSING");
    if (liveApplications.length > 0) {
      throw new ConvexError(
        "This deposit has been applied to a completed sale, so it cannot be voided as recorded in error. Cancel that sale first."
      );
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
/**
 * True when this car already has a completed sale on this quote.
 *
 * Deposit money may not be assigned to it: the invoice is issued and the
 * receivable is settled, so an allocation made now credits nothing and simply
 * sits there. The hold status alone does not answer it — a car whose share was
 * exactly zero completes with its hold untouched, which reads as available.
 */
async function hasCompletedSaleOnQuote(
  ctx: QueryCtx,
  args: { orgId: Id<"organizations">; quoteId: Id<"quotes">; vehicleId: Id<"vehicles"> }
): Promise<boolean> {
  // Scoped by the quote, which is the narrow side: a quote carries a handful of
  // cars and their sales, where an org carries every sale it has ever made.
  const sales = await ctx.db
    .query("sales")
    .withIndex("by_quote", (q) => q.eq("quoteId", args.quoteId))
    .collect();
  return sales.some(
    (sale) =>
      sale.orgId === args.orgId &&
      sale.vehicleId === args.vehicleId &&
      sale.status === "COMPLETED" &&
      sale.isDeleted !== true
  );
}

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
      if (
        await hasCompletedSaleOnQuote(ctx, {
          orgId: args.orgId,
          quoteId: args.quoteId,
          vehicleId: allocation.vehicleId,
        })
      ) {
        throw new ConvexError(
          "That vehicle's sale on this quote is already complete, so deposit money cannot be assigned to it. Cancel the sale first."
        );
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
    // edited. Summed per hold row, because a quote can carry several deposit
    // rows — the customer paid the عربون in instalments — and each has its own
    // hold for the same car.
    const retainedMinor = summary.allocations
      .filter(
        (a) =>
          a.active &&
          (a.status === undefined || a.status === "ALLOCATED") &&
          a.allocatedMinor !== undefined &&
          !proposedByVehicle.has(a.vehicleId.toString())
      )
      .reduce((sum, a) => sum + (a.allocatedMinor ?? 0), 0);

    const check = validateAllocationTotals({
      availableForAllocationMinor: summary.availableForAllocationMinor,
      retainedMinor,
      proposedMinor: [...proposedByVehicle.values()],
    });
    if (!check.ok) throw new ConvexError(check.reason);

    // Every named vehicle must have a hold row to write the allocation onto.
    // Silently skipping one meant the caller was told the allocation saved
    // while that car stayed unallocated and unsellable.
    //
    // Checked against terminal rows first, so a car whose share is already spent
    // is told so rather than being reported as having no hold at all — an
    // applied slice's row is inactive, which looks identical from here.
    const holdVehicleIds = new Set(
      summary.allocations.filter((a) => a.active).map((a) => a.vehicleId.toString())
    );
    for (const vehicleId of proposedByVehicle.keys()) {
      if (holdVehicleIds.has(vehicleId)) continue;
      const settled = summary.allocations.filter(
        (a) => a.vehicleId.toString() === vehicleId && !a.active
      );
      if (settled.some((a) => a.status === "APPLIED")) {
        throw new ConvexError(
          "That vehicle's share of the deposit has already been applied to its completed sale and cannot be re-allocated. Cancel the sale first."
        );
      }
      if (settled.some((a) => a.status === "REVERSING")) {
        throw new ConvexError(
          "That vehicle's share is still being backed out of the ledger after its sale was cancelled. It cannot be re-allocated until that reversal has posted."
        );
      }
      if (settled.some((a) => a.status === "RELEASED_AWAITING_DECISION")) {
        throw new ConvexError(
          "That vehicle's share was released when it left the deal and needs an explicit decision before it can be used again."
        );
      }
      throw new ConvexError(
        "One of the vehicles named has no active hold on this quote's deposit, so an allocation cannot be recorded against it."
      );
    }

    // How much of each individual payment is still free to assign. Cars left
    // out of this call keep their share, so theirs is subtracted here too.
    const capacity = new Map<string, number>();
    for (const row of summary.depositRows) {
      const retainedOnRow = summary.allocations
        .filter(
          (a) =>
            a.depositId === row.depositId &&
            a.active &&
            (a.status === undefined || a.status === "ALLOCATED") &&
            a.allocatedMinor !== undefined &&
            !proposedByVehicle.has(a.vehicleId.toString())
        )
        .reduce((sum, a) => sum + (a.allocatedMinor ?? 0), 0);
      capacity.set(
        row.depositId.toString(),
        Math.max(0, row.amountMinor - row.committedMinor - retainedOnRow)
      );
    }

    const now = Date.now();
    let written = 0;
    for (const [vehicleKey, proposed] of proposedByVehicle) {
      const holdsForVehicle = summary.allocations.filter(
        (a) => a.vehicleId.toString() === vehicleKey && a.active
      );
      for (const allocation of holdsForVehicle) {
        if (allocation.status === "APPLIED") {
          throw new ConvexError(
            "That vehicle's share of the deposit has already been applied to its completed sale and cannot be re-allocated. Cancel the sale first."
          );
        }
        if (allocation.status === "REVERSING") {
          throw new ConvexError(
            "That vehicle's share is still being backed out of the ledger after its sale was cancelled. It cannot be re-allocated until that reversal has posted."
          );
        }
        if (allocation.status === "RELEASED_AWAITING_DECISION") {
          throw new ConvexError(
            "That vehicle's share was released when it left the deal and needs an explicit decision before it can be used again."
          );
        }
        if (allocation.status === "RESOLVED") {
          throw new ConvexError(
            "That vehicle's share has already been resolved and cannot be allocated again."
          );
        }
      }

      // The amount is the VEHICLE's, not each payment's — and it is spread
      // across the payments that can actually cover it.
      //
      // Where the customer paid the عربون in instalments, the car has one hold
      // row per payment. Writing the requested figure onto every row allocated
      // it several times over; writing it all onto the first asked a 3,000
      // payment to settle a 5,000 share, and the subledger refused the sale
      // outright. Each row carries only what is left of it.
      let remaining = proposed;
      for (const allocation of holdsForVehicle) {
        const room = capacity.get(allocation.depositId.toString()) ?? 0;
        const share = Math.min(remaining, room);
        remaining -= share;
        capacity.set(allocation.depositId.toString(), room - share);
        await ctx.db.patch(allocation.holdId, {
          allocatedAmountMinor: share,
          allocationStatus: "ALLOCATED",
          allocatedAt: now,
          allocatedBy: user._id,
        });
      }
      if (remaining > 0) {
        throw new ConvexError(
          "That split cannot be settled against the payments received: one vehicle's share is larger than what is left of the deposits it is held against."
        );
      }
      if (holdsForVehicle.length > 0) written += 1;
    }

    await assertQuoteDepositConservation(ctx, { quoteId: args.quoteId, currency });

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
    // same approval bar as `deposits.release` — re-checked inside
    // `payOutDepositSlice` against the actor, along with the separation between
    // whoever took the deposit and whoever disposes of it. Re-allocating within
    // the same quote does not, and is deal work.
    // OTHER belongs here too. It takes the share out of the pool permanently
    // under a free-text reason — the schema calls it "an approved treatment",
    // and nothing was checking for an approval.
    const needsApproval =
      args.treatment === "REFUND_TO_CUSTOMER" ||
      args.treatment === "FORFEITED" ||
      args.treatment === "OTHER";
    const { user } = await requireTenantAuth(
      ctx,
      args.orgId,
      needsApproval ? [PERMISSIONS.APPROVE_REQUESTS] : [PERMISSIONS.VIEW_SALES]
    );

    const hold = await ctx.db.get(args.holdId);
    if (!hold || hold.orgId !== args.orgId) {
      throw new ConvexError("Deposit allocation not found in this organization.");
    }
    if (hold.allocationStatus === "REVERSING") {
      throw new ConvexError(
        "This share is still being backed out of the ledger after its sale was cancelled. Wait for that reversal to post before deciding what happens to the money."
      );
    }
    if (hold.allocationStatus !== "RELEASED_AWAITING_DECISION") {
      throw new ConvexError(
        "That allocation has not been released, so there is nothing to decide about it."
      );
    }
    const deposit = await ctx.db.get(hold.depositId);
    if (!deposit || deposit.orgId !== args.orgId) {
      throwAppError(AppErrorCode.DEPOSIT_NOT_FOUND, "Deposit not found in this organization.");
    }

    const currency = normalizeCurrency(
      deposit.currency ?? (await getOrgCurrency(ctx, args.orgId))
    );
    const amountMinor = hold.allocatedAmountMinor ?? 0;
    const now = Date.now();

    // SCRUM-195: whatever this decision does with the money, it acts for the
    // deal the money is already on. The deposit is the proof — it works for a
    // reservation-origin deposit that has no quote as well as for one that
    // does, without inferring anything from the customer.
    const sourceLineage = {
      quoteId: deposit.quoteId ?? null,
      reservationId: deposit.reservationId ?? null,
      depositId: hold.depositId,
    };

    if (args.treatment === "REALLOCATE_TO_VEHICLE") {
      if (!args.toVehicleId) {
        throw new ConvexError("Name the vehicle that is to receive the released amount.");
      }
      if (args.toVehicleId === hold.vehicleId) {
        throw new ConvexError(
          "Re-allocating a share to the vehicle it came from is not a decision. Return it to the quote's unallocated balance instead, and allocate from there."
        );
      }
      const quote = deposit.quoteId ? await ctx.db.get(deposit.quoteId) : null;
      const quoteVehicleIds = new Set(
        (quote?.vehicleItems ?? (quote ? [{ vehicleId: quote.vehicleId }] : [])).map((item) =>
          item.vehicleId.toString()
        )
      );
      if (!quoteVehicleIds.has(args.toVehicleId.toString())) {
        throw new ConvexError(
          "That vehicle is not a line on this deposit's quote, so it cannot receive the released amount."
        );
      }
      const targetHolds = await ctx.db
        .query("depositVehicleHolds")
        .withIndex("by_deposit_vehicle", (q) =>
          q.eq("depositId", hold.depositId).eq("vehicleId", args.toVehicleId!)
        )
        .collect();
      // Checked against the SALE as well as the hold. A car whose share was
      // exactly zero completes with its hold still ALLOCATED, so the hold
      // status alone let a released share be moved onto a car that had already
      // been sold and invoiced.
      if (
        targetHolds.some((h) => h.allocationStatus === "APPLIED") ||
        (deposit.quoteId !== undefined &&
          (await hasCompletedSaleOnQuote(ctx, {
            orgId: args.orgId,
            quoteId: deposit.quoteId,
            vehicleId: args.toVehicleId,
          })))
      ) {
        throw new ConvexError(
          "That vehicle's sale is already complete; its share cannot be increased after the fact."
        );
      }
      // A NEW allocation, not an edit of the old one. Rewriting the released
      // row to point at the receiving car would erase the fact that the money
      // was ever against the first one — the audit question a re-allocation
      // exists to answer.
      // SCRUM-195: moving money ONTO a car is a fresh acquisition of that car,
      // and it goes through the same authority boundary as every other one. If
      // something else has legitimately taken that car in the meantime, this
      // REFUSES rather than opening a second root on it.
      //
      // ⚠️ THE EVIDENCE IS CARRIED FROM THE SOURCE, NOT ASSUMED FROM THE ROW.
      // A reservation-origin deposit must not become DEPOSIT authority merely
      // because the surrounding row is a deposit — that is one of the exact
      // inference classes this replacement exists to remove.
      const reallocated = await acquireVehicle(ctx, {
        orgId: args.orgId,
        vehicleId: args.toVehicleId,
        customerId: deposit.customerId,
        createdBy: user._id,
        evidence: await evidenceForDepositHold(ctx, args.orgId, hold),
        lineage: sourceLineage,
      });
      await ctx.db.insert("depositVehicleHolds", {
        orgId: args.orgId,
        depositId: hold.depositId,
        vehicleId: args.toVehicleId,
        active: true,
        createdAt: now,
        allocatedAmountMinor: amountMinor,
        allocatedAt: now,
        allocatedBy: user._id,
        allocationStatus: "ALLOCATED",
        sourceHoldId: hold._id,
        // The NEW episode, not the source hold's. `sourceHoldId` records where
        // the money came from; this records what now holds the receiving car.
        sourceCommitmentClaimId: reallocated.claimId,
      });
      await syncVehicleHoldStatus(ctx, args.toVehicleId, user._id);
    } else if (args.treatment === "RETURN_TO_UNALLOCATED") {
      // No cash movement and no revenue: the money never left, it simply stops
      // being against this car. A fresh, unallocated hold re-opens the vehicle
      // so it can be allocated and sold again — without one, the car was
      // permanently unsellable on this quote, because an allocation can only be
      // written onto an active hold row and every path out of RESOLVED is
      // terminal.
      // SCRUM-195: putting the money back ON the deal is asking for the car
      // again — a FRESH acquisition, not the undoing of a mistake. Between the
      // release and this decision somebody else may legitimately have taken the
      // vehicle, so this must refuse rather than re-hold it.
      //
      // ⚠️ AND THE LINEAGE COMES FROM THE SOURCE EPISODE. A deposit taken with a
      // reservation carries no `quoteId`. Under the old design that arrived
      // here as `null` and was silently read as "open a new root", which is how
      // one physical car ended up with two. The deposit itself is now the
      // proof, and the evidence tag is carried rather than assumed.
      const reopened = await acquireVehicle(ctx, {
        orgId: args.orgId,
        vehicleId: hold.vehicleId,
        customerId: deposit.customerId,
        createdBy: user._id,
        evidence: await evidenceForDepositHold(ctx, args.orgId, hold),
        lineage: sourceLineage,
      });
      await ctx.db.insert("depositVehicleHolds", {
        orgId: args.orgId,
        depositId: hold.depositId,
        vehicleId: hold.vehicleId,
        active: true,
        createdAt: now,
        sourceHoldId: hold._id,
        // The re-opened slice carries the episode that re-acquired the car —
        // which inherits its evidence from the released one, so the chain of
        // what this money proves survives the round trip without re-deriving it.
        sourceCommitmentClaimId: reopened.claimId,
      });
      await syncVehicleHoldStatus(ctx, hold.vehicleId, user._id);
    } else if (args.treatment === "REFUND_TO_CUSTOMER" || args.treatment === "FORFEITED") {
      // The money actually moves. Recording the decision and posting nothing
      // left the customer's share sitting on the books as a liability against a
      // car that had left the deal, with a refund nobody ever paid.
      await payOutDepositSlice(ctx, {
        orgId: args.orgId,
        deposit,
        holdId: hold._id,
        vehicleId: hold.vehicleId,
        amountMinor,
        currency,
        resolution: args.treatment === "FORFEITED" ? "FORFEITED" : "REFUNDED",
        refundMethod: args.refundMethod,
        actorId: user._id,
        notes: args.reason,
        occurredAt: now,
        idempotencyKey: args.idempotencyKey,
      });
    } else {
      if (!args.reason?.trim()) {
        throw new ConvexError(
          "An 'other' treatment has to say what it is. Record the approved treatment and the reason for it."
        );
      }
    }

    // Terminal, and the amount is preserved rather than zeroed. Zeroing it made
    // a refunded slice disappear from the released bucket and reappear in the
    // quote's unallocated balance — refunded money becoming allocatable again —
    // and left the hold eligible to be resolved a second time.
    await ctx.db.patch(hold._id, {
      allocationStatus: "RESOLVED",
      resolutionTreatment: args.treatment,
      releaseReason: args.reason?.trim(),
      resolvedAt: now,
      resolvedBy: user._id,
    });

    if (deposit.quoteId) {
      await assertQuoteDepositConservation(ctx, { quoteId: deposit.quoteId, currency });
    }

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
        // Summed across every live hold for the car, because it can have more
        // than one: a deposit paid in instalments writes a hold per payment,
        // and money re-allocated from another car arrives as its own row rather
        // than being added onto an existing one. Reading a single row showed
        // one instalment's share and called it the car's allocation.
        const live = summary.allocations.filter((a) => a.vehicleId === item.vehicleId && a.active);
        // A released slice has `active: false` and is exactly the row somebody
        // has to make a decision about, so it cannot be filtered out of the
        // screen where that decision is made.
        const awaitingDecision = summary.allocations.filter(
          (a) =>
            a.vehicleId === item.vehicleId &&
            !a.active &&
            (a.status === "RELEASED_AWAITING_DECISION" || a.status === "REVERSING")
        );
        const shown = live.length > 0 ? live : awaitingDecision;
        const fallback = summary.allocations.find((a) => a.vehicleId === item.vehicleId);
        const allocatedMinor = shown.reduce<number | undefined>(
          (sum, a) => (a.allocatedMinor === undefined ? sum : (sum ?? 0) + a.allocatedMinor),
          undefined
        );
        return {
          vehicleId: item.vehicleId,
          label: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`.trim() : "Vehicle",
          unitPrice: item.unitPrice,
          allocatedMinor: shown.length > 0 ? allocatedMinor : fallback?.allocatedMinor,
          status: shown[0]?.status ?? fallback?.status,
          holdId: shown[0]?.holdId ?? fallback?.holdId,
          /**
           * Every share of this car that is off its sale, each with its OWN
           * amount and status.
           *
           * Not a list of ids against the vehicle's total: a car can hold more
           * than one share at once, and printing the vehicle figure beside each
           * of them showed two shares of 1,000 and 2,000 as "3,000" twice —
           * 6,000 on screen where 3,000 exists, and an operator forfeiting
           * "3,000" forfeiting 1,000.
           *
           * REVERSING is included and marked, because the money is real and has
           * to be visible; but it is waiting on the ledger rather than on a
           * person, and `resolveReleasedAllocation` refuses it.
           */
          awaitingDecision: awaitingDecision.map((a) => ({
            holdId: a.holdId,
            amountMinor: a.allocatedMinor ?? 0,
            status: a.status,
          })),
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
      // Every dinar received, in exactly one bucket. The screen shows the whole
      // picture rather than a net figure, because "5,000 held" is the same
      // number whether 2,000 of it was refunded or is still available.
      heldTotalMinor: summary.heldTotalMinor,
      totalReceivedMinor: summary.totalReceivedMinor,
      allocatedMinor: summary.allocatedMinor,
      appliedMinor: summary.appliedMinor,
      reversingMinor: summary.reversingMinor,
      releasedAwaitingDecisionMinor: summary.releasedAwaitingDecisionMinor,
      refundedMinor: summary.refundedMinor,
      forfeitedMinor: summary.forfeitedMinor,
      otherFinalizedMinor: summary.otherFinalizedMinor,
      resolvedOutMinor: summary.resolvedOutMinor,
      unallocatedMinor: summary.unallocatedMinor,
      availableForAllocationMinor: summary.availableForAllocationMinor,
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
      // Every live share of this car, not the oldest one. A re-allocation, or a
      // share returned to the pool and assigned again, opens a NEW hold beside
      // the terminal original — so `.first()` returned a settled row, skipped
      // it, and reported that the car held nothing while its money sat there
      // with no way out.
      const vehicleHolds = await ctx.db
        .query("depositVehicleHolds")
        .withIndex("by_deposit_vehicle", (q) =>
          q.eq("depositId", deposit._id).eq("vehicleId", args.vehicleId)
        )
        .collect();
      // Not qualified by `active`: applying a slice sets `active: false` in the
      // same patch, so asking for both could never be true and the operator got
      // "that vehicle holds no active share" instead of being told to cancel
      // the sale. Matches the sibling guards in allocateToVehicles and
      // resolveReleasedAllocation.
      if (vehicleHolds.some((h) => h.allocationStatus === "APPLIED")) {
        throw new ConvexError(
          "That vehicle's share has already been applied to its completed sale. Cancel the sale before removing the vehicle from the deal."
        );
      }
      for (const hold of vehicleHolds) {
        if (!hold.active) continue;
        await ctx.db.patch(hold._id, {
          active: false,
          allocationStatus: "RELEASED_AWAITING_DECISION",
          releaseReason: args.reason?.trim(),
        });
        releasedMinor += hold.allocatedAmountMinor ?? 0;
        releasedHolds += 1;
      }
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
