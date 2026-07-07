import { v, ConvexError } from "convex/values";
import { MutationCtx, mutation, query } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { paginationOptsValidator } from "convex/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS, isSystemOwnerRole } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";
import { releaseHoldForApplicationQuote } from "./utils/depositHelpers";
import { completeSale } from "./utils/saleCompletion";
import { cancelCompletedSaleOperationalRecords } from "./utils/saleCancellation";
import { runWithIdempotency } from "./utils/idempotency";
import { registerChequeCore, markChequeClearedCore } from "./collections";
import {
  hookFinanceDisbursed,
  hookFinanceCashReceived,
  hookFinanceDisbursementCancelled,
  hookSaleCancelled,
  hookCommissionReversed,
  getOrgCurrency,
} from "./accounting/workflowHooks";
import { toMinorUnits } from "./utils/money";
import {
  allocatePaymentToReceivable,
  createCanonicalPayment,
  ensureReceivableDocument,
} from "./subledger";

/** sourceType used for the canonical finance-company receivable opened at finalizeDeal. */
const FINANCE_APP_RECEIVABLE_SOURCE = "finance_application";

/**
 * Opens (or finds) the canonical receivable owed BY the finance company for a
 * finalized deal. Idempotent per application via the by_org_source index.
 */
async function ensureFinanceCompanyReceivable(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    applicationId: Id<"financeApplications">;
    financeCompanyId: Id<"financeCompanies">;
    customerId: Id<"customers">;
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    now: number;
  }
) {
  return await ensureReceivableDocument(ctx, {
    orgId: args.orgId,
    documentType: "INVOICE",
    payerType: "FINANCE_COMPANY",
    financeCompanyId: args.financeCompanyId,
    customerId: args.customerId,
    sourceType: FINANCE_APP_RECEIVABLE_SOURCE,
    sourceId: args.applicationId,
    originalAmountMinor: args.amountMinor,
    currency: args.currency,
    issueDate: args.now,
    dueDate: args.now,
    actorId: args.actorId,
  });
}

function receivableStatusForBalance(
  originalAmountMinor: number,
  allocatedMinor: number
): Doc<"receivableDocuments">["status"] {
  if (originalAmountMinor <= 0 || allocatedMinor >= originalAmountMinor) return "PAID";
  return allocatedMinor > 0 ? "PARTIALLY_PAID" : "OPEN";
}

async function getActiveReceivableAllocations(
  ctx: MutationCtx,
  receivableDocumentId: Id<"receivableDocuments">
) {
  return await ctx.db
    .query("paymentAllocations")
    .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", receivableDocumentId))
    .filter((q) => q.eq(q.field("status"), "ACTIVE"))
    .collect();
}

async function transferFinancedAmountFromCustomerReceivable(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    saleAmountMinor: number;
    financedAmountMinor: number;
  }
) {
  const sale = await ctx.db.get(args.saleId);
  if (!sale || sale.orgId !== args.orgId) throw new ConvexError("Finalized sale not found.");
  if (!sale.canonicalReceivableDocumentId) {
    throw new ConvexError("Finalized sale is missing its canonical customer receivable.");
  }

  const customerReceivable = await ctx.db.get(sale.canonicalReceivableDocumentId);
  if (!customerReceivable || customerReceivable.orgId !== args.orgId) {
    throw new ConvexError("Sale customer receivable not found.");
  }

  const customerPortionMinor = Math.max(0, args.saleAmountMinor - args.financedAmountMinor);
  if (customerReceivable.originalAmountMinor === customerPortionMinor) return;

  const activeAllocations = await getActiveReceivableAllocations(ctx, customerReceivable._id);
  const allocatedMinor = activeAllocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0);
  if (allocatedMinor > customerPortionMinor) {
    throw new ConvexError(
      "Customer receivable allocations exceed the non-financed customer balance. Reconcile the sale before finalizing financing."
    );
  }

  await ctx.db.patch(customerReceivable._id, {
    originalAmountMinor: customerPortionMinor,
    status: receivableStatusForBalance(customerPortionMinor, allocatedMinor),
  });
}

type FinanceApplicationStatus =
  | "DRAFT"
  | "PENDING_DOCS"
  | "UNDER_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "CLOSED"
  | "CANCELLED";

type QuoteMode =
  | "CASH"
  | "CONFIGURED_FINANCE_COMPANY"
  | "MANUAL_FINANCE_COMPANY"
  | "INTERNAL_INSTALLMENT"
  | "LEASE";

const VALID_STATUS_TRANSITIONS: Record<FinanceApplicationStatus, readonly FinanceApplicationStatus[]> = {
  DRAFT: ["PENDING_DOCS"],
  PENDING_DOCS: ["UNDER_REVIEW", "REJECTED"],
  UNDER_REVIEW: ["APPROVED", "REJECTED", "PENDING_DOCS"],
  APPROVED: ["CLOSED"],
  REJECTED: ["PENDING_DOCS"],
  CLOSED: [],
  CANCELLED: [],
};

// Statuses from which an application can be voided via cancelApplication —
// e.g. when it was submitted against the wrong car. CLOSED applications can
// also be cancelled (see cancelApplication's CLOSED branch), which unwinds
// the sale, vehicle, deposits, and posted GL entries it created — but only
// while no disbursement has been confirmed yet (see the disbursedAt guard).
const CANCELLABLE_STATUSES: readonly FinanceApplicationStatus[] = [
  "DRAFT",
  "PENDING_DOCS",
  "UNDER_REVIEW",
  "APPROVED",
  "REJECTED",
  "CLOSED",
];

async function assertRequiredApplicationDocumentsComplete(
  ctx: MutationCtx,
  app: Doc<"financeApplications">,
  quote: Doc<"quotes">
) {
  const rules = await ctx.db
    .query("companyDocumentRules")
    .withIndex("by_org", (q) => q.eq("orgId", app.orgId))
    .collect();
  const requiredRules = rules.filter((rule) => rule.isRequired && (!rule.companyId || rule.companyId === quote.companyId));
  if (requiredRules.length === 0) return;

  const docs = await ctx.db
    .query("applicationDocuments")
    .withIndex("by_application", (q) => q.eq("applicationId", app._id))
    .collect();
  const docsByRule = new Map(docs.map((doc) => [doc.ruleId, doc]));

  const missing = requiredRules
    .filter((rule) => {
      const doc = docsByRule.get(rule._id);
      return !doc || (doc.status !== "VERIFIED" && doc.status !== "WAIVED");
    })
    .map((rule) => rule.documentName);

  if (missing.length > 0) {
    throw new ConvexError(
      `Required finance documents must be verified or waived before approval: ${missing.join(", ")}`
    );
  }
}

export const list = query({
  args: {
    orgId: v.id("organizations"),
    status: v.optional(v.string()), // DRAFT, PENDING_DOCS, etc.
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]); // Reusing sales permission for now

    let pageResult;
    if (args.status) {
      pageResult = await ctx.db
        .query("financeApplications")
        .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", args.status as "APPROVED" | "REJECTED" | "DRAFT" | "PENDING_DOCS" | "UNDER_REVIEW" | "CLOSED"))
        .paginate(args.paginationOpts);
    } else {
      pageResult = await ctx.db
        .query("financeApplications")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .paginate(args.paginationOpts);
    }

    // Enrich
    const page = await Promise.all(
      pageResult.page.map(async (app) => {
        const customer = await ctx.db.get(app.customerId);
        const vehicle = await ctx.db.get(app.vehicleId);
        const company = app.companyId ? await ctx.db.get(app.companyId) : null;
        const salesperson = await ctx.db.get(app.salespersonId);
        const quote = await ctx.db.get(app.quoteId);

        return {
          ...app,
          customerName: customer ? `${customer.firstName} ${customer.lastName}` : "Unknown",
          vehicleDesc: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : "Unknown",
          companyName: company ? company.name : "Cash / Direct",
          salespersonName: salesperson && "name" in salesperson ? salesperson.name : "Unknown",
          financedAmount: quote?.totalFinancedAmount || 0,
          monthlyInstallment: quote?.monthlyInstallment || 0,
        };
      })
    );

    return { ...pageResult, page };
  },
});

export const get = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    const app = await ctx.db.get(args.applicationId);
    if (!app || app.orgId !== args.orgId) return null;

    const customer = await ctx.db.get(app.customerId);
    const vehicle = await ctx.db.get(app.vehicleId);
    const company = app.companyId ? await ctx.db.get(app.companyId) : null;
    const salesperson = await ctx.db.get(app.salespersonId);
    const quote = await ctx.db.get(app.quoteId);

    return {
      ...app,
      customer,
      vehicle,
      company,
      salesperson,
      quote,
    };
  },
});

export const createFromQuote = mutation({
  args: {
    orgId: v.id("organizations"),
    quoteId: v.id("quotes"),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_SALES]);

    const quote = await ctx.db.get(args.quoteId);
    if (!quote || quote.orgId !== args.orgId) {
      throw new ConvexError("Quote not found.");
    }
    const customer = await ctx.db.get(quote.customerId);
    if (!customer || customer.orgId !== args.orgId) {
      throw new ConvexError("Quote customer not found in this organization.");
    }

    const quoteVehicleItems = quote.vehicleItems ?? [{ vehicleId: quote.vehicleId, unitPrice: quote.vehiclePrice }];
    // Financed deals stay single-vehicle for now — finalizeDeal only ever
    // completes app.vehicleId's sale, so a multi-vehicle quote reaching this
    // point would silently drop every other vehicle at finalization. The
    // wizard never produces this today (multi-vehicle is CASH-only), but
    // reject it defensively rather than relying on that never changing.
    if (quoteVehicleItems.length !== 1) {
      throw new ConvexError("Finance applications currently support exactly one vehicle.");
    }
    for (const item of quoteVehicleItems) {
      const lineVehicle = await ctx.db.get(item.vehicleId);
      if (!lineVehicle || lineVehicle.orgId !== args.orgId || lineVehicle.isDeleted) {
        throw new ConvexError("Quote vehicle not found in this organization.");
      }
    }
    if (quote.companyId) {
      const company = await ctx.db.get(quote.companyId);
      if (!company || company.orgId !== args.orgId) {
        throw new ConvexError("Quote finance company not found in this organization.");
      }
    }

    // Check if application already exists for this quote
    const existing = await ctx.db
      .query("financeApplications")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("quoteId"), args.quoteId))
      .first();

    if (existing) {
      throw new ConvexError("An application already exists for this quote.");
    }

    // Every vehicle on the quote should only have one in-flight application at
    // a time. Use an explicit allowlist of blocking statuses so REJECTED and
    // CLOSED applications (which are effectively terminal) don't strand the
    // vehicle indefinitely and allow a fresh deal to begin without cancellation.
    const IN_FLIGHT_STATUSES: string[] = ["DRAFT", "PENDING_DOCS", "UNDER_REVIEW", "APPROVED"];
    for (const item of quoteVehicleItems) {
      const activeForVehicle = await ctx.db
        .query("financeApplications")
        .withIndex("by_vehicle", (q) => q.eq("vehicleId", item.vehicleId))
        .filter((q) => q.eq(q.field("orgId"), args.orgId))
        .collect()
        .then((rows) => rows.find((r) => IN_FLIGHT_STATUSES.includes(r.status)));
      if (activeForVehicle) {
        throw new ConvexError(
          "This vehicle already has an active finance application. Cancel it before starting a new one."
        );
      }
    }

    const guarantors = await ctx.db
      .query("guarantors")
      .withIndex("by_customer", (q) => q.eq("customerId", quote.customerId))
      .filter((q) => q.neq(q.field("isDeleted"), true))
      .collect();

    const salary = customer.employment?.salary;
    const existingMonthlyDebt = customer.financials?.totalMonthlyDebt;
    const proposedInstallment = quote.monthlyInstallment ?? 0;
    const dbr =
      salary && salary > 0
        ? ((existingMonthlyDebt ?? 0) + proposedInstallment) / salary
        : undefined;

    let vehicleValuation: number | undefined;
    let ltv: number | undefined;
    if (quote.companyId) {
      const valuations = await Promise.all(
        quoteVehicleItems.map((item) =>
          ctx.db
            .query("vehicleValuations")
            .withIndex("by_vehicle", (q) => q.eq("vehicleId", item.vehicleId))
            .filter((q) => q.eq(q.field("companyId"), quote.companyId))
            .first()
        )
      );
      // Only treat the combined valuation as meaningful if every vehicle on the
      // quote has one — a partial sum would understate true collateral value.
      const allValued = valuations.every((v) => v?.valuationAmount !== undefined);
      vehicleValuation = allValued
        ? valuations.reduce((sum, v) => sum + (v?.valuationAmount ?? 0), 0)
        : undefined;
      if (vehicleValuation && quote.totalFinancedAmount !== undefined) {
        ltv = (quote.totalFinancedAmount / vehicleValuation) * 100;
      }
    }

    const underwritingSnapshot = {
      salaryAtSubmission: salary,
      employerAtSubmission: customer.employment?.employer,
      jobTitleAtSubmission: customer.employment?.title,
      totalMonthlyDebtAtSubmission: existingMonthlyDebt,
      proposedMonthlyInstallment: proposedInstallment,
      dbrAtSubmission: dbr,
      guarantorsAtSubmission: guarantors.map((g) => ({
        guarantorId: g._id,
        firstName: g.firstName,
        lastName: g.lastName,
        nationalIdLastFour: g.nationalId.slice(-4),
        phone: g.phone,
        income: g.income,
        relationship: g.relationship,
      })),
      vehicleValuationAtSubmission: vehicleValuation,
      ltvAtSubmission: ltv,
    };

    const now = Date.now();
    const manualFinanceSnapshot =
      quote.mode === "MANUAL_FINANCE_COMPANY"
        ? {
            ...(quote.manualProviderName !== undefined ? { providerName: quote.manualProviderName } : {}),
            ...(quote.manualProfitRate !== undefined ? { profitRate: quote.manualProfitRate } : {}),
            ...(quote.manualInsuranceRate !== undefined ? { insuranceRate: quote.manualInsuranceRate } : {}),
            ...(quote.manualAdminFees !== undefined ? { adminFees: quote.manualAdminFees } : {}),
            ...(quote.manualCommission !== undefined ? { commission: quote.manualCommission } : {}),
            ...(quote.manualIncludesCommissionInDebt !== undefined
              ? { includesCommissionInDebt: quote.manualIncludesCommissionInDebt }
              : {}),
            ...(quote.totalFinancedAmount !== undefined ? { totalFinancedAmount: quote.totalFinancedAmount } : {}),
            ...(quote.monthlyInstallment !== undefined ? { monthlyInstallment: quote.monthlyInstallment } : {}),
            ...(quote.totalProfit !== undefined ? { totalProfit: quote.totalProfit } : {}),
          }
        : undefined;

    const appId = await ctx.db.insert("financeApplications", {
      orgId: args.orgId,
      quoteId: quote._id,
      customerId: quote.customerId,
      vehicleId: quote.vehicleId,
      ...(quote.vehicleItems ? { vehicleItems: quote.vehicleItems } : {}),
      companyId: quote.companyId,
      salespersonId: auth.user._id,
      status: "PENDING_DOCS",
      notes: args.notes,
      createdAt: now,
      updatedAt: now,
      ...(quote.mode !== undefined ? { quoteModeAtSubmission: quote.mode } : {}),
      ...(manualFinanceSnapshot ? { manualFinanceSnapshot } : {}),
      underwritingSnapshot,
    });

    await ctx.db.insert("applicationStatusLog", {
      orgId: args.orgId,
      applicationId: appId,
      toStatus: "PENDING_DOCS",
      changedBy: auth.user._id,
      changedAt: now,
    });

    // Automatically assign required documents based on rules
    const rules = await ctx.db
      .query("companyDocumentRules")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    for (const rule of rules) {
      // If rule applies to ALL companies, or exactly to this quote's company
      if (!rule.companyId || rule.companyId === quote.companyId) {
        await ctx.db.insert("applicationDocuments", {
          orgId: args.orgId,
          applicationId: appId,
          ruleId: rule._id,
          status: "MISSING",
        });
      }
    }

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "application.created",
      { actorName, customerName: `${customer?.firstName} ${customer?.lastName}` },
      { link: `/${args.orgId}/applications` }
    );

    return appId;
  },
});

export const updateStatus = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    status: v.union(
      v.literal("DRAFT"),
      v.literal("PENDING_DOCS"),
      v.literal("UNDER_REVIEW"),
      v.literal("APPROVED"),
      v.literal("REJECTED"),
      v.literal("CLOSED")
    ),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId);
    const hasView =
      isSystemOwnerRole(auth.role) ||
      auth.role.permissions.includes(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    if (!hasView) {
      throw new ConvexError("Forbidden: Missing required permissions.");
    }

    const app = await ctx.db.get(args.applicationId);
    if (!app || app.orgId !== args.orgId) {
      throw new ConvexError("Application not found");
    }

    const allowedNextStatuses = VALID_STATUS_TRANSITIONS[app.status];
    if (!allowedNextStatuses.includes(args.status)) {
      throw new ConvexError(
        `Invalid finance application status transition: ${app.status} -> ${args.status}.`
      );
    }

    if (args.status === "UNDER_REVIEW" || args.status === "REJECTED") {
      await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.REVIEW_FINANCE_APPLICATION]);
    }

    let approvedBy = app.approvedBy;
    let approvedAt = app.approvedAt;

    if (args.status === "APPROVED") {
      await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_FINANCE_APPLICATION]);
      if (auth.user._id === app.salespersonId) {
        throw new ConvexError("You cannot approve your own application");
      }
      const quote = await ctx.db.get(app.quoteId);
      if (!quote || quote.orgId !== args.orgId) {
        throw new ConvexError("Application quote not found.");
      }
      await assertRequiredApplicationDocumentsComplete(ctx, app, quote);
      approvedBy = auth.user._id;
      approvedAt = Date.now();
    }

    if (args.status === "CLOSED") {
      await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.FINALIZE_FINANCED_DEAL]);
    }

    const patchedAt = Date.now();
    await ctx.db.patch(args.applicationId, {
      status: args.status,
      updatedAt: patchedAt,
      approvedBy,
      approvedAt,
    });

    await ctx.db.insert("applicationStatusLog", {
      orgId: args.orgId,
      applicationId: args.applicationId,
      fromStatus: app.status,
      toStatus: args.status,
      changedBy: auth.user._id,
      changedAt: patchedAt,
    });

    if (args.status === "REJECTED" && app.status !== "REJECTED") {
      await releaseHoldForApplicationQuote(ctx, { quoteId: app.quoteId });
    }
  },
});

/**
 * Voids an application that was submitted in error (e.g. against the wrong
 * vehicle) so the deal can be redone cleanly on a fresh quote. CANCELLED is
 * terminal — the application stays visible for audit purposes but can no
 * longer be acted on. Releases any deposit-driven vehicle hold tied to the
 * quote, same as a rejection. Not available once CLOSED, since finalizeDeal
 * has already created a sale.
 */
export const cancelApplication = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    reason: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_FINANCE_APPLICATION]);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "applications.cancelApplication",
        idempotencyKey: args.idempotencyKey,
        actorId: auth.user._id,
        fingerprint: JSON.stringify({ applicationId: args.applicationId, reason: args.reason }),
      },
      async () => {
        const app = await ctx.db.get(args.applicationId);
        if (!app || app.orgId !== args.orgId) {
          throw new ConvexError("Application not found");
        }

        if (!CANCELLABLE_STATUSES.includes(app.status)) {
          throw new ConvexError("This application has already been cancelled.");
        }

        // Reversing an already-APPROVED decision is more sensitive than voiding
        // a draft/in-review one, so require the same permission used to approve.
        if (app.status === "APPROVED") {
          await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_FINANCE_APPLICATION]);
        }

        const reason = args.reason ?? "Finance application cancelled";
        const now = Date.now();

        if (app.status === "CLOSED") {
          // Undoing a finalized deal touches the sale, vehicle, deposits, and
          // posted GL — require finalization authority (the same permission
          // needed to close the deal in the first place), not just approval.
          await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.FINALIZE_FINANCED_DEAL]);

          if (app.disbursedAt) {
            throw new ConvexError(
              "Disbursement has already been confirmed for this deal — funds have been received from the finance company. " +
              "This can't be auto-reversed from here; void it through a manual accounting correction instead."
            );
          }

          if (app.finalizedSaleId) {
            const sale = await ctx.db.get(app.finalizedSaleId);
            if (sale && sale.orgId === args.orgId) {
              await cancelCompletedSaleOperationalRecords(ctx, {
                orgId: args.orgId,
                sale,
                actorId: auth.user._id,
                reason,
                reversalDate: now,
              });

              if (sale.status !== "CANCELLED") {
                await ctx.db.patch(sale._id, { status: "CANCELLED" });
                await hookSaleCancelled(ctx, {
                  orgId: args.orgId,
                  saleId: sale._id,
                  reason,
                  actorId: auth.user._id,
                  reversalDate: now,
                });
                if (sale.commissionAmount != null && sale.commissionAmount > 0) {
                  await hookCommissionReversed(ctx, {
                    orgId: args.orgId,
                    saleId: sale._id,
                    reason,
                    actorId: auth.user._id,
                    reversalDate: now,
                  });
                }
              }
            }
          }

          const quote = await ctx.db.get(app.quoteId);
          const financeReceivable = app.companyId
            ? await ctx.db
                .query("receivableDocuments")
                .withIndex("by_org_source", (q) =>
                  q
                    .eq("orgId", args.orgId)
                    .eq("sourceType", FINANCE_APP_RECEIVABLE_SOURCE)
                    .eq("sourceId", args.applicationId)
                )
                .unique()
            : null;
          if (
            app.companyId &&
            ((quote?.totalFinancedAmount ?? 0) > 0 || financeReceivable)
          ) {
            await hookFinanceDisbursementCancelled(ctx, {
              orgId: args.orgId,
              applicationId: args.applicationId,
              reason,
              actorId: auth.user._id,
              reversalDate: now,
            });

            // The canonical finance-company receivable opened at finalizeDeal
            // is no longer owed once the deal is voided (this branch already
            // rejects deals whose disbursement was received).
            if (financeReceivable && financeReceivable.status !== "CANCELLED") {
              await ctx.db.patch(financeReceivable._id, { status: "CANCELLED" });
            }
          }
        } else {
          await releaseHoldForApplicationQuote(ctx, { quoteId: app.quoteId });
        }

        await ctx.db.patch(args.applicationId, {
          status: "CANCELLED",
          updatedAt: now,
          cancelledBy: auth.user._id,
          cancelledAt: now,
          cancellationReason: args.reason,
        });

        await ctx.db.insert("applicationStatusLog", {
          orgId: args.orgId,
          applicationId: args.applicationId,
          fromStatus: app.status,
          toStatus: "CANCELLED",
          changedBy: auth.user._id,
          changedAt: now,
          note: args.reason,
        });

        const actorName = await getActorName(ctx);
        const customer = await ctx.db.get(app.customerId);
        await notifyManagers(
          ctx,
          args.orgId,
          "application.cancelled",
          {
            actorName,
            customerName: customer ? `${customer.firstName} ${customer.lastName}` : "Unknown",
          },
          { link: `/${args.orgId}/applications`, excludeUserId: auth.user._id }
        );
      }
    );
  },
});

export const getLog = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    const entries = await ctx.db
      .query("applicationStatusLog")
      .withIndex("by_application", (q) => q.eq("applicationId", args.applicationId))
      .order("asc")
      .collect();

    return Promise.all(
      entries.map(async (entry) => {
        const user = await ctx.db.get(entry.changedBy);
        return {
          ...entry,
          changedByName: user && "name" in user ? (user.name ?? user.email) : "Unknown",
        };
      })
    );
  },
});

const expectedPaymentMethodValidator = v.union(
  v.literal("CASH"),
  v.literal("INTERNAL_INSTALLMENT"),
  v.literal("CHEQUE"),
  v.literal("BANK_TRANSFER"),
);

/**
 * التنازل بالسيارة للعميل — records that the vehicle has been handed over to
 * the customer. Required before finalizeDeal. Data-capture only, no document
 * is generated.
 */
export const registerVehicleHandover = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.REGISTER_VEHICLE_HANDOVER]);
    const app = await ctx.db.get(args.applicationId);
    if (!app || app.orgId !== args.orgId) throw new ConvexError("Application not found");
    if (app.status !== "APPROVED") throw new ConvexError("Application must be APPROVED before registering handover.");
    if (app.vehicleHandoverAt) throw new ConvexError("Vehicle handover has already been registered.");

    const now = Date.now();
    await ctx.db.patch(args.applicationId, {
      vehicleHandoverAt: now,
      vehicleHandoverBy: user._id,
      vehicleHandoverNotes: args.notes,
      updatedAt: now,
    });
    return now;
  },
});

/**
 * Registers how and when the deal's payment is expected to arrive — cash,
 * in-house installment with the customer, a cheque (from the finance company
 * or the customer's bank), or a bank transfer — before finalizeDeal. For
 * CHEQUE this also opens a real postDatedCheques record so it flows through
 * the existing cheque lifecycle (HELD -> DEPOSITED -> CLEARED).
 */
export const registerExpectedPayment = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    method: expectedPaymentMethodValidator,
    expectedDate: v.number(),
    chequeDetails: v.optional(v.object({
      bank: v.string(),
      chequeNumber: v.string(),
    })),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.REGISTER_EXPECTED_PAYMENT]);
    const app = await ctx.db.get(args.applicationId);
    if (!app || app.orgId !== args.orgId) throw new ConvexError("Application not found");
    if (app.status !== "APPROVED") throw new ConvexError("Application must be APPROVED before registering expected payment.");
    if (!app.vehicleHandoverAt) throw new ConvexError("Register the vehicle handover before the expected payment.");
    if (app.expectedPaymentRegisteredAt) throw new ConvexError("Expected payment has already been registered.");

    if (args.method === "CHEQUE") {
      if (!args.chequeDetails?.bank?.trim() || !args.chequeDetails?.chequeNumber?.trim()) {
        throw new ConvexError("Bank and cheque number are required for a cheque payment.");
      }
      const quote = await ctx.db.get(app.quoteId);
      const amount = quote?.totalFinancedAmount ?? quote?.vehiclePrice ?? 0;
      await registerChequeCore(ctx, {
        orgId: args.orgId,
        customerId: app.customerId,
        vehicleId: app.vehicleId,
        applicationId: args.applicationId,
        bank: args.chequeDetails.bank,
        chequeNumber: args.chequeDetails.chequeNumber,
        chequeDate: args.expectedDate,
        amount,
        actorId: user._id,
      });
    }

    const now = Date.now();
    await ctx.db.patch(args.applicationId, {
      expectedPaymentMethod: args.method,
      expectedPaymentDate: args.expectedDate,
      expectedPaymentRegisteredAt: now,
      expectedPaymentRegisteredBy: user._id,
      updatedAt: now,
    });
    return now;
  },
});

export const finalizeDeal = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.FINALIZE_FINANCED_DEAL]);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "applications.finalizeDeal",
        idempotencyKey: args.idempotencyKey,
        actorId: auth.user._id,
      },
      async () => {
        const app = await ctx.db.get(args.applicationId);
        if (!app || app.orgId !== args.orgId) throw new ConvexError("Application not found");
        if (app.status === "CLOSED" && app.finalizedSaleId) return app.finalizedSaleId;
        if (app.status !== "APPROVED") throw new ConvexError("Application must be APPROVED before finalizing");
        if (!app.vehicleHandoverAt) {
          throw new ConvexError("Register the vehicle handover to the customer before finalizing the deal.");
        }
        if (!app.expectedPaymentMethod || !app.expectedPaymentDate) {
          throw new ConvexError("Register how and when the payment is expected before finalizing the deal.");
        }

        const quote = await ctx.db.get(app.quoteId);
        if (!quote || quote.orgId !== args.orgId) throw new ConvexError("Quote not found");
        if (quote.customerId !== app.customerId || quote.vehicleId !== app.vehicleId) {
          throw new ConvexError("Application quote does not match the application customer and vehicle.");
        }
        if (quote.companyId && quote.companyId !== app.companyId) {
          throw new ConvexError("Application finance company does not match the quote.");
        }
        await assertRequiredApplicationDocumentsComplete(ctx, app, quote);

        const quoteMode: QuoteMode | undefined = app.quoteModeAtSubmission ?? quote.mode;
        const financingType =
          quoteMode === "LEASE"
            ? "LEASE"
            : quoteMode === "CONFIGURED_FINANCE_COMPANY" ||
                quoteMode === "MANUAL_FINANCE_COMPANY" ||
                quoteMode === "INTERNAL_INSTALLMENT"
              ? "FINANCED"
              : "CASH";

        const saleId = await completeSale(ctx, {
          orgId: args.orgId,
          vehicleId: app.vehicleId,
          customerId: app.customerId,
          salespersonId: app.salespersonId,
          salePrice: quote.vehiclePrice,
          saleDate: Date.now(),
          status: "COMPLETED",
          downPayment: quote.downPayment,
          financingType: quoteMode === undefined && app.companyId ? "FINANCED" : financingType,
          loanAmount: quote.totalFinancedAmount,
          termMonths: quote.termMonths,
          applicationId: args.applicationId,
          quoteId: app.quoteId,
          idempotencyKey: args.idempotencyKey,
          actorId: auth.user._id,
        });

        const now = Date.now();
        await ctx.db.patch(args.applicationId, {
          status: "CLOSED",
          finalizedSaleId: saleId,
          finalizationIdempotencyKey: args.idempotencyKey,
          updatedAt: now,
        });

        // Post the finance receivable transfer when a finance company is on the deal
        if (app.companyId && quote.totalFinancedAmount && quote.totalFinancedAmount > 0) {
          const currency = await getOrgCurrency(ctx, args.orgId);
          const loanAmountMinor = toMinorUnits(quote.totalFinancedAmount, currency);
          const saleAmountMinor = toMinorUnits(quote.vehiclePrice, currency);
          await hookFinanceDisbursed(ctx, {
            orgId: args.orgId,
            applicationId: args.applicationId,
            saleId,
            financeCompanyId: app.companyId,
            customerId: app.customerId,
            loanAmountMinor,
            currency,
            actorId: auth.user._id,
            occurredAt: now,
          });

          await transferFinancedAmountFromCustomerReceivable(ctx, {
            orgId: args.orgId,
            saleId,
            saleAmountMinor,
            financedAmountMinor: loanAmountMinor,
          });

          // Open the canonical finance-company receivable alongside the GL
          // transfer, so the amount owed by the finance company is tracked in
          // the subledger and settled by allocation at confirmDisbursement —
          // not just as an untracked GL balance.
          await ensureFinanceCompanyReceivable(ctx, {
            orgId: args.orgId,
            applicationId: args.applicationId,
            financeCompanyId: app.companyId,
            customerId: app.customerId,
            amountMinor: loanAmountMinor,
            currency,
            actorId: auth.user._id,
            now,
          });
        }

        return saleId;
      }
    );
  },
});

/**
 * Records actual receipt of disbursement funds from the finance company.
 * Only valid after finalizeDeal has been called and only once per application.
 */
export const confirmDisbursement = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    disbursedAmountMinor: v.number(),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT]);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "applications.confirmDisbursement",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({
          applicationId: args.applicationId,
          disbursedAmountMinor: args.disbursedAmountMinor,
        }),
      },
      async () => {
        const app = await ctx.db.get(args.applicationId);
        if (!app || app.orgId !== args.orgId) throw new ConvexError("Application not found.");
        if (app.status !== "CLOSED") throw new ConvexError("Disbursement can only be confirmed on a closed application.");
        if (app.disbursedAt) throw new ConvexError("Disbursement has already been confirmed for this application.");
        if (!app.companyId) throw new ConvexError("This application has no finance company — no disbursement expected.");
        if (args.disbursedAmountMinor <= 0) throw new ConvexError("Disbursement amount must be positive.");

        const quote = await ctx.db.get(app.quoteId);
        if (quote?.totalFinancedAmount !== undefined) {
          const currency = await getOrgCurrency(ctx, args.orgId);
          const expectedAmountMinor = toMinorUnits(quote.totalFinancedAmount, currency);
          if (args.disbursedAmountMinor !== expectedAmountMinor) {
            throw new ConvexError(
              `Disbursed amount (${args.disbursedAmountMinor}) does not match the financed amount on the deal (${expectedAmountMinor}).`
            );
          }
        }

        // registerExpectedPayment always opens a HELD postDatedCheques row when
        // the registered method is CHEQUE — link this confirmation to it so the
        // cheque doesn't stay HELD forever while the payment says settled.
        // (Not yet handled: a cheque that bounces AFTER this clears it — see
        // the note below, after the cheque is transitioned.)
        let chequeToClear: Doc<"postDatedCheques"> | null = null;
        if (app.expectedPaymentMethod === "CHEQUE") {
          const cheque = await ctx.db
            .query("postDatedCheques")
            .withIndex("by_application", (q) => q.eq("applicationId", args.applicationId))
            .unique();
          if (!cheque || cheque.isDeleted) {
            throw new ConvexError("Expected cheque record not found for this application.");
          }
          if (cheque.status === "RETURNED" || cheque.status === "CANCELLED") {
            throw new ConvexError(
              "This cheque was returned/cancelled — register a replacement or a different payment method before confirming disbursement."
            );
          }
          if (cheque.status !== "CLEARED") {
            chequeToClear = cheque;
          }
        }

        const now = Date.now();
        await ctx.db.patch(args.applicationId, {
          disbursedAt: now,
          disbursedAmountMinor: args.disbursedAmountMinor,
          disbursementIdempotencyKey: args.idempotencyKey,
          updatedAt: now,
        });

        if (chequeToClear) {
          // Transitions the cheque only — deliberately not clearCheque's
          // legacy collectionPayments/GL posting, since this disbursement is
          // already posted through the canonical finance-company receivable
          // below. A cheque that bounces after this point (post-hoc reversal)
          // is not yet handled; see clearCheque's applicationId guard.
          await markChequeClearedCore(ctx, {
            orgId: args.orgId,
            chequeId: chequeToClear._id,
            clearedAt: now,
          });
        }

        // Post the actual receipt of funds: DR Bank / CR Accounts Receivable —
        // Finance Companies. Without this the finance-company receivable opened
        // at finalizeDeal stays open forever even after the money arrives.
        const currency = await getOrgCurrency(ctx, args.orgId);
        await hookFinanceCashReceived(ctx, {
          orgId: args.orgId,
          applicationId: args.applicationId,
          financeCompanyId: app.companyId,
          customerId: app.customerId,
          amountMinor: args.disbursedAmountMinor,
          currency,
          actorId: user._id,
          occurredAt: now,
        });

        // Record the money in the canonical subledger and settle the
        // finance-company receivable opened at finalizeDeal. Deals finalized
        // before that receivable existed get one created here so the
        // settlement always has a document to allocate against.
        const receivableDocumentId = await ensureFinanceCompanyReceivable(ctx, {
          orgId: args.orgId,
          applicationId: args.applicationId,
          financeCompanyId: app.companyId,
          customerId: app.customerId,
          amountMinor: args.disbursedAmountMinor,
          currency,
          actorId: user._id,
          now,
        });
        // Reflects whatever method was registered before finalization
        // (registerExpectedPayment) instead of assuming bank transfer.
        const disbursementMethod =
          app.expectedPaymentMethod === "CASH" || app.expectedPaymentMethod === "CHEQUE"
            ? app.expectedPaymentMethod
            : "BANK_TRANSFER";
        const canonicalPaymentId = await createCanonicalPayment(ctx, {
          orgId: args.orgId,
          direction: "IN",
          payerType: "FINANCE_COMPANY",
          financeCompanyId: app.companyId,
          method: disbursementMethod,
          amountMinor: args.disbursedAmountMinor,
          currency,
          idempotencyKey: `finance_disbursement_${args.applicationId}`,
          actorId: user._id,
          status: "SETTLED",
          externalReference: `Finance disbursement for application ${args.applicationId}`,
          receivedAt: now,
        });
        const receivableDoc = await ctx.db.get(receivableDocumentId);
        if (receivableDoc) {
          const activeAllocations = await ctx.db
            .query("paymentAllocations")
            .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", receivableDocumentId))
            .filter((q) => q.eq(q.field("status"), "ACTIVE"))
            .collect();
          const allocatedMinor = activeAllocations.reduce((sum, a) => sum + a.amountMinor, 0);
          const outstandingMinor = Math.max(0, receivableDoc.originalAmountMinor - allocatedMinor);
          const allocationMinor = Math.min(outstandingMinor, args.disbursedAmountMinor);
          if (allocationMinor > 0) {
            await allocatePaymentToReceivable(ctx, {
              orgId: args.orgId,
              paymentId: canonicalPaymentId,
              receivableDocumentId,
              amountMinor: allocationMinor,
              actorId: user._id,
            });
          }
        }

        const actorName = await getActorName(ctx);
        await notifyManagers(ctx, args.orgId, "application.created" as const, {
          actorName,
          amount: String(args.disbursedAmountMinor),
        }, { link: `/${args.orgId}/accounting` });
      }
    );
  },
});
