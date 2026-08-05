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
import { auditLog } from "./financialAudit";
import { completeExistingSale, completeSale, completeSalesForLineItems, computeAutoCommissionAmount, createDraftSale } from "./utils/saleCompletion";
import { cancelCompletedSaleOperationalRecords } from "./utils/saleCancellation";
import { runWithIdempotency } from "./utils/idempotency";
import { assertDifferentActors } from "./utils/financialGuards";
import { throwAppError, AppErrorCode } from "./utils/errors";
import { getOrgCurrency, hookCommissionAccrued, hookCommissionAdjusted, hookCommissionPaid, hookSaleCancelled, isPostableNow, reverseCommissionForSale, commissionAccountingDate, commissionEntriesOutstandingStatus, recognizedCommissionMinor, safeAdjustmentSeq, MAX_COMMISSION_ADJUSTMENTS } from "./accounting/workflowHooks";
import { normalizePaymentMethod, paymentMethodValidator } from "./utils/paymentMethods";
import { toMinorUnits, fromMinorUnits, assertFiniteNumber } from "./utils/money";
import { checkPostingAllowed } from "./accountingPeriods";

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
        // Unconditional: reverseEventIfPosted no-ops when there is nothing on
        // the books and cancels anything still queued, so gating on the live
        // amount only created holes. A commission accrued and then corrected to
        // zero nets out in the GL but still owns real events — the old
        // `> 0` gate skipped it, leaving those events POSTED on a cancelled
        // sale and any queued entry free to post afterwards.
        await reverseCommissionForSale(ctx, {
          orgId: args.orgId,
          saleId: args.saleId,
          adjustmentSeq: sale.commissionAdjustmentSeq ?? 0,
          reason: "Sale cancelled",
          actorId: user._id,
          reversalDate: cancellationDate,
        });
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

/**
 * "unpaid" keeps its original meaning — everything not yet settled, which
 * includes the not-yet-decided rows. "not_set" is a strictly narrower view of
 * the same set (the manager's review queue), not a replacement for it.
 */
const commissionStatusFilter = v.optional(
  v.union(v.literal("paid"), v.literal("unpaid"), v.literal("not_set"))
);

async function commissionPage(
  ctx: QueryCtx,
  args: {
    orgId: Id<"organizations">;
    salespersonId?: Id<"users">;
    paidStatus?: "paid" | "unpaid" | "not_set";
  },
  paginationOpts: { numItems: number; cursor: string | null }
) {
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

    // Paginated on the sale-date index, newest first. A page reads a fixed
    // number of DOCUMENTS, not "however many it takes to find N matches" — the
    // difference matters most in the steady state a diligent manager creates,
    // where the review queue is empty and a match-counting scan would read the
    // dealership's entire history every time they open the page.
    //
    // The candidate rules run in JS rather than through `.filter()` so the page
    // size stays the read budget. A page may therefore come back short, or
    // empty, while more pages remain; that is what `isDone` is for.
    const salesQuery = salespersonId
      ? ctx.db
          .query("sales")
          .withIndex("by_org_salesperson_saleDate", (q) =>
            q.eq("orgId", args.orgId).eq("salespersonId", salespersonId)
          )
      : ctx.db.query("sales").withIndex("by_org_saleDate", (q) => q.eq("orgId", args.orgId));

    const pageResult = await salesQuery.order("desc").paginate(paginationOpts);

    const candidates = pageResult.page.filter((sale) => {
      if (sale.isDeleted) return false;
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
      if (!isCandidate) return false;
      // "unpaid" means still settleable and not yet settled; "not_set" narrows
      // that to the rows awaiting a decision.
      if (args.paidStatus === "paid" && sale.commissionPaidAt == null) return false;
      if (args.paidStatus === "unpaid" && (sale.commissionPaidAt != null || isVoid)) return false;
      if (
        args.paidStatus === "not_set" &&
        (sale.commissionPaidAt != null || sale.commissionAmount != null || isVoid)
      ) {
        return false;
      }
      return true;
    });

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

    // Payroll only ever sweeps commissions for members who are still ACTIVE
    // (collectUnpaidCommissions), and approval hard-rejects a run containing an
    // offboarded one. Opening the manual entry point makes it possible to enter
    // an amount for someone who has left, which would then sit as "pending"
    // forever with no error anywhere.
    //
    // Built as the set payroll actually uses rather than "memberships carrying
    // an offboardingStatus": finalizeMembershipOffboardingJob DELETES the
    // membership once removal succeeds, so testing for the in-progress flag
    // would report a fully-departed salesperson as fine — precisely the case
    // where payroll will never pay them. Absent from the set is the condition.
    // See PR 3 for actually settling them.
    // Looked up per distinct salesperson ON THIS PAGE rather than by collecting
    // the org's whole membership table: the page itself reads a bounded number
    // of sale documents, so a full scan here would be the only unbounded read
    // left on the path — and a caller walking N pages would repeat it N times.
    const pageSalespersonIds = [...new Set(listed.map((h) => h.sale.salespersonId))];
    const offboardedSalespersonIds = new Set(
      (
        await Promise.all(
          pageSalespersonIds.map(async (userId) => {
            const membership = await ctx.db
              .query("memberships")
              .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", userId))
              .unique();
            // Absent counts as offboarded: the finalizer DELETES the row once
            // external removal succeeds, which is exactly when payroll stops
            // paying them.
            return membership && !membership.offboardingStatus ? null : (userId as string);
          })
        )
      ).filter((id): id is string => id !== null)
    );

    const page = await Promise.all(
      listed.map(async ({ sale, vehicle, missingPurchaseCost, needsRecalculation }) => {
        const customer = await getCustomer(sale.customerId);
        const salesperson = await getUser(sale.salespersonId);
        const paidBy = sale.commissionPaidBy ? await getUser(sale.commissionPaidBy) : null;
        // Whether an edit is worth OFFERING — not a guarantee that it will be
        // accepted. An amount already on the books is no longer refused (it is
        // corrected with an adjusting entry), but setCommissionAmount still
        // rejects a change whose entries have not posted yet, and no query
        // result can be authoritative about that: the outbox can drain, or a
        // period close can land, between this render and the click. The
        // mutation is the authority; the client surfaces its reason.
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
          salespersonOffboarded: offboardedSalespersonIds.has(sale.salespersonId),
        };
      })
    );

  return { ...pageResult, page };
}

/**
 * The paginated contract. A page reads a fixed number of sale DOCUMENTS and
 * returns only those that belong on this screen, so it may come back short —
 * or empty — while more remain. Callers must walk `isDone`; see
 * `useTableControls` on the web and the load-more effect on mobile.
 */
export const listCommissionsPaginated = query({
  args: {
    orgId: v.id("organizations"),
    salespersonId: v.optional(v.id("users")),
    paidStatus: commissionStatusFilter,
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => commissionPage(ctx, args, args.paginationOpts),
});

/**
 * DEPRECATED, and kept alive only for mobile bundles that shipped before
 * `listCommissionsPaginated` existed. A published app updates on its own
 * schedule, so removing this at the same time as the backend deploy would break
 * the commissions screen for anyone who had not relaunched yet — there is no
 * deployment order that makes a breaking change to a live public query safe.
 *
 * Remove it once the OTA channel's adoption is complete.
 */
export const listCommissions = query({
  args: {
    orgId: v.id("organizations"),
    salespersonId: v.optional(v.id("users")),
    paidStatus: commissionStatusFilter,
  },
  handler: async (ctx, args) => {
    const { user, role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_COMMISSIONS]);
    const canViewAll = role.permissions.includes(PERMISSIONS.MANAGE_COMMISSIONS);
    const salespersonId = canViewAll ? args.salespersonId : user._id;

    // Unbounded, exactly as it was. Bounding it looked like an improvement and
    // is the opposite one: this reads DOCUMENTS, so a cap turns "200 recent
    // sales with no commission, then an older commissioned one" into an empty
    // answer — and a shipped bundle has no cursor to look past it. A slow
    // response is what these clients already had; a silently incomplete one is
    // new, invisible, and unfixable from their side.
    const sales = salespersonId
      ? await ctx.db
          .query("sales")
          .withIndex("by_org_salesperson", (q) =>
            q.eq("orgId", args.orgId).eq("salespersonId", salespersonId)
          )
          .filter((q) => q.neq(q.field("isDeleted"), true))
          .collect()
      : await ctx.db
          .query("sales")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .filter((q) => q.neq(q.field("isDeleted"), true))
          .collect();

    const orgSettings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
    const mode = orgSettings?.commissionMode ?? "AUTO_MEMBER";
    const isAutoMode = mode === "AUTO_MEMBER" || mode === "AUTO_TIERS";

    // The pre-pagination predicate, unchanged: a positive commission, or an
    // AUTO completed sale whose commission was never computed.
    const candidates = sales.filter(
      (sale) =>
        (sale.commissionAmount != null && sale.commissionAmount > 0) ||
        (isAutoMode && sale.status === "COMPLETED" && sale.commissionAmount == null)
    );

    const getVehicle = makeDocCache<"vehicles">(ctx);
    const getCustomer = makeDocCache<"customers">(ctx);
    const getUser = makeDocCache<"users">(ctx);

    const hydrated = await Promise.all(
      candidates.map(async (sale) => {
        const vehicle = await getVehicle(sale.vehicleId);
        const missingPurchaseCost =
          isAutoMode &&
          sale.status === "COMPLETED" &&
          sale.commissionAmount == null &&
          (!vehicle || !vehicleHasCostBasis(vehicle));
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

    const withCommission = hydrated.filter(
      (h) =>
        (h.sale.commissionAmount != null && h.sale.commissionAmount > 0) ||
        h.missingPurchaseCost ||
        h.needsRecalculation
    );

    const filtered =
      args.paidStatus === "paid"
        ? withCommission.filter((h) => h.sale.commissionPaidAt != null)
        : args.paidStatus === "unpaid"
          ? withCommission.filter((h) => h.sale.commissionPaidAt == null)
          : args.paidStatus === "not_set"
            ? withCommission.filter(
                (h) => h.sale.commissionPaidAt == null && h.sale.commissionAmount == null
              )
            : withCommission;

    return await Promise.all(
      filtered.map(async ({ sale, vehicle, missingPurchaseCost, needsRecalculation }) => {
        const customer = await getCustomer(sale.customerId);
        const salesperson = await getUser(sale.salespersonId);
        const paidBy = sale.commissionPaidBy ? await getUser(sale.commissionPaidBy) : null;
        return {
          ...sale,
          vehicleSummary: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : "Unknown",
          customerName: customer ? `${customer.firstName} ${customer.lastName}` : "Unknown",
          salespersonName: salesperson?.name ?? salesperson?.email ?? "Unknown",
          paidByName: paidBy?.name ?? paidBy?.email ?? null,
          missingPurchaseCost,
          needsRecalculation,
          // Present so a bundle built against the new shape still works if it
          // somehow reaches this endpoint; the old bundles simply ignore them.
          commissionStatus: deriveCommissionStatus(sale),
          canSetAmount: false,
        };
      })
    );
  },
});

/**
 * True once this sale's commission has been recognized in the ledger — either a
 * posted COMMISSION_ACCRUED journal entry or a still-queued accrual in the
 * outbox. Both AUTO and MANUAL accrue as soon as the amount is measurable on a
 * completed sale, so this decides whether a new amount is a FIRST accrual or a
 * correction to one already on the books (setCommissionAmount), and whether
 * recalculateCommission's one-shot fix-up still applies.
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

/**
 * Refuses to post a commission entry that would overtake its own prerequisites.
 *
 * Every entry that CLEARS Commission Payable (a payment) must land after the
 * entries that CREATED it (the accrual and any corrections). Those can be
 * sitting in the outbox — dated into a period that was closed when they were
 * raised — in which case posting the payment now debits a liability the GL does
 * not yet carry and drives Commission Payable negative until someone reopens
 * the month. Re-raising the accrual does not help: postOrEnqueue treats an
 * existing queued entry as the source of truth and returns without doing
 * anything, so the caller cannot tell by trying.
 *
 * Only enforced when this entry would ACTUALLY post now, which is all a
 * mutation can police — and it is deliberately NOT the whole defense. An entry
 * that queues is not thereby safe: the outbox holds each row on its own period
 * and continues, so a queued payment can still post ahead of a queued accrual
 * when their periods open in the wrong order. `commissionPostingBlockedReason`
 * is the drain-side half that covers that; this half exists so the common case
 * fails immediately, with a message, instead of silently deferring.
 */
/**
 * Refuses to record a commission whose entry could never post.
 *
 * Commission entries carry the SALE's date. `checkPostingAllowed` separates two
 * states that look identical from the outside:
 *  - no period exists for that date yet → `waiting`. The entry queues, burns no
 *    retries, and posts by itself the month someone opens it. Fine.
 *  - the period exists and is CLOSED or LOCKED → a deliberate refusal that will
 *    not resolve on its own. The entry queues, every drain burns an attempt,
 *    and after ten it dead-letters — where it blocks payment for that sale and
 *    every future period close, and a LOCKED period cannot even be reopened.
 *
 * Without this the write SUCCEEDS: the guards below are gated on
 * `isPostableNow`, which is false for a closed period, so both are skipped, the
 * amount is saved, and the manager is told it worked. Every neighbouring guard
 * in this file fails closed with a message at the point of action; this one was
 * the only path that failed silently.
 */
async function assertSalePeriodAcceptsPostings(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  saleDate: number,
  action: string
): Promise<void> {
  const check = await checkPostingAllowed(ctx, orgId, saleDate);
  if (!check.ok && !check.waiting) {
    throwAppError(
      AppErrorCode.VALIDATION_FAILED,
      `This sale's accounting period is closed, so a commission entry for it could never post. Reopen the period before you ${action}.`
    );
  }
}

async function assertCommissionEntriesPosted(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  sale: Doc<"sales">,
  entryDate: number,
  action: string
): Promise<void> {
  if (!(await isPostableNow(ctx, orgId, entryDate))) return;
  const outstanding = await commissionEntriesOutstandingStatus(ctx, orgId, sale);
  if (outstanding === "FAILED") {
    // Deliberately NOT "open the period". A dead-lettered entry is skipped by
    // every drain, so that instruction sends the user somewhere they cannot fix
    // it — the same cry-wolf failure this work removed from the close checklist.
    throwAppError(
      AppErrorCode.VALIDATION_FAILED,
      `A ledger entry for this sale has failed and needs to be retried before you can ${action}. Ask an administrator to retry it from Accounting → Setup.`
    );
  }
  if (outstanding === "PENDING") {
    throwAppError(
      AppErrorCode.VALIDATION_FAILED,
      `This commission hasn't posted to the ledger yet (its accounting period may be closed). Open the period so it posts, then ${action}.`
    );
  }
}

/**
 * Refuses to settle a commission whose ledger recognition does not match the
 * amount the sale says is owed.
 *
 * Settlement debits Commission Payable by the sale's amount; the GL holds what
 * the entries recognized. Every path that changes the amount posts a matching
 * delta, so the two agree — unless the row was written outside those paths (the
 * admin raw-JSON editor writes `sales` directly) or the delta arithmetic itself
 * is wrong. Paying across that gap puts the payable negative by the difference,
 * and every later correction computes from the already-wrong row, so nothing in
 * the normal workflow can bring it back.
 */
async function assertCommissionRecognitionMatches(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  sale: Doc<"sales">,
  currency: string,
  entryDate: number
): Promise<void> {
  // Gated exactly like the ordering check above, and for the same reason: when
  // nothing can post — no chart of accounts, or no open period — recognition is
  // legitimately zero while the sale carries a real amount, and the payment
  // queues behind the accrual rather than racing it. Enforcing here would
  // refuse every commission an org raises before it sets up its accounting.
  if (!(await isPostableNow(ctx, orgId, entryDate))) return;
  const recognized = await recognizedCommissionMinor(ctx, orgId, sale, currency);
  if (recognized === null) {
    // `null` has two causes and they send accounting after different things:
    // an unreadable correction count, or recognition in another currency.
    const usableSeq = safeAdjustmentSeq(sale.commissionAdjustmentSeq) !== null;
    throwAppError(
      AppErrorCode.VALIDATION_FAILED,
      usableSeq
        ? "This commission was recognized in a different currency than it would be paid in. Have accounting reconcile it before settling."
        : "This commission's correction history cannot be read, so it cannot be paid. Have accounting review it."
    );
  }
  const decided = toMinorUnits(sale.commissionAmount ?? 0, currency);
  if (recognized !== decided) {
    throwAppError(
      AppErrorCode.VALIDATION_FAILED,
      "This commission's amount does not match what the ledger recognized for it, so it cannot be paid. Have accounting review it."
    );
  }
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
        // The safety-net accrual below is dated to the sale, so a closed period
        // would leave it unpostable while the payment itself posts — the exact
        // ordering split the drain guards exist to prevent, created here.
        await assertSalePeriodAcceptsPostings(ctx, args.orgId, sale.saleDate, "pay it");

        const now = Date.now();
        await ctx.db.patch(args.saleId, {
          commissionPaidAt: now,
          commissionPaidBy: user._id,
          commissionPaymentMethod: paymentMethod,
          commissionPaymentIdempotencyKey: args.idempotencyKey,
        });
        const currency = await getOrgCurrency(ctx, args.orgId);
        const amountMinor = toMinorUnits(sale.commissionAmount, currency);
        // Recognize the expense before paying it. Both modes now accrue as soon
        // as the amount is measurable, so for anything created since that change
        // this is an idempotent no-op on the same key. It stays as the safety
        // net for rows that predate it — a commission entered while MANUAL still
        // deferred accrual to payment — so the payment always clears a real
        // Commission Payable instead of pushing it negative (fixes C1).
        await hookCommissionAccrued(ctx, {
          orgId: args.orgId,
          saleId: args.saleId,
          salespersonId: sale.salespersonId,
          amountMinor,
          currency,
          actorId: user._id,
          occurredAt: await commissionAccountingDate(ctx, args.orgId, args.saleId, sale.saleDate),
        });
        // The payment clears the payable, so everything that built it must
        // already be on the books. Without this the direct path could pay
        // against a queued accrual — payroll has guarded this for a while;
        // this path did not.
        await assertCommissionEntriesPosted(ctx, args.orgId, sale, now, "pay it");
        await assertCommissionRecognitionMatches(ctx, args.orgId, sale, currency, now);
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
      const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_COMMISSIONS]);

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

      // AUTO-mode commissions are derived from the org's rules, so a completed
      // sale's amount is not hand-editable — changing it would silently diverge
      // from the rule that produced it. MANUAL amounts are a human decision and
      // stay editable until paid; a change after accrual posts an adjusting
      // entry (below) rather than being refused.
      if (sale.status === "COMPLETED" && mode !== "MANUAL") {
        throwAppError(
          AppErrorCode.SALE_ALREADY_COMPLETED,
          "Completed sale commission amounts are locked. Use a correction workflow."
        );
      }
      // Recognition follows measurability: a completed sale whose commission
      // amount is now known owes it, so it accrues here rather than waiting for
      // payment. A later correction posts a signed adjusting entry instead of
      // being refused — the previous behavior sent the user to a "correction
      // workflow" that does not exist, so a commission accrued at the wrong
      // amount was permanently unfixable.
      //
      // The accrual and every adjustment share one accounting date — the sale's
      // own, or today if the sale's period has closed (commissionAccountingDate).
      // Deriving both from the same rule is what stops a correction from posting
      // into an open period while the accrual it corrects is still queued behind
      // a closed one, which would drive Commission Payable negative.
      // Refused before anything is written: an entry dated into a closed period
      // can never post, and the guards further down are gated on isPostableNow,
      // which is false there — so without this the amount saved and the manager
      // was told it worked.
      await assertSalePeriodAcceptsPostings(
        ctx,
        args.orgId,
        sale.saleDate,
        "set the commission"
      );

      const currency = await getOrgCurrency(ctx, args.orgId);
      const previousMinor =
        sale.commissionAmount == null ? 0 : toMinorUnits(sale.commissionAmount, currency);
      const nextMinor = toMinorUnits(args.commissionAmount, currency);
      const alreadyAccrued = await hasCommissionAccrual(ctx, args.orgId, args.saleId);
      const accountingDate = await commissionAccountingDate(ctx, args.orgId, args.saleId, sale.saleDate);

      const patch: {
        commissionAmount: number;
        commissionAdjustmentSeq?: number;
      } = { commissionAmount: args.commissionAmount };

      if (alreadyAccrued) {
        const deltaMinor = nextMinor - previousMinor;
        // A no-op edit posts nothing: an empty journal entry carries no
        // information, and burning a sequence number on it would make the
        // adjustment count overstate how many real corrections happened.
        if (deltaMinor !== 0) {
          // Validated FIRST, so an unusable counter is reported as what it is.
          // `NaN + 1` is NaN and `NaN > MAX` is false, so a corrupt counter
          // sailed past the ceiling and minted the key
          // `commission_adjusted_<saleId>_NaN` — the first correction posted,
          // and the SECOND collided on that same key and was silently dropped
          // while the sale row moved anyway.
          const previousSeq = safeAdjustmentSeq(sale.commissionAdjustmentSeq);
          const sequence = previousSeq === null ? null : previousSeq + 1;
          if (sequence === null || sequence > MAX_COMMISSION_ADJUSTMENTS) {
            throwAppError(
              AppErrorCode.VALIDATION_FAILED,
              "This commission's correction history cannot be extended safely. Have accounting review it, or raise a manual journal."
            );
          }
          // A correction must not post ahead of the accrual it corrects: a
          // downward delta landing alone in an open period, while the accrual
          // waits behind a closed one, is a naked debit to Commission Payable.
          await assertCommissionEntriesPosted(
            ctx,
            args.orgId,
            sale,
            accountingDate,
            "change the amount"
          );
          // A correction computes its delta from the sale row, so correcting a
          // row that has already drifted from the ledger does not close the gap
          // — it inverts and widens it. Refuse, and leave the divergence for the
          // control that reports it.
          // Zero means nothing has POSTED yet — the accrual is still queued,
          // which is ordinary for an org without a chart or an open period, and
          // is the ordering guard's business rather than a divergence. Only a
          // ledger that recognized something DIFFERENT is drift.
          const recognizedNow = await recognizedCommissionMinor(ctx, args.orgId, sale, currency);
          if (recognizedNow !== null && recognizedNow !== 0 && recognizedNow !== previousMinor) {
            throwAppError(
              AppErrorCode.VALIDATION_FAILED,
              "This commission's amount no longer matches what the ledger recognized for it, so it cannot be corrected here. Have accounting reconcile it first."
            );
          }
          patch.commissionAdjustmentSeq = sequence;
          await hookCommissionAdjusted(ctx, {
            orgId: args.orgId,
            saleId: args.saleId,
            salespersonId: sale.salespersonId,
            sequence,
            deltaMinor,
            currency,
            actorId: user._id,
            occurredAt: accountingDate,
          });
        }
      } else if (sale.status === "COMPLETED" && nextMinor > 0) {
        // The FIRST accrual needs the same dependency check as a correction.
        // Inheriting the sale posting's date keeps them in one period, but once
        // that period opens while the sale's entry is still queued — or has
        // dead-lettered and will never drain — this posts immediately, ahead of
        // the revenue that earned it, and the drain-side guard never sees it.
        await assertCommissionEntriesPosted(
          ctx,
          args.orgId,
          sale,
          accountingDate,
          "set the amount"
        );
        await hookCommissionAccrued(ctx, {
          orgId: args.orgId,
          saleId: args.saleId,
          salespersonId: sale.salespersonId,
          amountMinor: nextMinor,
          currency,
          actorId: user._id,
          occurredAt: accountingDate,
        });
      }

      await ctx.db.patch(args.saleId, patch);

      // This is now the entry point for a payout figure, so who decided it,
      // when, and what it was before all have to survive. The sale row keeps
      // only the current value and, later, whoever paid it — which means
      // without this there is no record of the decision itself, and a MANUAL
      // amount stays editable right up until it hits the ledger.
      await auditLog(ctx, {
        orgId: args.orgId,
        actorId: user._id,
        actionType: "SET_COMMISSION_AMOUNT",
        resourceType: "sales",
        resourceId: args.saleId,
        description:
          sale.commissionAmount == null
            ? `Commission set to ${args.commissionAmount}`
            : `Commission changed from ${sale.commissionAmount} to ${args.commissionAmount}`,
        before: { commissionAmount: sale.commissionAmount ?? null },
        // The journalled delta and its sequence, not just the new amount: an
        // auditor reconciling the GL against the decision trail needs the
        // number that actually posted, and the sequence is what identifies the
        // entry it posted as.
        after: {
          commissionAmount: args.commissionAmount,
          adjustmentSeq: patch.commissionAdjustmentSeq ?? null,
          adjustmentDeltaMinor: patch.commissionAdjustmentSeq ? nextMinor - previousMinor : null,
        },
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
        await assertSalePeriodAcceptsPostings(
          ctx,
          args.orgId,
          sale.saleDate,
          "recalculate the commission"
        );
        const currency = await getOrgCurrency(ctx, args.orgId);
        const now = Date.now();
        const accountingDate = await commissionAccountingDate(ctx, args.orgId, args.saleId, sale.saleDate);
        // Same dependency as every other accrual path.
        await assertCommissionEntriesPosted(
          ctx,
          args.orgId,
          sale,
          accountingDate,
          "recalculate"
        );
        await hookCommissionAccrued(ctx, {
          orgId: args.orgId,
          saleId: args.saleId,
          salespersonId: sale.salespersonId,
          amountMinor: toMinorUnits(commissionAmount, currency),
          currency,
          actorId: user._id,
          // The same shared rule as every other commission entry. Dating this
          // at `now` recognized the expense in the month the cost basis was
          // fixed rather than the month of the sale — the very mismatch this
          // work removes — and, once the mode is switched to MANUAL, let a
          // later correction post into the sale's own open period with no
          // accrual behind it there.
          occurredAt: accountingDate,
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
