/**
 * The 127-entry economic-command classification ratchet (SCRUM-313; 113 at the
 * RC, +1 for SCRUM-83's `financingEconomics.resolveAppraisalGap`, +1 for
 * SCRUM-215's `financeDealCosts.recordTemplateFeeActual`, +1 for SCRUM-27's `financingEconomics.recordManualFinanceApproval`).
 *
 * OWNER RULING: every public mutation that can reach a money-bearing sink must
 * carry EXACTLY ONE classification, and this must FAIL whenever a new public
 * financial writer is in none of them. The old 31-command SCRUM-57 manifest is
 * explicitly a SUBSET of this population, not an equal.
 *
 * The mechanism is recorded per entry, not just the bucket, because
 * IDENTITY_GUARDED can be satisfied by more than one mechanism —
 * `vehicles.importBulk` carries a stable per-row import identity rather than
 * `runWithIdempotency`, and forcing everything through one helper would be a
 * false uniformity.
 *
 * The self-tests at the top come first deliberately, in the same spirit as
 * `tenantWriteGuard.test.ts`: a guard nobody has watched fail is not a guard.
 * They pin the SIX blind spots this analyzer actually had, each of which
 * produced a wrong census before it was caught. Deleting any of them re-opens a
 * hole that has already cost real analysis once.
 */
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import {
  buildGraph,
  censusForward,
  censusReverse,
  findSinks,
  hasCommandIdentity,
  mintsAndPostsLocally,
  mintsAndPostsTransitively,
  MONEY_TABLES,
  stripComments,
  type Bucket,
  type SymbolRecord,
} from "./economicCommandCensus";

const CONVEX_ROOT = path.resolve(__dirname, "..", "convex");

const CLASSIFICATION: Record<string, { bucket: Bucket; mechanism: string }> = {
  "accountingCutover.approveOpeningBalance": { bucket: "STATE_GUARDED", mechanism: "refuses unless the draft is in an approvable state; proven by rehearsal R10-style replay" },
  "accountingCutover.draftOpeningBalance": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "accountingCutover.postOpeningBalanceDirect": { bucket: "STATE_GUARDED", mechanism: "refuses when an opening balance is already posted or awaiting approval" },
  "accountingCutover.rejectOpeningBalanceDraft": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "accountingMigration.backfillFixedAssetMinorUnits": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "accountingMigration.backfillPartnerEquityMinorUnits": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "accountingOutbox.retryFailed": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "applications.amendSupplierDisbursementAdvice": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "applications.cancelApplication": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "applications.confirmDisbursement": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "applications.returnFinanceDisbursementCheque": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "applications.confirmSupplierDisbursement": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "applications.createFromQuote": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "applications.finalizeDeal": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "applications.repairQuoteEconomicsLineage": { bucket: "NON_ECONOMIC", mechanism: "fills missing quotation lineage fields after exact quote and tenant validation; it creates no payment, receivable, journal, or accounting event" },
  "applications.registerExpectedPayment": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "applications.correctExpectedPayment": { bucket: "NON_ECONOMIC", mechanism: "SCRUM-447: withdraws an unposted expected payment and its HELD cheque (status to CANCELLED); refuses DEPOSITED/CLEARED rows and any receivable allocation; no posting call is reachable from its own body" },
  "applications.attestChequeFace": { bucket: "NON_ECONOMIC", mechanism: "SCRUM-447: records the operator-attested face on a live unposted cheque (amountMinor/currency/attestedBy); never touches `amount` and posts nothing; the face only gates confirmDisbursement" },
  "applications.registerVehicleHandover": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "applications.setSupplierSettlementRoute": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "applications.updateStatus": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "bankReconciliation.confirmMatch": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "branches.migrateToDefaultBranch": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "cashDrawer.approveVariance": { bucket: "STATE_GUARDED", mechanism: "hookCashDrawerDeposited keys on `cash_drawer_deposited_${sessionId}` — the pre-existing session" },
  "cashDrawer.beginCount": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "cashDrawer.close": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "cashDrawer.open": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "cashDrawer.recordMovement": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "collections.applyRetainedCredit": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "collections.clearCheque": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "collections.createInstallmentPlan": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "collections.createReceivable": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "collections.depositCheque": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "collections.recordPayment": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "collections.registerCheque": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "collections.replaceCheque": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "collections.respondToApproval": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "collections.returnCheque": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "collections.returnClearedCheque": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "collections.reviewCashierReconciliation": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "collections.submitCashierReconciliation": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "customers.softDelete": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "deposits.create": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "dealUnwind.abandonDealUnwind": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted; posts nothing — ends an ACTIVE unwind (SCRUM-693)" },
  "dealUnwind.finishDealUnwind": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted; the unwind must be ACTIVE (it leaves COMPLETED); the receipt reversal is keyed on the disbursement version it reverses and proven POSTED, and it and the closed-deal teardown commit or roll back together (SCRUM-693 ruling B)" },
  "dealUnwind.recordDealUnwindForwardReturn": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted; STEP_DONE once forwardReturn is recorded, and reverseForward refuses a forward already reversed (SCRUM-693)" },
  "depositRequests.confirm": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted; the request must still be PENDING, and only CONFIRM_FINANCE_DISBURSEMENT holders reach the posting (SCRUM-444)" },
  "deposits.release": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "deposits.releaseVehicleAllocation": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "deposits.resolveReleasedAllocation": { bucket: "STATE_GUARDED", mechanism: "operates on an existing deposit allocation; the application id it posts under pre-exists the call" },
  "deposits.voidDeposit": { bucket: "STATE_GUARDED", mechanism: "posts only from pre-existing durable state, so its accounting idempotency key is stable across a retry and the posting engine dedupes it" },
  "expenses.create": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "expenses.remove": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "expenses.reverseExpense": { bucket: "STATE_GUARDED", mechanism: "posts only from pre-existing durable state, so its accounting idempotency key is stable across a retry and the posting engine dedupes it" },
  "expenses.update": { bucket: "STATE_GUARDED", mechanism: "reverses through hookPrepaidExpenseAmortizationsReversed, whose reversal key is derived from the original posted event, not from a fresh id" },
  "financeDealCosts.adoptCompanyFeeTemplates": { bucket: "RETIRED", mechanism: "public compatibility endpoint remains source-visible but always throws; fee-template adoption was retired when adminFees became the sole expected execution-fee authority" },
  "financeDealCosts.openDealCustody": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted; the ISSUED entry it mints posts under `custody_entry_${entryId}` INSIDE the idempotent section, so a replay returns the stored custody id and never reaches the hook" },
  "financeDealCosts.planCustodyHandler": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic (a `plannedCustody` patch on financeApplications); names who will handle the handover before any cash moves, audited, and posts nothing" },
  "financeDealCosts.migrateLegacyCustodyToLedger": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted on the custody id; every posting it makes is keyed on PRE-EXISTING entry, fee and custody ids through the same hooks the product uses, and a fresh key against a record already CANONICAL is refused inside the section" },
  "financeDealCosts.reconcileDealCustody": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted on custody id, normalised notes and write-off reason; the write-off branch additionally posts CUSTODY_WRITTEN_OFF keyed on the pre-existing custody id plus a stored version, and every mutable-state check is inside the section" },
  "financeDealCosts.reconcileDealFee": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "financeDealCosts.recordActualFeeAmount": { bucket: "STATE_GUARDED", mechanism: "sets a named field on one identified row; the custody posting it re-syncs (`syncCustodyFeePosting`) is keyed on the PRE-EXISTING fee id plus a version stored on the row, so a retry finds `custodyPosted` already matching and posts nothing" },
  "financeDealCosts.recordCustodyMovement": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "financeDealCosts.recordDealFee": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "financeDealCosts.recordTemplateFeeActual": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted (position included); one live line per (deal, position) refused inside the idempotent section" },
  "financeDealCosts.recordDirectFeePayment": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted on fee, method, date, reference and the required expectedAmountMinor the approver saw; the HANDOVER_COST_PAID_DIRECT posting is keyed on the fee id plus a stored version and every state check (already paid, custody-linked, no actual, actual changed since the form rendered, earlier payment still posted) is inside the section" },
  "financeDealCosts.recordExecutionFeeActual": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted on application, currency, amount, payer, custody, paid date and reference; the line it mints posts custody only through syncCustodyFeePosting keyed on that fee id plus a stored version, INSIDE the section, and an already-linked execution fee is refused inside it (SCRUM-690)" },
  "financeDealCosts.bindExecutionFeeLine": { bucket: "NON_ECONOMIC", mechanism: "sets the executionFeeBinding marker on one identified existing fee line; no posting call is reachable, the only downstream write is the derived-economics recompute (a projection patch, deducted lines only), and re-linking the line already linked returns early (SCRUM-690)" },
  "financeDealCosts.unbindExecutionFeeLine": { bucket: "NON_ECONOMIC", mechanism: "clears the executionFeeBinding marker on one identified fee line and is refused while the line carries a custody posting or direct payment; no posting call is reachable, and an already-unlinked line returns early (SCRUM-690)" },
  "financeCompanyForward.recordFinanceCompanyForward": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true - fingerprinted on application, method, paid date, reference and the expectedAmountMinor the payer saw; the FINANCE_COMPANY_FORWARD_PAID posting is keyed on the application id plus a stored version and every state check (finalized, transfer not yet confirmed, proof is DUE, amount unchanged, closed period) is inside the section" },
  "financeCompanyForward.reverseFinanceCompanyForward": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true - fingerprinted on application, forward and reason; reverses the pinned forward version through reverseEventIfPosted, keyed on the stored version, and refuses a forward already being taken back" },
  "financeCompanyForward.reportFinanceCompanyForwardReturned": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true - fingerprinted on application, forward and reason; reverses the pinned ON_BOOKS forward version through reverseEventIfPosted, keyed on the stored version" },
  "financeDealCosts.recordLegalInvoice": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "financeDealCosts.reopenDealCustody": { bucket: "STATE_GUARDED", mechanism: "reverses the stored write-off posting version through reverseEventIfPosted, whose key derives from the pre-existing custody id and version; a retry finds status === OPEN and returns before any posting" },
  "financeDealCosts.setFeeCustody": { bucket: "STATE_GUARDED", mechanism: "charges or releases an EXISTING fee line: the posting it syncs is keyed on the pre-existing fee id plus a version stored on the row (`custodyPosted`), so a retry after a lost response finds the target state already on the books and posts nothing; a second identical call returns early on `fee.custodyId === args.custodyId`" },
  "financeDealCosts.voidDealFee": { bucket: "STATE_GUARDED", mechanism: "voids one identified row and reverses its stored custody posting version through reverseEventIfPosted; a retry finds `voidedAt` set and returns before any posting" },
  "financialAudit.approveManualJournal": { bucket: "STATE_GUARDED", mechanism: "refuses unless status === PENDING_APPROVAL; a second approval cannot produce a second journal (rehearsal R10)" },
  "financialAudit.createManualJournal": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "financialAudit.rejectManualJournal": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "financingEconomics.applyQuoteFirstPayment": { bucket: "NON_ECONOMIC", mechanism: "patches the finance application's economics (first payment re-derived from the quote) only through the over-inclusive patch heuristic; no posting call is reachable from its own body. Replay-safe by the economics stamp: a retry carries a stale stamp and is refused before the application is written (an impersonated caller's access-audit row from requireTenantAuth may precede it; that row is not economic) (SCRUM-373)" },
  "financingEconomics.approveDealerPurchaseAmount": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "financingEconomics.recordAppraisal": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "financingEconomics.recordManualFinanceApproval": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table (financeApplications letter/G/gap) only through the patch heuristic; no posting call is reachable from its own body. Replay-safe by state: an identical letter on an intact unit is a no-op; after handover only an S-only correction is accepted, and nothing after finalize (SCRUM-27)" },
  "financingEconomics.recordSubmittedQuotation": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "financingEconomics.reopenApproval": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "financingEconomics.resolveAppraisalGap": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table (financeApplications gap shares/destinations) only through the patch heuristic; no posting call is reachable from its own body. Replay-safe by state: refuses once gapResolution is CUSTOMER_ABSORBS/SPLIT/DEALER_ABSORBS and checks the economics stamp before any write (SCRUM-83)" },
  "financingEconomics.resolveFinancingReconciliation": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "fixedAssets.capitalize": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "fixedAssets.dispose": { bucket: "STATE_GUARDED", mechanism: "hookAssetDisposed keys on `asset_disposed_${assetId}` — the PRE-EXISTING asset, so a retry reproduces the key and the posting engine dedupes it" },
  "fixedAssets.impair": { bucket: "STATE_GUARDED", mechanism: "hookAssetImpaired keys on `asset_impaired_${assetId}` — pre-existing asset id, stable across a retry" },
  "fixedAssets.remove": { bucket: "STATE_GUARDED", mechanism: "refuses removal of a capitalized, undisposed asset (callers must dispose instead); soft-deletes only legacy or already-DISPOSED assets, which carry no ledger effect" },
  "fixedAssets.update": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "orgSettings.upsert": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "partnerEquity.add": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "partnerEquity.recordEquityMovement": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "partnerEquity.remove": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "partnerEquity.update": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "paymentIntents.create": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "paymentIntents.expire": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "paymentIntents.markSettled": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "payroll.approveRun": { bucket: "STATE_GUARDED", mechanism: "hookPayrollAccrued keys on `payroll_accrued_${itemId}`; items are minted by createRun, so at approve time the id pre-exists and the key is stable" },
  "payroll.cancelRun": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "payroll.createRun": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "payroll.payRun": { bucket: "STATE_GUARDED", mechanism: "hookPayrollPaid keys on `payroll_paid_${itemId}` — pre-existing payroll item" },
  "payroll.recordAdvance": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "payroll.recoverAdvance": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "prepaidExpenses.approveCorrectionRequest": { bucket: "STATE_GUARDED", mechanism: "refuses unless request.status === PENDING" },
  "prepaidExpenses.correctSchedule": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "prepaidExpenses.redriveScheduleEvents": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "prepaidExpenses.retryAmortizationFailure": { bucket: "STATE_GUARDED", mechanism: "hookPrepaidExpenseAmortized keys on `prepaid_amort_${scheduleId}_${yearMonth}` — both pre-existing/deterministic, which is precisely what makes a RETRY endpoint safe" },
  "sales.completeDraft": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "sales.completeFromQuote": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "sales.create": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "sales.createDraft": { bucket: "NON_ECONOMIC", mechanism: "prepareSaleCompletion(DRAFT) writes no rows and insertSaleRecord(PENDING) only inserts the sale; applySaleCompletionSideEffects is never reached" },
  "sales.markCommissionPaid": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "sales.markCommissionUnpaid": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "sales.recalculateCommission": { bucket: "STATE_GUARDED", mechanism: "makeCommissionHook keys on `${prefix}_${saleId}` — pre-existing sale" },
  "sales.setCommissionAmount": { bucket: "STATE_GUARDED", mechanism: "convergent set-to-value: commissionAmount is SET, and deltaMinor = next - previous, so a retry computes 0, posts nothing and burns no adjustment sequence" },
  "sales.softDelete": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "sales.update": { bucket: "STATE_GUARDED", mechanism: "posts only from pre-existing durable state, so its accounting idempotency key is stable across a retry and the posting engine dedupes it" },
  "sourcingPayables.markPaid": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "sourcingPayables.recordPartialPayment": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "sourcingPayables.setDisputed": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "supplierReceivables.recordReceipt": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "supplierCostRecoveries.recordReceipt": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted; posts synchronously keyed by the receipt id (SCRUM-389)" },
  "supplierCostRecoveries.reverseReceipt": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted; reverses under its own per-receipt key (SCRUM-389)" },
  "supplierReceivables.setDisputed": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "vehicleEdits.resolve": { bucket: "STATE_GUARDED", mechanism: "refuses unless request.status === PENDING; the same mutation transitions it to APPROVED/REJECTED" },
  "vehicles.correctAcquisitionCost": { bucket: "STATE_GUARDED", mechanism: "convergent set-to-value: the retry re-reads the patched cost, delta === 0, and throws COST_CORRECTION_NO_CHANGE so Convex rolls back before the insert and the hook" },
  "vehicles.create": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "vehicles.createReservation": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "vehicles.importBulk": { bucket: "IDENTITY_GUARDED", mechanism: "per-row import identity `${importId}:${row.rowId}` — a SECOND valid mechanism, not runWithIdempotency" },
  "vehicles.releaseReservation": { bucket: "NON_ECONOMIC", mechanism: "reaches a money-bearing table only through the over-inclusive patch heuristic; no posting call is reachable from its own body" },
  "vehicles.update": { bucket: "STATE_GUARDED", mechanism: "hookVehicleAcquired keys on `vehicle_acquired_${vehicleId}` — pre-existing vehicle (contrast vehicles.create, where that id is minted in-call, which is why THAT one needs identity)" },
  "vehicles.upsertLandedCosts": { bucket: "STATE_GUARDED", mechanism: "convergent: accountDeltas = newSums - oldSums against the STORED items, so a retry yields zero deltas and never reaches the posting call. NOTE the posting mints `editToken: crypto.randomUUID()` server-side — that would be a retry hole if the deltas were absolute; it is safe ONLY because the guard above it is convergent" },
  "workOrders.create": { bucket: "IDENTITY_GUARDED", mechanism: "runWithIdempotency with economic: true — caller-supplied identity, fingerprinted" },
  "workOrders.update": { bucket: "STATE_GUARDED", mechanism: "refuses when the work order already carries expenseId, which this same mutation patches on success" },
};

describe("analyzer self-tests — the six blind spots, pinned", () => {
  test("BLIND SPOT 1: a callee is resolved through imports, never by bare name", () => {
    // `create`, `add` and `update` are symbol names in dozens of modules. Bare
    // name resolution fused the graph and reported 348 of 349 public mutations
    // as economic. If a future edit reintroduces name-based linking, the
    // population explodes and this catches it.
    const g = buildGraph(CONVEX_ROOT);
    const population = censusForward(g);
    const publicMutations = [...g.symbols.values()].filter((s) => s.kind === "publicMutation");
    expect(publicMutations.length).toBeGreaterThan(300);
    // A fused graph puts essentially EVERY public mutation in the population.
    expect(population.size).toBeLessThan(publicMutations.length * 0.6);
  });

  test("BLIND SPOT 2: a financial sink is not only a ledger insert", () => {
    // Defining a sink as a journal/accountingEvents insert dropped seven
    // already-protected commands that move money without posting. Those tables
    // must remain in the money-bearing set.
    for (const table of ["deposits", "paymentIntents", "financeDealCustody", "financeDealFees"]) {
      expect(MONEY_TABLES).toContain(table);
    }
  });

  test("BLIND SPOT 3: ctx.db.patch is reachable by sink detection", () => {
    // patch/replace take a DOCUMENT ID, never a table name, so a call-site
    // regex can only ever see inserts. A function that only patches, while
    // naming a money table in a typed id, must still be a sink.
    const onlyPatches: SymbolRecord = {
      id: "synthetic.patchesOnly",
      file: "synthetic",
      name: "patchesOnly",
      kind: "publicMutation",
      line: 1,
      body: [
        "export const patchesOnly = mutation({",
        "  handler: async (ctx, args: { id: Id<\"receivables\"> }) => {",
        "    await ctx.db.patch(args.id, { outstandingAmount: 0 });",
        "  },",
        "});",
      ].join("\n"),
    };
    const sinks = findSinks(new Map([[onlyPatches.id, onlyPatches]]));
    expect([...sinks]).toEqual(["synthetic.patchesOnly"]);
  });

  test("BLIND SPOT 4: mint-and-post detection is transitive through a helper", () => {
    // `partnerEquity.add` -> `recordMovement` mints the transactions row and
    // posts. A local-only check calls the command safe; the owner found this by
    // hand. The local check must say NO and the transitive one must say YES, or
    // the ratchet has the same hole it had before.
    const command: SymbolRecord = {
      id: "synthetic.command", file: "synthetic", name: "command", kind: "publicMutation", line: 1,
      body: [
        "export const command = mutation({",
        "  handler: async (ctx, args) => {",
        "    return await helper(ctx, args);",
        "  },",
        "});",
      ].join("\n"),
    };
    const helper: SymbolRecord = {
      id: "synthetic.helper", file: "synthetic", name: "helper", kind: "helper", line: 10,
      body: [
        "async function helper(ctx, args) {",
        "  const transactionId = await ctx.db.insert(\"partnerEquityTransactions\", { ...args });",
        "  const hookArgs = { transactionId, orgId: args.orgId };",
        "  await hookCapitalContributed(ctx, hookArgs);",
        "  return transactionId;",
        "}",
      ].join("\n"),
    };
    const symbols = new Map([[command.id, command], [helper.id, helper]]);
    const g = {
      symbols,
      edges: new Map([[command.id, new Set([helper.id])], [helper.id, new Set<string>()]]),
      rEdges: new Map([[helper.id, new Set([command.id])], [command.id, new Set<string>()]]),
      sinks: new Set<string>(),
    };
    expect(mintsAndPostsLocally(command.body)).toBe(false);
    expect(mintsAndPostsTransitively(g, command.id)).toBe(true);
  });

  test("BLIND SPOT 5: comment text is not a call (SCRUM-738)", () => {
    // A body is sliced from its declaration to the NEXT declaration, so the next
    // function's leading JSDoc lands in the previous symbol's body, and call/hook
    // tokens were matched over raw text. A JSDoc naming a hook therefore produced
    // a false money edge. Edge extraction now strips comments with a TypeScript
    // aware pass; it must stay precise in BOTH directions: no edge from a comment,
    // and no real call lost to a `//` or `/*` that is only text inside a literal.
    const BT = "`";
    const fixture = [
      "export function foo(x: number) { return x; }",
      "export function hookX() { return 0; }",
      "export function runWith(h: unknown) { return h; }",
      "export function awaitfoo() { return 0; }",
      // (a) comments only. The JSDoc on nextOne is attributed to commentsOnly.
      "export function commentsOnly() {",
      "  // calls foo() and hookX here",
      "  /** hookX and foo() in a block */",
      "  return 1; // trailing foo() hookX",
      "}",
      "/**",
      " * Leading JSDoc of the NEXT declaration: names `hookX` and foo().",
      " */",
      "export function nextOne() { return 2; }",
      // (b) real edges that sit beside a trailing comment on the same line.
      "export function realCall() {",
      "  const y = foo(1); // mentions runWith() only in a comment",
      "  return y;",
      "}",
      "export function realHookValue() {",
      "  runWith(hookX); /* trailing */",
      "}",
      "export function realHookConst() {",
      "  const h = hookX; // trailing foo()",
      "  return h;",
      "}",
      // Replacing a comment must not glue its neighbours: awaitfoo is NOT foo.
      "export function gluing() {",
      "  return await/**/foo(1);",
      "}",
      // (c) comment markers inside literals must not hide a following real call.
      "export function dqString() {",
      '  const s = "https://example.com"; foo(1);',
      "  runWith(2);",
      "}",
      "export function sqString() {",
      "  const s = 'http://x /* y'; foo(1);",
      "  runWith(2);",
      "}",
      "export function templateText() {",
      "  const t = " + BT + "a // b /* c" + BT + "; foo(1);",
      "  runWith(2);",
      "}",
      "export function regexSlashes() {",
      String.raw`  const r = /["']\/\//; foo(1);`,
      "  runWith(2);",
      "}",
      "export function regexQuote() {",
      String.raw`  const r = /"/; foo(1);`,
      "  runWith(2);",
      "}",
      "export function regexBlockOpen() {",
      String.raw`  const r = /a\/*b/; foo(1);`,
      "  runWith(2);",
      "}",
      // (d) a call inside a template expression is still a call.
      "export function templateCall() {",
      "  return " + BT + "x ${foo()} y // z" + BT + ";",
      "}",
      "export function nestedTemplateCall() {",
      "  return " + BT + "a ${" + BT + "b ${runWith(1)}" + BT + "} /* c" + BT + ";",
      "}",
    ].join("\n");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "census738-"));
    try {
      fs.writeFileSync(path.join(dir, "fx.ts"), fixture);
      // (e) a JSDoc that is the LAST content of a file hangs off the EndOfFileToken.
      fs.writeFileSync(
        path.join(dir, "tail.ts"),
        "export function foo() { return 0; }\nexport function bar() { return 1; }\n/** foo() */\n",
      );
      const g = buildGraph(dir);
      const edgesOf = (n: string) => [...(g.edges.get(`fx.${n}`) ?? [])].sort();

      // (a) comments create no edge, including the JSDoc the slicer mis-attributes.
      expect(edgesOf("commentsOnly")).toEqual([]);
      expect(edgesOf("nextOne")).toEqual([]);

      // (b) real call / hook-as-value edges survive beside a trailing comment.
      expect(edgesOf("realCall")).toEqual(["fx.foo"]);
      expect(edgesOf("realHookValue")).toEqual(["fx.hookX", "fx.runWith"]);
      expect(edgesOf("realHookConst")).toEqual(["fx.hookX"]);
      expect(edgesOf("gluing")).toEqual(["fx.foo"]);

      // (c) literals that merely contain `//` or `/*` lose nothing after them.
      for (const n of ["dqString", "sqString", "templateText", "regexSlashes", "regexQuote", "regexBlockOpen"]) {
        expect(edgesOf(n), n).toEqual(["fx.foo", "fx.runWith"]);
      }

      // (d) calls inside template expressions are still seen.
      expect(edgesOf("templateCall")).toEqual(["fx.foo"]);
      expect(edgesOf("nestedTemplateCall")).toEqual(["fx.runWith"]);

      // (e) terminal JSDoc is comment text too: no edge, and the text is blanked.
      expect([...(g.edges.get("tail.bar") ?? [])]).toEqual([]);
      const tail = "export function bar() { return 1; }\n/** foo() */\n";
      const blanked = stripComments(tail);
      expect(blanked).toBe("export function bar() { return 1; }\n" + " ".repeat("/** foo() */".length) + "\n");
      expect(blanked.length).toBe(tail.length);
      expect(blanked.split("\n").length).toBe(tail.split("\n").length);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("BLIND SPOT 6: a factory-built hook is a real call (SCRUM-738 F1)", () => {
    // `export const hookCommissionPaid = makeCommissionHook(...)` puts its only
    // callee on the DECLARATION line, which edge extraction used to skip (it
    // sliced from the line after). Comment-derived edges had hidden that. The
    // declaration line's code after the first `=` is now read for `const`/`let`,
    // minus the Convex builder call (`mutation(`) which would otherwise fuse the
    // graph, and a call may carry a type-argument list (`make<T>(`).
    const fixture = [
      'export function makeHook(name: string) {',
      '  return async (ctx: any) => { await ctx.db.insert("receivables", { name }); };',
      '}',
      'export function makeHook2<T>(opts: T) {',
      '  return async (ctx: any) => { await ctx.db.insert("receipts" + "x", opts); await ctx.db.insert("deposits", {}); };',
      '}',
      'export function plain() { return 1; }',
      'export function a() { return 1; }',
      'export const mutation = customMutation(rawMutation);',
      'export const hookA = makeHook("X");',
      // A NESTED generic inside the type argument (`Id<"t">`), as the real
      // reversal hooks in convex/accounting/workflowHooks.ts carry.
      'export const hookB = makeHook2<{ k: Id<"t"> }>({',
      '  k: "v",',
      '});',
      'export const pubA = mutation({',
      '  handler: async (ctx: any) => { await hookA(ctx); },',
      '});',
      'export const pubB = mutation({',
      '  handler: async (ctx: any) => { await hookB(ctx); },',
      '});',
      'export const pubNoCall = mutation({',
      '  handler: async (ctx: any) => { return 1; },',
      '});',
      'export const pubGeneric = mutation<Args>({',
      '  handler: async (ctx: any) => { return 1; },',
      '});',
      // A comparison is not a type-argument list: no edge to `a`.
      'export const pubCompare = mutation({',
      '  handler: async (ctx: any, b: number, c: (n: number) => number) => { return a < b && c(1); },',
      '});',
    ].join("\n");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "census738f1-"));
    try {
      fs.writeFileSync(path.join(dir, "fx6.ts"), fixture);
      const g = buildGraph(dir);
      const edgesOf = (n: string) => [...(g.edges.get(`fx6.${n}`) ?? [])].sort();

      // The factory callee is on the declaration line only.
      expect(edgesOf("hookA")).toEqual(["fx6.makeHook"]);
      expect(edgesOf("hookB")).toEqual(["fx6.makeHook2"]);
      // The builder call never becomes an edge, so the graph cannot fuse.
      for (const n of ["pubNoCall", "pubGeneric"]) expect(edgesOf(n), n).toEqual([]);
      expect(edgesOf("pubA")).toEqual(["fx6.hookA"]);
      expect(edgesOf("pubB")).toEqual(["fx6.hookB"]);
      // `a < b && c(` is a comparison, not `a<...>(`.
      expect(edgesOf("pubCompare")).toEqual([]);

      expect(g.sinks.has("fx6.makeHook")).toBe(true);
      expect(g.sinks.has("fx6.makeHook2")).toBe(true);
      const forward = censusForward(g);
      expect(forward.has("fx6.pubA")).toBe(true);
      expect(forward.has("fx6.pubB")).toBe(true);
      expect(forward.has("fx6.pubNoCall")).toBe(false);
      expect(forward.has("fx6.pubGeneric")).toBe(false);
      expect(forward.has("fx6.pubCompare")).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── KNOWN GAPS (SCRUM-742). These two tests assert the gap EXISTS today, so
  // they are deliberately written to BREAK the moment the analyzer is rewritten
  // over the TypeScript AST and the gap closes. When they fail: that is the
  // fix landing. Flip each `toEqual([])` to the control's expectation, rename the
  // test, and delete the matching SCRUM-742 tripwire below. Neither shape is on a
  // current money path; the tripwire test over the real tree enforces that.
  const edgesIn = (file: string, fixture: string, name: string): string[] => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "census742-"));
    try {
      fs.writeFileSync(path.join(dir, `${file}.ts`), fixture);
      const g = buildGraph(dir);
      return [...(g.edges.get(`${file}.${name}`) ?? [])].sort();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  test("KNOWN GAP (SCRUM-742): a generic call whose type argument contains parentheses gets no edge", () => {
    // `(?:<[^()]*>)?` cannot span the `(x: number)` inside the type argument.
    const fixture = [
      "export function make<T>(): number { return 1; }",
      "export const hookGap = make<{ cb: (x: number) => void }>();",
      // Control: the same call without parentheses in the type argument IS an edge.
      'export const hookCtl = make<{ k: Id<"t"> }>();',
    ].join("\n");
    expect(edgesIn("fx742a", fixture, "hookCtl")).toEqual(["fx742a.make"]);
    // MUST FLIP to ["fx742a.make"] when SCRUM-742 lands.
    expect(edgesIn("fx742a", fixture, "hookGap")).toEqual([]);
  });

  test("KNOWN GAP (SCRUM-742): any call on a `function` declaration line (parameter default or one-line body) gets no edge", () => {
    // Function declaration lines are not read for edges (only const/let are), so
    // neither a parameter default nor a body that opens and closes on that line.
    const fixture = [
      "export function plain() { return 1; }",
      "export function fnDefault(x = plain()) { return x; }",
      "export function one() { return plain(); }",
      // Control: the same call on a LATER line is an edge.
      // (Multi-line: the declaration line itself is never read for `function`.)
      "export function fnBody(x: number) {",
      "  return plain() + x;",
      "}",
    ].join("\n");
    expect(edgesIn("fx742b", fixture, "fnBody")).toEqual(["fx742b.plain"]);
    // BOTH MUST FLIP to ["fx742b.plain"] when SCRUM-742 lands.
    expect(edgesIn("fx742b", fixture, "fnDefault")).toEqual([]);
    expect(edgesIn("fx742b", fixture, "one")).toEqual([]);
  });
});

describe("SCRUM-313 economic command classification ratchet", () => {
  const g = buildGraph(CONVEX_ROOT);
  const forward = censusForward(g);
  const reverse = censusReverse(g);

  test("the population is derived identically in both directions", () => {
    const onlyForward = [...forward].filter((x) => !reverse.has(x)).sort((a, b) => a.localeCompare(b));
    const onlyReverse = [...reverse].filter((x) => !forward.has(x)).sort((a, b) => a.localeCompare(b));
    expect(onlyForward).toEqual([]);
    expect(onlyReverse).toEqual([]);
  });

  test("the population is exactly the classified set", () => {
    const liveClassified = Object.entries(CLASSIFICATION)
      .filter(([, entry]) => entry.bucket !== "RETIRED")
      .map(([id]) => id)
      .sort((a, b) => a.localeCompare(b));
    const retired = Object.entries(CLASSIFICATION)
      .filter(([, entry]) => entry.bucket === "RETIRED")
      .map(([id]) => id)
      .sort((a, b) => a.localeCompare(b));
    const population = [...forward].sort((a, b) => a.localeCompare(b));
    // Both directions, so a NEW public financial writer fails here rather than
    // entering the codebase unclassified, and a classification for a command
    // that no longer exists fails too rather than rotting.
    expect(population.filter((p) => !CLASSIFICATION[p])).toEqual([]);
    expect(liveClassified.filter((c) => !forward.has(c))).toEqual([]);
    expect(retired.filter((c) => forward.has(c))).toEqual([]);
    // 116 → 117: `applications.repairQuoteEconomicsLineage` (TASK-DEAL-01).
    // 117 → 119: `financeDealCosts.planCustodyHandler` and `financeDealCosts.setFeeCustody` (AF-80).
    // Fee-template adoption is classified RETIRED and therefore excluded from
    // the live population by construction; the live census remained 119 until:
    // 119 → 120: `financingEconomics.applyQuoteFirstPayment` (SCRUM-373 D2).
    // 120 → 122: `supplierCostRecoveries.recordReceipt` and
    // `supplierCostRecoveries.reverseReceipt` (SCRUM-389 supplier cost bearer).
    // 122 → 121: `financeDealCosts.classifyDealAccounting` RETIRED (SCRUM-407),
    // then deleted outright with its classification entry.
    // 121 → 122: `depositRequests.confirm` (SCRUM-444); `request` writes only a pending row and is not in the population.
    // 122 → 123: `financeDealCosts.recordDirectFeePayment` (SCRUM-443).
    // 123 → 125: `applications.correctExpectedPayment` and
    // `applications.attestChequeFace` (SCRUM-447).
    // 123 -> 126: `financeCompanyForward.recordFinanceCompanyForward`, `.reverseFinanceCompanyForward` and `.reportFinanceCompanyForwardReturned` (SCRUM-435).
    // 126 -> 128: the two SCRUM-447 mutations above, on top of the SCRUM-435 three (merge of origin/main into SCRUM-447).
    // 128 -> 129: `financingEconomics.recordManualFinanceApproval` (SCRUM-27), on top of main's 128.
    // 129 -> 130: `applications.returnFinanceDisbursementCheque` (SCRUM-239).
    // 130 -> 136: the three SCRUM-693 unwind steps (`dealUnwind.*`; `startDealUnwind` writes only the unwind row) + `financeDealCosts.recordExecutionFeeActual`, `.bindExecutionFeeLine` and `.unbindExecutionFeeLine` (SCRUM-690).
    expect(population).toHaveLength(136);
  });

  test("every entry carries exactly one bucket and a stated mechanism", () => {
    const buckets: Bucket[] = ["IDENTITY_GUARDED", "STATE_GUARDED", "NON_ECONOMIC", "RETIRED"];
    for (const [id, entry] of Object.entries(CLASSIFICATION)) {
      expect(buckets, id).toContain(entry.bucket);
      expect(entry.mechanism.trim().length, id).toBeGreaterThan(20);
    }
  });

  test("every IDENTITY_GUARDED command actually carries identity", () => {
    // The bucket is a claim about the source. A command may satisfy it through
    // runWithIdempotency OR a documented equivalent, so the exceptions are named
    // explicitly rather than the assertion being weakened for everyone.
    const ALTERNATE_MECHANISM = new Set(["vehicles.importBulk"]);
    const liars: string[] = [];
    for (const [id, entry] of Object.entries(CLASSIFICATION)) {
      if (entry.bucket !== "IDENTITY_GUARDED") continue;
      if (ALTERNATE_MECHANISM.has(id)) continue;
      const sym = g.symbols.get(id);
      if (!sym || !hasCommandIdentity(sym.body)) liars.push(id);
    }
    expect(liars).toEqual([]);
  });

  test("no public mutation mints an id and posts without an explicit classification", () => {
    // The safety property, stated as the thing that actually hurts: a command
    // that creates a row and posts an accounting event keyed on that row's fresh
    // id is blind to its own retry. Every such command must be consciously
    // classified — over-inclusion is intended, since a false positive costs one
    // line here and a false negative duplicates money.
    const unclassified: string[] = [];
    for (const id of forward) {
      if (!mintsAndPostsTransitively(g, id)) continue;
      if (!CLASSIFICATION[id]) unclassified.push(id);
    }
    expect(unclassified).toEqual([]);
  });

  test("the SCRUM-57 manifest is a strict subset of this population", () => {
    // Recorded so nobody re-derives safety from the old 31-command manifest.
    const MANIFEST_SAMPLE = [
      "collections.recordPayment", "deposits.release", "paymentIntents.create",
      "financeDealCosts.recordDealFee", "applications.confirmSupplierDisbursement",
    ];
    for (const id of MANIFEST_SAMPLE) expect([...forward], id).toContain(id);
    expect(forward.size).toBeGreaterThan(31);
  });

  test("factory-built reversal and commission hooks keep their real edges and reach a sink (SCRUM-738 N1)", () => {
    // The real `export const hookX = makeY<{ ... Id<"t"> ... }>({` declarations
    // in convex/accounting/workflowHooks.ts. If the declaration-line read or the
    // type-argument pattern regressed, these hooks would lose their only edge.
    const H = "accounting/workflowHooks";
    const hasEdge = (from: string, to: string) => g.edges.get(`${H}.${from}`)?.has(`${H}.${to}`) === true;
    expect(g.symbols.has(`${H}.hookCommissionReversed`)).toBe(true);
    expect(hasEdge("hookCommissionReversed", "makeReversalHook")).toBe(true);
    expect(hasEdge("hookCommissionPaid", "makeCommissionHook")).toBe(true);

    const reachesSink = (start: string): boolean => {
      const seen = new Set([start]);
      const stack = [start];
      while (stack.length) {
        const cur = stack.pop()!;
        if (g.sinks.has(cur)) return true;
        for (const n of g.edges.get(cur) ?? []) {
          if (!seen.has(n)) { seen.add(n); stack.push(n); }
        }
      }
      return false;
    };
    expect(reachesSink(`${H}.hookCommissionPaid`)).toBe(true);
    expect(reachesSink(`${H}.reverseCommissionForSale`)).toBe(true);
  });
});

describe("SCRUM-742 tripwire — call shapes the census cannot see must not appear in convex/", () => {
  // The census builds edges with a regex over comment-stripped text. Two call
  // shapes produce NO edge (see the KNOWN GAP tests above): (a) a generic call
  // with parentheses in its type argument; (b) ANY call or `hook*` reference on a
  // top-level `function` declaration line (parameter default or one-line body).
  // They are unreachable from any money path today; this keeps that true.
  // Measured 2026-10-06 over 262 non-test sources: (a) zero; (b) zero beyond
  // `Date.now()` (which can neither reach a sink nor hide a call to one).
  // Function REFERENCES (`ctx.runMutation(internal.…)`, scheduler) are a separate,
  // untested gap: SCRUM-743.
  // ~80% of the 262 non-test convex sources measured 2026-10-06.
  const FILE_FLOOR = 210;
  // COUPLING: this must match the analyzer's unexported `walk` in
  // scripts/economicCommandCensus.ts (every `.ts` under convex/, skipping
  // `_generated` and `*.test.ts`). It is duplicated rather than imported because
  // exporting `walk` would be an executable change to the analyzer; the file-count
  // floor below catches a narrowed copy.
  const walkSources = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "_generated") walkSources(p, out);
      } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
    }
    return out;
  };

  test("SCRUM-742 tripwire: no uncovered census call shape exists in convex/ sources", () => {
    const offenders: string[] = [];
    const files = walkSources(CONVEX_ROOT);
    // Floor: a walker narrowed by mistake must not pass this test vacuously.
    expect(files.length, "tripwire scanned suspiciously few convex sources").toBeGreaterThanOrEqual(FILE_FLOOR);
    for (const file of files) {
      const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const at = (n: ts.Node) =>
        `${path.relative(CONVEX_ROOT, file).replace(/\\/g, "/")}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
      const startLine = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
      // Top-level `function` declarations are exactly what the analyzer's DECL
      // matches as a `function` line, and the whole line is unread for edges.
      const unreadFunctionLines = sf.statements.filter(ts.isFunctionDeclaration);
      for (const decl of unreadFunctionLines) {
        const declLine = startLine(decl);
        const scanLine = (m: ts.Node): void => {
          if (startLine(m) === declLine) {
            if (ts.isCallExpression(m) && m.expression.getText(sf) !== "Date.now") {
              offenders.push(`(b) call ${m.expression.getText(sf)} on a function declaration line at ${at(m)}`);
            } else if (ts.isIdentifier(m) && m !== decl.name && /^hook[A-Z]/.test(m.text)) {
              // (the declared name itself is the symbol, not a reference to one)
              offenders.push(`(b) ${m.text} on a function declaration line at ${at(m)}`);
            }
          }
          ts.forEachChild(m, scanLine);
        };
        scanLine(decl);
      }
      const visit = (n: ts.Node): void => {
        // (a) a generic call whose type argument contains parentheses.
        if (ts.isCallExpression(n) && n.typeArguments?.some((t) => t.getText(sf).includes("("))) {
          offenders.push(`(a) generic type argument with parentheses at ${at(n)}`);
        }
        // (b') a parameter default containing a call other than `Date.now`, on any
        // function form not already covered by the top-level declaration scan.
        if (
          (ts.isFunctionDeclaration(n) && !unreadFunctionLines.includes(n)) ||
          ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n)
        ) {
          for (const p of n.parameters) {
            if (!p.initializer) continue;
            const scan = (m: ts.Node): void => {
              if (ts.isCallExpression(m) && m.expression.getText(sf) !== "Date.now") {
                offenders.push(`(b') parameter default calling ${m.expression.getText(sf)} at ${at(m)}`);
              }
              ts.forEachChild(m, scan);
            };
            scan(p.initializer);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(
      offenders,
      "uncovered census call shape — see SCRUM-742; run a manual census check or land SCRUM-742",
    ).toEqual([]);
  });
});
