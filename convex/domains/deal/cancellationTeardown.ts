import { ConvexError } from "convex/values";
import { type MutationCtx, type QueryCtx } from "../../_generated/server";
import { type Doc, type Id } from "../../_generated/dataModel";
import { type WithoutSystemFields } from "convex/server";
import { cancelCompletedSaleOperationalRecords } from "../../utils/saleCancellation";
import { assertNoSaleLinkedLegacyReceivable } from "../../utils/saleDebtContainment";
import {
  hookFinanceDisbursementCancelled,
  hookSaleCancelled,
  reverseCommissionForSale,
} from "../../accounting/workflowHooks";
import { handoverStatusForFacts } from "../../utils/financingEconomics";
import { chequesForApplication } from "../../utils/fcCheque";
import { assertFinancedDepositsSurviveParentReversal } from "../../utils/depositApplications";
import { manualPayerOf } from "../../utils/manualFinancePayer";
import { FINANCE_APP_RECEIVABLE_SOURCE } from "./financeReceivables";

/**
 * SCRUM-195 M3. Release every car this application's quote was holding, if
 * nothing else still holds it.
 *
 * Called AFTER `releaseHoldForApplicationQuote`, never before. That helper ends
 * TWO bases in one call — the quote's deposit holds and any same-customer
 * reservation — so a liveness check run first would read a basis this very
 * mutation is about to retire and leave the root open forever.
 */
export async function releaseRootsForApplicationQuote(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    quoteId: Id<"quotes">;
    decisionNow: number;
    reason: string;
  },
  releaseRootIfNoLiveBasis: (
    ctx: MutationCtx,
    args: {
      orgId: Id<"organizations">;
      vehicleId: Id<"vehicles">;
      reason: string;
      decisionNow: number;
    },
  ) => Promise<void>,
): Promise<void> {
  const quote = await ctx.db.get(args.quoteId);
  if (!quote || quote.orgId !== args.orgId) return;
  const items = quote.vehicleItems ?? [{ vehicleId: quote.vehicleId }];
  for (const item of items) {
    await releaseRootIfNoLiveBasis(ctx, {
      orgId: args.orgId,
      vehicleId: item.vehicleId,
      reason: args.reason,
      decisionNow: args.decisionNow,
    });
  }
}

/**
 * SCRUM-447 D4: a finance-company cheque never outlives its deal. Run BEFORE
 * any other write in `cancelApplication`: a HELD cheque is CANCELLED (the deal
 * that owned it is gone), a DEPOSITED one is refused (its bank outcome is
 * unknown — record the return or the clearing first), and terminal rows
 * (CLEARED / RETURNED / CANCELLED / REPLACED) are left as they are. The refusal
 * throws before any cheque is written; a thrown error rolls the whole mutation
 * back.
 */
export async function resolveLinkedChequesForCancellation(
  ctx: MutationCtx,
  app: Doc<"financeApplications">,
  actorId: Id<"users">,
  reason: string,
  now: number,
): Promise<void> {
  const rows = await chequesForApplication(ctx, app._id);
  const deposited = rows.find((row) => row.status === "DEPOSITED");
  if (deposited) {
    throw new ConvexError(
      "A cheque for this deal is already deposited. Record its return (or clearing) before cancelling the deal.",
    );
  }
  for (const row of rows) {
    if (row.status !== "HELD") continue;
    await ctx.db.patch(row._id, {
      status: "CANCELLED",
      cancelledAt: now,
      cancelledBy: actorId,
      cancellationReason: reason,
      updatedAt: now,
    });
  }
}

/**
 * Voids an application that was submitted in error (e.g. against the wrong
 * vehicle) so the deal can be redone cleanly on a fresh quote. CANCELLED is
 * terminal — the application stays visible for audit purposes but can no
 * longer be acted on. Releases any deposit-driven vehicle hold tied to the
 * quote, same as a rejection. CLOSED applications can be cancelled only while
 * no disbursement has been confirmed, because that branch unwinds the sale,
 * vehicle, deposits, and posted accounting records.
 */
/**
 * The teardown of a CLOSED deal: refuses while the finance-company receivable
 * holds live allocations, reverses a COMPLETED sale (journal, commission,
 * operational records), reverses the finance disbursement and cancels the
 * finance-company receivable. Extracted unchanged from `cancelApplication` so
 * the unwind of a paid deal (SCRUM-693, `finishDealUnwind`) runs the exact
 * same teardown; each caller keeps its own refusals in front of it.
 */
export async function cancelClosedApplicationTeardown(
  ctx: MutationCtx,
  args: {
    app: Doc<"financeApplications">;
    actorId: Id<"users">;
    reason: string;
    cancellationReason: string;
    now: number;
  },
  assertNoActiveAllocations: (
    ctx: QueryCtx | MutationCtx,
    receivableDocumentId: Id<"receivableDocuments">,
  ) => Promise<void>,
): Promise<void> {
  const { app, actorId, reason, cancellationReason, now } = args;
  const orgId = app.orgId;
  const applicationId = app._id;
  // SCRUM-121A-PRE §5.1 — resolved and gated HERE, above every write
  // in this branch, so a refusal leaves the deal exactly as it was.
  //
  // `app.disbursedAt` was the only thing standing in for this, and it
  // is not sufficient: `subledger.allocate` allocates against the
  // finance-company document without touching the application at all,
  // so `disbursedAt` stays unset and the guard above sees a clean deal
  // while the subledger holds live money. The document itself is the
  // only thing that knows.
  //
  // Scope note: this reads the canonical receivable and refuses. It
  // deliberately changes nothing about `confirmDisbursement`, the
  // remittance economics, the settlement route, or the deal teardown
  // below.
  // SCRUM-27 (D5): found by SOURCE for a manual company too. Gating on
  // `companyId` alone would skip both the allocation guard and the void.
  const financeReceivable =
    app.companyId || manualPayerOf(app)
      ? await ctx.db
          .query("receivableDocuments")
          .withIndex("by_org_source", (q) =>
            q
              .eq("orgId", orgId)
              .eq("sourceType", FINANCE_APP_RECEIVABLE_SOURCE)
              .eq("sourceId", applicationId),
          )
          .unique()
      : null;
  if (financeReceivable && financeReceivable.status !== "CANCELLED") {
    await assertNoActiveAllocations(ctx, financeReceivable._id);
  }

  if (app.finalizedSaleId) {
    const sale = await ctx.db.get(app.finalizedSaleId);
    if (sale && sale.orgId === orgId) {
      // ⚠️ THE PARENT REVERSAL RUNS FIRST, AND ITS OUTCOME IS A GATE.
      //
      // Operational reinstatement used to run first and hand the deposit
      // back before anyone knew whether the sale's journal had actually
      // reversed. For a FINANCED_SALE_CONSIDERATION deposit that is the
      // whole question: its release lives inside the sale entry, so a
      // DEFERRED parent leaves the release standing while the deposit
      // reads as available again.
      //
      // Safe in both directions, verified rather than assumed: nothing in
      // `cancelCompletedSaleOperationalRecords` reads `accountingEvents`,
      // and `reverseAccountingEvent` reads only the ORIGINAL event's own
      // stored journal — never current sale or deposit state. So neither
      // half depends on the other having run.
      //
      // The refusal below is a real rollback boundary: these mutations are
      // not wrapped in try/catch, so an uncaught throw discards the queued
      // reversal and every other write in the transaction.
      // ⚠️ THE EXACT TRANSITION, NOT MERELY 'NOT CANCELLED' — SCRUM-212-R1.
      //
      // This asked `sale.status !== "CANCELLED"`, which is a different
      // question from the one the invariant is about. Every other status
      // answered yes — PENDING included, and a CANCELLED sale could be
      // reopened to PENDING through `sales.update`. A sale that never
      // completed would then run the full completed-sale teardown.
      //
      // Only a COMPLETED sale has a projection, a journal, an accrual and
      // a cashflow row to reverse, so only a COMPLETED sale may be torn
      // down. Reopening is now also refused at that door; this guard does
      // not depend on that one holding.
      if (sale.status === "COMPLETED") {
        await ctx.db.patch(sale._id, { status: "CANCELLED" });
        await hookSaleCancelled(ctx, {
          orgId: orgId,
          saleId: sale._id,
          reason,
          actorId: actorId,
          reversalDate: now,
        });
        await assertFinancedDepositsSurviveParentReversal(ctx, {
          orgId: orgId,
          saleId: sale._id,
        });
        // Accrual plus every correction posted against it, called
        // unconditionally for the same reason sales.update's
        // cancellation does — it is the same entry point, so the two
        // void paths cannot drift apart.
        await reverseCommissionForSale(ctx, {
          orgId: orgId,
          saleId: sale._id,
          adjustmentSeq: sale.commissionAdjustmentSeq ?? 0,
          reason,
          actorId: actorId,
          reversalDate: now,
        });

        // ⚠️ INSIDE THE TRANSITION THAT OWNS IT — SCRUM-212.
        //
        // This sat outside the status block, so re-entering on a sale
        // that was already CANCELLED skipped the reversal, the commission
        // void and the deposit gate — and still ran the destructive
        // teardown. By then the car could belong to a LATER sale, and the
        // teardown would restore it out from under one that is still
        // COMPLETED, voiding that sale's cashflow row on the way past.
        //
        // Destructive teardown belongs to the one transaction that
        // performs COMPLETED -> CANCELLED for this exact sale, so it now
        // lives inside the block that performs it and runs at most once.
        // Everything below stays outside: cancelling the application's
        // own receivable, disbursement and root state IS idempotent on
        // re-entry, and re-entry still needs to reach it.
        //
        // The deposit gate above still precedes it, and now does so on
        // the only path that reaches it — so the duplicate call this
        // block used to need is gone with the hole it was covering.
        await cancelCompletedSaleOperationalRecords(ctx, {
          orgId: orgId,
          sale,
          actorId: actorId,
          reason,
          reversalDate: now,
        });
      } else if (sale.status !== "CANCELLED") {
        // A draft that never completed. Cancelling the application ends
        // the deal, so the sale goes with it — but `createDraft` performs
        // no inventory, deposit, CRM or accounting side effects, so there
        // is nothing to reverse and nothing to hand back.
        // SCRUM-571 T2: a sale exit refuses while a sale-linked legacy receivable exists.
        await assertNoSaleLinkedLegacyReceivable(ctx, orgId, sale._id);
        await ctx.db.patch(sale._id, { status: "CANCELLED" });
      }
    }
  }

  const quote = await ctx.db.get(app.quoteId);
  // Deliberately NOT gated on the settlement route.
  //
  // It looks like it should be: on the direct route `finalizeDeal`
  // posted no FINANCE_DISBURSED event and opened no finance-company
  // receivable, so there is nothing to reverse. But the block is already
  // a no-op in that case — `reverseEventIfPosted` returns NOT_POSTED
  // when nothing was posted, `cancelPendingPostByKey` finds no queued
  // row, and `financeReceivable` is null so the patch is skipped. The
  // guard bought nothing.
  //
  // What it DID buy was a hole. It re-derived the route from the LIVE
  // vehicle, while finalization acted on the state as it was months
  // earlier. A vehicle converted SOURCED -> STOCK before finalization
  // (allowed: `retroactiveOwnershipChangeRefusal` only refuses once the
  // vehicle is SOLD) posts the ordinary finance receivable, and being
  // converted back to SOURCED afterwards made this branch skip the
  // reversal that `origin/main` performs — leaving AR-Finance-Companies
  // debited and an OPEN receivable on a voided deal, permanently.
  //
  // Same reasoning as `sales.ts`: "reverseEventIfPosted no-ops when
  // there is nothing on the books and cancels anything still queued, so
  // gating on the live amount only created holes."
  if (
    (app.companyId || manualPayerOf(app)) &&
    ((quote?.totalFinancedAmount ?? 0) > 0 || financeReceivable)
  ) {
    await hookFinanceDisbursementCancelled(ctx, {
      orgId: orgId,
      applicationId: applicationId,
      reason,
      actorId: actorId,
      reversalDate: now,
    });

    // The canonical finance-company receivable opened at finalizeDeal
    // is no longer owed once the deal is voided (this branch already
    // rejects deals whose disbursement was received).
    if (financeReceivable && financeReceivable.status !== "CANCELLED") {
      // SCRUM-121A-PRE §5.2 — the same metadata the other two writers
      // now carry. Without `cancelledAt`, `getReceivablesAsOf` keeps
      // this document in every historical AR report forever, while this
      // very branch reverses its GL.
      //
      // `cancellationReason` (not `reason`) is the trimmed fallback, so
      // this is never stored blank. They are separate constants on
      // purpose: `reason` still feeds the sale reversal, the commission
      // void and the teardown, which are outside this stage's slice.
      await ctx.db.patch(financeReceivable._id, {
        status: "CANCELLED",
        cancelledAt: now,
        cancelledBy: actorId,
        cancellationReason,
      });
    }
  }
}

/**
 * The application side of a cancellation: the CANCELLED patch, the release of
 * the quote's roots and the status-log row. Shared by `cancelApplication` and
 * `finishDealUnwind` (SCRUM-693).
 */
export async function closeOutCancelledApplication(
  ctx: MutationCtx,
  args: {
    app: Doc<"financeApplications">;
    actorId: Id<"users">;
    now: number;
    cancellationReason: string;
    note: string | undefined;
    failurePatch?: Partial<WithoutSystemFields<Doc<"financeApplications">>>;
  },
  releaseRootIfNoLiveBasis: (
    ctx: MutationCtx,
    args: {
      orgId: Id<"organizations">;
      vehicleId: Id<"vehicles">;
      reason: string;
      decisionNow: number;
    },
  ) => Promise<void>,
): Promise<void> {
  const { app, actorId, now, cancellationReason } = args;
  await ctx.db.patch(app._id, {
    status: "CANCELLED",
    updatedAt: now,
    cancelledBy: actorId,
    cancelledAt: now,
    cancellationReason,
    creditDecision: "CANCELLED",
    // This branch has already reversed the sale and voided the
    // finance-company receivable, so nothing is expected any more. The
    // handover timestamp is deliberately left alone — the vehicle
    // physically went to the customer and later came back, and erasing
    // that is not the same as reversing it — but a cancelled deal that
    // was never handed over must not keep claiming it is READY to be.
    settlementStatus: "NOT_READY",
    handoverStatus: handoverStatusForFacts({ ...app, status: "CANCELLED" }),
    // A gap nobody will now negotiate. FAILED is the terminal value the
    // validator already carries for exactly this.
    ...(app.gapResolution === "PENDING_NEGOTIATION"
      ? { gapResolution: "FAILED" as const }
      : {}),
    ...(args.failurePatch ?? {}),
  });

  // SCRUM-195 M3. AFTER the application row itself is CANCELLED, so the
  // FINANCE basis is genuinely gone when the predicate runs. Before this
  // patch the application is still in the in-flight set and the root
  // would correctly refuse to release.
  await releaseRootsForApplicationQuote(
    ctx,
    {
      orgId: app.orgId,
      quoteId: app.quoteId,
      decisionNow: now,
      reason: "finance application cancelled",
    },
    releaseRootIfNoLiveBasis,
  );

  await ctx.db.insert("applicationStatusLog", {
    orgId: app.orgId,
    applicationId: app._id,
    fromStatus: app.status,
    toStatus: "CANCELLED",
    changedBy: actorId,
    changedAt: now,
    note: args.note,
  });
}
