import { v, ConvexError } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { advanceLeadStage } from "./utils/leadStageHelpers";
import { notifyUser, getActorName } from "./utils/notifications";
import { assertProfitApproved, quoteModeRequiresMinimumProfit } from "./utils/profitApproval";
import {
  COMMITMENT_MESSAGES,
  rootIdForReservation,
  validateReservationAdoption,
} from "./commitments";
import type { Id } from "./_generated/dataModel";

const quoteModeValidator = v.optional(v.union(
  v.literal("CASH"),
  v.literal("CONFIGURED_FINANCE_COMPANY"),
  v.literal("MANUAL_FINANCE_COMPANY"),
  v.literal("INTERNAL_INSTALLMENT"),
  v.literal("LEASE"),
));

export const listQuotesByCustomer = query({
  args: { 
    orgId: v.id("organizations"),
    customerId: v.id("customers") 
  },
  handler: async (ctx, { orgId, customerId }) => {
    await requireTenantAuth(ctx, orgId, [PERMISSIONS.VIEW_CUSTOMERS]);
    return await ctx.db
      .query("quotes")
      .withIndex("by_customer", (q) => q.eq("customerId", customerId))
      .filter((q) => q.eq(q.field("orgId"), orgId))
      .collect();
  },
});

export const get = query({
  args: {
    orgId: v.id("organizations"),
    quoteId: v.id("quotes"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_CUSTOMERS]);
    const quote = await ctx.db.get(args.quoteId);
    if (!quote || quote.orgId !== args.orgId) {
      throw new ConvexError("Quote not found.");
    }
    return quote;
  },
});

export const saveQuote = mutation({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    vehicleId: v.id("vehicles"),
    // When set (2+ vehicles, or several units of the same model), this is the
    // authoritative source for which vehicles/prices are on the quote —
    // vehicleId/vehiclePrice below are derived server-side from it and the
    // client-supplied values for them are ignored.
    vehicleItems: v.optional(v.array(v.object({
      vehicleId: v.id("vehicles"),
      unitPrice: v.number(),
    }))),
    companyId: v.optional(v.id("financeCompanies")),
    mode: quoteModeValidator,
    leadId: v.optional(v.id("leads")),
    vehiclePrice: v.number(),
    // The dealer margin the client is quoting. Absent is read as zero, so a
    // caller that omits it can never slip a below-minimum deal past the check.
    desiredProfit: v.optional(v.number()),
    downPayment: v.number(),
    termMonths: v.number(),
    totalFinancedAmount: v.optional(v.number()),
    monthlyInstallment: v.optional(v.number()),
    profitRateApplied: v.optional(v.number()),
    totalProfit: v.optional(v.number()),
    recipientName: v.optional(v.string()),
    manualProviderName: v.optional(v.string()),
    manualProfitRate: v.optional(v.number()),
    manualInsuranceRate: v.optional(v.number()),
    manualAdminFees: v.optional(v.number()),
    manualCommission: v.optional(v.number()),
    manualIncludesCommissionInDebt: v.optional(v.boolean()),

    // ── SCRUM-195 lineage (c14865) ───────────────────────────────────────────
    //
    // All three are OPTIONAL during the backend-first rollout so existing web
    // and mobile callers keep working while they migrate. That compatibility is
    // temporary by design: a caller that sends none of them is not cutover
    // ready, and the fallback cannot be removed until no supported legacy
    // caller remains.

    /**
     * Stable operation identity. An exact retry must return the SAME quote
     * rather than minting a second deal for one customer intention — a
     * duplicate root is not a cosmetic problem, it is a second claimant on the
     * same car.
     */
    idempotencyKey: v.optional(v.string()),

    /**
     * REVISE: the revision this quote replaces. Only the CURRENT head may be
     * superseded, checked as compare-and-swap, so two people renegotiating the
     * same deal concurrently cannot both win and silently make the loser's
     * price the deal.
     */
    supersedesQuoteId: v.optional(v.id("quotes")),

    /**
     * Explicit, server-validated proof that this quote adopts a reservation's
     * root.
     *
     * ⚠️ Adoption is never inferred from the customer matching. A customer may
     * legitimately hold a reservation and separately open an unrelated deal on
     * the same car, and treating those as one root lets the second consume the
     * first's vehicle. Omitting this leaves the quote on independent lineage,
     * which is exactly what makes it refusable later.
     */
    adoptReservationId: v.optional(v.id("vehicleReservations")),
  },
  handler: async (ctx, args) => {
    // A quote is an informational financing draft, not a committed sale —
    // gated to VIEW_SALES (held by SALES/MANAGER/ACCOUNTANT/OWNER) rather
    // than CREATE_SALES, which is reserved for finalizing an actual sale.
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    const customer = await ctx.db.get(args.customerId);
    if (!customer || customer.orgId !== args.orgId) {
      throw new ConvexError("Customer not found in this organization.");
    }

    let vehicleId = args.vehicleId;
    let vehiclePrice = args.vehiclePrice;

    if (args.vehicleItems && args.vehicleItems.length > 0) {
      const seen = new Set<string>();
      for (const item of args.vehicleItems) {
        if (item.unitPrice <= 0) {
          throw new ConvexError("Each vehicle in the quote must have a positive price.");
        }
        if (seen.has(item.vehicleId)) {
          throw new ConvexError("The same vehicle cannot be added twice to a quote.");
        }
        seen.add(item.vehicleId);
        const lineVehicle = await ctx.db.get(item.vehicleId);
        if (!lineVehicle || lineVehicle.orgId !== args.orgId) {
          throw new ConvexError("Vehicle not found in this organization.");
        }
      }
      vehicleId = args.vehicleItems[0].vehicleId;
      vehiclePrice = args.vehicleItems.reduce((sum, item) => sum + item.unitPrice, 0);
    } else {
      const vehicle = await ctx.db.get(args.vehicleId);
      if (!vehicle || vehicle.orgId !== args.orgId) {
        throw new ConvexError("Vehicle not found in this organization.");
      }
    }

    if (args.mode === "CONFIGURED_FINANCE_COMPANY" && !args.companyId) {
      throw new ConvexError("Configured finance company quotes require a finance company.");
    }

    if (args.mode !== undefined && args.mode !== "CONFIGURED_FINANCE_COMPANY" && args.companyId) {
      throw new ConvexError("Finance company can only be set for configured finance company quotes.");
    }

    if (args.companyId) {
      const company = await ctx.db.get(args.companyId);
      if (!company || company.orgId !== args.orgId) {
        throw new ConvexError("Finance company not found in this organization.");
      }
    }

    // The UI blocks a below-minimum financed quote unless a manager approved it;
    // enforce the same rule here so a direct API call, an older client, or the
    // mobile app cannot write one. Financed quotes are single-vehicle, so this
    // checks the resolved `vehicleId` rather than the line items.
    if (quoteModeRequiresMinimumProfit(args.mode)) {
      await assertProfitApproved(ctx, {
        orgId: args.orgId,
        vehicleId,
        desiredProfit: args.desiredProfit ?? 0,
        subject: "quote",
      });
    }

    if (args.leadId) {
      const lead = await ctx.db.get(args.leadId);
      if (!lead || lead.orgId !== args.orgId) {
        throw new ConvexError("Lead not found in this organization.");
      }
      if (lead.customerId !== args.customerId || (lead.vehicleId && lead.vehicleId !== vehicleId)) {
        throw new ConvexError("Lead does not match the quote customer and vehicle.");
      }
    }

    // ── SCRUM-195: identity, lineage and the current head ───────────────────

    // Idempotency first, so a retry never re-runs any of the work below. An
    // exact retry returns the SAME quote; a reused key carrying a materially
    // different payload is a conflict rather than a silent overwrite, because
    // the two callers disagree about what the deal is and only one can be right.
    if (args.idempotencyKey) {
      const priorQuote = await ctx.db
        .query("quotes")
        .withIndex("by_org_idempotency", (q) =>
          q.eq("orgId", args.orgId).eq("idempotencyKey", args.idempotencyKey)
        )
        .first();
      if (priorQuote) {
        const samePayload =
          priorQuote.customerId === args.customerId &&
          priorQuote.vehicleId === vehicleId &&
          priorQuote.vehiclePrice === vehiclePrice &&
          priorQuote.downPayment === args.downPayment &&
          priorQuote.termMonths === args.termMonths &&
          (priorQuote.mode ?? null) === (args.mode ?? null) &&
          (priorQuote.supersedesQuoteId ?? null) === (args.supersedesQuoteId ?? null);
        if (!samePayload) {
          throw new ConvexError(
            "This request id was already used for a different quote. Start a new revision instead of reusing it."
          );
        }
        return priorQuote._id;
      }
    }

    let lineageRootId: Id<"commitmentRoots"> | undefined;

    // REVISE. Compare-and-swap against the root's current head.
    if (args.supersedesQuoteId) {
      const predecessor = await ctx.db.get(args.supersedesQuoteId);
      if (!predecessor || predecessor.orgId !== args.orgId) {
        throw new ConvexError("The quote being revised was not found in this organization.");
      }
      if (predecessor.customerId !== args.customerId) {
        throw new ConvexError(
          "A revision has to stay on the same deal. That quote belongs to a different customer."
        );
      }
      // The CAS itself. `supersededByQuoteId` is the durable marker, so a
      // second reviser reading the same predecessor loses here rather than
      // quietly forking the deal into two live heads.
      if (predecessor.supersededByQuoteId) {
        throw new ConvexError(COMMITMENT_MESSAGES.notTheHead);
      }
      if (predecessor.rootId) {
        const root = await ctx.db.get(predecessor.rootId);
        if (root && root.headQuoteId && root.headQuoteId !== predecessor._id) {
          throw new ConvexError(COMMITMENT_MESSAGES.notTheHead);
        }
        lineageRootId = predecessor.rootId;
      }
    }

    // ADOPT. A reservation-origin deal joins the reservation's root, and only
    // through proof this server validated itself.
    if (args.adoptReservationId) {
      await validateReservationAdoption(ctx, {
        orgId: args.orgId,
        reservationId: args.adoptReservationId,
        customerId: args.customerId,
        vehicleId,
      });
      const reservationRootId = await rootIdForReservation(ctx, args.adoptReservationId);
      if (reservationRootId) lineageRootId = reservationRootId;
    }

    const {
      manualProviderName,
      manualProfitRate,
      manualInsuranceRate,
      manualAdminFees,
      manualCommission,
      manualIncludesCommissionInDebt,
      // Pulled out of the spread deliberately. The ARGUMENT is imperative —
      // "adopt this reservation" — while the stored FIELD is a record of what
      // happened, so they are named differently and only the stored form
      // belongs on the row.
      adoptReservationId,
      ...quoteArgs
    } = args;

    const quoteId = await ctx.db.insert("quotes", {
      ...quoteArgs,
      vehicleId,
      vehiclePrice,
      ...(lineageRootId ? { rootId: lineageRootId } : {}),
      ...(adoptReservationId ? { adoptedReservationId: adoptReservationId } : {}),
      // Always written, never left undefined: `applications.finalizeDeal` reads
      // its absence as "quote predates this check" and skips its re-verification.
      desiredProfit: args.desiredProfit ?? 0,
      ...(args.mode === "MANUAL_FINANCE_COMPANY" && manualProviderName !== undefined ? { manualProviderName } : {}),
      ...(args.mode === "MANUAL_FINANCE_COMPANY" && manualProfitRate !== undefined ? { manualProfitRate } : {}),
      ...(args.mode === "MANUAL_FINANCE_COMPANY" && manualInsuranceRate !== undefined ? { manualInsuranceRate } : {}),
      ...(args.mode === "MANUAL_FINANCE_COMPANY" && manualAdminFees !== undefined ? { manualAdminFees } : {}),
      ...(args.mode === "MANUAL_FINANCE_COMPANY" && manualCommission !== undefined ? { manualCommission } : {}),
      ...(args.mode === "MANUAL_FINANCE_COMPANY" && manualIncludesCommissionInDebt !== undefined ? { manualIncludesCommissionInDebt } : {}),
      status: "DRAFT",
      createdBy: user._id,
      createdAt: Date.now(),
    });

    // Advance the head ATOMICALLY with the insert — same mutation, same
    // transaction. Writing the successor and advancing the head in two steps
    // would leave a window where the root points at a revision that is no
    // longer current, and evidence written in that window would attach to the
    // wrong price.
    if (args.supersedesQuoteId) {
      await ctx.db.patch(args.supersedesQuoteId, { supersededByQuoteId: quoteId });
      if (lineageRootId) {
        const root = await ctx.db.get(lineageRootId);
        if (root) {
          await ctx.db.patch(lineageRootId, {
            headQuoteId: quoteId,
            revision: root.revision + 1,
          });
        }
      }
    }

    return quoteId;
  },
});

export const updateQuoteStatus = mutation({
  args: {
    orgId: v.id("organizations"),
    quoteId: v.id("quotes"),
    status: v.union(v.literal("DRAFT"), v.literal("SHARED"), v.literal("ACCEPTED"), v.literal("EXPIRED")),
  },
  handler: async (ctx, { orgId, quoteId, status }) => {
    await requireTenantAuth(ctx, orgId, [PERMISSIONS.VIEW_SALES]);
    const existing = await ctx.db.get(quoteId);
    if (!existing || existing.orgId !== orgId) throw new ConvexError("Not found");

    await ctx.db.patch(quoteId, { status });

    if (status === "SHARED" && existing.leadId) {
      await advanceLeadStage(ctx, {
        leadId: existing.leadId,
        targetStage: "NEGOTIATION",
        trigger: "Quote sent",
      });
    }

    if (status === "ACCEPTED") {
      const vehicle = await ctx.db.get(existing.vehicleId);
      const actorName = await getActorName(ctx);
      await notifyUser(
        ctx,
        orgId,
        existing.createdBy,
        "quote.accepted",
        {
          actorName,
          quoteLabel: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : "the quote",
        },
        { link: `/${orgId}/customers?highlightId=${existing.customerId}` }
      );
    }
  },
});
