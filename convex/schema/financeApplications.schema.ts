import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  appraisalStatusValidator,
  approvedPurchaseBasisValidator,
  creditDecisionValidator,
  customerContributionSettlementValidator,
  customerQuotePricingSnapshotValidator,
  dealerContributionSettlementValidator,
  feeResponsibilityValidator,
  financeCompanyRuleSnapshotValidator,
  financingFailureReasonValidator,
  gapResolutionValidator,
  handoverStatusValidator,
  quotationCalculationSnapshotValidator,
  quotationSourceValidator,
  settlementStatusValidator,
} from "../utils/financingEconomics";
import { consignedSettlementRouteValidator } from "../utils/vehicleOwnership";
import { supplierIdentityRepairStamp } from "./supplierIdentity.schema";
import { underwritingSnapshotValidator } from "./underwritingSnapshot.schema";

export const financeApplicationsTables = {
  financeApplications: defineTable({
    orgId: v.id("organizations"),
    dealId: v.optional(v.id("commercialDeals")),
    quoteId: v.id("quotes"),
    customerId: v.id("customers"),
    vehicleId: v.id("vehicles"),
    // Mirrors quotes.vehicleItems — snapshotted at application creation so
    // finalization can complete a sale per vehicle without re-reading the quote.
    vehicleItems: v.optional(v.array(v.object({
      vehicleId: v.id("vehicles"),
      unitPrice: v.number(),
    }))),
    /**
     * SCRUM-208 — the CURRENT episode PER VEHICLE, not one scalar.
     *
     * ⚠️ A SCALAR HERE WOULD BE WRONG BY CONSTRUCTION. The acquisition path
     * opens one claim PER VEHICLE in the normalized item set, so a single
     * `currentCommitmentClaimId` could only ever name one of them and every
     * other car on the application would fall back to a history search.
     *
     * ⚠️ THE CARDINALITY AUTHORITY IS THE NORMALIZED SET, NOT THIS FIELD AND
     * NOT `vehicleItems`. `vehicleItems` is ABSENT on single-vehicle
     * applications — the commonest shape — so code reading it directly sees
     * zero vehicles for a perfectly ordinary application. The authority is
     * `vehicleItems ?? [{ vehicleId }]`, exactly as the acquisition path
     * normalizes it.
     *
     * Vehicle ids within the set are UNIQUE: a duplicate REFUSES before any
     * claim, root, pointer or status write, and is never silently
     * deduplicated — a repeated car is a caller bug, and collapsing it would
     * post one vehicle's authority under another's intent. The persisted order
     * is canonical (ascending by vehicle id) so two equal sets never compare
     * unequal on order alone.
     */
    currentCommitmentClaims: v.optional(v.array(v.object({
      vehicleId: v.id("vehicles"),
      claimId: v.id("vehicleCommitmentClaims"),
    }))),
    companyId: v.optional(v.id("financeCompanies")),
    salespersonId: v.id("users"),
    cashNoCostCloseout: v.optional(v.object({
      version: v.number(),
      declaredBy: v.id("users"),
      declaredAt: v.number(),
      confirmation: v.optional(v.object({ by: v.id("users"), at: v.number() })),
      invalidated: v.optional(v.literal(true)),
    })),

    status: v.union(
      v.literal("DRAFT"),
      v.literal("PENDING_DOCS"),
      v.literal("UNDER_REVIEW"),
      v.literal("APPROVED"),
      v.literal("REJECTED"),
      v.literal("CLOSED"),
      v.literal("CANCELLED")
    ),

    notes: v.optional(v.string()),
    /**
     * Who is PLANNED to handle this deal's finalization payments, before any
     * cash is handed over. A plan, not money: nothing here is issued, posted
     * or summed, and the actual custody record (`financeDealCustody`) is
     * opened separately and may name someone else. `amountMinor` is the
     * amount the planner agreed to hand over, optional — the server's own
     * recommendation is derived from the deal's employee-paid fee templates
     * and never stored.
     */
    plannedCustody: v.optional(
      v.object({
        userId: v.id("users"),
        amountMinor: v.optional(v.number()),
        note: v.optional(v.string()),
        plannedBy: v.id("users"),
        plannedAt: v.number(),
      })
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
    quoteModeAtSubmission: v.optional(v.union(
      v.literal("CASH"),
      v.literal("CONFIGURED_FINANCE_COMPANY"),
      v.literal("MANUAL_FINANCE_COMPANY"),
      v.literal("INTERNAL_INSTALLMENT"),
      v.literal("LEASE"),
    )),
    manualFinanceSnapshot: v.optional(v.object({
      providerName: v.optional(v.string()),
      profitRate: v.optional(v.number()),
      insuranceRate: v.optional(v.number()),
      adminFees: v.optional(v.number()),
      commission: v.optional(v.number()),
      includesCommissionInDebt: v.optional(v.boolean()),
      totalFinancedAmount: v.optional(v.number()),
      monthlyInstallment: v.optional(v.number()),
      totalProfit: v.optional(v.number()),
    })),
    /**
     * SCRUM-27: what the manager read off the MANUAL finance company's approval
     * letter (OR-8/OR-11). Present only on a manual application; cleared with the
     * approval it belongs to. `dealerSendsMinor` is S = held deposit + dealership
     * contribution - an explicit 0 is a fact, an absent field is "not entered".
     */
    manualApproval: v.optional(v.object({
      approvedAmountMinor: v.number(),
      financierName: v.string(),
      dealerSendsMinor: v.number(),
      enteredBy: v.id("users"),
      enteredAt: v.number(),
    })),
    approvedBy: v.optional(v.id("users")),
    approvedAt: v.optional(v.number()),
    finalizedSaleId: v.optional(v.id("sales")),
    finalizationIdempotencyKey: v.optional(v.string()),
    disbursedAt: v.optional(v.number()),
    disbursedAmountMinor: v.optional(v.number()),
    disbursementIdempotencyKey: v.optional(v.string()),
    // SCRUM-239: which disbursement of this application is live. Absent means 1;
    // a returned cleared cheque bumps it so the next confirmation mints new keys.
    disbursementVersion: v.optional(v.number()),
    // التنازل بالسيارة للعميل — vehicle handover to the customer, registered
    // before finalizeDeal is allowed to run.
    vehicleHandoverAt: v.optional(v.number()),
    firstPaymentEvidenceChecked: v.optional(v.literal(true)),
    pendingFirstPaymentEvidenceCorrectionId: v.optional(v.id("firstPaymentEvidenceCorrections")),
    pendingLenderCorrectionId: v.optional(v.id("deliveredLenderCorrections")),
    pendingIdentityCorrectionId: v.optional(v.id("deliveredDealIdentityCorrections")),
    approvedIdentityCorrectionId: v.optional(v.id("deliveredDealIdentityCorrections")),
    identityFinanceTermsRequiredSince: v.optional(v.number()),
    approvedLenderCorrectionId: v.optional(v.id("deliveredLenderCorrections")),
    vehicleHandoverBy: v.optional(v.id("users")),
    vehicleHandoverNotes: v.optional(v.string()),
    // How and when the deal's payment is expected to be received, registered
    // before finalizeDeal — generalizes the finance-company-only disbursement
    // flow to also cover cash/in-house-installment/cheque/bank deals.
    expectedPaymentMethod: v.optional(v.union(
      v.literal("CASH"),
      v.literal("INTERNAL_INSTALLMENT"),
      v.literal("CHEQUE"),
      v.literal("BANK_TRANSFER"),
    )),
    expectedPaymentDate: v.optional(v.number()),
    expectedPaymentRegisteredAt: v.optional(v.number()),
    expectedPaymentRegisteredBy: v.optional(v.id("users")),
    cancelledBy: v.optional(v.id("users")),
    cancelledAt: v.optional(v.number()),
    cancellationReason: v.optional(v.string()),
    underwritingSnapshot: v.optional(underwritingSnapshotValidator),

    // --- Lifecycle dimensions -------------------------------------------
    // `status` above conflates all five of these. It stays as the legacy
    // field every existing reader still uses; these carry the real state.
    creditDecision: v.optional(creditDecisionValidator),
    appraisalStatus: v.optional(appraisalStatusValidator),
    gapResolution: v.optional(gapResolutionValidator),
    settlementStatus: v.optional(settlementStatusValidator),
    handoverStatus: v.optional(handoverStatusValidator),

    // --- Dealer-side economics ------------------------------------------
    // All in minor units of `economicsCurrency`. Deliberately NOT reusing
    // quotes.totalFinancedAmount, which is the customer's Murabaha principal
    // and was being read as four other things — see the module header on
    // packages/shared/src/financingEconomics.ts.
    economicsCurrency: v.optional(v.string()),
    vehiclePurchaseCostMinor: v.optional(v.number()),
    targetSellingAmountMinor: v.optional(v.number()),

    // What the dealership actually sent the finance company. Calculated by
    // default but overridable, because the number sent is a commercial
    // decision and storing a computed value as if it were the submitted
    // document would be a lie about a real artefact.
    submittedQuotationMinor: v.optional(v.number()),
    submittedQuotationSource: v.optional(quotationSourceValidator),
    submittedQuotationOverrideReason: v.optional(v.string()),
    // Mode, inputs, solver result, rule version and override, frozen at the
    // moment the quotation was recorded.
    quotationCalculationSnapshot: v.optional(quotationCalculationSnapshotValidator),
    // The quote-side first payment after `applyQuoteFirstPayment` corrected a
    // recorded-as-zero one (SCRUM-766). The snapshot above stays exactly as the
    // solver and the dealer saw it; the NET shortfall reads this ahead of the
    // snapshot's first payment. Cleared when a quotation is re-recorded.
    quoteFirstPaymentCorrectedMinor: v.optional(v.number()),
    estimatedDealerBorneExpensesMinor: v.optional(v.number()),
    quotationBufferMinor: v.optional(v.number()),
    submittedQuotationAt: v.optional(v.number()),
    submittedQuotationBy: v.optional(v.id("users")),
    dealerEstimateMinor: v.optional(v.number()),

    // What the company will actually buy at, and on what basis. Stored, never
    // inferred from the appraisal: a tolerance rule can approve at the
    // quotation despite a lower appraisal, and a negotiated third figure is
    // neither of the two.
    appliedLtvPercent: v.optional(v.number()),
    approvedDealerPurchaseAmountMinor: v.optional(v.number()),
    /**
     * Bumped by every write that moves the deal's economics, and projected as
     * the `economicsStamp` a handover confirmation must hand back.
     *
     * A COUNTER rather than a digest of the figures. The first version of this
     * stamp was `v1|<approved>|<funded>|<contribution>`, issued to every caller
     * who could load the deal — which handed the exact amounts
     * `redactSettlementEvidence` withholds to callers it withholds them from,
     * in a form anyone could read straight off. Hashing the tuple would not
     * have fixed it either: the format is known and at 100% LTV the search
     * collapses to one figure, so the digest is invertible in practice.
     *
     * Absent on rows written before this field existed, which reads as
     * revision 0 — consistent for every caller, so no one is locked out.
     *
     * ⚠️ Every writer of the approved amount or its derived split must bump
     * this. `convex/economicsRevisionGuard.test.ts` fails CI if one does not:
     * a forgotten bump is fail-OPEN, and would let a stale confirmation seal.
     */
    economicsRevision: v.optional(v.number()),
    approvedPurchaseBasis: v.optional(approvedPurchaseBasisValidator),
    approvedPurchaseAppraisalId: v.optional(v.id("financeAppraisals")),
    approvedPurchaseExceptionRuleVersion: v.optional(v.number()),
    approvedPurchaseApprovedBy: v.optional(v.id("users")),
    approvedPurchaseApprovedAt: v.optional(v.number()),
    // A corrected approval's timestamp cannot activate first-approval recovery after delivery.
    approvedPurchaseCorrectedAfterHandoverAt: v.optional(v.number()),
    approvedPurchaseNotes: v.optional(v.string()),

    // Funding composition. Derived server-side from the three inputs above on
    // every write, never accepted from a client.
    financeCompanyFundedPortionMinor: v.optional(v.number()),
    unfinancedPortionMinor: v.optional(v.number()),
    customerFirstPaymentMinor: v.optional(v.number()),
    // Customer money that goes to the FINANCE COMPANY. Must never create a
    // dealer-side customer receivable.
    customerContributionToFinanceCompanyMinor: v.optional(v.number()),
    dealerContributionMinor: v.optional(v.number()),
    dealerContributionSettlement: v.optional(dealerContributionSettlementValidator),
    customerContributionSettlement: v.optional(customerContributionSettlementValidator),

    // Who the finance company actually pays when the car is the supplier's.
    //
    // Not derivable, and not the same question as who owns the car: the same
    // consigned vehicle can be financed with the cheque made out to the
    // dealership or made out to the supplier, and only the agreement says
    // which (`حسب ملكية السيارة`). Recorded here rather than on the sale
    // because the sale does not exist yet when the deal is arranged, and
    // `finalizeDeal` is what carries it onto the sale.
    //
    // Absent means THROUGH_DEALERSHIP — the same reading `consignedSettlementRoute`
    // gives an absent route on a sale, and what every financed consigned deal
    // finalized before this field existed actually posted. Reading absent as
    // anything else would restate them.
    supplierSettlementRoute: v.optional(consignedSettlementRouteValidator),

    // The finance company's disbursement TO THE SUPPLIER, on the direct route.
    //
    // Kept apart from `disbursedAt`/`disbursedAmountMinor` above, which mean
    // money that arrived in the dealership's own bank. This money never touches
    // the dealership's books: it is a fact read off the settlement advice,
    // recorded because it is what makes the supplier's margin collectable, and
    // it posts no journal. Folding the two together would let a disbursement
    // the dealership never received satisfy a check for one it did.
    supplierDisbursementConfirmedAt: v.optional(v.number()),
    supplierDisbursedAmountMinor: v.optional(v.number()),
    supplierDisbursementReference: v.optional(v.string()),
    supplierDisbursementConfirmedBy: v.optional(v.id("users")),
    /**
     * Whether the recorded advice agrees with what the deal was approved at.
     *
     * The dealership's ruling is one payment, for the approved amount — so a
     * different figure is a contradiction between two records of the same fact,
     * not a partial payment. The first attempt at enforcing that REFUSED the
     * mismatched advice, and refusing turned out to be worse than the problem:
     *
     *   - the approval is immutable once the deal is finalized, so there was no
     *     legal way to make the two agree and the advice could never be
     *     recorded at all;
     *   - `supplierDisbursementConfirmedAt` therefore stayed absent, and that
     *     field is what stops a sale being cancelled after the finance company
     *     has paid. A mismatched advice — evidence the supplier WAS paid — left
     *     the sale freely cancellable. The enforcement disarmed the guard it
     *     was meant to strengthen.
     *
     * So the advice is now always recorded, and a disagreement is recorded WITH
     * it as a state a human has to resolve. `REQUIRES_RECONCILIATION` is not a
     * softer CONFIRMED: it says the dealership holds two contradictory records
     * of one payment and does not yet know which is true.
     *
     * Absent means the advice predates this field. It means an advice is ON
     * FILE — NOT that the amounts agreed. The claim that they must have is
     * false: the pre-status writer validated only that the amount was positive
     * and never compared it against `approvedDealerPurchaseAmountMinor`, and
     * that comparison first exists in this release. `redactSettlementEvidence`
     * normalizes absence to `CONFIRMED` for DISPLAY, and says the same thing
     * there — do not read either as evidence of agreement, and never branch on
     * `status === "CONFIRMED"` from a redacted payload to decide whether a
     * disbursement reconciled. Ask the raw fields, as `dealCockpit` does.
     */
    supplierDisbursementStatus: v.optional(
      v.union(v.literal("CONFIRMED"), v.literal("REQUIRES_RECONCILIATION"))
    ),
    /**
     * What the deal was approved at when the advice was recorded, in minor
     * units. Frozen alongside the advice so the discrepancy stays legible even
     * if the approval is later corrected through its own audited path — without
     * it, "the advice disagreed" becomes unfalsifiable the moment either side
     * moves. Written only when the two disagree.
     */
    supplierDisbursementApprovedAtRecordingMinor: v.optional(v.number()),

    // Settlement. `expected` is what the company owes; `actual` is what turned
    // up. Keeping them apart is the whole reason confirmDisbursement could not
    // handle a partial or late remittance.
    expectedDealerRemittanceMinor: v.optional(v.number()),
    actualDealerReceiptTotalMinor: v.optional(v.number()),
    customerFinancingPrincipalMinor: v.optional(v.number()),
    estimatedClosingExpensesMinor: v.optional(v.number()),
    actualClosingExpensesMinor: v.optional(v.number()),
    targetNetProceedsMinor: v.optional(v.number()),

    // The legally documented transaction price — the invoice and purchase
    // agreement, not a figure the system worked out.
    //
    // This is the ninth of nine amounts the deal keeps SEPARATELY, and the only
    // one revenue may ever be posted from. Neither the dealer's target selling
    // amount nor the finance company's approved purchase amount is revenue:
    // both are real, both are stored, and neither is the invoice. Deriving this
    // from either of them is the specific thing that is not allowed, because a
    // financed deal's paperwork is what determines who sold what to whom.
    //
    // Unset means nobody has recorded the document yet, which is why
    // `accountingClassification` exists rather than a default being assumed.
    legalInvoiceAmountMinor: v.optional(v.number()),
    legalInvoiceNumber: v.optional(v.string()),
    legalInvoiceDate: v.optional(v.number()),
    legalInvoiceRecordedBy: v.optional(v.id("users")),
    legalInvoiceRecordedAt: v.optional(v.number()),
    legalInvoiceRevision: v.optional(v.number()),
    /** Who the invoice was actually issued to, which a financed deal makes a real question. */
    legalInvoiceIssuedTo: v.optional(
      v.union(v.literal("CUSTOMER"), v.literal("FINANCE_COMPANY"), v.literal("OTHER"))
    ),
    legalInvoiceIssuedToOther: v.optional(v.string()),
    /**
     * SCRUM-411 (plan v3): who ISSUED the invoice. A genuine dealership invoice
     * exists only for dealer-owned stock; on a sourced/importer-owned car the
     * importer, a separate company, invoices the finance company and the
     * dealership issues none for its margin. Optional evidence only: nothing
     * here ever feeds revenue, the recognition date or readiness.
     */
    legalInvoiceIssuedBy: v.optional(v.union(v.literal("DEALERSHIP"), v.literal("THIRD_PARTY"))),
    legalInvoiceIssuerName: v.optional(v.string()),

    // Whether the deal's accounting treatment has actually been established.
    //
    // PENDING_CLASSIFICATION is the honest default for a financed deal: until
    // the invoice, the purchase agreement and the settlement advice say how the
    // purchase amount and the dealer contribution are documented, there is no
    // sale amount to post that would not be a guess. CLASSIFIED is set by a
    // person, never inferred.
    accountingClassification: v.optional(
      v.union(v.literal("PENDING_CLASSIFICATION"), v.literal("CLASSIFIED"))
    ),
    accountingClassifiedBy: v.optional(v.id("users")),
    accountingClassifiedAt: v.optional(v.number()),
    accountingClassificationNotes: v.optional(v.string()),

    /**
     * The settlement plan this deal was actually recognised from.
     *
     * Server-owned and written only by finalization, beside the sale id and the
     * idempotency key it belongs with. It is the record of WHICH plan posted:
     * the fee rows behind it can be corrected afterwards, and when they are,
     * what the journal says must still be traceable to the figures that produced
     * it rather than to whatever those rows say later.
     */
    financedSaleRecognitionFingerprint: v.optional(v.string()),

    /**
     * N — what the financing company still owed when the sale was recognised.
     *
     * Frozen at finalization, beside the plan that produced it, and the figure
     * `confirmDisbursement` measures an actual receipt against. Re-deriving it at
     * receipt time would compare the money that arrived against economics that
     * may have moved since — a deposit resolved, a fee corrected — and call a
     * correct payment wrong.
     */
    financedSaleNetReceivableMinor: v.optional(v.number()),

    /**
     * SCRUM-435 (finance-company forward). Written only by finalization. A
     * plan-version-2 deal: the company transfers the FULL approved amount and
     * the dealership forwards H (deposit) + C (its contribution) to it. Frozen
     * at finalize so the forward due never re-derives from moving inputs.
     * Absent on a v1 deal, which is never recomputed.
     */
    financedSalePlanVersion: v.optional(v.union(v.literal(1), v.literal(2), v.literal(3))),
    financeCompanyForwardDueMinor: v.optional(v.number()),
    forwardDepositPortionMinor: v.optional(v.number()),
    forwardContributionPortionMinor: v.optional(v.number()),

    // Appraisal gap and its negotiated split. The gap negotiated is the RAW
    // difference against the submitted quotation, not the change in the
    // company's funded portion.
    rawAppraisalGapMinor: v.optional(v.number()),
    // SCRUM-766: the amount customer, showroom and supplier actually split is the
    // owner's NET shortfall (how much less remained for the showroom than the
    // quotation promised), not the gross quotation - approved above. FINANCE tier:
    // unlike the gross gap it embeds the LTV. Signed and unfloored; the two
    // components sum to it exactly. Absent method on a row with a gross gap is a
    // pre-766 row, read as gross by `shortfallState`.
    netShortfallMethod: v.optional(
      v.union(v.literal("NET"), v.literal("GROSS_MANUAL"), v.literal("UNAVAILABLE"))
    ),
    netShortfallMinor: v.optional(v.number()),
    valuationShortfallMinor: v.optional(v.number()),
    financingTermsShortfallMinor: v.optional(v.number()),
    customerGapShareMinor: v.optional(v.number()),
    dealerGapShareMinor: v.optional(v.number()),
    /**
     * SCRUM-766 PR-C (owner ruling SCRUM-760 c23812 #3): the part of the net shortfall the
     * SUPPLIER of a SOURCED vehicle absorbs by conceding part of his entitlement. Absent is 0.
     * Customer + dealer + supplier shares always equal the net shortfall. FINANCE-tier: it
     * is a figure of the deal's economics, withheld from a caller without view:finance.
     */
    supplierGapShareMinor: v.optional(v.number()),
    /**
     * The supplier terms the concession was agreed against, observed by the operator at the
     * moment of agreement and revalidated against the vehicle when the sale completes. A
     * vehicle whose entitlement or supplier no longer matches refuses completion instead of
     * silently applying a concession to a different contract. Cleared with the share.
     */
    supplierGapBasis: v.optional(v.object({
      contractEntitlementMinor: v.number(),
      currency: v.string(),
      supplierName: v.string(),
      /** SCRUM-868 P1 (widen-only, unread): the supplier master row the concession was agreed against. */
      supplierId: v.optional(v.id("suppliers")),
      supplierIdentityRepair: v.optional(supplierIdentityRepairStamp),
    })),
    customerGapCashToDealerMinor: v.optional(v.number()),
    customerGapInstallmentToDealerMinor: v.optional(v.number()),
    customerGapToFinanceCompanyMinor: v.optional(v.number()),
    /**
     * SCRUM-766 PR-B: how much of `customerGapToFinanceCompanyMinor` was credited
     * against the showroom's contribution - only the part CONFIRMED by a
     * `customerFinanceCompanyPayments` row; `dealerContributionMinor` is already
     * net of it. Kept so the commissionable margin can use the contribution
     * BEFORE the credit (owner ruling: the margin does not depend on where the
     * customer's money goes). Absent means nothing was credited.
     */
    customerGapToFinanceCompanyAppliedMinor: v.optional(v.number()),
    /**
     * SCRUM-766 PR-B: THE balance of what the deal still needs confirmed - the
     * part of the agreement that could be credited against the contribution
     * (the agreement, capped by the customer's share and by the contribution)
     * minus what is confirmed. Written by the economics recompute beside
     * `customerGapToFinanceCompanyAppliedMinor` and nowhere else; the closing
     * gate, the payment card, the overview and the confirm command's cap all
     * read it, so none of them can disagree about it. Zero when nothing is left
     * to confirm; absent until a recompute has run (a reader treats absent, with
     * a payment agreed, as unconfirmed).
     */
    customerGapToFinanceCompanyUnconfirmedMinor: v.optional(v.number()),
    gapResolvedAt: v.optional(v.number()),
    gapResolvedBy: v.optional(v.id("users")),
    gapResolutionNotes: v.optional(v.string()),

    // Failure. The appraisal-fee treatment keys off the reason, not the status.
    failureReason: v.optional(financingFailureReasonValidator),
    failureNotes: v.optional(v.string()),
    failedAt: v.optional(v.number()),
    failedBy: v.optional(v.id("users")),
    appraisalFeeResponsibility: v.optional(feeResponsibilityValidator),
    appraisalFeeResponsibilityReason: v.optional(v.string()),

    companyRuleSnapshot: v.optional(financeCompanyRuleSnapshotValidator),
    companyRuleVersionId: v.optional(v.id("financeCompanyRuleVersions")),
    customerQuotePricingSnapshot: v.optional(customerQuotePricingSnapshotValidator),

    // Set by the migration on rows whose pre-existing figures cannot be
    // reinterpreted safely. Reported on, never silently cleared.
    needsFinancingReconciliation: v.optional(v.boolean()),
    financingReconciliationReason: v.optional(v.string()),
    // Written only by migrateFinancingEconomics. Deliberately not one of the
    // business dimensions: keying the backfill on `creditDecision` meant the
    // live mutations that now maintain it also set the migration's own
    // completion sentinel, so any legacy row a user touched mid-migration was
    // skipped forever — without its rule snapshot, its remaining dimensions,
    // or its reconciliation flag.
    financingBackfilledAt: v.optional(v.number()),
    /** SCRUM-808: the readable per-organization deal number; see `sales.dealNumber`. */
    dealNumber: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_dealNumber", ["orgId", "dealNumber"])
    .index("by_dealNumber", ["dealNumber"])
    .index("by_customer", ["customerId"])
    .index("by_vehicle", ["vehicleId"])
    .index("by_status", ["status"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_quote", ["orgId", "quoteId"])
    .index("by_org_vehicle", ["orgId", "vehicleId"])
    .index("by_org_reconciliation", ["orgId", "needsFinancingReconciliation"]),
};
