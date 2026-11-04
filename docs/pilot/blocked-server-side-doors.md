# Pilot: server-side block evidence for excluded financial mutations (SCRUM-760 decision B, SCRUM-795)

Decision B (AGENTS.md, "Pilot release gate"): every excluded or uncertified financial mutation is blocked
**server-side** (hiding it in the UI is not a block) and cannot corrupt financial state. This file is the
class table for that evidence: each excluded public Convex mutation, the exact guard, the refusal code, and the
test that calls the public door and asserts a coded refusal with nothing written.

## Evidence boundary

- **What this is.** A static map of the code at `origin/main` 440bd99b6 (2026-11-04), the merge base of this branch.
  The inventory lists all 404 `export const … = mutation(` in `convex/**/*.ts`
  ([`blocked-server-side-doors.inventory.json`](blocked-server-side-doors.inventory.json)). Each door has exactly one
  class, and `scripts/regression/pilotDoorInventory.test.ts` fails when a public mutation is missing, listed twice
  or no longer exists. Regenerate the list with that test's scan, not by hand.
- **What the inventory test proves.** The list is complete, each cited guard symbol exists in its file, each cited
  test file calls the door through `api.<module>.<function>` and contains the refusal code, each certified door is
  called in its certification test, and no door classed non-financial touches a ledger, cash or subledger table.
  It does not prove that a guard runs before a read, or that a refusal test fails without its guard.
- **What ran.** `convex/pilotBlockedDoors.scrum795.test.ts` (new), `scripts/regression/pilotDoorInventory.test.ts`
  (new), `scripts/regression/scenarioRecord.test.ts` and the suites under "Executed", serially
  (`--maxWorkers=1`), on `convex-test`. Every other test is cited, not re-run here.
- **What it is not.** Not browser, cloud or production evidence. The production read-back of each refusal is
  owed under SCRUM-760 task A3 / SCRUM-762 and is **not** claimed. Switches stay as shipped; nothing is enabled.
- **No policy is decided here.** A door classed UNCLASSIFIED is one that no ruling places. It stays as it is and
  needs an owner ruling, whatever it looks like.

## Inventory: 404 public mutations

EXCLUDED_GUARDED 30 · ENABLED_CERTIFIED 38 · UNCLASSIFIED 140 · NON_FINANCIAL 196.

| Class | Meaning | Evidence per door |
| --- | --- | --- |
| EXCLUDED_GUARDED | A pilot containment refuses it, or the part of it that moves excluded money | Guard symbol and file, refusal code, the test that calls the door |
| ENABLED_CERTIFIED | In pilot scope and a cell of the SCRUM-486 oracle covers it | The certification test and the row title or oracle section |
| UNCLASSIFIED | Moves or can move money, and no ruling places it | One line on what it does to money, `ruling: "owner ruling needed"` |
| NON_FINANCIAL | Writes no ledger, cash or subledger table and calls no posting helper | A reason; the inventory test checks the door body |

A door with a partial block (for example `sales.update`, `vehicles.update`, `collections.recordPayment`) has a
`blocks` entry whatever its class. For `recordPayment` the class is UNCLASSIFIED because only the sale-invoice
branch is blocked. Read the per-door entries in the inventory file; the tables below are the summary of the
excluded families.

## How a block is built

A pilot block is a compile-time constant (never an env var, org setting or database flag) read by a guard call
inside the mutation handler, after tenant authentication. Refusals are `AppErrorCode`s with static text ending
"Nothing has been changed." and an Arabic `ServerError_<code>` entry in `lib/i18n/domains/common.ts`.

Where the guard sits is read from the cited lines, not proven by the tests:

- The three payout doors and the three sale-invoice receipt doors call the guard as the first statement after
  `requireTenantAuth`, before any `db` read and before `runWithIdempotency`.
- `collections.recordPayment` validates the payment date and runs `assertOpeningReceivableDate` (a read of the
  receivable) first. Its sale-invoice branch is refused at `collections.ts:1664`, before `runWithIdempotency`
  and before any write.
- `dealUnwind.finishDealUnwind` loads the unwind and runs `assertFinishable` (reads) first. The payout guard at
  `dealUnwind.ts:656` runs before the first write of the handler body.

## Class table: excluded doors

`T` = the test calls the public mutation and asserts the coded refusal. `0W` = the same test compares full table
content (and where stated the scheduler) before and after, so a refusal that committed a row would fail. `0W`
proves that nothing was committed. It does not prove at which point the refusal was thrown.

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

## The deal unwind: enabled, with the payout branch blocked (finding B)

Owner decision B ("narrow pilot gate", SCRUM-760, 2026-10-19) puts the unwind of a financed deal in the pilot
scope. The oracle (`docs/architecture/scrum486-certification-oracle.md`, line 256) states the enabled scope:
the unwind (`startDealUnwind`, `recordDealUnwindForwardReturn`, `finishDealUnwind`, `abandonDealUnwind`) of a
financed deal finished with zero-credit dispositions, and "Unwind and cost correction are enabled, not deferred".
The oracle's own wording holds the precise text; this file does not restate it as a ruling.

So the classes are:

- `startDealUnwind`, `recordDealUnwindForwardReturn`, `abandonDealUnwind` and `finishDealUnwind`: ENABLED_CERTIFIED,
  with oracle rows U-RET, U-ABANDON and U-SOURCED (and CC-CASH, CC-AP, CC-RESTATE, CC-SOURCED for cost correction).
  The financier unwind legs are enabled and are not blocked here.
- The customer-credit payout branch of `finishDealUnwind` is blocked (section 1) and is oracle row U-REFUND, an
  expected-refusal cell. The `finishDealUnwind` entry carries both the certification and that block.
- `customerPaymentDisposition: "REFUND"` with zero active customer credit is permitted: the guard at
  `dealUnwind.ts:656` is reached only when a payout field is given or the invoice plan's `totalMinor` is above zero.

## Doors that stay enabled

The doors the pilot keeps on are the ENABLED_CERTIFIED entries of the inventory, each with the certification
test that calls it. This file lists no door by wildcard. Two entries carry a limit that is easy to miss:
`collections.registerCheque` and `collections.clearCheque` are certified only as the financier cheque receipt. A
customer cheque is not a certification row, so the plain customer cheque path is not claimed as certified. The
direct commission payout door is blocked (section 4); commission payout runs through payroll, and the payroll
doors are UNCLASSIFIED.

## Unclassified money-moving doors (owner ruling needed, nothing guarded here)

The inventory lists 140 UNCLASSIFIED doors, each with a one-line effect on money. No switch and no ruling places
them. They are listed, not guarded, because guarding one would switch off a function and, per SCRUM-810, would
need a matching UI capability flag. These are the ones that look like a deferred correction or refund, or that a
review named:

| Door | What it does to money |
| --- | --- |
| `deposits.voidDeposit` | Voids a held customer deposit and reverses the receipt, so the money leaves the customer's balance. |
| `financeCompanyForward.reverseFinanceCompanyForward` | Takes back a forward payment recorded to the finance company before the transfer is confirmed. |
| `financeCompanyForward.reportFinanceCompanyForwardReturned` | Reverses a forward on the books after the finance company returned the money. |
| `partnerEquity.recordEquityMovement` | Records a partner CONTRIBUTION or DRAW (money in or out of the business). PROFIT_DISTRIBUTION is refused (section 6). |
| `cashDrawer.approveVariance` | Approves a drawer variance and writes the cash movement that deposits the counted cash to the bank. |
| `cashDrawer.close` | Submits the physical count and computes the variance. |
| `collections.depositCheque` | Marks a post-dated cheque deposited at the bank. |
| `collections.submitCashierReconciliation` | Submits a cashier's daily reconciliation. Ruling SCRUM-795#c22479 Q2 makes SCRUM-396 a prerequisite before relying on it. |
| `collections.recordPayment` | Records a customer payment on a receivable and enqueues its receipt posting. Only the `invoiceSaleId` branch is blocked (section 2). |
| `accountingOutbox.redrive`, `accountingOutbox.retryFailed` | Re-drive or re-queue posting events so that held or failed journals post. |
| `accountingMigration.backfillVehicleInventoryOpeningBalances` | Posts opening vehicle-inventory journals for cars that have none. |
| `sales.recalculateCommission` | Recomputes a sale's commission from the frozen basis. |
| `sales.completeDraft` | Completes a draft sale and posts revenue and receivable. Its deposit-OTHER branch is blocked (section 6). |
| `sales.softDelete` | Soft-deletes a sale. |

`applications.returnFinanceDisbursementCheque` is not in this list. The coordinator's note suggested it as a
deferred correction. The oracle section "SCRUM-760 finance-company cheque return cells" records that the owner
declined the block on 2026-10-19 and keeps the door on, so it is ENABLED_CERTIFIED with four cells.

The five retired `claims` writers (`CLAIMS_RETIRED`, `claimsRetirement.test.ts`) and
`accountingMigration.migrateUnpostedTransactions` are EXCLUDED_GUARDED: each throws unconditionally. The migration
door uses plain retired-text `ConvexError` with no `AppErrorCode`; the inventory records that in the `code` field
instead of inventing a code.

Limit of the unwind certification citations: for `startDealUnwind`, `recordDealUnwindForwardReturn` and
`finishDealUnwind` the inventory names the first test that calls the door in `scrum486Certification.test.ts`,
because those calls sit in a shared helper. The rows that exercise them are U-RET, U-ABANDON and U-SOURCED in the
oracle; the inventory test confirms the door is called in that file, not which row asserts what.

## Executed in this change

Run on `claude/scrum795-server-blocks-evidence` (merge base `origin/main` 440bd99b6), serial, 2026-11-04:

- `npx vitest run convex/pilotBlockedDoors.scrum795.test.ts --maxWorkers=1`: 8 of 8 pass.
- Guard-removal mutants, one per door: with the guard call commented out, exactly the matching test fails
  and the other seven pass (`retainedCreditRefunds.ts` request, approve and execute; `collections.ts`
  `registerSaleInvoiceCheque`, `reserveSaleInvoiceReceipt`, `activateSaleInvoiceReceipt` and the
  `recordPayment` `invoiceSaleId` branch). 7 of 7 killed. These were the round 1 runs, restored with
  `git checkout --`. The round 2 runs below restore by file copy.
- Guard-position mutants (round 2). `registerSaleInvoiceCheque` and `reserveSaleInvoiceReceipt` are now called
  with a sale id that names no row. Control 8 of 8. Mutant 1 moves the guard in `registerSaleInvoiceCheque` below
  `requireOwnedRow`: 1 failed, 7 passed (the cheque test). Mutant 2 does the same in `reserveSaleInvoiceReceipt`:
  1 failed, 7 passed (the reserve test). `collections.ts` was restored by file copy after each, the tree showed
  no change to it, and the control was 8 of 8 again. Denominator: `convex/pilotBlockedDoors.scrum795.test.ts`,
  8 tests, 2 mutants. The payout doors, `activateSaleInvoiceReceipt` and `recordPayment` were not mutated this
  round: their guard position is read from the cited lines (see "How a block is built").
- The existing refusal suites cited above (`rt11DoorContainment`, `supplierSettlementContainment`,
  `fixedAssetLifecycleContainment.scrum560`, `legacyCollectionRefundContainment`,
  `postDeliveryDoorContainment`, `manualJournalsPilotOff.scrum795`, `manualJournalsPilotOffControl.scrum795`,
  `partnerDistributionPilot`, `transactionsLegacyWriteContainment`, `chequeCancelledSaleCredit`) together with
  the new file: 11 files, 187 tests, all pass.
- `pnpm test:regression-library`: 62 of 62 pass with the seven new records loaded.

Nothing here ran against a real backend, a browser or production. Each new refusal test is bound to a SCRUM-761 record under
`regression/scenarios/money/shipped-*.scenario.json`. The records' `matrixRow` is
`SCRUM-760-DECISION-B-BLOCKED-DOORS`, the section of the SCRUM-486 oracle that holds the seven expected-refusal
rows; `pilotDoorInventory.test.ts` checks that each row's test title and refusal code exist in the test file.
The payout records cite SCRUM-795#c22479, SCRUM-795#c23829 and SCRUM-760#description. The receipt records cite
SCRUM-795#c23829 and SCRUM-760#description. Caveat: the stored digests of c22479 and c23829 were computed from the
Jira MCP markdown rendering of the comment with escaped brackets restored, so a digest taken from the raw comment
body could differ. The earlier c22485 (deposit OTHER) binding was wrong for these doors and is removed.
