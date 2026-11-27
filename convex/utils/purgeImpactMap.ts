/**
 * SCRUM-1023 Phase 1: the impact map of the one-time test-record purge.
 *
 * EVERY table in the schema is classified here, so a table added later without
 * a ruling fails `scripts/purgeImpactMapCensus.test.ts` instead of being
 * silently outside the purge's reasoning. Meaning of each class:
 *
 *  ROOT                  the rows the owner named (sales, finance applications,
 *                        expenses). The purge may only start from these.
 *  EXPLICIT_ROOT         (phase 1b) a row the owner may name as a root by its own id: a CANCELLED
 *                        payroll run, a fully REFUNDED deposit. Each has its own proof
 *                        (`purgeRootProofs.ts`); the three ROOT tables stay the only roots the
 *                        closure treats as "live deal" ids.
 *  OWNED_CHILD           (phase 1b) a row that belongs to exactly one EXPLICIT_ROOT through one
 *                        field (payrollItems.runId) and leaves with it; a kept one that names a
 *                        purged id is a surviving reference like any other.
 *  STRUCTURAL            rows that exist only because a root (or another purged
 *                        row) exists. They join the purge set when they mention
 *                        a purged id.
 *  LEDGER                accounting events, journal entries, journal lines.
 *                        Removed only as complete reversed pairs that net to
 *                        zero per account, per period, per currency.
 *  DERIVED               rows derived from purged rows (notifications,
 *                        idempotency rows, bank aggregate items). Removed with
 *                        them; the bank aggregate is maintained by the
 *                        journalLines trigger, not by hand.
 *  AUDIT                 audit logs (financialAuditLog, adminAuditLog). Phase 1b: a row whose SUBJECT
 *                        is purged leaves with it (PURGE_AUDIT_SUBJECT); a row about a KEPT record that
 *                        merely mentions a purged id is counted and refuses (AUDIT_MIXED_SUBJECT).
 *  ADJUST                running totals that must be reduced by what the purge
 *                        removes (account balance snapshots) or are maintained
 *                        by triggers (bank aggregates, expense summaries).
 *  FORWARD_LINKED        a row the roots point AT (the commercial deal). It joins the
 *                        purge set only when a purged row mentions it and NO live
 *                        row does; one a live row also holds simply stays, which is
 *                        not a refusal.
 *  REFUSE_IF_REFERENCED  survivors. A row of one of these tables that mentions a
 *                        purged id is a surviving reference: the manifest
 *                        refuses rather than rewrite or orphan it.
 *  KEEP                  entities the purge must leave byte-identical (customers,
 *                        chart, periods, banks ...). They hold no reference into
 *                        the purge set.
 *  NOT_APPLICABLE        a different domain (marketplace, website, social,
 *                        support, AI ...): no reference into the purge set.
 */
export type PurgeImpactClass =
  | "ROOT"
  | "EXPLICIT_ROOT"
  | "OWNED_CHILD"
  | "STRUCTURAL"
  | "LEDGER"
  | "DERIVED"
  | "FORWARD_LINKED"
  | "AUDIT"
  | "ADJUST"
  | "REFUSE_IF_REFERENCED"
  | "KEEP"
  | "NOT_APPLICABLE";

export const PURGE_IMPACT_MAP: Readonly<Record<string, PurgeImpactClass>> = {
  accountBalanceSnapshots: "ADJUST",
  accountingCutoverSignOffs: "NOT_APPLICABLE",
  accountingEvents: "LEDGER",
  accountingPeriods: "KEEP",
  adminAuditLog: "AUDIT",
  // Added by main (SCRUM-980, #880) after this map was first written: holds customer and user ids and draft
  // text only, no deal, application or ledger id. Classified when the census test forced it (2026-11-27).
  aiDrafts: "NOT_APPLICABLE",
  aiOrgSettings: "NOT_APPLICABLE",
  aiProviderKeys: "NOT_APPLICABLE",
  aiSettings: "NOT_APPLICABLE",
  applicationDocuments: "REFUSE_IF_REFERENCED",
  applicationStatusLog: "STRUCTURAL",
  bankAccounts: "KEEP",
  bankBalanceAggregateItems: "DERIVED",
  bankBalanceAggregateStates: "ADJUST",
  bankBalanceGrossShards: "ADJUST",
  bankStatementLines: "REFUSE_IF_REFERENCED",
  branches: "KEEP",
  canonicalPayments: "STRUCTURAL",
  cashDrawerSessions: "NOT_APPLICABLE",
  cashierReconciliations: "NOT_APPLICABLE",
  cashMovements: "REFUSE_IF_REFERENCED",
  changelogEntries: "NOT_APPLICABLE",
  chartOfAccounts: "KEEP",
  claims: "REFUSE_IF_REFERENCED",
  collectionApprovalRequests: "NOT_APPLICABLE",
  collectionPayments: "REFUSE_IF_REFERENCED",
  collectionReminders: "NOT_APPLICABLE",
  commandIdempotency: "DERIVED",
  // PR #908 round 1 (R7): sales and finance applications point at it through `dealId`, so it is not a different domain.
  commercialDeals: "FORWARD_LINKED",
  commitmentAuthorityAttempt: "NOT_APPLICABLE",
  commitmentAuthorityWork: "REFUSE_IF_REFERENCED",
  commitmentRoots: "REFUSE_IF_REFERENCED",
  companyDocumentRules: "NOT_APPLICABLE",
  consignedSaleCorrections: "REFUSE_IF_REFERENCED",
  cronHeartbeats: "NOT_APPLICABLE",
  customerFinanceCompanyPayments: "STRUCTURAL",
  customers: "KEEP",
  dashboardExpenseMonths: "ADJUST",
  dashboardExpenseSummaryState: "ADJUST",
  dealCommissionLines: "STRUCTURAL",
  dealerProductDeferrals: "REFUSE_IF_REFERENCED",
  dealNumberCounters: "KEEP",
  dealUnwinds: "STRUCTURAL",
  deliveredDealIdentityCorrections: "REFUSE_IF_REFERENCED",
  deliveredLenderCorrections: "REFUSE_IF_REFERENCED",
  depositApplications: "STRUCTURAL",
  depositCancellationPendings: "STRUCTURAL",
  // Phase 1b: confirmedDepositId names the deposit; a deposit root with a request row refuses until the owner rules on it.
  depositRequests: "REFUSE_IF_REFERENCED",
  deposits: "EXPLICIT_ROOT",
  depositVehicleHolds: "REFUSE_IF_REFERENCED",
  dmConversations: "NOT_APPLICABLE",
  dmMessages: "NOT_APPLICABLE",
  dmParticipantState: "NOT_APPLICABLE",
  domainSearchLogs: "NOT_APPLICABLE",
  e2ePreviewBootstrap: "NOT_APPLICABLE",
  // Phase 1b: names a payslip (payrollItemId) when an advance was deducted on it, so it is payment evidence and a survivor.
  employeeAdvanceRecoveries: "REFUSE_IF_REFERENCED",
  employeeAdvances: "NOT_APPLICABLE",
  employeeCompensation: "KEEP",
  exchangeRates: "NOT_APPLICABLE",
  expenses: "ROOT",
  facebookEvents: "NOT_APPLICABLE",
  facebookMessages: "NOT_APPLICABLE",
  facebookRevocations: "NOT_APPLICABLE",
  feedback: "NOT_APPLICABLE",
  financeApplicationOverrides: "STRUCTURAL",
  financeApplications: "ROOT",
  financeAppraisals: "STRUCTURAL",
  financeCompanies: "KEEP",
  financeCompanyForwards: "STRUCTURAL",
  financeCompanyForwardSlices: "STRUCTURAL",
  financeCompanyRuleVersions: "KEEP",
  financeDealCustody: "STRUCTURAL",
  financeDealCustodyEntries: "STRUCTURAL",
  financeDealFees: "STRUCTURAL",
  financialAuditLog: "AUDIT",
  firstPaymentEvidenceCorrections: "REFUSE_IF_REFERENCED",
  fixedAssetEvents: "REFUSE_IF_REFERENCED",
  fixedAssets: "NOT_APPLICABLE",
  guarantors: "NOT_APPLICABLE",
  impersonationGrants: "NOT_APPLICABLE",
  instagramEvents: "NOT_APPLICABLE",
  invitations: "NOT_APPLICABLE",
  invoiceReceiptApplications: "REFUSE_IF_REFERENCED",
  journalEntries: "LEDGER",
  journalLines: "LEDGER",
  journalReportEligibility: "ADJUST",
  leadActivities: "NOT_APPLICABLE",
  leadAssignmentCursors: "NOT_APPLICABLE",
  leads: "KEEP",
  liveChatMessages: "NOT_APPLICABLE",
  liveChatPresence: "NOT_APPLICABLE",
  liveChatThreads: "NOT_APPLICABLE",
  manualJournalDrafts: "REFUSE_IF_REFERENCED",
  marketplaceBuyerPushTokens: "NOT_APPLICABLE",
  marketplaceDealerProfiles: "NOT_APPLICABLE",
  marketplaceEvents: "NOT_APPLICABLE",
  marketplaceIndividualSellerProfiles: "NOT_APPLICABLE",
  marketplaceListingImageUploads: "NOT_APPLICABLE",
  marketplaceListings: "NOT_APPLICABLE",
  marketplaceRequestMatches: "NOT_APPLICABLE",
  marketplaceRequests: "NOT_APPLICABLE",
  marketplaceResponses: "NOT_APPLICABLE",
  marketplaceTradeInRequests: "NOT_APPLICABLE",
  marketplaceWeeklyReportDeliveries: "NOT_APPLICABLE",
  marketplaceWeeklyReportRuns: "NOT_APPLICABLE",
  marketplaceWeeklyReportSends: "NOT_APPLICABLE",
  marketplaceWhatsAppFlows: "NOT_APPLICABLE",
  membershipOffboardingJobs: "NOT_APPLICABLE",
  memberships: "KEEP",
  mobileAppReleases: "NOT_APPLICABLE",
  mobilePushTokens: "NOT_APPLICABLE",
  notificationBroadcasts: "NOT_APPLICABLE",
  notificationPreferences: "NOT_APPLICABLE",
  notifications: "DERIVED",
  oauthStates: "NOT_APPLICABLE",
  openingBalanceDrafts: "REFUSE_IF_REFERENCED",
  openingCommissionLiabilities: "REFUSE_IF_REFERENCED",
  openingManagementSettlementPlans: "NOT_APPLICABLE",
  openingPayablePayments: "REFUSE_IF_REFERENCED",
  openingPrepaidReclassifications: "REFUSE_IF_REFERENCED",
  organizationDeletionRequests: "NOT_APPLICABLE",
  organizations: "KEEP",
  orgCustomerStatuses: "NOT_APPLICABLE",
  orgCustomFields: "NOT_APPLICABLE",
  orgCustomFieldValues: "REFUSE_IF_REFERENCED",
  orgImportMappings: "NOT_APPLICABLE",
  orgLeadSources: "NOT_APPLICABLE",
  orgPipelineStages: "NOT_APPLICABLE",
  orgSettings: "KEEP",
  orgValuationCompanies: "NOT_APPLICABLE",
  partnerEquity: "NOT_APPLICABLE",
  partnerEquityTransactions: "REFUSE_IF_REFERENCED",
  paymentAllocations: "STRUCTURAL",
  paymentIntents: "REFUSE_IF_REFERENCED",
  // Phase 1b: the auto-generated receipt voucher of a deposit. Not covered by the rulings: a deposit that has one refuses (owner decision listed).
  paymentVouchers: "REFUSE_IF_REFERENCED",
  payrollItems: "OWNED_CHILD",
  payrollRuns: "EXPLICIT_ROOT",
  pendingAccountingEvents: "REFUSE_IF_REFERENCED",
  postDatedCheques: "REFUSE_IF_REFERENCED",
  prepaidAmortizationFailures: "NOT_APPLICABLE",
  prepaidCorrectionRequests: "NOT_APPLICABLE",
  prepaidExpenseSchedules: "REFUSE_IF_REFERENCED",
  prepaidScheduleCorrections: "NOT_APPLICABLE",
  profitApprovalRequests: "NOT_APPLICABLE",
  pushSubscriptions: "NOT_APPLICABLE",
  quotes: "KEEP",
  receiptApplications: "REFUSE_IF_REFERENCED",
  receiptMovements: "REFUSE_IF_REFERENCED",
  receiptRetainedPositions: "REFUSE_IF_REFERENCED",
  receivableDocuments: "STRUCTURAL",
  receivables: "REFUSE_IF_REFERENCED",
  retainedCreditRefundRequests: "REFUSE_IF_REFERENCED",
  roleMigrationRuns: "NOT_APPLICABLE",
  roles: "KEEP",
  sales: "ROOT",
  siteConfig: "NOT_APPLICABLE",
  siteVisitorEvents: "NOT_APPLICABLE",
  siteVisitors: "NOT_APPLICABLE",
  socialContacts: "NOT_APPLICABLE",
  socialConversations: "NOT_APPLICABLE",
  socialMaterializationState: "NOT_APPLICABLE",
  socialOwnNumberCounts: "NOT_APPLICABLE",
  socialOwnNumberRepairs: "NOT_APPLICABLE",
  socialOwnNumberSources: "NOT_APPLICABLE",
  socialPosts: "NOT_APPLICABLE",
  subscriptions: "NOT_APPLICABLE",
  supplierAliases: "NOT_APPLICABLE",
  supplierCostRecoveries: "REFUSE_IF_REFERENCED",
  supplierCostRecoveryReceipts: "NOT_APPLICABLE",
  supplierRegistryState: "NOT_APPLICABLE",
  suppliers: "KEEP",
  supplierVatHoldMigration: "NOT_APPLICABLE",
  supportAgents: "NOT_APPLICABLE",
  supportMessages: "NOT_APPLICABLE",
  supportOrgAccessGrants: "NOT_APPLICABLE",
  supportThreads: "NOT_APPLICABLE",
  taskAlarmDeliveries: "NOT_APPLICABLE",
  taskHistory: "NOT_APPLICABLE",
  tasks: "REFUSE_IF_REFERENCED",
  test_drives: "NOT_APPLICABLE",
  transactions: "STRUCTURAL",
  unmatchedProviderFunds: "NOT_APPLICABLE",
  userOffboardingReviews: "NOT_APPLICABLE",
  users: "KEEP",
  vehicleCommitmentClaims: "STRUCTURAL",
  vehicleCostCorrections: "REFUSE_IF_REFERENCED",
  vehicleEdits: "NOT_APPLICABLE",
  vehicleLandedCosts: "NOT_APPLICABLE",
  vehicleOwnershipConversions: "REFUSE_IF_REFERENCED",
  vehiclePriceHistory: "NOT_APPLICABLE",
  vehicleReservations: "REFUSE_IF_REFERENCED",
  vehicles: "REFUSE_IF_REFERENCED",
  vehicleStatusRequests: "NOT_APPLICABLE",
  vehicleSupplierPayables: "STRUCTURAL",
  vehicleSupplierReceivables: "REFUSE_IF_REFERENCED",
  vehicleValuations: "NOT_APPLICABLE",
  webhookLogs: "NOT_APPLICABLE",
  websiteDomains: "NOT_APPLICABLE",
  websiteLeadAbuseEvents: "NOT_APPLICABLE",
  websiteLeadBlocklist: "NOT_APPLICABLE",
  websiteLeadRouting: "NOT_APPLICABLE",
  websitePublishedSections: "NOT_APPLICABLE",
  websitePublishSnapshots: "NOT_APPLICABLE",
  websiteSettings: "NOT_APPLICABLE",
  wizardDrafts: "NOT_APPLICABLE",
  workOrders: "REFUSE_IF_REFERENCED",
};

/**
 * The orgId-leading index used to read each scanned table with a bound. Every
 * scanned table has one (proved by the census test against the schema), so the
 * manifest never scans a table across tenants.
 */
export const PURGE_ORG_INDEX: Readonly<Record<string, string>> = {
  accountingEvents: "by_org",
  adminAuditLog: "by_org",
  applicationDocuments: "by_org",
  applicationStatusLog: "by_org",
  bankBalanceAggregateItems: "by_org",
  bankStatementLines: "by_org_bankAccount",
  canonicalPayments: "by_org",
  cashMovements: "by_org",
  claims: "by_org",
  collectionPayments: "by_org",
  commercialDeals: "by_org",
  commandIdempotency: "by_org_operation_key",
  commitmentAuthorityWork: "by_org_work_key",
  commitmentRoots: "by_org_vehicle_status",
  consignedSaleCorrections: "by_org",
  customerFinanceCompanyPayments: "by_org_application",
  dealCommissionLines: "by_org_sale",
  dealerProductDeferrals: "by_org",
  dealUnwinds: "by_org_application_status",
  employeeAdvanceRecoveries: "by_org",
  deliveredDealIdentityCorrections: "by_org_application",
  deliveredLenderCorrections: "by_org_application",
  depositApplications: "by_org",
  depositRequests: "by_org_status",
  depositCancellationPendings: "by_org_vehicle_status",
  deposits: "by_org",
  depositVehicleHolds: "by_org_vehicle_active",
  financeApplicationOverrides: "by_org",
  financeAppraisals: "by_org",
  financeCompanyForwards: "by_org_application",
  financeCompanyForwardSlices: "by_org_forward",
  financeDealCustody: "by_org",
  financeDealCustodyEntries: "by_org",
  financeDealFees: "by_org",
  financialAuditLog: "by_org",
  firstPaymentEvidenceCorrections: "by_org_application",
  fixedAssetEvents: "by_org",
  invoiceReceiptApplications: "by_org",
  journalEntries: "by_org",
  manualJournalDrafts: "by_org_status",
  notifications: "by_org_user",
  openingCommissionLiabilities: "by_org",
  openingBalanceDrafts: "by_org",
  openingPayablePayments: "by_org",
  openingPrepaidReclassifications: "by_org",
  orgCustomFieldValues: "by_org",
  partnerEquityTransactions: "by_org",
  paymentAllocations: "by_org",
  paymentIntents: "by_org",
  paymentVouchers: "by_org",
  payrollItems: "by_org",
  payrollRuns: "by_org",
  pendingAccountingEvents: "by_org_status",
  postDatedCheques: "by_org",
  prepaidExpenseSchedules: "by_org",
  receiptApplications: "by_org",
  receiptMovements: "by_org",
  receiptRetainedPositions: "by_org",
  receivableDocuments: "by_org",
  receivables: "by_org",
  retainedCreditRefundRequests: "by_org",
  supplierCostRecoveries: "by_org",
  tasks: "by_org",
  transactions: "by_org",
  vehicleCommitmentClaims: "by_org_vehicle_status",
  vehicleCostCorrections: "by_org_vehicle",
  vehicleOwnershipConversions: "by_org",
  vehicleReservations: "by_org_vehicle",
  vehicles: "by_org",
  vehicleSupplierPayables: "by_org",
  vehicleSupplierReceivables: "by_org",
  workOrders: "by_org",
};

/**
 * The root tables are read too, through their org index, but never as a purge candidate: a NON-purged row of one
 * of them that mentions a purged id is a surviving reference (a live sale naming a purged application), and every
 * one of their ids is a "root-class id" a joining row may not hold unless that root is purged as well.
 */
export const PURGE_ROOT_SURVIVOR_INDEX: Readonly<Record<string, string>> = {
  expenses: "by_org",
  financeApplications: "by_org",
  sales: "by_org",
};

/** Tables read through their PARENT's id (they have no org index): journal lines, per purged journal. */
export const PURGE_PARENT_INDEX: Readonly<Record<string, { index: string; parent: string; field: string }>> = {
  journalLines: { index: "by_journal_entry", parent: "journalEntries", field: "journalEntryId" },
};

/** Tables read by `db.get` of one known id rather than an index (the organization row has no org index). */
export const PURGE_SCANNED_BY_GET: ReadonlySet<string> = new Set(["organizations"]);

/**
 * A reference into a purgeable table from a table the manifest neither scans nor reads by id must be listed here
 * with the reason it is safe, or the census fails. Empty today: after round 1 every table that holds such a
 * reference is scanned (the schema walk in `scripts/purgeImpactMapCensus.test.ts` proves it, key = `table.path->target`).
 */
export const PURGE_REFERENCE_COVERAGE: Readonly<Record<string, string>> = {};

/** Classes whose rows may be purged: a reference INTO one of them is what the survivor scan exists to find. */
export const PURGE_TARGET_CLASSES: ReadonlySet<PurgeImpactClass> = new Set<PurgeImpactClass>([
  "ROOT", "EXPLICIT_ROOT", "OWNED_CHILD", "STRUCTURAL", "LEDGER", "DERIVED", "FORWARD_LINKED",
]);

/**
 * Phase 1b: rows that leave WITH an explicit root because one field says they belong to it. `child.field` holds the
 * parent root's id. A payslip leaves with its run even when it names a real sale (ruling B). A deposit's hold slice is
 * joined too, but the deposit proof (purgeRootProofs.ts) refuses unless every slice is resolved, inactive and names no real sale.
 */
export const PURGE_OWNED_CHILDREN: Readonly<Record<string, { parent: string; field: string }>> = {
  payrollItems: { parent: "payrollRuns", field: "runId" },
  depositVehicleHolds: { parent: "deposits", field: "depositId" },
};

/**
 * Phase 1b (ruling A): the audit tables whose rows are deleted with the record they are ABOUT. The value is the one
 * field that names that subject; a row whose subject is purged leaves, and a row that only MENTIONS a purged id
 * somewhere else refuses (AUDIT_MIXED_SUBJECT) because deleting it would erase the history of a kept record.
 * `applicationStatusLog` is already STRUCTURAL (its subject is a v.id field, so closure joins it).
 */
export const PURGE_AUDIT_SUBJECT: Readonly<Record<string, string>> = {
  financialAuditLog: "resourceId",
  adminAuditLog: "targetId",
};

/** Tables whose rows name a payslip when it was paid or deducted from: evidence the run is not a plain cancelled draft. */
export const PURGE_PAYROLL_PAYMENT_TABLES: readonly string[] = ["employeeAdvanceRecoveries", "dealCommissionLines", "openingCommissionLiabilities"];

/**
 * A purged row in one of these states is LIVE money or an open obligation: purging it is the owner's call, so it
 * refuses (LIVE_STATE_ROW) unless its id is passed in `approvedLiveRowIds`. The values are the schema literals
 * (census-checked). Tables NOT listed carry no money status: financeAppraisals and financeDealFees hold amounts
 * but no lifecycle (their payables carry it), and the rest are history rows.
 */
export interface PurgeLiveRule { field: string; values: readonly string[]; /** Phase 1b: a table with its own refusal code and its own approval limits (purgeEvidence.ts). */ code?: "CONFIRMED_PAYMENT_EVIDENCE" | "COMMITMENT_CLAIM" }

export const PURGE_LIVE_STATES: Readonly<Record<string, PurgeLiveRule>> = {
  canonicalPayments: { field: "status", values: ["VERIFIED", "PENDING_SETTLEMENT", "SETTLED"] },
  commandIdempotency: { field: "status", values: ["STARTED"] },
  customerFinanceCompanyPayments: { field: "status", values: ["CONFIRMED"], code: "CONFIRMED_PAYMENT_EVIDENCE" },
  dealUnwinds: { field: "status", values: ["ACTIVE"] },
  depositApplications: { field: "status", values: ["APPLIED", "REVERSING"] },
  depositCancellationPendings: { field: "status", values: ["PENDING", "QUARANTINED", "FORFEITED"] },
  financeDealCustody: { field: "status", values: ["OPEN"] },
  paymentAllocations: { field: "status", values: ["ACTIVE"] },
  receivableDocuments: { field: "status", values: ["OPEN", "PARTIALLY_PAID", "PAID", "WRITTEN_OFF"] },
  // Phase 1c: judged by purgeCommitments.ts (evidence, hold, lineage), with no approvable id.
  vehicleCommitmentClaims: { field: "status", values: ["ACTIVE"], code: "COMMITMENT_CLAIM" },
  vehicleSupplierPayables: { field: "status", values: ["PENDING", "NOT_YET_DUE", "DUE_ON_SALE", "PARTIALLY_PAID", "PAID", "DISPUTED"] },
};

/**
 * Every OTHER purgeable table that has a `status` lifecycle, with the reason a purged row in any of its states is not
 * live money. The census requires each purgeable table with a status literal to be here or in PURGE_LIVE_STATES.
 */
export const PURGE_NOT_LIVE_STATUS: Readonly<Record<string, string>> = {
  accountingEvents: "ledger rows: the pair rules (POSTED/REVERSED, linked both ways, net zero) are the liveness check, not a status list",
  financeAppraisals: "a valuation document; the money it leads to is a vehicleSupplierPayables row, which IS a live state",
  journalEntries: "ledger rows: only POSTED or REVERSED journals may be paired, so a DRAFT journal already refuses (JOURNAL_NOT_PAIRED)",
};

export interface PurgeClearRule {
  field: string;
  whenField: string;
  notIn?: readonly string[];
  in?: readonly string[];
  /** Set when the clear changes behaviour: the row is listed ONLY for an exact id the owner approved; the text is its fixed consequence. */
  ownerApproval?: string;
}

/**
 * A kept row tied to the purge by ONE link field may keep living with that field emptied. `whenField` with `in`/`notIn`:
 * the row may be cleared only while that field holds an allowed value, i.e. while the link is history and not the live
 * authority. Every clear is listed with that guarding value so the owner can judge it.
 *  - depositVehicleHolds.appliedSaleId: saleCancellation.ts empties it when it releases a slice; no reader uses it
 *    outside APPLIED (the zero-amount reopen checks allocationStatus first).
 *  - vehicles.soldBySaleId: `assertSoldVehicleOwnedBySale` needs it ONLY for a SOLD car (saleHelpers.ts).
 *  - deposits.resolutionSaleId: NOT a plain history link. The app empties it in two places only, both in
 *    saleCancellation.ts: when it reopens an APPLIED deposit to HELD, and when it reinstates the hold of a HELD
 *    deposit whose hold was closed; each time together with resolvedBy, resolvedAt, resolutionTreatment and
 *    resolutionReason. Nothing empties it on a REFUNDED or FORFEITED deposit. An empty field changes two gates:
 *    identityCorrectionShowroomRefund.ts requires it empty on a REFUNDED deposit, and openingDepositRefunds.ts
 *    refuses an opening deposit that still has it. So it is a refusal unless the owner approves the exact deposit id.
 * commitmentRoots.consumedBySaleId is WRITE-ONCE ("nothing may rewrite it") and payrollItems.commissionSaleIds is
 * a payroll fact: both stay refusals.
 */
export const PURGE_CLEARABLE_FIELDS: Readonly<Record<string, PurgeClearRule>> = {
  depositVehicleHolds: { field: "appliedSaleId", whenField: "allocationStatus", in: ["RELEASED_AWAITING_DECISION", "RESOLVED"] },
  deposits: {
    field: "resolutionSaleId", whenField: "status", notIn: ["APPLIED"],
    ownerApproval:
      "The app empties resolutionSaleId only together with resolvedBy, resolvedAt, resolutionTreatment and resolutionReason, when it reopens a deposit to HELD (saleCancellation.ts). " +
      "Emptying it alone changes two eligibility gates: a REFUNDED deposit becomes valid showroom-refund proof (identityCorrectionShowroomRefund.ts) " +
      "and a HELD opening deposit becomes refundable (openingDepositRefunds.ts).",
  },
  vehicles: { field: "soldBySaleId", whenField: "status", notIn: ["SOLD"] },
};

/** Storage files (`v.id("_storage")`) held by purgeable rows: Phase 2 must delete them with the rows. */
export const PURGE_STORAGE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  financeAppraisals: ["documentStorageIds"],
  financeDealFees: ["documentStorageIds"],
  vehicleSupplierPayables: ["documentStorageIds"],
};

export function tablesOfClass(...classes: PurgeImpactClass[]): string[] {
  return Object.entries(PURGE_IMPACT_MAP)
    .filter(([, c]) => classes.includes(c))
    .map(([t]) => t);
}
