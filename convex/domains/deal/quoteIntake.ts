import { IN_FLIGHT_FINANCE_STATUSES } from "../../utils/financeStatuses";
import { ConvexError } from "convex/values";
import { type MutationCtx } from "../../_generated/server";
import { type Doc, type Id } from "../../_generated/dataModel";
import { mayRecordSubmittedQuotation } from "../../utils/financeApplicationProjection";
import { notifyManagers, getActorName } from "../../utils/notifications";
import { assertReservationAdoptableWithoutDeposit } from "../../utils/depositRequestGuards";
import { assertOperatedDealMode } from "../../utils/dealModes";
import { allocateQuotedApplicationIdentity } from "../../utils/quotedCommercialDeal";
import { getOrgCurrency } from "../../accounting/workflowHooks";
import { assertSupportedDenomination } from "../../utils/money";
import { type FinanceCompanyRuleSnapshot } from "../../utils/financingEconomics";
import {
  resolveCreationEconomicsInputs,
  resolveCreationRuleSnapshot,
} from "../../utils/creationEconomics";
import { type TenantAuthContext } from "../../utils/tenancy";

type QuoteCommitmentLineage = {
  quoteId: Id<"quotes">;
  adoptReservationId?: Id<"vehicleReservations">;
};
type InitialSubmittedQuotation = {
  submittedQuotationMinor: number;
  source: "SYSTEM_CALCULATED";
};

export type QuoteMode =
  | "CASH"
  | "CONFIGURED_FINANCE_COMPANY"
  | "MANUAL_FINANCE_COMPANY"
  | "INTERNAL_INSTALLMENT"
  | "LEASE";

type CreateFromQuoteInput = {
  orgId: Id<"organizations">;
  quoteId: Id<"quotes">;
  adoptReservationId?: Id<"vehicleReservations">;
  notes?: string;
  confirmedCalculatedQuotationMinor?: number;
};

/**
 * SCRUM-195: EXPLICIT proof that this financed deal continues the
 * reservation already holding the car. Never inferred.
 */
/**
 * SCRUM-404: the AutoFlow-calculated quotation the operator was SHOWN in the
 * wizard and confirmed by starting the application. Present, the deal is
 * created with that exact figure recorded as its SYSTEM_CALCULATED
 * submitted quotation, in the same transaction — or not created at all.
 * Absent, creation is exactly what it was before: no quotation recorded.
 * Never inferred: only the wizard's explicit confirmation sends it.
 */
export async function executeCreateFromQuote(
  ctx: MutationCtx,
  args: CreateFromQuoteInput,
  auth: TenantAuthContext,
  assertAcquirable: (
    ctx: MutationCtx,
    args: {
      orgId: Id<"organizations">;
      vehicleId: Id<"vehicles">;
      lineage: QuoteCommitmentLineage;
      vehicle?: Doc<"vehicles">;
    },
  ) => Promise<void>,
  acquireVehicle: (
    ctx: MutationCtx,
    args: {
      orgId: Id<"organizations">;
      vehicleId: Id<"vehicles">;
      customerId: Id<"customers">;
      createdBy: Id<"users">;
      evidence: { kind: "FINANCE"; applicationId: Id<"financeApplications"> };
      lineage: QuoteCommitmentLineage;
      vehicle?: Doc<"vehicles">;
    },
  ) => Promise<unknown>,
  assertQuotationRecordAuthority: (
    role: Doc<"roles">,
    quotation: InitialSubmittedQuotation,
  ) => string | undefined,
  applySubmittedQuotation: (
    ctx: MutationCtx,
    record: {
      user: Doc<"users">;
      role: Doc<"roles">;
      app: Doc<"financeApplications">;
      args: InitialSubmittedQuotation & {
        orgId: Id<"organizations">;
        applicationId: Id<"financeApplications">;
      };
      reason: string | undefined;
      recordedVia: "DEAL_CREATION";
    },
  ) => Promise<Id<"financeApplications">>,
) {
  // Recording the quotation is `recordSubmittedQuotation`'s act, so a
  // confirmation needs that door's authority too — asked of the role alone,
  // before anything is read, so a refusal is independent of every row fact.
  // Refused outright rather than silently creating without the quotation:
  // the operator confirmed a figure and must not believe it was recorded.
  const confirmedQuotation =
    args.confirmedCalculatedQuotationMinor === undefined
      ? undefined
      : {
          submittedQuotationMinor: args.confirmedCalculatedQuotationMinor,
          source: "SYSTEM_CALCULATED" as const,
        };
  let confirmedQuotationReason: string | undefined;
  if (confirmedQuotation) {
    if (!mayRecordSubmittedQuotation(auth.role)) {
      throw new ConvexError(
        "Recording the finance company's quotation needs finance-application access. Start the application without it, and ask someone with that access to record the quotation on the deal page.",
      );
    }
    confirmedQuotationReason = assertQuotationRecordAuthority(
      auth.role,
      confirmedQuotation,
    );
  }

  const quote = await ctx.db.get(args.quoteId);
  if (!quote || quote.orgId !== args.orgId) {
    throw new ConvexError("Quote not found.");
  }
  // SCRUM-495: a quote left in a retired mode does not become an application.
  assertOperatedDealMode(quote.mode);
  const customer = await ctx.db.get(quote.customerId);
  if (!customer || customer.orgId !== args.orgId) {
    throw new ConvexError("Quote customer not found in this organization.");
  }

  const quoteVehicleItems = quote.vehicleItems ?? [
    { vehicleId: quote.vehicleId, unitPrice: quote.vehiclePrice },
  ];
  // Financed deals stay single-vehicle for now — finalizeDeal only ever
  // completes app.vehicleId's sale, so a multi-vehicle quote reaching this
  // point would silently drop every other vehicle at finalization. The
  // wizard never produces this today (multi-vehicle is CASH-only), but
  // reject it defensively rather than relying on that never changing.
  if (quoteVehicleItems.length !== 1) {
    throw new ConvexError(
      "Finance applications currently support exactly one vehicle.",
    );
  }
  const lineVehicles = new Map<Id<"vehicles">, Doc<"vehicles">>();
  for (const item of quoteVehicleItems) {
    const lineVehicle = await ctx.db.get(item.vehicleId);
    if (
      !lineVehicle ||
      lineVehicle.orgId !== args.orgId ||
      lineVehicle.isDeleted
    ) {
      throw new ConvexError("Quote vehicle not found in this organization.");
    }
    lineVehicles.set(item.vehicleId, lineVehicle);
  }
  // Kept for the rule snapshot below rather than re-fetched: this handler
  // already validates the company here, and reading it twice per application
  // buys nothing.
  let quoteCompany: Doc<"financeCompanies"> | null = null;
  if (quote.companyId) {
    quoteCompany = await ctx.db.get(quote.companyId);
    if (!quoteCompany || quoteCompany.orgId !== args.orgId) {
      throw new ConvexError(
        "Quote finance company not found in this organization.",
      );
    }
  }

  // Check if application already exists for this quote
  const existing = await ctx.db
    .query("financeApplications")
    .withIndex("by_org_quote", (q) =>
      q.eq("orgId", args.orgId).eq("quoteId", args.quoteId),
    )
    .first();

  if (existing) {
    throw new ConvexError("An application already exists for this quote.");
  }

  // Every vehicle on the quote should only have one in-flight application at
  // a time. REJECTED and CLOSED applications are effectively terminal, so they
  // must not strand the vehicle — a fresh deal may begin without cancellation.
  //
  // ⚠️ THE LIST IS `IN_FLIGHT_FINANCE_STATUSES`, IMPORTED. It used to be a
  // local copy here, and M3's commit message claimed to have removed it while
  // in fact only ADDING the shared one — so two hand-maintained lists shipped,
  // which is the exact distributed inference this program exists to delete.
  // Both reviewer seats caught it. "Which statuses hold a car" is now answered
  // in one place, and the release side (`hasLiveCommitmentBasis`) reads the
  // same array, so acquisition and release cannot drift apart.
  for (const item of quoteVehicleItems) {
    const vehicleApplications = await ctx.db
      .query("financeApplications")
      .withIndex("by_org_vehicle", (q) =>
        q.eq("orgId", args.orgId).eq("vehicleId", item.vehicleId),
      )
      .collect();
    const activeForVehicle = vehicleApplications.find((r) =>
      IN_FLIGHT_FINANCE_STATUSES.includes(r.status),
    );
    if (activeForVehicle) {
      throw new ConvexError(
        "This vehicle already has an active finance application. Cancel it before starting a new one.",
      );
    }
  }

  const economicsCurrency = await getOrgCurrency(ctx, args.orgId);
  assertSupportedDenomination(
    economicsCurrency,
    "creating the finance application",
  );

  let proposedInstallment: number;
  let totalFinancedAmount: number | undefined;

  if (quote.customerQuotePricingSnapshot) {
    if (quote.customerQuotePricingSnapshot.currency !== economicsCurrency) {
      throw new ConvexError(
        `Quote currency (${quote.customerQuotePricingSnapshot.currency}) does not match organization currency (${economicsCurrency}).`,
      );
    }
    if (
      quote.monthlyInstallment !== undefined &&
      Math.abs(
        quote.monthlyInstallment -
          quote.customerQuotePricingSnapshot.monthlyInstallment,
      ) > 1e-4
    ) {
      throw new ConvexError(
        "Quotation monthly installment does not match its frozen customer pricing snapshot.",
      );
    }
    if (
      quote.totalFinancedAmount !== undefined &&
      Math.abs(
        quote.totalFinancedAmount -
          quote.customerQuotePricingSnapshot.totalFinancedAmount,
      ) > 1e-4
    ) {
      throw new ConvexError(
        "Quotation total financed amount does not match its frozen customer pricing snapshot.",
      );
    }
    proposedInstallment = quote.customerQuotePricingSnapshot.monthlyInstallment;
    totalFinancedAmount =
      quote.customerQuotePricingSnapshot.totalFinancedAmount;
  } else {
    proposedInstallment = quote.monthlyInstallment ?? 0;
    totalFinancedAmount = quote.totalFinancedAmount;
  }

  const customerGuarantors = await ctx.db
    .query("guarantors")
    .withIndex("by_customer", (q) => q.eq("customerId", quote.customerId))
    .collect();
  // Rows with `isDeleted` absent are kept — only an explicit `true` excludes.
  const guarantors = customerGuarantors.filter((g) => g.isDeleted !== true);

  const salary = customer.employment?.salary;
  const existingMonthlyDebt = customer.financials?.totalMonthlyDebt;
  const dbr =
    salary && salary > 0
      ? ((existingMonthlyDebt ?? 0) + proposedInstallment) / salary
      : undefined;

  let vehicleValuation: number | undefined;
  let ltv: number | undefined;
  if (quote.companyId) {
    const valuationCompanyId = quote.companyId;
    const valuations = await Promise.all(
      quoteVehicleItems.map(
        async (item) =>
          // SCRUM-557: one tenant-led (org, vehicle, company) point read; a row
          // stamped with another org is never selected.
          (await ctx.db
            .query("vehicleValuations")
            .withIndex("by_org_vehicle_company", (q) =>
              q
                .eq("orgId", args.orgId)
                .eq("vehicleId", item.vehicleId)
                .eq("companyId", valuationCompanyId),
            )
            .first()) ?? null,
      ),
    );
    // Only treat the combined valuation as meaningful if every vehicle on the
    // quote has one — a partial sum would understate true collateral value.
    const allValued = valuations.every((v) => v?.valuationAmount !== undefined);
    vehicleValuation = allValued
      ? valuations.reduce((sum, v) => sum + (v?.valuationAmount ?? 0), 0)
      : undefined;
    if (vehicleValuation && totalFinancedAmount !== undefined) {
      ltv = (totalFinancedAmount / vehicleValuation) * 100;
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
          ...(quote.manualProviderName !== undefined
            ? { providerName: quote.manualProviderName }
            : {}),
          ...(quote.manualProfitRate !== undefined
            ? { profitRate: quote.manualProfitRate }
            : {}),
          ...(quote.manualInsuranceRate !== undefined
            ? { insuranceRate: quote.manualInsuranceRate }
            : {}),
          ...(quote.manualAdminFees !== undefined
            ? { adminFees: quote.manualAdminFees }
            : {}),
          ...(quote.manualCommission !== undefined
            ? { commission: quote.manualCommission }
            : {}),
          ...(quote.manualIncludesCommissionInDebt !== undefined
            ? { includesCommissionInDebt: quote.manualIncludesCommissionInDebt }
            : {}),
          ...(totalFinancedAmount !== undefined ? { totalFinancedAmount } : {}),
          ...(proposedInstallment !== undefined
            ? { monthlyInstallment: proposedInstallment }
            : {}),
          ...(quote.totalProfit !== undefined
            ? { totalProfit: quote.totalProfit }
            : {}),
        }
      : undefined;

  // Snapshot the finance company's dealer-purchase rules onto the
  // application, and point at the immutable version row they came from.
  // When the quote froze its rule snapshot at creation, that frozen authority
  // is preserved so subsequent edits to the finance company cannot silently
  // reinterpret the financial basis (installment, financed amount, DBR, LTV).
  //
  // The choice and the fee-template limit live in `resolveCreationRuleSnapshot`
  // so the creation-time quotation preview resolves the SAME rules (SCRUM-404).
  const companyRuleSnapshot: FinanceCompanyRuleSnapshot | undefined =
    resolveCreationRuleSnapshot(quote, quoteCompany);
  let companyRuleVersionId: Id<"financeCompanyRuleVersions"> | undefined;
  if (quote.mode === "CONFIGURED_FINANCE_COMPANY") {
    if (companyRuleSnapshot) {
      const versionRow = await ctx.db
        .query("financeCompanyRuleVersions")
        .withIndex("by_company_version", (q) =>
          q
            .eq("companyId", quote.companyId!)
            .eq("version", companyRuleSnapshot!.ruleVersion),
        )
        .first();
      if (versionRow) companyRuleVersionId = versionRow._id;
    }
  }

  // Carry the commercial facts the operator already stated on the quote
  // into the application that owns the dealer-side economics. Leaving these
  // behind made a fresh application look as though no target or customer
  // first payment had ever been recorded: the quotation solver returned
  // NO_TARGET_RECORDED, its dialog opened blank, and the financial summary
  // contradicted the financing-plan card by showing a zero first payment.
  //
  // The quote stores major units; application economics are always minor
  // units in an explicit denomination. Resolve and validate that
  // denomination before any write, then convert once at this lineage
  // boundary. A corrupt NaN/negative legacy quote must fail closed rather
  // than seed unusable economics (Convex's v.number() accepts NaN).
  //
  // Only costs the frozen policy explicitly says are included in the
  // quotation belong in the solver input. Other expected handover costs
  // remain visible in the deal checklist, but adding them here would charge
  // the customer for a cost the policy explicitly excluded. EMPLOYEE means
  // the dealership advances/reimburses the money and is therefore
  // dealer-borne, matching the cockpit's financial summary classification.
  //
  // One resolver, shared with the creation-time quotation preview (SCRUM-404).
  const {
    targetSellingAmountMinor,
    customerFirstPaymentMinor,
    dealerBorneExpensesMinor,
  } = resolveCreationEconomicsInputs({
    quote,
    companyRuleSnapshot,
    currency: economicsCurrency,
  });

  // SCRUM-195: a live finance application is per-vehicle commitment evidence
  // in its own right — no deposit required. So creating one is an
  // ACQUISITION and goes through the same authority boundary as a deposit or
  // a reservation, refusing before anything is written.
  //
  // The quote is the lineage: a financed deal that already took a deposit
  // JOINS the root that deposit opened (the ordinary financed flow), while a
  // quote that has proven nothing cannot take a car another deal holds.
  // SCRUM-444 R-B: a funded reservation is never adopted (its money would be
  // invisible to the quote); refused before the authority is even asked.
  if (args.adoptReservationId) {
    await assertReservationAdoptableWithoutDeposit(ctx, {
      orgId: args.orgId,
      reservationId: args.adoptReservationId,
    });
  }
  for (const item of quoteVehicleItems) {
    await assertAcquirable(ctx, {
      orgId: args.orgId,
      vehicleId: item.vehicleId,
      lineage: {
        quoteId: quote._id,
        adoptReservationId: args.adoptReservationId,
      },
      vehicle: lineVehicles.get(item.vehicleId),
    });
  }

  // Allocate the number and canonical quote link in the same transaction as the application.
  const dealIdentity = await allocateQuotedApplicationIdentity(ctx, quote);
  const appId = await ctx.db.insert("financeApplications", {
    orgId: args.orgId,
    ...dealIdentity,
    quoteId: quote._id,
    customerId: quote.customerId,
    vehicleId: quote.vehicleId,
    ...(quote.vehicleItems ? { vehicleItems: quote.vehicleItems } : {}),
    companyId: quote.companyId,
    salespersonId: auth.user._id,
    status: "PENDING_DOCS",
    // The legacy `status` above stays the field every existing reader uses.
    // These carry the five dimensions it conflates; a new application has
    // been submitted for credit and nothing else has happened yet.
    creditDecision: "SUBMITTED",
    appraisalStatus: "NOT_REQUESTED",
    settlementStatus: "NOT_READY",
    handoverStatus: "BLOCKED",
    economicsCurrency,
    targetSellingAmountMinor,
    targetNetProceedsMinor: targetSellingAmountMinor,
    customerFirstPaymentMinor,
    estimatedDealerBorneExpensesMinor: dealerBorneExpensesMinor,
    estimatedClosingExpensesMinor: dealerBorneExpensesMinor,
    ...(companyRuleSnapshot ? { companyRuleSnapshot } : {}),
    ...(companyRuleVersionId ? { companyRuleVersionId } : {}),
    ...(quote.customerQuotePricingSnapshot
      ? { customerQuotePricingSnapshot: quote.customerQuotePricingSnapshot }
      : {}),
    notes: args.notes,
    createdAt: now,
    updatedAt: now,
    ...(quote.mode !== undefined ? { quoteModeAtSubmission: quote.mode } : {}),
    ...(manualFinanceSnapshot ? { manualFinanceSnapshot } : {}),
    underwritingSnapshot,
  });

  // ⚠️ TAGGED FINANCE, not DEPOSIT. The application is the defining evidence
  // here even when a deposit exists on the same deal — they are two separate
  // episodes on one root, and each must be able to end independently.
  for (const item of quoteVehicleItems) {
    await acquireVehicle(ctx, {
      orgId: args.orgId,
      vehicleId: item.vehicleId,
      customerId: quote.customerId,
      createdBy: auth.user._id,
      evidence: { kind: "FINANCE", applicationId: appId },
      lineage: {
        quoteId: quote._id,
        adoptReservationId: args.adoptReservationId,
      },
      vehicle: lineVehicles.get(item.vehicleId),
    });
  }

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
    { link: `/${args.orgId}/applications` },
  );

  // SCRUM-404: record the quotation the operator confirmed, through the SAME
  // code `recordSubmittedQuotation` runs after its ownership check — the row
  // is this mutation's own insert. SYSTEM_CALCULATED demands exact equality
  // with the solver on the row's frozen inputs, so a figure that went stale
  // between the preview and this click refuses, and the refusal rolls back
  // everything above: the application, the acquisition, the status log, the
  // documents and the notifications (all transactional writes).
  if (confirmedQuotation) {
    const inserted = await ctx.db.get(appId);
    if (!inserted) {
      throw new ConvexError(
        "The new finance application could not be read back.",
      );
    }
    await applySubmittedQuotation(ctx, {
      user: auth.user,
      role: auth.role,
      app: inserted,
      args: { orgId: args.orgId, applicationId: appId, ...confirmedQuotation },
      reason: confirmedQuotationReason,
      recordedVia: "DEAL_CREATION",
    });
  }

  return appId;
}
