import { defineTable } from "convex/server";
import { v } from "convex/values";
import { paymentMethodValidator } from "../utils/paymentMethods";
import { supplierIdentityRepairStamp } from "./supplierIdentity.schema";

// SCRUM-868: keep the name at posting immutable. The supplier master link,
// snapshot version and repair stamp stay optional in storage for existing rows.
const supplierBalanceIdentityFields = {
  sourcedFromName: v.string(),
  supplierId: v.optional(v.id("suppliers")),
  supplierSnapshotVersion: v.optional(v.number()),
  supplierIdentityRepair: v.optional(supplierIdentityRepairStamp),
};

const supplierRecoveryCommon = {
orgId: v.id("organizations"),
...supplierBalanceIdentityFields,
amountDueMinor: v.number(),
amountRecoveredMinor: v.number(),
currency: v.string(),
/** How many receipts have ever been recorded (LIVE or REVERSED). */
    receiptSeq: v.number(),
status: v.union(
      v.literal("OPEN"),
      v.literal("PARTIALLY_RECOVERED"),
      v.literal("RECOVERED"),
      v.literal("REVERSED")
    ),
reversedAt: v.optional(v.number()),
reversedBy: v.optional(v.id("users")),
/**
 * SCRUM-869 S3a (widen-only): the due date agreed with the supplier, epoch ms. Optional in
 * storage forever. No door writes it in S3a; absent means "no agreed date" (SCRUM-869#c23883).
 */
agreedDueDate: v.optional(v.number()),
createdBy: v.id("users"),
createdAt: v.number(),
updatedAt: v.number(),
};

const supplierRecoveryReceiptCommon = {
orgId: v.id("organizations"),
recoveryId: v.id("supplierCostRecoveries"),
seq: v.number(),
amountMinor: v.number(),
currency: v.string(),
method: v.union(v.literal("CASH"), v.literal("BANK_TRANSFER")),
bankAccountId: v.optional(v.id("bankAccounts")),
receivedDate: v.number(),
reference: v.optional(v.string()),
notes: v.optional(v.string()),
/**
     * The caller's command identity (runWithIdempotency). The POSTING's key is
     * not stored: it is `supplierCostRecoveryReceiptKey(_id)`, one spelling.
     */
    idempotencyKey: v.string(),
status: v.union(v.literal("POSTING"), v.literal("LIVE"), v.literal("REVERSED")),
reversedAt: v.optional(v.number()),
reversedBy: v.optional(v.id("users")),
reversalReason: v.optional(v.string()),
reversalDate: v.optional(v.number()),
createdBy: v.id("users"),
createdAt: v.number(),
};

const supplierPayableCommon = {
orgId: v.id("organizations"),
...supplierBalanceIdentityFields,
amountDue: v.number(),
currency: v.string(),
// PENDING is retained permanently as a legacy value. Every row written
    // before consigned-agent accounting carries it, and dropping it from the
    // union would make those rows unreadable — a schema change that destroys
    // access to existing payables is a worse outcome than one extra literal.
    // `deriveSettlementStatus` maps it to DUE_ON_SALE for every reader.
    status: v.union(
      v.literal("PENDING"),
      v.literal("NOT_YET_DUE"),
      v.literal("DUE_ON_SALE"),
      v.literal("PARTIALLY_PAID"),
      v.literal("PAID"),
      v.literal("DISPUTED"),
      v.literal("CANCELLED")
    ),
// How `amountDue` was arrived at. Recorded rather than inferred: the same
    // number reached by an agreed cost and by a percentage of the sale means
    // different things when the sale price later changes.
    settlementCalculationMethod: v.optional(
      v.union(
        v.literal("AGREED_SOURCE_COST"),
        v.literal("PERCENTAGE_OF_SALE"),
        v.literal("FIXED_AMOUNT"),
        v.literal("OTHER")
      )
    ),
settlementCalculationNote: v.optional(v.string()),
// Cumulative. `remainingAmount` is deliberately NOT stored — a second copy
    // of a figure derivable from two others is a figure that can disagree with
    // them, and this one decides whether a supplier is still owed money.
    amountPaid: v.optional(v.number()),
/**
     * How many payments have posted. Carried into the GL event's version and
     * idempotency key, because `postAccountingEvent` dedupes on
     * (eventType, sourceType, sourceId, eventVersion) — without it a second
     * instalment silently returns "already posted" and the ledger records one
     * payment where the subledger records several.
     */
    paymentSeq: v.optional(v.number()),
paymentDueTrigger: v.optional(
      v.union(
        v.literal("ON_SALE"),
        v.literal("ON_SETTLEMENT_RECEIPT"),
        v.literal("FIXED_DATE"),
        v.literal("ON_DEMAND")
      )
    ),
paymentDueDate: v.optional(v.number()),
paidAt: v.optional(v.number()),
paidBy: v.optional(v.id("users")),
paymentMethod: v.optional(paymentMethodValidator),
/** Last payment's physical bank; each instalment also retains its bank on its accounting event. */
    bankAccountId: v.optional(v.id("bankAccounts")),
/** Cheque number or transfer reference. */
    paymentReference: v.optional(v.string()),
/** The bank or cash account the payment left. */
    paymentAccountId: v.optional(v.id("chartOfAccounts")),
paymentNotes: v.optional(v.string()),
documentStorageIds: v.optional(v.array(v.id("_storage"))),
disputedAt: v.optional(v.number()),
disputedBy: v.optional(v.id("users")),
disputeReason: v.optional(v.string()),
// Portion of amountDue that is input VAT paid to the supplier (tax-inclusive,
    // not additive) — feeds the VAT return's input side. Optional/backward compatible.
    taxAmount: v.optional(v.number()),
cancelledAt: v.optional(v.number()),
cancelledBy: v.optional(v.id("users")),
createdBy: v.id("users"),
createdAt: v.number(),
updatedAt: v.number(),
};

export const supplierBalancesTables = {
  // SCRUM-782: deployment-wide singleton checkpoint, not tenant data. Only the
  // internal rollout migration writes it; completion prevents repeat scans.
  supplierVatHoldMigration: defineTable({
    cursor: v.optional(v.string()),
    completedAt: v.optional(v.number()),
    updatedAt: v.number(),
  }),

  /**
   * One row per historical consigned sale restated from principal to agent
   * basis, written by migrateConsignedSaleBasis.
   *
   * This is the migration's audit trail AND its idempotency key. The GL is
   * already protected — postOrEnqueue drops a duplicate idempotency key — but
   * "it posted nothing the second time" is not the same as being able to show
   * an auditor which sales were touched, by whom, on what evidence, and that
   * the correction left profit unchanged. That is what this table is for, and
   * why it stores the amounts rather than pointing at the journal and hoping.
   *
   * `originalJournalEntryIds` links back to the entries being corrected. The
   * correction is a NEW entry, never an edit of those — the original posting
   * and its restatement both stay on the books, which is the only version of
   * this an auditor can follow.
   */
  consignedSaleCorrections: defineTable({
    orgId: v.id("organizations"),
    saleId: v.id("sales"),
    vehicleId: v.id("vehicles"),
    currency: v.string(),
    originalJournalEntryIds: v.array(v.id("journalEntries")),
    /**
     * How far this correction actually got.
     *
     * The distinction this exists to make: a correction dated into a closed or
     * not-yet-existing period does not post — it queues to the outbox. That is
     * the NORMAL case for historical restatements, since the periods being
     * corrected are usually closed. Recording such a row as done meant the
     * pre-check reported `alreadyCorrected` forever while no journal had ever
     * been written, and a dead-lettered event would never be noticed.
     *
     *  - PENDING_POSTING — the event is durably queued; no journal yet.
     *  - POSTED — the journal exists. Only this counts as corrected.
     *  - FAILED — the event neither posted nor queued, or its outbox entry
     *    dead-lettered. A retry re-raises the event under the same key, so it
     *    cannot double-post; a dead-lettered outbox row must be redriven by an
     *    operator first (accountingOutbox.retryFailed), because postOrEnqueue
     *    treats any unposted queued row as already handled.
     *
     * This tracks the JOURNAL only. Whether the operational ledger was also
     * restated is `reportingBasisStatus` below — two ledgers with two failure
     * modes, and folding them into one status made a queued correction whose
     * transaction row needed a human permanently unpromotable: nothing ever
     * wrote its journal id, and the impact report went on reporting an
     * already-corrected sale as fully overstated, inviting a second manual
     * correction.
     */
    status: v.union(
      v.literal("PENDING_POSTING"),
      v.literal("POSTED"),
      v.literal("FAILED")
    ),
    /** Why the row is FAILED. Absent otherwise. */
    statusReason: v.optional(v.string()),
    /**
     * Whether the sale's `transactions` row was restated onto the agent basis.
     *
     *  - RESTATED — done, or there was no such row to restate.
     *  - REQUIRES_RECONCILIATION — the row could not be identified
     *    unambiguously (a vehicle sold twice, an amount already netted down by
     *    deposits), so it was left alone rather than guessed at. The journal
     *    correction is unaffected and proceeds on its own.
     */
    reportingBasisStatus: v.optional(
      v.union(v.literal("RESTATED"), v.literal("REQUIRES_RECONCILIATION"))
    ),
    /** Why the reporting basis needs a human. Absent when RESTATED. */
    reportingBasisReason: v.optional(v.string()),
    /** The idempotency key of the correcting event, so a retry reuses its identity. */
    eventIdempotencyKey: v.optional(v.string()),
    /**
     * Absent until the correction actually posts. The event is durable either
     * way; only the journal id is not yet knowable.
     */
    correctionJournalEntryId: v.optional(v.id("journalEntries")),
    /** When the journal was confirmed to exist — the moment status became POSTED. */
    postedAt: v.optional(v.number()),
    /**
     * The `transactions` row whose reporting basis was restated to the agent
     * margin, so Sales Reports, Dashboard and P&L agree about a historical
     * sourced month. Absent when the row could not be identified — see
     * REQUIRES_RECONCILIATION.
     */
    recognizedRevenueTransactionId: v.optional(v.id("transactions")),
    revenueReclassifiedMinor: v.number(),
    commissionRecognizedMinor: v.number(),
    cogsReversedMinor: v.number(),
    /**
     * Stored even though it is always zero. The migration's entire licence to
     * run unattended is that it cannot move profit; recording the number it
     * actually computed means a later reader can verify that claim per row
     * instead of taking it on trust.
     */
    netIncomeDeltaMinor: v.number(),
    correctedBy: v.id("users"),
    correctedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_sale", ["orgId", "saleId"])
    .index("by_status", ["status"]),

  /**
   * What a supplier owes the DEALERSHIP on a consigned sale he was paid for
   * directly.
   *
   * The mirror of `vehicleSupplierPayables`, and it exists for the same reason
   * that one does: a general-ledger balance is not a subledger. On the
   * DIRECT_TO_SUPPLIER route the buyer pays the supplier the whole
   * 12,500, the supplier keeps his 9,500 entitlement, and the dealership's
   * 3,000 agency margin stays with him until he settles it. Debiting
   * Receivable from Suppliers records that the money is owed; only this records
   * WHICH deal it is owed on, how much of it has since arrived, when, by what
   * means, and against which reference — the things an aging report and a
   * supplier conversation are actually made of.
   *
   * `sourcedFromName` is the immutable name snapshot (SCRUM-868 N3). The supplier
   * master now exists, so `supplierId` sits beside it, optional in storage and
   * required at the write boundary by later slices.
   */
  vehicleSupplierReceivables: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    saleId: v.id("sales"),
    ...supplierBalanceIdentityFields,
    /** The dealership's agency margin on the deal — what the supplier owes back. */
    amountDue: v.number(),
    currency: v.string(),
    status: v.union(
      v.literal("OPEN"),
      v.literal("PARTIALLY_PAID"),
      v.literal("PAID"),
      v.literal("DISPUTED"),
      // Not one of the four the requirement names, and deliberately kept: a
      // sale can be cancelled, and a claim against a deal that no longer exists
      // is not "open". Without it, cancelling would either strand a live
      // receivable or delete the record of one that existed.
      v.literal("CANCELLED")
    ),
    /**
     * Cumulative amount collected. `remainingAmount` is NOT stored — a second
     * copy of a figure derivable from two others is a figure that can disagree
     * with them, and this one decides whether a supplier still owes money.
     */
    amountReceived: v.optional(v.number()),
    receiptMethod: v.optional(paymentMethodValidator),
    receiptBankAccountId: v.optional(v.id("bankAccounts")),
    /** Cheque number or transfer reference for the most recent receipt. */
    receiptReference: v.optional(v.string()),
    /** The bank or cash account the money arrived in. */
    receiptAccountId: v.optional(v.id("chartOfAccounts")),
    receiptNotes: v.optional(v.string()),
    /**
     * How many receipts have posted. The GL event's idempotency key includes
     * it, so a second instalment of the same amount is a distinct event rather
     * than a duplicate the outbox silently drops.
     */
    receiptSeq: v.optional(v.number()),
    /** When the claim was settled in full. */
    settledAt: v.optional(v.number()),
    settledBy: v.optional(v.id("users")),
    disputeReason: v.optional(v.string()),
    disputedAt: v.optional(v.number()),
    disputedBy: v.optional(v.id("users")),
    /**
     * SCRUM-869 S3a (widen-only): the due date agreed with the supplier, epoch ms. Optional in
     * storage forever (rows written before it stay valid). No door writes it in S3a; the due-date
     * reader treats an absent value as "no agreed date" and falls to the ownership-model trigger
     * (owner ruling SCRUM-869#c23883).
     */
    agreedDueDate: v.optional(v.number()),
    cancelledAt: v.optional(v.number()),
    cancelledBy: v.optional(v.id("users")),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_sale", ["orgId", "saleId"])
    .index("by_org_vehicle", ["orgId", "vehicleId"])
    .index("by_sale", ["saleId"])
    // SCRUM-868 P1: one supplier's receivables by status. Unread until the identity slices land.
    .index("by_org_and_supplierId_and_status", ["orgId", "supplierId", "status"]),

  /**
   * SCRUM-389 — a paid SUPPLIER-borne vehicle cost, owed back by the supplier.
   *
   * Opened in the SAME transaction as the expense's EXPENSE_POSTED (which, for
   * a SUPPLIER bearer, debits Receivable from Suppliers rather than an expense
   * account). Deliberately NOT linked to any sale: recovery has its own
   * lifecycle, so cancelling a sale can never strand it and settling one can
   * never absorb it into margin.
   *
   * Amounts are integer MINOR units in `currency`. `amountRecoveredMinor` is
   * the sum of LIVE receipts, maintained in the same mutation that writes or
   * reverses a receipt; `status` is re-derived from due, recovered and
   * reversal at every such write (`recoveryStatusFor`), never set by hand.
   *
   * The source posting's STATE is not stored — it is derived from
   * `sourceEventKey` across `accountingEvents` and the outbox, because the
   * posting can drain, fail or be reversed in transactions that never touch
   * this row.
   */
  supplierCostRecoveries: defineTable(v.union(v.object({...supplierRecoveryCommon,
vehicleId: v.id("vehicles"),
expenseId: v.id("expenses"),
/** Idempotency key of the source EXPENSE_POSTED post. */
    sourceEventKey: v.string(),
origin:v.optional(v.literal("EXPENSE"))}),v.object({...supplierRecoveryCommon,origin:v.literal("OPENING"),openingBalanceDraftId:v.id("openingBalanceDrafts"),openingRowKey:v.string(),title:v.string(),purpose:v.union(v.literal("CLAIM"),v.literal("REFUNDABLE_DEPOSIT"))})))
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_vehicle_status", ["orgId", "vehicleId", "status"])
    .index("by_org_expense", ["orgId", "expenseId"])
    // SCRUM-868 P1: one supplier's recoveries by status. Unread until the identity slices land.
    .index("by_org_and_supplierId_and_status", ["orgId", "supplierId", "status"]),

  /**
   * SCRUM-389 — money actually received from a supplier against one recovery.
   *
   * Immutable once LIVE except for its own reversal. Each receipt is its own
   * posting source (`supplierCostRecoveryReceipts` / receipt id / version 1),
   * posted SYNCHRONOUSLY — there is no queued receipt, so a LIVE row always has
   * a POSTED event behind it. `POSTING` exists only inside the recording
   * mutation (insert, post, patch LIVE); any throw rolls it back, so it is
   * never persisted.
   */
  supplierCostRecoveryReceipts: defineTable(v.union(v.object({...supplierRecoveryReceiptCommon,
vehicleId: v.id("vehicles"),
origin:v.optional(v.literal("NATIVE"))}),v.object({...supplierRecoveryReceiptCommon,origin:v.literal("OPENING"),openingBalanceDraftId:v.id("openingBalanceDrafts"),openingRowKey:v.string()})))
    .index("by_org", ["orgId"])
    .index("by_org_recovery", ["orgId", "recoveryId"]),

  vehicleSupplierPayables: defineTable(v.union(v.object({...supplierPayableCommon,
vehicleId: v.id("vehicles"),
saleId: v.optional(v.id("sales")),
origin:v.optional(v.literal("NATIVE"))}),v.object({...supplierPayableCommon,origin:v.literal("OPENING"),openingBalanceDraftId:v.id("openingBalanceDrafts"),openingRowKey:v.string(),openingKind:v.union(v.literal("SUPPLIER_PAYABLE"),v.literal("OTHER_PAYABLE")),title:v.string()})))
    .index("by_org", ["orgId"])
    .index("by_vehicle", ["vehicleId"])
    .index("by_sale", ["saleId"])
    .index("by_org_status", ["orgId", "status"])
    // SCRUM-868 P1: one supplier's payables by status. Unread until the identity slices land.
    .index("by_org_and_supplierId_and_status", ["orgId", "supplierId", "status"]),
};
