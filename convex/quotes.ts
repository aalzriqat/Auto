import { v, ConvexError } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { advanceLeadStage } from "./utils/leadStageHelpers";
import { notifyUser, getActorName } from "./utils/notifications";
import { assertProfitApproved, quoteModeRequiresMinimumProfit } from "./utils/profitApproval";
import { canonicalRequestFingerprint } from "@autoflow/shared/quoteIdentity";
import {
  actingRootForQuoteOnVehicle,
  COMMITMENT_MESSAGES,
  rootIdForReservation,
  unresolvedRootMoneyMinor,
  validateReservationAdoption,
} from "./commitments";
import { getOrgCurrency } from "./accounting/workflowHooks";
import { amountToMinorOrThrow, normalizeCurrency } from "./utils/depositRecording";
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
     * The id of ONE submission attempt — kept across retries of that attempt,
     * rotated once the save is acknowledged.
     *
     * ⚠️ Deliberately NOT derived from the payload. Deriving it made the quote's
     * content its identity, so two legitimate intentions with identical terms
     * could never both exist. Idempotency answers "is this the same submission
     * whose response I lost", not "may this content exist more than once".
     */
    idempotencyKey: v.optional(v.string()),

    /**
     * NEW opens an independent deal lineage; REVISE continues an existing one
     * and requires `supersedesQuoteId`.
     *
     * Optional during the backend-first rollout, but the two are not
     * distinguishable from the payload — an edited resubmission without
     * `supersedesQuoteId` is an independent lineage, whatever it looks like to
     * the person who typed it — so supported callers state which they mean.
     */
    intent: v.optional(v.union(v.literal("NEW"), v.literal("REVISE"))),

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

    // ── Operation identity comes FIRST, right after auth ────────────────────
    //
    // ⚠️ This used to sit below the customer, vehicle, company, profit and lead
    // validations, and a comment above it claimed idempotency ran first. It did
    // not, and the gap was exactly the case idempotency exists for: the server
    // commits, the response is lost, and by the time the client retries a
    // manager has changed something the quote references — a minimum profit, a
    // finance company. The retry asks for nothing new, but it was re-validated
    // against the changed world and refused, leaving the caller unable to
    // recover a quote the server had already written.
    //
    // The derivation below is deliberately ARITHMETIC ONLY: first line item,
    // sum of line items. No database reads, so it cannot depend on mutable
    // state, which is what lets it run before the validations rather than
    // after them.
    const vehicleId =
      args.vehicleItems && args.vehicleItems.length > 0
        ? args.vehicleItems[0].vehicleId
        : args.vehicleId;
    const vehiclePrice =
      args.vehicleItems && args.vehicleItems.length > 0
        ? args.vehicleItems.reduce((sum, item) => sum + item.unitPrice, 0)
        : args.vehiclePrice;

    const { idempotencyKey: _operationKey, ...materialRequest } = args;
    const requestFingerprint = canonicalRequestFingerprint({
      ...materialRequest,
      vehicleId,
      vehiclePrice,
    });

    if (args.idempotencyKey) {
      const priorQuote = await ctx.db
        .query("quotes")
        .withIndex("by_org_idempotency", (q) =>
          q.eq("orgId", args.orgId).eq("idempotencyKey", args.idempotencyKey)
        )
        .first();
      if (priorQuote) {
        if (priorQuote.requestFingerprint !== requestFingerprint) {
          throw new ConvexError(
            "This save was already completed with different details. Reload the deal and submit the change as a new quote rather than reusing the same request."
          );
        }
        return priorQuote._id;
      }
    }

    const customer = await ctx.db.get(args.customerId);
    if (!customer || customer.orgId !== args.orgId) {
      throw new ConvexError("Customer not found in this organization.");
    }

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
      // `vehicleId` / `vehiclePrice` were already derived above, before the
      // idempotency check; this loop only validates that the line items are
      // real, distinct and in this organization.
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
    // Intent is stated, not inferred. REVISE without a predecessor would open
    // an independent lineage while the caller believed it was continuing one,
    // which is precisely how a deal's history fragments silently.
    if (args.intent === "REVISE" && !args.supersedesQuoteId) {
      throw new ConvexError(
        "A revision has to say which quote it replaces. Reload the deal and try again."
      );
    }
    if (args.intent === "NEW" && args.supersedesQuoteId) {
      throw new ConvexError(
        "A new quote cannot also supersede an existing one. Send it as a revision instead."
      );
    }

    let lineageRootId: Id<"commitmentRoots"> | undefined;
    /** The cars the predecessor was a deal for — each has its own root. */
    let predecessorVehicleItems: Array<{ vehicleId: Id<"vehicles"> }> | undefined;

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
      predecessorVehicleItems = predecessor.vehicleItems ?? [
        { vehicleId: predecessor.vehicleId },
      ];
      if (predecessor.rootId) {
        const root = await ctx.db.get(predecessor.rootId);
        if (root && root.headQuoteId && root.headQuoteId !== predecessor._id) {
          throw new ConvexError(COMMITMENT_MESSAGES.notTheHead);
        }
        lineageRootId = predecessor.rootId;

        // A requote may not price the deal BELOW what the customer has already
        // paid into it. Refused HERE, before the head advances — otherwise the
        // deal would be left pointing at a revision that was never allowed to
        // exist, holding more money than the car is now worth, with no way to
        // represent the difference.
        //
        // Deliberately not an automatic refund: handing money back is a
        // decision about somebody's money and belongs to a person, not to a
        // side effect of editing a price.
        const unresolvedMinor = await unresolvedRootMoneyMinor(ctx, predecessor.rootId);
        const orgCurrency = normalizeCurrency(await getOrgCurrency(ctx, args.orgId));
        const newHeadMinor = amountToMinorOrThrow(vehiclePrice, orgCurrency, "Quote amount");
        if (newHeadMinor < unresolvedMinor) {
          throw new ConvexError(
            "This deal already holds more of the customer's money than the new price. Resolve the deposit first — refund, forfeit or reallocate it — then requote."
          );
        }
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
      requestFingerprint,
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

      // ⚠️ EVERY root on the deal, not just the primary vehicle's.
      //
      // `lineageRootId` is the predecessor's own `rootId`, which on a
      // multi-vehicle deal belongs to the FIRST car only — the rest carry
      // lineage through their own claims. Advancing that one alone left the
      // second car's root headed by the superseded revision, and because
      // heading a root is what proves lineage, the successor could then prove
      // nothing about that car: the deal was refused its own second vehicle,
      // with a message saying it was committed to another deal. It was, in a
      // sense — to its own previous revision.
      const predecessorItems = predecessorVehicleItems ?? [];
      const rootIds = new Set<string>();
      if (lineageRootId) rootIds.add(lineageRootId);
      for (const item of predecessorItems) {
        const itemRootId = await actingRootForQuoteOnVehicle(
          ctx,
          args.orgId,
          args.supersedesQuoteId,
          item.vehicleId
        );
        if (itemRootId) rootIds.add(itemRootId);
      }

      for (const id of rootIds) {
        const rootId = id as Id<"commitmentRoots">;
        const root = await ctx.db.get(rootId);
        if (root) {
          await ctx.db.patch(rootId, {
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
