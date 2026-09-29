import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/**
 * SCRUM-444 — the ONE place that knows what a PENDING deposit request blocks.
 *
 * A request is not money, but it is a promise that a manager or accountant will
 * be asked to decide, so it may never be orphaned: every door that ends a deal
 * (or takes the deposit directly) refuses while one is waiting, and names the
 * three ways out. The doors call this instead of restating the message, so the
 * wording and the query cannot drift apart.
 */
export const PENDING_DEPOSIT_REQUEST_NEXT_STEP =
  "Ask a manager or accountant to confirm receipt, reject the request, or have the requester withdraw it.";

export async function pendingDepositRequestsForQuote(
  ctx: QueryCtx,
  quoteId: Id<"quotes">
): Promise<Array<Doc<"depositRequests">>> {
  return await ctx.db
    .query("depositRequests")
    .withIndex("by_quote_status", (q) => q.eq("quoteId", quoteId).eq("status", "PENDING"))
    .collect();
}

/**
 * Refuses while the quote carries a PENDING deposit request.
 * `action` is the operator-facing verb phrase ("cancel this application").
 */
export async function assertNoPendingDepositRequest(
  ctx: QueryCtx,
  args: { orgId: Id<"organizations">; quoteId: Id<"quotes">; action: string }
): Promise<void> {
  const pending = (await pendingDepositRequestsForQuote(ctx, args.quoteId)).filter(
    (request) => request.orgId === args.orgId
  );
  if (pending.length === 0) return;
  throw new ConvexError(
    `A deposit request is still waiting on this deal, so you cannot ${args.action} yet. ${PENDING_DEPOSIT_REQUEST_NEXT_STEP}`
  );
}

/**
 * Why a quote can no longer take a deposit, or null while it is live.
 *
 * "Terminal" is the deal having ended: the quote expired, a sale on it is
 * complete, or every finance application on it has been rejected, cancelled or
 * closed. A request can never outlive that, so neither request nor confirm is
 * accepted once it is true.
 */
export async function quoteTerminalReason(
  ctx: QueryCtx,
  quote: Doc<"quotes">
): Promise<string | null> {
  if (quote.status === "EXPIRED") return "This quote has expired.";

  const sales = await ctx.db
    .query("sales")
    .withIndex("by_quote", (q) => q.eq("quoteId", quote._id))
    .collect();
  if (sales.some((sale) => sale.orgId === quote.orgId && sale.status === "COMPLETED" && sale.isDeleted !== true)) {
    return "A sale on this quote is already complete.";
  }

  const applications = [];
  for await (const application of ctx.db
    .query("financeApplications")
    .withIndex("by_vehicle", (q) => q.eq("vehicleId", quote.vehicleId))) {
    if (application.orgId === quote.orgId && application.quoteId === quote._id) {
      applications.push(application);
    }
  }
  if (
    applications.length > 0 &&
    applications.every(
      (application) =>
        application.status === "REJECTED" ||
        application.status === "CANCELLED" ||
        application.status === "CLOSED"
    )
  ) {
    return "The finance application on this quote has already ended.";
  }
  return null;
}

/**
 * SCRUM-444 F1 — the way out named by every refusal below.
 */
export const RESERVATION_DEPOSIT_NEXT_STEP =
  "Release or resolve that reservation deposit first (vehicle, Deposits section: refund or forfeit it, or cancel the sale it was applied to), then record or request the deposit on the quote.";

/**
 * Bounds of the reservation-deposit probe. The probe FAILS CLOSED past any
 * bound (it throws) rather than reading a truncated window and concluding
 * "nothing there" — the SCRUM-444 N2 defect.
 *
 * ⚠️ EVERY BOUND IS PER QUOTE, NEVER PER CAR OR PER ORG (SCRUM-444 R3). A car's
 * commitment roots accumulate for its whole life, one terminal root per lapsed
 * hold, released reservation, refund or cancelled application, for every
 * customer that ever touched it. A bound on that range turns unrelated history
 * into a permanent dead end for every future quote on the car. The probe's read
 * set is therefore the DEAL's own records only.
 *
 *  - MAX_ROOTS_PER_QUOTE: distinct candidate roots of ONE quote's deal
 *    (`commitmentRoots.by_org_head_quote` plus the roots named by claims tagged
 *    with the quote). A deal owns one root per car, and each restoration after a
 *    sale reversal adds one successor that inherits `headQuoteId`; adoption
 *    re-heads at most one root per car. A 20-car quote restored four times is
 *    100. There is no schema cap on `quotes.vehicleItems`, so this is the
 *    "no real deal gets near it" figure, not a proven ceiling.
 *  - MAX_TAGGED_CLAIMS_PER_QUOTE: claims whose `quoteId` names the quote, in any
 *    status (`vehicleCommitmentClaims.by_org_quote`). Only `attachEpisode`
 *    (commitments.ts, the sole `vehicleCommitmentClaims` insert) stamps it: one
 *    per deposit / finance application / reservation episode the quote drives,
 *    per car. 500 is roughly 8x the busiest single root on record (60+
 *    episodes, commitmentFinalization G.13) spread over many cars.
 *  - MAX_CLAIMS_PER_ROOT: ACTIVE claims of ONE root (`by_root_status`). Claims
 *    are insert-only in production (nothing patches a claim status), so this is
 *    every episode the root ever opened; a busy deal legitimately carries 60+.
 *    500 is far above any real deal and still one bounded read.
 */
export const RESERVATION_PROBE_MAX_ROOTS_PER_QUOTE = 100;
export const RESERVATION_PROBE_MAX_TAGGED_CLAIMS_PER_QUOTE = 500;
export const RESERVATION_PROBE_MAX_CLAIMS_PER_ROOT = 500;

// Unreachable in normal operation: every bound above is per QUOTE (the deal's
// own records), far above what one deal can legitimately create. It exists so
// that a corrupt or runaway deal fails CLOSED instead of being read truncated.
const RESERVATION_PROBE_OVERFLOW_MESSAGE =
  "This quote's deal has too many deal records to confirm that no reservation deposit is holding money for it, so the deposit was not taken. Ask an administrator to review the deal's reservations.";

/**
 * A reservation whose deposit is still HELD or APPLIED, or null. This is the
 * one definition of "a reservation that is carrying money".
 */
async function liveReservationDeposit(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  reservationId: Id<"vehicleReservations"> | undefined,
  claimDepositId: Id<"deposits"> | undefined
): Promise<Doc<"deposits"> | null> {
  const reservation = reservationId ? await ctx.db.get(reservationId) : null;
  if (reservation && reservation.orgId !== orgId) return null;
  for (const depositId of [reservation?.depositId, claimDepositId]) {
    if (!depositId) continue;
    const deposit = await ctx.db.get(depositId);
    if (!deposit || deposit.orgId !== orgId || deposit.isDeleted === true) continue;
    if (deposit.status === "HELD" || deposit.status === "APPLIED") return deposit;
  }
  return null;
}

/**
 * A reservation that was taken WITH a deposit and belongs to this quote's deal
 * is a receipt the quote's own arithmetic cannot see: `deposits.by_quote` never
 * lists it, so the cap and the pending-request guard both read "nothing paid".
 * Every door that would receive more money against the quote fails CLOSED while
 * one is live.
 *
 * ⚠️ ROOT-BASED, NOT TAG-BASED. A reservation joins a quote's deal in more ways
 * than carrying the quote id on its claim — `dealDepositId`, adoption after the
 * fact, historical rows — and the claim tag is only written by some of them.
 * What every one of them has in common is the commitment ROOT, so the probe
 * treats a root as this deal's when `headQuoteId` names the quote (a claim
 * tagged with the quote counts too).
 *
 * ⚠️ SCOPED TO THE DEAL, NEVER THE CAR (SCRUM-444 R3). The candidate roots are
 * exactly (roots whose `headQuoteId` is the quote) ∪ (the root of every claim
 * tagged with the quote). Nothing reads `by_org_vehicle_status`: a car's
 * finished deals belong to other quotes and must never block this one.
 *
 * Indexes: `commitmentRoots.by_org_head_quote`, `vehicleCommitmentClaims
 * .by_org_quote`, then `vehicleCommitmentClaims.by_root_status` (ACTIVE) per
 * candidate root; bounds above, all per quote.
 */
export async function assertNoQuoteLinkedReservationDeposit(
  ctx: QueryCtx,
  quote: Doc<"quotes">
): Promise<void> {
  const headed = await ctx.db
    .query("commitmentRoots")
    .withIndex("by_org_head_quote", (q) =>
      q.eq("orgId", quote.orgId).eq("headQuoteId", quote._id)
    )
    .take(RESERVATION_PROBE_MAX_ROOTS_PER_QUOTE + 1);
  const tagged = await ctx.db
    .query("vehicleCommitmentClaims")
    .withIndex("by_org_quote", (q) => q.eq("orgId", quote.orgId).eq("quoteId", quote._id))
    .take(RESERVATION_PROBE_MAX_TAGGED_CLAIMS_PER_QUOTE + 1);
  if (
    headed.length > RESERVATION_PROBE_MAX_ROOTS_PER_QUOTE ||
    tagged.length > RESERVATION_PROBE_MAX_TAGGED_CLAIMS_PER_QUOTE
  ) {
    throw new ConvexError(RESERVATION_PROBE_OVERFLOW_MESSAGE);
  }

  const candidateRootIds = new Set<Id<"commitmentRoots">>([
    ...headed.map((root) => root._id),
    ...tagged.map((claim) => claim.rootId),
  ]);
  if (candidateRootIds.size > RESERVATION_PROBE_MAX_ROOTS_PER_QUOTE) {
    throw new ConvexError(RESERVATION_PROBE_OVERFLOW_MESSAGE);
  }
  const headedRootIds = new Set<Id<"commitmentRoots">>(headed.map((root) => root._id));

  for (const rootId of candidateRootIds) {
    const claims = await ctx.db
      .query("vehicleCommitmentClaims")
      .withIndex("by_root_status", (q) => q.eq("rootId", rootId).eq("status", "ACTIVE"))
      .take(RESERVATION_PROBE_MAX_CLAIMS_PER_ROOT + 1);
    if (claims.length > RESERVATION_PROBE_MAX_CLAIMS_PER_ROOT) {
      throw new ConvexError(RESERVATION_PROBE_OVERFLOW_MESSAGE);
    }
    const rootIsThisDeal = headedRootIds.has(rootId);
    for (const claim of claims) {
      if (claim.evidenceKind !== "RESERVATION" || claim.orgId !== quote.orgId) continue;
      if (!rootIsThisDeal && claim.quoteId !== quote._id) continue;
      const deposit = await liveReservationDeposit(
        ctx,
        quote.orgId,
        claim.reservationId,
        claim.depositId
      );
      // A deposit already recorded ON this quote is visible to `by_quote`.
      if (!deposit || deposit.quoteId === quote._id) continue;
      throw new ConvexError(
        `A reservation deposit taken on this deal's vehicle is already holding money for it, and this quote cannot see it. ${RESERVATION_DEPOSIT_NEXT_STEP}`
      );
    }
  }
}
/**
 * SCRUM-444 R-B — adoption of a FUNDED reservation is refused.
 *
 * Adopting a reservation re-heads its deal onto the quote but leaves its money
 * where it was: a `deposits` row with no quote, invisible to the quote's cap and
 * to `activeQuoteDepositMinor`. So a second receipt could post on top. The
 * operator releases the reservation deposit (refund or forfeit) and then takes
 * the money through the quote's own deposit flow. Deposit-free adoption is
 * unchanged.
 */
export async function assertReservationAdoptableWithoutDeposit(
  ctx: QueryCtx,
  args: { orgId: Id<"organizations">; reservationId: Id<"vehicleReservations"> }
): Promise<void> {
  const deposit = await liveReservationDeposit(ctx, args.orgId, args.reservationId, undefined);
  if (!deposit) return;
  throw new ConvexError(
    `This reservation already holds a deposit, so it cannot be continued into a quote or an application. ${RESERVATION_DEPOSIT_NEXT_STEP}`
  );
}