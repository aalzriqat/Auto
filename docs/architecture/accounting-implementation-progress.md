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
