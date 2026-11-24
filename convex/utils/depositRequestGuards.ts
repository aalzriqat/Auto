import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { activeDealUnwindFor } from "./dealUnwindGuard";
import { dealSettlesDirect } from "./financedSaleRecognition";
import {
  MAX_QUOTE_DEPOSITS,
  readFirstPaymentEvidence,
  readPostedQuoteDepositMinor,
} from "./firstPaymentEvidence";
import { resolveDealCurrency } from "./settlementDeductions";
import { AppErrorCode, throwAppError } from "./errors";

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
  args: { orgId: Id<"organizations">; quoteId: Id<"quotes">; action: string; localized?: true }
): Promise<void> {
  const pending = (await pendingDepositRequestsForQuote(ctx, args.quoteId)).filter(
    (request) => request.orgId === args.orgId
  );
  if (pending.length === 0) return;
  if (args.localized) {
    throwAppError(
      AppErrorCode.DEPOSIT_REQUEST_WAITING,
      `A deposit request is still waiting on this deal. ${PENDING_DEPOSIT_REQUEST_NEXT_STEP}`,
    );
  }
  throw new ConvexError(
    `A deposit request is still waiting on this deal, so you cannot ${args.action} yet. ${PENDING_DEPOSIT_REQUEST_NEXT_STEP}`
  );
}

/**
 * The active application whose terms bind this receipt, or the reason intake
 * cannot proceed. Direct recording, request and confirmation share this check.
 */
export async function readQuoteDepositIntake(
  ctx: QueryCtx,
  quote: Doc<"quotes">
): Promise<{ reason: string; code?: AppErrorCode } | { application: Doc<"financeApplications"> | undefined }> {
  if (quote.supersededAt !== undefined) return { reason: "This quote was replaced on its existing deal." };
  if (quote.status === "EXPIRED") return { reason: "This quote has expired." };

  const sales = await ctx.db
    .query("sales")
    .withIndex("by_quote", (q) => q.eq("quoteId", quote._id))
    .take(MAX_QUOTE_DEPOSITS + 1);
  if (sales.some((sale) => sale.orgId === quote.orgId && sale.status === "COMPLETED" && sale.isDeleted !== true)) {
    return { reason: "A sale on this quote is already complete." };
  }

  const applications = await ctx.db
    .query("financeApplications")
    .withIndex("by_org_quote", (q) => q.eq("orgId", quote.orgId).eq("quoteId", quote._id))
    .take(MAX_QUOTE_DEPOSITS + 1);
  if (sales.length > MAX_QUOTE_DEPOSITS || applications.length > MAX_QUOTE_DEPOSITS) {
    return { reason: "The quote's active deal could not be verified.", code: AppErrorCode.DEPOSIT_DEAL_UNVERIFIED };
  }
  let openApplication: Doc<"financeApplications"> | undefined;
  for (const application of applications) {
    if (application.finalizedSaleId !== undefined || application.status === "CLOSED" ||
      application.status === "REJECTED" || application.status === "CANCELLED") continue;
    if (openApplication || application.customerId !== quote.customerId || application.vehicleId !== quote.vehicleId) {
      return { reason: "The quote's active deal could not be verified.", code: AppErrorCode.DEPOSIT_DEAL_UNVERIFIED };
    }
    openApplication = application;
  }
  if (!openApplication) {
    return applications.length > 0
      ? { reason: "The finance application on this quote has already ended." }
      : { application: undefined };
  }
  if (openApplication.vehicleHandoverAt !== undefined) {
    return { reason: "Vehicle handover has already been recorded on this deal.", code: AppErrorCode.DEPOSIT_DEAL_HANDED_OVER };
  }
  if (openApplication.pendingIdentityCorrectionId !== undefined ||
    openApplication.pendingLenderCorrectionId !== undefined ||
    openApplication.pendingFirstPaymentEvidenceCorrectionId !== undefined ||
    await activeDealUnwindFor(ctx, quote.orgId, openApplication._id)) {
    return {
      reason: "Resolve the active deal correction or unwind before taking another deposit.",
      code: AppErrorCode.DEPOSIT_DEAL_CORRECTION_ACTIVE,
    };
  }
  return { application: openApplication };
}

export async function readQuoteDepositHistoryForIntake(
  ctx: QueryCtx,
  quoteId: Id<"quotes">,
  newReceiptCount = 1,
  usesFinanceProofBudget = true,
): Promise<Doc<"deposits">[]> {
  const rows = ctx.db
    .query("deposits")
    .withIndex("by_quote", (q) => q.eq("quoteId", quoteId));
  // Cash and multi-vehicle allocations do not use the financed proof reader's
  // single-vehicle receipt budget.
  if (!usesFinanceProofBudget) return await rows.collect();
  const depositRows = await rows.take(MAX_QUOTE_DEPOSITS + 1);
  if (depositRows.length + newReceiptCount > MAX_QUOTE_DEPOSITS) {
    throwAppError(
      AppErrorCode.DEPOSIT_RECEIPT_HISTORY_LIMIT,
      "An accountant must review the deal's deposit history before another receipt can be recorded.",
    );
  }
  return depositRows;
}

export function quoteUsesFinanceProofBudget(quote: Doc<"quotes">): boolean {
  return quote.mode !== "CASH" && (quote.vehicleItems?.length ?? 1) <= 1;
}

/** Keep dealer receipts and direct lender evidence within the same agreement. */
export async function assertQuoteFirstPaymentCapacity(
  ctx: QueryCtx,
  application: Doc<"financeApplications"> | undefined,
  currency: string,
  additionalMinor: number,
  depositRows: readonly Doc<"deposits">[],
): Promise<void> {
  if (!application) return;
  const dealCurrency = await resolveDealCurrency(ctx, application, "recording a deposit");
  if (currency !== dealCurrency) {
    throwAppError(AppErrorCode.DEPOSIT_DEAL_CURRENCY, "The deposit currency must match the deal currency.");
  }
  // Early deposits and older terms use the existing quote ceiling. Verified
  // first-payment terms bind every later receipt or pending request.
  if (application.status !== "APPROVED" ||
    application.customerFirstPaymentMinor === undefined ||
    application.submittedQuotationMinor === undefined ||
    application.approvedDealerPurchaseAmountMinor === undefined) return;
  const settlesDirect = await dealSettlesDirect(ctx, application);
  const now = Date.now();
  const proof = await readFirstPaymentEvidence(ctx, application, {
    settlesDirect, currency, now, depositRows,
  });
  let availableMinor: number | null;
  if (proof.status === "NOT_APPLICABLE") {
    // Supplier-direct and other deals without lender evidence still have
    // dealership receipts bounded by the recorded first payment.
    const heldMinor = await readPostedQuoteDepositMinor(ctx, application, depositRows, currency, now);
    availableMinor = heldMinor === null ? null : application.customerFirstPaymentMinor - heldMinor;
  } else {
    availableMinor = proof.status === "BLOCKED" || proof.status === "READY"
      ? proof.requiredMinor - proof.heldMinor - proof.directMinor
      : null;
  }
  if (availableMinor === null || !Number.isSafeInteger(availableMinor) || additionalMinor > availableMinor) {
    throwAppError(
      AppErrorCode.DEPOSIT_FIRST_PAYMENT_BALANCE,
      "Verify the first-payment balance before receiving or requesting another deposit.",
    );
  }
}

/**
 * SCRUM-444 F1 — the way out named by every refusal below.
 */
export const RESERVATION_DEPOSIT_NEXT_STEP =
  "Release or resolve that reservation deposit first (vehicle, Deposits section: refund or forfeit it, or cancel the sale it was applied to), then record or request the deposit on the quote.";

/**
 * Bounds of the reservation-deposit probe. The probe FAILS CLOSED past either
 * bound (it throws) rather than reading a truncated window and concluding
 * "nothing there" — the SCRUM-444 N2 defect.
 *
 * ⚠️ THE PROBE'S COST IS A FUNCTION OF ONE QUOTE'S RESERVATIONS, NOTHING ELSE.
 * A car's roots accumulate for its whole life, and a quote's own deal can carry
 * any number of cars, restoration successors, deposits and episodes. None of
 * those is read. The two loops below step through DISTINCT values with a
 * `.gt(<last>).first()` seek, so a thousand roots that share one origin, or a
 * thousand claims that share one deposit, cost one seek. There is no per-root
 * loop, no per-claim loop and no `.collect()` / `.take()` window anywhere.
 *
 *  - MAX_ORIGINS_PER_QUOTE (Branch H): distinct `originReservationId` values
 *    across every root headed at the quote, in any root status. A deal opens a
 *    root with an origin only when a RESERVATION starts it (`dealQuoteId` /
 *    adoption re-heading); ordinary quote deposits open roots with none, which
 *    the seek steps over. A quote reserved and released 100 times is already
 *    far past any real deal.
 *  - MAX_FUNDED_TAGGED_PER_QUOTE (Branch T): distinct deposits named by
 *    RESERVATION claims tagged with the quote. Only a FUNDED reservation stamps
 *    a `depositId` on its claim, and `createReservation` refuses a deposit on a
 *    reservation that has deal lineage, so this is only the historical shape
 *    (rows written before that refusal). 50 is far above any real quote.
 *
 * Database calls per probe (each `.first()` is one range, each `db.get` one
 * call): Branch H is at most 100 x (1 seek + 1 reservation get + 1 deposit get)
 * = 300; Branch T is at most 50 x (1 seek + 1 reservation get + 2 deposit gets)
 * = 200 (a reservation is read once however many branches reach it, and a
 * deposit id is read once); plus 2 terminal seeks, so at most about 500. The
 * confirm door runs the probe twice (request, and inside the shared posting
 * body), so about 1,000 against the platform's 4,096. It is a ceiling on the
 * SHAPE, not a measurement of a typical deal, which is a handful.
 *
 * Known envelope (SCRUM-461): at its max shape the probe costs about 450 index
 * ranges. Combined with a very large quote (roughly 95+ cars) the create/confirm
 * door can exceed the platform's 4,096 range limit before the guided refusal.
 * The transaction aborts atomically, so no money is recorded. The structural fix
 * is the SCRUM-461 link table.
 */
export const RESERVATION_PROBE_MAX_ORIGINS_PER_QUOTE = 100;
export const RESERVATION_PROBE_MAX_FUNDED_TAGGED_PER_QUOTE = 50;

// Unreachable in normal operation: both bounds are far above what one quote can
// legitimately link. It exists so a corrupt or runaway deal fails CLOSED
// instead of being read truncated.
const RESERVATION_PROBE_OVERFLOW_MESSAGE =
  "This quote is linked to too many reservations to confirm that no reservation deposit is holding money for it, so the deposit was not taken. Ask an administrator to review the reservations linked to this deal.";

// A reservation the deal points at that cannot be read as this organization's
// is not evidence of "no money": the probe cannot tell, so it refuses.
const RESERVATION_PROBE_UNREADABLE_MESSAGE =
  "This quote's deal points at a reservation that could not be found, so it cannot be confirmed that no reservation deposit is holding money for it, and the deposit was not taken. Ask an administrator to review the reservations linked to this deal.";

/**
 * The first of `depositIds` that is a live receipt of this organization
 * (HELD or APPLIED, not deleted), or null. Missing, foreign-organization and
 * deleted deposits are skipped — they are never this organization's money.
 */
async function firstLiveDeposit(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  depositIds: Array<Id<"deposits"> | undefined>
): Promise<Doc<"deposits"> | null> {
  for (const depositId of depositIds) {
    if (!depositId) continue;
    const deposit = await ctx.db.get(depositId);
    if (!deposit || deposit.orgId !== orgId || deposit.isDeleted === true) continue;
    if (deposit.status === "HELD" || deposit.status === "APPLIED") return deposit;
  }
  return null;
}

/**
 * A reservation whose deposit is still HELD or APPLIED, or null. This is the
 * one definition of "a reservation that is carrying money" for adoption.
 */
async function liveReservationDeposit(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  reservationId: Id<"vehicleReservations"> | undefined,
  claimDepositId: Id<"deposits"> | undefined
): Promise<Doc<"deposits"> | null> {
  const reservation = reservationId ? await ctx.db.get(reservationId) : null;
  if (reservation && reservation.orgId !== orgId) return null;
  return await firstLiveDeposit(ctx, orgId, [reservation?.depositId, claimDepositId]);
}

/**
 * A reservation that was taken WITH a deposit and belongs to this quote's deal
 * is a receipt the quote's own arithmetic cannot see: `deposits.by_quote` never
 * lists it, so the cap and the pending-request guard both read "nothing paid".
 * Every door that would receive more money against the quote fails CLOSED while
 * one is live.
 *
 * The writers this relies on (verified, and not changed here):
 *  - `vehicleReservations.depositId` is written only when the reservation is
 *    created with a deposit.
 *  - A RESERVATION claim's evidence carries `depositId` if and only if its
 *    reservation was funded.
 *  - A deposit is refused on a reservation that has deal lineage, so a FUNDED
 *    reservation always opens its own root and is that root's
 *    `originReservationId`; restoration successors copy `headQuoteId` and
 *    `originReservationId`.
 *
 * Actual coverage:
 *  - Branch H, BY ROOT: every ORIGIN-headed root whose `headQuoteId` is the
 *    quote, in any root status. The distinct `originReservationId` values are
 *    the reservations. It counts unfunded origins too (cap 100) and is
 *    fail-closed: past the cap it refuses rather than reads a truncated set.
 *  - Branch T, BY TAG: the funded RESERVATION claims tagged with the quote,
 *    which names the reservation even when its root is headed elsewhere.
 *  Not covered here: an untagged joiner (`dealDepositId` / `dealQuoteId`) onto
 *  an ORIGINLESS quote-headed root. The writer refuses that shape (R-A,
 *  vehicles.ts) and history is covered by the pre-deploy census (SCRUM
 *  follow-up).
 *
 * ⚠️ SCOPED TO THE DEAL, NEVER THE CAR. Nothing reads `by_org_vehicle_status`:
 * a car's finished deals belong to other quotes and must never block this one.
 * Every seek leads with `orgId`, and every reservation and deposit is checked
 * against the org before it counts.
 *
 * Indexes: `commitmentRoots.by_org_head_quote_origin` and
 * `vehicleCommitmentClaims.by_org_quote_kind_deposit`; bounds above.
 */
export async function assertNoQuoteLinkedReservationDeposit(
  ctx: QueryCtx,
  quote: Doc<"quotes">
): Promise<void> {
  const orgId = quote.orgId;
  const visitedReservations = new Set<Id<"vehicleReservations">>();
  const checkedDeposits = new Set<Id<"deposits">>();

  const visit = async (
    reservationId: Id<"vehicleReservations">,
    claimDepositId: Id<"deposits"> | undefined
  ): Promise<void> => {
    const candidates: Array<Id<"deposits"> | undefined> = [];
    // A reservation reached by both branches is read once.
    if (!visitedReservations.has(reservationId)) {
      visitedReservations.add(reservationId);
      const reservation = await ctx.db.get(reservationId);
      // Missing or foreign: the deal names a reservation this organization
      // cannot read. That is not "no money", it is "cannot tell" — fail closed.
      if (!reservation || reservation.orgId !== orgId) {
        throw new ConvexError(RESERVATION_PROBE_UNREADABLE_MESSAGE);
      }
      candidates.push(reservation.depositId);
    }
    candidates.push(claimDepositId);

    // Every unchecked candidate is evaluated (at most two gets): a reservation's
    // own deposit and its claim's deposit can differ, and either one alone being
    // live and off-quote is enough to refuse.
    for (const id of candidates) {
      if (!id || checkedDeposits.has(id)) continue;
      checkedDeposits.add(id);
      const deposit = await ctx.db.get(id);
      if (!deposit || deposit.orgId !== orgId || deposit.isDeleted === true) continue;
      if (deposit.status !== "HELD" && deposit.status !== "APPLIED") continue;
      // A deposit already recorded ON this quote is visible to `by_quote`.
      if (deposit.quoteId === quote._id) continue;
      throw new ConvexError(
        `A reservation deposit taken on this deal's vehicle is already holding money for it, and this quote cannot see it. ${RESERVATION_DEPOSIT_NEXT_STEP}`
      );
    }
  };

  // Branch H — distinct reservation origins of the roots headed at this quote.
  // `.gt("originReservationId", undefined)` on the first seek steps over roots
  // headed here with NO origin (undefined sorts before every defined value).
  let lastOrigin: Id<"vehicleReservations"> | undefined = undefined;
  for (let origins = 0; ; origins += 1) {
    const after: Id<"vehicleReservations"> | undefined = lastOrigin;
    const root: Doc<"commitmentRoots"> | null = await ctx.db
      .query("commitmentRoots")
      .withIndex("by_org_head_quote_origin", (q) =>
        q.eq("orgId", orgId).eq("headQuoteId", quote._id).gt("originReservationId", after)
      )
      .first();
    if (!root) break;
    // The index contract (`gt` skips undefined) means a returned root always has
    // an origin. If that ever stops holding, refuse rather than pass silently.
    if (!root.originReservationId) throw new ConvexError(RESERVATION_PROBE_UNREADABLE_MESSAGE);
    if (origins >= RESERVATION_PROBE_MAX_ORIGINS_PER_QUOTE) {
      throw new ConvexError(RESERVATION_PROBE_OVERFLOW_MESSAGE);
    }
    lastOrigin = root.originReservationId;
    await visit(root.originReservationId, undefined);
  }

  // Branch T — distinct FUNDED deposits on RESERVATION claims tagged with the
  // quote. An unfunded reservation's claim has no `depositId`, sorts first, and
  // is stepped over by `.gt("depositId", undefined)`, so it is never counted.
  let lastDeposit: Id<"deposits"> | undefined = undefined;
  for (let funded = 0; ; funded += 1) {
    const after: Id<"deposits"> | undefined = lastDeposit;
    const claim: Doc<"vehicleCommitmentClaims"> | null = await ctx.db
      .query("vehicleCommitmentClaims")
      .withIndex("by_org_quote_kind_deposit", (q) =>
        q
          .eq("orgId", orgId)
          .eq("quoteId", quote._id)
          .eq("evidenceKind", "RESERVATION")
          .gt("depositId", after)
      )
      .first();
    if (!claim) break;
    // Same contract as Branch H: a returned claim always has a depositId.
    if (!claim.depositId) throw new ConvexError(RESERVATION_PROBE_UNREADABLE_MESSAGE);
    if (funded >= RESERVATION_PROBE_MAX_FUNDED_TAGGED_PER_QUOTE) {
      throw new ConvexError(RESERVATION_PROBE_OVERFLOW_MESSAGE);
    }
    lastDeposit = claim.depositId;
    // A tagged claim with no reservation cannot be read as anyone's: refuse.
    if (!claim.reservationId) throw new ConvexError(RESERVATION_PROBE_UNREADABLE_MESSAGE);
    await visit(claim.reservationId, claim.depositId);
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
