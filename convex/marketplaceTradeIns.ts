import { ConvexError, v } from "convex/values";
import { action, internalMutation, mutation, query, ActionCtx, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { verifyTurnstileToken, normalizeRequiredText, normalizeText } from "./websites";
import { normalizePhone } from "./marketplaceRequests";
import { rateLimiter } from "./rateLimit";
import { notifyByPermission } from "./utils/notifications";
import { PERMISSIONS } from "./utils/permissions";
import { requireTenantAuth } from "./utils/tenancy";
import { resolveGeneratedLeadAssignee, getOrCreateMarketplaceBuyerCustomer } from "./utils/leadAssignment";

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

async function enforceTradeInRateLimit(
  ctx: ActionCtx | MutationCtx,
  name: "marketplaceTradeInFingerprint" | "marketplaceTradeInContact",
  key: string
) {
  const status = await rateLimiter.limit(ctx, name, { key });
  if (!status.ok) {
    throw new ConvexError("Too many submissions. Please try again later.");
  }
}

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
    const clientFingerprint = normalizeRequiredText(args.clientFingerprint, "Client fingerprint", MAX_FINGERPRINT_CHARS);
    await verifyTurnstileToken(args.turnstileToken);
    await enforceTradeInRateLimit(ctx, "marketplaceTradeInFingerprint", clientFingerprint);

    const normalizedPhone = normalizePhone(args.buyerPhone, "Phone");
    await enforceTradeInRateLimit(ctx, "marketplaceTradeInContact", normalizedPhone);

    const { turnstileToken: _turnstileToken, ...requestArgs } = args;
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
    const profile = await ctx.db
      .query("marketplaceDealerProfiles")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
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
export const getStatusForBuyer = query({
  args: { tradeInRequestId: v.id("marketplaceTradeInRequests"), buyerPhone: v.string() },
  handler: async (ctx, args) => {
    const tradeIn = await ctx.db.get(args.tradeInRequestId);
    if (!tradeIn) return null;
    const normalizedPhone = normalizePhone(args.buyerPhone, "Phone");
    if (tradeIn.buyerPhone !== normalizedPhone) return null;

    return {
      status: tradeIn.status,
      offerAmountJod: tradeIn.offerAmountJod ?? null,
      currentMake: tradeIn.currentMake,
      currentModel: tradeIn.currentModel,
      currentYear: tradeIn.currentYear,
    };
  },
});

/** Public: buyer accepts an offer — creates an attributed lead in the dealer's existing pipeline (same as marketplaceResponses.respond), phone-gated. No Purchase Order is created: Phase 34 (Purchase Orders) doesn't exist in this codebase yet, so this stays a lead like every other marketplace conversion until that phase ships. */
export const acceptOffer = mutation({
  args: { tradeInRequestId: v.id("marketplaceTradeInRequests"), buyerPhone: v.string() },
  handler: async (ctx, args): Promise<{ leadId: Id<"leads"> }> => {
    const tradeIn = await ctx.db.get(args.tradeInRequestId);
    if (!tradeIn) throw new ConvexError("Trade-in request not found.");
    const normalizedPhone = normalizePhone(args.buyerPhone, "Phone");
    if (tradeIn.buyerPhone !== normalizedPhone) throw new ConvexError("Trade-in request not found.");
    if (tradeIn.status !== "OFFERED") throw new ConvexError("This trade-in request has no active offer.");

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

    await ctx.db.patch(args.tradeInRequestId, { status: "ACCEPTED", respondedAt: Date.now(), leadId });

    return { leadId };
  },
});

/** Public: buyer declines an offer, phone-gated. */
export const declineOffer = mutation({
  args: { tradeInRequestId: v.id("marketplaceTradeInRequests"), buyerPhone: v.string() },
  handler: async (ctx, args) => {
    const tradeIn = await ctx.db.get(args.tradeInRequestId);
    if (!tradeIn) throw new ConvexError("Trade-in request not found.");
    const normalizedPhone = normalizePhone(args.buyerPhone, "Phone");
    if (tradeIn.buyerPhone !== normalizedPhone) throw new ConvexError("Trade-in request not found.");
    if (tradeIn.status !== "OFFERED") throw new ConvexError("This trade-in request has no active offer.");

    await ctx.db.patch(args.tradeInRequestId, { status: "DECLINED", respondedAt: Date.now() });
  },
});
