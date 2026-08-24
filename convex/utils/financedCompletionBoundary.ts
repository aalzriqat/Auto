/**
 * The one place that decides whether a deal may be turned into a completed sale.
 *
 * A financed deal is supposed to commit through its finance application:
 * handover registered, dealer economics recorded, then `finalizeDeal`. Every
 * public sale door reached the shared completion path without ever asking
 * whether the deal was financed, so a caller holding `create:sales` could
 * complete a configured quote outright — the sale COMPLETED, the vehicle SOLD,
 * the accounting side effects run, and the application left stranded because
 * its own `finalizeDeal` then fails on an already-sold vehicle.
 *
 * Four things about the shape of this guard are load-bearing. Each replaced an
 * earlier design that looked equivalent and was not.
 *
 * ## 1. Authority is derived, never asserted
 *
 * The first design exempted the authorized path with a caller-supplied flag
 * (`allowFinancedCompletion`, or equivalently "an `applicationId` was passed").
 * That is forgeable by construction: this module cannot see WHO set the field,
 * only that it is set, so any future entry point that copies the argument shape
 * inherits the bypass silently — passing the flag looks like ordinary plumbing
 * rather than an authorization decision.
 *
 * So nothing here trusts the caller. `finalizeDeal` is not EXEMPT from this
 * boundary; it is simply the only caller whose deals can SATISFY it, because
 * satisfaction is read from the application's own persisted lifecycle state.
 * A matching application id is identity, not authority — which is why an
 * APPROVED application with no handover is still refused.
 *
 * ## 2. The deal is resolved from persisted state, not from the arguments
 *
 * `applicationId` is optional on the shared args and `quoteId` is optional on
 * `sales.create` and `sales.createDraft`. A guard keyed on either closes
 * nothing, because the dangerous shape simply omits the field.
 *
 * Omitting the quote must therefore not erase the financing evidence. When no
 * quote is supplied the customer's own persisted quotes for this vehicle are
 * consulted instead — otherwise a financed quote whose application has not been
 * created YET is completable by leaving `quoteId` off, which is the widest
 * version of the bypass rather than a narrower one.
 *
 * ## 3. Scoped to org + vehicle + CUSTOMER, never vehicle alone
 *
 * Keying on the vehicle alone made one abandoned application lock that car
 * against every future cash buyer, permanently — nothing expires a finance
 * application, so a stale DRAFT from a customer who never returned would refuse
 * an unrelated walk-in sale, and tell the operator the deal was "financed" when
 * it was not. The harm this guard exists to prevent is a deal being completed
 * around ITS OWN lifecycle, so the deal — vehicle and customer together — is
 * what gets looked up.
 *
 * ## 4. REJECTED is not terminal
 *
 * `convex/applications.ts` permits `REJECTED -> PENDING_DOCS`. Treating a
 * rejection as finished let the car be sold and the application then legitimately
 * reopened onto a SOLD vehicle, where it can never finalize. Only CLOSED and
 * CANCELLED actually end an application's claim on a car.
 */
import { ConvexError } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * The application statuses, as one exhaustive map.
 *
 * Typed as `Record<ApplicationStatus, true>` so that adding a status to the
 * schema fails to compile here until it is classified — the alternative is a new
 * status silently defaulting to whichever side the code happens to check.
 */
const ALL_APPLICATION_STATUSES: Record<Doc<"financeApplications">["status"], true> = {
  DRAFT: true,
  PENDING_DOCS: true,
  UNDER_REVIEW: true,
  APPROVED: true,
  REJECTED: true,
  CLOSED: true,
  CANCELLED: true,
};

/**
 * The statuses that genuinely end an application's claim on a vehicle.
 *
 * REJECTED is deliberately NOT here: `applications.ts` permits
 * `REJECTED -> PENDING_DOCS`, so a rejection is reopenable and still holds the
 * car. Only these two actually release it.
 */
const TERMINAL_APPLICATION_STATUSES: readonly string[] = ["CLOSED", "CANCELLED"];

/**
 * Every status this boundary must treat as still holding the vehicle.
 *
 * DERIVED, never written out a second time. Maintaining a separate live list
 * beside the terminal one gave the module two sources of truth for the same
 * question, and mutation testing proved it: moving REJECTED into the terminal
 * set changed nothing, because the lookup was still reading its own list. Two
 * lists that must agree will eventually not.
 */
const LIVE_APPLICATION_STATUSES = (
  Object.keys(ALL_APPLICATION_STATUSES) as Doc<"financeApplications">["status"][]
).filter((status) => !TERMINAL_APPLICATION_STATUSES.includes(status));

/** A quote that has expired is stale intent and no longer holds a car. */
const SPENT_QUOTE_STATUS = "EXPIRED";

/** The subset of a quote that decides whether the deal is financed. */
export interface FinancedQuoteFacts {
  mode?: string;
  companyId?: Id<"financeCompanies">;
}

/**
 * Whether this quote's deal has to commit through a finance application.
 *
 * The `companyId` fallback is not a refinement, it is the point. `saveQuote`
 * rejects a `companyId` only when a mode is PRESENT and non-configured, so
 * `companyId` set with `mode === undefined` is creatable through the ordinary
 * public mutation today — and it is the shape that gets written down as
 * `financingType: "CASH"`, which misstates a financed deal as a cash one rather
 * than merely skipping a lifecycle.
 *
 * Every explicit non-CASH mode commits through the application. That includes
 * INTERNAL_INSTALLMENT, where the DEALERSHIP is the financier: `settlementPayer`
 * correctly reports `external: false` for it because nobody outside pays the
 * supplier, but that is a different question from this one and the two must not
 * be unified. It also includes LEASE and MANUAL_FINANCE_COMPANY, neither of
 * which can carry a `companyId` at all — so a guard reading `companyId` alone
 * would miss both.
 */
export function quoteCommitsThroughApplication(quote: FinancedQuoteFacts): boolean {
  if (quote.mode !== undefined) return quote.mode !== "CASH";
  return quote.companyId !== undefined;
}

/**
 * What is missing before this deal's economics can be sold on, or `null` when
 * nothing is.
 *
 * A deal that never recorded a submitted quotation is a legacy shape with no
 * economics to check, and is let through untouched — the same reading
 * `finalizeDeal` has always used.
 */
export function dealerEconomicsGap(
  app: Pick<
    Doc<"financeApplications">,
    "submittedQuotationMinor" | "approvedDealerPurchaseAmountMinor" | "financeCompanyFundedPortionMinor"
  >,
  action: string
): string | null {
  if (app.submittedQuotationMinor === undefined) return null;
  if (app.approvedDealerPurchaseAmountMinor === undefined) {
    return `The finance company's approved purchase amount is not recorded on this deal. Record it before ${action}.`;
  }
  // An approval whose funding split could not be computed — the company's LTV
  // basis names an amount nobody recorded — is not something to hand a vehicle
  // over against, or to sell on. The approval being present is not enough.
  if (app.financeCompanyFundedPortionMinor === undefined) {
    return `This deal's funding split could not be calculated. Resolve the reconciliation note on it before ${action}.`;
  }
  return null;
}

/**
 * Why this application cannot legitimately become a completed sale right now,
 * or `null` when it can.
 *
 * These are the same facts `finalizeDeal` establishes before it calls
 * `completeSale`, asked here as a question rather than enforced there as a
 * sequence — so that satisfying the lifecycle, rather than being a particular
 * caller, is what earns a deal its completion.
 *
 * Deliberately NOT a copy of every condition `finalizeDeal` checks. It also
 * validates denomination, settlement route, held deposits and current
 * minimum-profit approval; duplicating those here would create the second
 * definition of "ready to finalize" this module exists to avoid. They stay where
 * they are unless a concrete reachable bypass shows one is needed here.
 */
export function financeApplicationCompletionGap(app: Doc<"financeApplications">): string | null {
  if (app.status !== "APPROVED") {
    return "This deal's finance application has not been approved, so the sale cannot be completed yet.";
  }
  if (!app.vehicleHandoverAt) {
    return "Register the vehicle handover to the customer before completing this deal.";
  }
  if (!app.expectedPaymentMethod || !app.expectedPaymentDate) {
    return "Register how and when the payment is expected before completing this deal.";
  }
  return dealerEconomicsGap(app, "completing this deal");
}

/** Whether this application still holds a claim on its vehicle. */
function applicationIsLive(app: Doc<"financeApplications">): boolean {
  return !TERMINAL_APPLICATION_STATUSES.includes(app.status);
}

/**
 * The first still-live application this customer holds on this vehicle.
 *
 * Issued as one bounded point query per live status rather than collecting the
 * vehicle's whole application history and filtering in memory. The collect-then-
 * filter version read every application ever made against a car — terminal ones
 * included — so a vehicle quoted and re-quoted often enough could exceed Convex's
 * transaction read limit and start refusing every sale of that car, financed or
 * cash. `convex-test` does not model that limit, so it would have passed CI and
 * failed in production.
 */
async function firstLiveApplicationForDeal(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">,
  customerId: Id<"customers">
): Promise<Doc<"financeApplications"> | null> {
  for (const status of LIVE_APPLICATION_STATUSES) {
    const found = await ctx.db
      .query("financeApplications")
      .withIndex("by_vehicle_customer_status", (q) =>
        q.eq("vehicleId", vehicleId).eq("customerId", customerId).eq("status", status)
      )
      .first();
    // The index is keyed on document ids, which cannot span organizations, but
    // the org is asserted rather than assumed — a tenancy check that holds only
    // because of an id's uniqueness is one schema change from not holding.
    if (found && found.orgId === orgId) return found;
  }
  return null;
}

/**
 * Whether this customer has un-expired financing intent recorded against this
 * vehicle.
 *
 * Consulted ONLY when the caller supplied no quote. A caller who supplies an
 * explicit CASH quote has made an affirmative statement about the deal in front
 * of them and is judged on it; a caller who supplies nothing must not thereby
 * erase what the customer's own records say.
 */
async function customerHasFinancedQuoteForVehicle(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">,
  customerId: Id<"customers">
): Promise<boolean> {
  const quotes = await ctx.db
    .query("quotes")
    .withIndex("by_vehicle_customer", (q) =>
      q.eq("vehicleId", vehicleId).eq("customerId", customerId)
    )
    .collect();
  return quotes.some(
    (quote) =>
      quote.orgId === orgId &&
      quote.status !== SPENT_QUOTE_STATUS &&
      quoteCommitsThroughApplication(quote)
  );
}

/**
 * The canonical assertion. Every sale-completion door inherits it by reaching
 * `prepareSaleCompletion`, so a door added later inherits it too rather than
 * having to remember it.
 *
 * Deliberately runs before the sale is inserted, before the vehicle is patched
 * SOLD, and before any receivable, journal, outbox event or dealer-economics
 * write — a refusal must leave nothing behind.
 */
export async function assertFinancedDealCommitsThroughApplication(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    customerId: Id<"customers">;
    /** The supplied quote, or `null` when the caller supplied none. */
    quote: FinancedQuoteFacts | null;
    applicationId?: Id<"financeApplications">;
  }
): Promise<void> {
  const financed =
    args.quote !== null
      ? quoteCommitsThroughApplication(args.quote)
      : await customerHasFinancedQuoteForVehicle(
          ctx,
          args.orgId,
          args.vehicleId,
          args.customerId
        );

  const liveApplication = await firstLiveApplicationForDeal(
    ctx,
    args.orgId,
    args.vehicleId,
    args.customerId
  );

  // An ordinary cash deal with nothing of this customer's in flight on this car.
  // Left exactly as it was, which is what keeps the walk-in sale working — and
  // what keeps ANOTHER customer's stale application from locking the vehicle.
  if (!financed && liveApplication === null) return;

  if (!args.applicationId) {
    // Two different situations, and they must not share a message. Telling the
    // operator of a genuinely cash deal that "this deal is financed" is false,
    // and naming no remedy they can act on strands them.
    if (!financed && liveApplication !== null) {
      throw new ConvexError(
        "This customer already has an open finance application on this vehicle. Cancel that application first — cancelling is what releases the vehicle and unwinds the deal properly — then complete the cash sale."
      );
    }
    throw new ConvexError(
      "This deal is financed, so it commits through its finance application. Register the vehicle handover and record the dealer economics, then finalize it from the application. If the customer is paying cash instead, cancel the finance application first."
    );
  }

  // Identity is validated by the caller before this runs. What is checked here
  // is whether the deal has genuinely reached the point where completion is
  // legitimate — the derivation that makes a matching id identity, not authority.
  const app = await ctx.db.get(args.applicationId);
  if (!app || app.orgId !== args.orgId || !applicationIsLive(app)) {
    throw new ConvexError(
      "This deal's finance application is no longer open, so it cannot be completed through it."
    );
  }

  const gap = financeApplicationCompletionGap(app);
  if (gap) throw new ConvexError(gap);

  // Deliberately NOT refused here: a live application on the same vehicle
  // belonging to a DIFFERENT customer. Completing this deal does strand it, but
  // it was already stranded the moment two customers were quoted one car, and
  // refusing would dead-end the legitimate finalize behind a cancellation this
  // operator may not have permission to perform. That is a pre-existing
  // condition this boundary is not chartered to fix.
}
