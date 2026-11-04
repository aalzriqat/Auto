# Pilot: server-side block evidence for excluded financial mutations (SCRUM-760 decision B, SCRUM-795)

Decision B (AGENTS.md, "Pilot release gate"): every excluded or uncertified financial mutation is blocked
**server-side** (hiding it in the UI is not a block) and cannot corrupt financial state. This file is the
class table for that evidence: each excluded public Convex mutation, the exact guard, the refusal code, and the
test that calls the public door and asserts a coded refusal with nothing written.

## Evidence boundary

- **What this is.** A static map of `origin/main` at 30a6429e3 (2026-11-04) from `convex/**/*.ts`: every
  `export const … = mutation(` (404 found), narrowed by hand to the doors that move money or financial state, then
  joined to the guard call sites and to the test files that call the public door and name the refusal code.
- **What ran.** Only `convex/pilotBlockedDoors.scrum795.test.ts` (new, this change) and the suites listed under
  "Executed" below were run here, serially (`--maxWorkers=1`), on `convex-test`. Every other test is cited, not
  re-run here.
- **What it is not.** Not browser, cloud or production evidence. The production read-back of each refusal is
  owed under SCRUM-760 task A3 / SCRUM-762 and is **not** claimed. Switches stay as shipped; nothing is enabled.
- The map is not a proof that no other door exists. The unclassified doors at the end are the ones this sweep
  could not place under any ruling.

## How a block is built

A pilot block is a compile-time constant (never an env var, org setting or database flag) read by a guard that runs
after tenant authentication and **before any read or write** (and before `runWithIdempotency`, so a stored replay is
refused too). Refusals are `AppErrorCode`s with static text ending "Nothing has been changed." and an Arabic
`ServerError_<code>` entry in `lib/i18n/domains/common.ts`.

## Class table: excluded doors

`T` = test calls the public mutation and asserts the code. `0W` = same test compares full table content (and where
stated the scheduler) before and after, so a refusal that patched a row would fail.

### 1. Customer-credit payout (`CUSTOMER_CREDIT_PAYOUT_PILOT_DISABLED = true`, `customerCreditPayoutContainment.ts`)

Code `CUSTOMER_CREDIT_PAYOUT_DISABLED`. Guard `assertCustomerCreditPayoutAllowed()`.

| Door | Guard site | Test (public door, refusal, no write) |
| --- | --- | --- |
| `retainedCreditRefunds.requestRetainedCreditRefund` | `retainedCreditRefunds.ts:98` | **new** `pilotBlockedDoors.scrum795.test.ts` (shipped switch, T+0W+EN/AR); `chequeCancelledSaleCredit.test.ts` P1 (mocked switch, also proves the open state) |
| `retainedCreditRefunds.respondToRetainedCreditRefund` (APPROVED; REJECTED stays as an exit) | `:140` | same two |
| `retainedCreditRefunds.executeRetainedCreditRefund` | `:198` | same two; CASH method stays refused with the switch off (P2, `CUSTOMER_CREDIT_CASH_PAYOUT_UNSUPPORTED`) |
| `dealUnwind.finishDealUnwind` (any customer refund field or REFUND disposition) | `dealUnwind.ts:656` | `dealUnwind.test.ts` (real-switch pin at the end of the file); `scrum486Certification.test.ts` cell; record `unwind-refuses-every-customer-credit-payout-request-with-nothing-changed` |
| `sales.update` (cancel path that would pay credit out) | `sales.ts:1264` | `accountingReceiptMovement.test.ts`, `chequeCancelledSaleCredit.test.ts`, `scrum486Certification.test.ts` |
| cancel / teardown disposition `REFUND` (`invoiceReceiptDisposition`) | `accounting/invoiceReceiptDisposition.ts:55` | reached through `applications.cancelApplication` / `sales.update`; same suites |
| `retainedCreditRefunds.cancelRetainedCreditRefund` | none, by design | an exit: it only marks a request CANCELLED and moves no money |

### 2. Sale-invoice receipt application (`SALE_INVOICE_RECEIPT_DOORS_PILOT_DISABLED = true`)

Code `SALE_INVOICE_RECEIPT_DOORS_DISABLED`. Guard `assertSaleInvoiceReceiptDoorsAllowed()`. Unlinked customer receipts
and cheques are separately refused while a cash sale invoice is open (SCRUM-802,
`UNLINKED_RECEIPT_OPEN_SALE_INVOICE_REFUSED`).

| Door | Guard site | Test |
| --- | --- | --- |
| `collections.registerSaleInvoiceCheque` | `collections.ts:1208` | **new** file (T+0W+EN/AR); `chequeCancelledSaleCredit.test.ts` P3 (mocked); `scrum802CashSaleContainment.test.ts` |
| `collections.reserveSaleInvoiceReceipt` | `:1245` | **new** file; `chequeCancelledSaleCredit.test.ts` P3 |
| `collections.activateSaleInvoiceReceipt` | `:1284` | **new** file; `chequeCancelledSaleCredit.test.ts` P3 |
| `collections.recordPayment` with `invoiceSaleId` | `:1664` | **new** file; `scrum802CashSaleContainment.test.ts`; `scrum761CashReceiptDoors.test.ts` (sale-bound receipt, `SALE_DEBT_RECEIPT_REFUSED`) |
| `collections.createReceivable`, `applyRetainedCredit`, `registerCheque`/`replaceCheque` aimed at a sale | `saleDebtContainment.ts` (`assertSourceIsNotSaleDebt`, `assertReceiptTargetNotSaleLinked`, …) | `scrum571s1Containment.test.ts`, `scrum571ReceiptContainment.test.ts`, `scrum802CashSaleContainment.test.ts` |

The unmocked file also pins that both shipped constants are `true`; before this change that pin existed for the
receipt switch (`utils/customerCreditPayoutContainment.test.ts`) and, for the payout switch, only inside
`dealUnwind.test.ts`.

### 3. Manual journals (`MANUAL_JOURNALS_PILOT_DISABLED = true`, `pilotSwitches.ts`)

| Door | Guard | Test |
| --- | --- | --- |
| `financialAudit.createManualJournal` | `assertManualJournalsEnabled()` (`financialAudit.ts:357`) | `manualJournalsPilotOff.scrum795.test.ts` (T+0W); records `manual-journal-*` |
| `financialAudit.approveManualJournal` | `:447` | same file; legacy pending draft stays rejectable (control) |

### 4. RT11 doors (`RT11_DOORS_PILOT_DISABLED`, `rt11DoorContainment.ts`, owner ruling SCRUM-760#c23862)

All tested in `rt11DoorContainment.test.ts` with no mocks, full-table + scheduler snapshot, EN/AR text, and an
allowed control for the neighbouring path (T+0W).

| Door | Code |
| --- | --- |
| `financeDealCosts.recordCustodyMovement` (finalized REVERSAL / REIMBURSED) | `CUSTODY_FINALIZED_MOVEMENT_PILOT_DISABLED` |
| `financeDealCosts.reconcileDealCustody` (shortage write-off) | `CUSTODY_WRITEOFF_PILOT_DISABLED` |
| `financeDealCosts.migrateLegacyCustodyToLedger` | `CUSTODY_MIGRATION_PILOT_DISABLED` |
| `financeDealCosts.reopenDealCustody` | `CUSTODY_REOPEN_PILOT_DISABLED` |
| `financingEconomics.recordManualFinanceApproval` | `MANUAL_FINANCE_APPROVAL_PILOT_DISABLED` |
| `applications.correctExpectedPayment` (after payout) | `EXPECTED_PAYMENT_PAID_PILOT_DISABLED` |
| `applications.amendSupplierDisbursementAdvice` | `SUPPLIER_ADVICE_AMENDMENT_PILOT_DISABLED` |
| `sales.markCommissionPaid` (direct payout; payroll stays) | `DIRECT_COMMISSION_PAYOUT_PILOT_DISABLED` |
| `vehicles.update` (ownership change) | `VEHICLE_OWNERSHIP_CHANGE_PILOT_DISABLED` |
| `vehicles.upsertLandedCosts` (edit / remove / move paid cost) | `PAID_LANDED_COST_CHANGE_PILOT_DISABLED` |

### 5. Supplier settlement (`supplierSettlementContainment.ts`, SCRUM-869#c23881)

| Door | Guard / code | Test |
| --- | --- | --- |
| `supplierCostRecoveries.reverseReceipt` | `SUPPLIER_RECEIPT_REVERSAL_PILOT_DISABLED` | `supplierSettlementContainment.test.ts` |
| `vehicles.correctAcquisitionCost` (unpaid ON_ACCOUNT payable branch) | `SUPPLIER_PAYABLE_CORRECTION_PILOT_DISABLED` | `supplierObligationCorrections.test.ts`, `supplierRefusalTexts.scrum869.test.ts` |
| `expenses.reverseExpense` (supplier owes it) | `SUPPLIER_COST_EXPENSE_REVERSAL_PILOT_DISABLED` | `supplierObligationCorrections.test.ts` |
| `sourcingPayables.markPaid`, `recordPartialPayment`, `supplierReceivables.recordReceipt` (method other than CASH / BANK_TRANSFER) | `assertSupplierSettlementMethodAllowed` → `SUPPLIER_PAYMENT_METHOD_PILOT_UNSUPPORTED` / `SUPPLIER_RECEIPT_METHOD_PILOT_UNSUPPORTED` | `supplierSettlementContainment.test.ts` |

### 6. Other switches

| Family | Door(s) | Guard | Test |
| --- | --- | --- | --- |
| Fixed assets (`FIXED_ASSET_LIFECYCLE_PILOT_DISABLED`) | `fixedAssets.capitalize/update/remove/impair/dispose`, `accountingMigration.backfillFixedAssetMinorUnits`, posting engine, cron | `assertFixedAssetLifecycleAllowed` → `FIXED_ASSET_LIFECYCLE_DISABLED` | `fixedAssetLifecycleContainment.scrum560.test.ts` (T+0W, queued-outbox and cron paths) |
| Legacy collection refund (`LEGACY_COLLECTION_REFUND_PILOT_DISABLED`) | `collections.requestApproval` / `respondToApproval` (REFUND), `accountingLedger.post`, `subledger.recordPayment` (OUT to a customer), `subledger.reverseAllocationMutation` (internal doors), workflow hook | `assertLegacyCollectionRefundAllowed` | `legacyCollectionRefundContainment.test.ts` |
| Cleared-cheque return (`CLEARED_CHEQUE_RETURN_PILOT_DISABLED`) | `collections.returnClearedCheque` | `assertClearedChequeReturnAllowed` | `postDeliveryDoorContainment.test.ts` |
| Partner profit distribution (`PARTNER_PROFIT_DISTRIBUTION_PILOT_DISABLED`) | `partnerEquity.recordEquityMovement` (type PROFIT_DISTRIBUTION) | inline switch + `PARTNER_PROFIT_DISTRIBUTION_UNAVAILABLE` | `partnerDistributionPilot.test.ts` |
| Payment links (`PAYMENT_LINKS_PILOT_DISABLED`, `lib/pilotCapabilities.ts`) | `paymentIntents.create`, `markSettled`, `resolveUnmatchedProviderFunds`, webhook settle (held, not posted) | `refuseSaleDebt("PAYMENT_LINKS_DISABLED")` | `scrum571ReceiptContainment.test.ts`, `scrum571s1Containment.test.ts`, `scrum571HeldIdentityDoors.test.ts`, `scrum571UnmatchedProviderFunds.test.ts` |
| Deposit OTHER treatment (`DEPOSIT_OTHER_TREATMENT_PILOT_DISABLED`) | `sales.create`, `sales.completeFromQuote`, `applications.finalizeDeal`, `deposits.resolveReleasedAllocation` | `refuseDepositOtherTreatment` | `consignedDepositResolution.test.ts`, `multiVehicleDepositAllocation.test.ts`, `scrum411*` suites |
| CASH sale extras / pay-first (`CASH_SALE_EXTRAS_PILOT_REFUSED`, `CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED`) | every CASH completion door | `saleDebtContainment.ts`, `cashSalePilotGate.ts` | `scrum802CashSale*.test.ts` |
| Retired legacy ledger writes | `transactions.add/update/remove` | `refuseLegacyLedgerWrite` | `transactionsLegacyWriteContainment.test.ts` |
| Opening-balance data refusals (SCRUM-858) — the doors stay enabled, only these inputs are refused | `accountingCutover.draftOpeningBalance/approveOpeningBalance/postOpeningBalanceDirect` | `refuseOpeningAfterLedgerActivity`, `refuseOpeningDepositDirectPost`, opening-deposit payout/reversal refusals | `openingNamedDeposits.scrum858.test.ts`; other cutover suites not individually verified here |
| Salesperson cash receipts (SCRUM-795 item 3) | `deposits.create`, `depositRequests.confirm`, `deposits.allocateToVehicles`, `releaseVehicleAllocation`, `resolveReleasedAllocation` | permission removed from the default SALES template | `depositRequests.test.ts`; records `sales-member-*` (`vehicles.createReservation` SALES half is still an open gap, see `regression/PILOT-PATH.md`) |
| Deal commission lines | `dealCommissions.addLine/removeLine` | `DEAL_COMMISSION_LINES_PILOT_DISABLED = false` (**enabled**, not a block) | `dealCommissionsPilot.test.ts` |

## Doors that stay enabled for CASH / configured FINANCED / SOURCED through delivery

Not blocks, listed so the table is not read as the whole money surface: `quotes.saveQuote`,
`applications.createFromQuote/updateStatus/registerExpectedPayment/finalizeDeal/confirmDisbursement/
registerVehicleHandover/cancelApplication`, `sales.create/createDraft/completeFromQuote/update`, `deposits.create/
allocateToVehicles/release`, `financeCompanyForward.*`, `financingEconomics.approveDealerPurchaseAmount/…`,
`sourcingPayables.markPaid/recordPartialPayment` and `supplierReceivables.recordReceipt` (CASH, BANK_TRANSFER only),
`vehicles.create/update/upsertLandedCosts` (additions), `expenses.create`, `financeDealCosts` fee and custody
recording before finalization. Commission payout is through payroll (the direct payout door is blocked above; the
payroll doors themselves are listed as unclassified below). Certification of these is the SCRUM-486 oracle
(`docs/architecture/scrum486-certification-oracle.md`), not this file.

## Unclassified money-moving doors (no ruling places them; owner decision, not guarded here)

No switch, and no ruling in the pilot scope excludes or certifies these. They are outside the CASH / FINANCED /
SOURCED deal path but reachable by a role with the permission. They are listed rather than guarded, because
adding a guard would switch off a function (and, per SCRUM-810, would need a matching UI capability flag).

- `dealUnwind.startDealUnwind`, `dealUnwind.recordDealUnwindForwardReturn`, and the financier-remittance leg of
  `dealUnwind.finishDealUnwind`. Only the customer-payout half is switched off; the unwind itself is wired in
  `DealCockpit`. Decision B lists "refund or unwind" as deferred, so whether the financier legs are in or out
  needs a ruling.
- `payroll.setCompensation/recordAdvance/recoverAdvance/createRun/cancelRun/approveRun/payRun`.
- `bankReconciliation.uploadStatementLines/confirmMatch/ignoreLine`, `bankAccounts.create/update/deactivate`,
  `cashDrawer.recordMovement`, `collections.createInstallmentPlan`, `collections.returnCheque` (uncleared),
  `collections.reviewCashierReconciliation`.
- `partnerEquity.add/remove`, `prepaidExpenses.*`, `accountingPeriods.reopen`, `openingManagementSettlement.approve/reject`,
  `sales.markCommissionUnpaid` (refuses when paid; clears nothing else).

## Executed in this change

Run on `claude/scrum795-server-blocks-evidence` (base `origin/main` 30a6429e3), serial, 2026-11-04:

- `npx vitest run convex/pilotBlockedDoors.scrum795.test.ts --maxWorkers=1`: 8 of 8 pass.
- Guard-removal mutants, one per door: with the guard call commented out, exactly the matching test fails
  and the other seven pass (`retainedCreditRefunds.ts` request, approve and execute; `collections.ts`
  `registerSaleInvoiceCheque`, `reserveSaleInvoiceReceipt`, `activateSaleInvoiceReceipt` and the
  `recordPayment` `invoiceSaleId` branch). 7 of 7 killed. Each file was restored with `git checkout --` and
  the tree showed only the new files afterwards.
- The existing refusal suites cited above (`rt11DoorContainment`, `supplierSettlementContainment`,
  `fixedAssetLifecycleContainment.scrum560`, `legacyCollectionRefundContainment`,
  `postDeliveryDoorContainment`, `manualJournalsPilotOff.scrum795`, `manualJournalsPilotOffControl.scrum795`,
  `partnerDistributionPilot`, `transactionsLegacyWriteContainment`, `chequeCancelledSaleCredit`) together with
  the new file: 11 files, 187 tests, all pass.
- `pnpm test:regression-library`: 62 of 62 pass with the seven new records loaded.

Nothing here ran against a real backend, a browser or production. Each new refusal test is bound to a SCRUM-761 record under
`regression/scenarios/money/shipped-*.scenario.json` (matrix label `SCRUM-760-DECISION-B-BLOCKED-DOORS`, a
descriptive label, not a joined SCRUM-486 row id).
