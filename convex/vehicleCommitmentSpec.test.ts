import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { anyApi, FunctionReference } from "convex/server";

/**
 * SCRUM-195 — THE COMMITMENT SPECIFICATION, re-derived (owner ruling c14840).
 *
 * ## Why this file exists instead of more fixtures
 *
 * The previous free-form suite reached 89 hand-written fixtures and, across
 * three review rounds, produced the same defect four times: a fixture that
 * could never validate what it claimed. Two of those were outright
 * CONTRADICTIONS — one fixture requiring an operation to refuse while another
 * required the identical operation, in the identical situation, to succeed. No
 * implementation could satisfy the suite, and only a human-grade reviewer ever
 * noticed.
 *
 * That is not carelessness that more care fixes. It is a structural property of
 * free-form fixtures: each one states a rule in its own prose, in its own
 * setup, and nothing compares any of them to each other. The 90th fixture is
 * exactly as likely to contradict the 12th as the 89th was.
 *
 * So the rules are declared as DATA. A scenario is a normalized world-state, an
 * operation, and a required outcome. Two scenarios that normalize to the same
 * (world, operation) MUST require the same outcome — and a preflight test
 * enforces that mechanically, before any of them runs. The contradiction class
 * becomes unrepresentable rather than merely unlucky.
 *
 * ## What the preflight actually buys
 *
 * `deposits.create` on a vehicle another root holds must REFUSE. That rule now
 * exists in exactly ONE place. A future scenario that constructs the same world
 * and expects ACCEPT does not produce a subtly-wrong suite — it fails the
 * preflight by name, with both scenario ids printed.
 *
 * ## Binding rules encoded here (c14554 · c14659 · c14796 · c14833 · c14840)
 *
 *   - one physical vehicle has ONE hard-commitment owner; identity is a
 *     SERVER-OWNED root, never row count and never (customerId, vehicleId);
 *   - a `quoteId` is lineage PROOF, never the identity;
 *   - lineage is linear: one current head, monotonic revision, CAS on advance;
 *   - a STALE revision may not create new hard evidence;
 *   - ownership and money are SEPARATE axes — released money frees the car and
 *     leaves the root financially open;
 *   - root money is computed from the CANONICAL allocation buckets, never from
 *     `Σ amount − Σ releasedAmountMinor` (c14840: slice refunds provably live
 *     outside that field);
 *   - callers declare NEW vs REVISE explicitly and carry a stable operation
 *     identity; a missing key is legacy compatibility, NOT a dedupe promise.
 */

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.*s");

type UnbuiltMutation = FunctionReference<"mutation", "public", Record<string, unknown>, unknown>;
type UnbuiltQuery = FunctionReference<"query", "public", Record<string, unknown>, unknown>;
const notYetBuilt = anyApi as unknown as Record<string, Record<string, UnbuiltMutation>>;
const notYetBuiltQuery = anyApi as unknown as Record<string, Record<string, UnbuiltQuery>>;

const PRICE = 28_000;

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE WORLD VOCABULARY
//
// Every dimension a commitment decision can turn on. A scenario names a value
// for each dimension it depends on and omits the rest; omitted dimensions are
// "irrelevant to this rule" and are excluded from the normalized key, so two
// scenarios only collide when they genuinely describe the same situation.
// ─────────────────────────────────────────────────────────────────────────────

/** What the target vehicle's commitment looks like when the operation runs. */
type VehicleState =
  /** No root holds it. */
  | "FREE"
  /** Held by the SAME root the operation belongs to. */
  | "HELD_BY_SAME_ROOT"
  /** Held by a DIFFERENT live root. */
  | "HELD_BY_OTHER_ROOT"
  /** Its share was released; per c14833 the car is genuinely free again. */
  | "RELEASED_AWAITING_DECISION"
  /**
   * Its finance claim was REJECTED but the same root's deposit still lives.
   * Rejection releases the CLAIM, not the customer's money — the unit stays
   * held, and treating rejection as a full release silently discards a deal.
   */
  | "REJECTED_APP_SAME_ROOT_DEPOSIT_LIVES"
  /**
   * Two live roots on one car — the pre-cutover state a backfill inherits.
   * Only reachable by direct seeding, which c14840 permits precisely because
   * the repaired public API can no longer produce it.
   */
  | "LEGACY_MULTI_ROOT"
  /**
   * Held, with the holding row sitting BEYOND a default page of results.
   *
   * A resolver that reads holds with `.take(50)` reports a car with 51 holds
   * as FREE — the most dangerous possible wrong answer, since it hands
   * someone else's committed vehicle to a new deal, and it only appears on
   * the busiest cars. Pagination is a correctness property here, not a
   * performance one.
   */
  | "HELD_PAST_PAGINATION_LIMIT"
  /**
   * Held, and held for a long time.
   *
   * An exclusive commitment that nobody revisits quietly takes a car off the
   * market forever. The authority must make aged commitments DISCOVERABLE so
   * an operator can cancel one deliberately — the alternative is an expiry
   * that releases someone's deal behind their back.
   */
  | "HELD_LONG_AGO";

/** Which revision of the lineage the operation cites as its proof. */
type RevisionState =
  | "NO_LINEAGE"
  /** Cites the current head. */
  | "HEAD"
  /** Cites a revision that has been superseded. */
  | "STALE";

/** The lineage proof supplied alongside the operation. */
type ProofState =
  | "NONE"
  | "RESERVATION_MATCHING"
  | "RESERVATION_WRONG_CUSTOMER"
  | "RESERVATION_WRONG_VEHICLE"
  | "RESERVATION_VEHICLE_SET_DRIFT"
  | "RESERVATION_NOT_ACTIVE"
  | "RESERVATION_ALREADY_ADOPTED"
  | "SUPERSEDES_MATCHING"
  | "SUPERSEDES_WRONG_CUSTOMER"
  | "SUPERSEDES_WRONG_VEHICLE"
  | "SUPERSEDES_VEHICLE_SET_DRIFT"
  | "BOTH_PROOFS_DIFFERENT_ROOTS";

/** How much of the customer's money the root economically retains. */
type MoneyState =
  | "NONE"
  | "WITHIN_HEAD_PRICE"
  | "EXCEEDS_HEAD_PRICE"
  | "AWAITING_DECISION"
  | "REFUNDED"
  | "VOIDED";

/**
 * c14840: callers declare intent and carry a stable operation identity.
 * A missing key is LEGACY COMPATIBILITY — explicitly NOT a dedupe promise.
 */
type IdentityState =
  | "KEY_FRESH"
  | "KEY_REPLAY_SAME_TERMS"
  | "KEY_REPLAY_DIFFERENT_TERMS"
  | "NO_KEY_LEGACY";

/**
 * What the vehicle IS to the operation. A car can be the thing being bought or
 * the thing being taken in part-exchange, and the authority must treat both as
 * acquisitions — the trade-in path was a second, unguarded writer.
 */
type VehicleRole = "PRIMARY" | "TRADE_IN";

/**
 * SOURCED rows are one physical car that several dealers may list. That is the
 * case where "two applications, one vehicle" looks legitimate and is not.
 */
type VehicleSource = "OWNED" | "SOURCED";

interface World {
  vehicle?: VehicleState;
  revision?: RevisionState;
  proof?: ProofState;
  money?: MoneyState;
  identity?: IdentityState;
  role?: VehicleRole;
  source?: VehicleSource;
  /** Set when a rule is about multi-vehicle quotes specifically. */
  multiVehicle?: boolean;
}

/** Every operation the authority governs. */
type Operation =
  | "deposits.create"
  | "deposits.resolveReleasedAllocation"
  | "applications.createFromQuote"
  | "applications.finalizeDeal"
  | "applications.reopenRejected"
  | "vehicles.createReservation"
  | "vehicles.softDelete"
  | "vehicles.archive"
  | "quotes.saveQuote"
  | "sales.create"
  | "sales.completeFromQuote"
  | "commitments.closeRoot";

type Outcome = "ACCEPT" | "REFUSE";

interface Scenario {
  /** Stable id, used in failure output and in the preflight's collision report. */
  id: string;
  /** The rule this scenario encodes, in one line. */
  rule: string;
  world: World;
  operation: Operation;
  outcome: Outcome;
  /**
   * Required for REFUSE. The refusal must be the RULE's refusal — a bare
   * "it threw" is satisfied by any unrelated auth, validator or rate-limit
   * failure, which is how a fixture ends up green while testing nothing.
   */
  reason?: RegExp;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. NORMALIZATION + THE CONSISTENCY PREFLIGHT
//
// The mechanism the whole re-derivation exists for.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Only the dimensions a given operation can actually turn on participate in its
 * key. Including irrelevant dimensions would make every scenario unique and the
 * preflight would silently never fire — a check that cannot fail is the exact
 * species of evidence this file was built to stop producing.
 */
const RELEVANT_DIMENSIONS: Record<Operation, (keyof World)[]> = {
  "deposits.create": ["vehicle", "revision", "proof", "money", "multiVehicle"],
  "deposits.resolveReleasedAllocation": ["vehicle", "multiVehicle"],
  "applications.createFromQuote": ["vehicle", "revision", "proof", "source", "multiVehicle"],
  "applications.finalizeDeal": ["vehicle", "revision"],
  "applications.reopenRejected": ["vehicle"],
  "vehicles.createReservation": ["vehicle", "revision", "proof"],
  "vehicles.softDelete": ["vehicle"],
  "vehicles.archive": ["vehicle"],
  "quotes.saveQuote": ["proof", "revision", "money", "identity", "multiVehicle"],
  "sales.create": ["vehicle", "revision", "proof", "role"],
  "sales.completeFromQuote": ["vehicle", "revision", "money"],
  "commitments.closeRoot": ["vehicle", "money"],
};

function normalizeKey(scenario: Scenario): string {
  const dims = RELEVANT_DIMENSIONS[scenario.operation];
  const parts = dims
    .map((d) => {
      const value = scenario.world[d];
      return value === undefined ? null : `${d}=${String(value)}`;
    })
    .filter((p): p is string => p !== null);
  return `${scenario.operation}::${parts.sort().join("|")}`;
}

export const SCENARIOS: Scenario[] = [
  // ── one physical vehicle, one hard-commitment owner ──────────────────────
  {
    id: "deposit/free-vehicle",
    rule: "A deposit on a vehicle no root holds is accepted.",
    world: { vehicle: "FREE", revision: "HEAD", proof: "NONE", money: "NONE" },
    operation: "deposits.create",
    outcome: "ACCEPT",
  },
  {
    id: "deposit/same-root-instalment",
    rule: "Further deposits on the SAME root are more evidence, not a conflict.",
    world: { vehicle: "HELD_BY_SAME_ROOT", revision: "HEAD", proof: "NONE", money: "WITHIN_HEAD_PRICE" },
    operation: "deposits.create",
    outcome: "ACCEPT",
  },
  {
    id: "deposit/other-root",
    rule: "A deposit on a vehicle a DIFFERENT root holds is refused — same customer or not.",
    world: { vehicle: "HELD_BY_OTHER_ROOT", revision: "HEAD", proof: "NONE", money: "NONE" },
    operation: "deposits.create",
    outcome: "REFUSE",
    reason: /committed|another deal|already held|no longer available|different root/i,
  },
  {
    id: "deposit/released-is-free",
    rule: "RELEASED_AWAITING_DECISION money does not hold the car; a rival may take it.",
    world: { vehicle: "RELEASED_AWAITING_DECISION", revision: "HEAD", proof: "NONE", money: "NONE" },
    operation: "deposits.create",
    outcome: "ACCEPT",
  },
  {
    id: "deposit/stale-revision",
    rule: "A stale revision may not create new hard evidence (c14796/c14840).",
    world: { vehicle: "HELD_BY_SAME_ROOT", revision: "STALE", proof: "NONE", money: "WITHIN_HEAD_PRICE" },
    operation: "deposits.create",
    outcome: "REFUSE",
    reason: /current revision|superseded|stale|current head/i,
  },
  {
    id: "deposit/head-after-supersession",
    rule: "The CURRENT head accepts the deposit the stale revision was refused.",
    world: { vehicle: "HELD_BY_SAME_ROOT", revision: "HEAD", proof: "SUPERSEDES_MATCHING", money: "WITHIN_HEAD_PRICE" },
    operation: "deposits.create",
    outcome: "ACCEPT",
  },
  {
    id: "deposit/exceeds-root-ceiling",
    rule: "Root-wide retained money may not exceed the CURRENT head price.",
    world: { vehicle: "HELD_BY_SAME_ROOT", revision: "HEAD", proof: "NONE", money: "EXCEEDS_HEAD_PRICE" },
    operation: "deposits.create",
    outcome: "REFUSE",
    reason: /exceed|more than|price|already held|ceiling/i,
  },
  {
    id: "deposit/multi-vehicle-any-line-committed",
    rule: "A multi-vehicle deposit acquires EVERY line, so any committed line refuses it.",
    world: { vehicle: "HELD_BY_OTHER_ROOT", revision: "HEAD", proof: "NONE", money: "NONE", multiVehicle: true },
    operation: "deposits.create",
    outcome: "REFUSE",
    reason: /committed|another deal|already held|no longer available/i,
  },
  {
    id: "deposit/multi-vehicle-all-free",
    rule: "A multi-vehicle deposit on wholly uncommitted cars is accepted.",
    world: { vehicle: "FREE", revision: "HEAD", proof: "NONE", money: "NONE", multiVehicle: true },
    operation: "deposits.create",
    outcome: "ACCEPT",
  },

  // ── the reservation bridge ────────────────────────────────────────────────
  {
    id: "reservation/standalone-free",
    rule: "A standalone reservation on a free car establishes its own root.",
    world: { vehicle: "FREE", revision: "NO_LINEAGE", proof: "NONE" },
    operation: "vehicles.createReservation",
    outcome: "ACCEPT",
  },
  {
    id: "reservation/over-other-root-unproven",
    rule: "Omitting lineage is not permission: an unproven reservation over a held car fails closed.",
    world: { vehicle: "HELD_BY_OTHER_ROOT", revision: "NO_LINEAGE", proof: "NONE" },
    operation: "vehicles.createReservation",
    outcome: "REFUSE",
    // Widened to the refusal the engine ACTUALLY gives today ("Another
    // customer's deposit is currently…"). The first pattern here was narrower
    // than the real message, so a rule that is already correctly enforced read
    // as a violation. Declaring the expected refusal forced that mismatch into
    // the open instead of leaving it to be discovered as a false finding.
    reason: /committed|another deal|already held|another customer|deposit|lineage|proof/i,
  },
  {
    id: "reservation/stale-proof",
    rule: "A reservation citing a superseded revision as proof is refused.",
    world: { vehicle: "HELD_BY_SAME_ROOT", revision: "STALE", proof: "SUPERSEDES_MATCHING" },
    operation: "vehicles.createReservation",
    outcome: "REFUSE",
    reason: /current revision|superseded|stale|current head/i,
  },

  // ── adoption + supersession proofs ────────────────────────────────────────
  {
    id: "savequote/adopt-reservation-matching",
    rule: "A first quote may adopt a reservation root on matching customer AND vehicle.",
    world: { proof: "RESERVATION_MATCHING", revision: "NO_LINEAGE", money: "NONE", identity: "KEY_FRESH" },
    operation: "quotes.saveQuote",
    outcome: "ACCEPT",
  },
  {
    id: "savequote/adopt-wrong-customer",
    rule: "An adoption proof belonging to a different customer is refused.",
    world: { proof: "RESERVATION_WRONG_CUSTOMER", revision: "NO_LINEAGE", money: "NONE", identity: "KEY_FRESH" },
    operation: "quotes.saveQuote",
    outcome: "REFUSE",
    reason: /does not match|not this customer|unauthorized|different customer/i,
  },
  {
    id: "savequote/adopt-wrong-vehicle",
    rule: "An adoption proof naming a different vehicle is refused.",
    world: { proof: "RESERVATION_WRONG_VEHICLE", revision: "NO_LINEAGE", money: "NONE", identity: "KEY_FRESH" },
    operation: "quotes.saveQuote",
    outcome: "REFUSE",
    reason: /does not match|vehicle|different vehicle|unauthorized/i,
  },
  {
    id: "savequote/adopt-vehicle-set-drift",
    rule: "vehicleItems is authoritative: a set that differs from the proof is refused.",
    world: { proof: "RESERVATION_VEHICLE_SET_DRIFT", revision: "NO_LINEAGE", money: "NONE", identity: "KEY_FRESH", multiVehicle: true },
    operation: "quotes.saveQuote",
    outcome: "REFUSE",
    reason: /does not match|vehicle set|different vehicle|unauthorized/i,
  },
  {
    id: "savequote/adopt-inactive-reservation",
    rule: "A proof is only proof while live: RELEASED/EXPIRED/CONVERTED cannot be adopted.",
    world: { proof: "RESERVATION_NOT_ACTIVE", revision: "NO_LINEAGE", money: "NONE", identity: "KEY_FRESH" },
    operation: "quotes.saveQuote",
    outcome: "REFUSE",
    reason: /not active|released|expired|converted|no longer/i,
  },
  {
    id: "savequote/adopt-already-adopted",
    rule: "A reservation already adopted cannot be adopted by a different quote.",
    world: { proof: "RESERVATION_ALREADY_ADOPTED", revision: "NO_LINEAGE", money: "NONE", identity: "KEY_FRESH" },
    operation: "quotes.saveQuote",
    outcome: "REFUSE",
    reason: /already adopted|already claimed|already linked|not available|does not match/i,
  },
  {
    id: "savequote/both-proofs-conflict",
    rule: "Two proofs resolving to different roots is refused, never silently reconciled.",
    world: { proof: "BOTH_PROOFS_DIFFERENT_ROOTS", revision: "NO_LINEAGE", money: "NONE", identity: "KEY_FRESH" },
    operation: "quotes.saveQuote",
    outcome: "REFUSE",
    reason: /conflicting|both|ambiguous|one root|mutually exclusive|does not match/i,
  },
  {
    id: "savequote/supersede-wrong-customer",
    rule: "A supersession proof belonging to a different customer is refused.",
    world: { proof: "SUPERSEDES_WRONG_CUSTOMER", revision: "HEAD", money: "NONE", identity: "KEY_FRESH" },
    operation: "quotes.saveQuote",
    outcome: "REFUSE",
    reason: /does not match|not this customer|unauthorized|different customer/i,
  },
  {
    id: "savequote/supersede-wrong-vehicle",
    rule: "A supersession proof naming a different vehicle is refused.",
    world: { proof: "SUPERSEDES_WRONG_VEHICLE", revision: "HEAD", money: "NONE", identity: "KEY_FRESH" },
    operation: "quotes.saveQuote",
    outcome: "REFUSE",
    reason: /does not match|vehicle|different vehicle|unauthorized/i,
  },
  {
    id: "savequote/supersede-vehicle-set-drift",
    rule: "A supersession may not absorb inventory the predecessor never covered.",
    world: { proof: "SUPERSEDES_VEHICLE_SET_DRIFT", revision: "HEAD", money: "NONE", identity: "KEY_FRESH", multiVehicle: true },
    operation: "quotes.saveQuote",
    outcome: "REFUSE",
    reason: /does not match|vehicle set|different vehicle|unauthorized/i,
  },
  {
    id: "savequote/supersede-stale-head",
    rule: "Only the CURRENT head may be superseded; a stale predecessor is refused (CAS).",
    world: { proof: "SUPERSEDES_MATCHING", revision: "STALE", money: "NONE", identity: "KEY_FRESH" },
    operation: "quotes.saveQuote",
    outcome: "REFUSE",
    reason: /current revision|superseded|stale|current head/i,
  },
  {
    id: "savequote/price-below-retained",
    rule: "A head priced below money already retained is refused immediately, not at completion.",
    world: { proof: "SUPERSEDES_MATCHING", revision: "HEAD", money: "EXCEEDS_HEAD_PRICE", identity: "KEY_FRESH" },
    operation: "quotes.saveQuote",
    outcome: "REFUSE",
    reason: /below|already held|deposits|exceed/i,
  },
  {
    id: "savequote/price-above-retained",
    rule: "A head that clears the retained amount is accepted — including with money awaiting a decision.",
    world: { proof: "SUPERSEDES_MATCHING", revision: "HEAD", money: "AWAITING_DECISION", identity: "KEY_FRESH" },
    operation: "quotes.saveQuote",
    outcome: "ACCEPT",
  },
  {
    id: "savequote/refunded-frees-headroom",
    rule: "Money genuinely refunded stops counting against the ceiling.",
    world: { proof: "SUPERSEDES_MATCHING", revision: "HEAD", money: "REFUNDED", identity: "KEY_FRESH" },
    operation: "quotes.saveQuote",
    outcome: "ACCEPT",
  },
  {
    id: "savequote/voided-contributes-zero",
    rule: "A VOIDED deposit is not customer credit and contributes nothing to the ceiling.",
    world: { proof: "SUPERSEDES_MATCHING", revision: "HEAD", money: "VOIDED", identity: "KEY_FRESH" },
    operation: "quotes.saveQuote",
    outcome: "ACCEPT",
  },
  {
    id: "savequote/replay-same-key-same-terms",
    rule: "A retry under the same operation identity returns the same quote, not a second root.",
    world: { proof: "NONE", revision: "NO_LINEAGE", money: "NONE", identity: "KEY_REPLAY_SAME_TERMS" },
    operation: "quotes.saveQuote",
    outcome: "ACCEPT",
  },
  {
    id: "savequote/replay-same-key-different-terms",
    rule: "The same identity with changed terms conflicts rather than silently winning.",
    world: { proof: "NONE", revision: "NO_LINEAGE", money: "NONE", identity: "KEY_REPLAY_DIFFERENT_TERMS" },
    operation: "quotes.saveQuote",
    outcome: "REFUSE",
    reason: /idempoten|conflict|different|reused/i,
  },

  // ── ownership vs money axes ───────────────────────────────────────────────
  {
    id: "closeroot/live-money",
    rule: "A root with live money cannot be closed.",
    world: { vehicle: "HELD_BY_SAME_ROOT", money: "WITHIN_HEAD_PRICE" },
    operation: "commitments.closeRoot",
    outcome: "REFUSE",
    reason: /unresolved|live|open|in progress|cannot close/i,
  },
  {
    id: "closeroot/awaiting-decision",
    rule: "Closure may not strand money awaiting an explicit disposition.",
    world: { vehicle: "RELEASED_AWAITING_DECISION", money: "AWAITING_DECISION" },
    operation: "commitments.closeRoot",
    outcome: "REFUSE",
    reason: /unresolved|awaiting|decision|cannot close/i,
  },
  {
    id: "closeroot/fully-resolved",
    rule: "A root whose money is fully resolved closes, releases the car, and reports closed.",
    world: { vehicle: "RELEASED_AWAITING_DECISION", money: "REFUNDED" },
    operation: "commitments.closeRoot",
    outcome: "ACCEPT",
  },

  // ── the paths that spend money ────────────────────────────────────────────
  {
    id: "sale/other-root-cash",
    rule: "A cash sale cannot consume a vehicle another root holds.",
    world: { vehicle: "HELD_BY_OTHER_ROOT", revision: "NO_LINEAGE", proof: "NONE", role: "PRIMARY" },
    operation: "sales.create",
    outcome: "REFUSE",
    reason: /committed|another deal|already held|no longer available/i,
  },
  {
    id: "sale/stale-quote",
    rule: "A sale may not complete against a superseded revision's terms.",
    world: {
      vehicle: "HELD_BY_SAME_ROOT",
      revision: "STALE",
      proof: "SUPERSEDES_MATCHING",
      role: "PRIMARY",
    },
    operation: "sales.create",
    outcome: "REFUSE",
    reason: /current revision|superseded|stale|current head/i,
  },
  {
    id: "complete/stale-quote",
    rule: "completeFromQuote refuses a superseded revision.",
    world: { vehicle: "HELD_BY_SAME_ROOT", revision: "STALE", money: "WITHIN_HEAD_PRICE" },
    operation: "sales.completeFromQuote",
    outcome: "REFUSE",
    reason: /current revision|superseded|stale|current head/i,
  },
  {
    id: "finalize/stale-quote",
    rule: "finalizeDeal refuses once its application's quote has been superseded.",
    world: { vehicle: "HELD_BY_SAME_ROOT", revision: "STALE" },
    operation: "applications.finalizeDeal",
    outcome: "REFUSE",
    reason: /current revision|superseded|stale|current head/i,
  },

  // ── applications ──────────────────────────────────────────────────────────
  {
    id: "application/same-root",
    rule: "An application from the same quote joins that root rather than competing.",
    world: { vehicle: "HELD_BY_SAME_ROOT", revision: "HEAD", proof: "NONE", source: "OWNED" },
    operation: "applications.createFromQuote",
    outcome: "ACCEPT",
  },
  {
    id: "application/other-root",
    rule: "An application on a vehicle a different root holds is refused.",
    world: { vehicle: "HELD_BY_OTHER_ROOT", revision: "HEAD", proof: "NONE", source: "OWNED" },
    operation: "applications.createFromQuote",
    outcome: "REFUSE",
    reason: /committed|another deal|already held|no longer available/i,
  },
  {
    id: "application/stale-revision",
    rule: "An application citing a superseded revision is refused.",
    world: { vehicle: "HELD_BY_SAME_ROOT", revision: "STALE", proof: "NONE", source: "OWNED" },
    operation: "applications.createFromQuote",
    outcome: "REFUSE",
    reason: /current revision|superseded|stale|current head/i,
  },

  // ── reacquisition ─────────────────────────────────────────────────────────
  {
    id: "reallocate/target-held-elsewhere",
    rule: "Re-allocating a released share onto a car another root now holds is an acquisition, and refused.",
    world: { vehicle: "HELD_BY_OTHER_ROOT", multiVehicle: true },
    operation: "deposits.resolveReleasedAllocation",
    outcome: "REFUSE",
    reason: /committed|another deal|already held|no longer available/i,
  },
  {
    id: "reallocate/target-free",
    rule: "Re-allocating onto a genuinely free line on the same quote is accepted.",
    world: { vehicle: "RELEASED_AWAITING_DECISION", multiVehicle: true },
    operation: "deposits.resolveReleasedAllocation",
    outcome: "ACCEPT",
  },

  // ── migrated from the free-form authority matrix (c14843) ────────────────
  // These were 21 hand-written fixtures. Expressing them as worlds collapses
  // several into scenarios that already existed — which is itself the point:
  // duplicates that stated the same rule in different prose could drift apart,
  // and now cannot.
  // ⚠️ DELETED IN MIGRATION, deliberately: "a financed multi-vehicle quote is
  // refused with NO partial state".
  //
  // The engine refuses multi-vehicle finance applications outright ("Finance
  // applications currently support…"), so that fixture could never reach the
  // commitment rule it was named for — the wrong-reason class, caught here by
  // the classifier before it could be committed a fifth time.
  //
  // Its actual value was the "no partial state" half, and that is no longer
  // one fixture's job: whole-world zero-delta is now asserted on EVERY refusal
  // the table declares. The property survives the deletion, strengthened.
  {
    id: "application/sourced-double-hold",
    rule: "A SOURCED row is ONE physical car: two applications cannot both hold it.",
    world: { vehicle: "HELD_BY_OTHER_ROOT", revision: "HEAD", proof: "NONE", source: "SOURCED" },
    operation: "applications.createFromQuote",
    outcome: "REFUSE",
    reason: /committed|another deal|already held|no longer available/i,
  },
  {
    id: "application/reopen-rejected-taken",
    rule: "Reopening a rejected application must RE-ACQUIRE, and loses if another deal took the car.",
    world: { vehicle: "HELD_BY_OTHER_ROOT" },
    operation: "applications.reopenRejected",
    outcome: "REFUSE",
    reason: /committed|another deal|already held|no longer available/i,
  },
  {
    id: "application/reopen-rejected-free",
    rule: "Reopening succeeds while the car is still free — rejection releases, it does not forfeit.",
    world: { vehicle: "FREE" },
    operation: "applications.reopenRejected",
    outcome: "ACCEPT",
  },
  {
    id: "sale/tradein-committed",
    rule: "A committed vehicle cannot be taken in as another deal's trade-in.",
    world: { vehicle: "HELD_BY_OTHER_ROOT", revision: "NO_LINEAGE", proof: "NONE", role: "TRADE_IN" },
    operation: "sales.create",
    outcome: "REFUSE",
    reason: /committed|another deal|already held|no longer available/i,
  },
  {
    id: "sale/tradein-free",
    rule: "An uncommitted vehicle is still accepted as a trade-in.",
    world: { vehicle: "FREE", revision: "NO_LINEAGE", proof: "NONE", role: "TRADE_IN" },
    operation: "sales.create",
    outcome: "ACCEPT",
  },
  {
    id: "sale/walkin-free-vehicle",
    rule: "An ordinary walk-in cash sale on an uncommitted car still completes.",
    world: { vehicle: "FREE", revision: "NO_LINEAGE", proof: "NONE", role: "PRIMARY" },
    operation: "sales.create",
    outcome: "ACCEPT",
  },
  {
    id: "vehicle/softdelete-committed",
    rule: "Soft-deleting a vehicle a live commitment holds is refused.",
    world: { vehicle: "HELD_BY_OTHER_ROOT" },
    operation: "vehicles.softDelete",
    outcome: "REFUSE",
    reason: /committed|another deal|already held|in use|cannot delete/i,
  },
  {
    id: "vehicle/archive-committed",
    rule: "Archiving is a second door out of inventory and is refused on a committed car.",
    world: { vehicle: "HELD_BY_OTHER_ROOT" },
    operation: "vehicles.archive",
    outcome: "REFUSE",
    // Widened to the refusal the engine ALREADY gives ("Release the
    // reservation or deposit…"). This rule is enforced today; my first pattern
    // was narrower than the real message and read a satisfied rule as a
    // violation — the same mistake as the reservation scenario.
    reason: /committed|another deal|already held|in use|cannot archive|release the (reservation|deposit)/i,
  },
  {
    id: "vehicle/softdelete-free",
    rule: "An uncommitted vehicle may still be soft-deleted.",
    world: { vehicle: "FREE" },
    operation: "vehicles.softDelete",
    outcome: "ACCEPT",
  },
  {
    id: "deposit/rejected-app-still-held",
    rule: "Rejecting the finance claim releases the CLAIM, not the money: same-root deposit keeps the car.",
    world: {
      vehicle: "REJECTED_APP_SAME_ROOT_DEPOSIT_LIVES",
      revision: "HEAD",
      proof: "NONE",
      money: "NONE",
    },
    operation: "deposits.create",
    outcome: "REFUSE",
    reason: /committed|another deal|already held|no longer available|deposit/i,
  },
  {
    id: "deposit/legacy-multi-root-fails-closed",
    rule: "A vehicle carrying two legacy roots is ambiguous, and ambiguity is never free inventory.",
    world: { vehicle: "LEGACY_MULTI_ROOT", revision: "HEAD", proof: "NONE", money: "NONE" },
    operation: "deposits.create",
    outcome: "REFUSE",
    reason: /conflict|ambiguous|committed|another deal|already held|not cutover/i,
  },
];

/**
 * ── QUERY CONTRACTS ─────────────────────────────────────────────────────────
 *
 * Some normative behaviour is not an ACCEPT/REFUSE decision at all: it is what
 * the system must SAY about a world. "This vehicle is ambiguous", "this org is
 * not cutover-ready", "this root is still financially open" are answers, not
 * permissions, and forcing them into the scenario table would either distort
 * the model or — worse — leave them in a structural check, which c14843
 * forbids from carrying product rules.
 *
 * So they get their own table with the SAME discipline: a declared world, a
 * query, and a declared expected answer that is comparable, so the same
 * contradiction preflight can run over them. An expectation expressed as a
 * callback would be unreadable to the preflight, which is exactly the property
 * that let contradictions survive in the free-form suite.
 */
type QueryName =
  | "commitments.resolveVehicleRoot"
  | "commitments.cutoverReadiness"
  | "commitments.rootFinancialState"
  | "commitments.listAgedCommitments";

interface QueryContract {
  id: string;
  rule: string;
  world: World;
  query: QueryName;
  /** Comparable by construction, so the preflight can detect disagreement. */
  expected: Record<string, string | boolean>;
}

export const QUERY_CONTRACTS: QueryContract[] = [
  {
    id: "resolve/legacy-multi-root-is-conflict",
    rule: "A vehicle with two live legacy roots resolves to CONFLICT — never a winner.",
    world: { vehicle: "LEGACY_MULTI_ROOT" },
    query: "commitments.resolveVehicleRoot",
    expected: { kind: "CONFLICT" },
  },
  {
    id: "resolve/free-vehicle-is-free",
    rule: "A vehicle no root holds resolves to FREE.",
    world: { vehicle: "FREE" },
    query: "commitments.resolveVehicleRoot",
    expected: { kind: "FREE" },
  },
  {
    id: "resolve/held-vehicle-names-an-owner",
    rule: "A vehicle a live root holds resolves to OWNED.",
    world: { vehicle: "HELD_BY_OTHER_ROOT" },
    query: "commitments.resolveVehicleRoot",
    expected: { kind: "OWNED" },
  },
  {
    id: "cutover/conflicted-vehicle-blocks-readiness",
    rule: "A conflicted vehicle makes the org NOT cutover-ready, so ambiguity cannot ship.",
    world: { vehicle: "LEGACY_MULTI_ROOT" },
    query: "commitments.cutoverReadiness",
    expected: { blocked: true },
  },
  {
    id: "money/awaiting-decision-keeps-root-open",
    rule: "Released-but-unresolved money leaves the root financially OPEN even though the car is free.",
    world: { vehicle: "RELEASED_AWAITING_DECISION", money: "AWAITING_DECISION" },
    query: "commitments.rootFinancialState",
    expected: { financiallyOpen: true },
  },
  {
    id: "resolve/never-reports-free-because-it-paginated",
    rule: "The 51st hold is still a hold: a paginated read must never report a held car as FREE.",
    world: { vehicle: "HELD_PAST_PAGINATION_LIMIT" },
    query: "commitments.resolveVehicleRoot",
    expected: { kind: "OWNED" },
  },
  {
    id: "aged/long-held-commitment-is-discoverable",
    rule: "An aged live commitment is discoverable so an operator can cancel it deliberately.",
    world: { vehicle: "HELD_LONG_AGO" },
    query: "commitments.listAgedCommitments",
    expected: { listed: true },
  },
];

describe("SCRUM-195 spec — consistency preflight (c14840)", () => {
  /**
   * ⚠️ THIS RUNS BEFORE ANY SCENARIO AND IS THE POINT OF THE RE-DERIVATION.
   *
   * Four times across three rounds the previous suite shipped a fixture that
   * could never validate what it claimed, twice because two fixtures demanded
   * opposite outcomes for the same situation. Reviewers caught them; nothing in
   * the suite could. This test is that missing mechanism.
   */
  test("no two scenarios require opposite outcomes for the same normalized world", () => {
    const byKey = new Map<string, Scenario[]>();
    for (const scenario of SCENARIOS) {
      const key = normalizeKey(scenario);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(scenario);
    }

    const contradictions: string[] = [];
    for (const [key, group] of byKey) {
      const outcomes = new Set(group.map((s) => s.outcome));
      if (outcomes.size > 1) {
        const detail = group.map((s) => `${s.id} → ${s.outcome}`).join("  vs  ");
        contradictions.push(`${key}\n      ${detail}`);
      }
    }

    expect(contradictions, `Contradictory scenarios:\n  ${contradictions.join("\n  ")}`).toEqual([]);
  });

  test("every scenario id is unique", () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  test("every REFUSE scenario names the refusal it expects", () => {
    // A bare "it threw" is satisfied by any unrelated auth, validator or
    // rate-limit failure. That is how a fixture goes green while testing
    // nothing, and it is not permitted here.
    const unnamed = SCENARIOS.filter((s) => s.outcome === "REFUSE" && !s.reason).map((s) => s.id);
    expect(unnamed).toEqual([]);
  });

  test("every scenario declares a value for each dimension its operation turns on", () => {
    // A dimension left undefined is excluded from the normalized key. If a
    // scenario omits one its operation genuinely depends on, it collides with
    // scenarios it does not actually describe — or, worse, collides with
    // nothing and the preflight silently never fires for it.
    const underspecified: string[] = [];
    for (const scenario of SCENARIOS) {
      const required = RELEVANT_DIMENSIONS[scenario.operation];
      const missing = required.filter(
        (d) => scenario.world[d] === undefined && d !== "multiVehicle"
      );
      if (missing.length) underspecified.push(`${scenario.id} omits ${missing.join(", ")}`);
    }
    expect(underspecified).toEqual([]);
  });

  test("every rule is stated in one line of prose, so the table reads as a specification", () => {
    const bad = [...SCENARIOS, ...QUERY_CONTRACTS].filter(
      (s) => !s.rule || s.rule.length < 20 || s.rule.includes("\n")
    );
    expect(bad.map((s) => s.id)).toEqual([]);
  });

  test("no two query contracts require different answers for the same world", () => {
    // The same discipline as the scenario preflight, for the half of the
    // specification that is an ANSWER rather than a permission. Without it,
    // "this vehicle is FREE" and "this vehicle is OWNED" could sit in the same
    // file describing the same world, exactly as the ACCEPT/REFUSE pairs did.
    const byKey = new Map<string, QueryContract[]>();
    for (const contract of QUERY_CONTRACTS) {
      const key = `${contract.query}::${JSON.stringify(contract.world, Object.keys(contract.world).sort())}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(contract);
    }

    const contradictions: string[] = [];
    for (const [key, group] of byKey) {
      const answers = new Set(group.map((c) => JSON.stringify(c.expected)));
      if (answers.size > 1) {
        contradictions.push(
          `${key}\n      ${group.map((c) => `${c.id} → ${JSON.stringify(c.expected)}`).join("  vs  ")}`
        );
      }
    }
    expect(contradictions, `Contradictory query contracts:\n  ${contradictions.join("\n  ")}`).toEqual(
      []
    );
  });

  test("scenario and query-contract ids do not collide", () => {
    const all = [...SCENARIOS.map((s) => s.id), ...QUERY_CONTRACTS.map((c) => c.id)];
    expect(all.length).toBe(new Set(all).size);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE EXECUTOR
//
// Builds each declared world against the real backend and runs the operation.
// ─────────────────────────────────────────────────────────────────────────────

type Seed = Awaited<ReturnType<typeof seedDealer>>;

async function seedDealer(suffix: string) {
  const t = convexTestWithComponents(schema, MODULES);

  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Spec ${suffix}`, createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `spec_${suffix}`, email: `s${suffix}@x.com`, name: "Closer" })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `spec_ap_${suffix}`, email: `sa${suffix}@x.com`, name: "Approver" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Spec",
      permissions: [
        "view:sales",
        "create:sales",
        "edit:sales",
        "approve:requests",
        "view:customers",
        "edit:vehicles",
        "delete:vehicles",
        "create:finance_application",
        "review:finance_application",
        "approve:finance_application",
        "finalize:financed_deal",
        "view:finance_applications",
        "register:vehicle_handover",
        "register:expected_payment",
      ],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));

  const customerA = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Aisha", lastName: "Root" })
  );
  const customerB = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Bilal", lastName: "Other" })
  );
  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId,
      name: "Spec Finance",
      profitRate: 5,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
    })
  );

  return {
    t,
    orgId,
    userId,
    approverId,
    customerA,
    customerB,
    companyId,
    asUser: t.withIdentity({ subject: `spec_${suffix}`, clerkId: `spec_${suffix}` }),
    asApprover: t.withIdentity({ subject: `spec_ap_${suffix}`, clerkId: `spec_ap_${suffix}` }),
  };
}

let vinCounter = 0;
async function vehicle(seed: Seed, source: VehicleSource = "OWNED"): Promise<Id<"vehicles">> {
  const vin = `SPEC${String(vinCounter++).padStart(13, "0")}`;
  return await seed.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: seed.orgId,
      vin,
      make: "Toyota",
      model: "Land Cruiser",
      year: 2024,
      mileage: 20,
      color: "White",
      fuelType: "Gasoline",
      transmission: "Automatic",
      sellingPrice: PRICE,
      status: "AVAILABLE",
      // A SOURCED row is one physical car several dealers may list, which is
      // the case where "two applications on one vehicle" looks legitimate and
      // is not.
      ...(source === "SOURCED" ? { sourceType: "SOURCED" as const } : {}),
    })
  );
}

/**
 * ⚠️ EVERY LOAD-BEARING SETUP OPERATION GOES THROUGH HERE (c14840).
 *
 * The legacy-conflict contradiction hid for three rounds because its two
 * cross-root deposits were bare `await` calls with no assertion. They were
 * every bit as much a specification as a decorated `expect` — the test could
 * not pass unless they succeeded — but no scan of assertions could see them,
 * and no reader treated them as claims.
 *
 * Wrapping them makes the claim explicit and, when it fails, says WHICH step
 * of WHICH scenario failed instead of surfacing as a bare rejection halfway
 * through an opaque setup.
 */
async function mustSucceed<T>(label: string, op: Promise<T>): Promise<T> {
  try {
    return await op;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SETUP FAILED — "${label}" was required to succeed but refused: ${message}`);
  }
}

interface BuiltWorld {
  vehicleId: Id<"vehicles">;
  /** The application under test, for the reopen path. */
  rejectedApplicationId?: Id<"financeApplications">;
  /** The car actually being SOLD when `vehicleId` is a trade-in. */
  primaryVehicleId?: Id<"vehicles">;
  /** The root under test, when the scenario has one. */
  ownQuoteId?: Id<"quotes">;
  /** The current head, when a supersession has happened. */
  headQuoteId?: Id<"quotes">;
  rivalQuoteId?: Id<"quotes">;
  reservationId?: Id<"vehicleReservations">;
  releasedHoldId?: Id<"depositVehicleHolds">;
  secondVehicleId?: Id<"vehicles">;
}

async function quoteFor(
  seed: Seed,
  customerId: Id<"customers">,
  vehicleId: Id<"vehicles">,
  extra: Record<string, unknown> = {}
): Promise<Id<"quotes">> {
  return await mustSucceed(
    `quote for ${String(customerId).slice(-6)}`,
    seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId,
      vehicleId,
      mode: "CASH" as const,
      vehiclePrice: PRICE,
      downPayment: 0,
      termMonths: 0,
      totalFinancedAmount: 0,
      ...extra,
    })
  );
}

/**
 * Constructs the declared world.
 *
 * Where a world can only be reached through a surface that does not exist yet
 * (a superseded revision needs `supersedesQuoteId`), the setup throws through
 * `mustSucceed` and the scenario is PREREQUISITE-red — failing in setup, named
 * as such, rather than quietly appearing to test its own subject. That is a
 * real boundary of a design-before-implementation suite, stated rather than
 * hidden.
 */
async function buildWorld(seed: Seed, scenario: Scenario): Promise<BuiltWorld> {
  const { world } = scenario;
  const vehicleId = await vehicle(seed, world.source ?? "OWNED");
  const built: BuiltWorld = { vehicleId };

  // A trade-in is a SECOND vehicle role in one sale. The car being bought must
  // exist and be free, or the sale fails on the primary rather than on the
  // trade-in rule under test.
  if (world.role === "TRADE_IN") {
    built.primaryVehicleId = await vehicle(seed);
  }

  // The reopen path needs a genuinely rejected application, reached the
  // ordinary way rather than seeded — rejection is what releases the claim, so
  // manufacturing the row would skip the very transition being measured.
  if (scenario.operation === "applications.reopenRejected") {
    const ownQuote = await quoteFor(seed, seed.customerA, vehicleId);
    built.ownQuoteId = ownQuote;
    built.rejectedApplicationId = (await mustSucceed(
      "create the application that will be rejected",
      seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId: ownQuote,
      })
    )) as Id<"financeApplications">;
    await mustSucceed(
      "reject it",
      seed.asUser.mutation(api.applications.updateStatus, {
        orgId: seed.orgId,
        applicationId: built.rejectedApplicationId,
        status: "REJECTED" as const,
      })
    );
    if (world.vehicle === "HELD_BY_OTHER_ROOT") {
      built.rivalQuoteId = await quoteFor(seed, seed.customerB, vehicleId);
      await mustSucceed(
        "a rival takes the car the rejection released",
        seed.asUser.mutation(api.deposits.create, {
          orgId: seed.orgId,
          quoteId: built.rivalQuoteId,
          amount: 1_500,
        })
      );
    }
    return built;
  }

  // ── reacquisition has its own shape ──────────────────────────────────────
  // `resolveReleasedAllocation` needs a released SHARE to move and a TARGET to
  // move it onto, which no other operation requires. Building it inside the
  // generic path produced a hold id of `undefined` and a validator error —
  // a refusal that matched no rule, wearing the costume of one.
  if (scenario.operation === "deposits.resolveReleasedAllocation") {
    const source = await vehicle(seed);
    built.secondVehicleId = source;
    const quoteId = await quoteFor(seed, seed.customerA, vehicleId, {
      vehicleItems: [
        { vehicleId, unitPrice: PRICE },
        { vehicleId: source, unitPrice: PRICE },
      ],
      vehiclePrice: PRICE * 2,
    });
    built.ownQuoteId = quoteId;
    await mustSucceed(
      "seed the two-car deposit",
      seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 4_000 })
    );
    await mustSucceed(
      "allocate a real share to each car",
      seed.asUser.mutation(api.deposits.allocateToVehicles, {
        orgId: seed.orgId,
        quoteId,
        allocations: [
          { vehicleId, amount: 2_000 },
          { vehicleId: source, amount: 2_000 },
        ],
      })
    );
    // BOTH are released: the target must be genuinely free for a rival to be
    // able to take it (a deposit holds every line on its quote), and the source
    // must be released to have a share awaiting a decision at all.
    for (const [id, why] of [
      [vehicleId, "free the target"],
      [source, "release the share to be moved"],
    ] as const) {
      await mustSucceed(
        why,
        seed.asUser.mutation(api.deposits.releaseVehicleAllocation, {
          orgId: seed.orgId,
          quoteId,
          vehicleId: id,
          reason: why,
        })
      );
    }
    const hold = await seed.t.run(async (ctx) => {
      const holds = await ctx.db
        .query("depositVehicleHolds")
        .filter((q) => q.eq(q.field("vehicleId"), source))
        .collect();
      return holds.find((h) => h.allocationStatus === "RELEASED_AWAITING_DECISION");
    });
    expect(hold, "setup: the source share must be awaiting a decision").toBeDefined();
    built.releasedHoldId = hold!._id;

    if (world.vehicle === "HELD_BY_OTHER_ROOT") {
      built.rivalQuoteId = await quoteFor(seed, seed.customerB, vehicleId);
      await mustSucceed(
        "rival acquires the released target",
        seed.asUser.mutation(api.deposits.create, {
          orgId: seed.orgId,
          quoteId: built.rivalQuoteId,
          amount: 1_500,
        })
      );
    }
    return built;
  }

  if (world.multiVehicle) built.secondVehicleId = await vehicle(seed);

  const needsOwnRoot =
    world.revision === "HEAD" ||
    world.revision === "STALE" ||
    world.vehicle === "HELD_BY_SAME_ROOT" ||
    world.vehicle === "RELEASED_AWAITING_DECISION" ||
    world.money !== undefined;

  if (needsOwnRoot) {
    built.ownQuoteId = built.secondVehicleId
      ? await quoteFor(seed, seed.customerA, vehicleId, {
          vehicleItems: [
            { vehicleId, unitPrice: PRICE },
            { vehicleId: built.secondVehicleId, unitPrice: PRICE },
          ],
          vehiclePrice: PRICE * 2,
        })
      : await quoteFor(seed, seed.customerA, vehicleId);
  }

  // ── money ────────────────────────────────────────────────────────────────
  if (built.ownQuoteId && world.money && world.money !== "NONE") {
    const quoteId = built.ownQuoteId;
    if (world.money === "WITHIN_HEAD_PRICE" || world.money === "EXCEEDS_HEAD_PRICE") {
      await mustSucceed(
        "seed retained deposit",
        seed.asUser.mutation(api.deposits.create, {
          orgId: seed.orgId,
          quoteId,
          amount: world.money === "EXCEEDS_HEAD_PRICE" ? PRICE : 2_000,
        })
      );
    }
    if (world.money === "VOIDED") {
      const depositId = await mustSucceed(
        "seed deposit to be voided",
        seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: PRICE })
      );
      await mustSucceed(
        "void the deposit",
        seed.asApprover.mutation(api.deposits.voidDeposit, {
          orgId: seed.orgId,
          depositId,
          reason: "entered against the wrong deal",
        })
      );
    }
    if (world.money === "AWAITING_DECISION" || world.money === "REFUNDED") {
      // Awaiting-decision shares only arise on a MULTI-vehicle deal: a
      // single-vehicle quote allocates its deposit in full and refuses to
      // release a share that is the whole thing.
      const second = built.secondVehicleId ?? (await vehicle(seed));
      built.secondVehicleId = second;
      const multi = await quoteFor(seed, seed.customerA, vehicleId, {
        vehicleItems: [
          { vehicleId, unitPrice: PRICE },
          { vehicleId: second, unitPrice: PRICE },
        ],
        vehiclePrice: PRICE * 2,
      });
      built.ownQuoteId = multi;
      await mustSucceed(
        "seed multi-vehicle deposit",
        seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: multi, amount: 4_000 })
      );
      await mustSucceed(
        "allocate across both cars",
        seed.asUser.mutation(api.deposits.allocateToVehicles, {
          orgId: seed.orgId,
          quoteId: multi,
          allocations: [
            { vehicleId, amount: 2_000 },
            { vehicleId: second, amount: 2_000 },
          ],
        })
      );
      await mustSucceed(
        "release the second car's share",
        seed.asUser.mutation(api.deposits.releaseVehicleAllocation, {
          orgId: seed.orgId,
          quoteId: multi,
          vehicleId: second,
          reason: "customer dropped it",
        })
      );
      const hold = await seed.t.run(async (ctx) => {
        const holds = await ctx.db
          .query("depositVehicleHolds")
          .filter((q) => q.eq(q.field("vehicleId"), second))
          .collect();
        return holds.find((h) => h.allocationStatus === "RELEASED_AWAITING_DECISION");
      });
      expect(hold, "setup: a released share must exist").toBeDefined();
      built.releasedHoldId = hold!._id;

      if (world.money === "REFUNDED") {
        // Maker-checker: `assertDifferentActors` forbids the depositor
        // resolving their own refund.
        await mustSucceed(
          "refund the released share",
          seed.asApprover.mutation(api.deposits.resolveReleasedAllocation, {
            orgId: seed.orgId,
            holdId: built.releasedHoldId,
            treatment: "REFUND_TO_CUSTOMER" as const,
            refundMethod: "CASH" as const,
            reason: "customer took it back",
          })
        );
      }
    }
  }

  // ── vehicle commitment state ─────────────────────────────────────────────
  if (world.vehicle === "REJECTED_APP_SAME_ROOT_DEPOSIT_LIVES") {
    const ownQuote = built.ownQuoteId ?? (await quoteFor(seed, seed.customerA, vehicleId));
    built.ownQuoteId = ownQuote;
    await mustSucceed(
      "the root's own deposit, which must survive the rejection",
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId: ownQuote,
        amount: 1_000,
      })
    );
    const applicationId = await mustSucceed(
      "the finance application on the same root",
      seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId: ownQuote,
      })
    );
    await mustSucceed(
      "reject it",
      seed.asUser.mutation(api.applications.updateStatus, {
        orgId: seed.orgId,
        applicationId,
        status: "REJECTED" as const,
      })
    );
  }

  if (world.vehicle === "LEGACY_MULTI_ROOT") {
    // Seeded DIRECTLY, and c14840 permits exactly this: once the acquisition
    // guard lands, the public path refuses the second deposit and the state
    // becomes unconstructible through the API — while remaining precisely what
    // a backfill inherits from today's data. A specification expressible only
    // before the fix is no specification for the fix.
    const rootA = await quoteFor(seed, seed.customerA, vehicleId);
    const rootB = await quoteFor(seed, seed.customerB, vehicleId);
    await seed.t.run(async (ctx) => {
      for (const [customerId, quoteId, amount] of [
        [seed.customerA, rootA, 1_000],
        [seed.customerB, rootB, 2_000],
      ] as const) {
        await ctx.db.insert("deposits", {
          orgId: seed.orgId,
          customerId,
          quoteId,
          vehicleId,
          amount,
          amountMinor: amount * 1_000,
          currency: "JOD",
          method: "CASH" as const,
          status: "HELD" as const,
          holdActive: true,
          createdAt: Date.now(),
          createdBy: seed.userId,
        });
      }
    });
    // The acting quote is a THIRD, independent quote on the SAME car — that is
    // what "a new deposit lands on an ambiguous vehicle" means. It must not be
    // pointed at a different vehicle, or the scenario silently stops being
    // about ambiguity at all.
    built.ownQuoteId = await quoteFor(seed, seed.customerA, vehicleId);
  }

  if (world.vehicle === "HELD_LONG_AGO") {
    const rival = await quoteFor(seed, seed.customerB, vehicleId);
    built.rivalQuoteId = rival;
    await mustSucceed(
      "an ordinary commitment",
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId: rival,
        amount: 1_500,
      })
    );
    // Then age it. Backdating the row is the only way to get a months-old
    // commitment inside a test, and the age is the entire subject.
    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
    await seed.t.run(async (ctx) => {
      for (const row of await ctx.db
        .query("deposits")
        .filter((q) => q.eq(q.field("vehicleId"), vehicleId))
        .collect()) {
        await ctx.db.patch(row._id, { createdAt: ninetyDaysAgo });
      }
    });
  }

  if (world.vehicle === "HELD_PAST_PAGINATION_LIMIT") {
    // 50 dead holds, then one LIVE one. Seeded directly because producing 51
    // holds through the public API would take 51 deals; the shape is what
    // matters, and it is what a busy car actually looks like after a year of
    // quotes that went nowhere.
    const rival = await quoteFor(seed, seed.customerB, vehicleId);
    built.rivalQuoteId = rival;
    await seed.t.run(async (ctx) => {
      for (let i = 0; i < 50; i++) {
        const depositId = await ctx.db.insert("deposits", {
          orgId: seed.orgId,
          customerId: seed.customerA,
          quoteId: rival,
          vehicleId,
          amount: 1,
          amountMinor: 1_000,
          currency: "JOD",
          method: "CASH" as const,
          status: "REFUNDED" as const,
          holdActive: false,
          createdAt: Date.now(),
          createdBy: seed.userId,
        });
        await ctx.db.insert("depositVehicleHolds", {
          orgId: seed.orgId,
          depositId,
          vehicleId,
          active: false,
          createdAt: Date.now(),
        });
      }
    });
    await mustSucceed(
      "the 51st, LIVE hold",
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId: rival,
        amount: 1_500,
      })
    );
  }

  if (world.vehicle === "HELD_BY_OTHER_ROOT") {
    built.rivalQuoteId = await quoteFor(seed, seed.customerB, vehicleId);
    await mustSucceed(
      "rival takes the vehicle",
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId: built.rivalQuoteId,
        amount: 1_500,
      })
    );
  }
  if (world.vehicle === "HELD_BY_SAME_ROOT" && built.ownQuoteId && !world.money) {
    await mustSucceed(
      "own root takes the vehicle",
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId: built.ownQuoteId,
        amount: 1_000,
      })
    );
  }

  // ── revision state ───────────────────────────────────────────────────────
  if ((world.revision === "STALE" || world.proof === "SUPERSEDES_MATCHING") && built.ownQuoteId) {
    built.headQuoteId = (await mustSucceed(
      "supersede the head (PENDING SURFACE: saveQuote.supersedesQuoteId)",
      seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
        orgId: seed.orgId,
        customerId: seed.customerA,
        vehicleId,
        mode: "CASH",
        vehiclePrice: PRICE - 500,
        downPayment: 0,
        termMonths: 0,
        totalFinancedAmount: 0,
        supersedesQuoteId: built.ownQuoteId,
      })
    )) as Id<"quotes">;
  }

  // ── proof ────────────────────────────────────────────────────────────────
  if (world.proof?.startsWith("RESERVATION")) {
    const reservedVehicle =
      world.proof === "RESERVATION_WRONG_VEHICLE" ? await vehicle(seed) : vehicleId;
    const reservationCustomer =
      world.proof === "RESERVATION_WRONG_CUSTOMER" ? seed.customerB : seed.customerA;
    built.reservationId = (await mustSucceed(
      "create the reservation used as proof",
      seed.asUser.mutation(api.vehicles.createReservation, {
        orgId: seed.orgId,
        vehicleId: reservedVehicle,
        customerId: reservationCustomer,
      })
    )) as Id<"vehicleReservations">;

    if (world.proof === "RESERVATION_NOT_ACTIVE") {
      await seed.t.run(async (ctx) => {
        await ctx.db.patch(built.reservationId!, { status: "RELEASED" });
      });
    }
    if (world.proof === "RESERVATION_ALREADY_ADOPTED") {
      await mustSucceed(
        "first adoption (PENDING SURFACE: saveQuote.reservationId)",
        seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
          orgId: seed.orgId,
          customerId: seed.customerA,
          vehicleId,
          mode: "CASH",
          vehiclePrice: PRICE,
          downPayment: 0,
          termMonths: 0,
          totalFinancedAmount: 0,
          reservationId: built.reservationId,
        })
      );
    }
  }
  if (world.proof === "BOTH_PROOFS_DIFFERENT_ROOTS") {
    built.reservationId = (await mustSucceed(
      "reservation leg of the conflicting pair",
      seed.asUser.mutation(api.vehicles.createReservation, {
        orgId: seed.orgId,
        vehicleId,
        customerId: seed.customerA,
      })
    )) as Id<"vehicleReservations">;
    built.ownQuoteId = await quoteFor(seed, seed.customerA, await vehicle(seed));
  }
  if (world.proof?.startsWith("SUPERSEDES") && !built.ownQuoteId) {
    built.ownQuoteId = await quoteFor(seed, seed.customerA, vehicleId);
  }

  return built;
}

/**
 * The quote the operation acts THROUGH.
 *
 * A stale-revision scenario deliberately cites the superseded quote; everything
 * else cites the current head. Getting this backwards is precisely the bug that
 * produced the price-RISE contradiction, so it is decided ONCE here instead of
 * being re-decided, differently, in each fixture.
 */
function actingQuote(world: World, built: BuiltWorld): Id<"quotes"> | undefined {
  if (world.revision === "STALE") return built.ownQuoteId;
  return built.headQuoteId ?? built.ownQuoteId;
}

async function invoke(seed: Seed, scenario: Scenario, built: BuiltWorld): Promise<unknown> {
  const { world, operation } = scenario;
  const quoteId = actingQuote(world, built);
  const { vehicleId } = built;

  switch (operation) {
    case "deposits.create":
      return seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId: quoteId!,
        amount: world.money === "EXCEEDS_HEAD_PRICE" ? PRICE : 1_000,
      });

    case "applications.createFromQuote":
      return seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId: quoteId!,
      });

    case "applications.finalizeDeal":
      return seed.asUser.mutation(notYetBuilt.applications.finalizeDeal, {
        orgId: seed.orgId,
        quoteId: quoteId!,
      });

    case "vehicles.createReservation":
      return seed.asUser.mutation(
        world.proof === "NONE"
          ? api.vehicles.createReservation
          : notYetBuilt.vehicles.createReservation,
        {
          orgId: seed.orgId,
          vehicleId,
          customerId: seed.customerA,
          ...(world.proof === "NONE" ? {} : { quoteId: quoteId! }),
        }
      );

    case "quotes.saveQuote": {
      const items = built.secondVehicleId
        ? {
            vehicleItems: [
              { vehicleId, unitPrice: PRICE },
              { vehicleId: built.secondVehicleId, unitPrice: PRICE },
            ],
            vehiclePrice: PRICE * 2,
          }
        : {};
      const proofArgs: Record<string, unknown> = {};
      if (world.proof?.startsWith("RESERVATION")) proofArgs.reservationId = built.reservationId;
      if (world.proof?.startsWith("SUPERSEDES")) proofArgs.supersedesQuoteId = built.ownQuoteId;
      if (world.proof === "BOTH_PROOFS_DIFFERENT_ROOTS") {
        proofArgs.reservationId = built.reservationId;
        proofArgs.supersedesQuoteId = built.ownQuoteId;
      }
      const customerId =
        world.proof === "SUPERSEDES_WRONG_CUSTOMER" ? seed.customerB : seed.customerA;
      const targetVehicle =
        world.proof === "SUPERSEDES_WRONG_VEHICLE" ? await vehicle(seed) : vehicleId;

      const args: Record<string, unknown> = {
        orgId: seed.orgId,
        customerId,
        vehicleId: targetVehicle,
        mode: "CASH",
        vehiclePrice:
          world.money === "EXCEEDS_HEAD_PRICE"
            ? 500
            : world.money === "AWAITING_DECISION"
              ? 5_000
              : PRICE,
        downPayment: 0,
        termMonths: 0,
        totalFinancedAmount: 0,
        ...items,
        ...proofArgs,
      };

      const key = `spec-${scenario.id}`;
      if (world.identity === "KEY_REPLAY_SAME_TERMS") {
        await mustSucceed(
          "first call of the replay pair",
          seed.asUser.mutation(notYetBuilt.quotes.saveQuote, { ...args, idempotencyKey: key })
        );
        return seed.asUser.mutation(notYetBuilt.quotes.saveQuote, { ...args, idempotencyKey: key });
      }
      if (world.identity === "KEY_REPLAY_DIFFERENT_TERMS") {
        await mustSucceed(
          "first call of the conflicting pair",
          seed.asUser.mutation(notYetBuilt.quotes.saveQuote, { ...args, idempotencyKey: key })
        );
        return seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
          ...args,
          vehiclePrice: PRICE - 3_000,
          idempotencyKey: key,
        });
      }
      return seed.asUser.mutation(notYetBuilt.quotes.saveQuote, { ...args, idempotencyKey: key });
    }

    case "sales.create": {
      // When the vehicle under test is a TRADE-IN, the sale is of a different,
      // free car and the vehicle under test arrives as `tradeInVehicleId`. That
      // is a second acquisition path into one mutation, and it was an unguarded
      // writer: the trade-in guard refuses SOLD and ARCHIVED but has never
      // consulted commitments.
      const isTradeIn = world.role === "TRADE_IN";
      return seed.asUser.mutation(api.sales.create, {
        orgId: seed.orgId,
        vehicleId: isTradeIn ? built.primaryVehicleId! : vehicleId,
        customerId: seed.customerA,
        salespersonId: seed.userId,
        salePrice: PRICE,
        saleDate: Date.now(),
        status: "COMPLETED" as const,
        ...(isTradeIn ? { tradeInVehicleId: vehicleId, tradeInValue: 5_000 } : {}),
        ...(quoteId && !isTradeIn ? { quoteId } : {}),
      });
    }

    case "applications.reopenRejected":
      // Rejection RELEASED the claim, so reopening must re-acquire and lose if
      // a competitor got there first.
      // PENDING_DOCS, not UNDER_REVIEW: `REJECTED: ["PENDING_DOCS"]` is the
      // only legal transition out of rejection. Using any other status fails
      // on the state machine before the commitment authority is consulted —
      // a refusal that matched no rule, wearing the costume of one.
      return seed.asUser.mutation(api.applications.updateStatus, {
        orgId: seed.orgId,
        applicationId: built.rejectedApplicationId!,
        status: "PENDING_DOCS" as const,
      });

    case "vehicles.softDelete":
      return seed.asUser.mutation(api.vehicles.softDelete, {
        orgId: seed.orgId,
        vehicleId,
      });

    case "vehicles.archive":
      // The SECOND door out of inventory. `vehicles.update` accepts a status
      // change independently of `softDelete`, so a guard on one is not a guard
      // on the other.
      return seed.asUser.mutation(api.vehicles.update, {
        orgId: seed.orgId,
        vehicleId,
        status: "ARCHIVED" as const,
      });

    case "sales.completeFromQuote":
      return seed.asUser.mutation(api.sales.completeFromQuote, {
        orgId: seed.orgId,
        quoteId: quoteId!,
      });

    case "commitments.closeRoot":
      return seed.asUser.mutation(notYetBuilt.commitments.closeRoot, {
        orgId: seed.orgId,
        quoteId: quoteId!,
      });

    case "deposits.resolveReleasedAllocation":
      return seed.asUser.mutation(api.deposits.resolveReleasedAllocation, {
        orgId: seed.orgId,
        holdId: built.releasedHoldId!,
        treatment: "REALLOCATE_TO_VEHICLE" as const,
        toVehicleId: vehicleId,
        reason: "move the released share",
      });
  }
}

/**
 * Every table a refused operation could plausibly touch.
 *
 * "Nothing was written" is only a claim if the world is actually counted.
 * Asserting that no DEPOSIT row appeared would miss the payment, transaction,
 * hold, ledger and notification residue that is the entire reason the rule
 * exists.
 */
const WORLD_TABLES = [
  "deposits",
  "depositVehicleHolds",
  "depositApplications",
  "transactions",
  "vehicleReservations",
  "notifications",
  "financeApplications",
  "sales",
  "receivableDocuments",
  "journalEntries",
  "pendingAccountingEvents",
  "collectionPayments",
  "canonicalPayments",
  "paymentVouchers",
] as const;

async function snapshotWorld(seed: Seed): Promise<Record<string, number>> {
  return await seed.t.run(async (ctx) => {
    const counts: Record<string, number> = {};
    for (const table of WORLD_TABLES) {
      counts[table] = (await ctx.db.query(table).collect()).length;
    }
    return counts;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// STRUCTURAL INVARIANTS (c14843)
//
// Properties of the SOURCE, which a scenario table cannot express. Each carries
// an explicit invariant ID so it can be cited, and NONE of them may hide an
// ACCEPT/REFUSE product rule — every such rule belongs in SCENARIOS, where the
// contradiction preflight can see it. What lives here is "does this file exist,
// is this surface shaped this way, is this list complete" — never "is this
// operation permitted".
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The c14843 contract for `testSupport:deploymentIdentity`, mechanically.
 *
 * The ruling is narrow and every clause of it is load-bearing: a read-only
 * query, EXACTLY empty args, returning ONLY the canonical deployment identity
 * plus a disposable boolean, carrying no secrets and no write authority.
 *
 * An earlier version of INV-4 checked only that the export was a query, that
 * the module exported no mutation, and that a few obvious secret words were
 * absent. That leaves the two clauses that actually BOUND the authority
 * unenforced — nothing stopped the surface growing an `orgId` argument, or
 * returning a deploy key alongside the two allowed fields. "Read-only" is not
 * the same as "narrow": a query that accepts arbitrary arguments and returns
 * arbitrary configuration is a read-only information-disclosure endpoint.
 *
 * Returned as a list of coded violations rather than a boolean so a failure
 * says WHICH clause broke, and so each clause can be proven to fire.
 */
type IdentityViolationCode =
  | "NOT_A_QUERY"
  | "ARGS_NOT_EMPTY"
  | "NO_RETURN_VALIDATOR"
  | "RETURN_SURFACE_NOT_EXACT"
  | "MODULE_EXPORTS_MUTATION"
  | "LEAKS_AUTHORITY";

interface IdentityContractViolation {
  code: IdentityViolationCode;
  detail: string;
}

/** The complete authority surface c14843 permits. Nothing else may be returned. */
const ALLOWED_IDENTITY_FIELDS = ["cloudUrl", "disposable"];

function balancedFrom(source: string, openIdx: number, open: string, close: string): string {
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === open) depth++;
    else if (source[i] === close) {
      depth--;
      if (depth === 0) return source.slice(openIdx, i + 1);
    }
  }
  return "";
}

export function checkDeploymentIdentityContract(source: string): IdentityContractViolation[] {
  const violations: IdentityContractViolation[] = [];

  const decl = source.match(/export\s+const\s+deploymentIdentity\s*=\s*(\w+)\s*\(/);
  if (!decl || decl[1] !== "query") {
    violations.push({
      code: "NOT_A_QUERY",
      detail: decl ? `declared as ${decl[1]}(), not query()` : "not exported at all",
    });
    return violations; // Nothing below is meaningful without the declaration.
  }

  const block = balancedFrom(source, source.indexOf("(", decl.index!), "(", ")");

  // Clause: EXACTLY empty args.
  const args = block.match(/args\s*:\s*\{([^}]*)\}/);
  if (!args || args[1].trim() !== "") {
    violations.push({
      code: "ARGS_NOT_EMPTY",
      detail: args ? `accepts ${args[1].trim()}` : "declares no args validator",
    });
  }

  // Clause: the returned surface is exactly the two allowed fields. An explicit
  // `returns:` validator is required — inferring the shape from the handler
  // body would mean the contract is enforced by reading prose, which is what
  // this whole file exists to stop doing.
  const returnsIdx = block.search(/returns\s*:\s*v\.object\s*\(/);
  if (returnsIdx === -1) {
    violations.push({
      code: "NO_RETURN_VALIDATOR",
      detail: "no returns: v.object({...}) — the returned surface is unbounded",
    });
  } else {
    const objOpen = block.indexOf("{", block.indexOf("v.object", returnsIdx));
    const fields = [...new Set([...balancedFrom(block, objOpen, "{", "}").matchAll(/(\w+)\s*:/g)].map((m) => m[1]))].sort();
    if (JSON.stringify(fields) !== JSON.stringify([...ALLOWED_IDENTITY_FIELDS].sort())) {
      violations.push({
        code: "RETURN_SURFACE_NOT_EXACT",
        detail: `returns { ${fields.join(", ")} }; c14843 permits exactly { ${ALLOWED_IDENTITY_FIELDS.join(", ")} }`,
      });
    }
  }

  // Clause: no write authority anywhere in the module.
  const mutation = source.match(/export\s+const\s+(\w+)\s*=\s*(?:internal)?[Mm]utation\s*\(/);
  if (mutation) {
    violations.push({
      code: "MODULE_EXPORTS_MUTATION",
      detail: `exports mutation ${mutation[1]} — c14843 forbids public write-capable testSupport surfaces`,
    });
  }

  // Clause: no secrets or authority-bearing material.
  for (const token of ["SECRET", "TOKEN", "PRIVATE_KEY", "DEPLOY_KEY", "CONVEX_AUTH"]) {
    if (source.includes(token)) {
      violations.push({ code: "LEAKS_AUTHORITY", detail: `mentions ${token}` });
    }
  }

  return violations;
}

describe("SCRUM-195 spec — structural invariants", () => {
  test("INV-1 the contention harness declares no public testSupport SEED MUTATION", async () => {
    // c14840: preview contention bootstraps through real authenticated
    // product/admin paths. A public mutation that manufactures scenario state
    // is reachable by anyone holding a session, and the probe's own
    // caller-side "is this deployment disposable?" check protects the probe,
    // not the endpoint.
    //
    // One read-only `testSupport:deploymentIdentity` query survives on purpose:
    // it writes nothing and exists to REFUSE rather than to enable. If it ever
    // becomes a mutation, this test must start failing — which is why the
    // assertion is on `client.mutation`, not on the string `testSupport:`.
    const { readFileSync } = await import("node:fs");
    const harness = readFileSync("scripts/vehicleCommitmentContention.mjs", "utf8");

    const seedMutations = [
      ...harness.matchAll(/client\.mutation\(\s*["'`](testSupport:[A-Za-z0-9_]+)["'`]/g),
    ].map((m) => m[1]);

    expect(seedMutations).toEqual([]);
  });

  test("INV-2 every saveQuote caller is inventoried, web and mobile alike", async () => {
    // c14840 put `apps/mobile` IN SCOPE and made this the cutover gate rather
    // than a curiosity: supported callers must declare NEW vs REVISE and carry
    // a stable operation identity, and no fallback may be removed until this
    // inventory proves zero supported legacy callers remain.
    //
    // Mobile has no revise path today, so under the cross-root rule a mobile
    // salesperson re-pricing their own customer's deal would mint a competing
    // root and have that customer's own second deposit refused. The registry
    // exists so that fact cannot go unnoticed again — it was invisible for
    // three rounds because the scan only looked at `components`, `app`, `lib`.
    const CALLERS = [
      "apps/mobile/src/features/workspace/modules/quotes.tsx",
      "apps/mobile/src/features/workspace/salesWizard/SalesWizardScreen.tsx",
      "components/sales/QuoteDialog.tsx",
      "components/sales/wizard/steps/Step3Review.tsx",
    ];

    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join, relative, sep } = await import("node:path");

    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "_generated") continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx|js|jsx|mjs)$/.test(entry) || /\.test\./.test(entry)) continue;
        const text = readFileSync(full, "utf8");
        const DOTTED = /api\s*\.\s*quotes\s*\.\s*saveQuote/;
        const BRACKET =
          /api\s*(?:\.\s*quotes|\[\s*["'`]quotes["'`]\s*\])\s*\[\s*["'`]saveQuote["'`]\s*\]/;
        if (DOTTED.test(text) || BRACKET.test(text)) {
          found.push(relative(process.cwd(), full).split(sep).join("/"));
        }
      }
    };
    // `convex` is scanned too: a server-side `ctx.runMutation` caller mints a
    // root exactly like a client one, and none exists today only by accident.
    for (const root of ["components", "app", "lib", "apps", "convex"]) {
      try {
        walk(root);
      } catch {
        // A root absent from this checkout is not a caller.
      }
    }

    expect([...new Set(found)].sort()).toEqual([...CALLERS].sort());
  });

  test("INV-3 org-purge deletes the commitment claim AFTER everything it protects", async () => {
    // Ordering, not behaviour — which is why it belongs here rather than in
    // SCENARIOS. The requirement was REVERSED once already: I asserted the
    // claim must be purged before its referents, and c14659 corrected it.
    //
    // `ACTIVE_DELETION_STATUSES` omits FAILED, so `unsuspendOrg` can revive an
    // organisation whose purge died mid-run. If claims were deleted first, that
    // revival leaves surviving vehicles and live deposits with NO authority
    // over them — unprotected inventory, which is a far worse hazard than an
    // inert claim pointing at a deleted vehicle (Convex has no FK enforcement,
    // so the dangling claim is merely useless).
    const { ORGANIZATION_DELETION_STEPS } = await import("./adminOrgs");
    const stepOf = (table: string) =>
      ORGANIZATION_DELETION_STEPS.findIndex((s) => String(s).includes(table));

    const claim = stepOf("vehicleCommitmentClaims");

    // ⚠️ The absence check is against the SCHEMA, not against the purge list.
    //
    // An earlier version returned early whenever the table was missing from
    // ORGANIZATION_DELETION_STEPS. That passes today — and would go on passing
    // the day the claim table ships WITHOUT being sequenced, which is precisely
    // the failure it exists to catch. A gate whose green light survives the bug
    // is not a gate.
    //
    // So: while the table is absent from the schema this is genuinely
    // not-yet-applicable; the moment it exists, it MUST appear in the sequence.
    const schemaTables = Object.keys(schema.tables);
    if (!schemaTables.includes("vehicleCommitmentClaims")) {
      expect(claim, "no claim table in the schema yet, so nothing to sequence").toBe(-1);
      return;
    }
    expect(
      claim,
      "vehicleCommitmentClaims exists but is absent from ORGANIZATION_DELETION_STEPS — an org purge would orphan it"
    ).toBeGreaterThan(-1);

    for (const protectedTable of ["vehiclesWithStorage", "deposits", "financeApplications"]) {
      expect(
        claim,
        `the claim must outlive ${protectedTable}, or an aborted-then-unsuspended purge leaves it unprotected`
      ).toBeGreaterThan(stepOf(protectedTable));
    }
  });

  test("INV-4a the contract checker itself detects each way the contract can be broken", () => {
    // ⚠️ INV-4 applies `checkDeploymentIdentityContract` to a module that does
    // not exist yet, so it is red and stays red. That makes the CHECKER
    // unexercised by INV-4 — and an unexercised checker is worth nothing the
    // day the module lands.
    //
    // So the checker is proven here against inline fixtures, one per way the
    // contract can be broken. This is the same discipline as proving the
    // contradiction preflight by injecting a contradiction: a gate nobody has
    // watched fail is not known to work.
    const compliant = `
      export const deploymentIdentity = query({
        args: {},
        returns: v.object({ cloudUrl: v.string(), disposable: v.boolean() }),
        handler: async () => ({ cloudUrl: process.env.CONVEX_CLOUD_URL, disposable: false }),
      });
    `;
    expect(checkDeploymentIdentityContract(compliant)).toEqual([]);

    // Each mutant below must be REJECTED, and rejected for its OWN reason.
    const nonEmptyArgs = compliant.replace("args: {},", "args: { orgId: v.id('organizations') },");
    expect(checkDeploymentIdentityContract(nonEmptyArgs).map((v) => v.code)).toContain(
      "ARGS_NOT_EMPTY"
    );

    const extraReturnField = compliant.replace(
      "disposable: v.boolean() }",
      "disposable: v.boolean(), deployKey: v.string() }"
    );
    expect(checkDeploymentIdentityContract(extraReturnField).map((v) => v.code)).toContain(
      "RETURN_SURFACE_NOT_EXACT"
    );

    const missingReturnField = compliant.replace(", disposable: v.boolean()", "");
    expect(checkDeploymentIdentityContract(missingReturnField).map((v) => v.code)).toContain(
      "RETURN_SURFACE_NOT_EXACT"
    );

    const noReturnValidator = compliant
      .split("\n")
      .filter((line) => !line.includes("returns:"))
      .join("\n");
    expect(checkDeploymentIdentityContract(noReturnValidator).map((v) => v.code)).toContain(
      "NO_RETURN_VALIDATOR"
    );

    const asMutation = compliant.replace("= query({", "= mutation({");
    expect(checkDeploymentIdentityContract(asMutation).map((v) => v.code)).toContain("NOT_A_QUERY");

    const alsoExportsMutation = `${compliant}\nexport const seedThing = mutation({ args: {}, handler: async () => null });`;
    expect(checkDeploymentIdentityContract(alsoExportsMutation).map((v) => v.code)).toContain(
      "MODULE_EXPORTS_MUTATION"
    );

    const absent = "// nothing here";
    expect(checkDeploymentIdentityContract(absent).map((v) => v.code)).toContain("NOT_A_QUERY");
  });

  test("INV-4 testSupport:deploymentIdentity stays a read-only identity query", async () => {
    // c14843 keeps this ONE surface under an extremely narrow contract: a
    // read-only query, exactly empty args, returning only the canonical
    // deployment identity plus a disposable boolean, with no secrets and no
    // write authority. It exists solely so the external contention harness can
    // fail closed BEFORE it performs any writes.
    //
    // The contract is checked at the SOURCE, because the harness's own use of
    // it cannot prove what the surface is allowed to do — a caller that happens
    // to pass `{}` says nothing about what the surface would accept.
    const { readFileSync, existsSync } = await import("node:fs");
    const path = "convex/testSupport.ts";
    if (!existsSync(path)) {
      // Not built yet, and this stays LOUDLY RED. Treating "module absent" as
      // not-applicable is the vacuous-pass shape removed from INV-3; the whole
      // point is that this contract gets written the day the surface is.
      expect(existsSync(path), "convex/testSupport.ts does not exist yet").toBe(true);
      return;
    }

    const violations = checkDeploymentIdentityContract(readFileSync(path, "utf8"));
    expect(
      violations,
      `deploymentIdentity breaks its c14843 contract:\n  ${violations
        .map((v) => `${v.code}: ${v.detail}`)
        .join("\n  ")}`
    ).toEqual([]);
  });
});

describe("SCRUM-195 spec — INV-5 the fail-closed deployment gate (c14843)", () => {
  /**
   * The gate exists so the external contention probe refuses to write to
   * anything but a deployment that has explicitly declared itself disposable.
   * c14843 requires BOTH negative controls and a positive one — and the
   * positive matters most: a gate that refuses everything is trivially "safe"
   * and makes the probe permanently unable to run anywhere, which would leave
   * this design with no concurrency evidence at all while every test stayed
   * green.
   *
   * These call the real gate with stub identities. That is why the harness now
   * only runs `main()` when invoked directly.
   */
  const gate = async (identity: unknown, expected = "kindly-preview-999") => {
    const { assertDeploymentIsDisposable } = await import(
      "../scripts/vehicleCommitmentContention.mjs"
    );
    const client = { query: async () => identity };
    return assertDeploymentIsDisposable(client, expected);
  };

  test("refuses a deployment that will not say which one it is", async () => {
    await expect(gate({ disposable: true })).rejects.toThrow(/will not say which one it is/i);
  });

  test("refuses a deployment other than the one named", async () => {
    await expect(
      gate({ cloudUrl: "https://production-hound-172.convex.cloud", disposable: true })
    ).rejects.toThrow(/pointed somewhere else/i);
  });

  test("refuses a correctly-named deployment that does not declare itself disposable", async () => {
    await expect(
      gate({ cloudUrl: "https://kindly-preview-999.convex.cloud", disposable: false })
    ).rejects.toThrow(/does not declare itself disposable/i);
  });

  test("refuses when the disposable flag is merely absent, not false", async () => {
    // Fail CLOSED. A missing flag is the shape a real production deployment
    // presents, since it has no reason to carry one.
    await expect(
      gate({ cloudUrl: "https://kindly-preview-999.convex.cloud" })
    ).rejects.toThrow(/does not declare itself disposable/i);
  });

  test("ACCEPTS an explicitly disposable preview that matches the named deployment", async () => {
    // The positive control. Without it every refusal above is satisfied by a
    // gate that refuses unconditionally.
    await expect(
      gate({ cloudUrl: "https://kindly-preview-999.convex.cloud", disposable: true })
    ).resolves.toBe("kindly-preview-999");
  });
});

describe("SCRUM-195 spec — declared scenarios", () => {
  test.each(SCENARIOS.map((s) => [s.id, s] as const))("%s", async (_id, scenario) => {
    const seed = await seedDealer(scenario.id.replace(/[^a-z0-9]/gi, "").slice(0, 24));
    const built = await buildWorld(seed, scenario);

    if (scenario.outcome === "ACCEPT") {
      await expect(
        invoke(seed, scenario, built),
        `${scenario.id}: ${scenario.rule}`
      ).resolves.toBeDefined();
      return;
    }

    // ⚠️ WHOLE-WORLD ZERO DELTA ON EVERY REFUSAL, not in one dedicated fixture.
    //
    // The free-form suite proved "a refused deposit writes nothing anywhere"
    // exactly once, for one operation, in one world. Every other refusal in the
    // design was free to leave a payment row, an orphaned hold, a notification
    // or a half-posted journal entry behind, and nothing would have noticed.
    //
    // Making it a property of the executor means it holds for every refusal the
    // table declares, including every refusal added later — the residue problem
    // is closed by construction rather than by remembering to test for it.
    const before = await snapshotWorld(seed);
    await expect(invoke(seed, scenario, built), `${scenario.id}: ${scenario.rule}`).rejects.toThrow(
      scenario.reason!
    );
    expect(
      await snapshotWorld(seed),
      `${scenario.id}: the refusal must leave the world untouched`
    ).toEqual(before);
  });
});

describe("SCRUM-195 spec — declared query contracts", () => {
  test.each(QUERY_CONTRACTS.map((c) => [c.id, c] as const))("%s", async (_id, contract) => {
    const seed = await seedDealer(contract.id.replace(/[^a-z0-9]/gi, "").slice(0, 24));
    // Query contracts describe a world, not an operation, so they reuse the
    // same builder — one construction path for both halves of the spec means a
    // world cannot mean one thing here and something else over there.
    const built = await buildWorld(seed, {
      id: contract.id,
      rule: contract.rule,
      world: contract.world,
      operation: "deposits.create",
      outcome: "ACCEPT",
    });

    const [, queryName] = contract.query.split(".");
    const args: Record<string, unknown> =
      contract.query === "commitments.cutoverReadiness" ||
      contract.query === "commitments.listAgedCommitments"
        ? { orgId: seed.orgId }
        : contract.query === "commitments.rootFinancialState"
          ? { orgId: seed.orgId, quoteId: built.ownQuoteId }
          : { orgId: seed.orgId, vehicleId: built.vehicleId };

    const result = (await seed.asUser.query(
      notYetBuiltQuery.commitments[queryName],
      args
    )) as Record<string, unknown>;

    for (const [key, want] of Object.entries(contract.expected)) {
      if (key === "listed") {
        // The vehicle must appear BY NAME. A non-empty list would pass while
        // containing something else entirely.
        const rows = (Array.isArray(result) ? result : (result?.items ?? [])) as {
          vehicleId?: unknown;
        }[];
        expect(
          rows.map((r) => String(r?.vehicleId)),
          `${contract.id}: ${contract.rule}`
        ).toContain(String(built.vehicleId));
        continue;
      }
      if (key === "blocked") {
        // Readiness reports WHICH vehicles block it, so "blocked" means this
        // vehicle is named — a bare boolean would pass while pointing at some
        // unrelated car.
        const ids = (result?.blockedVehicleIds ?? []) as unknown[];
        expect(ids.map(String), `${contract.id}: ${contract.rule}`).toContain(
          String(built.vehicleId)
        );
        continue;
      }
      expect(result?.[key], `${contract.id}: ${contract.rule}`).toBe(want);
    }
  });
});
