/**
 * SCRUM-237 — the canonical receipt accounting occurrence identity.
 *
 * ## What this file is for
 *
 * One economic receipt must have exactly ONE accounting occurrence identity,
 * and that same identity must drive every consumer of it: movement provenance,
 * outbox enqueue, replay, the POSTED causal check, and reversal lookup. Today
 * those consumers each rebuild the identity by hand from loose strings, which
 * is why they can drift apart without anything failing.
 *
 * This module defines the identity as a VALUE that can only be constructed one
 * way per channel, and derives everything else from it. It deliberately does
 * not rewire any producer — removing the old `hookCollectionPayment` and
 * repointing `recordPayment` / `clearCheque` is SCRUM-236, and persisting the
 * identity on the row is SCRUM-218-C. This file is the contract those two
 * consume.
 *
 * ## The reviewed identity map (owner-proxy ruling c17579)
 *
 *   Direct collection   COLLECTION_PAYMENT     collectionPayments   <collectionPaymentId>
 *   Payment link        PAYMENT_LINK_RECEIVED  paymentIntents       <paymentIntentId>
 *
 * ## Why the identity is not keyed on the row you would expect
 *
 * A `collectionPayments` row is NOT evidence of a `collectionPayments`-sourced
 * occurrence. Seven production sites insert that row and only three mint that
 * identity: the payment-link path writes one as operational lineage inside the
 * same mutation that books its economics against `paymentIntents`, and the
 * deposit paths book theirs against `deposits`. Keying the identity on the row
 * would hand payment-link and deposit receipts a SECOND identity beside the one
 * they already carry — the one-receipt-two-journals defect SCRUM-223 exists to
 * remove. A table name is not a source family.
 *
 * ## Three things this identity is deliberately NOT
 *
 * - **Not `canonicalPayments`.** That table is monetary and provenance
 *   authority. It spans finance disbursements, collections and intents, and
 *   `createCanonicalPayment` returns an EXISTING row on idempotency-key
 *   collision, so row-to-occurrence is not 1:1 there. Provenance authority and
 *   accounting source identity are different jobs.
 * - **Not a deposit family.** Deposits are the negative control for this
 *   contract, not another receipt family. `DEPOSIT_RECEIVED` is sourced from
 *   `deposits` and stays that way; if a change here makes a deposit
 *   constructible as a receipt occurrence, the change is wrong.
 * - **Not manufacturable from a legacy row.** See "Legacy tokens" below.
 *
 * ## What the branded type does and does not prove (owner-proxy c17593 §5)
 *
 * The constructors accept `Id<"collectionPayments">` / `Id<"paymentIntents">`,
 * so an `Id<"transactions">` or `Id<"deposits">` is a COMPILE ERROR. State the
 * boundary truthfully, though:
 *
 * > This proves the TypeScript SOURCE-FAMILY type only. It does NOT prove the
 * > row exists, belongs to this org or customer, or represents trusted money.
 *
 * It is repository/type-level CONSTRUCTIBILITY CONTROL, not a database or
 * security boundary — and an unsafe `as` cast inside trusted server code
 * bypasses it. Loading and proving the exact source, canonical-payment and
 * movement provenance before monetary authority is sealed remains SCRUM-218-C's
 * job. A branded object is not a substitute for those runtime proofs.
 */
import { Id } from "../_generated/dataModel";
import { EventType } from "./postingRules";

/**
 * Brand. `ReceiptOccurrenceIdentity` carries a property no caller can produce,
 * so the value cannot be assembled from an object literal — it can only come
 * out of one of the channel constructors below. This is the whole enforcement
 * mechanism: reviewers should treat any `as` cast onto this type as a defect.
 */
declare const RECEIPT_OCCURRENCE_BRAND: unique symbol;

/** The two channels that mint a v2 receipt occurrence. Exhaustive by design. */
export type ReceiptChannel = "DIRECT_COLLECTION" | "PAYMENT_LINK";

/**
 * The canonical identity of one receipt accounting occurrence.
 *
 * The four ECONOMIC fields — eventType, sourceType, sourceId, eventVersion —
 * are the immutable occurrence core (owner-proxy c17593 §2). They are exactly
 * the columns of the existing `by_org_event_source_version` index on
 * `accountingEvents` (`["orgId", "eventType", "sourceType", "sourceId",
 * "eventVersion"]`), so this value addresses a real, already-indexed row range
 * rather than inventing a parallel addressing scheme.
 *
 * `channel` is carried for key derivation and diagnostics. It is a function of
 * `eventType`/`sourceType`, not an independent degree of freedom.
 */
export type ReceiptOccurrenceIdentity = {
  readonly orgId: Id<"organizations">;
  readonly eventType: Extract<EventType, "COLLECTION_PAYMENT" | "PAYMENT_LINK_RECEIVED">;
  readonly sourceType: "collectionPayments" | "paymentIntents";
  readonly sourceId: string;
  /**
   * ECONOMIC occurrence discriminator — which repeat of this event against this
   * source. NOT a schema or payload version, and it must never be used as one.
   *
   * `postAccountingEvent` dedupes on (eventType, sourceType, sourceId,
   * eventVersion). Setting this to 2 to mean "v2 payload shape" would therefore
   * not annotate the row, it would declare a SECOND ECONOMIC RECEIPT against
   * the same source, and the ledger would post twice. Payload and authority
   * versioning gets its own field — see `RECEIPT_PAYLOAD_VERSION` below.
   */
  readonly eventVersion: number;
  readonly channel: ReceiptChannel;
  readonly [RECEIPT_OCCURRENCE_BRAND]: true;
};

/**
 * Payload / authority shape version, kept strictly separate from
 * `eventVersion`, and NOT part of the economic occurrence identity
 * (owner-proxy c17593 §2).
 *
 * The distinction is load-bearing. These two:
 *
 *   same economic tuple + v1 gross payload
 *   same economic tuple + v2 movement payload
 *
 * must COLLIDE as the same occurrence and then fail semantic replay because the
 * payload/authority differs. They must not become two idempotency keys and two
 * journals merely because the payload version changed. That is why
 * `occurrenceIdempotencyKey` below does not read this value: letting it into
 * the key would mint a second occurrence for one receipt, which is precisely
 * the defect this ticket exists to make unrepresentable.
 *
 * SCRUM-237 defines it; SCRUM-218-C persists it as `receiptPayloadVersion`.
 */
export const RECEIPT_PAYLOAD_VERSION = 2 as const;

/**
 * Legacy tokens are NON-AUTHORITY (owner-proxy c17593 §4, carried from the
 * SCRUM-223 certification finding).
 *
 *   transactions.add     -> key may be absent entirely
 *   transactions.update  -> a row RETAGGED to COLLECTION_PAYMENT keeps the
 *                           idempotencyKey it was born with, inherited from an
 *                           unrelated original category
 *
 * The second case is the dangerous one: it is a plausible-looking correlation
 * token that correlates to NOTHING. An absence is detectable; a false positive
 * is not. Therefore NO value on a legacy `transactions` row is canonical
 * correlation evidence for a v2 receipt occurrence, however valid it looks, and
 * a manual or retagged `transactions`/COLLECTION_PAYMENT row can neither
 * construct a receipt identity nor influence `occurrenceIdempotencyKey`.
 *
 * This is enforced structurally rather than by convention: no function in this
 * module accepts a `transactions` id or a caller-supplied key, so there is no
 * parameter through which such a token could arrive.
 */

/**
 * The stored idempotency-key prefix per channel.
 *
 * These are the EXACT prefixes already written to production rows by the
 * ACCOUNTING producers — `makeCollectionHook`'s
 * `idempotencyKey: \`${keyPrefix}_${paymentId}\`` at `workflowHooks.ts:943`,
 * instantiated as `hookCollectionPayment` at `workflowHooks.ts:957` and called
 * from `collections.ts:1099` and `collections.ts:1404`; and
 * `hookPaymentLinkReceived`'s `payment_link_received_<intentId>`.
 *
 * NOT `collections.ts:474`. That line builds an identically-spelled key for
 * `createCanonicalPayment` — a `canonicalPayments` row, which this very file
 * disclaims above as a different job. The strings coincide, which is precisely
 * why citing it looked right; it is the wrong table's key and a future engineer
 * re-verifying the claim there would find nothing to do with `accountingEvents`.
 *
 * They are spelled
 * out rather than derived from `eventType.toLowerCase()` — which would happen
 * to produce the same two strings today — because a silent change to this
 * value orphans every already-posted event from its own replay check, and a
 * lookup table makes that a visible edit instead of an emergent one.
 */
const CHANNEL_KEY_PREFIX: Record<ReceiptChannel, string> = {
  DIRECT_COLLECTION: "collection_payment",
  PAYMENT_LINK: "payment_link_received",
};

/**
 * The namespace that separates repeat-occurrence keys from legacy v1 keys.
 *
 * Disjointness is what makes the two key spaces non-colliding, so it is checked
 * at module load rather than left as a comment: adding a channel whose prefix
 * began with `occv` would silently reintroduce the collision this exists to
 * remove. A module-load throw is loud, immediate and impossible to miss.
 */
const REPEAT_KEY_NAMESPACE = "occv";

for (const [channel, prefix] of Object.entries(CHANNEL_KEY_PREFIX)) {
  if (prefix.startsWith(REPEAT_KEY_NAMESPACE)) {
    throw new Error(
      `channel ${channel} prefix "${prefix}" collides with the repeat-occurrence namespace "${REPEAT_KEY_NAMESPACE}"`
    );
  }
}

/**
 * `eventVersion` is typed `number`, which admits 0, negatives, fractions, NaN
 * and Infinity. None of those is a meaningful economic occurrence, and each
 * would silently become part of a stored idempotency key (`_occNaN`, `_occ0`).
 * Refuse at construction so a bad value cannot reach the ledger at all.
 */
function assertOccurrence(eventVersion: number): void {
  if (!Number.isSafeInteger(eventVersion) || eventVersion < 1) {
    throw new Error(
      `receipt occurrence must be a safe integer >= 1, received ${String(eventVersion)}`
    );
  }
}

function identity(
  parts: Omit<ReceiptOccurrenceIdentity, typeof RECEIPT_OCCURRENCE_BRAND>
): ReceiptOccurrenceIdentity {
  assertOccurrence(parts.eventVersion);
  return parts as ReceiptOccurrenceIdentity;
}

/**
 * Identity for a receipt taken directly through the collections module
 * (`recordPayment`, and a cheque reaching `clearCheque`).
 *
 * `paymentId` is typed as the collection-payment row id, which is what makes a
 * legacy `transactions` row structurally unable to reach this constructor.
 */
export function directCollectionReceipt(args: {
  orgId: Id<"organizations">;
  paymentId: Id<"collectionPayments">;
  /** Repeat economic occurrence against the same payment. Defaults to 1. */
  occurrence?: number;
}): ReceiptOccurrenceIdentity {
  return identity({
    orgId: args.orgId,
    eventType: "COLLECTION_PAYMENT",
    sourceType: "collectionPayments",
    sourceId: args.paymentId.toString(),
    eventVersion: args.occurrence ?? 1,
    channel: "DIRECT_COLLECTION",
  });
}

/**
 * Identity for a receipt settled through a payment link.
 *
 * Sourced from the INTENT, not from the `collectionPayments` row the same
 * mutation also writes. That row is operational lineage; the intent is where
 * this receipt's economics are booked. A payment-link producer must call THIS
 * constructor and must never reconstruct the tuple from its downstream
 * `collectionPayments` row (owner-proxy c17593 §6).
 */
export function paymentLinkReceipt(args: {
  orgId: Id<"organizations">;
  intentId: Id<"paymentIntents">;
  /** Repeat economic occurrence against the same intent. Defaults to 1. */
  occurrence?: number;
}): ReceiptOccurrenceIdentity {
  return identity({
    orgId: args.orgId,
    eventType: "PAYMENT_LINK_RECEIVED",
    sourceType: "paymentIntents",
    sourceId: args.intentId.toString(),
    eventVersion: args.occurrence ?? 1,
    channel: "PAYMENT_LINK",
  });
}

/**
 * The idempotency key for this occurrence — DERIVED, never supplied.
 *
 * This is the point of the contract, and owner-proxy c17593 §3 makes it the
 * ONLY constructor for a v2 receipt outbox key:
 *
 *   idempotencyKey = f(eventType, sourceType, sourceId, eventVersion)
 *
 * `postOrEnqueue` short-circuits on a POSTED row found by `by_org_idempotency`,
 * while `postAccountingEvent` dedupes on the (eventType, sourceType, sourceId,
 * eventVersion) tuple. Those are two different keys for one occurrence, and
 * today nothing makes them agree — the collection hook happens to build both
 * from `paymentId`, which is a convention of one call site, not an invariant.
 * Deriving the key from the identity makes them the same fact by construction.
 *
 * ## Injectivity — and the naive form that is NOT injective
 *
 * An earlier revision of this function derived `${base}_occ${eventVersion}`.
 * That is NOT injective, and two independent reviewers produced the same
 * counterexample:
 *
 *   sourceId "X_occ2" at eventVersion 1  ->  "collection_payment_X_occ2"
 *   sourceId "X"       at eventVersion 2  ->  "collection_payment_X_occ2"
 *
 * Two DISTINCT economic tuples, one key. Because `postOrEnqueue` short-circuits
 * on a POSTED row found by that key BEFORE `postAccountingEvent` ever compares
 * the tuple, the second receipt would be silently absorbed — recorded in the
 * subledger, absent from the ledger. The claim that the old form was "injective
 * across the whole domain the type permits" was simply false: it swept
 * `eventVersion` for a FIXED `sourceId` and never the two-dimensional space
 * where the collision lives.
 *
 * The fix is a disjoint namespace plus length-prefixed fields:
 *
 *   v == 1   ->  `${prefix}_${sourceId}`                       (legacy, exact)
 *   v  > 1   ->  `occv${v}:${p.length}:${p}:${id.length}:${id}`
 *
 * A v1 key always begins with a channel prefix; a repeat key always begins with
 * `occv`. No channel prefix may begin with `occv` — asserted below, not assumed.
 * Within the repeat namespace every variable-length field carries its own
 * length, so the string is uniquely decodable and therefore injective for ANY
 * `sourceId`, including one containing the delimiters.
 *
 * This does not rest on Convex ids being base-32 and free of `_` or `:`. That
 * happens to be true today, but `sourceId` is typed `string`, this file already
 * has a sibling elsewhere in the codebase that builds a COMPOSITE sourceId
 * (`${vehicleId}_${editToken}`), and a property that holds only by convention
 * is not a property.
 *
 * ## Backward compatibility
 *
 * For `eventVersion === 1` this returns byte-identical keys to those already
 * stored (`collection_payment_<paymentId>` from the hook factory at
 * `workflowHooks.ts:943`, `payment_link_received_<intentId>` from
 * `hookPaymentLinkReceived`), so existing POSTED events keep matching their own
 * replay check. Only the repeat-occurrence form changed, and nothing has ever
 * posted through it — the facade is unused — so the change carries no
 * migration.
 *
 * `RECEIPT_PAYLOAD_VERSION` is deliberately absent from this computation.
 */
export function occurrenceIdempotencyKey(id: ReceiptOccurrenceIdentity): string {
  assertOccurrence(id.eventVersion);
  const prefix = CHANNEL_KEY_PREFIX[id.channel];
  if (id.eventVersion === 1) return `${prefix}_${id.sourceId}`;
  return `${REPEAT_KEY_NAMESPACE}${id.eventVersion}:${prefix.length}:${prefix}:${id.sourceId.length}:${id.sourceId}`;
}

/**
 * The reversal key for this occurrence — also derived, for the same reason.
 *
 * `reverseEventIfPosted` takes `reversalIdempotencyKey` AND
 * `pendingPostIdempotencyKey` as two independent strings, and nothing makes the
 * second agree with the forward key that actually enqueued the row. If they
 * disagree, `cancelPendingPostByKey` cancels nothing and an unposted forward
 * entry survives a reversal that reported NOT_POSTED. Deriving both from the
 * one identity removes the opportunity.
 */
export function occurrenceReversalIdempotencyKey(id: ReceiptOccurrenceIdentity): string {
  return `${occurrenceIdempotencyKey(id)}_reversal`;
}

/**
 * The exact index range that addresses this occurrence in `accountingEvents`
 * (owner-proxy c17593 §7).
 *
 * Every consumer — forward post, outbox enqueue, replay, the POSTED causal
 * check and reversal lookup — must address the row through this, so that
 * "which row is this receipt?" has one answer instead of one per call site.
 *
 * Convex has NO unique indexes, so this range is not guaranteed by the
 * database to hold at most one row. Cardinality must be asserted by the caller
 * where it matters; it can never be inferred from the schema.
 */
export function occurrenceIndexRange(id: ReceiptOccurrenceIdentity) {
  return {
    index: "by_org_event_source_version" as const,
    orgId: id.orgId,
    eventType: id.eventType,
    sourceType: id.sourceType,
    sourceId: id.sourceId,
    eventVersion: id.eventVersion,
  };
}

/**
 * Human-readable form for audit records, error messages and handoff notes.
 * Deliberately not parseable back into an identity — round-tripping through a
 * string is exactly how a caller-supplied identity gets reintroduced.
 */
export function describeOccurrence(id: ReceiptOccurrenceIdentity): string {
  return `${id.eventType}/${id.sourceType}/${id.sourceId}@v${id.eventVersion}`;
}

/**
 * Forward-posting arguments for a v2 receipt occurrence (c17593 §6).
 *
 * Note what is ABSENT and cannot be passed: `eventType`, `sourceType`,
 * `sourceId`, `eventVersion` and `idempotencyKey`. All five are derived from
 * `identity`, so a producer cannot re-split the tuple into independent
 * arguments. That absence is the contract; adding any of them back is the
 * regression these types exist to prevent.
 */
export type PostReceiptOccurrenceArgs = {
  identity: ReceiptOccurrenceIdentity;
  currency: string;
  occurredAt: number;
  actorId: Id<"users">;
  payload: Record<string, unknown>;
};

/**
 * Reversal arguments for a v2 receipt occurrence (c17593 §6).
 *
 * Same absence, plus both keys: `reversalIdempotencyKey` and
 * `pendingPostIdempotencyKey` are derived, never supplied.
 */
export type ReverseReceiptOccurrenceArgs = {
  identity: ReceiptOccurrenceIdentity;
  reason: string;
  actorId: Id<"users">;
  reversalDate: number;
};
