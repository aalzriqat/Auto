import { ConvexError, v } from "convex/values";
import { mutation, query, MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { PERMISSIONS } from "./utils/permissions";
import { requireTenantAuth } from "./utils/tenancy";

const MAX_NOTE_CHARS = 1000;
const MAX_LISTED_REQUESTS = 100;

const responseKindValidator = v.union(
  v.literal("HAVE_MATCH"),
  v.literal("HAVE_SIMILAR"),
  v.literal("CAN_SOURCE"),
  v.literal("NOT_AVAILABLE")
);

const FULFILLING_KINDS = new Set(["HAVE_MATCH", "HAVE_SIMILAR", "CAN_SOURCE"]);

/** Dashboard: requests matched to this org, each with the org's own most recent response (if any). */
export const listForOrg = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MARKETPLACE_RESPOND]);

    const matches = await ctx.db
      .query("marketplaceRequestMatches")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(MAX_LISTED_REQUESTS);

    const rows = await Promise.all(
      matches.map(async (match) => {
        const request = await ctx.db.get(match.requestId);
        if (!request) return null;

        const responses = await ctx.db
          .query("marketplaceResponses")
          .withIndex("by_request", (q) => q.eq("requestId", match.requestId))
          .collect();
        const ownResponses = responses
          .filter((r) => r.orgId === args.orgId)
          .sort((a, b) => b.createdAt - a.createdAt);

        return {
          requestId: request._id,
          status: request.status,
          buyerFirstName: request.buyerFirstName,
          buyerCity: request.buyerCity,
          make: request.make,
          model: request.model,
          yearMin: request.yearMin,
          yearMax: request.yearMax,
          priceMin: request.priceMin,
          priceMax: request.priceMax,
          paymentType: request.paymentType,
          monthlyBudget: request.monthlyBudget,
          buyerTimeframe: request.buyerTimeframe,
          buyerIntent: request.buyerIntent,
          matchedAt: match.matchedAt,
          latestResponse: ownResponses[0]
            ? { kind: ownResponses[0].kind, createdAt: ownResponses[0].createdAt }
            : null,
        };
      })
    );

    return rows.filter((row): row is NonNullable<typeof row> => row !== null);
  },
});

/** Dashboard: dealer replies to a matched request. Creates/attaches a lead in the org's existing pipeline. */
export const respond = mutation({
  args: {
    orgId: v.id("organizations"),
    requestId: v.id("marketplaceRequests"),
    kind: responseKindValidator,
    vehicleId: v.optional(v.id("vehicles")),
    offerPriceJod: v.optional(v.number()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MARKETPLACE_RESPOND]);

    const request = await ctx.db.get(args.requestId);
    if (!request) throw new ConvexError("Request not found.");
    if (request.status === "SPAM" || request.status === "EXPIRED") {
      throw new ConvexError("This request is no longer open.");
    }

    // A dealer may only respond to requests actually routed to them — never
    // the full request pool. See master plan A9.
    const match = await ctx.db
      .query("marketplaceRequestMatches")
      .withIndex("by_request", (q) => q.eq("requestId", args.requestId))
      .filter((q) => q.eq(q.field("orgId"), args.orgId))
      .unique();
    if (!match) throw new ConvexError("This request was not routed to your dealership.");

    if (args.vehicleId) {
      const vehicle = await ctx.db.get(args.vehicleId);
      if (!vehicle || vehicle.orgId !== args.orgId || vehicle.isDeleted) {
        throw new ConvexError("Vehicle not found.");
      }
    }

    const note = args.note?.trim().slice(0, MAX_NOTE_CHARS) || undefined;
    const now = Date.now();

    await ctx.db.insert("marketplaceResponses", {
      requestId: args.requestId,
      orgId: args.orgId,
      respondingUserId: user._id,
      kind: args.kind,
      vehicleId: args.vehicleId,
      offerPriceJod: args.offerPriceJod,
      note,
      createdAt: now,
    });

    if (FULFILLING_KINDS.has(args.kind) && request.status !== "FULFILLED") {
      await ctx.db.patch(args.requestId, { status: "FULFILLED" });
    }

    await updateResponseScore(ctx, args.orgId, match, now);

    let customerId = (
      await ctx.db
        .query("customers")
        .withIndex("by_org_phone", (q) => q.eq("orgId", args.orgId).eq("phone", request.buyerPhone))
        .first()
    )?._id;

    if (!customerId) {
      customerId = await ctx.db.insert("customers", {
        orgId: args.orgId,
        firstName: request.buyerFirstName,
        lastName: "Marketplace Buyer",
        phone: request.buyerPhone,
        whatsapp: request.buyerWhatsApp,
      });
    }

    const vehicleDescription = [request.make, request.model].filter(Boolean).join(" ") || "a vehicle";
    const noteLines = [
      `Marketplace request: buyer wants ${vehicleDescription} in ${request.buyerCity} (${request.paymentType}, ${request.buyerIntent} intent).`,
      `Dealer reply: ${args.kind}${args.offerPriceJod ? ` — offered ${args.offerPriceJod} JOD` : ""}.`,
    ];
    if (note) noteLines.push(note);

    const leadId = await ctx.db.insert("leads", {
      orgId: args.orgId,
      customerId,
      assignedUserId: user._id,
      vehicleId: args.vehicleId,
      source: "Marketplace request",
      sourceChannel: "marketplace",
      marketplaceRequestId: args.requestId,
      stage: "NEW",
      notes: noteLines.join(" "),
      createdBy: user._id,
    });

    return { leadId };
  },
});

async function updateResponseScore(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  match: Doc<"marketplaceRequestMatches">,
  respondedAt: number
) {
  const profile = await ctx.db
    .query("marketplaceDealerProfiles")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
  if (!profile) return;

  const responseMinutes = Math.max(0, (respondedAt - (match.notifiedAt ?? match.matchedAt)) / 60000);
  const previousTotal = profile.totalResponses;
  const previousAvg = profile.avgResponseMinutes ?? responseMinutes;
  const newAvg = (previousAvg * previousTotal + responseMinutes) / (previousTotal + 1);

  await ctx.db.patch(profile._id, {
    avgResponseMinutes: newAvg,
    totalResponses: previousTotal + 1,
    updatedAt: Date.now(),
  });
}
