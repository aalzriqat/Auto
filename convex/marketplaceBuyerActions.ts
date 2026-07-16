import { ConvexError, v } from "convex/values";
import { mutation, MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { getOrCreateMarketplaceBuyerCustomer, resolveGeneratedLeadAssignee } from "./utils/leadAssignment";

/**
 * Buyer-side actions on a Request Room, taken by an anonymous buyer with no
 * account. The unguessable publicId is the read/light-action key; the two
 * actions that reveal the phone (allowContact, acceptOffer) additionally
 * require the buyer's own phone, so a forwarded link can't leak it.
 *
 * This is where the CRM lead is finally created — never on the dealer's reply.
 */

function normalizePhone(raw: string): string {
  return raw.replace(/[^\d+]/g, "");
}

/**
 * Loads the response and its request from a publicId + responseId, verifying
 * the response actually belongs to that request. Returns null on any mismatch
 * so callers surface one generic "offer not found" rather than leaking which
 * half was wrong.
 */
async function loadOfferForRoom(
  ctx: MutationCtx,
  publicId: string,
  responseId: Id<"marketplaceResponses">
): Promise<{ request: Doc<"marketplaceRequests">; response: Doc<"marketplaceResponses"> } | null> {
  const request = await ctx.db
    .query("marketplaceRequests")
    .withIndex("by_publicId", (q) => q.eq("publicId", publicId.trim()))
    .unique();
  if (!request) return null;

  const response = await ctx.db.get(responseId);
  if (!response || response.requestId !== request._id) return null;
  if (response.kind === "NOT_AVAILABLE") return null;

  return { request, response };
}

async function requireOffer(ctx: MutationCtx, publicId: string, responseId: Id<"marketplaceResponses">) {
  const found = await loadOfferForRoom(ctx, publicId, responseId);
  if (!found) throw new ConvexError("That offer could not be found.");
  return found;
}

async function logEvent(
  ctx: MutationCtx,
  requestId: Id<"marketplaceRequests">,
  orgId: Id<"organizations">,
  event: string
) {
  await ctx.db.insert("marketplaceEvents", { requestId, orgId, event, createdAt: Date.now() });
}

/**
 * Creates the buyer's customer + lead in the responding dealer's pipeline and
 * stamps contactUnlockedAt on both the response and its match row — but only
 * once. A second consent (accept after allowContact, or a double tap) reuses
 * the existing unlock instead of duplicating the lead.
 */
async function unlockContactAndCreateLead(
  ctx: MutationCtx,
  request: Doc<"marketplaceRequests">,
  response: Doc<"marketplaceResponses">
): Promise<void> {
  if (response.contactUnlockedAt !== undefined) return;

  const now = Date.now();
  const customerId = await getOrCreateMarketplaceBuyerCustomer(
    ctx,
    response.orgId,
    request.buyerPhone,
    request.buyerFirstName,
    request.buyerWhatsApp
  );
  const assignedUserId = await resolveGeneratedLeadAssignee(ctx, response.orgId);

  const vehicleDescription = [request.make, request.model].filter(Boolean).join(" ") || "a vehicle";
  const noteLines = [
    `Marketplace: buyer wants ${vehicleDescription} in ${request.buyerCity} (${request.paymentType}, ${request.buyerIntent} intent).`,
    `Buyer unlocked contact on the dealer's ${response.kind} offer.`,
  ];
  if (response.note) noteLines.push(response.note);

  await ctx.db.insert("leads", {
    orgId: response.orgId,
    customerId,
    assignedUserId,
    vehicleId: response.vehicleId,
    source: "Marketplace offer",
    sourceChannel: "marketplace",
    marketplaceRequestId: request._id,
    stage: "NEW",
    notes: noteLines.join(" "),
  });

  await ctx.db.patch(response._id, { contactUnlockedAt: now });

  const match = await ctx.db
    .query("marketplaceRequestMatches")
    .withIndex("by_request", (q) => q.eq("requestId", request._id))
    .filter((q) => q.eq(q.field("orgId"), response.orgId))
    .unique();
  if (match && match.contactUnlockedAt === undefined) {
    await ctx.db.patch(match._id, { contactUnlockedAt: now });
  }

  await logEvent(ctx, request._id, response.orgId, "contact.unlocked");
}

/** Buyer shortlists an offer — a private bookmark, no phone reveal, no lead. */
export const shortlistOffer = mutation({
  args: { publicId: v.string(), responseId: v.id("marketplaceResponses") },
  handler: async (ctx, args) => {
    const { request, response } = await requireOffer(ctx, args.publicId, args.responseId);
    await ctx.db.patch(response._id, { buyerAction: "SHORTLISTED", buyerActionAt: Date.now() });
    await logEvent(ctx, request._id, response.orgId, "offer.shortlisted");
  },
});

/** Buyer declines an offer — no phone reveal, no lead. */
export const declineOffer = mutation({
  args: { publicId: v.string(), responseId: v.id("marketplaceResponses") },
  handler: async (ctx, args) => {
    const { request, response } = await requireOffer(ctx, args.publicId, args.responseId);
    await ctx.db.patch(response._id, { buyerAction: "DECLINED", buyerActionAt: Date.now() });
    await logEvent(ctx, request._id, response.orgId, "offer.declined");
  },
});

/**
 * Buyer allows this one dealer to contact them: phone-gated, reveals the phone
 * to that dealer only, and creates the lead. Does not commit to the offer.
 */
export const allowContact = mutation({
  args: { publicId: v.string(), responseId: v.id("marketplaceResponses"), buyerPhone: v.string() },
  handler: async (ctx, args) => {
    const { request, response } = await requireOffer(ctx, args.publicId, args.responseId);
    if (request.buyerPhone !== normalizePhone(args.buyerPhone)) {
      throw new ConvexError("That phone number doesn't match this request.");
    }
    await unlockContactAndCreateLead(ctx, request, response);
  },
});

/**
 * Buyer accepts an offer: phone-gated, marks the offer ACCEPTED and the request
 * ACCEPTED, and creates the lead (via the shared unlock path). ACCEPTED/
 * COMPLETED are buyer-only states — a dealer reply never sets them.
 */
export const acceptOffer = mutation({
  args: { publicId: v.string(), responseId: v.id("marketplaceResponses"), buyerPhone: v.string() },
  handler: async (ctx, args) => {
    const { request, response } = await requireOffer(ctx, args.publicId, args.responseId);
    if (request.buyerPhone !== normalizePhone(args.buyerPhone)) {
      throw new ConvexError("That phone number doesn't match this request.");
    }

    await unlockContactAndCreateLead(ctx, request, response);
    await ctx.db.patch(response._id, { buyerAction: "ACCEPTED", buyerActionAt: Date.now() });
    if (request.status !== "COMPLETED") {
      await ctx.db.patch(request._id, { status: "ACCEPTED" });
    }
    await logEvent(ctx, request._id, response.orgId, "offer.accepted");
  },
});
