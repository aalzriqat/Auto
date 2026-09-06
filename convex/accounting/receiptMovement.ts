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
