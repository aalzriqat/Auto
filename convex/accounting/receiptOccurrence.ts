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
 * way, and derives everything else from it. It deliberately does not rewire any
 * producer — removing the old `hookCollectionPayment` and repointing
 * `recordPayment` / `clearCheque` is SCRUM-236, and persisting the identity on
 * the row is SCRUM-218-C. This file is the contract those two consume.
 *
 * ## The identity map — DIRECT COLLECTIONS ONLY (owner ruling c17632)
 *
 *   Direct collection   COLLECTION_PAYMENT   collectionPayments   <collectionPaymentId>
 *
 * ⚠️ PAYMENT LINKS ARE OUT OF SCOPE FOR THIS RELEASE, BY OWNER PRODUCT RULING.
 * The `PAYMENT_LINK_RECEIVED / paymentIntents` arm, its constructor and its
 * channel abstraction were REMOVED here rather than repaired — the owner cut
 * online-provider receipts from the Accounting Redesign launch, so a two-channel
 * abstraction is complexity this release does not need. SCRUM-219 and SCRUM-233
 * own provider intake and provider-capture-vs-settlement as Low, post-redesign.
 *
 * Two consequences a future reader must not get wrong:
 *
 *  - **Payment links are DEFERRED, not RECLASSIFIED.** Nothing may remap a
 *    provider receipt onto `COLLECTION_PAYMENT` to get it through this contract.
 *    If that is ever wanted it is a product decision, not a plumbing one.
 *  - **The existing production hook is untouched.** `hookPaymentLinkReceived`
 *    in `workflowHooks.ts` still posts exactly as it did; this change removes a
 *    v2 identity arm that had no production caller, and disables nothing.
 *
 * Re-adding a channel is not a matter of adding a constructor: it re-opens the
 * multi-prefix injectivity problem `assertKeyPrefixesUnambiguous` below exists
 * for, which is why that guard is kept even though one prefix cannot collide
 * with itself.
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
 * Compile-time speed bump. **NOT authority** — see `TRUSTED_OCCURRENCES`.
 *
 * ⚠️ THIS BRAND ONCE CLAIMED TO BE "THE WHOLE ENFORCEMENT MECHANISM". IT WAS
 * NOT, AND SAYING SO COST A CERTIFICATION ROUND. A `declare`d symbol has no
 * runtime existence, and TypeScript COPIES a phantom branded property through
 * object spread — so a caller holding one legitimate identity could produce
 * another with a different economic tuple, and `tsc` reported zero diagnostics:
 *
 *     const forged: ReceiptOccurrenceIdentity = { ...legitimate, eventType: … };
 *
 * Found by the Codex seat at `90d5f03fe` (B237-HEAD-01), reproduced, and ruled a
 * class-5 caller-forgeable-monetary-identity blocker by the owner (c17632).
 *
 * What a phantom brand actually buys, stated exactly:
 *
 *   object literal typed as the brand   REFUSED (missing property, TS2741)
 *   `{ ...valid, field: other }`        ACCEPTED — brand is copied
 *   `Object.assign(valid, {…})`         ACCEPTED — and mutates the original
 *   anything at runtime                 NOTHING IS THERE TO CHECK
 *
 * It is kept only because refusing an accidental object literal at compile time
 * is still worth having, and because the `Id<"transactions">` / `Id<"deposits">`
 * negative controls depend on the constructor's argument types. Authority is
 * established at RUNTIME, below, and nowhere else.
 */
declare const RECEIPT_OCCURRENCE_BRAND: unique symbol;

/**
 * The ONLY event type and source type this contract addresses (c17632).
 *
 * Server-fixed constants, not caller-selectable fields. They are `as const` and
 * appear in `ReceiptOccurrenceIdentity` as literal types, so the tuple's two
 * classifying columns are not a degree of freedom any caller can move — which
 * is what made the forged `eventType` above select a different posting rule.
 */
export const RECEIPT_EVENT_TYPE = "COLLECTION_PAYMENT" as const;
export const RECEIPT_SOURCE_TYPE = "collectionPayments" as const;

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
 * ⚠️ THERE IS NO `channel` FIELD, AND ITS REMOVAL IS A FIX, NOT A SIMPLIFICATION
 * (c17632 requirement 1). It used to be carried alongside the tuple and the key
 * derivation TRUSTED it — while this very comment said it "is a function of
 * eventType/sourceType, not an independent degree of freedom". The code did not
 * enforce what the comment asserted, so a spread that changed `eventType` while
 * leaving `channel` alone made KEY AND TUPLE DIVERGE: two distinct economic
 * tuples, one stored idempotency key. The prefix is now a module constant read
 * from nowhere the caller can reach.
 *
 * General rule this cost us: **if a value is documented as derivable, DERIVE it.
 * A carried copy of a derivable field is a forgery surface**, and every consumer
 * that trusts the copy instead of recomputing it is a place the two can disagree.
 */
export type ReceiptOccurrenceIdentity = {
  readonly orgId: Id<"organizations">;
  readonly eventType: typeof RECEIPT_EVENT_TYPE;
  readonly sourceType: typeof RECEIPT_SOURCE_TYPE;
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
 * `idempotencyKey: \`${keyPrefix}_${paymentId}\``, instantiated as
 * `hookCollectionPayment` (both in `workflowHooks.ts`) and called from
 * `recordPayment` and `clearCheque` in `collections.ts`; and
 * `hookPaymentLinkReceived`'s `payment_link_received_<intentId>`.
 *
 * Cited by SYMBOL, deliberately, with no line numbers. The previous revision
 * cited `workflowHooks.ts:943` and `:957`; the fix that added the ambiguity
 * refusal earlier in that file shifted every line below it by +20, so the
 * citation was stale again within one commit — and the stale numbers had
 * already propagated into the PR description, a reviewer brief and two Jira
 * comments before the Sonnet seat caught them. A line number is a claim with a
 * short shelf life; a symbol name is one a reader can actually verify.
 *
 * NOT `mirrorCollectionPaymentToCanonical`. That builds an identically-spelled key for
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
const COLLECTION_PAYMENT_KEY_PREFIX = "collection_payment";

/**
 * The v1 key prefixes this module may mint. One member today.
 *
 * Kept as a SET, and kept guarded, even though a single prefix cannot collide
 * with itself: the guard below encodes three properties that only bite when a
 * second prefix is added, and re-adding a channel is exactly when they are
 * needed and exactly when nobody will remember them. Deleting a proven guard
 * because its current input makes it vacuous is how the defect class returns.
 */
const V1_KEY_PREFIXES = [COLLECTION_PAYMENT_KEY_PREFIX] as const;

/**
 * The two reserved namespaces: repeat FORWARD posts, and every REVERSAL.
 *
 * `occv` and `occr` are the same length and differ at index 3, so neither is a
 * prefix of the other. Every key this module mints therefore begins with
 * exactly one of: a channel prefix (legacy v1 forward), `occv` (repeat forward),
 * or `occr` (reversal) — three spaces that cannot overlap.
 */
const POST_KEY_NAMESPACE = "occv";
const REVERSAL_KEY_NAMESPACE = "occr";
const RESERVED_NAMESPACES = [POST_KEY_NAMESPACE, REVERSAL_KEY_NAMESPACE] as const;

/**
 * Every property that keeps the LEGACY v1 forward branch injective, asserted
 * rather than assumed.
 *
 * The v1 branch is `${prefix}_${sourceId}` and CANNOT be length-framed — it must
 * stay byte-identical to rows already in production. Its safety therefore rests
 * entirely on the prefix set, which makes the prefix set a load-bearing
 * invariant rather than a naming choice.
 *
 * Three ways a future channel breaks it, all checked here. Each round of review
 * has found one the previous guard's SHAPE could not express, so the count is
 * the current floor, not a proof of exhaustiveness:
 *
 *  1. A prefix inside a reserved namespace. `occv…` or `occr…` as a channel
 *     prefix would let a v1 forward key impersonate a repeat or a reversal.
 *
 *  2. Two channels carrying the IDENTICAL prefix — found independently by both
 *     review seats at `acfd58429`. The pairwise loop below guarded on `a !== b`,
 *     which compares VALUES, so a duplicated string was never compared against
 *     itself and passed silently: one key for two distinct economic tuples,
 *     exactly what this module exists to make unrepresentable. Checked first,
 *     because the pairwise loop structurally cannot see it.
 *
 *  3. A prefix that is a prefix of another prefix — the case both review seats
 *     independently raised. Adding `collection_payment_reissue` alongside
 *     `collection_payment` collides with NO exotic characters at all:
 *
 *       "collection_payment_"         + "reissue_abc"  ==
 *       "collection_payment_reissue_" + "abc"
 *
 *     `postOrEnqueue`'s `by_org_idempotency` short-circuit compares the string
 *     key BEFORE `postAccountingEvent` ever compares the tuple, so the second
 *     receipt is absorbed silently — the same mechanism as the original
 *     injectivity defect, reached from a different direction.
 *
 * Exported so the property can be tested directly against a deliberately
 * colliding pair, instead of only indirectly through module-load behaviour.
 */
export function assertKeyPrefixesUnambiguous(prefixes: readonly string[]): void {
  // The most basic break, and the one the pairwise loop below CANNOT catch:
  // two channels whose prefixes are the same string. That loop guards on
  // `a !== b`, which compares VALUES, so a duplicate is never compared against
  // itself and passes silently — while minting one identical key for two
  // distinct economic tuples. Found independently by both review seats.
  if (new Set(prefixes).size !== prefixes.length) {
    throw new Error(
      `duplicate channel prefix in ${JSON.stringify(prefixes)}; two channels cannot share one key space`
    );
  }
  for (const prefix of prefixes) {
    for (const reserved of RESERVED_NAMESPACES) {
      if (prefix.startsWith(reserved)) {
        throw new Error(
          `channel prefix "${prefix}" collides with the reserved namespace "${reserved}"`
        );
      }
    }
  }
  for (const a of prefixes) {
    for (const b of prefixes) {
      if (a !== b && b.startsWith(a)) {
        throw new Error(
          `channel prefix "${a}" is a prefix of "${b}"; v1 keys built from them are not injective`
        );
      }
    }
  }
}

assertKeyPrefixesUnambiguous(V1_KEY_PREFIXES);

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

/* ------------------------------------------------------------------------- *
 * RUNTIME AUTHORITY. THIS IS THE ENFORCEMENT — NOT THE TYPE.
 *
 * Authority is OBJECT IDENTITY, not shape. A value is trusted if and only if
 * THIS module minted it, and membership lives in a module-private `WeakSet` no
 * caller can reach, add to, or forge an entry in.
 *
 * Why membership rather than shape: every shape check can be satisfied by a
 * hand-built object, because a shape is exactly what an attacker copies. A
 * spread produces a DIFFERENT OBJECT, so it is absent from the set however
 * perfect its fields are. That is the whole mechanism, and it is three lines.
 *
 * ⚠️ WHY NOT A CLASS WITH A `#private` FIELD. It would also defeat spread, and
 * it was considered and REJECTED under owner ruling c17632: SCRUM-218-C must
 * PERSIST this occurrence, and a class instance is not a storable value — it
 * would have to be converted at the boundary anyway, and the conversion is
 * where the authority question reappears. Keeping the runtime value a plain
 * frozen object makes the persisted form (`toReceiptOccurrenceSnapshot`) and the
 * trusted form the same shape, with rehydration as the single sanctioned door
 * between them. The invariant matters more than the syntax.
 *
 * `WeakSet` and not `Set`: entries must not keep identities alive. A receipt
 * identity lives for one mutation; a strong set would leak every one ever built
 * for the lifetime of the isolate.
 * ------------------------------------------------------------------------- */
const TRUSTED_OCCURRENCES = new WeakSet<object>();

/**
 * Mint a trusted identity. The ONLY function that adds to the registry, and it
 * is module-private — every public door funnels through here.
 *
 * FROZEN, and the freeze is load-bearing rather than decorative: `readonly` is
 * erased at runtime, so without it `Object.assign(id, { sourceId })` silently
 * rewrites an already-accepted identity in place. Frozen, the same call THROWS
 * (module code is strict mode), which is the behaviour c17632 §4 requires.
 *
 * Freezing a COPY, not the caller's object: if the argument were sealed
 * directly, the caller would keep a live reference to the trusted value and
 * could have mutated it before anyone read it.
 */
function seal(parts: {
  orgId: Id<"organizations">;
  sourceId: string;
  eventVersion: number;
}): ReceiptOccurrenceIdentity {
  assertOccurrence(parts.eventVersion);
  if (typeof parts.sourceId !== "string" || parts.sourceId.length === 0) {
    throw new Error("receipt occurrence sourceId must be a non-empty string");
  }
  const sealed = Object.freeze({
    orgId: parts.orgId,
    eventType: RECEIPT_EVENT_TYPE,
    sourceType: RECEIPT_SOURCE_TYPE,
    sourceId: parts.sourceId,
    eventVersion: parts.eventVersion,
  }) as unknown as ReceiptOccurrenceIdentity;
  TRUSTED_OCCURRENCES.add(sealed);
  return sealed;
}

/**
 * Refuse any value this module did not mint — BEFORE it can address a row or
 * derive a key, and therefore before any caller can write anything from it.
 *
 * Every monetary door calls this: the two key derivations, the index range, and
 * each of the three facades in `workflowHooks.ts`. `describeOccurrence` does
 * NOT, deliberately — it is diagnostic, mints no authority, and is used to build
 * the very error messages a refusal produces. A trust check there would throw
 * while reporting a throw.
 *
 * The message names the two sanctioned doors on purpose: a developer who hits
 * this is holding a copy and needs to be told where a real one comes from.
 */
export function assertTrustedOccurrence(id: ReceiptOccurrenceIdentity): void {
  if (!TRUSTED_OCCURRENCES.has(id)) {
    throw new Error(
      "untrusted receipt occurrence identity: this value was not minted by " +
        "directCollectionReceipt or rehydrateReceiptOccurrence. A spread, clone, " +
        "cast or hand-built object carries the right shape but no authority."
    );
  }
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
  return seal({
    orgId: args.orgId,
    sourceId: args.paymentId.toString(),
    eventVersion: args.occurrence ?? 1,
  });
}

/* ------------------------------------------------------------------------- *
 * PERSISTENCE BOUNDARY — a stored object is NEVER authority (c17632 §5).
 *
 * SCRUM-218-C has to persist the exact occurrence. What it stores is a plain
 * canonical snapshot; what a monetary facade accepts is a trusted runtime
 * identity; and `rehydrateReceiptOccurrence` is the ONLY door between them.
 * Reading a row back does not restore authority — re-validating it does.
 * ------------------------------------------------------------------------- */

/**
 * The persisted form. Deliberately NOT `ReceiptOccurrenceIdentity`: it carries
 * no brand, is not frozen, and is not in the trust registry, because it is data
 * at rest rather than authority in flight.
 *
 * ⚠️ `orgId` IS ABSENT, AND THAT IS THE POINT. The tenant is supplied by the
 * authenticated server context at rehydration, never read back out of the
 * stored blob — so a snapshot that was tampered with, copied between rows, or
 * restored from a foreign backup cannot carry a foreign tenant in with it.
 */
export type ReceiptOccurrenceSnapshot = {
  readonly eventType: typeof RECEIPT_EVENT_TYPE;
  readonly sourceType: typeof RECEIPT_SOURCE_TYPE;
  readonly sourceId: string;
  readonly eventVersion: number;
};

/** Project a trusted identity into its storable form. */
export function toReceiptOccurrenceSnapshot(
  id: ReceiptOccurrenceIdentity
): ReceiptOccurrenceSnapshot {
  assertTrustedOccurrence(id);
  return {
    eventType: id.eventType,
    sourceType: id.sourceType,
    sourceId: id.sourceId,
    eventVersion: id.eventVersion,
  };
}

/**
 * Re-establish runtime authority from a stored snapshot, or refuse.
 *
 * Takes `unknown`, because that is what a value read back out of a database
 * row honestly is at this boundary. Typing the parameter as the snapshot type
 * would assert the very property this function exists to check.
 *
 * ⚠️ WHAT THIS PROVES, AND WHAT IT DOES NOT. It proves the snapshot is
 * STRUCTURALLY CANONICAL — the two classifying columns are this contract's
 * server-fixed constants, the occurrence is a safe integer >= 1, the source id
 * is a non-empty string, and nothing else is smuggled alongside — and it then
 * re-mints through the same `seal` every constructor uses. It does NOT prove the
 * referenced `collectionPayments` row exists, belongs to `orgId`, or represents
 * trusted money. That is runtime provenance and remains SCRUM-218-C's job. A
 * rehydrated identity is authority to ADDRESS an occurrence, not evidence that
 * the occurrence is real.
 *
 * Unknown keys are REFUSED rather than ignored: a snapshot carrying an extra
 * field is either a different contract's row or something a caller assembled,
 * and silently dropping the extra is how a `channel`-shaped field would find its
 * way back in.
 */
export function rehydrateReceiptOccurrence(args: {
  orgId: Id<"organizations">;
  snapshot: unknown;
}): ReceiptOccurrenceIdentity {
  const s = args.snapshot;
  if (typeof s !== "object" || s === null || Array.isArray(s)) {
    throw new Error("receipt occurrence snapshot must be an object");
  }
  const record = s as Record<string, unknown>;

  const allowed = ["eventType", "sourceType", "sourceId", "eventVersion"];
  const extra = Object.keys(record).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    throw new Error(
      `receipt occurrence snapshot carries unrecognised field(s) ${JSON.stringify(extra)}; ` +
        "refusing rather than ignoring them"
    );
  }

  // The cross-family refusal. A `paymentIntents`, `transactions` or `deposits`
  // snapshot cannot become a direct-collection receipt by being read back.
  if (record.eventType !== RECEIPT_EVENT_TYPE || record.sourceType !== RECEIPT_SOURCE_TYPE) {
    throw new Error(
      `receipt occurrence snapshot is not a direct collection: ` +
        `${String(record.eventType)}/${String(record.sourceType)} is outside this contract ` +
        `(expected ${RECEIPT_EVENT_TYPE}/${RECEIPT_SOURCE_TYPE})`
    );
  }
  if (typeof record.sourceId !== "string") {
    throw new Error("receipt occurrence snapshot sourceId must be a string");
  }
  if (typeof record.eventVersion !== "number") {
    throw new Error("receipt occurrence snapshot eventVersion must be a number");
  }

  return seal({
    orgId: args.orgId,
    sourceId: record.sourceId,
    eventVersion: record.eventVersion,
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
 * stored (`collection_payment_<paymentId>` from `makeCollectionHook`,
 * `payment_link_received_<intentId>` from `hookPaymentLinkReceived`), so
 * existing POSTED events keep matching their own replay check. Only the
 * repeat-occurrence and reversal forms changed, and nothing has ever posted
 * through either — the facade is unused — so the change carries no migration.
 *
 * `RECEIPT_PAYLOAD_VERSION` is deliberately absent from this computation.
 */
function framedKey(namespace: string, id: ReceiptOccurrenceIdentity): string {
  const prefix = COLLECTION_PAYMENT_KEY_PREFIX;
  return `${namespace}${id.eventVersion}:${prefix.length}:${prefix}:${id.sourceId.length}:${id.sourceId}`;
}

export function occurrenceIdempotencyKey(id: ReceiptOccurrenceIdentity): string {
  assertTrustedOccurrence(id);
  assertOccurrence(id.eventVersion);
  if (id.eventVersion === 1) return `${COLLECTION_PAYMENT_KEY_PREFIX}_${id.sourceId}`;
  return framedKey(POST_KEY_NAMESPACE, id);
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
 *
 * ## Why the role is INSIDE the encoding, not a suffix
 *
 * This was `${occurrenceIdempotencyKey(id)}_reversal` — an unframed suffix, i.e.
 * exactly the defect that had just been removed from the version axis, left
 * standing one axis over. The Codex seat found it at `45dd608b0`:
 *
 *     reverseKey(sourceId = "X")           ->  collection_payment_X_reversal
 *     forwardKey(sourceId = "X_reversal")  ->  collection_payment_X_reversal
 *
 * Two distinct operations, one key. Both `accountingEvents` and
 * `pendingAccountingEvents` dedupe through `by_org_idempotency`, so that could
 * report REVERSED while the original stayed POSTED, silently discard a forward
 * post, or skip enqueueing a reversal.
 *
 * The role now lives in the encoder rather than in a convention about suffixes,
 * because fixing one axis and leaving another is how this defect recurred:
 *
 *   forward v1   ->  `${prefix}_${sourceId}`                       (legacy, exact)
 *   forward v>1  ->  `occv${v}:${p.length}:${p}:${id.length}:${id}`
 *   reversal ANY ->  `occr${v}:${p.length}:${p}:${id.length}:${id}`
 *
 * Reversals are framed at EVERY version, including v1. Unlike the forward key,
 * this carries no backward-compatibility constraint: no production reversal key
 * OF THIS FRAMED SHAPE has ever been written. Reversal keys today are per-hook
 * literals built by `makeReversalHook` (e.g. `sale_cancelled_${saleId}`), the
 * `reversed_${key}` prefix form, or a literal built at the call site.
 *
 * ⚠️ THE EARLIER VERSION OF THIS PARAGRAPH ALSO SAID "NO reversal hook exists
 * for `COLLECTION_PAYMENT` at all". THAT WAS FALSE, and it is retracted here
 * rather than only where it was first corrected. `clearCheque`'s return path in
 * `collections.ts` builds `cheque_return_after_clear_<chequeId>` and calls
 * `reverseAccountingEvent` DIRECTLY on a `collectionPayments`-sourced event. It
 * uses neither `makeReversalHook` nor a `_reversal` suffix, which is why a grep
 * over those two spellings missed it — an absence asserted from a search of two
 * spellings rather than of the space. The Codex seat disproved it at
 * `acfd58429`; it survived here, in the contract file, for two commits after
 * the commit message, the PR body, the test prose and Jira had all been fixed.
 *
 * The consequence is real and is NOT guarded against: a legacy reversal key for
 * a receipt occurrence exists, the framed `occr…` key can never equal it, and
 * the ledger is protected by `reverseAccountingEvent` patching the original to
 * REVERSED rather than by the key. See §12 of the identity suite for what that
 * coexistence does and does not cover.
 *
 * Note the existing `reversed_${key}` prefix form was already safe, because a
 * forward key always begins with a channel prefix. Choosing a suffix instead
 * was a deviation from a convention that worked.
 */
export function occurrenceReversalIdempotencyKey(id: ReceiptOccurrenceIdentity): string {
  assertTrustedOccurrence(id);
  assertOccurrence(id.eventVersion);
  return framedKey(REVERSAL_KEY_NAMESPACE, id);
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
  assertTrustedOccurrence(id);
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
