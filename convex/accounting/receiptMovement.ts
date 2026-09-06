/**
 * receiptMovement.ts — SCRUM-218-C, the direct-collection receipt movement model.
 *
 * Owner-proxy ruling `c17653`: A + B + C ship together.
 *
 *   A  what a receipt WAS            `receiptMovements`          sealed once
 *   B  what is still owed back       `receiptRetainedPositions`  server-owned
 *   C  each later discharge          `receiptApplications`       append-only
 *
 * ## Why persist at all
 *
 * Receipt disposition is an economic fact created by a movement. Every earlier
 * round of this ticket was rejected for reconstructing it later from
 * `payment.amountMinor − Σ ACTIVE allocations`, and that residual is wrong in
 * four independent ways: a refund reverses allocations so refunded money
 * reappears as "available"; a VOIDED payment still answers; there is no
 * direction or status filter; and a customer DEPOSIT is also a settled payment
 * with no allocation. **"Unallocated" does not identify "unapplied receipt."**
 *
 * ## Why A alone was refused
 *
 * Today a no-receivable receipt credits Customer AR, so a receivable raised
 * later *implicitly nets it off*. Moving that credit to 2110 removes the
 * implicit discharge. Shipping A without C would therefore replace one
 * incorrect lifecycle with an incomplete one — a liability nothing can retire.
 *
 * ## Scope
 *
 * DIRECT COLLECTIONS ONLY. Payment Links and provider receipts are deferred, so
 * the partial-at-intake case (`0 < applied < received` at the moment of receipt)
 * cannot arise here: `recordPayment` and `clearCheque` REFUSE over-receipt. Two
 * intake shapes exist and no third:
 *
 *     with a receivable    applied == received    unapplied == 0
 *     no receivable        applied == 0           unapplied == received
 *
 * Nothing below assumes that, though — the conservation check is written for the
 * general case, because Payment Links will eventually produce the middle row and
 * a guard that only holds for today's inputs is not a guard.
 */
import { ConvexError } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { SYSTEM_KEYS } from "../utils/defaultChart";
import {
  RECEIPT_CREDIT_APPLIED_EVENT_TYPE,
  RECEIPT_CREDIT_APPLIED_SOURCE_TYPE,
} from "./postingRules";
import {
  ReceiptOccurrenceIdentity,
  RECEIPT_PAYLOAD_VERSION,
  toReceiptOccurrenceSnapshot,
  rehydrateReceiptOccurrence,
  describeOccurrence,
} from "./receiptOccurrence";
import { findPostedReceiptOccurrence } from "./workflowHooks";

/**
 * The account a retained receipt credit lives in.
 *
 * ⚠️ Referenced, never created. The 2110 row is a SCRUM-231 cutover artifact;
 * this ticket must not create, adopt, reclassify or substitute it, and in
 * particular must never fall back to `UNAPPLIED_CUSTOMER_CASH` (1220), which is
 * an ASSET on the wrong side of the balance sheet.
 */
export const RETAINED_CREDIT_SYSTEM_KEY = SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY;

/** Aliases of the single definition in `postingRules`, never a second literal. */
export const RECEIPT_APPLICATION_EVENT_TYPE = RECEIPT_CREDIT_APPLIED_EVENT_TYPE;
export const RECEIPT_APPLICATION_SOURCE_TYPE = RECEIPT_CREDIT_APPLIED_SOURCE_TYPE;

export type ReceiptSplit = {
  readonly receivedMinor: number;
  readonly appliedMinor: number;
  readonly unappliedMinor: number;
};

/**
 * The application event's source id — derived from (movement, sequence), so it
 * is known BEFORE the row is inserted and is stable across an exact replay.
 *
 * Length-framed for the same reason SCRUM-237's repeat-occurrence key is: a
 * naive `${movementId}_${sequence}` is only injective while ids happen to
 * exclude the delimiter, and "holds by convention" is not a property. Convex ids
 * contain no `:` today; this does not depend on that staying true.
 */
export function receiptApplicationSourceId(
  receiptMovementId: Id<"receiptMovements">,
  sequence: number
): string {
  const m = receiptMovementId.toString();
  return `rcapp:${m.length}:${m}:${sequence}`;
}

export function receiptApplicationIdempotencyKey(
  receiptMovementId: Id<"receiptMovements">,
  sequence: number
): string {
  return `receipt_credit_applied_${receiptApplicationSourceId(receiptMovementId, sequence)}`;
}

function assertNonNegativeMinor(value: number, name: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ConvexError(`${name} must be a non-negative safe integer.`);
  }
}

/**
 * Seal the immutable record of what this receipt was.
 *
 * ⚠️ NO CALLER SUPPLIES AN AMOUNT. `receivedMinor` is re-read from the canonical
 * payment row and `appliedMinor` is summed from the exact allocation rows this
 * movement created — both inside the same transaction that wrote them. The
 * caller passes identifiers and nothing else that money depends on.
 *
 * That distinction is the one this ticket keeps relearning: re-reading a row
 * proves the seal was not handed a different number, but it does not cleanse the
 * PROVENANCE of the value in the row. Here provenance is sound because the
 * canonical payment and the allocations were both created by this same
 * transaction from a receipt the operator actually entered — not because the
 * read happened.
 *
 * `allocationIds` is recorded from what `allocatePaymentToReceivable` RETURNED,
 * never recovered by set-difference: every write in one Convex transaction can
 * share a `_creationTime`, so timestamps cannot separate this movement's own
 * rows from pre-existing ones.
 */
export async function sealReceiptMovement(
  ctx: MutationCtx,
  args: {
    identity: ReceiptOccurrenceIdentity;
    orgId: Id<"organizations">;
    collectionPaymentId: Id<"collectionPayments">;
    canonicalPaymentId: Id<"canonicalPayments">;
    customerId: Id<"customers">;
    currency: string;
    allocationIds: readonly Id<"paymentAllocations">[];
    actorId: Id<"users">;
  }
): Promise<{ movementId: Id<"receiptMovements">; split: ReceiptSplit }> {
  // The identity must address THIS payment. Without this, a legitimately minted
  // identity for payment A could seal a movement over payment B's money.
  if (args.identity.sourceId !== args.collectionPaymentId.toString()) {
    throw new ConvexError(
      `Receipt occurrence ${describeOccurrence(args.identity)} does not address collection payment ${args.collectionPaymentId}.`
    );
  }

  const canonical = await ctx.db.get(args.canonicalPaymentId);
  if (!canonical || canonical.orgId !== args.orgId) {
    throw new ConvexError("Canonical payment not found for this organization.");
  }
  if (canonical.direction !== "IN") {
    throw new ConvexError("Only an inbound payment can seal a receipt movement.");
  }
  if (canonical.currency.toUpperCase() !== args.currency.toUpperCase()) {
    throw new ConvexError("Receipt currency does not match the canonical payment currency.");
  }
  const receivedMinor = canonical.amountMinor;
  assertNonNegativeMinor(receivedMinor, "receivedMinor");
  if (receivedMinor === 0) {
    throw new ConvexError("A receipt of zero cannot seal a movement.");
  }

  let appliedMinor = 0;
  for (const allocationId of args.allocationIds) {
    const allocation = await ctx.db.get(allocationId);
    if (!allocation || allocation.orgId !== args.orgId) {
      throw new ConvexError("Allocation not found for this organization.");
    }
    // Belongs to THIS payment: an allocation drawn from another payment would
    // otherwise inflate appliedMinor and shrink the retained liability.
    if (allocation.paymentId !== args.canonicalPaymentId) {
      throw new ConvexError("Allocation does not belong to this receipt's canonical payment.");
    }
    if (allocation.status !== "ACTIVE") {
      throw new ConvexError("Only an active allocation can be sealed into a receipt movement.");
    }
    appliedMinor += allocation.amountMinor;
  }

  const unappliedMinor = receivedMinor - appliedMinor;
  if (unappliedMinor < 0) {
    throw new ConvexError(
      `Receipt allocations (${appliedMinor}) exceed the money received (${receivedMinor}).`
    );
  }

  const now = Date.now();
  const movementId = await ctx.db.insert("receiptMovements", {
    orgId: args.orgId,
    collectionPaymentId: args.collectionPaymentId,
    canonicalPaymentId: args.canonicalPaymentId,
    customerId: args.customerId,
    currency: args.currency,
    receivedMinor,
    initialAppliedMinor: appliedMinor,
    initialUnappliedMinor: unappliedMinor,
    initialAllocationIds: [...args.allocationIds],
    occurrence: toReceiptOccurrenceSnapshot(args.identity),
    receiptPayloadVersion: RECEIPT_PAYLOAD_VERSION,
    // Stated, not inferred. A reader must never conclude "no allocation,
    // therefore retained credit" — that inference is what mistakes a customer
    // deposit for an unapplied receipt.
    liabilityTreatment: unappliedMinor > 0 ? "UNAPPLIED_CUSTOMER_RECEIPTS" : "NONE",
    actorId: args.actorId,
    createdAt: now,
  });

  // Only a receipt that actually retained something gets a position. An absent
  // row means "nothing was ever retained here", which is a different fact from
  // "a position that has been drawn down to zero", and the two must stay
  // distinguishable.
  if (unappliedMinor > 0) {
    await ctx.db.insert("receiptRetainedPositions", {
      orgId: args.orgId,
      receiptMovementId: movementId,
      customerId: args.customerId,
      currency: args.currency,
      initialUnappliedMinor: unappliedMinor,
      remainingUnappliedMinor: unappliedMinor,
      applicationCount: 0,
      updatedAt: now,
    });
  }

  return { movementId, split: { receivedMinor, appliedMinor, unappliedMinor } };
}

/**
 * Re-establish the receipt's runtime occurrence authority from its stored
 * snapshot and prove the receipt is actually on the books.
 *
 * Two separate obligations, deliberately in one place because doing only the
 * first is the trap:
 *
 *  1. `rehydrateReceiptOccurrence` proves the snapshot is STRUCTURALLY canonical
 *     and re-mints it through the sanctioned door. It is the only route from
 *     stored data back to authority — reading a row does not restore authority,
 *     re-validating it does. The tenant comes from the authenticated context,
 *     never from the stored blob.
 *  2. `findPostedReceiptOccurrence` proves the GL occurrence EXISTS and is
 *     POSTED. Structural validity says nothing about whether the money reached
 *     the ledger, and a retained credit whose receipt never posted would
 *     otherwise discharge a receivable against a liability that does not exist.
 *     It also refuses an ambiguous tuple rather than choosing the favourable row.
 */
export async function requirePostedReceiptForMovement(
  ctx: MutationCtx,
  movement: Doc<"receiptMovements">
): Promise<ReceiptOccurrenceIdentity> {
  const identity = rehydrateReceiptOccurrence({
    orgId: movement.orgId,
    snapshot: movement.occurrence,
  });
  const posted = await findPostedReceiptOccurrence(ctx, identity);
  if (!posted) {
    throw new ConvexError(
      "This receipt has not reached the general ledger yet, so its retained credit cannot be applied. " +
        "It will become available once the accounting entry posts."
    );
  }
  return identity;
}

/**
 * How much of a requested application may actually happen.
 *
 * Every bound is server-derived: the caller's `requestedMinor` is legitimate
 * INPUT (an operator may genuinely choose to apply part of a credit) but it is
 * evidence to be capped, never authority. The other two bounds come from rows.
 */
export function computeApplicableMinor(args: {
  requestedMinor: number;
  remainingUnappliedMinor: number;
  outstandingMinor: number;
}): number {
  assertNonNegativeMinor(args.requestedMinor, "requestedMinor");
  return Math.min(args.requestedMinor, args.remainingUnappliedMinor, args.outstandingMinor);
}

/**
 * Load the authoritative retained position for a movement, refusing ambiguity.
 *
 * Convex has no unique indexes, so nothing in the schema guarantees one row per
 * movement. `.unique()` fails closed on a duplicate rather than silently picking
 * one — and picking one here would mean two positions over the same retained
 * money, which is an overdraft waiting to happen.
 */
export async function loadRetainedPosition(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  receiptMovementId: Id<"receiptMovements">
): Promise<Doc<"receiptRetainedPositions">> {
  const position = await ctx.db
    .query("receiptRetainedPositions")
    .withIndex("by_org_movement", (q) =>
      q.eq("orgId", orgId).eq("receiptMovementId", receiptMovementId)
    )
    .unique();
  if (!position) {
    throw new ConvexError("This receipt retained no customer credit, so there is nothing to apply.");
  }
  return position;
}

/**
 * Record one application and draw the position down, in one transaction.
 *
 * ⚠️ THE POSITION IS NEVER PATCHED ALONE. The child row and the decrement are
 * written together; a naked patch would move money with no lineage behind it.
 *
 * The re-read of the position immediately before the decrement is not
 * decoration: `remainingUnappliedMinor` is the contended value, and reading it
 * inside the same transaction that writes it is what lets Convex's OCC detect a
 * concurrent application and retry the loser instead of letting both spend the
 * same credit.
 */
export async function recordRetainedApplication(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    movement: Doc<"receiptMovements">;
    position: Doc<"receiptRetainedPositions">;
    receivableId: Id<"receivables">;
    receivableDocumentId: Id<"receivableDocuments">;
    allocationId: Id<"paymentAllocations">;
    amountMinor: number;
    actorId: Id<"users">;
  }
): Promise<{ applicationId: Id<"receiptApplications">; sequence: number; idempotencyKey: string }> {
  if (!Number.isSafeInteger(args.amountMinor) || args.amountMinor <= 0) {
    throw new ConvexError("An application must move a positive amount.");
  }

  const fresh = await ctx.db.get(args.position._id);
  if (!fresh || fresh.orgId !== args.orgId) {
    throw new ConvexError("Retained position not found for this organization.");
  }
  if (args.amountMinor > fresh.remainingUnappliedMinor) {
    throw new ConvexError(
      `Only ${fresh.remainingUnappliedMinor} remains of this retained credit; ${args.amountMinor} was requested.`
    );
  }

  const sequence = fresh.applicationCount + 1;
  const idempotencyKey = receiptApplicationIdempotencyKey(args.movement._id, sequence);
  const now = Date.now();

  const applicationId = await ctx.db.insert("receiptApplications", {
    orgId: args.orgId,
    receiptMovementId: args.movement._id,
    sequence,
    customerId: args.movement.customerId,
    receivableId: args.receivableId,
    receivableDocumentId: args.receivableDocumentId,
    allocationId: args.allocationId,
    amountMinor: args.amountMinor,
    currency: args.movement.currency,
    occurrence: {
      eventType: RECEIPT_APPLICATION_EVENT_TYPE,
      sourceType: RECEIPT_APPLICATION_SOURCE_TYPE,
      sourceId: receiptApplicationSourceId(args.movement._id, sequence),
      eventVersion: 1,
    },
    eventIdempotencyKey: idempotencyKey,
    status: "APPLIED",
    actorId: args.actorId,
    createdAt: now,
  });

  await ctx.db.patch(fresh._id, {
    remainingUnappliedMinor: fresh.remainingUnappliedMinor - args.amountMinor,
    applicationCount: sequence,
    updatedAt: now,
  });

  return { applicationId, sequence, idempotencyKey };
}

/* ------------------------------------------------------------------------- *
 * SCRUM-130 — REVOKING A RECEIPT, FROM ITS PERSISTED LINEAGE
 *
 * A returned cleared cheque invalidates the tender that created the receipt, so
 * every still-live economic consequence of that tender has to be unwound exactly
 * once. The set is enumerable ONLY from the rows above — the initial movement's
 * own allocations, and one child per later application — which is why every
 * earlier round of this ticket was rejected for reaching for `cheque.amount`, a
 * generic ACTIVE-allocation scan, or the mirror row's stale allocation id.
 * ------------------------------------------------------------------------- */

/**
 * The one named refusal for a lineage this ticket must not guess about.
 *
 * ⚠️ NAMED, NOT PARAPHRASED. `c17504` split the economic fate of already-refunded
 * money to SCRUM-221 and required SCRUM-130 to fail closed with a NAMED
 * unsupported-refund-interaction reason rather than infer that outcome from
 * reversed allocations. A machine-readable token is what makes the boundary
 * assertable in a test and greppable when SCRUM-221 lands; without it the caller
 * sees `reverseAllocation`'s bare "Allocation is already reversed.", which
 * describes a symptom and names no owner.
 */
export const CHEQUE_RETURN_UNSUPPORTED_REFUND_INTERACTION =
  "CHEQUE_RETURN_UNSUPPORTED_REFUND_INTERACTION";

/** One later application, paired with the debt it must reopen and by how much. */
export type ReceiptApplicationUnwind = {
  readonly application: Doc<"receiptApplications">;
  readonly allocationId: Id<"paymentAllocations">;
  readonly receivableId: Id<"receivables">;
  readonly amountMinor: number;
};

/**
 * Everything a revocation will touch, proven before anything is written.
 *
 * `initialAppliedMinor` is the amount the RECEIPT ITSELF discharged, read from
 * the sealed movement. It is the reopening amount for the cheque's own debt, and
 * it is NOT `cheque.amount`: the two coincide on today's cheque path only
 * because `clearCheque` refuses over-receipt, and a reopening driven by the face
 * value is wrong the moment that stops being true — which SCRUM-121 contract v3
 * R8 already forbids.
 */
export type ReceiptRevocationPlan = {
  readonly movement: Doc<"receiptMovements">;
  readonly position: Doc<"receiptRetainedPositions"> | null;
  readonly initialAllocationIds: readonly Id<"paymentAllocations">[];
  readonly initialAppliedMinor: number;
  /** Highest sequence FIRST — an unwind runs newest-to-oldest. */
  readonly applications: readonly ReceiptApplicationUnwind[];
  readonly totalApplicationMinor: number;
};

/**
 * Read and VALIDATE the complete unwind for one receipt movement. Writes nothing.
 *
 * ⚠️ THE VALIDATION IS THE POINT, NOT THE READ. Every allocation this receipt
 * persisted — its own, and one per application — must still be ACTIVE. If any is
 * not, something outside this receipt's own history has already transformed the
 * lineage, and the known producer is the refund path: `reverseAllocationsForRefund`
 * reverses ACTIVE allocations on a receivable newest-first and can even SPLIT
 * one, re-allocating the un-refunded remainder under an allocation id no lineage
 * row records. Unwinding on top of that would reopen debts twice, or reopen them
 * for money the customer was already paid back.
 *
 * Enumeration of what can reverse a lineage allocation (search surface: every
 * non-test `.ts` under `convex/`; method: `grep -rn "reverseAllocation("`;
 * candidates classified):
 *
 *   collections.ts   reverseAllocationsForRefund   the refund approval path
 *   collections.ts   returnClearedCheque           this lifecycle itself
 *   subledger.ts     the exported mutation wrapper
 *   utils/saleCancellation.ts                      sale cancellation
 *
 * All four leave the same observable state, and none of them is safe to unwind
 * over. So the refusal is keyed on the OBSERVED state rather than on identifying
 * which producer caused it — a discrimination this ticket has no authority to
 * make, and `c17504` explicitly forbids inventing.
 */
export async function planReceiptRevocation(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    movement: Doc<"receiptMovements">;
  }
): Promise<ReceiptRevocationPlan> {
  const { orgId, movement } = args;
  if (movement.orgId !== orgId) {
    throw new ConvexError("Receipt movement does not belong to this organization.");
  }

  const requireActiveAllocation = async (allocationId: Id<"paymentAllocations">) => {
    const allocation = await ctx.db.get(allocationId);
    if (!allocation || allocation.orgId !== orgId) {
      throw new ConvexError(
        `${CHEQUE_RETURN_UNSUPPORTED_REFUND_INTERACTION}: this receipt's persisted allocation ` +
          `${allocationId} is missing, so the amounts it moved cannot be unwound safely.`
      );
    }
    if (allocation.status !== "ACTIVE") {
      throw new ConvexError(
        `${CHEQUE_RETURN_UNSUPPORTED_REFUND_INTERACTION}: part of this receipt has already been ` +
          `reversed elsewhere — most commonly by an approved refund. Resolve the refund's economic ` +
          `disposition first; returning the cheque now would reopen the debt for money the customer ` +
          `has already been paid back.`
      );
    }
    return allocation;
  };

  for (const allocationId of movement.initialAllocationIds) {
    await requireActiveAllocation(allocationId);
  }

  const rows = await ctx.db
    .query("receiptApplications")
    .withIndex("by_org_movement", (q) =>
      q.eq("orgId", orgId).eq("receiptMovementId", movement._id)
    )
    .collect();

  const applications: ReceiptApplicationUnwind[] = [];
  let totalApplicationMinor = 0;
  // Newest first. An unwind that ran oldest-first would restore a position it is
  // about to draw down again in the same transaction; going backwards through
  // the sequence mirrors the order the applications were created in.
  for (const application of [...rows].sort((a, b) => b.sequence - a.sequence)) {
    // An already-REVERSED child is not an error and not work: an exact replay of
    // the return must produce one effect, not a second reversal.
    if (application.status === "REVERSED") continue;
    await requireActiveAllocation(application.allocationId);
    applications.push({
      application,
      allocationId: application.allocationId,
      receivableId: application.receivableId,
      amountMinor: application.amountMinor,
    });
    totalApplicationMinor += application.amountMinor;
  }

  const position = await ctx.db
    .query("receiptRetainedPositions")
    .withIndex("by_org_movement", (q) =>
      q.eq("orgId", orgId).eq("receiptMovementId", movement._id)
    )
    .unique();

  // Conservation, asserted rather than assumed. The applications may never have
  // moved more than the receipt retained; if they have, the lineage contradicts
  // itself and no unwind derived from it can be trusted.
  if (totalApplicationMinor > movement.initialUnappliedMinor) {
    throw new ConvexError(
      `${CHEQUE_RETURN_UNSUPPORTED_REFUND_INTERACTION}: this receipt's applications total ` +
        `${totalApplicationMinor}, which exceeds the ${movement.initialUnappliedMinor} it retained.`
    );
  }

  return {
    movement,
    position,
    initialAllocationIds: movement.initialAllocationIds,
    initialAppliedMinor: movement.initialAppliedMinor,
    applications,
    totalApplicationMinor,
  };
}

/**
 * Mark the planned applications REVERSED and retire the retained position, in
 * one write set.
 *
 * ⚠️ THE POSITION IS STILL NEVER PATCHED ALONE. `recordRetainedApplication`'s
 * rule was that the position moves only alongside a persisted child; the same
 * rule holds in reverse, which is why this is one function rather than an
 * exported "zero the position" helper a future caller could reach for on its own.
 *
 * ## Why the residue goes to zero rather than back up
 *
 * Economically the unwind is two steps: reversing an application RESTORES
 * retained credit (CR 2110), and reversing the receipt then EXTINGUISHES the
 * whole retained credit (DR 2110). Both journals are written, so the ledger
 * shows both steps and 2110 nets to zero. The POSITION is state, not ledger, and
 * its terminal value after those two steps is zero — writing the intermediate
 * restored value first and then zeroing it in the same transaction would record
 * no additional fact.
 *
 * ⚠️ `applicationCount` IS NOT DECREMENTED. It is the source of the next
 * `sequence`, and a sequence is part of an application's accounting identity;
 * winding it back would let a future application mint the identity a reversed
 * one already used, and the dedupe tuple would then swallow it.
 */
export async function retireReceiptRevocationState(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    plan: ReceiptRevocationPlan;
  }
): Promise<void> {
  const now = Date.now();
  for (const unwind of args.plan.applications) {
    await ctx.db.patch(unwind.application._id, { status: "REVERSED" });
  }
  if (args.plan.position && args.plan.position.remainingUnappliedMinor !== 0) {
    await ctx.db.patch(args.plan.position._id, {
      remainingUnappliedMinor: 0,
      updatedAt: now,
    });
  }
}
