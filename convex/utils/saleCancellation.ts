import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  hookDepositApplicationReversed,
  hookDepositSettlementApplicationReversed,
  hookTradeInReversed,
  hookFiCommissionRecognitionsReversed,
} from "../accounting/workflowHooks";
import { reverseAllocation, voidCanonicalPayment } from "../subledger";
import { cancelSupplierReceivablesForSale } from "../supplierReceivables";
import { restoreVehicleFromSale } from "./saleHelpers";
import {
  reactivateAllVehiclesForDeposit,
  syncVehicleHoldStatus,
  hasActiveDepositHold,
  hasActiveReservationHold,
} from "./depositHelpers";
import { reverseDepositApplicationsForSale } from "./depositApplications";
import {
  DeferredAuthorityOutcome,
  authorityOutcomeDetail,
  restoreAuthorityAfterReversal,
  worstAuthorityOutcome,
} from "../commitments";
import { beginUserRun } from "./commitmentKernel";
import { auditLog } from "../financialAudit";

async function getActiveReceivableAllocations(
  ctx: MutationCtx,
  receivableDocumentId: Id<"receivableDocuments">
) {
  return await ctx.db
    .query("paymentAllocations")
    .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", receivableDocumentId))
    .filter((q) => q.eq(q.field("status"), "ACTIVE"))
    .collect();
}

/**
 * Idempotency keys of payments this routine already knows how to safely
 * reverse (in addition to actually reversing them, below) — anything else
 * found allocated against the receivable is an unexpected customer payment,
 * which still blocks automatic cancellation.
 */
async function getSafelyReversiblePaymentKeys(
  ctx: MutationCtx,
  sale: Doc<"sales">
) {
  const keys = new Set<string>();
  if (sale.tradeInVehicleId) {
    keys.add(`trade_in_payment_${sale._id}`);
  }
  if (!sale.quoteId) return keys;
  // Every deposit on the quote, whatever its current status.
  //
  // Filtering to APPLIED broke as soon as one deposit could be consumed by
  // several sales: on a multi-vehicle quote the first cancellation reinstates
  // the row to HELD, so the second sale's own slice — allocated from the very
  // same payment — no longer looked safely reversible and the unwind stopped
  // half done. The key names a payment this system created from this deposit
  // either way, and an unexpected customer payment still has no matching key.
  const deposits = await ctx.db
    .query("deposits")
    .withIndex("by_quote", (q) => q.eq("quoteId", sale.quoteId!))
    .collect();
  for (const deposit of deposits) {
    if (deposit.isDeleted === true) continue;
    keys.add(`deposit_received_${deposit._id}`);
  }
  return keys;
}

async function cancelSaleReceivableIfSafe(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    sale: Doc<"sales">;
    actorId: Id<"users">;
    reason: string;
    reversalDate: number;
  }
) {
  if (!args.sale.canonicalReceivableDocumentId) return;
  const receivable = await ctx.db.get(args.sale.canonicalReceivableDocumentId);
  if (!receivable || receivable.orgId !== args.orgId || receivable.status === "CANCELLED") return;

  const activeAllocations = await getActiveReceivableAllocations(ctx, receivable._id);
  const safeKeys = await getSafelyReversiblePaymentKeys(ctx, args.sale);

  for (const allocation of activeAllocations) {
    const payment = await ctx.db.get(allocation.paymentId);
    if (!payment || payment.orgId !== args.orgId || !safeKeys.has(payment.idempotencyKey)) {
      throw new ConvexError(
        "Cannot automatically cancel a sale with customer payments already applied. Refund or reverse those payments first."
      );
    }
  }

  for (const allocation of activeAllocations) {
    await reverseAllocation(ctx, {
      orgId: args.orgId,
      allocationId: allocation._id,
      actorId: args.actorId,
    });
  }

  // cancelledAt lets accountingReports.ts's historical AR aging /
  // subledger-vs-GL reconciliation exclude this receivable for any asOfDate
  // on/after cancellation, without also hiding it from reports run for a
  // date BEFORE cancellation (when it was still genuinely outstanding).
  await ctx.db.patch(receivable._id, {
    status: "CANCELLED",
    cancelledAt: args.reversalDate,
    cancelledBy: args.actorId,
    cancellationReason: args.reason,
  });
}

/**
 * Refuses automatic trade-in reversal once the incoming vehicle has any
 * activity beyond its original acceptance that would make silently wiping
 * its cost basis and pulling it from sellable inventory unsafe: it's already
 * been resold, it's currently reserved/held by another transaction, or it
 * has landed costs or capitalized repairs recorded against it. Any of these
 * means a human needs to look at this vehicle before its trade-in can be
 * undone — see the docs/production-audit "trade-in cancellation" gap this
 * closes for the concrete failure mode (a cancelled trade-in reappearing as
 * available, zero-cost-basis inventory that could be sold with wrong COGS).
 */
async function assertTradeInVehicleSafeToReverse(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    tradeInVehicleId: Id<"vehicles">;
    tradeInVehicle: Doc<"vehicles">;
  }
) {
  if (args.tradeInVehicle.status === "SOLD") {
    throw new ConvexError(
      "Cannot automatically cancel: this trade-in vehicle has already been resold. Use a manual accounting correction."
    );
  }
  if (args.tradeInVehicle.status === "RESERVED") {
    throw new ConvexError(
      "Cannot automatically cancel: this trade-in vehicle is currently reserved. Use a manual accounting correction."
    );
  }
  const hasHold =
    (await hasActiveDepositHold(ctx, args.tradeInVehicleId)) ||
    (await hasActiveReservationHold(ctx, { orgId: args.orgId, vehicleId: args.tradeInVehicleId }));
  if (hasHold) {
    throw new ConvexError(
      "Cannot automatically cancel: this trade-in vehicle is currently held by another deposit or reservation. Use a manual accounting correction."
    );
  }

  // landedCostTotal is the same authoritative, kept-in-sync field
  // computeVehicleCapitalizedCost reads (set by vehicles.ts's
  // upsertLandedCosts) — no need to separately query vehicleLandedCosts.
  if (args.tradeInVehicle.landedCostTotal && args.tradeInVehicle.landedCostTotal > 0) {
    throw new ConvexError(
      "Cannot automatically cancel: this trade-in vehicle has received landed costs since being accepted. Use a manual accounting correction."
    );
  }

  const capitalizedExpense = await ctx.db
    .query("expenses")
    .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.tradeInVehicleId))
    .filter((q) =>
      q.and(
        q.eq(q.field("accountingTreatment"), "CAPITALIZED_INVENTORY"),
        q.neq(q.field("isDeleted"), true)
      )
    )
    .first();
  if (capitalizedExpense) {
    throw new ConvexError(
      "Cannot automatically cancel: this trade-in vehicle has received capitalized repair/prep costs since being accepted. Use a manual accounting correction."
    );
  }
}

/**
 * Undoes a trade-in fully when the sale it was part of is cancelled: reverses
 * the TRADE_IN_ACCEPTED GL entry, voids the canonical trade-in payment (its
 * allocation was already reversed by cancelSaleReceivableIfSafe, above —
 * voidCanonicalPayment requires that first), clears the vehicle's
 * purchasePrice so it no longer reads as capitalized inventory, and — if it
 * was AVAILABLE — pulls it into IN_INSPECTION so it can't be sold again with
 * a zero cost basis before a human re-establishes one.
 */
async function restoreTradeInVehicle(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    sale: Doc<"sales">;
    actorId: Id<"users">;
    reason: string;
    reversalDate: number;
  }
) {
  const tradeInVehicleId = args.sale.tradeInVehicleId;
  // Must match saleCompletion.ts's exact gate (tradeInVehicleId && tradeInValue
  // > 0) — a sale can store a tradeInVehicleId with no positive tradeInValue,
  // in which case completion never ran the trade-in branch at all. Without
  // this check, cancelling such a sale would still wipe the vehicle's
  // unrelated, legitimate purchasePrice (e.g. from a normal acquisition).
  if (!tradeInVehicleId || !args.sale.tradeInValue || args.sale.tradeInValue <= 0) return;

  const tradeInVehicle = await ctx.db.get(tradeInVehicleId);
  if (!tradeInVehicle || tradeInVehicle.orgId !== args.orgId) return;

  await assertTradeInVehicleSafeToReverse(ctx, {
    orgId: args.orgId,
    tradeInVehicleId,
    tradeInVehicle,
  });

  const payment = await ctx.db
    .query("canonicalPayments")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", args.orgId).eq("idempotencyKey", `trade_in_payment_${args.sale._id}`)
    )
    .unique();
  if (payment && payment.status !== "VOIDED") {
    await voidCanonicalPayment(ctx, {
      orgId: args.orgId,
      paymentId: payment._id,
      actorId: args.actorId,
    });
  }

  await hookTradeInReversed(ctx, {
    orgId: args.orgId,
    vehicleId: tradeInVehicleId,
    saleId: args.sale._id,
    reason: args.reason,
    actorId: args.actorId,
    reversalDate: args.reversalDate,
  });

  await ctx.db.patch(tradeInVehicleId, {
    purchasePrice: undefined,
    // Only downgrade from AVAILABLE — IN_REPAIR/IN_INSPECTION/SOURCING are
    // already not generally sellable, and ARCHIVED must never be silently
    // un-archived by a reversal.
    ...(tradeInVehicle.status === "AVAILABLE" ? { status: "IN_INSPECTION" as const } : {}),
  });
}

/**
 * Cancels every warranty/GAP deferral created at sale completion, clawing
 * back any month(s) of F&I commission already recognized and stopping the
 * monthly cron from recognizing any more (by moving it out of ACTIVE).
 */
async function cancelProductDeferrals(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    actorId: Id<"users">;
    reason: string;
    reversalDate: number;
  }
) {
  const deferrals = await ctx.db
    .query("dealerProductDeferrals")
    .withIndex("by_sale", (q) => q.eq("saleId", args.saleId))
    .collect();

  for (const deferral of deferrals) {
    if (deferral.orgId !== args.orgId || deferral.status === "CANCELLED") continue;
    await hookFiCommissionRecognitionsReversed(ctx, {
      orgId: args.orgId,
      deferralId: deferral._id,
      reason: args.reason,
      actorId: args.actorId,
      reversalDate: args.reversalDate,
    });
    await ctx.db.patch(deferral._id, { status: "CANCELLED" });
  }
}

async function cancelPendingSupplierPayables(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    actorId: Id<"users">;
    now: number;
  }
) {
  // The claim on the other route cancels with the sale too, and refuses for the
  // same reason: money that has already arrived is a correction somebody makes
  // deliberately, not something a cancellation does on its way past.
  await cancelSupplierReceivablesForSale(ctx, {
    orgId: args.orgId,
    saleId: args.saleId,
    actorId: args.actorId,
    now: args.now,
  });

  const payables = await ctx.db
    .query("vehicleSupplierPayables")
    .withIndex("by_sale", (q) => q.eq("saleId", args.saleId))
    .collect();

  const orgPayables = payables.filter((payable) => payable.orgId === args.orgId);
  if (orgPayables.some((payable) => payable.status === "PAID")) {
    throw new ConvexError(
      "Cannot automatically cancel a sale after the supplier payable has been paid. Use a manual accounting correction."
    );
  }

  for (const payable of orgPayables) {
    if (payable.status === "PENDING") {
      await ctx.db.patch(payable._id, {
        status: "CANCELLED",
        cancelledAt: args.now,
        cancelledBy: args.actorId,
        updatedAt: args.now,
      });
    }
  }
}

/**
 * Puts a deposit row back to HELD after one of its applications was reversed.
 *
 * Only from APPLIED. A row that was refunded or forfeited has had real money
 * leave the business, and re-opening it as held would make that money spendable
 * a second time — the reversed slice is accounted for on its own hold row,
 * which is where the decision about it now belongs.
 */
async function reopenDepositAfterReversal(
  ctx: MutationCtx,
  depositId: Id<"deposits">,
  /**
   * SCRUM-208 — MAY THE VEHICLE HOLD COME BACK YET?
   *
   * ⚠️ THE MONEY SIDE AND THE CAR SIDE ARE DIFFERENT QUESTIONS. Taking the row
   * out of APPLIED says the money is no longer consumed by that sale, and that
   * is true the moment the application is reversed or reversing. Setting
   * `holdActive` says the CAR is held again, and on a single-vehicle deposit
   * that flag IS the hold — so doing it while the reversing journal is only
   * queued holds a car against an entry the ledger still shows posted.
   *
   * The multi-vehicle path already knew this and gated its slice on
   * `journalReversed`; the direct path did not, and that asymmetry is the
   * defect. Same class as every other one this phase found: the rule was
   * pinned on the branch somebody looked at and missing from its neighbour.
   *
   * Defaults to true so the callers that reopen a row with no deferred
   * accounting behind it are unchanged.
   */
  options: { reinstateHold?: boolean } = {}
): Promise<Doc<"deposits"> | null> {
  const reinstateHold = options.reinstateHold ?? true;
  const deposit = await ctx.db.get(depositId);
  if (!deposit) return null;
  // A row with money left over never closes as APPLIED — it keeps HELD so the
  // remainder stays refundable — but its hold side is closed all the same, and
  // `resolveDepositsForQuote` skips any deposit whose `holdActive` is false. So
  // after a cancellation the row was invisible to the next completion: the car
  // was re-sold at full price with the customer's own money uncredited, and its
  // share left active on a vehicle now marked SOLD. Every control agreed the
  // books were fine, because they were — the money simply never moved.
  if (deposit.status === "HELD" && deposit.holdActive === false) {
    if (!reinstateHold) return deposit;
    await ctx.db.patch(deposit._id, {
      holdActive: true,
      resolvedBy: undefined,
      resolvedAt: undefined,
      resolutionTreatment: undefined,
      resolutionReason: undefined,
      resolutionSaleId: undefined,
    });
    return await ctx.db.get(depositId);
  }
  if (deposit.status !== "APPLIED") return deposit;
  await ctx.db.patch(deposit._id, {
    status: "HELD",
    // The money is no longer consumed by that sale either way; only the CAR
    // waits for the journal.
    ...(reinstateHold ? { holdActive: true } : {}),
    resolvedBy: undefined,
    resolvedAt: undefined,
    // Cleared alongside the status. Leaving them set pointed a live deposit
    // at the treatment and the sale of a deal that no longer exists, and the
    // settlement re-hook reads `resolutionTreatment` to decide what to post.
    resolutionTreatment: undefined,
    resolutionReason: undefined,
    resolutionSaleId: undefined,
  });
  return await ctx.db.get(depositId);
}

/**
 * Backs out the deposit money THIS sale consumed, and nothing else.
 *
 * Every application carries the accounting coordinates it was posted under (see
 * utils/depositApplications), so the reversal targets one movement exactly.
 * Reversing "the deposit" instead used to take `.first()` among the events
 * sharing its id, which on a two-car quote meant cancelling the second car
 * reversed the first car's entry — stripping a credit from an invoice that was
 * still live while leaving the cancelled one intact.
 *
 * The slice does not flow back to its car. It lands in
 * RELEASED_AWAITING_DECISION, where somebody says what happens to it: back to
 * the quote's unallocated pool, onto another car, refunded, or forfeited. The
 * car itself is freed by `restoreVehicleFromSale` regardless, so nothing about
 * the money's fate blocks re-selling it.
 */
async function reinstateAppliedDeposits(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    quoteId: Id<"quotes"> | undefined;
    actorId: Id<"users">;
    reason: string;
    reversalDate: number;
  }
) {
  const reversed = await reverseDepositApplicationsForSale(ctx, {
    orgId: args.orgId,
    saleId: args.saleId,
    reason: args.reason,
    actorId: args.actorId,
    reversalDate: args.reversalDate,
  });

  // ⚠️ ONE CLOCK AND ONE ACTOR FOR EVERY AUTHORITY DECISION IN THIS
  // CANCELLATION, taken before anything is consulted, so two cars on the same
  // quote cannot be judged against different instants.
  const run = beginUserRun(args.actorId, args.reversalDate);
  const authorityOutcomes: DeferredAuthorityOutcome[] = [];

  const touchedDeposits = new Set<string>();
  for (const application of reversed) {
    touchedDeposits.add(application.depositId.toString());
    // ⚠️ A SLICED DEPOSIT'S PARENT FLAG IS NOT THE CAR HOLD — its slices are,
    // and they are gated below. A DIRECT deposit's flag IS the car hold, so it
    // waits for the reversing journal.
    //
    // ⚠️ AND THIS IS WHERE THE SYNCHRONOUS PATH GETS ITS LIVENESS, IMPLICITLY.
    //
    // The deferred caller re-reads the canonical binding after making its
    // source live, and refuses to write authority if the source did not
    // actually come back — see the `relive` gate in
    // `commitments.restoreAuthorityAfterReversal`. This path has no such gate,
    // because it has no callback for one to verify: the source is made live
    // HERE, earlier in the same transaction, before `restoreAuthorityAfterReversal`
    // is reached further down under the SAME `journalReversed` condition.
    //
    // That ordering is what makes it safe, and it is an INVARIANT NOBODY
    // ASSERTS: a deposit reaching this line with a live application is APPLIED,
    // so it always transitions to HELD + holdActive. Note the asymmetry that
    // makes it worth writing down — unlike `reinstateDirectDepositHold`, this
    // writer does NOT check `isDeleted`. No door can currently produce a
    // deleted deposit still carrying a live application (`deposits.voidDeposit`
    // refuses unless the status is HELD with no APPLIED/REVERSING application,
    // and `deposits` is absent from `adminData`'s ADMIN_TABLES), so there is no
    // reachable counterexample today.
    //
    // But "nothing can reach it" is the claim that has already stopped being
    // true twice on this branch, and the sibling writer carries an `isDeleted`
    // guard for exactly that reason. If a new deposit-mutating door is ever
    // added that does not route through `voidDeposit`'s guards, this is the
    // line that silently stops being safe. Raised by Sonnet MAX against
    // e3850d972; left as a documented invariant rather than a speculative
    // guard, because the reachable behaviour is correct as it stands.
    const deposit = await reopenDepositAfterReversal(ctx, application.depositId, {
      reinstateHold: application.holdId !== undefined || application.journalReversed,
    });
    if (!deposit) continue;

    if (application.holdId) {
      // Multi-vehicle: the slice comes off its sale and waits for a decision.
      // It is NOT silently returned to the pool — the customer put that money
      // against this specific car, and moving it is their call.
      //
      // REVERSING while the reversing journal is only queued. A slice whose
      // original entry is still POSTED is not money anybody may decide about:
      // refunding it then pays the customer an amount the ledger still shows
      // credited against their invoice.
      await ctx.db.patch(application.holdId, {
        active: false,
        allocationStatus: application.journalReversed
          ? "RELEASED_AWAITING_DECISION"
          : "REVERSING",
        appliedSaleId: undefined,
        releaseReason: args.reason,
        resolvedAt: undefined,
        resolvedBy: undefined,
      });
      await syncVehicleHoldStatus(ctx, application.vehicleId, args.actorId);
    } else {
      // Single-vehicle quote: no hold rows exist, the whole row is the slice,
      // and the long-standing behaviour — the deposit goes back on hold against
      // its car — is exactly right.
      //
      // ⚠️ BUT ONLY ONCE THE REVERSING JOURNAL HAS POSTED. While it is merely
      // queued this leaves the car un-held and the money un-restorable, and the
      // outbox finishes the job when the entry posts. Reinstating here would
      // hold a car against an entry the ledger still shows credited — the
      // single-vehicle twin of the slice rule three lines above.
      //
      // ⚠️ HONEST NOTE ON COVERAGE: this gate is belt-and-braces, and its own
      // mutant SURVIVES. The load-bearing gate is `reinstateHold` above — with
      // `holdActive` still false, this call only re-syncs the vehicle
      // projection and reactivates secondary slices, of which a direct deposit
      // has none, so forcing it true changes nothing observable. It is kept
      // because it would become load-bearing the moment `reinstateHold` were
      // loosened, but it is NOT independently proven and should not be read as
      // if it were.
      if (application.journalReversed) {
        await reactivateAllVehiclesForDeposit(ctx, deposit);

        // ⚠️ SCRUM-208 c15808 — THE MONEY CAME BACK, SO THE DEAL COMES BACK.
        //
        // This is the synchronous half of the cancellation spine: the
        // reversing journal already exists, so `reopenDepositAfterReversal`
        // above has just made this deposit hold its car again. Without what
        // follows, the customer's root stays CONSUMED, `resolveOwnership`
        // reports the car FREE, and a rival's `acquireVehicle` succeeds on a
        // car whose original buyer's deposit reads `holdActive: true`. That is
        // the defect SCRUM-195 exists to prevent, reintroduced one layer up.
        //
        // The deferred half lives in `accountingOutbox.settleOneReversalSource`
        // and calls the SAME function, so the two paths cannot drift.
        //
        // ⚠️ BUT THEY ARE NOT PROTECTED THE SAME WAY, AND THAT ASYMMETRY IS
        // DELIBERATE — DO NOT "TIDY" IT AWAY.
        //
        // The deferred caller wraps this in a per-source `try`/`catch` inside
        // `settleFreedHoldsAuthority`, because it runs under
        // `accountingOutbox.drainEntries`, whose own per-row catch would
        // otherwise absorb a throw and COMMIT a half-restoration with no record
        // of it. This synchronous caller has no such catch anywhere in this
        // loop or in either of its callers — so an unexpected throw here
        // propagates out and Convex aborts the whole mutation. Nothing commits.
        // That is a different mechanism reaching the same safety property, and
        // here it is the stronger one.
        //
        // So: adding a `try`/`catch`/`continue` around this call — say, to stop
        // one bad car blocking the others in a multi-vehicle cancellation —
        // would REMOVE that atomic abort and silently reintroduce the exact
        // silent-loss shape SCRUM-208 spent three rounds closing. If that
        // behaviour is ever wanted, it needs the deferred path's full treatment
        // (a recorded, worst-ranked outcome pushed into `authorityOutcomes`),
        // not a bare catch. Raised by Sonnet MAX against 641ead8cb.
        authorityOutcomes.push(
          await restoreAuthorityAfterReversal(ctx, {
            run,
            orgId: args.orgId,
            vehicleId: application.vehicleId,
            source: { kind: "DEPOSIT", depositId: deposit._id },
            saleId: args.saleId,
            createdBy: args.actorId,
          })
        );
      }
    }
  }

  // ⚠️ RECORDED DURABLY, NOT RETURNED AND DROPPED. The deferred path has
  // `pendingAccountingEvents.authorityOutcome` to land on; the synchronous one
  // has no queue row at all — `journalReversed` is precisely the case where no
  // entry was ever queued — so without this an authority result a human must
  // act on would exist only in the shape of the data it failed to change.
  //
  // Written only when a restoration was actually attempted. A cancellation
  // with no direct deposit behind it has nothing to report, and a row saying
  // so on every cancellation would bury the ones that matter.
  // ⚠️ DEFERRED TO EVERY EXIT, NOT TAKEN HERE. This used to run inline, above
  // the zero-share loop below — so an outcome that loop produced could not
  // reach it, and the loop produced none because it performed no restoration at
  // all. Both halves of that are fixed; the audit is now taken after ALL
  // restoration work, at whichever exit the function actually takes.
  const recordWorstAuthorityOutcome = async () => {
    const worst = worstAuthorityOutcome(authorityOutcomes);
    if (!worst) return;
    const detail = authorityOutcomeDetail(worst);
    await auditLog(ctx, {
      orgId: args.orgId,
      actorId: args.actorId,
      actionType: "SETTLE_COMMITMENT_AUTHORITY",
      resourceType: "sales",
      resourceId: args.saleId,
      description: detail
        ? `Commitment authority after cancellation: ${worst.outcome} — ${detail}`
        : `Commitment authority after cancellation: ${worst.outcome}`,
      after: {
        outcome: worst.outcome,
        ...(detail ? { detail } : {}),
        vehiclesSettled: authorityOutcomes.length,
      },
    });
  };

  if (!args.quoteId) {
    await recordWorstAuthorityOutcome();
    return;
  }

  // Slices this sale consumed that carry no money.
  //
  // A zero-amount allocation is a real decision — that car carries none of the
  // deposit — and completion marks its hold APPLIED like any other. But no
  // journal is posted for nothing, so there is no application row for the loop
  // above to find, and the hold stayed APPLIED after its sale was cancelled.
  // The car was then refused a new allocation with "already applied to its
  // completed sale — cancel the sale first", for a sale that had been.
  //
  // The instalment spreader writes these routinely: a payment whose capacity is
  // exhausted carries 0 for every car after the first.
  const quoteDeposits = await ctx.db
    .query("deposits")
    .withIndex("by_quote", (q) => q.eq("quoteId", args.quoteId!))
    .collect();
  for (const deposit of quoteDeposits) {
    const holds = await ctx.db
      .query("depositVehicleHolds")
      .withIndex("by_deposit", (q) => q.eq("depositId", deposit._id))
      .collect();
    for (const hold of holds) {
      if (hold.appliedSaleId !== args.saleId) continue;
      if (hold.allocationStatus !== "APPLIED") continue;
      if ((hold.allocatedAmountMinor ?? 0) !== 0) continue;
      await ctx.db.patch(hold._id, {
        active: true,
        allocationStatus: "ALLOCATED",
        appliedSaleId: undefined,
        resolvedAt: undefined,
        resolvedBy: undefined,
      });
      // Reopen the row's hold side, because a hold that is active again is
      // meaningless on a deposit that is closed — sale completion skips those
      // entirely, so the next sale of this car would ignore the money.
      //
      // Not gated on which sale closed the row: a zero slice posts no journal
      // and so has no application row, so whichever car was sold LAST closed
      // it, and that is rarely the one being cancelled.
      await reopenDepositAfterReversal(ctx, deposit._id);
      await syncVehicleHoldStatus(ctx, hold.vehicleId, args.actorId);

      // ⚠️ SCRUM-208 — THE MONEY WENT BACK ON THE CAR, SO THE DEAL MUST TOO.
      //
      // The asymmetry this closes is exact. In the application-backed loop a
      // FUNDED slice's hold goes DOWN — released, awaiting the customer's
      // decision — so the car is genuinely freed and no authority is owed. This
      // loop does the opposite: it puts the hold back UP. Without what follows,
      // the source was live again over a root that stayed CONSUMED, so
      // `resolveOwnership` reported the car FREE while its projection said
      // RESERVED, and a rival's `acquireVehicle` succeeded on a car the
      // original deal still held money against — the exact defect SCRUM-195
      // exists to prevent, reachable only through the zero-share door.
      //
      // ⚠️ INVISIBLE TO EVERY EXISTING TEST IN THIS AREA, AND THAT IS WHY IT
      // SURVIVED. Every fixture in `multiVehicleDepositAllocation.test.ts`
      // seeds a LEGACY organization, and a LEGACY organization performs no
      // canonical restoration at all — so the whole zero-share path was built
      // and tested in the one regime where this gap cannot appear. The
      // regression test stamps V1 first. Found by Codex xhigh against 6e2dceb83.
      //
      // Same spine and same ordering as the DIRECT case above: the source is
      // made live first, then the decision is taken. No try/catch, for the
      // reason spelled out there — a throw must abort the whole mutation.
      authorityOutcomes.push(
        await restoreAuthorityAfterReversal(ctx, {
          run,
          orgId: args.orgId,
          vehicleId: hold.vehicleId,
          // The sliced representation names its exact hold row.
          source: { kind: "DEPOSIT", depositId: deposit._id, holdId: hold._id },
          saleId: args.saleId,
          createdBy: args.actorId,
        })
      );
    }
  }

  // Deposits applied before applications were recorded. Their journals were
  // posted under the old identity (sourceType "deposits", the deposit's own
  // id), so they are reversed the old way — re-deriving a new-style identity
  // for them would look for an event that was never written, find nothing, and
  // return quietly, leaving the deposit reinstated in the subledger while the
  // GL still showed its liability discharged.
  const legacyDeposits = await ctx.db
    .query("deposits")
    .withIndex("by_quote", (q) => q.eq("quoteId", args.quoteId!))
    .filter((q) => q.eq(q.field("status"), "APPLIED"))
    .collect();

  for (const deposit of legacyDeposits) {
    if (touchedDeposits.has(deposit._id.toString())) continue;
    const applications = await ctx.db
      .query("depositApplications")
      .withIndex("by_deposit", (q) => q.eq("depositId", deposit._id))
      .collect();
    // A deposit that has application rows is governed by them, even if none of
    // them belongs to this sale — reversing it wholesale here is precisely the
    // cross-car reversal this rewrite exists to stop.
    if (applications.length > 0) continue;

    await reopenDepositAfterReversal(ctx, deposit._id);
    const reopened = await ctx.db.get(deposit._id);
    if (reopened) await reactivateAllVehiclesForDeposit(ctx, reopened);
    const reverse =
      deposit.resolutionTreatment === "APPLY_TO_TRANSACTION_SETTLEMENT"
        ? hookDepositSettlementApplicationReversed
        : hookDepositApplicationReversed;
    await reverse(ctx, {
      orgId: args.orgId,
      depositId: deposit._id,
      reason: args.reason,
      actorId: args.actorId,
      reversalDate: args.reversalDate,
    });
  }

  await recordWorstAuthorityOutcome();
}

/**
 * Soft-deletes the VEHICLE_SALE row this sale wrote to the legacy `transactions`
 * cashflow ledger.
 *
 * Every other record a completed sale touches is reversed above, but the
 * cashflow row was left behind — and reports.getProfitAndLoss sums that table,
 * so a cancelled sale kept being reported as revenue forever, with no way for an
 * operator to reconcile it against a sale that no longer exists.
 *
 * `transactions` has no saleId, so the row is matched on org + vehicle +
 * customer + VEHICLE_SALE among rows not already deleted. That is exact here: a
 * vehicle is SOLD for the lifetime of a completed sale and cannot be sold again
 * until this cancellation restores it, so at most one live sale row can exist
 * for that pair at a time.
 *
 * DEPOSIT rows are deliberately left alone — cancelling a sale reinstates the
 * deposit against the quote rather than refunding it, so that cash really was
 * received and still is held.
 */
async function voidSaleCashflowTransaction(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    sale: Doc<"sales">;
    actorId: Id<"users">;
    reversalDate: number;
  }
) {
  const saleRows = await ctx.db
    .query("transactions")
    .withIndex("by_org_vehicle", (q) =>
      q.eq("orgId", args.orgId).eq("vehicleId", args.sale.vehicleId)
    )
    .filter((q) =>
      q.and(
        q.eq(q.field("category"), "VEHICLE_SALE"),
        // ⚠️ THE SALE, NOT A TUPLE THAT RESEMBLES IT — SCRUM-212.
        //
        // This matched on `customerId` before, which does not identify a sale.
        // A first teardown was safe on its own: it voids its row, so two live
        // VEHICLE_SALE rows for one (vehicle, customer) never coexist through
        // the public doors. The damage needed a REPLAY — teardown running a
        // second time for an old sale after the same customer had bought the
        // same car again — and then this filter selected the LATER sale's live
        // row and deleted it, so `reports.getProfitAndLoss` omitted a sale
        // whose journal, receivable and sale row were all still standing.
        //
        // Matching the exact sale removes the ambiguity rather than relying on
        // the replay being unreachable, which is the other half of the fix.
        //
        // Rows carrying no `saleId` are never selected. That is a guarantee
        // this makes explicit rather than a behaviour change: the public
        // `transactions.add` door can write a VEHICLE_SALE row for a vehicle
        // but takes no customerId, so such rows did not match the old filter
        // either. No sale's cancellation is entitled to void them. There is no
        // legacy fallback here by design (c16229 item 5).
        q.eq(q.field("saleId"), args.sale._id),
        q.neq(q.field("isDeleted"), true)
      )
    )
    .collect();

  for (const row of saleRows) {
    await ctx.db.patch(row._id, {
      isDeleted: true,
      deletedAt: args.reversalDate,
      deletedBy: args.actorId,
    });
  }
}

export async function cancelCompletedSaleOperationalRecords(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    sale: Doc<"sales">;
    actorId: Id<"users">;
    reason: string;
    reversalDate: number;
  }
) {
  if (args.sale.commissionPaidAt != null) {
    throw new ConvexError(
      "Cannot automatically cancel a sale after commission has been paid. Use a manual accounting correction."
    );
  }

  await cancelPendingSupplierPayables(ctx, {
    orgId: args.orgId,
    saleId: args.sale._id,
    actorId: args.actorId,
    now: args.reversalDate,
  });
  await cancelSaleReceivableIfSafe(ctx, {
    orgId: args.orgId,
    sale: args.sale,
    actorId: args.actorId,
    reason: args.reason,
    reversalDate: args.reversalDate,
  });
  // Must run after cancelSaleReceivableIfSafe: voidCanonicalPayment requires
  // the trade-in's payment allocation (reversed above) to no longer be ACTIVE.
  await restoreTradeInVehicle(ctx, {
    orgId: args.orgId,
    sale: args.sale,
    actorId: args.actorId,
    reason: args.reason,
    reversalDate: args.reversalDate,
  });
  await cancelProductDeferrals(ctx, {
    orgId: args.orgId,
    saleId: args.sale._id,
    actorId: args.actorId,
    reason: args.reason,
    reversalDate: args.reversalDate,
  });
  await restoreVehicleFromSale(ctx, args.sale.vehicleId, args.sale._id);
  await reinstateAppliedDeposits(ctx, {
    orgId: args.orgId,
    saleId: args.sale._id,
    quoteId: args.sale.quoteId,
    actorId: args.actorId,
    reason: args.reason,
    reversalDate: args.reversalDate,
  });
  await voidSaleCashflowTransaction(ctx, {
    orgId: args.orgId,
    sale: args.sale,
    actorId: args.actorId,
    reversalDate: args.reversalDate,
  });
  await syncVehicleHoldStatus(ctx, args.sale.vehicleId, args.actorId);
}
