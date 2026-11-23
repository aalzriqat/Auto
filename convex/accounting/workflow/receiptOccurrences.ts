import { type QueryCtx, type MutationCtx } from "../../_generated/server";
import {
  type ReceiptOccurrenceIdentity,
  occurrenceIndexRange,
  describeOccurrence,
  type ReverseReceiptOccurrenceArgs,
  assertTrustedOccurrence,
  occurrenceReversalIdempotencyKey,
  occurrenceIdempotencyKey,
} from "../receiptOccurrence";
import { type Doc, type Id } from "../../_generated/dataModel";
import { type ReversalOutcome, reverseEventIfPosted } from "./reversal";
import { cancelPendingPostByKey } from "../outboxIngress";
import { ConvexError } from "convex/values";
import {
  RECEIPT_CREDIT_APPLIED_EVENT_TYPE,
  RECEIPT_CREDIT_APPLIED_SOURCE_TYPE,
  type EventType,
} from "../postingRules";

/**
 * The causal check: is THIS occurrence on the books?
 *
 * Eligibility is exactly what c17593 §7 fixes it at — the exact
 * `accountingEvents` occurrence exists AND its status is POSTED. An outbox row
 * marked POSTED, a matching idempotency key, or a legacy `transactions` token
 * is never a substitute, and REVERSED / FAILED / PENDING / missing are all
 * ineligible.
 *
 * Addressed through `occurrenceIndexRange`, so every economic field must match.
 * There is deliberately no key-only fallback: a lookup whose identity is wrong
 * in any field must MISS, not quietly match something else.
 *
 * ## Ambiguity REFUSES rather than choosing
 *
 * Convex has no unique indexes, so nothing in the schema guarantees this exact
 * range holds at most one row. An earlier revision filtered to POSTED and took
 * `.first()`, which meant a corrupt pair — the same exact tuple present twice,
 * one POSTED and one REVERSED — would be reported as a live POSTED occurrence,
 * choosing the favourable row and hiding the corruption. `postAccountingEvent`
 * reads the same tuple with `.unique()` and therefore fails closed; a causal
 * check that is laxer than the writer it guards is worse than no check.
 *
 * So the range is read WITHOUT the status filter and refuses on more than one
 * row. That converts silent corruption into an explicit operational error, and
 * a caller cannot obtain an eligible occurrence it should not have. Status is
 * applied afterwards: only POSTED is eligible — REVERSED, FAILED, PENDING and
 * missing are all ineligible, and an outbox POSTED row or a matching
 * idempotency key is never a substitute.
 */
export async function findPostedReceiptOccurrence(
  // Read-only, so it accepts a QueryCtx too (SCRUM-218-C). Widened rather than
  // cast at the call site: `listRetainedCredits` needs the same causal check a
  // mutation does, and casting a QueryCtx to a MutationCtx to get it would be a
  // type lie that happens to work only because this function never writes.
  ctx: QueryCtx | MutationCtx,
  identity: ReceiptOccurrenceIdentity
): Promise<Doc<"accountingEvents"> | null> {
  const range = occurrenceIndexRange(identity);
  const rows = await ctx.db
    .query("accountingEvents")
    .withIndex(range.index, (q) =>
      q
        .eq("orgId", range.orgId)
        .eq("eventType", range.eventType)
        .eq("sourceType", range.sourceType)
        .eq("sourceId", range.sourceId)
        .eq("eventVersion", range.eventVersion)
    )
    .take(2);
  if (rows.length > 1) {
    throw new Error(
      `ambiguous receipt occurrence ${describeOccurrence(identity)}: more than one accountingEvents row shares this exact economic tuple`
    );
  }
  const row = rows[0];
  return row && row.status === "POSTED" ? row : null;
}

/**
 * Reverse the receipt occurrence named by `identity`.
 *
 * Two things this closes that the generic helper leaves open:
 *
 * 1. `eventVersion` is ALWAYS supplied. `reverseEventIfPosted` falls back to a
 *    `by_org_source` scan with `.first()` when it is undefined, which reverses
 *    whichever event happens to come first — for a source with several
 *    occurrences that is a reversal aimed at one receipt landing on another.
 *    Carrying the identity makes the exact-address branch unconditional FOR
 *    THIS FACADE'S OWN CALLS. It does not make that fallback dead code: the
 *    generic `makeReversalHook` factory in this file still omits `eventVersion`
 *    for other event families, and that is out of scope here.
 * 2. `pendingPostIdempotencyKey` is derived from the SAME identity as the
 *    forward post, so `cancelPendingPostByKey` cancels the entry that forward
 *    post actually enqueued. Supplied independently, a mismatch cancels nothing
 *    and leaves an unposted forward entry alive behind a NOT_POSTED result.
 * 3. Cardinality is refused BEFORE anything mutates.
 *
 * On (3), which the Codex seat found at `45dd608b0`: pinning `eventVersion`
 * addresses the right ROW RANGE but says nothing about how many rows are in it.
 * `reverseEventIfPosted`'s exact-version branch filters POSTED and takes
 * `.first()`, so against two rows sharing one exact economic tuple it reverses
 * one, leaves the other POSTED, and returns REVERSED. Convex has no unique
 * indexes, so nothing in the schema prevents that pair from existing.
 *
 * The read path (`findPostedReceiptOccurrence`) already refused this. The
 * MUTATING path did not — the wrong way round, since the read merely reports
 * while the write moves money. Calling the read guard first reuses the exact
 * same cardinality assertion and makes the refusal happen before any write.
 *
 * The `.first()` in `reverseEventIfPosted` itself is deliberately NOT changed:
 * it is pre-existing, shared with `reverseDepositApplication`, and outside this
 * change's frozen scope. Closing it at the facade removes the path this diff
 * makes reachable; the generic helper's own cardinality behaviour is recorded
 * as follow-up rather than widened into this PR.
 */
export async function reverseReceiptOccurrence(
  ctx: MutationCtx,
  args: ReverseReceiptOccurrenceArgs
): Promise<ReversalOutcome> {
  const id = args.identity;
  // ⚠️ OBTAINABILITY BEFORE ANYTHING ELSE (c17632). Refuse a value this process
  // did not mint — a spread clone, a JSON round trip, a hand-built object —
  // before a single read, let alone a write. The key derivations assert this
  // too; asserting at the door as well means a facade that later grows a write
  // before its first key derivation cannot lose the check by accident.
  assertTrustedOccurrence(id);
  // Throws on an ambiguous exact tuple. Its return value is deliberately
  // unused: NOT_POSTED is a legitimate outcome that reverseEventIfPosted below
  // determines for itself, so this call is here purely for its refusal.
  await findPostedReceiptOccurrence(ctx, id);
  return await reverseEventIfPosted(ctx, {
    orgId: id.orgId,
    sourceType: id.sourceType,
    sourceId: id.sourceId,
    eventType: id.eventType,
    eventVersion: id.eventVersion,
    reason: args.reason,
    actorId: args.actorId,
    reversalDate: args.reversalDate,
    reversalIdempotencyKey: occurrenceReversalIdempotencyKey(id),
    pendingPostIdempotencyKey: occurrenceIdempotencyKey(id),
  });
}

/* ------------------------------------------------------------------------- *
 * SCRUM-130 — THE SANCTIONED RECEIPT-REVOCATION SURFACE
 *
 * Two entry points, and deliberately only two. A cheque return has to make an
 * occurrence STOP EXISTING economically, and that is not the same operation as
 * "reverse it": an occurrence still sitting in the outbox has nothing to
 * reverse, yet it is the one that can still hurt you. `reverseReceiptOccurrence`
 * cancels the forward obligation ONLY on the branch where no posted row was
 * found — which is exactly the asymmetry owner-proxy `c17763` names, and exactly
 * the resurrection SCRUM-249 Round 3 reproduced:
 *
 *     canonical receipt POST still PENDING
 *   + a receipt row at the SAME reserved tuple under a FOREIGN key, POSTED
 *   -> the return finds and reverses the sibling and returns REVERSED
 *   -> the canonical pending obligation is never cancelled
 *   -> a later drain publishes it and mints a SECOND POSTED row at the reserved
 *      tuple, for a tender the bank took back.
 *
 * These two functions are the narrow interface SCRUM-256 may structurally wrap.
 * They create no new authority: every key and every address is derived from a
 * trusted identity or from the persisted lineage row itself, never accepted.
 * ------------------------------------------------------------------------- */

/**
 * Revoke the receipt occurrence named by `identity`: the forward obligation can
 * no longer publish, AND any posted journal is reversed.
 *
 * ⚠️ THE CANCEL IS UNCONDITIONAL, AND THAT IS THE WHOLE POINT. It runs whether
 * or not a posted row is found, so no branch can leave an eligible forward
 * obligation alive behind a `REVERSED` outcome. Both writes happen in the
 * caller's single Convex transaction, so the tender's death and the obligation's
 * death commit together or not at all.
 *
 * `cancelledPendingForward` is returned rather than inferred: "was there an
 * obligation to kill?" is a different question from "was anything posted?", and
 * a caller that needs to report on the lifecycle should not have to guess.
 */
export async function revokeReceiptOccurrence(
  ctx: MutationCtx,
  args: ReverseReceiptOccurrenceArgs
): Promise<{ outcome: ReversalOutcome; cancelledPendingForward: boolean }> {
  const id = args.identity;
  // Same door discipline as the other three facades: refuse a value this
  // process did not mint before it can address a row or derive a key.
  assertTrustedOccurrence(id);
  const cancelledPendingForward = await cancelPendingPostByKey(
    ctx,
    id.orgId,
    occurrenceIdempotencyKey(id)
  );
  const outcome = await reverseReceiptOccurrence(ctx, args);
  return { outcome, cancelledPendingForward };
}

/**
 * Revoke ONE persisted retained-credit application occurrence.
 *
 * ⚠️ ADDRESSED FROM THE ROW, NOT FROM ARGUMENTS. `sourceId`, `eventVersion` and
 * the forward idempotency key all come off the `receiptApplications` document
 * that `recordRetainedApplication` sealed, so a caller has no parameter through
 * which to re-split the tuple and reverse a different application than the one
 * it named. Application #1 and #2 against one receipt are two legitimate
 * economic occurrences; reversing #2 must never land on #1.
 *
 * The reversal key uses the `reversed_` PREFIX form rather than a suffix. A
 * suffix is the defect `occurrenceReversalIdempotencyKey` documents at length:
 * `key + "_reversal"` collides with a forward key whose source id happens to end
 * in `_reversal`. A prefix cannot collide, because every forward key in this
 * family begins with its own channel prefix. It is also outside the reserved
 * receipt namespace (`isReservedReceiptKey` reserves `collection_payment_`,
 * `occv` and `occr`), so SCRUM-249's reversal-side namespace guard does not and
 * must not fire here — this is a different event family.
 */
export async function revokeReceiptApplicationOccurrence(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    application: Doc<"receiptApplications">;
    reason: string;
    actorId: Id<"users">;
    reversalDate: number;
  }
): Promise<ReversalOutcome> {
  const { application } = args;
  // Tenancy is re-derived, never taken from the row alone: a document handed in
  // from anywhere must still belong to the org the caller was authorised for.
  if (application.orgId !== args.orgId) {
    throw new ConvexError("Receipt application does not belong to this organization.");
  }
  const occurrence = application.occurrence;
  // Cross-family refusal, in the same spirit as `rehydrateReceiptOccurrence`'s.
  // A row whose stored occurrence is not this contract's is not something to
  // reverse "generically" — it is a row that should not exist.
  if (
    occurrence.eventType !== RECEIPT_CREDIT_APPLIED_EVENT_TYPE ||
    occurrence.sourceType !== RECEIPT_CREDIT_APPLIED_SOURCE_TYPE
  ) {
    throw new ConvexError(
      `Receipt application ${application._id} carries occurrence ` +
        `${occurrence.eventType}/${occurrence.sourceType}, which is outside the ` +
        `retained-credit application contract.`
    );
  }

  // Unconditional, for the same reason as `revokeReceiptOccurrence`: an
  // application dated into a period that was not open never posted, so there is
  // nothing to reverse — and it is precisely that queued obligation which would
  // otherwise drain later and debit 2110 for a tender that no longer exists.
  await cancelPendingPostByKey(ctx, args.orgId, application.eventIdempotencyKey);

  return await reverseEventIfPosted(ctx, {
    orgId: args.orgId,
    sourceType: occurrence.sourceType,
    sourceId: occurrence.sourceId,
    eventType: occurrence.eventType as EventType,
    eventVersion: occurrence.eventVersion,
    reason: args.reason,
    actorId: args.actorId,
    reversalDate: args.reversalDate,
    reversalIdempotencyKey: `reversed_${application.eventIdempotencyKey}`,
    pendingPostIdempotencyKey: application.eventIdempotencyKey,
  });
}
