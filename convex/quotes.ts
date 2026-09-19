import { v, ConvexError } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import type { Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { advanceLeadStage } from "./utils/leadStageHelpers";
import { notifyUser, getActorName } from "./utils/notifications";
import { assertProfitApproved, quoteModeRequiresMinimumProfit } from "./utils/profitApproval";
import {
  assertCustomerEligibilityForCompany,
  assertCustomerLoanTermsValid,
  assertFinanceCompanyEligibleForNewQuote,
  assertFinancedMurabahaResultValid,
  assertFinancedQuoteContributionValid,
  assertRequestedFinancingTermValid,
  buildRuleSnapshot,
  requireConfiguredExecutionFees,
  type CustomerEligibilitySnapshot,
  type CustomerQuotePricingSnapshot,
  type FinanceCompanyRuleSnapshot,
} from "./utils/financingEconomics";
import { calculateUnifiedMurabaha } from "../lib/financing";
import { getOrgCurrency } from "./accounting/workflowHooks";
import { assertMajorAmountRepresentable } from "./utils/money";

function assertFiniteNumber(val: unknown, name: string): void {
  if (val !== undefined && (typeof val !== "number" || !Number.isFinite(val))) {
    throw new ConvexError(`${name} must be a finite number.`);
  }
}

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
    customerEligibilityStatusIds: v.optional(v.array(v.id("orgCustomerStatuses"))),
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
  },
  handler: async (ctx, args) => {
    // A quote is an informational financing draft, not a committed sale —
    // gated to VIEW_SALES (held by SALES/MANAGER/ACCOUNTANT/OWNER) rather
    // than CREATE_SALES, which is reserved for finalizing an actual sale.
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    // Finite checks on all numeric inputs and caller-supplied outputs
    assertFiniteNumber(args.vehiclePrice, "Vehicle price");
    assertFiniteNumber(args.desiredProfit, "Desired profit");
    assertFiniteNumber(args.downPayment, "Down payment");
    assertFiniteNumber(args.termMonths, "Term months");
    assertFiniteNumber(args.totalFinancedAmount, "Total financed amount");
    assertFiniteNumber(args.monthlyInstallment, "Monthly installment");
    assertFiniteNumber(args.profitRateApplied, "Profit rate applied");
    assertFiniteNumber(args.totalProfit, "Total profit");
    assertFiniteNumber(args.manualProfitRate, "Manual profit rate");
    assertFiniteNumber(args.manualInsuranceRate, "Manual insurance rate");
    assertFiniteNumber(args.manualAdminFees, "Manual admin fees");
    assertFiniteNumber(args.manualCommission, "Manual commission");

    if (args.downPayment < 0) {
      throw new ConvexError("Down payment cannot be negative.");
    }
    if (args.termMonths < 0) {
      throw new ConvexError("Term months cannot be negative.");
    }
    if (
      (args.mode === "CONFIGURED_FINANCE_COMPANY" || args.mode === "MANUAL_FINANCE_COMPANY") &&
      (!Number.isInteger(args.termMonths) || args.termMonths <= 0)
    ) {
      throw new ConvexError("Term months must be a positive integer.");
    }
    if (!Number.isInteger(args.termMonths)) {
      throw new ConvexError("Term months must be a non-negative integer.");
    }

    const customer = await ctx.db.get(args.customerId);
    if (!customer || customer.orgId !== args.orgId) {
      throw new ConvexError("Customer not found in this organization.");
    }

    const orgCurrency = await getOrgCurrency(ctx, args.orgId);

    // Exact denomination representability: every monetary major-unit input that becomes
    // deal economics must be representable without loss in the organization's currency.
    assertMajorAmountRepresentable(args.downPayment, orgCurrency, "Down payment");
    if (args.desiredProfit !== undefined) {
      assertMajorAmountRepresentable(args.desiredProfit, orgCurrency, "Desired profit");
    }

    let vehicleId = args.vehicleId;
    let vehiclePrice = args.vehiclePrice;

    if (args.vehicleItems && args.vehicleItems.length > 0) {
      const seen = new Set<string>();
      for (const item of args.vehicleItems) {
        assertFiniteNumber(item.unitPrice, "Vehicle item unit price");
        if (item.unitPrice <= 0) {
          throw new ConvexError("Each vehicle in the quote must have a positive price.");
        }
        assertMajorAmountRepresentable(item.unitPrice, orgCurrency, "Vehicle line item price");
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

    assertMajorAmountRepresentable(vehiclePrice, orgCurrency, "Vehicle price");

    if (vehiclePrice <= 0) {
      throw new ConvexError("Vehicle price must be positive.");
    }

    if (args.mode === "CONFIGURED_FINANCE_COMPANY" || args.mode === "MANUAL_FINANCE_COMPANY") {
      assertFinancedQuoteContributionValid({
        vehiclePrice,
        downPayment: args.downPayment,
      });
    }

    if (args.mode === "CONFIGURED_FINANCE_COMPANY" && !args.companyId) {
      throw new ConvexError("Configured finance company quotes require a finance company.");
    }

    if (args.companyId !== undefined && args.mode !== "CONFIGURED_FINANCE_COMPANY") {
      throw new ConvexError("Finance company can only be set for configured finance company quotes.");
    }

    let companyRuleSnapshot: FinanceCompanyRuleSnapshot | undefined;
    let companyRuleVersion: number | undefined;
    let customerQuotePricingSnapshot: CustomerQuotePricingSnapshot | undefined;
    let customerEligibilitySnapshot: CustomerEligibilitySnapshot | undefined;
    let totalFinancedAmount: number | undefined;
    let monthlyInstallment: number | undefined;
    let profitRateApplied: number | undefined;
    let totalProfit: number | undefined;

    if (args.mode === "CONFIGURED_FINANCE_COMPANY") {
      const rawCompany = await ctx.db.get(args.companyId!);
      assertFinanceCompanyEligibleForNewQuote({
        company: rawCompany,
        orgId: args.orgId,
      });
      const company = rawCompany!;
      // Defensive validation against corrupt or legacy company rows in DB
      assertCustomerLoanTermsValid(company, orgCurrency);

      const configuredAdminFees = requireConfiguredExecutionFees(company, "quotation");

      assertRequestedFinancingTermValid({
        termMonths: args.termMonths,
        gracePeriodMonths: company.gracePeriodMonths,
        maxTermMonths: company.maxTermMonths,
      });
      const gracePeriodMonths = company.gracePeriodMonths ?? 0;

      if (!args.customerEligibilityStatusIds || args.customerEligibilityStatusIds.length === 0) {
        throw new ConvexError("Customer eligibility status is required for configured finance company quotes.");
      }

      // Deduplicate deterministically preserving order
      const deduplicatedStatusIds = Array.from(new Set(args.customerEligibilityStatusIds));
      const selectedStatuses: Array<{ statusId: Id<"orgCustomerStatuses">; label: string }> = [];

      for (const statusId of deduplicatedStatusIds) {
        const statusDoc = await ctx.db.get(statusId);
        if (!statusDoc || statusDoc.orgId !== args.orgId) {
          throw new ConvexError("Customer eligibility status not found in this organization.");
        }
        if (!statusDoc.isActive) {
          throw new ConvexError("Customer eligibility status is inactive or unavailable.");
        }
        selectedStatuses.push({
          statusId,
          label: statusDoc.label,
        });
      }

      const matchedStatusIds = assertCustomerEligibilityForCompany({
        selectedStatusIds: deduplicatedStatusIds,
        companyAcceptedStatusIds: company.acceptedStatuses,
      }) as Id<"orgCustomerStatuses">[];

      customerEligibilitySnapshot = {
        selectedStatuses,
        companyAcceptedStatusIds: company.acceptedStatuses,
        matchedStatusIds,
        evaluatedAt: Date.now(),
      };

      companyRuleSnapshot = buildRuleSnapshot(company);
      // Align companyRuleVersion with snapshot ruleVersion (representing dealer-purchase
      // rules such as adminFees, LTV, and settlement), whereas customerQuotePricingSnapshot
      // freezes the complete customer-facing Murabaha pricing terms.
      companyRuleVersion = companyRuleSnapshot.ruleVersion;

      const calc = calculateUnifiedMurabaha({
        vehiclePrice,
        downPayment: args.downPayment,
        commission: company.commission ?? 0,
        processingFees: configuredAdminFees,
        annualProfitRate: company.profitRate,
        annualInsuranceRate: company.insuranceRate ?? 0,
        termMonths: args.termMonths,
        gracePeriodMonths,
        includesCommissionInDebt: company.includesCommissionInDebt ?? false,
      });

      assertFinancedMurabahaResultValid(calc);

      totalFinancedAmount = calc.financedAmount;
      monthlyInstallment = calc.monthlyInstallment;
      profitRateApplied = company.profitRate;
      totalProfit = calc.totalProfit;

      customerQuotePricingSnapshot = {
        currency: orgCurrency,
        vehiclePrice,
        downPayment: args.downPayment,
        termMonths: args.termMonths,
        executionFees: configuredAdminFees,
        commission: company.commission ?? 0,
        profitRate: company.profitRate,
        insuranceRate: company.insuranceRate ?? 0,
        gracePeriodMonths,
        includesCommissionInDebt: company.includesCommissionInDebt ?? false,
        totalFinancedAmount: calc.financedAmount,
        totalContractValue: calc.totalContractValue,
        monthlyInstallment: calc.monthlyInstallment,
        totalProfit: calc.totalProfit,
        takafulAmount: calc.takafulAmount,
        companyRuleVersion,
      };
    } else if (args.mode === "MANUAL_FINANCE_COMPANY") {
      assertRequestedFinancingTermValid({
        termMonths: args.termMonths,
        gracePeriodMonths: 0,
      });
      if (args.manualAdminFees === undefined) {
        throw new ConvexError(
          "Execution Fees are not configured for this manual finance company quote. Enter the expected execution fee amount, or enter 0 if none are charged."
        );
      }
      assertMajorAmountRepresentable(args.manualAdminFees, orgCurrency, "Manual execution fees");
      if (args.manualCommission !== undefined) {
        assertMajorAmountRepresentable(args.manualCommission, orgCurrency, "Manual commission");
      }
      if (args.manualAdminFees < 0) {
        throw new ConvexError("Execution fees cannot be negative.");
      }
      if (args.manualProfitRate !== undefined && args.manualProfitRate < 0) {
        throw new ConvexError("Manual profit rate cannot be negative.");
      }
      if (args.manualInsuranceRate !== undefined && args.manualInsuranceRate < 0) {
        throw new ConvexError("Manual insurance rate cannot be negative.");
      }
      if (args.manualCommission !== undefined && args.manualCommission < 0) {
        throw new ConvexError("Manual commission cannot be negative.");
      }

      const manualProfitRate = args.manualProfitRate ?? 0;
      const manualInsuranceRate = args.manualInsuranceRate ?? 0;
      const manualCommission = args.manualCommission ?? 0;
      const manualIncludesCommissionInDebt = args.manualIncludesCommissionInDebt ?? true;

      const calc = calculateUnifiedMurabaha({
        vehiclePrice,
        downPayment: args.downPayment,
        commission: manualCommission,
        processingFees: args.manualAdminFees,
        annualProfitRate: manualProfitRate,
        annualInsuranceRate: manualInsuranceRate,
        termMonths: args.termMonths,
        gracePeriodMonths: 0,
        includesCommissionInDebt: manualIncludesCommissionInDebt,
      });

      assertFinancedMurabahaResultValid(calc);

      totalFinancedAmount = calc.financedAmount;
      monthlyInstallment = calc.monthlyInstallment;
      profitRateApplied = manualProfitRate;
      totalProfit = calc.totalProfit;

      customerQuotePricingSnapshot = {
        currency: orgCurrency,
        vehiclePrice,
        downPayment: args.downPayment,
        termMonths: args.termMonths,
        executionFees: args.manualAdminFees,
        commission: manualCommission,
        profitRate: manualProfitRate,
        insuranceRate: manualInsuranceRate,
        gracePeriodMonths: 0,
        includesCommissionInDebt: manualIncludesCommissionInDebt,
        totalFinancedAmount: calc.financedAmount,
        totalContractValue: calc.totalContractValue,
        monthlyInstallment: calc.monthlyInstallment,
        totalProfit: calc.totalProfit,
        takafulAmount: calc.takafulAmount,
      };
    } else {
      // Non-financed or unsupported mode (CASH, INTERNAL_INSTALLMENT, LEASE, or undefined):
      // Murabaha outputs remain undefined so no caller-fabricated values reach storage.
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

    const {
      totalFinancedAmount: _clientFinanced,
      monthlyInstallment: _clientInstallment,
      profitRateApplied: _clientRate,
      totalProfit: _clientProfit,
      manualProviderName,
      manualProfitRate,
      manualInsuranceRate,
      manualAdminFees,
      manualCommission,
      manualIncludesCommissionInDebt,
      customerEligibilityStatusIds: _clientStatusIds,
      ...quoteArgs
    } = args;

    return await ctx.db.insert("quotes", {
      ...quoteArgs,
      vehicleId,
      vehiclePrice,
      // Always written, never left undefined: `applications.finalizeDeal` reads
      // its absence as "quote predates this check" and skips its re-verification.
      desiredProfit: args.desiredProfit ?? 0,
      ...(args.mode === "MANUAL_FINANCE_COMPANY" && manualProviderName !== undefined ? { manualProviderName } : {}),
      ...(args.mode === "MANUAL_FINANCE_COMPANY" && manualProfitRate !== undefined ? { manualProfitRate } : {}),
      ...(args.mode === "MANUAL_FINANCE_COMPANY" && manualInsuranceRate !== undefined ? { manualInsuranceRate } : {}),
      ...(args.mode === "MANUAL_FINANCE_COMPANY" && manualAdminFees !== undefined ? { manualAdminFees } : {}),
      ...(args.mode === "MANUAL_FINANCE_COMPANY" && manualCommission !== undefined ? { manualCommission } : {}),
      ...(args.mode === "MANUAL_FINANCE_COMPANY" && manualIncludesCommissionInDebt !== undefined ? { manualIncludesCommissionInDebt } : {}),
      ...(companyRuleSnapshot ? { companyRuleSnapshot } : {}),
      ...(companyRuleVersion !== undefined ? { companyRuleVersion } : {}),
      ...(customerQuotePricingSnapshot ? { customerQuotePricingSnapshot } : {}),
      ...(customerEligibilitySnapshot ? { customerEligibilitySnapshot } : {}),
      ...(totalFinancedAmount !== undefined ? { totalFinancedAmount } : {}),
      ...(monthlyInstallment !== undefined ? { monthlyInstallment } : {}),
      ...(profitRateApplied !== undefined ? { profitRateApplied } : {}),
      ...(totalProfit !== undefined ? { totalProfit } : {}),
      status: "DRAFT",
      createdBy: user._id,
      createdAt: Date.now(),
    });
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
