/**
 * SCRUM-208 — THE PHASE-3 AUTHORITY KERNEL.
 *
 * Phase 2 answered "who holds this car". Phase 3 has to answer it again after
 * a sale is reversed, a deposit is reinstated, or a deal is restored — and the
 * first four design rounds established that the hard part is not the lifecycle
 * but the *preconditions* every lifecycle path shares. Four consecutive rounds
 * of review found the same class of defect through a different door each time:
 * a rule pinned on one path and missing from the adjacent one.
 *
 * So the preconditions live HERE, once, structurally.
 *
 * ## The four things this module owns
 *
 * **1. WHICH AUTHORITY AN ORG RUNS ON.** Canonical-state admission is one
 * per-org rule (`organizations.commitmentAuthorityVersion`), not per-field
 * `undefined` semantics reinvented on every new column. Round 4 killed a
 * design that added optional indexed flags and read a missing value as
 * `false` — which is a false negative across the ENTIRE pre-existing dataset,
 * and which literally implements the mutant the contract packet says must die.
 *
 * **2. WHO IS ASKING, AND WHEN.** One clock reading per decision, server-owned.
 * A caller may express intent and identify business objects; it may never
 * supply the clock, the root, the lineage tip, the principal, liveness, or the
 * representation class. Round 4's `decisionNow` finding was exactly this gap:
 * the comparison operator was pinned and the clock's provenance was not, so a
 * far-future timestamp from a caller made every finite live reservation vanish
 * from its range.
 *
 * **3. WHOSE EVIDENCE IT IS.** `PrincipalBoundEvidence` carries the principal
 * with the evidence, so principal consistency is asserted once by construction
 * instead of by a check each path has to remember. Round 3 found a successor
 * root could take another customer's principal; round 4 found the same class
 * on the ATTACH path, because the fix had been pinned to succession.
 *
 * **4. EXACT LIVENESS, IN THE RANGE.** A predicate that authorizes must be
 * exact. `.first()` / `.take(n)` is legal ONLY when every row in the range is
 * BY CONSTRUCTION a live basis. Fetching candidates and post-filtering is
 * prohibited: a page filled with stale rows hides the live one behind them and
 * the caller reads "nothing holds this car" from a bounded page rather than
 * from the data. That is not hypothetical — it is the shipped defect in
 * `getActiveDepositHolds`, which is why that reader is a comparator during
 * cutover and never the oracle.
 *
 * ## What this module deliberately does NOT own
 *
 * "Does another customer own this car" is NOT answered here. Ownership belongs
 * to the root/principal model — `resolveOwnership` / `resolveActingRoot` in
 * `commitments.ts` — and adding a fourth deposit-shaped predicate for it would
 * re-scatter the question this kernel exists to centralize (owner ruling
 * c15785).
 *
 * Reporting is not authority. `listActiveDepositsForVehicle` exists for
 * callers that genuinely need the whole list (summing amounts, deriving a
 * customer for an order); it may enumerate and it may paginate. Nothing that
 * grants or refuses authority may call it.
 */

import { ConvexError } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Canonical-state admission.
// ─────────────────────────────────────────────────────────────────────────────

/** The only canonical authority version this build knows how to run. */
export const COMMITMENT_AUTHORITY_V1 = 1;

export type AuthorityVersion = "LEGACY" | "V1";

/**
 * Why authority could not be established for an organization.
 *
 * A typed reason rather than a thrown error, because the caller decides
 * whether that is fatal. For a user-facing mutation it is; for a cross-tenant
 * sweep it must not be — see `beginSystemRun`.
 */
export type AuthorityWithheldReason =
  | "ORGANIZATION_NOT_FOUND"
  | "UNSUPPORTED_AUTHORITY_VERSION";

/**
 * Admit an organization's stored version, or refuse it.
 *
 * ⚠️ AN UNKNOWN VERSION IS REFUSED, NEVER CLAMPED. "A number I do not
 * recognize, so treat it as the newest I know" is how a half-deployed backend
 * grants itself authority it was never activated for: the org is flipped to a
 * version whose code has not shipped yet, and the old build silently accepts
 * it as V1. Refusing keeps a partial deploy loud.
 */
export function admitAuthorityVersion(
  raw: number | undefined
): { ok: true; version: AuthorityVersion } | { ok: false; reason: AuthorityWithheldReason } {
  if (raw === undefined || raw === 0) return { ok: true, version: "LEGACY" };
  if (raw === COMMITMENT_AUTHORITY_V1) return { ok: true, version: "V1" };
  return { ok: false, reason: "UNSUPPORTED_AUTHORITY_VERSION" };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Run and decision contexts.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Who an authority decision is being made by.
 *
 * ⚠️ SYSTEM IS NOT "A USER WE COULD NOT IDENTIFY". A sweep has no
 * authenticated user, no single tenant, and no customer standing in front of
 * it. Modelling it as an optional `actorId` would let a path that requires a
 * real actor pass `undefined` and keep going.
 */
export type AuthorityActor =
  | { kind: "USER"; userId: Id<"users"> }
  | { kind: "SYSTEM"; source: string };

/**
 * One clock reading for one execution of one registered function.
 *
 * A cross-tenant sweep creates ONE of these and then derives one
 * `AuthorityDecisionContext` per row, so every tenant it touches is judged
 * against the same instant.
 */
export type AuthorityRunContext = {
  /**
   * ⚠️ THE ONE CLOCK READING, taken before anything is consulted. Reading the
   * clock separately in each branch would let one call a proof live and the
   * next call it expired a millisecond later.
   */
  readonly now: number;
  readonly actor: AuthorityActor;
};

/** One tenant's authority state, bound to one run. */
export type AuthorityDecisionContext = {
  readonly orgId: Id<"organizations">;
  readonly authorityVersion: AuthorityVersion;
  readonly now: number;
  readonly actor: AuthorityActor;
};

export type DecisionContextResult =
  | { kind: "READY"; decision: AuthorityDecisionContext }
  | { kind: "WITHHELD"; orgId: Id<"organizations">; reason: AuthorityWithheldReason };

/** A user-initiated run. `now` is captured by the caller, once, up front. */
export function beginUserRun(userId: Id<"users">, now: number): AuthorityRunContext {
  return { now, actor: { kind: "USER", userId } };
}

/**
 * A server-initiated run — a cron sweep, a scheduled reconciliation.
 *
 * `source` names the function, for diagnosis. It is never an identity and
 * nothing may make an authorization decision on its text.
 */
export function beginSystemRun(source: string, now: number): AuthorityRunContext {
  return { now, actor: { kind: "SYSTEM", source } };
}

/**
 * Derive one tenant's decision context, WITHOUT throwing.
 *
 * ⚠️ THIS IS THE SHAPE A CROSS-TENANT SWEEP NEEDS. One Convex mutation is one
 * transaction, so a throw on the last row un-does every earlier row —
 * belonging to other people's dealerships — and because the offending row
 * never reaches its terminal state, the next sweep selects it again. One
 * corrupt org would starve the sweep for everyone, permanently. The expiry
 * sweep already learned this the hard way and decides its AMBIGUOUS case per
 * row instead of throwing; version admission gets the same treatment.
 *
 * Mixed versions within one batch are NORMAL, not an error: activation is per
 * org, so a sweep legitimately meets legacy and canonical organizations side
 * by side.
 */
export async function tryDecisionContext(
  ctx: QueryCtx | MutationCtx,
  run: AuthorityRunContext,
  orgId: Id<"organizations">
): Promise<DecisionContextResult> {
  const org = await ctx.db.get(orgId);
  if (!org) return { kind: "WITHHELD", orgId, reason: "ORGANIZATION_NOT_FOUND" };

  const admitted = admitAuthorityVersion(org.commitmentAuthorityVersion);
  if (!admitted.ok) return { kind: "WITHHELD", orgId, reason: admitted.reason };

  return {
    kind: "READY",
    decision: {
      orgId,
      authorityVersion: admitted.version,
      now: run.now,
      actor: run.actor,
    },
  };
}

/**
 * Derive one tenant's decision context for a single-tenant operation, refusing
 * outright when authority cannot be established.
 *
 * The right shape for a registered mutation acting on one organization, where
 * there is no other tenant's work in the transaction to protect.
 */
export async function requireDecisionContext(
  ctx: QueryCtx | MutationCtx,
  run: AuthorityRunContext,
  orgId: Id<"organizations">
): Promise<AuthorityDecisionContext> {
  const result = await tryDecisionContext(ctx, run, orgId);
  if (result.kind === "WITHHELD") {
    throw new ConvexError(
      result.reason === "ORGANIZATION_NOT_FOUND"
        ? "This dealership could not be found."
        : "This dealership is configured for a commitment authority this server does not support. No commitment change was made."
    );
  }
  return result.decision;
}

/**
 * Guard for a path that only exists under the canonical authority.
 *
 * ⚠️ THE REFUSAL IS THE POINT. A legacy org reaching a canonical-only path is
 * a routing bug, and the safe answer is to stop rather than to fall back —
 * a fallback would answer a canonical question with legacy data and report it
 * as canonical.
 */
export function requireCanonicalAuthority(
  decision: AuthorityDecisionContext
): void {
  if (decision.authorityVersion !== "V1") {
    throw new ConvexError(
      "This action needs the canonical commitment authority, which is not enabled for this dealership yet."
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Principal-bound evidence.
// ─────────────────────────────────────────────────────────────────────────────

export type CommitmentEvidenceKind = "DEPOSIT" | "FINANCE" | "RESERVATION";

/** The defining reference, tagged so it is never re-derived from what is set. */
export type CommitmentEvidenceRef =
  | { kind: "DEPOSIT"; depositId: Id<"deposits"> }
  | { kind: "FINANCE"; applicationId: Id<"financeApplications"> }
  | { kind: "RESERVATION"; reservationId: Id<"vehicleReservations"> };

/**
 * Where this evidence stands relative to the claim lineage.
 *
 * ⚠️ THIS HAD TO BE A DISCRIMINATED UNION, NOT OPTIONAL FIELDS. A shape that
 * always required `claimId` + `lineageRootId` cannot express first
 * acquisition at all: the acquisition path opens the ROOT and only then
 * attaches the episode, so at the moment the evidence is resolved neither id
 * exists yet. Optional fields would have expressed it — and would also have
 * let a restoration path run with both absent, which is precisely the
 * provenance loss this models against.
 */
export type EvidenceEpisode =
  /** No episode yet. First acquisition, before any root or claim exists. */
  | { state: "NEW" }
  /** The live episode this evidence currently holds its car through. */
  | {
      state: "CURRENT";
      claimId: Id<"vehicleCommitmentClaims">;
      lineageRootId: Id<"commitmentRoots">;
      lineageGeneration: number;
    }
  /**
   * Present and principal-bearing, but contributing NO claim transition.
   *
   * A reservation's own deposit on the deal's other car, for one: it proves
   * who the participant is, and it must not be terminalized by an operation
   * whose defining evidence is the reservation.
   */
  | { state: "CONTEXTUAL_ONLY" };

/**
 * Evidence that has already been proven to belong to a specific principal on a
 * specific car in a specific tenant.
 *
 * ⚠️ A CLAIM POINTER ALONE AUTHORIZES NOTHING. Explicit evidence SELECTS a
 * root; it does not entitle whoever presents it to act on that root. A quote,
 * a deposit or a reservation belonging to somebody else is still a real row,
 * and every check that asks "is this evidence genuine" says yes.
 *
 * ⚠️ A RESOLVER THAT CANNOT POPULATE THIS REFUSES. It never returns a partial
 * object for a later stage to complete — that is how a missing principal
 * becomes an implicit one.
 */
export type PrincipalBoundEvidence = {
  readonly orgId: Id<"organizations">;
  readonly vehicleId: Id<"vehicles">;
  /** The principal this evidence PROVES, read from the evidence row itself. */
  readonly customerId: Id<"customers">;
  readonly evidenceKind: CommitmentEvidenceKind;
  readonly evidenceRef: CommitmentEvidenceRef;
  readonly episode: EvidenceEpisode;
};

/**
 * Operations that may only act on an episode that actually exists.
 *
 * ⚠️ `NEW` MAY NEVER SUBSTITUTE FOR MISSING PROVENANCE. The mutant this kills:
 * a restoration path accepts `NEW`, finds no predecessor, and opens a fresh
 * root — silently discarding the chain back to what was reversed, and
 * producing a root that looks legitimate to every subsequent check.
 */
export function requireCurrentEpisode(
  evidence: PrincipalBoundEvidence,
  operation: "RESTORE" | "TERMINALIZE" | "SUCCEED"
): Extract<EvidenceEpisode, { state: "CURRENT" }> {
  if (evidence.episode.state !== "CURRENT") {
    throw new ConvexError(
      `This ${evidence.evidenceKind.toLowerCase()} has no live commitment episode to ${operation.toLowerCase()}, so the change was refused rather than opening a new one.`
    );
  }
  return evidence.episode;
}

/**
 * The principal check, in ONE place, for every path.
 *
 * Round 3 found a successor root could adopt another customer's principal;
 * round 4 found the identical defect on the attach path, because the round-3
 * fix had been pinned to succession rather than stated as an invariant. Every
 * path that attaches, restores, terminalizes, succeeds or adopts calls this.
 */
export function assertPrincipalMatches(
  evidence: PrincipalBoundEvidence,
  rootPrincipal: Id<"customers">
): void {
  if (String(evidence.customerId) !== String(rootPrincipal)) {
    throw new ConvexError(
      "That deposit, reservation or application belongs to a different customer, so it cannot be used on this deal."
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Exact liveness — canonical access paths.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A canonical row that contradicts what its range promised.
 *
 * ⚠️ REFUSE, NEVER FILTER. Post-activation, a `holdActive: true` row on a
 * VOIDED or deleted deposit is corruption. Skipping it would make the
 * corruption invisible and answer "nothing holds this car" — freeing a vehicle
 * somebody has paid to hold. Refusing is what makes a plain index range exact
 * without keeping a second, independently mutable copy of liveness in sync.
 */
function refuseContradiction(what: string): never {
  throw new ConvexError(
    `This vehicle's hold records disagree with each other (${what}), so no commitment decision was made. Please have this corrected before continuing.`
  );
}

/**
 * Does anything hold this car through a DEPOSIT, under the canonical
 * authority?
 *
 * Two exact ranges, one per representation, neither post-filtered:
 *
 *   DIRECT — `(org, vehicle, usesVehicleHoldRows: false, holdActive: true)`
 *   SLICED — `(org, vehicle, active: true)` on the hold rows
 *
 * Every row in either range is by construction a live basis, which is what
 * makes `.first()` legal here and illegal in the legacy reader.
 */
export async function hasCanonicalDepositHold(
  ctx: QueryCtx | MutationCtx,
  decision: AuthorityDecisionContext,
  vehicleId: Id<"vehicles">
): Promise<boolean> {
  requireCanonicalAuthority(decision);

  const direct = await ctx.db
    .query("deposits")
    .withIndex("by_org_vehicle_direct_hold", (q) =>
      q
        .eq("orgId", decision.orgId)
        .eq("vehicleId", vehicleId)
        .eq("usesVehicleHoldRows", false)
        .eq("holdActive", true)
    )
    .first();
  if (direct) {
    if (direct.status !== "HELD" || direct.isDeleted === true) {
      refuseContradiction("a deposit still holds a car after being voided or deleted");
    }
    return true;
  }

  const slice = await ctx.db
    .query("depositVehicleHolds")
    .withIndex("by_org_vehicle_active", (q) =>
      q.eq("orgId", decision.orgId).eq("vehicleId", vehicleId).eq("active", true)
    )
    .first();
  if (slice) {
    const parent = await ctx.db.get(slice.depositId);
    if (!parent || parent.orgId !== decision.orgId) {
      refuseContradiction("a live hold points at a deposit in another dealership");
    }
    if (parent.usesVehicleHoldRows !== true) {
      refuseContradiction("a deposit carries hold rows but is not recorded as using them");
    }
    if (parent.status !== "HELD" || parent.isDeleted === true) {
      refuseContradiction("a deposit still holds a car after being voided or deleted");
    }
    return true;
  }

  return false;
}

/**
 * Is there a live RESERVATION on this car, under the canonical authority?
 *
 * ⚠️ TWO RANGES, BECAUSE `expiresAt` IS OPTIONAL. An absent expiry is a
 * legitimate "never expires" and can never satisfy a `>` comparison, so
 * folding both into one range would silently drop every non-expiring
 * reservation. And the range expresses LIVE before anything is taken: loading
 * ACTIVE rows and testing expiry afterwards lets a backlog of expired-but-
 * unswept rows hide the live one behind them.
 */
export async function hasCanonicalReservationHold(
  ctx: QueryCtx | MutationCtx,
  decision: AuthorityDecisionContext,
  vehicleId: Id<"vehicles">
): Promise<boolean> {
  requireCanonicalAuthority(decision);

  const neverExpires = await ctx.db
    .query("vehicleReservations")
    .withIndex("by_org_vehicle_status_expiresAt", (q) =>
      q
        .eq("orgId", decision.orgId)
        .eq("vehicleId", vehicleId)
        .eq("status", "ACTIVE")
        .eq("expiresAt", undefined)
    )
    .first();
  if (neverExpires) return true;

  const stillLive = await ctx.db
    .query("vehicleReservations")
    .withIndex("by_org_vehicle_status_expiresAt", (q) =>
      q
        .eq("orgId", decision.orgId)
        .eq("vehicleId", vehicleId)
        .eq("status", "ACTIVE")
        .gt("expiresAt", decision.now)
    )
    .first();
  return stillLive !== null;
}

/**
 * Every live deposit holding this car, as a LIST.
 *
 * ⚠️ REPORTING ONLY. Nothing that grants or refuses authority may call this.
 * It exists because some callers genuinely need the whole set — summing held
 * amounts, deriving the customer an order was sourced for — and a boolean
 * cannot serve them. Enumeration is allowed to be bounded; authority is not,
 * which is exactly why they are different functions.
 */
export async function listActiveDepositsForVehicle(
  ctx: QueryCtx | MutationCtx,
  decision: AuthorityDecisionContext,
  vehicleId: Id<"vehicles">
): Promise<Doc<"deposits">[]> {
  requireCanonicalAuthority(decision);

  const byId = new Map<string, Doc<"deposits">>();

  for await (const deposit of ctx.db
    .query("deposits")
    .withIndex("by_org_vehicle_direct_hold", (q) =>
      q
        .eq("orgId", decision.orgId)
        .eq("vehicleId", vehicleId)
        .eq("usesVehicleHoldRows", false)
        .eq("holdActive", true)
    )) {
    byId.set(String(deposit._id), deposit);
  }

  for await (const hold of ctx.db
    .query("depositVehicleHolds")
    .withIndex("by_org_vehicle_active", (q) =>
      q.eq("orgId", decision.orgId).eq("vehicleId", vehicleId).eq("active", true)
    )) {
    const parent = await ctx.db.get(hold.depositId);
    if (!parent || parent.orgId !== decision.orgId) continue;
    byId.set(String(parent._id), parent);
  }

  return Array.from(byId.values());
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Lineage tip resolution.
// ─────────────────────────────────────────────────────────────────────────────

export type LineageTip =
  | { kind: "TIP"; root: Doc<"commitmentRoots">; isOpen: boolean }
  | { kind: "CORRUPT"; reason: string };

/**
 * The current root of a lineage — MAX-GENERATION-FIRST.
 *
 * ```
 * 1. highest generation  -> by_org_lineage_generation, descending, take(2)
 *                           two rows at the same generation => corruption
 * 2. candidate tip       := that row
 * 3. cross-check OPEN    -> by_org_lineage_status, status=OPEN, take(2)
 *                           two OPEN                     => corruption
 *                           one OPEN that is not the tip => corruption
 *                           zero OPEN                    => tip is terminal
 * ```
 *
 * ⚠️ NOT "FIND THE OPEN ROOT AND TRUST IT". Round 4 found that a live-first
 * probe returns as soon as it sees exactly one OPEN root, and never discovers
 * that a LATER generation exists in a terminal state. A lineage holding
 * `R1(gen 1, OPEN)` and `R2(gen 2, CONSUMED)` has exactly one OPEN root and no
 * duplicate generation, so every check passes — and dormant evidence then
 * attaches behind R2, regressing authority to an older generation.
 *
 * Establishing the maximum FIRST means the OPEN set can only ever confirm or
 * contradict it, never quietly substitute for it.
 *
 * ⚠️ THIS VALIDATES THE CLAIMED TIP; IT DOES NOT AUDIT HISTORY. Duplicate
 * generations further back are repair debt, and authority never walks history
 * looking for them — a read that grows with the deal's age is the thing this
 * design exists to avoid.
 */
export async function resolveLineageTip(
  ctx: QueryCtx | MutationCtx,
  decision: AuthorityDecisionContext,
  lineageRootId: Id<"commitmentRoots">
): Promise<LineageTip> {
  requireCanonicalAuthority(decision);

  const highest = await ctx.db
    .query("commitmentRoots")
    .withIndex("by_org_lineage_generation", (q) =>
      q.eq("orgId", decision.orgId).eq("lineageRootId", lineageRootId)
    )
    .order("desc")
    .take(2);

  if (highest.length === 0) {
    return { kind: "CORRUPT", reason: "lineage has no roots" };
  }
  const candidate = highest[0];
  // ⚠️ A CANONICAL LINEAGE ROW WITHOUT A GENERATION IS LEGACY, AND LEGACY FAILS
  // CLOSED. It is never normalized to 0 — that would manufacture an origin for
  // a row that never had one, and two such rows would then both claim to be
  // the origin of the same lineage.
  if (candidate.lineageGeneration === undefined) {
    return { kind: "CORRUPT", reason: "the lineage tip carries no generation" };
  }
  if (highest.length === 2 && highest[1].lineageGeneration === candidate.lineageGeneration) {
    return { kind: "CORRUPT", reason: "two roots share the lineage's highest generation" };
  }

  const open = await ctx.db
    .query("commitmentRoots")
    .withIndex("by_org_lineage_status", (q) =>
      q.eq("orgId", decision.orgId).eq("lineageRootId", lineageRootId).eq("status", "OPEN")
    )
    .take(2);

  if (open.length > 1) {
    return { kind: "CORRUPT", reason: "a lineage holds more than one OPEN root" };
  }
  if (open.length === 1 && String(open[0]._id) !== String(candidate._id)) {
    return {
      kind: "CORRUPT",
      reason: "an OPEN root sits below a later terminal generation",
    };
  }

  return { kind: "TIP", root: candidate, isOpen: open.length === 1 };
}
