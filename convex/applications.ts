import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";
import { releaseHoldForApplicationQuote, holdVehicleForDeposit } from "./utils/depositHelpers";
import { completeSale } from "./utils/saleCompletion";
import { restoreVehicleToAvailable } from "./utils/saleHelpers";
import { runWithIdempotency } from "./utils/idempotency";
import {
  hookFinanceDisbursed,
  hookFinanceCashReceived,
  hookFinanceDisbursementCancelled,
  hookSaleCancelled,
  hookCommissionReversed,
  hookDepositApplicationReversed,
  getOrgCurrency,
} from "./accounting/workflowHooks";
import { toMinorUnits } from "./utils/money";

type FinanceApplicationStatus =
  | "DRAFT"
  | "PENDING_DOCS"
  | "UNDER_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "CLOSED"
  | "CANCELLED";

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
    const vehicle = await ctx.db.get(quote.vehicleId);
    if (!vehicle || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Quote vehicle not found in this organization.");
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

    // A vehicle should only have one application in flight at a time —
    // otherwise two reviewers can be working the same car for different
    // customers, or a stray PENDING_DOCS application from a wrong-car mistake
    // sits open indefinitely. CANCELLED applications don't count, since
    // cancelling is exactly how staff redo a deal with the correct vehicle.
    const activeForVehicle = await ctx.db
      .query("financeApplications")
      .withIndex("by_vehicle", (q) => q.eq("vehicleId", quote.vehicleId))
      .filter((q) => q.and(q.eq(q.field("orgId"), args.orgId), q.neq(q.field("status"), "CANCELLED")))
      .first();
    if (activeForVehicle) {
      throw new ConvexError(
        "This vehicle already has an active finance application. Cancel it before starting a new one."
      );
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
      const valuation = await ctx.db
        .query("vehicleValuations")
        .withIndex("by_vehicle", (q) => q.eq("vehicleId", quote.vehicleId))
        .filter((q) => q.eq(q.field("companyId"), quote.companyId))
        .first();
      vehicleValuation = valuation?.valuationAmount;
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
    const appId = await ctx.db.insert("financeApplications", {
      orgId: args.orgId,
      quoteId: quote._id,
      customerId: quote.customerId,
      vehicleId: quote.vehicleId,
      companyId: quote.companyId,
      salespersonId: auth.user._id,
      status: "PENDING_DOCS",
      notes: args.notes,
      createdAt: now,
      updatedAt: now,
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
      auth.role.name === "OWNER" ||
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

    let approvedBy = app.approvedBy;
    let approvedAt = app.approvedAt;

    if (args.status === "APPROVED") {
      await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_FINANCE_APPLICATION]);
      if (auth.user._id === app.salespersonId) {
        throw new ConvexError("You cannot approve your own application");
      }
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
          // posted GL — require the same authority as approving, not just
          // the lighter bar used to create/withdraw an in-flight application.
          await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_FINANCE_APPLICATION]);

          if (app.disbursedAt) {
            throw new ConvexError(
              "Disbursement has already been confirmed for this deal — funds have been received from the finance company. " +
              "This can't be auto-reversed from here; void it through a manual accounting correction instead."
            );
          }

          if (app.finalizedSaleId) {
            const sale = await ctx.db.get(app.finalizedSaleId);
            if (sale && sale.orgId === args.orgId && sale.status !== "CANCELLED") {
              await restoreVehicleToAvailable(ctx, sale.vehicleId);
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

          const quote = await ctx.db.get(app.quoteId);
          if (app.companyId && quote?.totalFinancedAmount && quote.totalFinancedAmount > 0) {
            await hookFinanceDisbursementCancelled(ctx, {
              orgId: args.orgId,
              applicationId: args.applicationId,
              reason,
              actorId: auth.user._id,
              reversalDate: now,
            });
          }

          // Deposits applied at finalization go back to being an active hold
          // (re-reserving the vehicle) rather than vanishing, so the same
          // customer money can be carried over to a corrected quote.
          const appliedDeposits = await ctx.db
            .query("deposits")
            .withIndex("by_quote", (q) => q.eq("quoteId", app.quoteId))
            .filter((q) => q.eq(q.field("status"), "APPLIED"))
            .collect();
          for (const deposit of appliedDeposits) {
            await ctx.db.patch(deposit._id, {
              status: "HELD",
              holdActive: true,
              resolvedBy: undefined,
              resolvedAt: undefined,
            });
            await hookDepositApplicationReversed(ctx, {
              orgId: args.orgId,
              depositId: deposit._id,
              reason,
              actorId: auth.user._id,
              reversalDate: now,
            });
            await holdVehicleForDeposit(ctx, deposit.vehicleId);
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

        const quote = await ctx.db.get(app.quoteId);
        if (!quote || quote.orgId !== args.orgId) throw new ConvexError("Quote not found");
        if (quote.customerId !== app.customerId || quote.vehicleId !== app.vehicleId) {
          throw new ConvexError("Application quote does not match the application customer and vehicle.");
        }
        if (quote.companyId && quote.companyId !== app.companyId) {
          throw new ConvexError("Application finance company does not match the quote.");
        }

        const financingType =
          quote.mode === "LEASE"
            ? "LEASE"
            : quote.mode === "CONFIGURED_FINANCE_COMPANY" ||
                quote.mode === "MANUAL_FINANCE_COMPANY" ||
                quote.mode === "INTERNAL_INSTALLMENT"
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
          financingType: quote.mode === undefined && app.companyId ? "FINANCED" : financingType,
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
          await hookFinanceDisbursed(ctx, {
            orgId: args.orgId,
            applicationId: args.applicationId,
            saleId,
            financeCompanyId: app.companyId,
            customerId: app.customerId,
            loanAmountMinor: toMinorUnits(quote.totalFinancedAmount, currency),
            currency,
            actorId: auth.user._id,
            occurredAt: now,
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

        const now = Date.now();
        await ctx.db.patch(args.applicationId, {
          disbursedAt: now,
          disbursedAmountMinor: args.disbursedAmountMinor,
          disbursementIdempotencyKey: args.idempotencyKey,
          updatedAt: now,
        });

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

        const actorName = await getActorName(ctx);
        await notifyManagers(ctx, args.orgId, "application.created" as const, {
          actorName,
          amount: String(args.disbursedAmountMinor),
        }, { link: `/${args.orgId}/accounting` });
      }
    );
  },
});
