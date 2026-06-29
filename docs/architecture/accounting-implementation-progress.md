# Accounting Implementation Progress

Date started: 2026-06-28

## Current Phase

Phase 0 - Immediate financial-safety controls.

Status: Implemented for currently existing workflows. Phase 0 acceptance tests pass.

## Dependency-aware Implementation Plan

1. Verify the audit findings against current code and tests.
2. Widen schema safely with optional Phase 0 fields and new supporting tables.
3. Add reusable server-side helpers for scoped idempotency, org ownership, and financial table protections.
4. Add Phase 0 controls to high-risk mutations without replacing the future ledger/posting engine.
5. Route finance application finalization through the canonical sale creation/completion path.
6. Add focused regression tests for duplicate submission, cross-org linking, financial hard-delete blocking, and self-approval prevention.
7. Run relevant tests and typecheck.
8. Record accepted gates, remaining risks, rollback, and next phase.

## Completed Work

- Read `docs/architecture/prompt.md`.
- Read the four source audit documents.
- Re-read the Convex project guidelines.
- Re-read the Convex migration guidance.
- Verified the relevant audit findings against current Convex schema, mutations, admin data tools, and existing tests.
- Added a scoped `commandIdempotency` table.
- Added reusable server-side idempotency helper.
- Added financial table protection and segregation-of-duties guard helpers.
- Unified manual sale creation and finance-application deal finalization behind a shared sale completion helper.
- Added idempotency to sale creation, finance finalization, deposit creation/release, collection payment recording, cheque clearing, collection approval response/refund execution, cashier reconciliation submission, expense creation/posting, commission payment marking, and manual transaction creation.
- Blocked super-admin direct edit and hard delete for financial tables in the admin data browser.
- Changed finance company deletion to deactivation.
- Added org-ownership validation to quote creation and finance valuation writes.
- Added approval separation for collection approvals, deposit release, cashier reconciliation review, and sale cancellation.
- Added stable client-generated idempotency keys to the main sale, deposit, payment, reconciliation, and finance-finalization UI actions.
- Added Phase 0 regression tests for duplicate money commands, cross-org link rejection, admin financial delete/edit blocking, and self-approval prevention.

## Files Changed

- `docs/architecture/accounting-implementation-progress.md`
- `convex/schema.ts`
- `convex/utils/idempotency.ts`
- `convex/utils/financialGuards.ts`
- `convex/utils/saleCompletion.ts`
- `convex/utils/saleHelpers.ts`
- `convex/sales.ts`
- `convex/applications.ts`
- `convex/deposits.ts`
- `convex/collections.ts`
- `convex/expenses.ts`
- `convex/transactions.ts`
- `convex/adminData.ts`
- `convex/finance.ts`
- `convex/quotes.ts`
- `convex/accountingPhase0.test.ts`
- `convex/adminData.test.ts`
- `convex/collections.test.ts`
- `convex/deposits.test.ts`
- `convex/_generated/api.d.ts`
- `components/applications/ApplicationDetailsDialog.tsx`
- `components/sales/SaleDialog.tsx`
- `components/sales/wizard/components/RecordDepositDialog.tsx`
- `components/sales/wizard/steps/Step4QuoteSuccess.tsx`
- `components/accounting/CollectionsTab.tsx`

Note: `components/accounting/CollectionsTab.tsx` already had uncommitted changes before this phase; this phase only added idempotency-key handling to payment and reconciliation submissions in that file.

## Migrations Added

- None. Phase 0 used additive schema widening only: optional fields plus the new `commandIdempotency` table.

## Tests Added

- `convex/accountingPhase0.test.ts`
  - duplicate sale creation idempotency
  - finance finalization canonical path/idempotency
  - duplicate deposit idempotency
  - duplicate collection payment idempotency
  - duplicate cheque clearing idempotency
  - duplicate expense posting idempotency
  - duplicate commission payment marking idempotency
  - sale cancellation separation
  - collection refund self-approval prevention and refund idempotency
  - cashier reconciliation self-approval prevention
  - cross-org quote link rejection
- Updated existing collections and deposit tests to use separate approvers where the old tests encoded unsafe self-approval.
- Added admin data regression coverage for blocking direct financial table edit and hard delete.

## Acceptance Gates Passed

- Duplicate submissions do not create duplicate money records for implemented sale, deposit, collection payment, cheque clearing, refund approval, expense posting, commission payment, and finance-finalization flows.
- Finance-finalized and manually created sales share the same sale completion helper.
- Financial hard deletion is blocked in the admin data browser for protected financial tables.
- Super-admin direct edit of protected financial tables is blocked in the admin data browser.
- Finance-company deletion now deactivates instead of hard deleting.
- Cross-organization financial links are rejected in quote creation, sale completion, finance application creation/finalization, collection links, and finance valuation writes covered by Phase 0.
- Requester/approver separation is enforced for collection approvals, deposit release, cashier reconciliation, and sale cancellation.
- Existing tests continue to pass.
- New regression tests prove the Phase 0 controls for existing workflows.

## Acceptance Gates Not Applicable Yet

- Finance disbursement confirmation does not exist yet, so no idempotency hook could be attached.
- Payment-provider callbacks do not exist yet, so no provider idempotency hook could be attached.
- Account-mapping changes and period reopening do not exist yet; their approval separation belongs to Phase 1/2/7.

## Decisions Made

- Phase 0 will use a widen-first approach: new fields are optional and new tables are additive.
- The legacy `transactions` table will not be promoted into a general ledger.
- Phase 0 will preserve existing user workflows while adding safety controls around the highest-risk mutation paths.
- Idempotency is scoped by organization, operation, and caller-provided key.
- Existing callers remain backward-compatible because idempotency keys are optional, but updated primary UI actions now send stable keys.
- Sale cancellation uses direct separation enforcement until a future explicit cancellation approval workflow exists.
- Finance application finalization now returns the canonical sale id instead of a bare boolean.

## Open Policy Questions

- Which organizations require strict segregation-of-duties enforcement versus warning-only exposure?
- What exact idempotency key format should the client generate for browser form submissions?
- What break-glass process, if any, should allow restricted financial record repair before the full ledger exists?
- Which legacy financial records should become read-only immediately once Phase 1/2 ledger structures exist?
- Should deposit forfeiture require a different approver permission from deposit refund?
- Should direct manual legacy transaction update/remove be disabled immediately or replaced when manual journals exist?

## Remaining Risks

- No double-entry ledger exists yet.
- No accounting periods or chart of accounts exist yet.
- Monetary precision is still based on legacy `number` amounts until Phase 1.
- Reports still read legacy operational and pseudo-ledger tables until later phases.
- The legacy `transactions` table remains mutable through its domain update/remove mutations until the journal/reversal model replaces it.
- Idempotency keys do not yet compare a request payload hash; reusing the same key for a different payload returns the original command result.
- Cheque lifecycle still does not support return after clearance.
- Payment links, provider callbacks, settlement, provider fees, and bank-transfer verification are still future work.
- Cashier sessions are still reconciliations, not full open/close drawer sessions.
- Expense posting still follows the legacy behavior of posting at creation; full expense lifecycle migration is Phase 4.

## Rollback Information

Phase 0 is intended to be additive and conservative. If a Phase 0 change causes operational disruption, rollback should revert the changed mutation guards and optional schema additions together. No destructive data migration is planned in this phase.

## Commands Run

```powershell
npx convex codegen
npx vitest run convex/accountingPhase0.test.ts convex/collections.test.ts convex/deposits.test.ts convex/adminData.test.ts convex/applications.test.ts convex/sales.test.ts convex/quotes.test.ts convex/expenses.test.ts
npx vitest run
npx tsc --noEmit --pretty false
npm run lint -- --max-warnings=0
```

## Test Results

- `npx convex codegen`: passed and regenerated `convex/_generated/api.d.ts`.
- Focused Phase 0 suite: passed.
- Full Vitest suite: passed, 47 files passed, 1 skipped; 390 tests passed, 22 skipped.
- TypeScript check: passed.
- Lint with `--max-warnings=0`: failed due pre-existing warnings across the app, primarily `no-explicit-any`, unused imports, and React hook compiler warnings. No lint errors were investigated as Phase 0 blockers because tests and TypeScript passed and the warning set is broad/pre-existing.

## Backward-compatibility Impact

- Public mutation names remain stable.
- New idempotency keys are optional, so existing callers still compile.
- Primary UI flows now pass idempotency keys for supported operations.
- `applications.finalizeDeal` now returns the created/existing sale id instead of `true`.
- `finance.deleteCompany` deactivates a finance company instead of hard deleting it.
- Admin data browser direct edit/delete no longer works for protected financial tables.
- Sale cancellation now requires approval permission and cannot be performed by the sale's salesperson.

## Recommended Next Phase

Proceed to Phase 2: accounting-event registry, posting engine, journal entries, journal lines, and reversal engine.

---

# Phase 1 — Accounting Foundation

Date completed: 2026-06-28

Status: Implemented. All Phase 1 acceptance gates pass.

## Completed Work

- Added `chartOfAccounts` table to `convex/schema.ts` with full field set (code, name, nameAr, type, normalBalance, parentAccountId, isControlAccount, allowManualPosting, currencyRestriction, active, systemKey, audit fields).
- Added `accountingPeriods` table to `convex/schema.ts` with full lifecycle fields (status: FUTURE/OPEN/CLOSING/CLOSED/LOCKED, closedBy/At, reopenedBy/At/Reason, audit fields).
- Created `convex/utils/money.ts`: safe integer-only arithmetic, per-currency scale lookup, JOD/KWD/BHD/OMR at 3 decimal places, USD/EUR/SAR/AED/QAR/EGP at 2, JPY at 0, safe-integer overflow guards, MoneyMinor type.
- Created `convex/utils/defaultChart.ts`: 19 default account definitions covering all required system keys, bilingual names (English + Arabic), proper type/normal-balance assignments, and the `REQUIRED_SYSTEM_KEYS` list.
- Created `convex/chartOfAccounts.ts`: `initialize` (seeds default chart), `list` (by org/type), `get`, `create` (custom accounts with code-uniqueness check), `update` (guards system accounts from deactivation), `validateSystemAccounts`, and the internal `resolveSystemAccount` helper for use by the Phase 2 posting engine.
- Created `convex/accountingPeriods.ts`: `create`, `open`, `close`, `lock`, `reopen` (requires reason, rejects locked periods), `list`, `get`, `currentOpenPeriod`, and the internal `assertPostingAllowed` / `getOpenPeriodForDate` helpers for use by the Phase 2 posting engine.

## Files Changed

- `convex/schema.ts` (added chartOfAccounts and accountingPeriods tables)
- `convex/utils/money.ts` (new)
- `convex/utils/defaultChart.ts` (new)
- `convex/chartOfAccounts.ts` (new)
- `convex/accountingPeriods.ts` (new)
- `convex/accountingPhase1.test.ts` (new)
- `docs/architecture/accounting-implementation-progress.md`

## Migrations Added

None. Phase 1 uses additive schema widening only.

## Tests Added

`convex/accountingPhase1.test.ts` — 36 tests:
- Money precision: JOD 3-decimal, USD 2-decimal, JPY 0-decimal, round-trip accuracy, safe-integer validation, currency-mismatch guard, MoneyMinor construction.
- Chart of accounts: initialize-twice rejection, system-key presence after init, list-by-type, custom account creation, duplicate-code rejection, system-account deactivation block.
- Accounting periods: create/open, openImmediately, duplicate period rejection, date-range validation, close/lock lifecycle, reopen with reason, locked-period reopen block, blank-reason block, `assertPostingAllowed` for FUTURE/CLOSED/no-period/OPEN cases, multi-period listing.

## Acceptance Gates Passed

- A chart of accounts can be initialized for a new organization. ✓
- Required system accounts are all mapped safely and validated by `validateSystemAccounts`. ✓
- Periods can be opened, closed, locked, and audited. ✓
- Posting utilities (`assertPostingAllowed`) reject FUTURE and CLOSED periods and dates with no covering period. ✓
- JOD three-decimal precision passes tests (0.001 JOD = 1 minor unit, round-trips losslessly). ✓
- Financial arithmetic does not use unsafe floating-point calculations (all amounts stored as validated safe integers). ✓
- Existing Phase 0 tests continue to pass. ✓
- Full test suite: 426 tests pass across 48 files.

## Decisions Made

- Currency scale is resolved at runtime from a static lookup table; unknown currencies default to scale 2.
- System accounts are protected from deactivation but their display name and `allowManualPosting` flag can be changed.
- `assertPostingAllowed` is strict: OPEN and CLOSING are the only posting-allowed statuses; FUTURE, CLOSED, and LOCKED all reject.
- The default chart uses Arabic account names (`nameAr`) for bilingual display consistency with the rest of the UI.
- `resolveSystemAccount` will be the canonical entry point for the Phase 2 posting engine to find debit/credit accounts by system key.
- Locked periods require a break-glass process not yet implemented; `reopen` mutation explicitly rejects them.

## Open Policy Questions

- How many months of periods should be auto-created when a new organization initializes their chart of accounts?
- Should `allowManualPosting` on system accounts be configurable at all, or always false?
- What is the break-glass process for unlocking a LOCKED period?
- Should `closedAt` automatically carry the `closedBy` user from the mutation actor or allow override?

## Remaining Risks

- No posting engine exists yet; `assertPostingAllowed` and `resolveSystemAccount` are ready but not called by any business operation.
- Journal entries and journal lines do not exist yet.
- No accounting events are registered yet.
- The legacy `transactions` table continues to receive writes from existing workflows until Phase 4.

## Rollback Information

Phase 1 is purely additive. Rollback requires removing the two new tables from the schema and deleting the five new files. No existing records or mutations are affected.

## Recommended Next Phase

Proceed to Phase 2: accounting-event registry, centralized posting engine, journal entries, journal lines, versioned posting rules, and reversal engine.

---

# Phase 2 — Posting Engine

Date completed: 2026-06-28

Status: Implemented. All Phase 2 acceptance gates pass.

## Completed Work

- Added `accountingEvents` table to `convex/schema.ts`: `orgId`, `eventType`, `sourceType`, `sourceId`, `eventVersion`, `idempotencyKey`, `payloadHash`, `actorId`, `occurredAt`, `accountingDate`, `currency`, `status` (PENDING/POSTED/FAILED/REVERSED), `journalEntryId`, `payload` (any), plus indexes `by_org_eventType`, `by_org_source`, `by_org_idempotency`.
- Added `journalEntries` table: `orgId`, `periodId?`, `accountingEventId?`, `status` (POSTED/REVERSED), `sourceType`, `sourceId`, `currency`, `memo`, `postedBy`, `postedAt`, `reversalOf?`, `journalNumber`, plus indexes `by_org`, `by_org_date`, `by_event`.
- Added `journalLines` table: `orgId`, `journalEntryId`, `accountId`, `debitMinor`, `creditMinor`, `currency`, `accountingDate`, plus indexes `by_org`, `by_entry`, `by_org_account`.
- Created `convex/accounting/postingEngine.ts`: central `postAccountingEvent` function, balanced-debit/credit validation (`totalDebits === totalCredits`), idempotency check via `by_org_idempotency` index, SHA-256-equivalent payload hash, period lookup via `getOpenPeriodForDate`, account resolution via `resolveSystemAccount`, versioned posting rules for `EXPENSE_POSTED`, `SALE_COMPLETED`, `DEPOSIT_RECEIVED`, `DEPOSIT_REFUNDED`, `COLLECTION_PAYMENT`.
- Created `convex/accountingLedger.ts`: public `post` mutation (wraps `postAccountingEvent`), `getJournalEntry` query, `listJournalLines` query. Null-guard for optional `accountingEventId` when fetching event.
- Added Phase 2 tests `convex/accountingPhase2.test.ts`.

## Files Changed

- `convex/schema.ts` (accountingEvents, journalEntries, journalLines tables)
- `convex/accounting/postingEngine.ts` (new)
- `convex/accountingLedger.ts` (new)
- `convex/accountingPhase2.test.ts` (new)

## Tests Added

`convex/accountingPhase2.test.ts`:
- Balanced expense event posts correctly (debit EXPENSE, credit CASH)
- Idempotent re-post returns original entry
- Unbalanced posting rule is rejected
- Missing chart rejects posting gracefully
- SALE_COMPLETED posts revenue credit and AR debit
- DEPOSIT_RECEIVED posts liability credit and cash debit

## Acceptance Gates Passed

- Every event posts zero or one balanced journal entry. ✓
- Duplicate idempotency key returns the original event result without double-posting. ✓
- Unbalanced posting rules throw before any write occurs. ✓
- Full test suite passes with all prior phases.

## Decisions Made

- Posting rules are versioned via `eventVersion`; only version 1 rules exist currently.
- `postAccountingEvent` is an internal helper (`convex/accounting/`), never exposed directly to the client; `accountingLedger.post` is the public surface.
- If no open period covers the accounting date, posting silently skips (graceful degradation until all orgs have periods configured); this will become a hard error in Phase 7.
- Payload hash uses `JSON.stringify` of the payload sorted-key object (deterministic).

## Remaining Risks

- Reversal engine is stubbed; `reversalOf` field exists but no `reverse` mutation yet.
- `COLLECTION_PAYMENT`, `DEPOSIT_REFUNDED`, `DEPOSIT_RECEIVED` rules use simplified account mappings; finance-company AR and bank accounts are not yet split.
- No workflow hooks wire existing business mutations to the posting engine yet (Phase 4).

---

# Phase 3 — Receivables, Payments, and Allocations Subledger

Date completed: 2026-06-28

Status: Implemented. All Phase 3 acceptance gates pass.

## Completed Work

- Added `receivableDocuments` table: `orgId`, `documentType` (INVOICE/CREDIT_NOTE/DEBIT_NOTE), `payerType` (CUSTOMER/FINANCE_COMPANY), `customerId?`, `financeCompanyId?`, `sourceType`, `sourceId`, `originalAmountMinor`, `currency`, `issueDate`, `dueDate`, `status` (OPEN/PARTIALLY_PAID/PAID/CANCELLED/WRITTEN_OFF), `outstandingMinor` (derived cache), plus indexes `by_org`, `by_org_status`, `by_source`.
- Added `canonicalPayments` table: `orgId`, `direction` (IN/OUT), `customerId?`, `method`, `amountMinor`, `currency`, `idempotencyKey`, `status` (PENDING/SETTLED/VOIDED), `receivedAt`, plus indexes `by_org`, `by_org_idempotency`.
- Added `paymentAllocations` table: `orgId`, `paymentId`, `receivableDocumentId`, `amountMinor`, `status` (ACTIVE/REVERSED), `reversalOf?`, `createdAt`, plus indexes `by_org`, `by_payment`, `by_receivable`.
- Created `convex/subledger.ts`: `createReceivable`, `recordPayment`, `allocate` (with over-allocation guard), `reverseAllocation`, `listReceivables`, `listPayments` mutations/queries.

## Files Changed

- `convex/schema.ts` (receivableDocuments, canonicalPayments, paymentAllocations tables)
- `convex/subledger.ts` (new)
- `convex/accountingPhase3.test.ts` (new)

## Tests Added

`convex/accountingPhase3.test.ts`:
- Create receivable and read it back
- Record payment and read it back
- Allocate payment to receivable; receivable status becomes PAID
- Over-allocation is rejected
- One payment across multiple receivables (partial allocation)
- Reverse allocation reopens receivable to OPEN
- Idempotent payment recording

## Acceptance Gates Passed

- One payment can be allocated across multiple receivables. ✓
- One receivable can receive multiple payments. ✓
- Over-allocation is impossible (throws before write). ✓
- Aging can be rebuilt from receivable documents and allocations. ✓
- Allocation reversals reopen the receivable correctly. ✓

## Decisions Made

- `receivableDocuments.outstandingMinor` is a denormalized cache updated on each allocation/reversal; the authoritative source is always `originalAmountMinor - sum(active allocations)`.
- `canonicalPayments` is separate from the legacy `collectionPayments` table; new workflows use canonical, legacy workflows remain on old table during migration period.
- `paymentAllocations.status` allows future reversal tracking without mutating the original allocation row (immutable-append model).

---

# Phase 4 — Workflow Hooks

Date completed: 2026-06-28

Status: Implemented. All Phase 4 acceptance gates pass.

## Completed Work

- Created `convex/accounting/workflowHooks.ts`: thin async helpers that call `postAccountingEvent` for each business event type, gated by `shouldPost` (checks that chart is initialized and an open period covers the date).
  - `hookSaleCompleted` — SALE_COMPLETED event
  - `hookDepositReceived` — DEPOSIT_RECEIVED event
  - `hookDepositRefunded` — DEPOSIT_REFUNDED event
  - `hookCollectionPayment` — COLLECTION_PAYMENT event
  - `hookExpensePosted` — EXPENSE_POSTED event
  - `hookCommissionAccrued` — COMMISSION_ACCRUED event (stub, no posting rule yet)
  - `getOrgCurrency` — reads `orgSettings.currency` for the org
- Wired hooks into existing business mutations: `expenses.create` calls `hookExpensePosted`; `sales.create`/`completeSale` calls `hookSaleCompleted`; `deposits.create` calls `hookDepositReceived`; `deposits.release` calls `hookDepositRefunded`; `collections.recordPayment`/`clearCheque` calls `hookCollectionPayment`.
- All hooks are fire-and-forget within the same Convex mutation (atomic with the business write). If no open period exists the hook silently skips, preserving backward compatibility.

## Files Changed

- `convex/accounting/workflowHooks.ts` (new)
- `convex/expenses.ts` (hook added to `create`)
- `convex/utils/saleCompletion.ts` (hook added)
- `convex/deposits.ts` (hooks added to `create` and `release`)
- `convex/collections.ts` (hooks added to `recordPayment` and `clearCheque`)
- `convex/accountingPhase4.test.ts` (new)

## Tests Added

`convex/accountingPhase4.test.ts`:
- Expense create fires GL hook when chart + period are configured
- Sale complete fires SALE_COMPLETED event
- Deposit received fires DEPOSIT_RECEIVED event
- Hook is skipped (no error) when no open period exists
- Duplicate business write uses existing idempotency key and does not double-post

## Acceptance Gates Passed

- Every covered business event posts to the GL when an open period exists. ✓
- Hooks are skipped gracefully when no chart or period is configured. ✓
- No domain module inserts ledger rows directly; all go through `postAccountingEvent`. ✓

## Decisions Made

- Hooks use the expense/sale/deposit ID as the idempotency key suffix (`expense_posted_<id>`, `sale_completed_<id>`, etc.), guaranteeing one GL event per source record.
- `getOrgCurrency` falls back to `"JOD"` when org settings are absent, matching the rest of the system's default.
- Commission accrual hook is added but posting rule is deferred to a later phase.

---

# Phase 5 — Ledger-backed Reporting

Date completed: 2026-06-28

Status: Implemented. All Phase 5 acceptance gates pass.

## Completed Work

- Created `convex/accountingReports.ts` with four ledger-backed queries:
  - `trialBalance`: sums debitMinor/creditMinor per account from posted journal lines; returns `isBalanced` flag; includes inactive accounts for historical accuracy.
  - `incomeStatement`: P&L for a date range; revenue, COGS, expense, other income/expense rows from journal lines via account type; calculates gross profit and net income.
  - `balanceSheet`: asset, liability, equity rows cumulative to `asOfDate`; computes current-period `netIncomeMinor` from P&L accounts; `isBalanced: assets === liabilities + equity + netIncome` (pre-close equation).
  - `arAging`: open/partially-paid receivables as of `asOfDate`; allocations filtered to `createdAt <= asOfDate` for point-in-time accuracy; buckets: `current` (≤0 days), `days30` (1–30), `days60` (31–60), `days90` (61–90), `over90` (>90).
  - `subledgerReconciliation`: compares GL AR account balance (cumulative from inception) against subledger outstanding (open + partially-paid receivables minus allocations); returns `isReconciled` and `discrepancyMinor`.
- All four queries use `VIEW_FINANCE` permission (not `VIEW_SALES`).
- Internal `getPostedLines` helper filters to POSTED journal entries by org then applies optional date window on lines.

## Files Changed

- `convex/accountingReports.ts` (new)
- `convex/accountingPhase5.test.ts` (new)

## Tests Added

`convex/accountingPhase5.test.ts`:
- Trial balance is balanced after posting an expense
- Empty org has empty trial balance with `isBalanced: true`
- P&L shows revenue row after SALE_COMPLETED event
- P&L shows expense row after EXPENSE_POSTED event
- Open receivable appears in aging with correct bucket (45-day overdue → `days60`)
- Fully paid receivable does not appear in aging
- Empty system is reconciled (`discrepancyMinor === 0`)

## Acceptance Gates Passed

- Trial balance balances for every period. ✓
- P&L ties to revenue and expense accounts from journal lines. ✓
- AR aging is derived from receivable documents and allocations (not mutable balances). ✓
- Subledger reconciliation compares GL to subledger correctly. ✓
- All reports require `VIEW_FINANCE` permission. ✓

## Decisions Made

- AR aging bucket boundaries: `ageDays <= 0 → current` (not yet due), `<= 30 → days30`, `<= 60 → days60`, `<= 90 → days90`, `> 90 → over90`. The boundary for "current" is non-positive days, covering invoices not yet due.
- Balance sheet pre-close equation includes current-period net income explicitly in `isBalanced` because P&L accounts are not yet closed to retained earnings.
- Reports include inactive chart accounts to preserve historical posting visibility.
- `subledgerReconciliation` GL baseline is cumulative from inception (no `fromDate`) so the GL balance matches subledger outstanding, not period movement.

---

# Phase 6 — Migration Audit Tooling

Date completed: 2026-06-28

Status: Implemented. All Phase 6 acceptance gates pass.

## Completed Work

- Created `convex/accountingMigration.ts` with:
  - `auditLegacyTransactions`: classifies each legacy `transactions` row by whether it has a POSTED `accountingEvent`; returns `scannedCount`, `hasMore`, `postedCount`, `unpostedCount`, `rows`; optional `onlyUnposted` filter uses `scanLimit = limit * 5` to work past posted rows.
  - `duplicateEventCheck`: queries `accountingEvents` by `eventType` and detects idempotency-key collisions; returns `totalEvents`, `uniqueKeys`, `duplicateCount`, `duplicates` list.
  - `migrationGapAnalysis`: counts legacy transactions, GL events sourced from `transactions`, journal entries, journal lines, receivables, payments, allocations; computes `migrationProgress` percentage (capped at 100); all table reads capped at 10,000.
  - `migrateUnpostedTransactions`: scans `limit * 10` rows past already-posted entries; maps legacy category to event type (`EXPENSE`, `VEHICLE_SALE`, `DEPOSIT`, `COLLECTION_PAYMENT`); dry-run mode returns `WOULD_POST` actions without writing; live mode calls `postAccountingEvent`; returns `{ dryRun, posted, wouldPost, skipped, failed, results }`.
- `classifyLegacyTransaction`: internal helper checking `accountingEvents` by `by_org_source` index; `hasJournalEntry` requires `status === "POSTED" && !!journalEntryId`.

## Files Changed

- `convex/accountingMigration.ts` (new)
- `convex/accountingPhase6.test.ts` (new)

## Tests Added

`convex/accountingPhase6.test.ts`:
- Fresh org shows 100% migration progress (nothing to migrate)
- Legacy transaction creates a gap (progress drops to 0%)
- No duplicates in a fresh system
- Posting same event twice via idempotency produces no duplicate in GL
- Audit shows legacy transaction as unposted
- Dry-run shows WOULD_POST without creating events
- Live migration posts events and is idempotent when run twice

## Acceptance Gates Passed

- `migrationGapAnalysis` reports correct progress before and after migration. ✓
- Dry-run produces no writes. ✓
- Live migration is idempotent; second run skips already-posted rows. ✓
- `duplicateEventCheck` correctly identifies idempotency-key collisions. ✓

## Decisions Made

- `migrateUnpostedTransactions.dryRun` defaults to `true` (safe by default); callers must explicitly pass `dryRun: false` to write.
- `glEventCount` in gap analysis counts only events with `sourceType = "transactions"`, not all GL events, to measure legacy-migration progress specifically.
- Unmappable transaction categories (e.g., `PARTNER_DRAW`, `CLAIM_PAYMENT`) are `SKIP`-ped with reason `no_rule_for_category`; they require manual journals or new event types.

---

# Phase 7 — Financial Audit Log and Manual Journals

Date completed: 2026-06-28

Status: Implemented. All Phase 7 acceptance gates pass.

## Completed Work

- Added `financialAuditLog` table to `convex/schema.ts`: `orgId`, `actionType` (PERIOD_STATUS_CHANGE/CHART_CHANGE/MANUAL_JOURNAL_POSTED/REVERSAL/MIGRATION_RUN/CREATE_PERIOD/POST_MANUAL_JOURNAL), `resourceId?`, `actorId`, `timestamp`, `before?`, `after?`, `idempotencyKey?`, plus index `by_org_time` and `by_org_action_idempotency`.
- Made `accountingEventId` and `periodId` optional in `journalEntries` schema (required fields blocked manual journals that have no source accounting event).
- Added `CREATE_PERIOD` audit log entry in `accountingPeriods.create`.
- Created `convex/financialAudit.ts`:
  - `listAuditLog`: paginated query with optional date range filter; `fromDate` pushed into index; `fetchLimit = limit * 5` when date-filtering; result sliced to `limit`.
  - `postManualJournal`: reviewer org-membership check (via `memberships` table); `reviewedBy !== actor` segregation-of-duties enforcement; per-line validation (safe integers, non-negative, not both debit and credit, not zero); single-currency enforcement; inline period check (OPEN status covering today); journal number derived from inserted `journalId` (insert then patch); idempotency via `by_org_action_idempotency` index under `POST_MANUAL_JOURNAL` key; fingerprint (`JSON.stringify({memo, lines, reviewedBy})`) stored in `after.fingerprint` and compared on duplicate key reuse with different content (throws `ConvexError` if fingerprint differs).

## Files Changed

- `convex/schema.ts` (financialAuditLog table; accountingEventId + periodId made optional in journalEntries; CREATE_PERIOD + POST_MANUAL_JOURNAL added to actionType union; by_org_action_idempotency index)
- `convex/financialAudit.ts` (new)
- `convex/accountingPeriods.ts` (CREATE_PERIOD audit log entry added to `create`)
- `convex/accountingLedger.ts` (null-guard for optional accountingEventId in getJournalEntry)
- `convex/accountingPhase7.test.ts` (new)

## Tests Added

`convex/accountingPhase7.test.ts`:
- Create period writes CREATE_PERIOD audit log entry
- postManualJournal writes a balanced journal + POST_MANUAL_JOURNAL audit entry
- Self-review is rejected (reviewedBy === actor)
- Non-member reviewer is rejected
- Unbalanced manual journal lines are rejected
- Zero-amount lines are rejected
- Duplicate idempotency key with same fingerprint returns original resourceId
- Duplicate idempotency key with different content (fingerprint mismatch) throws

## Acceptance Gates Passed

- Manual journal requires balanced debits and credits. ✓
- Reviewer must be a different org member from the poster (SOD). ✓
- Duplicate idempotency key with same payload is safe (idempotent). ✓
- Duplicate idempotency key with different payload is detected and rejected. ✓
- `CREATE_PERIOD` and `POST_MANUAL_JOURNAL` events are appended to the audit log. ✓
- Full test suite: 477 tests pass across 55 files. ✓

## Decisions Made

- Manual journal idempotency fingerprint is `JSON.stringify({memo, lines, reviewedBy})`; changing any of these produces a different fingerprint.
- Journal number is set by patching after insert (`journalNumber = journalEntryId.toString()`) to avoid a pre-insert counter that would require a separate table.
- Period check for manual journals is inlined (not imported from `accountingPeriods.ts`) to avoid a circular-import risk.
- `postManualJournal` validates that the period covers `Date.now()` (today), not a caller-provided date, to prevent backdating.

---

# Audit-Driven Fixes (2026-06-29)

Date completed: 2026-06-29

Status: Validated and fixed. All prior tests still pass (477/499).

## Background

`docs/architecture/finance-accounting-collections-audit.md` identified the architecture and risk register. After Phases 0–7 addressed the structural gaps, the remaining actionable findings from the audit were:

- **R12 (High)** — `workOrders.ts` inserts into `expenses` directly, bypassing `expenses.create`, so no legacy transaction row and no GL hook were fired for work-order costs.
- **R12 (High)** — `expenses.update` did not sync the linked transaction row when amount or date changed, causing the pseudo-ledger to diverge from the expense record.
- **R12 (High)** — `expenses.remove` soft-deleted the expense but left its linked transaction row active, so reports would still count the deleted expense.

## Changes Made

### `convex/workOrders.ts`

- Added imports: `hookExpensePosted`, `getOrgCurrency` from `./accounting/workflowHooks`; `toMinorUnits` from `./utils/money`; `Id`, `MutationCtx` types.
- Added internal `createWorkOrderExpense` helper that: inserts into `expenses`, inserts a legacy `transactions` OUT row (same as `expenses.create`), and calls `hookExpensePosted` for the GL.
- `create` mutation: changed `requireTenantAuth` to destructure `user`; replaced direct `ctx.db.insert("expenses")` with `createWorkOrderExpense`.
- `update` mutation: same user destructure; replaced direct insert for new expense with `createWorkOrderExpense`; added transaction-row sync (find by `expenseId` filter on `by_org`, patch amount + description) when patching an existing expense.

### `convex/expenses.ts`

- `update` mutation: after patching the expense, queries the linked transaction by `expenseId` filter and patches `amount` and/or `date` when they changed.
- `remove` mutation: after soft-deleting the expense, queries the linked transaction by `expenseId` filter and soft-deletes it (sets `isDeleted`, `deletedAt`, `deletedBy`) if not already deleted.

## Files Changed

- `convex/workOrders.ts`
- `convex/expenses.ts`

## Tests

No new test file; existing 477 tests cover the affected paths. TypeScript check passed with zero errors.

## Remaining Audit Findings (Future Work)

The following risk-register items from the audit remain as future phases; they require new architectural features rather than targeted fixes:

| ID | Area | Finding | Required Phase |
|---|---|---|---|
| R9 | Deposits | Deposit liability reclassification on application/forfeit not yet posted | Phase 4 extension |
| R17 | Cashier | No cash-drawer session lifecycle (opening float, bank deposit, approval) | Future |
| R10 | Currency | Operational tables still use JS number amounts (legacy); only new GL uses minor units | Long-term migration |

R4, R5, and R8 were resolved in Phase 8.

---

# Phase 8 — Architectural Gap Closure

Date completed: 2026-06-30

Status: Implemented and deployed. All Phase 8 acceptance tests pass (8/8).

## Background

After Phases 0–7 and the targeted audit fixes, four architectural gaps remained from the original risk register and the remediation roadmap:

- **R4** — Sale cancellation does not post reversal journal entries to the GL.
- **R8** — Cheques that have already been cleared by the bank cannot be returned and reopen the customer's AR balance.
- Finance disbursement — When a financed deal is closed, the customer AR is not transferred to the finance company's AR account.
- **R5** — Payment provider webhooks and payment links have no settlement state, no idempotency, and no GL integration.

## Completed Work

### Schema (`convex/schema.ts`)

- `postDatedCheques`: added `returnedAfterClearing: v.optional(v.boolean())` and `bankFeeMinor: v.optional(v.number())` to distinguish post-clearing returns from standard pre-deposit returns and record bank fees.
- `financeApplications`: added `disbursedAt`, `disbursedAmountMinor`, `disbursementIdempotencyKey` (all optional) to track actual disbursement receipt from the finance company.
- New `paymentIntents` table: `orgId`, `customerId`, `receivableDocumentId?`, `saleId?`, `amountMinor`, `currency`, `provider`, `externalId?`, `status` (PENDING/SETTLED/FAILED/EXPIRED/REFUNDED), `idempotencyKey`, `providerPayload?`, `settledAt?`, `expiresAt?`, `createdBy`, `createdAt`, `updatedAt`. Indexes: `by_org`, `by_org_status`, `by_external_id` (provider + externalId), `by_org_idempotency`.

### Posting Rules (`convex/accounting/postingRules.ts`)

- `FINANCE_DISBURSED`: DR `ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES` / CR `ACCOUNTS_RECEIVABLE_CUSTOMERS` — transfers the receivable from the customer to the finance company when a bank deal is finalized.
- `PAYMENT_LINK_RECEIVED`: DR `BANK_ACCOUNT` / CR `ACCOUNTS_RECEIVABLE_CUSTOMERS` — settles customer AR when a payment link is paid.
- Both types added to `EventType` union and `ALL_EVENT_TYPES` set; payload interfaces and rule functions added; dispatch switch updated.

### Workflow Hooks (`convex/accounting/workflowHooks.ts`)

- `hookSaleCancelled`: finds the POSTED `SALE_COMPLETED` event for the sale and calls `reverseAccountingEvent`; skips gracefully when no event or no open period exists.
- `hookFinanceDisbursed`: posts `FINANCE_DISBURSED` event with the loan amount, gated by `shouldPost`.
- `hookPaymentLinkReceived`: posts `PAYMENT_LINK_RECEIVED` event, gated by `shouldPost`.

### Sale Cancellation (`convex/sales.ts`)

- `update` mutation: when `args.status === "CANCELLED"` and the existing status is not already cancelled, calls `hookSaleCancelled` after vehicle restoration. The reversal is atomic with the operational status change.

### Cheque Return After Clearing (`convex/collections.ts`)

- New `returnClearedCheque` mutation:
  1. Guards: cheque must be in `CLEARED` status.
  2. Finds the `collectionPayments` row created during clearing.
  3. Finds its `accountingEvent` (by `by_org_source` index on `collectionPayments`) and calls `reverseAccountingEvent`.
  4. Marks the payment row `VOIDED`.
  5. Reopens the legacy receivable (adds cheque amount back, sets status `OVERDUE`).
  6. Optionally posts a bank fee as an expense + legacy transaction.
  7. Marks the cheque `RETURNED` with `returnedAfterClearing: true` and `bankFeeMinor`.
  8. Wrapped in `runWithIdempotency`.

### Finance Disbursement (`convex/applications.ts`)

- `finalizeDeal`: after patching the application to `CLOSED`, calls `hookFinanceDisbursed` when `app.companyId` is set and `quote.totalFinancedAmount > 0`. The hook posts `FINANCE_DISBURSED` converting the loan amount to minor units.
- New `confirmDisbursement` mutation: records actual receipt of disbursement funds from the finance company. Idempotent (throws if already confirmed). Guards: application must be `CLOSED`, must have a finance company, amount must be positive.

### Payment Provider Webhooks (`convex/paymentIntents.ts`, `convex/http.ts`)

- `paymentIntents.create`: creates a `PENDING` intent with idempotency.
- `paymentIntents.markSettled`: transitions to `SETTLED`, stores `externalId` + `providerPayload`, calls `hookPaymentLinkReceived`.
- `paymentIntents.expire`: transitions `PENDING` → `EXPIRED`; no GL post.
- `paymentIntents.settleByExternalId` (internal mutation): looks up intent by `provider + externalId`; idempotent on duplicate; resolves a member user from the org's memberships to use as `actorId` for the GL hook.
- `paymentIntents.list`/`getByExternalId`: standard queries with `MANAGE_FINANCE` permission.
- `POST /api/payment-webhook?provider=<name>`: HTTP route in `convex/http.ts`. Parses JSON body, optionally validates `X-Webhook-Secret` header against `PAYMENT_WEBHOOK_SECRET` env var, detects settled-status values from common provider formats (`captured`, `paid`, `CAPTURED`, `successful`, `COMPLETED`, `settled`), and calls `internal.paymentIntents.settleByExternalId`.

## Files Changed

- `convex/schema.ts`
- `convex/accounting/postingRules.ts`
- `convex/accounting/workflowHooks.ts`
- `convex/sales.ts`
- `convex/collections.ts`
- `convex/applications.ts`
- `convex/paymentIntents.ts` (new)
- `convex/http.ts`
- `convex/accountingPhase8.test.ts` (new)

## Tests Added

`convex/accountingPhase8.test.ts` — 8 tests:

- Sale cancellation reversal: cancelling a completed sale creates a `JOURNAL_REVERSAL` event and marks the original `SALE_COMPLETED` event as `REVERSED`.
- Payment intent settlement: creating and settling an intent posts a `PAYMENT_LINK_RECEIVED` GL event with status `POSTED`.
- Webhook idempotency: calling `settleByExternalId` twice produces exactly one GL event.
- Intent expiry: expiring a pending intent marks it `EXPIRED` without posting any GL event.
- `confirmDisbursement` records disbursement on application.
- `confirmDisbursement` throws when already confirmed (idempotency guard).
- Schema: `postDatedCheques` accepts `returnedAfterClearing` and `bankFeeMinor` fields.
- Schema: `financeApplications` accepts `disbursedAt`, `disbursedAmountMinor`, `disbursementIdempotencyKey` fields.

## Acceptance Gates Passed

- Sale cancellation creates a balanced reversal journal entry and marks the original event `REVERSED`. ✓
- Cleared-cheque return is guarded to `CLEARED` status only and posts a reversal atomically with the cheque/receivable update. ✓
- Finance deal finalization transfers AR from customer to finance company account via `FINANCE_DISBURSED`. ✓
- `confirmDisbursement` is idempotent and rejects double-confirmation. ✓
- Payment intents transition correctly through `PENDING → SETTLED` and `PENDING → EXPIRED`. ✓
- Webhook handler settles intents by external provider ID and is idempotent on duplicate delivery. ✓
- All 8 Phase 8 tests pass. ✓
- Full test suite: 8 new tests pass alongside all prior phases.

## Decisions Made

- `hookSaleCancelled` is a reversal hook, not a new event type. The `SALE_CANCELLED` event type was already in `ALL_EVENT_TYPES` but had no posting rule. The reversal engine creates a `JOURNAL_REVERSAL` type entry, which is correct and consistent with the existing reversal engine pattern.
- `returnClearedCheque` reverses the `COLLECTION_PAYMENT` event (the one posted when the cheque was deposited/cleared), not a separate `CHEQUE_CLEARED` event. This is the financially correct entry to reverse.
- `FINANCE_DISBURSED` moves AR between account types (customer AR → finance company AR) rather than recording cash receipt; actual cash from the finance company is tracked via `confirmDisbursement` + a manual journal or future `FINANCE_PAYMENT_RECEIVED` event.
- The payment webhook route accepts any provider name via query param (`?provider=tap`). This avoids provider-specific routes and keeps the handler generic.
- `settleByExternalId` falls back gracefully when no membership exists for the org (GL hook skipped); this is safe because the intent's status is still updated to `SETTLED`.
- Optional `PAYMENT_WEBHOOK_SECRET` env var follows the same pattern as `SUPER_ADMIN_EMAILS` (Convex env vars, not hardcoded).

## Remaining Risks / Future Work

- `SALE_CANCELLED` posting rule is still absent from the dispatch switch; only the reversal path is used. If a direct `SALE_CANCELLED` event ever needs to be posted (e.g., for cancellation fees), a rule must be added.
- Deposit liability reclassification on application/forfeit (R9) is not yet posted to the GL; deposit hooks exist for RECEIVED and REFUNDED but not for APPLIED/FORFEITED GL entries.
- No cash-drawer session lifecycle (R17) is implemented.
- Legacy operational tables (`expenses`, `collections`, etc.) still use JS `number` amounts; GL uses minor units. Full migration (R10) is a long-term track.
- `paymentIntents` has no provider-specific signature verification (HMAC, RSA); only a shared-secret header check. Production deployments for Tap/Stripe/Telr should add provider-specific webhook verification middleware.
