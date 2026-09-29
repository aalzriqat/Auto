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
  "Release or resolve that reservation deposit first (vehicle, Reservations tab), then record or request the deposit on the quote.";

/**
 * A reservation that was taken WITH a deposit and is linked to this quote is a
 * receipt the quote's own arithmetic cannot see: `deposits.by_quote` never
 * lists it, so the cap and the pending-request guard both read "nothing paid".
 * `createReservation` no longer creates one, but historical rows can exist, so
 * every door that would receive more money against the quote fails CLOSED while
 * one is live.
 *
 * The lookup is bounded: the quote's own vehicles (one, or its line items) and,
 * for each, the ACTIVE commitment claims of that car (`by_org_vehicle_status`),
 * looking for a RESERVATION episode opened under THIS quote that carries a
 * deposit which is still held or applied.
 */
export async function assertNoQuoteLinkedReservationDeposit(
  ctx: QueryCtx,
  quote: Doc<"quotes">
): Promise<void> {
  const vehicleIds = new Set<Id<"vehicles">>(
    (quote.vehicleItems ?? [{ vehicleId: quote.vehicleId }]).map((item) => item.vehicleId)
  );
  for (const vehicleId of vehicleIds) {
    const claims = await ctx.db
      .query("vehicleCommitmentClaims")
      .withIndex("by_org_vehicle_status", (q) =>
        q.eq("orgId", quote.orgId).eq("vehicleId", vehicleId).eq("status", "ACTIVE")
      )
      .take(10);
    for (const claim of claims) {
      if (claim.evidenceKind !== "RESERVATION" || claim.quoteId !== quote._id) continue;
      if (!claim.reservationId) continue;
      const reservation = await ctx.db.get(claim.reservationId);
      if (!reservation || reservation.orgId !== quote.orgId || !reservation.depositId) continue;
      const deposit = await ctx.db.get(reservation.depositId);
      if (!deposit || deposit.orgId !== quote.orgId || deposit.isDeleted === true) continue;
      if (deposit.status !== "HELD" && deposit.status !== "APPLIED") continue;
      throw new ConvexError(
        `A reservation deposit taken on this deal's vehicle is already holding money for it, and this quote cannot see it. ${RESERVATION_DEPOSIT_NEXT_STEP}`
      );
    }
  }
}