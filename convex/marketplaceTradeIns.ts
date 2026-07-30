import { ConvexError, v } from "convex/values";
import { action, internalMutation, mutation, query, MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { normalizeRequiredText, normalizeText } from "./websites";
import { normalizePhone, verifyPublicSubmission } from "./marketplaceRequests";
import { notifyByPermission } from "./utils/notifications";
import { PERMISSIONS } from "./utils/permissions";
import { requireTenantAuth } from "./utils/tenancy";
import { resolveGeneratedLeadAssignee, getOrCreateMarketplaceBuyerCustomer } from "./utils/leadAssignment";
import { recordLeadCreated } from "./utils/leadActivity";
import { getOwnProfile } from "./marketplaceDealers";
import { assertFiniteNumber } from "./utils/money";

const MAX_NAME_CHARS = 80;
const MAX_MAKE_MODEL_CHARS = 60;
const MAX_NOTE_CHARS = 500;
const MAX_FINGERPRINT_CHARS = 256;
const MAX_IP_HASH_CHARS = 128;
const MAX_LISTED_TRADEINS = 100;

const conditionValidator = v.union(
  v.literal("EXCELLENT"),
  v.literal("GOOD"),
  v.literal("FAIR"),
  v.literal("POOR")
);

const submitTradeInBaseArgs = {
  orgId: v.id("organizations"),
  buyerFirstName: v.string(),
  buyerPhone: v.string(),
  currentMake: v.string(),
  currentModel: v.string(),
  currentYear: v.number(),
  currentMileage: v.number(),
  condition: conditionValidator,
  notes: v.optional(v.string()),
  consentAccepted: v.boolean(),
  clientFingerprint: v.string(),
  clientIpHash: v.optional(v.string()),
};

/** Public: buyer requests a trade-in offer on a specific dealer's vehicle listing. Turnstile + rate-limited, same shape as marketplaceRequests.submitRequest. */
export const submitTradeInRequest = action({
  args: {
    ...submitTradeInBaseArgs,
    turnstileToken: v.string(),
  },
  handler: async (ctx, args): Promise<{ tradeInRequestId: Id<"marketplaceTradeInRequests"> }> => {
    const { requestArgs, clientFingerprint } = await verifyPublicSubmission(
      ctx,
      args,
      "marketplaceTradeInFingerprint",
      "marketplaceTradeInContact",
    );
    return await ctx.runMutation(internal.marketplaceTradeIns.createTradeInRequest, {
      ...requestArgs,
      clientFingerprint,
    });
  },
});

export const createTradeInRequest = internalMutation({
  args: submitTradeInBaseArgs,
  handler: async (ctx, args): Promise<{ tradeInRequestId: Id<"marketplaceTradeInRequests"> }> => {
    if (!args.consentAccepted) {
      throw new ConvexError("Consent is required to submit a trade-in request.");
    }

    const org = await ctx.db.get(args.orgId);
    if (!org || org.suspended) throw new ConvexError("This dealer is not accepting trade-in requests.");
    const profile = await getOwnProfile(ctx, args.orgId);
    if (!profile || !profile.isOptedIn || profile.isDeleted) {
      throw new ConvexError("This dealer is not accepting trade-in requests.");
    }

    const now = Date.now();
    const buyerFirstName = normalizeRequiredText(args.buyerFirstName, "Name", MAX_NAME_CHARS);
    const buyerPhone = normalizePhone(args.buyerPhone, "Phone");
    const currentMake = normalizeRequiredText(args.currentMake, "Make", MAX_MAKE_MODEL_CHARS);
    const currentModel = normalizeRequiredText(args.currentModel, "Model", MAX_MAKE_MODEL_CHARS);
    const notes = normalizeText(args.notes, "Notes", MAX_NOTE_CHARS);
    const clientFingerprint = normalizeRequiredText(args.clientFingerprint, "Client fingerprint", MAX_FINGERPRINT_CHARS);
    const clientIpHash = normalizeText(args.clientIpHash, "Client IP hash", MAX_IP_HASH_CHARS);

    if (args.currentYear < 1980 || args.currentYear > new Date().getFullYear() + 1) {
      throw new ConvexError("Year is invalid.");
    }
    if (args.currentMileage < 0) {
      throw new ConvexError("Mileage cannot be negative.");
    }

    const tradeInRequestId = await ctx.db.insert("marketplaceTradeInRequests", {
      orgId: args.orgId,
      buyerFirstName,
      buyerPhone,
      currentMake,
      currentModel,
      currentYear: args.currentYear,
      currentMileage: args.currentMileage,
      condition: args.condition,
      notes,
      status: "PENDING",
      consentAcceptedAt: now,
      clientFingerprint,
      clientIpHash,
      createdAt: now,
    });

    const vehicleDescription = `${args.currentYear} ${currentMake} ${currentModel}`;
    await notifyByPermission(ctx, args.orgId, PERMISSIONS.MARKETPLACE_RESPOND, "marketplace.tradein_submitted", {
      vehicleDescription,
    });

    return { tradeInRequestId };
  },
});

/** Dealer inbox: trade-in requests directed at this org. */
export const listForOrg = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MARKETPLACE_RESPOND]);
    return await ctx.db
      .query("marketplaceTradeInRequests")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(MAX_LISTED_TRADEINS);
  },
});

/** Dealer makes an offer on a pending trade-in. */
export const makeOffer = mutation({
  args: {
    orgId: v.id("organizations"),
    tradeInRequestId: v.id("marketplaceTradeInRequests"),
    offerAmountJod: v.number(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MARKETPLACE_RESPOND]);
    // `< 0` is false for NaN, so a non-finite offer would pass this check and be
    // stored as the amount the seller was quoted.
    assertFiniteNumber(args.offerAmountJod, "offer amount");
    if (args.offerAmountJod < 0) throw new ConvexError("Offer amount must be non-negative.");

    const tradeIn = await ctx.db.get(args.tradeInRequestId);
    if (!tradeIn || tradeIn.orgId !== args.orgId) throw new ConvexError("Trade-in request not found.");
    if (tradeIn.status !== "PENDING") throw new ConvexError("This trade-in request already has an offer.");

    await ctx.db.patch(args.tradeInRequestId, {
      status: "OFFERED",
      offerAmountJod: args.offerAmountJod,
      offeredAt: Date.now(),
      offeredBy: user._id,
    });
  },
});

/** Public: buyer checks their trade-in offer status, phone-gated same as marketplaceRequests.getStatusForBuyer. */
async function getBuyerTradeInStatus(
  ctx: QueryCtx,
  tradeInRequestId: Id<"marketplaceTradeInRequests">,
  buyerPhone: string
) {
  const tradeIn = await ctx.db.get(tradeInRequestId);
  if (!tradeIn) return null;
  // normalizePhone throws on an unparseable number — for a read that just
  // means "no match", so treat it as null rather than surfacing the error.
  let normalizedPhone: string;
  try {
    normalizedPhone = normalizePhone(buyerPhone, "Phone");
  } catch (error) {
    if (error instanceof ConvexError) return null;
    throw error;
  }
  if (tradeIn.buyerPhone !== normalizedPhone) return null;

  return {
    status: tradeIn.status,
    offerAmountJod: tradeIn.offerAmountJod ?? null,
    currentMake: tradeIn.currentMake,
    currentModel: tradeIn.currentModel,
    currentYear: tradeIn.currentYear,
  };
}

export const getStatusForBuyer = query({
  args: { tradeInRequestId: v.id("marketplaceTradeInRequests"), buyerPhone: v.string() },
  handler: async (ctx, args) => {
    return await getBuyerTradeInStatus(ctx, args.tradeInRequestId, args.buyerPhone);
  },
});

/**
 * Public/mobile-safe: buyer trade-in status by a pasted/link id string, null
 * for a malformed id instead of a validator error. Same phone gate.
 */
export const getStatusForBuyerByPublicId = query({
  args: { tradeInRequestId: v.string(), buyerPhone: v.string() },
  handler: async (ctx, args) => {
    const tradeInRequestId = ctx.db.normalizeId("marketplaceTradeInRequests", args.tradeInRequestId.trim());
    if (!tradeInRequestId) return null;
    return await getBuyerTradeInStatus(ctx, tradeInRequestId, args.buyerPhone);
  },
});

/** Why a buyer may not act on an offer, or the offer if they may. */
type OfferGate =
  | { ok: true; tradeIn: Doc<"marketplaceTradeInRequests"> }
  | { ok: false; reason: "NOT_FOUND" | "NO_ACTIVE_OFFER" };

/**
 * Single gate for both entry points, so the phone check and the status check
 * cannot drift between the web page and the mobile app.
 *
 * "No such request" and "wrong phone" are one reason on purpose: reporting them
 * apart would turn this unauthenticated endpoint into an oracle for whether a
 * given phone number has a trade-in with a given dealership.
 */
async function resolveActionableOffer(
  ctx: MutationCtx,
  tradeInRequestId: Id<"marketplaceTradeInRequests">,
  buyerPhone: string
): Promise<OfferGate> {
  const tradeIn = await ctx.db.get(tradeInRequestId);
  if (!tradeIn) return { ok: false, reason: "NOT_FOUND" };
  if (tradeIn.buyerPhone !== normalizePhone(buyerPhone, "Phone")) return { ok: false, reason: "NOT_FOUND" };
  if (tradeIn.status !== "OFFERED") return { ok: false, reason: "NO_ACTIVE_OFFER" };
  return { ok: true, tradeIn };
}

/**
 * The gate, for the public-id endpoints that must not throw.
 *
 * `normalizePhone` raises on a malformed number, which for a field the buyer
 * types by hand is an ordinary input error, not an exception — catching it here
 * keeps those endpoints total, as their `{ success }` contract promises.
 */
async function resolveActionableOfferQuietly(
  ctx: MutationCtx,
  rawTradeInRequestId: string,
  buyerPhone: string
): Promise<Doc<"marketplaceTradeInRequests"> | null> {
  const tradeInRequestId = ctx.db.normalizeId("marketplaceTradeInRequests", rawTradeInRequestId.trim());
  if (!tradeInRequestId) return null;
  let gate: OfferGate;
  try {
    gate = await resolveActionableOffer(ctx, tradeInRequestId, buyerPhone);
  } catch {
    return null;
  }
  return gate.ok ? gate.tradeIn : null;
}

/** Maps a gate failure back to the message the public web page has always shown. */
function offerGateError(reason: "NOT_FOUND" | "NO_ACTIVE_OFFER"): ConvexError<string> {
  return new ConvexError(
    reason === "NOT_FOUND" ? "Trade-in request not found." : "This trade-in request has no active offer."
  );
}

/**
 * The accept effect. Shared by the typed and public-id entry points so the two
 * can never drift on what accepting an offer actually does.
 *
 * Creates an attributed lead in the dealer's existing pipeline (same as
 * marketplaceResponses.respond). No Purchase Order is created: Phase 34
 * (Purchase Orders) doesn't exist in this codebase yet, so this stays a lead
 * like every other marketplace conversion until that phase ships.
 */
async function applyOfferAcceptance(
  ctx: MutationCtx,
  tradeIn: Doc<"marketplaceTradeInRequests">
): Promise<Id<"leads">> {
  const customerId = await getOrCreateMarketplaceBuyerCustomer(
    ctx,
    tradeIn.orgId,
    tradeIn.buyerPhone,
    tradeIn.buyerFirstName
  );

  const vehicleDescription = `${tradeIn.currentYear} ${tradeIn.currentMake} ${tradeIn.currentModel}`;
  const noteLines = [
    `Marketplace trade-in: buyer's current car is a ${vehicleDescription}, ${tradeIn.currentMileage.toLocaleString()} km, ${tradeIn.condition} condition.`,
    `Accepted offer: ${tradeIn.offerAmountJod} JOD.`,
  ];
  if (tradeIn.notes) noteLines.push(tradeIn.notes);

  const assignedUserId = await resolveGeneratedLeadAssignee(ctx, tradeIn.orgId);

  const leadId = await ctx.db.insert("leads", {
    orgId: tradeIn.orgId,
    customerId,
    assignedUserId,
    source: "Marketplace trade-in",
    sourceChannel: "marketplace",
    stage: "NEW",
    notes: noteLines.join(" "),
  });

  await recordLeadCreated(ctx, {
    orgId: tradeIn.orgId,
    leadId,
    actorLabel: "Marketplace trade-in",
    stage: "NEW",
    assignedUserId,
    source: "Marketplace trade-in",
  });

  await ctx.db.patch(tradeIn._id, { status: "ACCEPTED", respondedAt: Date.now(), leadId });

  return leadId;
}

/** Public: buyer accepts an offer, phone-gated. Throws on a bad id/phone — the web page at /marketplace/tradein/[id] surfaces the message. */
export const acceptOffer = mutation({
  args: { tradeInRequestId: v.id("marketplaceTradeInRequests"), buyerPhone: v.string() },
  handler: async (ctx, args): Promise<{ leadId: Id<"leads"> }> => {
    const gate = await resolveActionableOffer(ctx, args.tradeInRequestId, args.buyerPhone);
    if (!gate.ok) throw offerGateError(gate.reason);
    return { leadId: await applyOfferAcceptance(ctx, gate.tradeIn) };
  },
});

/** Public: buyer declines an offer, phone-gated. */
export const declineOffer = mutation({
  args: { tradeInRequestId: v.id("marketplaceTradeInRequests"), buyerPhone: v.string() },
  handler: async (ctx, args) => {
    const gate = await resolveActionableOffer(ctx, args.tradeInRequestId, args.buyerPhone);
    if (!gate.ok) throw offerGateError(gate.reason);
    await ctx.db.patch(gate.tradeIn._id, { status: "DECLINED", respondedAt: Date.now() });
  },
});

/**
 * Public/mobile-safe accept, by a pasted/link id string.
 *
 * The mobile Offers tab types a raw id into a text field, so a malformed one
 * must not blow up on the `v.id` validator — same convention as
 * `getStatusForBuyerByPublicId` above. Returns a result object rather than
 * throwing so the caller can render one "couldn't update that offer" state for
 * every reason it might have failed.
 */
export const acceptOfferByPublicId = mutation({
  args: { tradeInRequestId: v.string(), buyerPhone: v.string() },
  handler: async (ctx, args): Promise<{ success: true; leadId: Id<"leads"> } | { success: false }> => {
    const tradeIn = await resolveActionableOfferQuietly(ctx, args.tradeInRequestId, args.buyerPhone);
    if (!tradeIn) return { success: false };
    return { success: true, leadId: await applyOfferAcceptance(ctx, tradeIn) };
  },
});

/** Public/mobile-safe decline, by a pasted/link id string. See acceptOfferByPublicId. */
export const declineOfferByPublicId = mutation({
  args: { tradeInRequestId: v.string(), buyerPhone: v.string() },
  handler: async (ctx, args): Promise<{ success: true } | { success: false }> => {
    const tradeIn = await resolveActionableOfferQuietly(ctx, args.tradeInRequestId, args.buyerPhone);
    if (!tradeIn) return { success: false };
    await ctx.db.patch(tradeIn._id, { status: "DECLINED", respondedAt: Date.now() });
    return { success: true };
  },
});
