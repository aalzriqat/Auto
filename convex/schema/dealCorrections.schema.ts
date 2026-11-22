import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  approvedPurchaseBasisValidator,
  quotationCalculationSnapshotValidator,
  quotationSourceValidator,
} from "../utils/financingEconomics";
import { underwritingSnapshotValidator } from "./underwritingSnapshot.schema";

const deliveredLenderCorrectionFields = {
  orgId: v.id("organizations"),
  applicationId: v.id("financeApplications"),
  originalQuoteId: v.id("quotes"),
  replacementQuoteId: v.id("quotes"),
  originalCompanyId: v.id("financeCompanies"),
  replacementCompanyId: v.id("financeCompanies"),
  handoverAt: v.number(),
  economicsStamp: v.string(),
  reason: v.string(),
  requestedBy: v.id("users"),
  requestedAt: v.number(),
};

const deliveredCorrectionResolutionFields = {
  resolvedBy: v.id("users"),
  resolvedAt: v.number(),
};

const deliveredIdentityCorrectionFields = {
  orgId: v.id("organizations"),
  applicationId: v.id("financeApplications"),
  originalQuoteId: v.id("quotes"),
  replacementQuoteId: v.id("quotes"),
  originalCustomerId: v.id("customers"),
  replacementCustomerId: v.id("customers"),
  originalVehicleId: v.id("vehicles"),
  replacementVehicleId: v.id("vehicles"),
  kind: v.union(v.literal("BUYER"), v.literal("VEHICLE")),
  handoverAt: v.number(),
  handoverBy: v.id("users"),
  handoverNotes: v.optional(v.string()),
  economicsStamp: v.string(),
  reason: v.string(),
  requestedBy: v.id("users"),
  requestedAt: v.number(),
};

export const dealCorrectionsTables = {
  deliveredLenderCorrections: defineTable(v.union(
    v.object({ ...deliveredLenderCorrectionFields, status: v.literal("PENDING") }),
    v.object({
      ...deliveredLenderCorrectionFields,
      ...deliveredCorrectionResolutionFields,
      status: v.literal("WITHDRAWN"),
    }),
    v.object({
      ...deliveredLenderCorrectionFields,
      ...deliveredCorrectionResolutionFields,
      status: v.literal("APPROVED"),
      lenderApprovalReference: v.string(),
      originalApproval: v.object({
        amountMinor: v.number(),
        approvedAt: v.optional(v.number()),
        approvedBy: v.optional(v.id("users")),
        basis: v.optional(approvedPurchaseBasisValidator),
        appraisalId: v.optional(v.id("financeAppraisals")),
        exceptionRuleVersion: v.optional(v.number()),
        notes: v.optional(v.string()),
        quotationMinor: v.optional(v.number()),
        quotationSource: v.optional(quotationSourceValidator),
        quotationOverrideReason: v.optional(v.string()),
        quotationAt: v.optional(v.number()),
        quotationBy: v.optional(v.id("users")),
        appliedLtvPercent: v.optional(v.number()),
        quotationSnapshot: v.optional(quotationCalculationSnapshotValidator),
        underwritingSnapshot: v.optional(underwritingSnapshotValidator),
      }),
    }),
  )).index("by_org_application", ["orgId", "applicationId"]),

  deliveredDealIdentityCorrections: defineTable(v.union(
    v.object({
      orgId: v.id("organizations"),
      applicationId: v.id("financeApplications"),
      status: v.literal("APPLIED_BEFORE_HANDOVER"),
      kind: v.union(v.literal("BUYER"), v.literal("VEHICLE")),
      originalQuoteId: v.id("quotes"),
      replacementQuoteId: v.id("quotes"),
      reason: v.string(),
      lenderConfirmationReference: v.optional(v.string()),
      ...deliveredCorrectionResolutionFields,
      retiredRootId: v.id("commitmentRoots"),
      replacementRootId: v.id("commitmentRoots"),
      // Values come from the validated original application and the server's patch keys.
      originalValues: v.record(v.string(), v.any()),
    }),
    v.object({ ...deliveredIdentityCorrectionFields, status: v.literal("PENDING") }),
    v.object({
      ...deliveredIdentityCorrectionFields,
      ...deliveredCorrectionResolutionFields,
      status: v.literal("WITHDRAWN"),
    }),
    v.object({
      ...deliveredIdentityCorrectionFields,
      ...deliveredCorrectionResolutionFields,
      status: v.literal("APPROVED"),
      returnedAt: v.number(),
      returnReference: v.string(),
      originalApproval: v.object({
        amountMinor: v.number(),
        approvedAt: v.optional(v.number()),
        approvedBy: v.optional(v.id("users")),
        basis: v.optional(approvedPurchaseBasisValidator),
        appraisalId: v.optional(v.id("financeAppraisals")),
        notes: v.optional(v.string()),
        exceptionRuleVersion: v.optional(v.number()),
        quotationMinor: v.optional(v.number()),
        quotationAt: v.optional(v.number()),
        quotationBy: v.optional(v.id("users")),
        quotationSource: v.optional(quotationSourceValidator),
        quotationOverrideReason: v.optional(v.string()),
        appliedLtvPercent: v.optional(v.number()),
        companyRuleVersionId: v.optional(v.id("financeCompanyRuleVersions")),
        purchaseCorrectedAt: v.optional(v.number()),
        quotationSnapshot: v.optional(quotationCalculationSnapshotValidator),
        underwritingSnapshot: v.optional(underwritingSnapshotValidator),
      }),
      retiredRootId: v.id("commitmentRoots"),
      replacementRootId: v.id("commitmentRoots"),
    }),
  ))
    .index("by_org_application", ["orgId", "applicationId"])
    .index("by_org_application_status", ["orgId", "applicationId", "status"]),

  /**
   * SCRUM-693: one server-owned unwind of a CLOSED, finance-company-paid deal.
   * While a row is ACTIVE no other command may re-disburse, re-forward,
   * re-register the expected payment, pay the commission or cancel the deal
   * around it (`assertNoActiveDealUnwind`). Each money leg is recorded with its
   * evidence only after its reversal is proven POSTED on the books.
   */
  dealUnwinds: defineTable({
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    saleId: v.id("sales"),
    status: v.union(v.literal("ACTIVE"), v.literal("COMPLETED"), v.literal("ABANDONED")),
    reason: v.string(),
    startedBy: v.id("users"),
    startedAt: v.number(),
    // Snapshots taken at start; every later step refuses when they drifted.
    remittanceVersion: v.number(),
    remittanceMinor: v.number(),
    remittanceMethod: v.union(v.literal("BANK_TRANSFER"), v.literal("CASH")),
    forwardDueMinor: v.number(),
    forwardReturn: v.optional(
      v.object({
        forwardId: v.optional(v.id("financeCompanyForwards")),
        returnedAt: v.number(),
        reference: v.string(),
        recordedBy: v.id("users"),
        recordedAt: v.number(),
      })
    ),
    remittanceRefund: v.optional(
      v.object({
        method: v.union(v.literal("BANK_TRANSFER"), v.literal("CASH")),
        refundedAt: v.number(),
        bankReference: v.optional(v.string()),
        voucherNumber: v.optional(v.string()),
        recipientAcknowledged: v.optional(v.boolean()),
        amountMinor: v.number(),
        paymentId: v.id("canonicalPayments"),
        reversedAllocationIds: v.array(v.id("paymentAllocations")),
        // D5: REVERSED = the posted receipt journal was reversed; NOT_POSTED =
        // it was only queued and the queued post was cancelled.
        receiptReversal: v.union(v.literal("REVERSED"), v.literal("NOT_POSTED")),
        recordedBy: v.id("users"),
        recordedAt: v.number(),
      })
    ),
    completion: v.optional(
      v.object({
        creditNoteReference: v.string(),
        vehicleReturnedAt: v.number(),
        vehicleReturnNote: v.string(),
        customerPaymentDisposition: v.union(v.literal("REFUND"), v.literal("RETAIN_CREDIT")),
        customerReceiptSettlement: v.optional(v.object({
          refundedMinor: v.number(),
          retainedMinor: v.number(),
          refundPaymentIds: v.array(v.id("canonicalPayments")),
          refundEventIds: v.array(v.id("accountingEvents")),
          method: v.optional(v.union(v.literal("BANK_TRANSFER"), v.literal("CASH"))),
          reference: v.optional(v.string()),
          paidAt: v.optional(v.number()),
        })),
        completedBy: v.id("users"),
        completedAt: v.number(),
      })
    ),
    abandonment: v.optional(
      v.object({
        reason: v.string(),
        abandonedBy: v.id("users"),
        abandonedAt: v.number(),
      })
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org_application_status", ["orgId", "applicationId", "status"])
    .index("by_org_sale_status", ["orgId", "saleId", "status"]),
};
