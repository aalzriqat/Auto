import { defineTable } from "convex/server";
import { v } from "convex/values";
import { wizardDraftDataValidator } from "../wizardDraftData";
import {
  customerContributionSettlementValidator,
  customerEligibilitySnapshotValidator,
  customerQuotePricingSnapshotValidator,
  dealerContributionSettlementValidator,
  financeCompanyRuleSnapshotValidator,
  financeFeeTemplateValidator,
  ltvBasisValidator,
} from "../utils/financingEconomics";

const commercialDealFields = { orgId: v.id("organizations"), createdBy: v.id("users") };

export const financingIntakeTables = {
  financeCompanies: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    receiptIssuerAliases: v.optional(v.array(v.string())),
    profitRate: v.number(), // e.g. 5.5 for 5.5%
    maxTermMonths: v.number(), // e.g. 72
    gracePeriodMonths: v.number(), // e.g. 3
    insuranceRate: v.optional(v.number()), // e.g. 3.5 for 3.5%
    adminFees: v.optional(v.number()), // Processing Fees
    commission: v.optional(v.number()), // Commission
    includesCommissionInDebt: v.optional(v.boolean()),
    maxFinancingLTV: v.optional(v.number()), // e.g. 85 for 85% Loan-to-Value
    isActive: v.boolean(),
    acceptedStatuses: v.optional(v.array(v.id("orgCustomerStatuses"))), // undefined/empty = accepts all
    deactivatedAt: v.optional(v.number()),
    deactivatedBy: v.optional(v.id("users")),

    /**
     * Optimistic-concurrency token for full-form company edits.
     *
     * Distinct from ruleVersion: ruleVersion freezes dealer-purchase economics
     * for historical deals, while editRevision covers every mutable field the
     * settings forms can overwrite (name, customer terms, statuses, activity,
     * and dealer rules). Legacy rows without it read as revision 1.
     */
    editRevision: v.optional(v.number()),

    // --- Dealer-side purchase rules -------------------------------------
    // The fields above describe the loan the company sells the CUSTOMER. These
    // describe the purchase it makes from the DEALERSHIP, which is a different
    // transaction with different terms and was previously unmodelled — only
    // maxFinancingLTV existed, and nothing server-side ever read it.
    //
    // Every one is optional so the 25 existing companies keep working
    // untouched; `buildRuleSnapshot` supplies conservative defaults.
    //
    // Bumped by finance.updateCompany on any rule change, and pointed at by the
    // immutable financeCompanyRuleVersions row an application snapshots.
    ruleVersion: v.optional(v.number()),
    defaultLtvPercent: v.optional(v.number()),
    minimumLtvPercent: v.optional(v.number()),
    ltvBasis: v.optional(ltvBasisValidator),
    minimumCustomerFirstPaymentMinor: v.optional(v.number()),
    allowedAppraisalVariancePercent: v.optional(v.number()),
    // Whether the company may buy at the dealer's submitted quotation when the
    // independent appraisal lands lower, and by how much it may fall short.
    allowsQuotationAboveAppraisal: v.optional(v.boolean()),
    lowerAppraisalTolerancePercent: v.optional(v.number()),
    quotationExceptionApproval: v.optional(
      v.union(v.literal("AUTOMATIC"), v.literal("MANUAL"))
    ),
    // How the company settles: whether the dealer wires its contribution
    // separately or the company nets it out, and whether customer money the
    // company collects is passed through to the dealer inside the purchase
    // price or retained. Both patterns are real; neither can be assumed.
    dealerContributionSettlement: v.optional(dealerContributionSettlementValidator),
    customerContributionSettlement: v.optional(customerContributionSettlementValidator),
    feesDeductedFromSettlement: v.optional(v.boolean()),
    // Whether the customer's first payment offsets the unfinanced share. The
    // quotation solver only applies when it does; unset makes the solver
    // decline rather than assume.
    customerFirstPaymentOffsetsUnfinancedShare: v.optional(v.boolean()),
    feeTemplates: v.optional(v.array(financeFeeTemplateValidator)),
  }).index("by_org", ["orgId"]),

  /**
   * Immutable snapshot of a finance company's dealer-side rules, written once
   * per version whenever those rules change.
   *
   * Applications point at a version and also carry an inline copy, so a
   * historical deal's terms cannot be rewritten by editing the company later —
   * which is exactly what would happen if the rules were only ever read live.
   */
  financeCompanyRuleVersions: defineTable({
    orgId: v.id("organizations"),
    companyId: v.id("financeCompanies"),
    version: v.number(),
    snapshot: financeCompanyRuleSnapshotValidator,
    note: v.optional(v.string()),
    createdAt: v.number(),
    createdBy: v.optional(v.id("users")),
  })
    .index("by_org", ["orgId"])
    .index("by_company", ["companyId"])
    .index("by_company_version", ["companyId", "version"]),

  vehicleValuations: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    companyId: v.id("financeCompanies"),
    valuationAmount: v.number(),
    expiresAt: v.optional(v.number()), // timestamp
  })
    .index("by_org", ["orgId"])
    .index("by_vehicle", ["vehicleId"])
    .index("by_company", ["companyId"])
    .index("by_org_vehicle_company", ["orgId", "vehicleId", "companyId"]),

  guarantors: defineTable({
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    firstName: v.string(),
    lastName: v.string(),
    nationalId: v.string(),
    phone: v.string(),
    relationship: v.optional(v.string()),
    income: v.optional(v.number()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_customer", ["customerId"]),

  quotes: defineTable({
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    vehicleId: v.id("vehicles"),
    // When set, this quote covers multiple vehicles (or several units of the
    // same model — each still its own inventory row/VIN). vehicleId/vehiclePrice
    // above become derived convenience values (first line item / sum of all
    // line items) for single-vehicle readers that haven't been updated yet.
    vehicleItems: v.optional(v.array(v.object({
      vehicleId: v.id("vehicles"),
      unitPrice: v.number(),
    }))),
    companyId: v.optional(v.id("financeCompanies")), // Null if cash deal
    mode: v.optional(v.union(
      v.literal("CASH"),
      v.literal("CONFIGURED_FINANCE_COMPANY"),
      v.literal("MANUAL_FINANCE_COMPANY"),
      v.literal("INTERNAL_INSTALLMENT"),
      v.literal("LEASE"),
    )),
    leadId: v.optional(v.id("leads")), // Set when the quote was generated from a lead's context

    // Core parameters
    vehiclePrice: v.number(),
    // The dealer's own margin on the deal, as the client that built the quote
    // defines it. Display only (SCRUM-260): the minimum-profit check derives the
    // margin from `vehiclePrice` itself, in convex/utils/profitApproval.ts.
    desiredProfit: v.optional(v.number()),
    downPayment: v.number(),
    termMonths: v.number(),

    // Financing Engine output
    totalFinancedAmount: v.optional(v.number()), // Principal + Insurance + Fees
    monthlyInstallment: v.optional(v.number()),
    profitRateApplied: v.optional(v.number()),
    totalProfit: v.optional(v.number()),

    recipientName: v.optional(v.string()), // Who the quote is addressed to (e.g. a financing company, for installment deals)
    manualProviderName: v.optional(v.string()),
    manualProfitRate: v.optional(v.number()),
    manualInsuranceRate: v.optional(v.number()),
    manualAdminFees: v.optional(v.number()),
    manualCommission: v.optional(v.number()),
    manualIncludesCommissionInDebt: v.optional(v.boolean()),

    // Frozen finance company rule snapshot and version at the time the quotation was calculated.
    // Bound to the quotation so createFromQuote and dealer-side economics remain anchored
    // to the identical fee authority even if the finance company settings change later.
    companyRuleVersion: v.optional(v.number()),
    companyRuleSnapshot: v.optional(financeCompanyRuleSnapshotValidator),
    customerQuotePricingSnapshot: v.optional(customerQuotePricingSnapshotValidator),
    customerEligibilitySnapshot: v.optional(customerEligibilitySnapshotValidator),
    supersededAt: v.optional(v.number()),

    status: v.union(v.literal("DRAFT"), v.literal("SHARED"), v.literal("ACCEPTED"), v.literal("EXPIRED")),
    expiresAt: v.optional(v.number()),
    createdBy: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_customer", ["customerId"])
    .index("by_vehicle", ["vehicleId"])
    .index("by_status", ["status"])
    .index("by_org_vehicle_status", ["orgId", "vehicleId", "status"])
    .index("by_org_customer_status", ["orgId", "customerId", "status"])
    .index("by_lead", ["leadId"]),

  applicationStatusLog: defineTable({
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    fromStatus: v.optional(v.string()),
    toStatus: v.string(),
    changedBy: v.id("users"),
    changedAt: v.number(),
    note: v.optional(v.string()),
  })
    .index("by_application", ["applicationId"])
    .index("by_org", ["orgId"]),

  /**
   * SCRUM-808: one row per organization, the last deal number handed out. Read and written only by
   * `allocateDealNumber` (convex/utils/dealNumber.ts), inside the mutation that creates the deal.
   */
  dealNumberCounters: defineTable({
    orgId: v.id("organizations"),
    lastNumber: v.number(),
  }).index("by_org", ["orgId"]),

  commercialDeals: defineTable(v.union(
    v.object({ ...commercialDealFields, kind: v.literal("QUOTED"), quoteId: v.id("quotes") }),
    v.object({ ...commercialDealFields, kind: v.literal("WALK_IN"), walkInSaleNumber: v.number() }),
    v.object({ ...commercialDealFields, kind: v.literal("DETACHED") }),
  ))
    .index("by_org", ["orgId"])
    .index("by_org_quote", ["orgId", "quoteId"]),

  /**
   * Every appraisal ever recorded against one application.
   *
   * Deliberately per-application rather than per-(vehicle, company) like
   * `vehicleValuations`: that table holds one mutable number shared by every
   * deal the vehicle appears in, so re-using a vehicle in a later application
   * silently overwrote the basis the earlier deal was approved on. History here
   * is append-only — a reappraisal supersedes its predecessor rather than
   * replacing it.
   */
  financeAppraisals: defineTable({
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    vehicleId: v.id("vehicles"),
    companyId: v.optional(v.id("financeCompanies")),
    appraisalAmountMinor: v.number(),
    currency: v.string(),
    // Who performed it. The independent appraisal is performed or approved by
    // the financing company; a dealer estimate is not an appraisal and is
    // marked as such so it can never be mistaken for one.
    providerType: v.union(
      v.literal("FINANCE_COMPANY"),
      v.literal("INDEPENDENT"),
      v.literal("DEALER_ESTIMATE")
    ),
    providerName: v.optional(v.string()),
    appraisedAt: v.number(),
    documentStorageIds: v.optional(v.array(v.id("_storage"))),
    isReappraisal: v.boolean(),
    reappraisalReason: v.optional(v.string()),
    status: v.union(
      v.literal("RECORDED"),
      v.literal("APPROVED"),
      v.literal("SUPERSEDED"),
      v.literal("REJECTED")
    ),
    supersededAt: v.optional(v.number()),
    supersededByAppraisalId: v.optional(v.id("financeAppraisals")),
    notes: v.optional(v.string()),
    recordedBy: v.id("users"),
    recordedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_application", ["applicationId"])
    .index("by_vehicle", ["vehicleId"]),

  /**
   * Audit trail for every manual override of a financing figure.
   *
   * Separate from `applicationStatusLog`, which records status transitions
   * only. An override that changed a number without changing a status left no
   * trace at all before this.
   */
  financeApplicationOverrides: defineTable({
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    field: v.string(),
    previousValue: v.optional(v.string()),
    newValue: v.string(),
    reason: v.string(),
    changedBy: v.id("users"),
    changedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_application", ["applicationId"]),

  companyDocumentRules: defineTable({
    orgId: v.id("organizations"),
    companyId: v.optional(v.id("financeCompanies")), // Null means required for ALL deals (e.g., ID)
    documentName: v.string(), // e.g., "Salary Certificate"
    isRequired: v.boolean(),
    description: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_company", ["companyId"]),

  applicationDocuments: defineTable({
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    ruleId: v.id("companyDocumentRules"),
    fileId: v.optional(v.id("_storage")),
    supersededAt: v.optional(v.number()),
    status: v.union(
      v.literal("MISSING"),
      v.literal("UPLOADED"),
      v.literal("VERIFIED"),
      v.literal("REJECTED"),
      v.literal("WAIVED")
    ),
    rejectionReason: v.optional(v.string()),
    waiverReason: v.optional(v.string()),
    uploadedAt: v.optional(v.number()),
    verifiedBy: v.optional(v.id("users")),
    waivedBy: v.optional(v.id("users")),
    waivedAt: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_application", ["applicationId"])
    .index("by_rule", ["ruleId"])
    .index("by_file", ["fileId"]),

  wizardDrafts: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    paymentType: v.string(),
    currentStep: v.number(),
    wizardData: wizardDraftDataValidator,
    selectedCustomerId: v.optional(v.string()),
    savedAt: v.number(),
  })
    .index("by_org_user", ["orgId", "userId"]),
};
