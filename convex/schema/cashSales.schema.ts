import { defineTable } from "convex/server";
import { v } from "convex/values";
import { paymentMethodValidator } from "../utils/paymentMethods";

export const cashSalesTables = {
  sales: defineTable({
    orgId: v.id("organizations"),
    dealId: v.optional(v.id("commercialDeals")),
    branchId: v.optional(v.id("branches")),
    vehicleId: v.id("vehicles"),
    customerId: v.id("customers"),
    salespersonId: v.id("users"),
    salePrice: v.number(),
    saleDate: v.number(), // timestamp
    status: v.union(v.literal("PENDING"), v.literal("COMPLETED"), v.literal("CANCELLED")),
    draftRevision: v.optional(v.number()),
    idempotencyKey: v.optional(v.string()),

    // Deal Structuring Fields
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
    gapSold: v.optional(v.number()),
    // Portion of warrantySold/gapSold owed to the third-party underwriter
    // (dealer resells, doesn't underwrite) — the remainder is the dealer's
    // own margin, deferred and recognized ratably over the term below. Same
    // decimal-major-unit convention as every other money field on this table
    // (salePrice, dealerFees, warrantySold, ...); converted to minor units
    // only at GL-posting time. See ruleSaleCompleted and dealerProductDeferrals.
    warrantyCost: v.optional(v.number()),
    warrantyTermMonths: v.optional(v.number()),
    gapCost: v.optional(v.number()),
    gapTermMonths: v.optional(v.number()),
    applicationId: v.optional(v.id("financeApplications")),
    quoteId: v.optional(v.id("quotes")),
    leadId: v.optional(v.id("leads")),
    // Where the buyer's money went on a consigned (SOURCED) sale, recorded per
    // deal because it is a fact about the agreement rather than about the
    // vehicle. THROUGH_DEALERSHIP: gross landed in the dealership's account on
    // the supplier's behalf, so his share is a liability from the moment it
    // arrives. DIRECT_TO_SUPPLIER: the buyer paid the supplier, nothing gross
    // ever reached these books, and the only asset is the margin he now owes
    // back.
    //
    // Absent on every non-consigned sale and on consigned rows written before
    // the route was recorded; readers must treat absent as THROUGH_DEALERSHIP,
    // which is what those rows actually posted (see
    // consignedSettlementRoute()). It is deliberately NOT defaulted at write
    // time, so a row that predates the field stays distinguishable from one
    // where somebody chose THROUGH_DEALERSHIP.
    supplierSettlementRoute: v.optional(
      v.union(v.literal("THROUGH_DEALERSHIP"), v.literal("DIRECT_TO_SUPPLIER"))
    ),
    /**
     * What the dealership earned on a consigned sale, in minor units, frozen at
     * completion. Written on every sourced sale — INCLUDING a zero — because
     * zero is the fact that most needs recording.
     *
     * Absent means the row predates this field, and readers must treat that as
     * UNKNOWN rather than as zero. Never defaulted at write time, for the same
     * reason `supplierSettlementRoute` above is not.
     *
     * The cockpit previously inferred a zero margin from the ABSENCE of a
     * `vehicleSupplierReceivables` row, on the grounds that sale completion
     * opens one only when the margin is positive. That inference was unsound:
     * absence is also what a legacy sale looks like, and what a `hardDeleteOrg`
     * that fails between deleting receivables and deleting sales leaves behind.
     * Either way the screen would have reported a deal settled with money still
     * uncollected. A fact this important is recorded, not deduced from a gap.
     */
    consignedMarginMinor: v.optional(v.number()),
    /**
     * The currency `consignedMarginMinor` is denominated in — the org's, as it
     * stood when the sale completed.
     *
     * Stored rather than assumed, like every other money row in this schema
     * (`vehicleSupplierReceivables.currency`, `financeDealFees.currency`,
     * `deposits.currency`). The cockpit resolves its own currency from
     * `financeApplications.economicsCurrency`, and `orgSettings` does not count
     * `financeApplications` among the rows that lock an org's currency — so a
     * young org can record deal economics in JOD and later switch to USD. The
     * reader would then have subtracted USD cents from JOD fils and published
     * the difference as profit.
     */
    consignedMarginCurrency: v.optional(v.string()),
    /**
     * SCRUM-390 (OR-5): the operands of the "Commissionable vehicle margin" on
     * a dealer-owned, financed sale completed by `applications.finalizeDeal`
     * under a v2 financed-sale plan, frozen at completion.
     *
     *   commissionable margin = approved (G) - contribution (C) - acquisition cost
     *
     * G is the finance company's full transfer and C the showroom contribution,
     * both in minor units of `currency`, written as ONE object so a partial
     * record cannot exist. Frozen because the application and the letter they
     * came from can still move afterwards, and `recalculateCommission` must
     * never re-derive payroll from them. Absent on every other sale (cash,
     * `sales.create`, consigned, plan v1 / none) and on every row written before
     * this field; those keep salePrice - cost.
     */
    commissionBase: v.optional(
      v.object({
        approvedMinor: v.number(),
        contributionMinor: v.number(),
        currency: v.string(),
      })
    ),
    /**
     * SCRUM-411 (plan v3): the revenue this financed sale earned, net of the
     * showroom's contribution, in minor units of `currency`, frozen at completion.
     *
     *   dealer-owned car:  consideration (A + R) - contra-revenue
     *   consigned car:     consideration (A + R) - supplier entitlement - contra-revenue
     *
     * The same figure the general ledger nets (revenue credited less
     * SALES_CONSIDERATION_REDUCTIONS debited), recorded so every report reads
     * the books' number instead of re-deriving a gross one. SIGNED: a
     * contribution larger than a consigned commission is a real loss and is
     * recorded as one, never floored.
     *
     * Absent on every sale that is not a v3 financed completion (cash,
     * `sales.create`, plan v1/v2, no plan) - readers keep the sale-price /
     * `consignedMarginMinor` reading for those, exactly as before. Distinct from
     * `consignedMarginMinor`, which stays the commission / supplier-claim basis
     * (K - E) and is not netted of the contribution.
     *
     * `considerationMinor` is that consideration K = A + R itself, in the same
     * `currency`, frozen in the same patch. It bounds a THROUGH_DEALERSHIP supplier's
     * entitlement for the readers (K exceeds the operational `salePrice` when the customer
     * absorbs a net shortfall). Absent on a v3 sale completed before it was recorded.
     */
    financedNetRevenue: v.optional(
      v.object({
        minor: v.number(),
        currency: v.string(),
        considerationMinor: v.optional(v.number()),
      })
    ),
    /**
     * What the supplier is owed for the car, in minor units, frozen at
     * completion — his entitlement, denominated in `consignedMarginCurrency`.
     *
     * Recorded rather than re-derived because every later reader needs it and
     * every source it could be re-derived FROM can move underneath them: the
     * vehicle's `sourceCost` is editable, and the capitalized cost is a sum over
     * rows that can be added after the sale. The cockpit renders this as the
     * supplier's settlement line on both routes.
     *
     * Cancellation does NOT read it: `makeReversalHook` reverses the original
     * journal entry line for line, which is stronger — it cannot disagree with
     * what was posted even if this field were wrong. Said explicitly because the
     * opposite claim was written here first, and a comment that overstates who
     * depends on a field is how a field survives long after its last reader.
     *
     * Absent means the row predates this field: UNKNOWN, never zero. A zero
     * entitlement and an unrecorded one are different facts, and only one of
     * them means "the supplier is owed nothing".
     */
    consignedSupplierEntitlementMinor: v.optional(v.number()),
    /**
     * SCRUM-766 PR-C: the part of his contractual entitlement the supplier conceded on this
     * deal to cover the net shortfall, in minor units, frozen at completion. The supplier was
     * owed `consignedSupplierEntitlementMinor` = contract - this. Absent or 0 means no
     * concession. FINANCE-tier: the `sales` projection withholds it from a caller without
     * view:finance.
     */
    consignedSupplierConcessionMinor: v.optional(v.number()),
    /**
     * What a third party paid the supplier DIRECTLY, in minor units, frozen at
     * completion. Written only on the direct route; absent on
     * THROUGH_DEALERSHIP, where nobody pays him directly and the dealership
     * owes him his entitlement as a payable instead.
     *
     * On a cash direct sale this is the sale price — the buyer pays him. On a
     * financed direct sale it is the finance company's approved purchase
     * amount, which is frequently NOT the sale price. Recording which quantity
     * actually applied is what stops a later reader from assuming the sale
     * price and reopening the defect this field was added to close: the
     * dealership's claim is `this − entitlement`, so a claim can never exceed
     * the dealership money the supplier is genuinely holding.
     *
     * Read by `sales.recalculateCommission`, which measures the salesperson's
     * commission on what this sale actually recognized. On a FINANCED direct row
     * its absence is refused rather than defaulted — see `commissionableEarnings`
     * in convex/utils/saleCompletion.ts.
     */
    consignedSupplierGrossReceiptMinor: v.optional(v.number()),
    canonicalReceivableDocumentId: v.optional(v.id("receivableDocuments")),
    /**
     * SCRUM-571 (D-48): whether the organization had a chart of accounts when this
     * sale was COMPLETED, i.e. whether SALE_COMPLETED was owed to the general
     * ledger. Snapshotted at completion and never recomputed, so a later chart
     * initialization or plan change cannot move an old sale's settled reading.
     * `false` (a Free/Starter org with no chart) means no posting proof exists to
     * demand; absent (a legacy row) is read as required - it fails closed. Read by
     * `resolveCustomerInvoicePosition`.
     */
    glPostingRequired: v.optional(v.boolean()),
    commissionAmount: v.optional(v.number()), // Calculated at sale time
    // How many COMMISSION_ADJUSTED corrections have been posted against this
    // sale's accrual. Monotonic, never reset — it discriminates each
    // correction's idempotency key (see hookCommissionAdjusted), so reusing a
    // number would make the ledger silently drop a real correction. Absent on
    // rows that predate corrections, and on any commission never corrected.
    commissionAdjustmentSeq: v.optional(v.number()),
    commissionPaidAt: v.optional(v.number()),
    commissionPaidBy: v.optional(v.id("users")),
    commissionPaymentMethod: v.optional(paymentMethodValidator),
    commissionBankAccountId: v.optional(v.id("bankAccounts")),
    commissionPaymentIdempotencyKey: v.optional(v.string()),
    // A sale is either live (unset) or soft-deleted (true); `false` is
    // unrepresentable, so the by_org_deleted / by_org_salesperson_deleted index
    // orders live sales by creation time (SCRUM-571 S1, D-28).
    isDeleted: v.optional(v.literal(true)),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
    /**
     * SCRUM-808: the readable per-organization deal number (shown as D-000123). Allocated once at creation from
     * `dealNumberCounters` in the same mutation (convex/utils/dealNumber.ts) and never changed. A sale finalized from a
     * finance application carries that application's number: it is the same deal. Optional only until the deploy
     * rollout backfill numbers the rows created before it. The `_id` stays the deal's identity.
     */
    dealNumber: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_dealNumber", ["orgId", "dealNumber"])
    // The deploy rollout backfill reads only rows whose number is unset (convex/dealNumberBackfill.ts).
    .index("by_dealNumber", ["dealNumber"])
    .index("by_org_salesperson", ["orgId", "salespersonId"])
    // sales.list pages these natively: `.lt("isDeleted", true)` keeps the unset
    // (live) rows and skips soft-deleted ones inside the index range.
    .index("by_org_deleted", ["orgId", "isDeleted"])
    .index("by_org_salesperson_deleted", ["orgId", "salespersonId", "isDeleted"])
    // Same ordering guarantee as by_org_saleDate, but scoped to one
    // salesperson. by_org_salesperson orders by _creationTime, so paging a
    // single rep's commissions through it would order by when the row was
    // created rather than the sale date the UI sorts and displays — a draft
    // created early but completed later would land in the wrong page.
    .index("by_org_salesperson_saleDate", ["orgId", "salespersonId", "saleDate"])
    .index("by_org_saleDate", ["orgId", "saleDate"])
    // Dashboard totals (dated windows and ALL_TIME) need completed, non-deleted
    // rows in sale-date order.
    .index("by_org_status_live_saleDate", ["orgId", "status", "isDeleted", "saleDate"])
    .index("by_org_status_live_commissionPaidAt_commissionAmount", ["orgId", "status", "isDeleted", "commissionPaidAt", "commissionAmount"])
    .index("by_org_customer", ["orgId", "customerId"])
    .index("by_quote", ["quoteId"])
    .index("by_lead", ["leadId"]),

  // GL Phase 19: the dealer's margin on a resold warranty/GAP product is
  // deferred at sale and recognized ratably over the product's term — one row
  // per product per sale. Same recognized/lastRecognizedYearMonth tracking
  // shape as fixedAssets' depreciation fields; see crons.ts's monthly
  // fi-commission-recognition job and recognizeDeferredCommissionForMonth.
  dealerProductDeferrals: defineTable({
    orgId: v.id("organizations"),
    saleId: v.id("sales"),
    productType: v.union(v.literal("WARRANTY"), v.literal("GAP")),
    totalMarginMinor: v.number(),
    currency: v.string(),
    termMonths: v.number(),
    recognizedMinor: v.number(),
    // Contractual month count actually recognized so far — distinct from
    // recognizedMinor/lastRecognizedYearMonth, which alone can't tell
    // recognizeDeferredCommissionForMonth whether the *next* call is the
    // final contractual month (the one that must absorb the remainder so the
    // deferral finishes in exactly termMonths, not termMonths+1).
    monthsRecognized: v.optional(v.number()),
    lastRecognizedYearMonth: v.optional(v.string()), // "YYYY-MM"
    status: v.union(v.literal("ACTIVE"), v.literal("FULLY_RECOGNIZED"), v.literal("CANCELLED")),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_status", ["status"])
    .index("by_sale", ["saleId"]),
};
