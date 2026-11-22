import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  feeAccountingTreatmentValidator,
  feePartyValidator,
  financeFeeTypeValidator,
} from "../utils/financingEconomics";
import { directPaymentValidator } from "../utils/handoverCostPayment";

export const financingSettlementTables = {
  /**
   * One itemized cost on one financed deal, estimated and actual side by side.
   *
   * ## Why both, and why neither defaults to the other
   *
   * A quotation is prepared days before the costs are known, so the dealership
   * has to work from estimates — and a deal is not closed on estimates. Storing
   * one number that starts as an estimate and is later overwritten by the
   * actual destroys the comparison the whole reconciliation depends on, and
   * makes "was this ever checked?" unanswerable. `estimatedAmountMinor` and
   * `actualAmountMinor` are therefore independent, and **an unset actual is not
   * zero and not the estimate** — it means nobody has paid or recorded it yet.
   *
   * ## No plugs
   *
   * Nothing here is ever back-solved from a quotation, a target or a residual.
   * A deal with no fees itemized has no fees, and reports a lower total —
   * which is the honest figure. The alternative, inferring an allowance from
   * the difference between two other numbers, turns arithmetic into a business
   * fact nobody stated.
   *
   * ## Accounting treatment is explicit, always
   *
   * `accountingTreatment` is required. Defaulting it — say, treating every
   * dealer-borne amount as a selling expense — is wrong for most of these: an
   * appraisal fee the dealership swallows is an expense, an amount the customer
   * still owes is a receivable, and money an employee fronted is a payable to
   * that employee. The party who paid does not determine the treatment either,
   * which is why `paidBy` and `accountingTreatment` are separate fields.
   */
  financeDealFees: defineTable({
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    feeType: financeFeeTypeValidator,
    description: v.optional(v.string()),
    currency: v.string(),

    /** What the deal was quoted on. Usable operationally; never closure evidence. */
    estimatedAmountMinor: v.optional(v.number()),
    /** What was actually paid. Unset means unpaid or unrecorded — not zero. */
    actualAmountMinor: v.optional(v.number()),

    paidBy: feePartyValidator,
    paidTo: feePartyValidator,
    /** Required. See the note above — never inferred from `paidBy`. */
    accountingTreatment: feeAccountingTreatmentValidator,
    includedInQuotation: v.boolean(),
    deductedFromSettlement: v.boolean(),
    refundable: v.boolean(),

    /** Set when an employee holding deal custody laid this out. */
    custodyId: v.optional(v.id("financeDealCustody")),
    /**
     * What of this line is ON THE BOOKS as a custody-paid cost right now, or
     * absent when nothing is. `CUSTODY_FEE_PAID` posts once per version
     * against `financeDealFees/<id>`; every correction (amount, custody,
     * unlink, void) reverses the live version and, if a live charge remains,
     * posts the next. Stored so "is it posted, and at what?" is answered from
     * the row rather than by scanning an event family whose reversals share
     * its source key.
     *
     * `occurredAt` is the date the version was minted AT — the one the outbox
     * row carries as its `occurredAt` and `accountingDate`. The worker proves
     * a queued row's envelope against it (`custodyPostingRefusal`): a row
     * whose date was moved after it was queued would post into another
     * period than the version was dated for, and nothing else records what
     * that date was. Optional only for rows written before the stamp
     * existed; a queued row standing on such a version is refused, never
     * trusted.
     */
    custodyPosted: v.optional(
      v.object({
        version: v.number(),
        amountMinor: v.number(),
        custodyId: v.id("financeDealCustody"),
        occurredAt: v.optional(v.number()),
      })
    ),
    /** The highest custody posting version ever used on this line — never reused after a reversal. */
    custodyPostingVersion: v.optional(v.number()),
    /**
     * SCRUM-443. What of this line is ON THE BOOKS as a DIRECT dealership
     * payment right now, or absent when nothing is: the dealership itself paid
     * the cost (cash, bank transfer, cheque issued, card), recorded by
     * somebody who may confirm a finance disbursement. `HANDOVER_COST_PAID_DIRECT`
     * posts once per version against `financeDealFees/<id>` (DR the treatment's
     * expense / CR the outbound cash or bank account); an amount edit or a void
     * reverses the live version and leaves the line unpaid again — there is no
     * automatic re-post. Mutually exclusive with `custodyPosted`: no writer
     * changes `paidBy`, and only a DEALER line can be paid this way.
     * Legacy rows carry none and simply read as unpaid.
     */
    directPayment: v.optional(directPaymentValidator),
    /** The highest direct-payment posting version ever used on this line — never reused after a reversal. */
    directPaymentVersion: v.optional(v.number()),
    paidAt: v.optional(v.number()),
    receiptReference: v.optional(v.string()),
    documentStorageIds: v.optional(v.array(v.id("_storage"))),
    /**
     * SCRUM-834. How many times this line's actual and its evidence (amount,
     * paid date, receipt reference, attachments) have been RE-recorded
     * through `recordActualFeeAmount`; absent on a line never re-recorded and
     * read as 0. Monotonic and unrelated to `updatedAt`, which payment,
     * custody and binding writes also move. `reconcileDealFee` pins the value
     * its checker was looking at, so a reconciliation can never certify
     * evidence that was replaced under it — even by a same-amount re-record.
     * Written only by `recordActualFeeAmount`: the one writer that replaces
     * those fields on an existing row (the inserts create new rows, which
     * start at 0).
     */
    actualEvidenceRevision: v.optional(v.number()),

    /** Whether the line came from the company's fee template or was typed. */
    source: v.union(v.literal("COMPANY_TEMPLATE"), v.literal("MANUAL")),
    /**
     * WHICH configured fee this line is the actual for: the position of the
     * template in the application's frozen `companyRuleSnapshot.feeTemplates`.
     * Written only by `recordTemplateFeeActual`, which resolves every other
     * template field from that entry server-side. Exact by construction — the
     * snapshot is immutable per application — so two identical templates are
     * two positions, never one ambiguous name. A COMPANY_TEMPLATE line without
     * it predates that writer and remains visible only as legacy/unplanned
     * history; it never satisfies a configured template row.
     */
    templateIndex: v.optional(v.number()),
    /**
     * SCRUM-690 F-PNTR-1. Set when this line IS the actual of the deal's
     * finance-company execution fee (`adminFees` on the frozen snapshot) — an
     * explicit, audited link by line, never inferred from fee type and payer.
     * At most one live line per deal carries it (proven by the binding
     * mutations over the deal's live lines); voiding or unbinding the line
     * makes the fee unrecorded again. See `utils/executionFeePosition.ts`.
     */
    executionFeeBinding: v.optional(
      v.object({
        boundAt: v.number(),
        boundBy: v.id("users"),
      })
    ),

    /**
     * Set only when a person has confirmed the actual against its evidence.
     * Deliberately not derived from `actualAmountMinor` being present: an
     * amount somebody typed and an amount somebody checked are different
     * claims, and closure requires the second.
     */
    reconciledAt: v.optional(v.number()),
    reconciledBy: v.optional(v.id("users")),
    reconciliationNotes: v.optional(v.string()),

    /** Voided rather than deleted, so a removed cost still has a trace. */
    voidedAt: v.optional(v.number()),
    voidedBy: v.optional(v.id("users")),
    voidReason: v.optional(v.string()),

    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_application", ["applicationId"])
    .index("by_custody", ["custodyId"])
    // A deal's LIVE lines, read without its removed ones: `loadActiveFees`
    // bounds every closure read on this index (`voidedAt` = `undefined`), so
    // the bound counts what is live — a removed line stays as a row for its
    // trace and never moves a deal toward the cap.
    .index("by_application_voidedAt", ["applicationId", "voidedAt"])
    // Every line of a deal that has EVER posted a custody charge, live or
    // removed: `custodyPostingVersion` is set by the two writers that post
    // one (`syncCustodyFeePosting`, the custody migration) and never unset,
    // so `.gt("custodyPostingVersion", 0)` after the application equality
    // enumerates exactly the lines whose `CUSTODY_FEE_PAID` family the
    // ledger gate must prove OFF the books (a voided, unlinked or re-charged
    // line whose reversal was deferred) — without the unbounded read of
    // every removed row the deal ever had.
    .index("by_application_custodyPostingVersion", ["applicationId", "custodyPostingVersion"])
    // Every line of a deal that has EVER carried a direct dealership payment
    // (SCRUM-443), live, zero-edited or removed: `directPaymentVersion` is set
    // by the one writer that posts one (`recordDirectFeePayment`) and never
    // unset, so `.gt("directPaymentVersion", 0)` after the application equality
    // enumerates exactly the lines whose `HANDOVER_COST_PAID_DIRECT` family the
    // closing gate must prove OFF the books — a voided or zeroed line's
    // reversal may still be queued behind a closed period, and the row no
    // longer says so.
    .index("by_application_directPaymentVersion", ["applicationId", "directPaymentVersion"])
    // The one LIVE line per configured position. `recordTemplateFeeActual`
    // proves uniqueness against this index with every field an equality —
    // `voidedAt` last, so `undefined` (live) is the one value asked for — and
    // `.unique()`, which refuses a second live line rather than choosing one.
    .index("by_application_source_templateIndex_voidedAt", [
      "applicationId",
      "source",
      "templateIndex",
      "voidedAt",
    ]),

  /**
   * Money handed to an employee to go and pay a financed deal's closing costs.
   *
   * ## Why this is NOT `employeeAdvances`
   *
   * It looks like one, and putting it there would take money from a person.
   * `payroll.ts` sweeps **every** `OUTSTANDING` row in `employeeAdvances` for a
   * user and deducts it from that month's salary. Deal custody is not a salary
   * advance: the employee is holding the dealership's cash to spend on the
   * dealership's behalf, settles it by producing receipts and returning the
   * balance, and is frequently owed money rather than owing it. Recovering it
   * from their pay would dock them for expenses they have already covered.
   *
   * ## The identity it has to close
   *
   * ```
   * issued - returned - actualExpenses = remainingBalance
   * ```
   *
   * `reconcileEmployeeCustody` in the shared engine computes it, and returns a
   * **signed** balance on purpose: an advance of 700 against 650 of expenses
   * with 50 returned reconciles to zero, while the same advance against 750 of
   * expenses leaves the dealership owing the employee 50. Collapsing those into
   * one unsigned "variance" is how a reimbursement silently becomes a shortage.
   *
   * `reimbursedMinor` is what has actually been paid back, and the engine nets
   * it so a caller reads what is still OUTSTANDING rather than what was
   * incurred — a figure named "due" that does not move after payment is a
   * double payment waiting to happen.
   *
   * Note what is deliberately NOT stored: the employee's own money. It is not
   * independent information — it is exactly the amount by which expenses exceed
   * what they were given and did not return — and holding it as its own figure
   * let it be added to the advance, cancelling the debt it was recording.
   * `reimbursedMinor` is different and IS stored, because money owed and money
   * actually paid back are separate facts and only the second closes the record.
   */
  /**
   * SCRUM-435: one row per forward VERSION (the dealership paying the finance
   * company H + C). The row holds the payment facts and the reversal INTENT
   * only. Whether the money is really on the books is DERIVED from the exact
   * accounting events by `deriveForwardState` — there is deliberately no stored
   * "pending" label that could disagree with the ledger.
   */
  financeCompanyForwards: defineTable({
    orgId: v.id("organizations"),
    bankAccountId: v.optional(v.id("bankAccounts")),
    applicationId: v.id("financeApplications"),
    // SCRUM-27: exactly ONE of the two is set - a configured company by id, a manual one by the name on its letter.
    financeCompanyId: v.optional(v.id("financeCompanies")),
    payerNameSnapshot: v.optional(v.string()),
    version: v.number(),
    amountMinor: v.number(),
    depositPortionMinor: v.number(),
    contributionPortionMinor: v.number(),
    currency: v.string(),
    method: v.union(
      v.literal("CASH"),
      v.literal("BANK_TRANSFER"),
      v.literal("CHEQUE"),
      v.literal("CARD")
    ),
    paidAt: v.number(),
    reference: v.optional(v.string()),
    actorId: v.id("users"),
    createdAt: v.number(),
    // SCRUM-411 P2-01: the sale plan fingerprint (A/F/H/D/R) this payment was
    // recorded against. A payment made BEFORE finalizing counts only while the plan
    // finalize would freeze still has this fingerprint; absent on older rows.
    planFingerprint: v.optional(v.string()),
    // Reversal intent (the ledger decides whether it happened).
    reversalRequestedAt: v.optional(v.number()),
    reversalIdempotencyKey: v.optional(v.string()),
    reversalKind: v.optional(v.union(v.literal("VOID"), v.literal("RETURNED"))),
    reverseReason: v.optional(v.string()),
    reversedAt: v.optional(v.number()),
    reversalActorId: v.optional(v.id("users")),
  })
    .index("by_org_application", ["orgId", "applicationId"]),

  /**
   * SCRUM-766 PR-B: evidence that the CUSTOMER paid the finance company directly
   * toward the shortfall. Only a CONFIRMED row reduces the showroom's
   * contribution; the agreed amount on the application is a promise, not money.
   * The money never touches the dealership's books, so there is deliberately no
   * posting and no ledger link here - the row is the audit trail. A row is
   * voided, never deleted, and neither is possible once the deal is closed
   * (the contribution is then frozen into the finalized plan).
   *
   * A payment is evidence against ONE agreement: `agreementResolvedAt` is the
   * application's `gapResolvedAt` when it was confirmed. Reopening the approval
   * or moving the shortfall voids the agreement and gives the next one a new
   * stamp, so an earlier agreement's rows stop crediting and stop being
   * confirmable against it - they stay on file, visible, until a person takes
   * them back with a reason (the transfer is then re-recorded on the new
   * agreement if it still stands). An application's finance company is fixed
   * for its life, so (application, reference) is also (company, reference).
   */
  customerFinanceCompanyPayments: defineTable({
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    status: v.union(v.literal("CONFIRMED"), v.literal("VOIDED")),
    amountMinor: v.number(),
    currency: v.string(),
    paidAt: v.number(),
    reference: v.string(),
    agreementResolvedAt: v.optional(v.number()),
    sourceIdentity: v.optional(v.string()),
    normalizedReference: v.optional(v.string()),
    firstPayment: v.optional(v.object({
      kind: v.union(v.literal("RECEIPT"), v.literal("CONFIRMATION")),
      attribution: v.string(),
      reapprovedForHandoverAt: v.optional(v.number()),
    })),
    confirmedBy: v.id("users"),
    confirmedAt: v.number(),
    voidedBy: v.optional(v.id("users")),
    voidedAt: v.optional(v.number()),
    voidReason: v.optional(v.string()),
  })
    .index("by_org_application", ["orgId", "applicationId"])
    .index("by_org_normalized_reference_status", ["orgId", "normalizedReference", "status"])
    .index("by_normalized_reference_status", ["normalizedReference", "status"]),

  firstPaymentEvidenceCorrections: defineTable({
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    paymentId: v.id("customerFinanceCompanyPayments"),
    status: v.union(v.literal("PENDING"), v.literal("APPROVED"), v.literal("WITHDRAWN")),
    handoverAt: v.number(),
    economicsRevision: v.optional(v.number()),
    vehicleId: v.id("vehicles"),
    attribution: v.string(),
    currency: v.string(),
    amountMinor: v.number(),
    paidAt: v.number(),
    kind: v.union(v.literal("RECEIPT"), v.literal("CONFIRMATION")),
    reference: v.string(),
    reason: v.string(),
    requestedBy: v.id("users"),
    requestedAt: v.number(),
    resolvedBy: v.optional(v.id("users")),
    resolvedAt: v.optional(v.number()),
    replacementPaymentId: v.optional(v.id("customerFinanceCompanyPayments")),
  }).index("by_org_application", ["orgId", "applicationId"]),

  /**
   * SCRUM-411 P2-02: the immutable provenance of the DEPOSIT part of one forward version -
   * which deposit (and which hold, when the deposit carries one) was paid onward to the
   * finance company inside H + D, and for how much. Written in the same transaction as the
   * forward row and NEVER patched or deleted: whether the money is still FORWARDED, or has
   * been recovered, is DERIVED from the forward version's accounting events (a posted
   * reversal), exactly like the forward's own state, so there is no label here that could
   * disagree with the ledger. `sum(amountMinor)` over a version's slices equals that row's
   * `depositPortionMinor` (checked when it is written). Absent for forwards recorded before
   * this table existed and for a replacement recorded after the sale (its deposit is already
   * consumed into the sale); the deposit spend guard treats a live unsliced version of an
   * unfinalized deal as covering every deposit of its quote.
   */
  financeCompanyForwardSlices: defineTable({
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    forwardId: v.id("financeCompanyForwards"),
    version: v.number(),
    depositId: v.id("deposits"),
    /** The one live hold row of this deposit on the car, when the deposit carries hold rows. */
    holdId: v.optional(v.id("depositVehicleHolds")),
    vehicleId: v.id("vehicles"),
    amountMinor: v.number(),
    currency: v.string(),
    actorId: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_org_forward", ["orgId", "forwardId"])
    .index("by_org_deposit", ["orgId", "depositId"]),

  financeDealCustody: defineTable({
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    /** The employee holding the money. */
    userId: v.id("users"),
    currency: v.string(),

    /** Cash handed over. The sum of every issuance on this custody record. */
    issuedMinor: v.number(),
    /** Unspent cash the employee gave back. */
    returnedMinor: v.number(),
    /** Money the dealership has actually paid back to the employee. */
    reimbursedMinor: v.number(),

    status: v.union(
      v.literal("OPEN"),
      v.literal("RECONCILED"),
      /** Closed with a difference nobody could account for, recorded as such. */
      v.literal("WRITTEN_OFF")
    ),
    reconciledAt: v.optional(v.number()),
    reconciledBy: v.optional(v.id("users")),
    reconciliationNotes: v.optional(v.string()),
    writeOffReason: v.optional(v.string()),
    /**
     * Set by `openDealCustody` once custody posts to the ledger: every
     * movement on this record has a journal (or a queued post) behind it. A
     * record WITHOUT it predates the posting and refuses every money command
     * (`assertCustodyOnLedger`) until an explicit migration settles it — a new
     * leg posted onto an unposted record would be a partial ledger.
     */
    ledgerPosting: v.optional(v.literal("CANONICAL")),
    /**
     * What EMPLOYEE_REIMBURSEMENTS_PAYABLE (2320) is being driven TO for this
     * record, and the last `CUSTODY_PAYABLE_RECLASSIFIED` version issued. The
     * payable is the record's out-of-pocket position `max(0, −position)`,
     * reached by a chain of delta reclassifications, one per movement — see
     * `syncCustodyPayable`. Absent means zero.
     *
     * ⚠️ A TARGET, NOT A LEDGER BALANCE. A delta dated into a closed month
     * waits in the outbox, and every later delta is queued behind it
     * (`utils/custodySourceLedger`), so the books may still carry an earlier
     * version's figure. What is actually posted is read from the ledger
     * (`custodyPayableReclassPosted`), never from this field — the read
     * reports `payableAwaitingPost` for exactly that gap.
     */
    payableTargetMinor: v.optional(v.number()),
    payableReclassVersion: v.optional(v.number()),
    /**
     * The date each issued `CUSTODY_PAYABLE_RECLASSIFIED` version was minted
     * AT — one stamp per version, the chain's own record of the envelope its
     * queued rows must carry. Several versions can wait in the outbox at once
     * (each queued behind the one before it), so the latest version's date
     * alone would say nothing about v1's; the worker proves a queued delta's
     * `occurredAt` / `accountingDate` against ITS version's stamp
     * (`custodyPostingRefusal`). Rewritten by `syncCustodyPayable` alone:
     * a fold that drops the queued tail and re-issues at a lower version
     * drops the stamps above it too. Bounded by the chain itself
     * (`MAX_SOURCE_EVENTS`, which the fold refuses past).
     */
    payableReclassIssued: v.optional(v.array(v.object({ version: v.number(), occurredAt: v.number() }))),
    /** The write-off on the books (`CUSTODY_WRITTEN_OFF`, versioned), absent once reopened; `occurredAt` as on `custodyPosted`. */
    writeOffPosted: v.optional(v.object({ version: v.number(), amountMinor: v.number(), occurredAt: v.optional(v.number()) })),
    /** The highest write-off posting version ever used — never reused after a reversal. */
    writeOffPostingVersion: v.optional(v.number()),

    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_application", ["applicationId"])
    .index("by_org_user", ["orgId", "userId"])
    .index("by_org_status", ["orgId", "status"]),

  /**
   * Every movement on a custody record, so the totals above are a sum of events
   * rather than a number somebody patched.
   *
   * Without this, correcting a mistyped issuance means overwriting a total and
   * losing the fact that it ever differed — the same defect the override table
   * exists to prevent one layer up.
   */
  financeDealCustodyEntries: defineTable({
    orgId: v.id("organizations"),
    custodyId: v.id("financeDealCustody"),
    kind: v.union(
      v.literal("ISSUED"),
      v.literal("RETURNED"),
      v.literal("REIMBURSED"),
      /**
       * Cancels an earlier entry, netted against that entry's own kind.
       *
       * Without it the documented "correct it with another entry" workflow
       * could only be performed by recording something untrue: a mistyped
       * ISSUED of 7,000 could be offset only by a RETURNED of 6,300, asserting
       * as fact that the employee handed back cash they never received.
       */
      v.literal("REVERSAL")
    ),
    /** Required on a REVERSAL, forbidden otherwise. */
    reversesEntryId: v.optional(v.id("financeDealCustodyEntries")),
    amountMinor: v.number(),
    method: v.optional(
      v.union(
        v.literal("CASH"),
        v.literal("BANK_TRANSFER"),
        v.literal("CHEQUE"),
        v.literal("CARD")
      )
    ),
    bankAccountId: v.optional(v.id("bankAccounts")),
    reference: v.optional(v.string()),
    note: v.optional(v.string()),
    occurredAt: v.number(),
    recordedBy: v.id("users"),
    recordedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_custody", ["custodyId"])
    // "Has this movement been reversed?" as one indexed point read, so a
    // paginated page of movements can mark each row without re-reading the
    // whole log to find the reversal that names it.
    .index("by_reverses", ["reversesEntryId"]),
};
