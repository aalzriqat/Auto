import { v, ConvexError } from "convex/values";
import { query, MutationCtx, QueryCtx } from "./_generated/server";
import { mutation } from "./functions";
import { Doc, Id, TableNames } from "./_generated/dataModel";
import { paginationOptsValidator } from "convex/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";
import { checkTenantWriteLimit } from "./rateLimit";
import { validateInput } from "./utils/validation";
import { CreateDraftSaleSchema, CreateSaleSchema, UpdateSaleSchema } from "./validations/sales";
import { restoreVehicleFromSale } from "./utils/saleHelpers";
import { vehicleHasCostBasis } from "./utils/vehicleCost";
import { deriveCommissionStatus, isCommissionOwed } from "./utils/commission";
import { completeExistingSale, completeSale, completeSalesForLineItems, computeAutoCommissionAmount, createDraftSale } from "./utils/saleCompletion";
import { cancelCompletedSaleOperationalRecords } from "./utils/saleCancellation";
import { runWithIdempotency } from "./utils/idempotency";
import { assertDifferentActors } from "./utils/financialGuards";
import { throwAppError, AppErrorCode } from "./utils/errors";
import { getOrgCurrency, hookCommissionAccrued, hookCommissionPaid, hookCommissionReversed, hookSaleCancelled } from "./accounting/workflowHooks";
import { normalizePaymentMethod, paymentMethodValidator } from "./utils/paymentMethods";
import { toMinorUnits, fromMinorUnits, assertFiniteNumber } from "./utils/money";

// ─── Validators ──────────────────────────────────────────────────────────────

const saleStatus = v.union(
  v.literal("PENDING"),
  v.literal("COMPLETED"),
  v.literal("CANCELLED")
);

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * Lists all sales for an organization, hydrated with related data.
 * Optionally filters by salesperson.
 */
export const list = query({
  args: {
    orgId: v.id("organizations"),
    salespersonId: v.optional(v.id("users")),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    let pageResult;

    if (args.salespersonId) {
      pageResult = await ctx.db
        .query("sales")
        .withIndex("by_org_salesperson", (q) =>
          q.eq("orgId", args.orgId).eq("salespersonId", args.salespersonId!)
        )
        .filter((q) => q.neq(q.field("isDeleted"), true))
        .paginate(args.paginationOpts);
    } else {
      pageResult = await ctx.db
        .query("sales")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .filter((q) => q.neq(q.field("isDeleted"), true))
        .paginate(args.paginationOpts);
    }

    const page = await Promise.all(
      pageResult.page.map(async (sale) => {
        // Fetch the three hydration reads together — they are independent, and
        // awaiting them in sequence made each row cost three round trips
        // instead of one.
        const [vehicle, customer, salesperson] = await Promise.all([
          ctx.db.get(sale.vehicleId),
          ctx.db.get(sale.customerId),
          ctx.db.get(sale.salespersonId),
        ]);

        return {
          ...sale,
          vehicleSummary: vehicle
            ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`
            : "Unknown",
          vehicleVin: vehicle?.vin ?? "",
          customerName: customer
            ? `${customer.firstName} ${customer.lastName}`
            : "Unknown",
          salespersonName: salesperson?.name ?? salesperson?.email ?? "Unknown",
        };
      })
    );
    
    return { ...pageResult, page };
  },
});

/**
 * Gets a single sale by ID, fully hydrated.
 */
export const get = query({
  args: {
    orgId: v.id("organizations"),
    saleId: v.id("sales"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    const sale = await ctx.db.get(args.saleId);
    if (!sale || sale.isDeleted || sale.orgId !== args.orgId) {
      throwAppError(AppErrorCode.SALE_NOT_FOUND, "Sale not found in this organization.");
    }

    const vehicle = await ctx.db.get(sale.vehicleId);
    const customer = await ctx.db.get(sale.customerId);
    const salesperson = await ctx.db.get(sale.salespersonId);

    return {
      ...sale,
      vehicle,
      customer,
      salesperson: salesperson
        ? { _id: salesperson._id, name: salesperson.name, email: salesperson.email }
        : null,
    };
  },
});

/**
 * Reconstructs everything a completed sale triggered across the system —
 * vehicle status, GL postings, receivable/invoice, deposits applied,
 * commission accrual, and lead closure — for the read-only Sale Trail view.
 * See saleCompletion.ts:applySaleCompletionSideEffects for the write side.
 */
/**
 * Resolves a `?highlightId=` value to a sale in this org, or null.
 *
 * Notification rows are long-lived, and some already-delivered ones point at
 * /sales carrying a *vehicle* id rather than a sale id. `getSaleTrail` takes a
 * `v.id("sales")`, which rejects a foreign-table id at the argument validator
 * before any handler could be tolerant about it — so a stale link would error
 * the page rather than simply not opening anything. Normalising first keeps an
 * old or malformed link harmless.
 */
export const resolveSaleHighlight = query({
  args: {
    orgId: v.id("organizations"),
    highlightId: v.string(),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    const saleId = ctx.db.normalizeId("sales", args.highlightId);
    if (!saleId) return null;

    const sale = await ctx.db.get(saleId);
    if (!sale || sale.isDeleted || sale.orgId !== args.orgId) return null;

    return saleId;
  },
});

export const getSaleTrail = query({
  args: {
    orgId: v.id("organizations"),
    saleId: v.id("sales"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    const sale = await ctx.db.get(args.saleId);
    if (!sale || sale.isDeleted || sale.orgId !== args.orgId) {
      throwAppError(AppErrorCode.SALE_NOT_FOUND, "Sale not found in this organization.");
    }

    const [vehicle, customer, salesperson, lead] = await Promise.all([
      ctx.db.get(sale.vehicleId),
      ctx.db.get(sale.customerId),
      ctx.db.get(sale.salespersonId),
      sale.leadId ? ctx.db.get(sale.leadId) : null,
    ]);

    const receivable = sale.canonicalReceivableDocumentId
      ? await ctx.db.get(sale.canonicalReceivableDocumentId)
      : null;

    const allocations = receivable
      ? await ctx.db
          .query("paymentAllocations")
          .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", receivable._id))
          .collect()
      : [];
    const payments = await Promise.all(
      allocations
        .filter((a) => a.status === "ACTIVE")
        .map(async (a) => {
          const payment = await ctx.db.get(a.paymentId);
          return {
            amount: fromMinorUnits(a.amountMinor, a.currency),
            currency: a.currency,
            allocationDate: a.allocationDate,
            method: payment?.method ?? null,
          };
        })
    );

    const deposits = sale.quoteId
      ? (
          await ctx.db
            .query("deposits")
            .withIndex("by_quote", (q) => q.eq("quoteId", sale.quoteId!))
            .collect()
        ).filter((d) => d.status === "APPLIED")
      : [];

    const [saleJournalEntry, commissionJournalEntry] = await Promise.all([
      ctx.db
        .query("journalEntries")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", args.orgId).eq("sourceType", "sales").eq("sourceId", sale._id.toString())
        )
        .first(),
      sale.commissionAmount
        ? ctx.db
            .query("journalEntries")
            .withIndex("by_org_source", (q) =>
              q.eq("orgId", args.orgId).eq("sourceType", "sales").eq("sourceId", `commission_${sale._id}`)
            )
            .first()
        : null,
    ]);

    const supplierPayable = await ctx.db
      .query("vehicleSupplierPayables")
      .withIndex("by_sale", (q) => q.eq("saleId", sale._id))
      .first();

    const commissionPaidByUser = sale.commissionPaidBy ? await ctx.db.get(sale.commissionPaidBy) : null;

    return {
      sale,
      vehicle,
      customer,
      salespersonName: salesperson?.name ?? salesperson?.email ?? "Unknown",
      lead: lead ? { _id: lead._id, stage: lead.stage } : null,
      receivable,
      payments,
      deposits: deposits.map((d) => ({ amount: d.amount, resolvedAt: d.resolvedAt })),
      saleJournalEntry: saleJournalEntry
        ? { _id: saleJournalEntry._id, journalNumber: saleJournalEntry.journalNumber, postedAt: saleJournalEntry.postedAt, status: saleJournalEntry.status }
        : null,
      commissionJournalEntry: commissionJournalEntry
        ? { _id: commissionJournalEntry._id, journalNumber: commissionJournalEntry.journalNumber, postedAt: commissionJournalEntry.postedAt, status: commissionJournalEntry.status }
        : null,
      supplierPayable: supplierPayable
        ? { amountDue: supplierPayable.amountDue, currency: supplierPayable.currency, status: supplierPayable.status, sourcedFromName: supplierPayable.sourcedFromName }
        : null,
      commissionPaidByName: commissionPaidByUser?.name ?? commissionPaidByUser?.email ?? null,
    };
  },
});

// ─── Mutations ───────────────────────────────────────────────────────────────

/**
 * Completes a new sale record.
 * Validates all cross-references and marks the vehicle as SOLD.
 */
export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    customerId: v.id("customers"),
    salespersonId: v.id("users"),
    salePrice: v.number(),
    saleDate: v.number(),
    status: v.literal("COMPLETED"),
    quoteId: v.optional(v.id("quotes")),
    taxRate: v.optional(v.number()),
    taxAmount: v.optional(v.number()),
    dealerFees: v.optional(v.number()),
    downPayment: v.optional(v.number()),
    tradeInVehicleId: v.optional(v.id("vehicles")),
    tradeInValue: v.optional(v.number()),
    financingType: v.optional(v.union(v.literal("CASH"), v.literal("FINANCED"), v.literal("LEASE"))),
    loanAmount: v.optional(v.number()),
    apr: v.optional(v.number()),
    termMonths: v.optional(v.number()),
    warrantySold: v.optional(v.number()),
    warrantyCost: v.optional(v.number()),
    warrantyTermMonths: v.optional(v.number()),
    gapSold: v.optional(v.number()),
    gapCost: v.optional(v.number()),
    gapTermMonths: v.optional(v.number()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_SALES]);

    const statusLimit = await checkTenantWriteLimit(ctx, "create", args.orgId);
    if (!statusLimit.ok) {
      throwAppError(AppErrorCode.RATE_LIMIT_EXCEEDED, `Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    validateInput(CreateSaleSchema, args);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "sales.create",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
      },
      async () => await completeSale(ctx, { ...args, actorId: user._id })
    );
  },
});

/**
 * Completes a CASH quote's sale — the one and only path that registers a sale
 * for the sales wizard. Loops the quote's vehicleItems (one vehicle for the
 * common case, several for a multi-vehicle/fleet quote), completing one sale
 * row per vehicle, all sharing the quote's id.
 */
export const completeFromQuote = mutation({
  args: {
    orgId: v.id("organizations"),
    quoteId: v.id("quotes"),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_SALES]);

    const statusLimit = await checkTenantWriteLimit(ctx, "create", args.orgId);
    if (!statusLimit.ok) {
      throwAppError(AppErrorCode.RATE_LIMIT_EXCEEDED, `Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "sales.completeFromQuote",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({ quoteId: args.quoteId }),
      },
      async () => {
        const quote = await ctx.db.get(args.quoteId);
        if (!quote || quote.orgId !== args.orgId) {
          throw new ConvexError("Quote not found in this organization.");
        }
        if (quote.mode !== undefined && quote.mode !== "CASH") {
          throw new ConvexError(
            "Only cash quotes can be completed directly — financed quotes go through the finance application workflow."
          );
        }

        const vehicleItems = quote.vehicleItems ?? [{ vehicleId: quote.vehicleId, unitPrice: quote.vehiclePrice }];

        return await completeSalesForLineItems(ctx, {
          orgId: args.orgId,
          quoteId: quote._id,
          vehicleItems,
          customerId: quote.customerId,
          salespersonId: user._id,
          saleDate: Date.now(),
          downPayment: quote.downPayment,
          financingType: "CASH",
          idempotencyKey: args.idempotencyKey,
          actorId: user._id,
        });
      }
    );
  },
});

/**
 * Creates a PENDING sale draft without inventory, deposit, CRM, or accounting side effects.
 */
export const createDraft = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    customerId: v.id("customers"),
    salespersonId: v.id("users"),
    salePrice: v.number(),
    saleDate: v.number(),
    status: v.optional(v.literal("PENDING")),
    quoteId: v.optional(v.id("quotes")),
    taxRate: v.optional(v.number()),
    taxAmount: v.optional(v.number()),
    dealerFees: v.optional(v.number()),
    downPayment: v.optional(v.number()),
    tradeInVehicleId: v.optional(v.id("vehicles")),
    tradeInValue: v.optional(v.number()),
    financingType: v.optional(v.union(v.literal("CASH"), v.literal("FINANCED"), v.literal("LEASE"))),
    loanAmount: v.optional(v.number()),
    apr: v.optional(v.number()),
    termMonths: v.optional(v.number()),
    warrantySold: v.optional(v.number()),
    warrantyCost: v.optional(v.number()),
    warrantyTermMonths: v.optional(v.number()),
    gapSold: v.optional(v.number()),
    gapCost: v.optional(v.number()),
    gapTermMonths: v.optional(v.number()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_SALES]);

    const statusLimit = await checkTenantWriteLimit(ctx, "create", args.orgId);
    if (!statusLimit.ok) {
      throwAppError(AppErrorCode.RATE_LIMIT_EXCEEDED, `Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    validateInput(CreateDraftSaleSchema, args);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "sales.createDraft",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
      },
      async () => await createDraftSale(ctx, { ...args, actorId: user._id })
    );
  },
});

/**
 * Explicitly completes a PENDING sale draft and runs completion side effects once.
 */
export const completeDraft = mutation({
  args: {
    orgId: v.id("organizations"),
    saleId: v.id("sales"),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_SALES]);

    const statusLimit = await checkTenantWriteLimit(ctx, "standardApi", args.orgId);
    if (!statusLimit.ok) {
      throwAppError(AppErrorCode.RATE_LIMIT_EXCEEDED, `Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "sales.completeDraft",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
      },
      async () =>
        await completeExistingSale(ctx, {
          orgId: args.orgId,
          saleId: args.saleId,
          actorId: user._id,
          idempotencyKey: args.idempotencyKey,
        })
    );
  },
});

/**
 * Updates a sale's details (e.g. price correction, status change).
 * If status changes to CANCELLED, restores the vehicle to AVAILABLE.
 */
export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    saleId: v.id("sales"),
    salePrice: v.optional(v.number()),
    saleDate: v.optional(v.number()),
    status: v.optional(saleStatus),
    taxRate: v.optional(v.number()),
    taxAmount: v.optional(v.number()),
    dealerFees: v.optional(v.number()),
    downPayment: v.optional(v.number()),
    tradeInVehicleId: v.optional(v.id("vehicles")),
    tradeInValue: v.optional(v.number()),
    financingType: v.optional(v.union(v.literal("CASH"), v.literal("FINANCED"), v.literal("LEASE"))),
    loanAmount: v.optional(v.number()),
    apr: v.optional(v.number()),
    termMonths: v.optional(v.number()),
    warrantySold: v.optional(v.number()),
    warrantyCost: v.optional(v.number()),
    warrantyTermMonths: v.optional(v.number()),
    gapSold: v.optional(v.number()),
    gapCost: v.optional(v.number()),
    gapTermMonths: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_SALES]);

    const statusLimit = await checkTenantWriteLimit(ctx, "standardApi", args.orgId);
    if (!statusLimit.ok) {
      throwAppError(AppErrorCode.RATE_LIMIT_EXCEEDED, `Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    validateInput(UpdateSaleSchema, args);

    const sale = await ctx.db.get(args.saleId);
    if (!sale || sale.isDeleted || sale.orgId !== args.orgId) {
      throwAppError(AppErrorCode.SALE_NOT_FOUND, "Sale not found in this organization.");
    }
    if (args.status === "COMPLETED" && sale.status !== "COMPLETED") {
      throwAppError(
        AppErrorCode.VALIDATION_FAILED,
        "Use sales.completeDraft to complete a pending sale."
      );
    }
    const isCancellingCompletedSale = args.status === "CANCELLED" && sale.status === "COMPLETED";
    const hasCompletedSaleFinancialChange =
      args.salePrice !== undefined ||
      args.saleDate !== undefined ||
      args.taxRate !== undefined ||
      args.taxAmount !== undefined ||
      args.dealerFees !== undefined ||
      args.downPayment !== undefined ||
      args.tradeInVehicleId !== undefined ||
      args.tradeInValue !== undefined ||
      args.financingType !== undefined ||
      args.loanAmount !== undefined ||
      args.apr !== undefined ||
      args.termMonths !== undefined ||
      args.warrantySold !== undefined ||
      args.warrantyCost !== undefined ||
      args.warrantyTermMonths !== undefined ||
      args.gapSold !== undefined ||
      args.gapCost !== undefined ||
      args.gapTermMonths !== undefined;
    if (sale.status === "COMPLETED" && hasCompletedSaleFinancialChange) {
      throwAppError(
        AppErrorCode.SALE_ALREADY_COMPLETED,
        "Completed sale financial fields are locked. Cancel and recreate the sale or use a correction workflow."
      );
    }
    if (sale.status === "COMPLETED" && args.status !== undefined && args.status !== "COMPLETED" && !isCancellingCompletedSale) {
      throwAppError(AppErrorCode.SALE_ALREADY_COMPLETED, "Completed sales can only transition through cancellation.");
    }

    const patch: Record<string, unknown> = {};
    if (args.salePrice !== undefined) patch.salePrice = args.salePrice;
    if (args.saleDate !== undefined) patch.saleDate = args.saleDate;
    if (args.status !== undefined) patch.status = args.status;
    if (args.taxRate !== undefined) patch.taxRate = args.taxRate;
    if (args.taxAmount !== undefined) patch.taxAmount = args.taxAmount;
    if (args.dealerFees !== undefined) patch.dealerFees = args.dealerFees;
    if (args.downPayment !== undefined) patch.downPayment = args.downPayment;
    if (args.tradeInVehicleId !== undefined) patch.tradeInVehicleId = args.tradeInVehicleId;
    if (args.tradeInValue !== undefined) patch.tradeInValue = args.tradeInValue;
    if (args.financingType !== undefined) patch.financingType = args.financingType;
    if (args.loanAmount !== undefined) patch.loanAmount = args.loanAmount;
    if (args.apr !== undefined) patch.apr = args.apr;
    if (args.termMonths !== undefined) patch.termMonths = args.termMonths;
    if (args.warrantySold !== undefined) patch.warrantySold = args.warrantySold;
    if (args.warrantyCost !== undefined) patch.warrantyCost = args.warrantyCost;
    if (args.warrantyTermMonths !== undefined) patch.warrantyTermMonths = args.warrantyTermMonths;
    if (args.gapSold !== undefined) patch.gapSold = args.gapSold;
    if (args.gapCost !== undefined) patch.gapCost = args.gapCost;
    if (args.gapTermMonths !== undefined) patch.gapTermMonths = args.gapTermMonths;

    if (args.status === "CANCELLED" && sale.status !== "CANCELLED") {
      await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_REQUESTS]);
      assertDifferentActors(
        user._id,
        sale.salespersonId,
        "Salesperson cannot approve cancellation of their own sale."
      );
      const cancellationDate = Date.now();
      // Only a sale that actually COMPLETED has operational records to reverse.
      // This branch used to run for any non-CANCELLED sale, which included
      // PENDING drafts — and createDraft explicitly performs no inventory,
      // deposit, CRM or accounting side effects, so there was nothing to undo.
      // Running the reversal anyway wiped the trade-in vehicle's own
      // purchasePrice (restoreTradeInVehicle clears it once tradeInValue > 0),
      // destroying real acquisition cost that feeds capitalized cost, COGS and
      // margin. Cancelling a draft is now just a status change, which is the
      // correct semantics for work that was never done.
      if (sale.status === "COMPLETED") {
        await cancelCompletedSaleOperationalRecords(ctx, {
          orgId: args.orgId,
          sale,
          actorId: user._id,
          reason: "Sale cancelled",
          reversalDate: cancellationDate,
        });
        // Post reversal journal entry for the original SALE_COMPLETED GL event
        await hookSaleCancelled(ctx, {
          orgId: args.orgId,
          saleId: args.saleId,
          reason: "Sale cancelled",
          actorId: user._id,
          reversalDate: cancellationDate,
        });
        if (sale.commissionAmount != null && sale.commissionAmount > 0) {
          await hookCommissionReversed(ctx, {
            orgId: args.orgId,
            saleId: args.saleId,
            reason: "Sale cancelled",
            actorId: user._id,
            reversalDate: cancellationDate,
          });
        }
      }
    }

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.saleId, patch);
    }

    if (Object.keys(patch).length > 0) {
      const actorName = await getActorName(ctx);
      await notifyManagers(
        ctx,
        args.orgId,
        "sale.updated",
        { actorName },
        { link: `/${args.orgId}/sales?highlightId=${args.saleId}` }
      );
    }
  },
});

/**
 * Soft deletes a sale record. Only CANCELLED or PENDING sales can be deleted.
 * Restores the vehicle to AVAILABLE if it was marked SOLD.
 */
// TODO: Add admin recovery endpoint if needed
export const softDelete = mutation({
  args: {
    orgId: v.id("organizations"),
    saleId: v.id("sales"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.DELETE_SALES]);
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throwAppError(AppErrorCode.UNAUTHENTICATED, "Unauthenticated");

    const statusLimit = await checkTenantWriteLimit(ctx, "standardApi", args.orgId);
    if (!statusLimit.ok) {
      throwAppError(AppErrorCode.RATE_LIMIT_EXCEEDED, `Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    const sale = await ctx.db.get(args.saleId);
    if (!sale || sale.isDeleted || sale.orgId !== args.orgId) {
      throwAppError(AppErrorCode.SALE_NOT_FOUND, "Sale not found in this organization.");
    }

    if (sale.status === "COMPLETED") {
      throwAppError(AppErrorCode.SALE_ALREADY_COMPLETED, "Cannot delete a completed sale. Cancel it first.");
    }

    await restoreVehicleFromSale(ctx, sale.vehicleId);

    await ctx.db.patch(args.saleId, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: identity.subject
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "sale.deleted",
      { actorName }
    );
  },
});

// ─── Commission Queries & Mutations ──────────────────────────────────────────

/**
 * How many commission rows a single page load may hydrate. Each row costs a
 * vehicle, a customer and a salesperson read, and every Convex function has a
 * hard ceiling on database calls — so an unbounded list does not degrade
 * gracefully at scale, it fails outright once a dealership has enough history.
 * The newest sales win the budget; older ones are reached with the filters.
 */
const COMMISSION_PAGE_DEFAULT = 300;
const COMMISSION_PAGE_MAX = 1000;

/**
 * Caches the in-flight promise rather than the resolved document. The hydration
 * loop runs its rows concurrently, so a cache that only records the value after
 * its own `await` is populated too late to prevent any of the duplicate reads it
 * exists for.
 */
function makeDocCache<T extends TableNames>(ctx: QueryCtx) {
  const cache = new Map<string, Promise<Doc<T> | null>>();
  return (id: Id<T>): Promise<Doc<T> | null> => {
    const hit = cache.get(id);
    if (hit) return hit;
    const pending = ctx.db.get(id);
    cache.set(id, pending);
    return pending;
  };
}

export const listCommissions = query({
  args: {
    orgId: v.id("organizations"),
    salespersonId: v.optional(v.id("users")),
    // "unpaid" keeps its original meaning — everything not yet settled, which
    // includes the not-yet-decided rows. "not_set" is a strictly narrower view
    // of the same set (the manager's review queue), not a replacement for it.
    paidStatus: v.optional(
      v.union(v.literal("paid"), v.literal("unpaid"), v.literal("not_set"))
    ),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { user, role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_COMMISSIONS]);

    // Without MANAGE_COMMISSIONS, a salesperson can only see their own
    // commissions — ignore whatever salespersonId was requested and force
    // it to the caller, regardless of org-wide view requested via "all".
    const canViewAll = role.permissions.includes(PERMISSIONS.MANAGE_COMMISSIONS);
    const salespersonId = canViewAll ? args.salespersonId : user._id;

    // In an automatic mode, a completed sale whose vehicle has no recorded cost
    // basis earns 0 commission (see C3 in saleCompletion). Surface those rows
    // too — flagged — so a manager notices the missing cost and can fix it.
    const orgSettings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
    const mode = orgSettings?.commissionMode ?? "AUTO_MEMBER";
    const isAutoMode = mode === "AUTO_MEMBER" || mode === "AUTO_TIERS";
    // MANUAL mode has no calculator: an amount only ever exists because somebody
    // typed it on this page. Listing only sales that already carry one is a
    // closed loop — the first amount can never be entered. So in MANUAL mode
    // every completed sale is listed, and the ones still undecided are the work
    // queue rather than an absence of records.
    const isManualMode = mode === "MANUAL";

    // Convex accepts NaN and ±Infinity for a v.number(), and every comparison
    // against NaN is false — so `candidates.length >= limit` would never break
    // the walk below and the page would read every sale in the org, which is
    // exactly the failure the bound exists to prevent. Anything not finite
    // falls back to the default rather than silently disabling the cap.
    const requested = args.limit;
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(Math.floor(requested as number), 1), COMMISSION_PAGE_MAX)
      : COMMISSION_PAGE_DEFAULT;

    // Walk the index newest-first and stop once the page is full, so the number
    // of documents this query touches is bounded by `limit` rather than by how
    // long the dealership has been trading. A sale can only make the list if it
    // already carries a commission, it's a completed sale in MANUAL mode
    // (decided or not), or (auto mode) it's a completed sale that might be
    // flagged for a missing cost basis. Everything else — drafts, cancelled
    // sales with no commission — is skipped before any vehicle read.
    const salesQuery = salespersonId
      ? ctx.db
          .query("sales")
          .withIndex("by_org_salesperson", (q) =>
            q.eq("orgId", args.orgId).eq("salespersonId", salespersonId)
          )
      : ctx.db.query("sales").withIndex("by_org_saleDate", (q) => q.eq("orgId", args.orgId));

    const candidates: Doc<"sales">[] = [];
    for await (const sale of salesQuery.order("desc")) {
      if (sale.isDeleted) continue;
      const isVoid = sale.status === "CANCELLED" && (sale.commissionAmount ?? 0) > 0;
      const isCandidate =
        isCommissionOwed(sale) ||
        (sale.status === "COMPLETED" && sale.commissionPaidAt != null) ||
        // A cancelled sale keeps its amount as history. It is listed so the
        // record does not silently vanish, but it owes nothing — every total,
        // every action and the unpaid filter below exclude it.
        isVoid ||
        (isAutoMode && sale.status === "COMPLETED" && sale.commissionAmount == null) ||
        (isManualMode && sale.status === "COMPLETED");
      if (!isCandidate) continue;
      // The status filter reads only stored fields, so applying it here instead
      // of after hydration means the page budget is spent entirely on rows the
      // caller actually asked for — the review queue in particular must never
      // be emptied just because the newest sales happen to be decided.
      // "unpaid" means still settleable and not yet settled; "not_set" narrows
      // that to the rows awaiting a decision.
      if (args.paidStatus === "paid" && sale.commissionPaidAt == null) continue;
      if (args.paidStatus === "unpaid" && (sale.commissionPaidAt != null || isVoid)) continue;
      if (
        args.paidStatus === "not_set" &&
        (sale.commissionPaidAt != null || sale.commissionAmount != null || isVoid)
      ) {
        continue;
      }
      candidates.push(sale);
      if (candidates.length >= limit) break;
    }

    const getVehicle = makeDocCache<"vehicles">(ctx);
    const getCustomer = makeDocCache<"customers">(ctx);
    const getUser = makeDocCache<"users">(ctx);

    const hydrated = await Promise.all(
      candidates.map(async (sale) => {
        const vehicle = await getVehicle(sale.vehicleId);
        // Only ever flag a sale whose commission was NEVER computed
        // (commissionAmount == null). A sale that already carries a real
        // commission — even if the vehicle's cost is later cleared — keeps its
        // amount and its Pay action and must not be pulled back into remediation.
        const missingPurchaseCost =
          isAutoMode &&
          sale.status === "COMPLETED" &&
          sale.commissionAmount == null &&
          (!vehicle || !vehicleHasCostBasis(vehicle));
        // The follow-up state to missingPurchaseCost: the cost has since been
        // fixed on the vehicle, but this sale completed while it was missing so
        // its commission was never computed (commissionAmount == null — AUTO
        // completion always stores a number, even 0, when a cost basis exists).
        // Surfaced so a manager can run recalculateCommission on it.
        const needsRecalculation =
          isAutoMode &&
          sale.status === "COMPLETED" &&
          sale.commissionPaidAt == null &&
          sale.commissionAmount == null &&
          vehicle != null &&
          vehicleHasCostBasis(vehicle);
        return { sale, vehicle, missingPurchaseCost, needsRecalculation };
      })
    );

    // Include sales that still owe a commission, the ones already settled, the
    // flagged AUTO fix-up rows, and (MANUAL) every completed sale so the
    // undecided ones are reachable at all.
    const listed = hydrated.filter(
      (h) =>
        isCommissionOwed(h.sale) ||
        (h.sale.status === "COMPLETED" && h.sale.commissionPaidAt != null) ||
        (h.sale.status === "CANCELLED" && (h.sale.commissionAmount ?? 0) > 0) ||
        h.missingPurchaseCost ||
        h.needsRecalculation ||
        (isManualMode && h.sale.status === "COMPLETED")
    );

    // Payroll only ever sweeps commissions for members who are still active
    // (collectUnpaidCommissions), and approval hard-rejects a run containing an
    // offboarded one. Opening the manual entry point makes it possible to enter
    // an amount for someone who has left, which would then sit as "pending"
    // forever with no error anywhere. Team size is small, so one collect here
    // buys an honest warning on the row. See PR 3 for actually settling them.
    const offboardedMemberIds = new Set(
      (
        await ctx.db
          .query("memberships")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .collect()
      )
        .filter((m) => m.offboardingStatus)
        .map((m) => m.userId as string)
    );

    return await Promise.all(
      listed.map(async ({ sale, vehicle, missingPurchaseCost, needsRecalculation }) => {
        const customer = await getCustomer(sale.customerId);
        const salesperson = await getUser(sale.salespersonId);
        const paidBy = sale.commissionPaidBy ? await getUser(sale.commissionPaidBy) : null;
        // Whether an edit is worth OFFERING — not a guarantee that it will be
        // accepted. setCommissionAmount also refuses once the amount is on the
        // books, and no query result can be authoritative about that: another
        // manager's payroll approval can land between this render and the
        // click. The mutation is the authority; the client surfaces its reason.
        const canSetAmount =
          isManualMode && sale.status === "COMPLETED" && sale.commissionPaidAt == null;
        return {
          ...sale,
          vehicleSummary: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : "Unknown",
          customerName: customer ? `${customer.firstName} ${customer.lastName}` : "Unknown",
          salespersonName: salesperson?.name ?? salesperson?.email ?? "Unknown",
          paidByName: paidBy?.name ?? paidBy?.email ?? null,
          missingPurchaseCost,
          needsRecalculation,
          commissionStatus: deriveCommissionStatus(sale),
          canSetAmount,
          salespersonOffboarded: offboardedMemberIds.has(sale.salespersonId),
        };
      })
    );
  },
});

/**
 * True once this sale's commission has been recognized in the ledger — either a
 * posted COMMISSION_ACCRUED journal entry or a still-queued accrual in the
 * outbox. AUTO modes accrue at completion; MANUAL accrues at payment. Used to
 * keep a MANUAL amount editable only while it hasn't yet hit the books.
 */
async function hasCommissionAccrual(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  saleId: Id<"sales">
): Promise<boolean> {
  // Only an ACTIVE accrual locks the amount. A REVERSED event means the
  // accrual was backed out (e.g. the sale was voided) — the error message's
  // "reverse it before changing the amount" promise must actually unlock then.
  const posted = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_source", (q) =>
      q.eq("orgId", orgId).eq("sourceType", "sales").eq("sourceId", `commission_${saleId}`)
    )
    .filter((q) =>
      q.and(q.eq(q.field("eventType"), "COMMISSION_ACCRUED"), q.neq(q.field("status"), "REVERSED"))
    )
    .first();
  if (posted) return true;
  // Outbox rows persist after being processed (status POSTED) — a processed
  // row's accrual is already covered by the accountingEvents check above, so
  // only a still-queued (PENDING/FAILED) row counts as an accrual here.
  const pending = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", orgId).eq("idempotencyKey", `commission_accrued_${saleId}`)
    )
    .filter((q) => q.neq(q.field("status"), "POSTED"))
    .first();
  return pending !== null;
}

export const markCommissionPaid = mutation({
  args: {
    orgId: v.id("organizations"),
    saleId: v.id("sales"),
    paymentMethod: v.optional(paymentMethodValidator),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_COMMISSIONS]);
    const paymentMethod = normalizePaymentMethod(args.paymentMethod);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "sales.markCommissionPaid",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({ saleId: args.saleId, paymentMethod }),
      },
      async () => {
        const sale = await ctx.db.get(args.saleId);
        if (!sale || sale.isDeleted || sale.orgId !== args.orgId) {
          throw new ConvexError("Sale not found.");
        }
        if (sale.commissionPaidAt != null) {
          throw new ConvexError("Commission already marked as paid.");
        }
        if (sale.status !== "COMPLETED") {
          throwAppError(AppErrorCode.VALIDATION_FAILED, "Only completed sale commissions can be paid.");
        }
        if (sale.commissionAmount == null || sale.commissionAmount <= 0) {
          throwAppError(AppErrorCode.VALIDATION_FAILED, "This sale has no commission amount to pay.");
        }

        const now = Date.now();
        await ctx.db.patch(args.saleId, {
          commissionPaidAt: now,
          commissionPaidBy: user._id,
          commissionPaymentMethod: paymentMethod,
          commissionPaymentIdempotencyKey: args.idempotencyKey,
        });
        const currency = await getOrgCurrency(ctx, args.orgId);
        const amountMinor = toMinorUnits(sale.commissionAmount, currency);
        // Recognize the expense before paying it. AUTO modes already accrued at
        // completion (this is an idempotent no-op — same idempotency key);
        // MANUAL accrues here for the first time, so the payment always clears a
        // real Commission Payable instead of pushing it negative (fixes C1).
        await hookCommissionAccrued(ctx, {
          orgId: args.orgId,
          saleId: args.saleId,
          salespersonId: sale.salespersonId,
          amountMinor,
          currency,
          actorId: user._id,
          occurredAt: now,
        });
        await hookCommissionPaid(ctx, {
          orgId: args.orgId,
          saleId: args.saleId,
          salespersonId: sale.salespersonId,
          amountMinor,
          currency,
          paymentMethod,
          actorId: user._id,
          occurredAt: now,
        });

        return args.saleId;
      }
    );
  },
});

export const markCommissionUnpaid = mutation({
  args: {
    orgId: v.id("organizations"),
    saleId: v.id("sales"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_COMMISSIONS]);

    const sale = await ctx.db.get(args.saleId);
    if (!sale || sale.isDeleted || sale.orgId !== args.orgId) {
      throw new ConvexError("Sale not found.");
    }
    if (sale.commissionPaidAt != null) {
      throwAppError(
        AppErrorCode.VALIDATION_FAILED,
        "Paid commissions are locked. Use a reversal workflow before marking them unpaid."
      );
    }

    await ctx.db.patch(args.saleId, {
      commissionPaidAt: undefined,
      commissionPaidBy: undefined,
    });
  },
});

export const setCommissionAmount = mutation({
  args: {
    orgId: v.id("organizations"),
    saleId: v.id("sales"),
    commissionAmount: v.number(),
  },
  handler: async (ctx, args) => {
    try {
      await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_COMMISSIONS]);

      // `Math.max(0, NaN)` is NaN, so without this the sale's commission is set
      // to NaN permanently: every downstream `> 0` / `<= 0` guard reads false,
      // so it is never accrued, never paid, and never reported as outstanding.
      assertFiniteNumber(args.commissionAmount, "commission amount");
      // Clamping a negative to zero would silently record a different decision
      // than the one that was made. Reject it so the mistake is visible.
      if (args.commissionAmount < 0) {
        throwAppError(AppErrorCode.VALIDATION_FAILED, "Commission amount cannot be negative.");
      }

      const sale = await ctx.db.get(args.saleId);
      if (!sale || sale.isDeleted || sale.orgId !== args.orgId) {
        throw new ConvexError("Sale not found.");
      }
      if (sale.commissionPaidAt != null) {
        throwAppError(AppErrorCode.VALIDATION_FAILED, "Paid commission amounts cannot be changed.");
      }
      // A cancelled sale earns nothing. Its accrual is reversed at cancellation
      // and no settlement path (payroll or direct) will ever pick it up, so an
      // amount set here would be an unpayable number sitting on the books.
      if (sale.status === "CANCELLED") {
        throwAppError(
          AppErrorCode.VALIDATION_FAILED,
          "A cancelled sale cannot be given a commission."
        );
      }

      const orgSettings = await ctx.db
        .query("orgSettings")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .unique();
      const mode = orgSettings?.commissionMode ?? "AUTO_MEMBER";

      // AUTO-mode commissions are derived and accrued at completion, so they
      // stay locked afterwards. MANUAL commissions are entered by hand and
      // accrue only at payment, so they remain editable on a completed sale
      // until they're paid or otherwise recorded in the ledger (fixes C1/C2 for
      // MANUAL).
      if (sale.status === "COMPLETED" && mode !== "MANUAL") {
        throwAppError(
          AppErrorCode.SALE_ALREADY_COMPLETED,
          "Completed sale commission amounts are locked. Use a correction workflow."
        );
      }
      if (await hasCommissionAccrual(ctx, args.orgId, args.saleId)) {
        throwAppError(
          AppErrorCode.VALIDATION_FAILED,
          "This commission is already recorded in the ledger. Reverse it before changing the amount."
        );
      }

      await ctx.db.patch(args.saleId, {
        commissionAmount: args.commissionAmount,
      });
    } catch (error) {
      // Routine validation rejections are ConvexErrors — re-throw them without
      // logging so only genuinely unexpected failures hit error monitoring.
      if (error instanceof ConvexError) throw error;
      console.error("sales.setCommissionAmount failed", error);
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

/**
 * The remediation path for C3: a sale that completed while its vehicle had no
 * recorded cost basis earned no commission (commissionAmount stayed null and
 * nothing accrued). Once a manager fixes the vehicle's cost, this recomputes
 * the commission under the CURRENT auto rules and posts the accrual the
 * completion skipped. One-shot by design: once an amount exists or an accrual
 * is on the books, changes go through the normal locked/correction flow.
 */
export const recalculateCommission = mutation({
  args: {
    orgId: v.id("organizations"),
    saleId: v.id("sales"),
  },
  handler: async (ctx, args) => {
    try {
      const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_COMMISSIONS]);

      const sale = await ctx.db.get(args.saleId);
      if (!sale || sale.isDeleted || sale.orgId !== args.orgId) {
        throw new ConvexError("Sale not found.");
      }
      if (sale.status !== "COMPLETED") {
        throwAppError(AppErrorCode.VALIDATION_FAILED, "Only completed sales can be recalculated.");
      }
      if (sale.commissionPaidAt != null) {
        throwAppError(AppErrorCode.VALIDATION_FAILED, "Paid commissions cannot be recalculated.");
      }
      if (sale.commissionAmount != null) {
        throwAppError(
          AppErrorCode.VALIDATION_FAILED,
          "This sale already has a commission amount. Amount changes go through the correction workflow."
        );
      }

      const orgSettings = await ctx.db
        .query("orgSettings")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .unique();
      const mode = orgSettings?.commissionMode ?? "AUTO_MEMBER";
      if (mode !== "AUTO_MEMBER" && mode !== "AUTO_TIERS") {
        throwAppError(
          AppErrorCode.VALIDATION_FAILED,
          "Recalculation only applies to automatic commission modes. Set the amount directly in manual mode."
        );
      }
      if (await hasCommissionAccrual(ctx, args.orgId, args.saleId)) {
        throwAppError(
          AppErrorCode.VALIDATION_FAILED,
          "This commission is already recorded in the ledger."
        );
      }

      const vehicle = await ctx.db.get(sale.vehicleId);
      if (!vehicle || !vehicleHasCostBasis(vehicle)) {
        throwAppError(
          AppErrorCode.VALIDATION_FAILED,
          "The vehicle still has no recorded cost. Set its purchase cost first."
        );
      }

      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", sale.salespersonId))
        .unique();

      const amount = await computeAutoCommissionAmount(ctx, {
        salePrice: sale.salePrice,
        vehicle,
        commissionMode: mode,
        memberCommissionRate: membership?.commissionRate,
        commissionTiers: orgSettings?.commissionTiers ?? [],
      });
      // Cost basis was just verified, so the calculator always returns a number.
      const commissionAmount = amount ?? 0;
      await ctx.db.patch(args.saleId, { commissionAmount });

      if (commissionAmount > 0) {
        const currency = await getOrgCurrency(ctx, args.orgId);
        const now = Date.now();
        await hookCommissionAccrued(ctx, {
          orgId: args.orgId,
          saleId: args.saleId,
          salespersonId: sale.salespersonId,
          amountMinor: toMinorUnits(commissionAmount, currency),
          currency,
          actorId: user._id,
          occurredAt: now,
        });
      }
      return { commissionAmount };
    } catch (error) {
      // Routine validation rejections are ConvexErrors — re-throw them without
      // logging so only genuinely unexpected failures hit error monitoring.
      if (error instanceof ConvexError) throw error;
      console.error("sales.recalculateCommission failed", error);
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});
