# Pilot: server-side block evidence for excluded financial mutations (SCRUM-760 decision B, SCRUM-795)

Decision B (AGENTS.md, "Pilot release gate"): every excluded or uncertified financial mutation is blocked
**server-side** (hiding it in the UI is not a block) and cannot corrupt financial state. This file is the
class table for that evidence: each excluded public Convex mutation, the exact guard, the refusal code, and the
test that calls the public door and asserts a coded refusal with nothing written.

## Evidence boundary

- **What this is.** A map of the code at baseline `66888d0a2f87753ba3a20b3677485ec2aea39793`, with the inventory corrections below (2026-11-04).
  The inventory lists all 408 registered public mutations exported by `convex/**/*.ts`
  ([`blocked-server-side-doors.inventory.json`](blocked-server-side-doors.inventory.json)). Each door has exactly one
  class, and `scripts/regression/pilotDoorInventory.test.ts` fails when a public mutation is missing, listed twice
  or no longer exists. Regenerate the list with that test's scan, not by hand.
- **What the inventory test proves.** The list is complete, each cited guard symbol exists in its file, each cited
  test file calls the door through `api.<module>.<function>` and contains the refusal code, each certified door is
  called within its cited test body or a helper that body reaches, and the NON_FINANCIAL entries pass the financial-effect scan described below.
  It does not prove that a guard runs before a read, or that a refusal test fails without its guard.
- **What ran.** `convex/pilotBlockedDoors.scrum795.test.ts` (new), `scripts/regression/pilotDoorInventory.test.ts`
  (new), `scripts/regression/scenarioRecord.test.ts` and the suites under "Executed", serially
  (`--maxWorkers=1`), on `convex-test`. Every other test is cited, not re-run here.
- **What it is not.** Not browser, cloud or production evidence. The production read-back of each refusal is
  owed under SCRUM-760 task A3 / SCRUM-762 and is **not** claimed. Switches stay as shipped; nothing is enabled.
- **No policy is decided here.** A door classed UNCLASSIFIED is one that no ruling places. It stays as it is and
  needs an owner ruling, whatever it looks like.

## Inventory: 408 public mutations

EXCLUDED_GUARDED 30 · ENABLED_CERTIFIED 35 · UNCLASSIFIED 173 · NON_FINANCIAL 170.

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

The 35 ENABLED_CERTIFIED entries each cite a certification test row. This file lists no door by wildcard.
`collections.registerCheque` and `collections.clearCheque` are UNCLASSIFIED. Their calls in U-REFUND's
`addActiveCustomerCredit` helper only prepare customer credit for the unwind payout-refusal test. The oracle
does not certify their registration or clearing contracts. `bankAccounts.setReconciliationTarget` is
NON_FINANCIAL: it changes configuration flags, and passes the financial-effect scan. Its U-RET setup call
is not a certification cell. The direct commission payout door is blocked
(section 4); commission payout runs through payroll, and the payroll doors are UNCLASSIFIED.

## Unclassified money-moving doors (owner ruling needed, nothing guarded here)

The inventory lists 170 UNCLASSIFIED doors, each with a one-line effect or a reason the static check refuses NON_FINANCIAL evidence. No switch and no ruling places
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
| `collections.registerCheque`, `collections.clearCheque` | Register cheque custody and clear a customer cheque into a collection payment and receipt posting. Their U-REFUND setup calls do not certify these contracts. |
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

The three unwind doors cite the U-RET `test.each` title that exercises start, forward return and finish.
The inventory check parses that specific test body and follows helper bindings with the TypeScript compiler.
A call in another test, an unused closure, a skipped row or a duplicate title cannot supply that citation.
This proves static reachability inside the cited row, not that every branch ran or that the row fully certifies
all behavior of a door.

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

## Review-seat corrections at baseline 7fb3c521 (2026-11-04)

F1, F2 and F3 were reproduced before the fixes. With HEAD still at the full baseline SHA above,
`pnpm exec vitest run scripts/regression/pilotDoorInventory.test.ts --maxWorkers=1 -t 'negative control'`
failed all three new controls: acquisition posting returned non-financial, the wrapped social mutation was
absent, and the unrelated test row was accepted. Seven unselected tests were skipped by that focused run.

The census imports the function modules and reads Convex's `isMutation` and `isPublic`
markers. It excludes generated code, test files, declaration files and the two platform configuration files
(`auth.config.ts` and `convex.config.ts`). An import error or unresolved handler fails the scan. There is no
source-spelling fallback. `socialInbox.setConversationVehicle` is now NON_FINANCIAL: it links social events and
the lead to a vehicle, then maintains conversation aggregates.

The financial-effect scan follows real helper declarations and imported/local aliases with the TypeScript
checker. It rejects any `post*` call, ledger/subledger writes, and numeric monetary-field writes, including
fields supplied by typed patches. Opaque any/unknown payloads and open numeric/unknown index signatures also
refuse NON_FINANCIAL evidence. It ignores comments and quoted examples. Timestamp and payment-type labels
are not amounts. This is a conservative static check: broad patch types and a chat helper named `post*` can
refuse NON_FINANCIAL evidence without proving that money moves. It is not runtime proof of the absence of
financial effects.

All 196 original NON_FINANCIAL entries were scanned. These 27 move to UNCLASSIFIED. No guard or switch changed.

| Door | Reason |
| --- | --- |
| `vehicleEdits.resolve` | Calls `postVehicleAcquisitionIfOwned` on approved creation and acquisition-affecting updates, posting VEHICLE_ACQUIRED against cash, bank or supplier payable. No certification row covers it. |
| `approvals.requestProfitApproval` | Writes requested/minimum profit and sale/list price approval amounts. |
| `finance.createCompany`, `finance.updateCompany` | Write financier profit, insurance and fee pricing rules. |
| `finance.saveValuation` | Writes a vehicle valuation amount used in financier pricing. |
| `marketplaceListings.createListing`, `marketplaceListings.updateListing` | Write the advertised vehicle price. |
| `marketplaceListings.adminSetListingStatus` | Its patch is typed to permit price fields. The scan conservatively refuses NON_FINANCIAL evidence; this does not prove the status change edits a price. |
| `marketplaceResponses.respond` | Writes a vehicle offer price and financing offer. |
| `marketplaceTradeIns.makeOffer` | Writes a trade-in offer amount. |
| `smartReply.setSmartReplyConfig` | Writes the default down-payment percentage for financing estimates. |
| `websites.searchDomain` | Writes a registrar domain-price quote to its search log. |
| `liveChat.acceptOffer`, `liveChat.claimThread` | Call `postAgentJoinedNotice`. The broad posting-name check refuses NON_FINANCIAL evidence; these notices are not claimed to post journals. |

The remaining 13 have open-ended `Record<string, unknown>` or `Record<string, any>` write payloads.
The check cannot prove which fields they write from those types. These are conservative evidence refusals,
not claims that each operation moves money:

| Door | Opaque patch contents |
| --- | --- |
| `customers.update` | customer profile and financial data. |
| `feedback.adminSetStatus` | feedback status. |
| `feedback.setStatus` | feedback status. |
| `guarantors.update` | guarantor details. |
| `leads.update` | lead details. |
| `orgCustomFields.update` | custom-field definitions. |
| `orgCustomerStatuses.update` | customer-status definitions. |
| `orgLeadSources.update` | lead-source definitions. |
| `orgPipelineStages.update` | pipeline-stage definitions. |
| `orgValuationCompanies.update` | valuation-company definitions. |
| `roles.update` | role details and permissions. |
| `users.updateMyNotificationProfile` | notification profile details. |
| `websites.saveDraft` | website draft settings. |

No certification row in this inventory covers these doors. The two vehicle-edit request doors now say that
applying their pending request requires `vehicleEdits.resolve`; they no longer claim delegation to `vehicles.update`.

The earlier row-specific scan corrected 13 citations. The round-4 correction below removes three fixture-only
certification claims, leaving 35 ENABLED_CERTIFIED entries:

- `startDealUnwind`, `recordDealUnwindForwardReturn`, `finishDealUnwind`, `vehicles.create`, `vehicles.update`,
  and `sales.setCommissionAmount` cite U-RET, including its helpers. `bankAccounts.setReconciliationTarget`
  now has a NON_FINANCIAL reason instead of a U-RET citation.
- `applications.setSupplierSettlementRoute` cites the SOURCED configured-financier opening row.
- `sales.create` cites the owned CASH full-deposit completion row.
- `collections.registerCheque` and `collections.clearCheque` are now UNCLASSIFIED with `owner ruling needed`.
- `sourcingPayables.markPaid` now names its payable-settlement test in addition to the oracle section.
- `supplierCostRecoveries.recordReceipt` now names its allowed-receipt test in addition to the oracle section.

Material design sources: [Convex registered mutations](https://docs.convex.dev/api/modules/server#registeredmutation),
[Convex function visibility](https://docs.convex.dev/functions/internal-functions), and the
[TypeScript compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API).

### Validation of the review-seat corrections

- `pnpm exec vitest run scripts/regression/pilotDoorAnalysis.test.ts scripts/regression/pilotDoorInventory.test.ts scripts/regression/scenarioRecord.test.ts convex/pilotBlockedDoors.scrum795.test.ts convex/scrum486Certification.test.ts convex/accountingVehicleInventory.test.ts convex/supplierSettlementContainment.test.ts --maxWorkers=1`: **340 passed**, seven files, no skips.
- After simplifying the class-evidence validation, `pnpm exec vitest run scripts/regression/pilotDoorAnalysis.test.ts scripts/regression/pilotDoorInventory.test.ts --maxWorkers=1`: **29 passed**, two files, no skips.
- `pnpm exec vitest run convex/accountingVehicleInventory.test.ts --maxWorkers=1 -t 'an approved creation request'`: **2 passed**, 167 unselected tests skipped. These are the CASH/BANK and ON_ACCOUNT acquisition-posting reproductions, not the full-suite result above.
- `pnpm exec eslint scripts/regression/pilotDoorAnalysis.ts scripts/regression/pilotDoorAnalysis.test.ts scripts/regression/pilotDoorInventory.test.ts --rule 'complexity: [error, 14]'`: **passed**. This extra local check caps cyclomatic complexity; it is not a SonarCloud verdict.
- `pnpm typecheck`: **passed**. Root exclusions are `node_modules`, `apps`, `packages`, `convex`, `dealer-worker` and `test-utils`; imported dependencies may still be followed.
- `pnpm typecheck:convex`: **passed**. Its roots include `convex/**/*` and `test-utils/**/*`, exclude `convex/_generated`, and do not replace the frontend/mobile/shared/worker checks.

Development runs also exposed the two non-function platform config modules, an unsupported runtime-marker
assumption, and opaque patches. Those failures were corrected; none was skipped or accepted as passing.
F4 and F5 remain outside this round. No fresh CI, SonarCloud, independent review-seat, browser or real-backend
result is claimed for these local corrections. No server guards, shipped switch values, release waivers or
review-evidence files changed.

## Round-4 corrections at baseline 66888d0a (2026-11-04)

Finding A is reproduced by four compiler fixtures with typed ids: a three-argument money patch, a
three-argument money replacement, an id-addressed journal patch and an id-addressed journal deletion.
Against the starting analyzer, all four fail with `expected false to be true`. They pass after normalization.
The first fixture draft used an unresolved id, whose `any` type made the old analyzer refuse for the wrong
reason. The recorded four-failure run uses branded ids and isolates the actual overload defect.

The analyzer normalizes `insert(table, value)`, both forms of `patch` and `replace`, and both forms of
`delete`. A literal money-table target or an id whose compiler-resolved `__tableName` brand matches the
existing money-table pattern refuses NON_FINANCIAL evidence even for metadata-only payloads or deletions.
The same pattern is reused for both forms. Numeric money fields, opaque payloads and posting helpers retain
their checks. The monetary vocabulary now uses a set instead of the regex Sonar reported as too complex.

The stronger scan of the 170 previous NON_FINANCIAL entries flags one additional door:
`financialAudit.rejectManualJournal` patches a `manualJournalDrafts` id. It moves to UNCLASSIFIED because
the existing journal-family pattern conservatively includes that table. The entry explicitly records that
rejection changes status and reviewer metadata, posts nothing, and remains an exit under SCRUM-795 c22479.
This is an evidence refusal, not a change to that ruling, a new server block or a claim of a money posting.

The seat's exact mutant, `await ctx.db.patch("financeCompanies", id, { adminFees: 100 });` in
`finance.deleteCompany`, fails `-t 'a door classed non-financial'`: one failed test reports
`finance.deleteCompany: finance.ts:455 patch`. The source is restored from its original bytes, with no diff.

Finding B has three data-driven inventory controls. Restoring the starting inventory makes all three fail:
each receives ENABLED_CERTIFIED instead of its required class. With the corrected inventory, the cheque
doors are UNCLASSIFIED with truthful effects and `ruling: "owner ruling needed"`, and
`bankAccounts.setReconciliationTarget` is NON_FINANCIAL. The full financial-effect scan checks the latter.

The generic citation test still measures row-specific call reachability, not whether an assertion certifies
the called door's contract. The three regression controls prevent these known setup-only claims from
returning. General assertion provenance through arbitrary setup helpers and a binding to each oracle cell
would require a larger data-flow and oracle-citation change, which is not implemented in this correction.

The registered public-mutation census is rerun after the merge of main 644d785d, including PR #764.
It finds 405 doors with no missing or stale inventory entries. Final classes are EXCLUDED_GUARDED 30,
ENABLED_CERTIFIED 35, UNCLASSIFIED 170 and NON_FINANCIAL 170. The seven PR scenario records describe the
shipped refusal doors and zero committed writes. They cite neither class counts nor the four reclassified
doors, so their assertions and fingerprints do not change.

Material design sources: [Convex database writer overloads](https://docs.convex.dev/api/interfaces/server.GenericDatabaseWriter#patch),
the installed Convex `Id` definition in `convex/values`, and the
[TypeScript compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API).
Argument counts distinguish the documented overload shapes. Compiler types and properties resolve branded
ids, aliases and unions without parsing human-readable type strings.

### Round-4 validation

- `pnpm exec vitest run scripts/regression/pilotDoorAnalysis.test.ts scripts/regression/pilotDoorInventory.test.ts scripts/regression/scenarioRecord.test.ts convex/pilotBlockedDoors.scrum795.test.ts --maxWorkers=1`: **122 passed**, four files, no skips. The census and the seven PR scenario records are included.
- `pnpm exec vitest run scripts/regression/pilotDoorAnalysis.test.ts --maxWorkers=1 --coverage --coverage.include=scripts/regression/pilotDoorAnalysis.ts --coverage.reportsDirectory=C:/Users/123/AppData/Local/Temp/scrum795-r4-coverage`: **39 passed**, with the existing coverage thresholds unchanged. Analyzer coverage is 97.70% lines, 94.88% statements, 92.13% branches and 97.56% functions. Matching LCOV to `git diff --unified=0` from baseline 66888d0a measures 27/27 added executable lines and 41/41 added branches covered. This is local correction coverage, not a fresh SonarCloud PR verdict.
- `pnpm typecheck`: **passed**. The root config excludes `node_modules`, `apps`, `packages`, `convex`, `dealer-worker` and `test-utils` as roots; imports may still be followed.
- `pnpm typecheck:convex`: **passed**. Includes `convex/**/*` and `test-utils/**/*`, excludes `_generated` as roots, and does not replace frontend, mobile, shared-package or worker checks.
- `pnpm exec eslint scripts/regression/pilotDoorAnalysis.ts scripts/regression/pilotDoorAnalysis.test.ts scripts/regression/pilotDoorInventory.test.ts --max-warnings 0 --rule 'complexity: [error, 14]' --rule 'no-nested-ternary: error'`: **passed**. Local SonarJS 4.2.2 recommended rules also report zero issues on these three files, with cognitive complexity capped at 14. The existing block-evidence loop is extracted without dropping assertions to remove its complexity of 17.

Two attempts to combine all four files with V8 coverage failed the inventory's unchanged 60-second setup
timeout: 108 tests passed and 13 inventory tests did not execute in each attempt. One attempt also ran
alongside the root typecheck; the second was serial. Neither is counted as a passing run. The first isolated
analyzer coverage run passed 38 tests but failed the unchanged 90% statement and line thresholds. The final
39-test analyzer run also exercises evidence locations and re-export resolution and passes those thresholds.
The census is then measured by the passing four-file run without coverage instrumentation.

No production Convex source, guard, shipped switch, waiver or review-evidence file changes. Fresh independent
seats, CI/SonarCloud, real-backend, browser and production verification are not claimed for this local commit.

## SCRUM-850 local implementation inventory update

The three new opening-maintenance commands are recorded as UNCLASSIFIED for pilot activation. SCRUM-850 c24748/c24749 supply their feature rules, but this local, unpushed implementation is not independent pilot certification. The existing opening doors retain their inventory classification. No class, threshold, block, or release gate is relaxed. The inventory now contains 408 public mutations; the measured delta is three new org-owned commands.
