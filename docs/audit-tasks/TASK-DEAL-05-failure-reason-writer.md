# TASK-DEAL-05: Failure reason / appraisal-fee responsibility have no writer

## Severity: Low
## Status: CLOSED

## Problem Statement
Schema fields existed on `financeApplications` for:
- `failureReason: v.optional(financingFailureReasonValidator)`
- `failureNotes: v.optional(v.string())`
- `failedAt: v.optional(v.number())`
- `failedBy: v.optional(v.id("users"))`
- `appraisalFeeResponsibility: v.optional(feeResponsibilityValidator)`
- `appraisalFeeResponsibilityReason: v.optional(v.string())`
However, `cancelApplication` did not accept these fields, leaving no structured historical record of why financing failed or which party was responsible for appraisal expenses when deals were cancelled.

## Invariants Protected
- `[ACC-3]`: All financial and deal lifecycle transitions must be auditable with clear reasons and authorized actor stamps.
- `[ACC-6]`: Fee responsibility assignments must be recorded and defended to avoid unassigned or ambiguous expenses.

## Failing-First Test
- `convex/applications.test.ts`:
  - `TASK-DEAL-05: cancelApplication persists failureReason and appraisalFeeResponsibility`
  - First run (before mutation args extension): FAILED with `Validator error: Unexpected field 'failureReason' in object`.
- `components/applications/cockpit/CancelApplicationDialog.test.tsx`:
  - `renders failure reason and appraisal fee responsibility fields and passes values on submit`
  - First run: FAILED with `TestingLibraryElementError: Unable to find an element with the text: FailureReasonLabel`.

## Implementation Details
1. Extended `convex/applications.ts:cancelApplication`:
   - Added args: `failureReason`, `failureNotes`, `appraisalFeeResponsibility`, `appraisalFeeResponsibilityReason`.
   - Included fields in idempotency fingerprint.
   - On patch of `financeApplications`, persisted `failureReason`, `failureNotes`, `failedAt`, `failedBy`, `appraisalFeeResponsibility`, and `appraisalFeeResponsibilityReason`.
   - Used `defaultAppraisalFeeResponsibility(failureReason)` as sensible default if explicit responsibility is omitted when `failureReason` is provided.
2. Updated `components/applications/cockpit/CancelApplicationDialog.tsx`:
   - Added `Select` dropdown for `failureReason` with 8 predefined reasons.
   - Added `Select` dropdown for `appraisalFeeResponsibility` (Dealership, Customer, Finance Company, Employee, Unresolved).
   - Added conditional input for `appraisalFeeResponsibilityReason`.
   - Packaged values into `CancelApplicationValues` and sent to `onSubmit`.
3. Updated `components/applications/cockpit/DealCockpit.tsx`:
   - Updated `cancel.onSubmit` to pass `CancelApplicationValues` to `cancelApplication` mutation.
4. Updated `lib/i18n/domains/sales.ts`:
   - Added bilingual labels for failure reasons and fee responsibilities in English and Arabic.

## Verification Evidence
- Vitest backend test: `pnpm vitest run convex/applications.test.ts -t "TASK-DEAL-05"` -> 1 passed (100%).
- Full `convex/applications.test.ts` suite: 39 passed (100%).
- Vitest frontend test: `pnpm vitest run components/applications/cockpit/CancelApplicationDialog.test.tsx` -> 1 passed (100%).
- Cockpit parity suite: `pnpm vitest run components/applications/cockpit/DealCockpitReviewParity.test.tsx` -> 62 passed (100%).
