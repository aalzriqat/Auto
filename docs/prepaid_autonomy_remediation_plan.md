# Prepaid Accounting Autonomy — Remediation Plan (PR #72, post-a4fdcbfd)

**Branch:** `agent/accounting-autonomy-final-ops` (PR #72, open — reviewer requested changes; next commits land here)
**Worktree:** `E:/Auto/Auto/.claude/worktrees/accounting-autonomy-final-ops`
**Scope:** all 8 validated merge blockers + 3 founder-independence gaps from the second review. Every claim was verified against the code at `a4fdcbfd` (see memory `project-pr72-second-review-validated`).

---

## Guiding principles (how tier-1 systems do this)

1. **The ledger is the source of truth; reports derive from posted recognition events, never from mutable operational state.** History is immutable — a correction is a new forward-dated event, and it must never restate months that already posted.
2. **Every financial mutation is idempotent** (client-supplied key + input fingerprint), so a retry can never double-book.
3. **Batch financial jobs isolate per-item failures**, persist them durably, and expose a redrive path. A batch never rolls back completed items because one item failed.
4. **Nothing financial can be silently wrong**: every failed/pending posting is visible to the accountant with an actionable retry, not just a green badge.
5. **Segregation of duties**: a write-off (asset → P&L) is maker-checker; the maker cannot approve their own correction.
6. **Amounts always travel with their currency**; the UI never assumes the org's current currency applies to historical rows.
7. **Validation parity**: every backend invariant has a matching frontend zod rule, and vice versa.
8. **Alerts route by role/permission, not to a person** — that is the entire point of "founder independence."

## Phase map

| Phase | Fixes | Size | Depends on |
|---|---|---|---|
| 1. Event-backed expense reporting | Blocker #1 | L | — |
| 2. Input integrity (start date, term cap, idempotency) | #2, #7, #8 | S | — |
| 3. Failure-isolated manual run + full GL-status visibility & redrive | #3, #4 | M | — |
| 4. VAT-aware refunds + credit-note reference | #5 | M | — |
| 5. Per-schedule currency | #6 | S | — |
| 6. Maker-checker write-off approval | reviewer's #8 addendum | M | 2, 4 |
| 7. Founder independence (role-routed alerts, reopen permission + backfill, reconciliation card) | gaps 1–3 | M | 6 (notify helper shared) |
| 8. Ship checklist (tests, changelog, deploy runbook) | CI item | S | all |

One commit per phase on the PR branch, suite green after each. Phases 1–5 are independent of each other; do 1 first (the financial-statement defect), then 2 (quick wins), then 3–5 in any order, then 6–7.

---

## Phase 1 — Event-backed expense reporting (blocker #1)

**Defect:** `recognizedAmountInRangeFromSchedule` / `computeAmortizationInfoFromSchedule` (`convex/utils/expenseAmortization.ts:152,168`) recompute the whole curve from month 0 using the schedule's *current* (post-correction) `totalMinor`/`termMonths`; `reports.ts:304` consumes them. A correction retroactively restates history in the report while the GL keeps the truth; a write-off's accelerated expense never appears in the operational P&L at all; a correction-CANCELLED schedule falls back to the original expense-doc curve (double count).

**Design — derive recognition from recognition events:**

- Add `yearMonth` to the `PREPAID_EXPENSE_AMORTIZED` payload in `hookPrepaidExpenseAmortized` (`workflowHooks.ts:1099`) — it's currently only encoded in the sourceId suffix `prepaid_amort_<scheduleId>_<YYYY-MM>`. Backward compat for pre-existing events: fall back to parsing the sourceId suffix, then to the event's `accountingDate` month.
- New helper (new file `convex/utils/prepaidRecognitionEvents.ts` or added to `expenseAmortization.ts`): given the org's recognition events, bucket **per scheduleId per month** and sum minor units:
  - **Posted:** `accountingEvents` where `eventType ∈ {PREPAID_EXPENSE_AMORTIZED, PREPAID_EXPENSE_WRITTEN_OFF}` and `status === "POSTED"` (index `by_org_eventType`, one query per type — same pattern `listSchedules` already uses). A reversed original flips to `status: "REVERSED"` (`reversals.ts:188`) and drops out automatically. ⚠️ **Verify during implementation** that reversal (clawback) events carry a distinct eventType and can't be double-counted by these queries — `listSchedules` already relies on this same filter, so any bug here is pre-existing and must be fixed in both places.
  - **Parked (pending/failed outbox):** `pendingAccountingEvents` rows with `kind === "POST"` and the same two eventTypes, bucketed by their command's accountingDate month. These represent recognition that *operationally happened* (`recognizedMinor` was bumped) but is queued behind a closed period — the operational P&L must include them in their own month, or the report diverges from the authoritative schedule exactly when a period closes late. This preserves the file-header invariant ("operational P&L and ledger P&L can never diverge") under the new derivation.
- **Rewire `reports.ts`:**
  - For any expense that has a schedule row (**any status, including CANCELLED**): `recognizedAmount` in `[startDate, endDate]` = event-derived sum for that schedule's months in range. Kill the CANCELLED-schedule → expense-doc fallback (`reports.ts:243`) — presence of a schedule row always means the event path. History survives cancellation; write-offs appear as expense in their correction month (correct accelerated recognition); refunds correctly never appear (cash vs asset, not P&L).
  - Prior-expense discovery loop (`reports.ts:257`): include CANCELLED schedules whose events fall in range (drop the `status === "CANCELLED" → continue`).
  - The per-row `amortization` info object: replace the curve recompute with **actual progress**: `recognizedToDateAmount = schedule.recognizedMinor`, `remainingAmount = totalMinor − recognizedMinor`, `monthlyAmount` = next-month share from remaining balance / remaining months (same math `amortizeScheduleForMonth` posts). Delete or deprecate `computeAmortizationInfoFromSchedule`'s curve form.
  - Legacy prepaid with **no** schedule row: doc fallback unchanged.
- Read amplification: two indexed event queries + two outbox status queries per report call, org-scoped — same shape as `listSchedules`; acceptable. If Insights flags it later, add `by_org_eventType_date` — not in this PR.

**Tests (`convex/prepaidExpenses.test.ts` + a reports-focused block):**
1. 1200/12mo, 3 months posted, write off 300: report shows Jan–Mar = 100 each (unchanged), write-off month +300, month 4 = 66; lifetime report total == GL total.
2. Refund 300 instead: history unchanged, no P&L line for the refund, future months 66/mo.
3. Correction consuming the full remainder (schedule → CANCELLED): prior months still reported, no doc-fallback double count.
4. Month parked behind a closed period: report still shows it in its own month (pending-event inclusion).
5. Legacy no-schedule prepaid regression: unchanged doc-fallback behavior.

**Acceptance:** for every scenario above, `getExpensesReport` total == sum of GL expense-account postings (posted + parked) for the window, to the minor unit.

---

## Phase 2 — Input integrity: start date (#2), term cap (#7), idempotency (#8)

**Start date (backend is authority, month granularity):**
- `normalizePrepaidFields` (`convex/expenses.ts:48`) gains an `expenseDate` param; reject when `yearMonthIndex(amortizationStartDate) < yearMonthIndex(expenseDate)` — month-level comparison because recognition is month-bucketed (a start 3 days earlier in the same month changes nothing). Both `create` and `update` callers pass the **effective** date (update: `args.date ?? expense.date`).
- Frontend: `expense.schema.ts` `superRefine` comparing `amortizationStartDate` to the form's `date` (month-level), plus `min={date}` on the date input in `ExpenseDialog.tsx`. Bilingual error strings in `lib/i18n/domains/expenses.ts`.
- Earlier coverage (accrued/opening-balance workflows) stays an explicit non-goal — error message says so.

**Term cap:** `correctSchedule` (`prepaidExpenses.ts:502`) add `|| newTermMonths > 600`; `prepaidCorrection.schema.ts` add `.max(600)`. Matches expense creation's 1–600.

**Idempotency:** `correctSchedule` gains `idempotencyKey: v.optional(v.string())`; wrap the whole handler body in `runWithIdempotency` (`convex/utils/idempotency.ts:19`) with `operation: "correctPrepaidSchedule"` and a fingerprint of `{scheduleId, refundMinor, refundTaxMinor, writeOffMinor, newTermMonths, reason}`. Client: `useMemo(() => crypto.randomUUID(), [])` inside `CorrectScheduleDialog` — the dialog is conditionally mounted per open, so each open gets a fresh key and a double-click/retry within one open replays safely.

**Tests:** start-date rejection (create + update paths, month boundary cases); term > 600 rejected; same-key double call → one correction row, one GL event; different key → second correction.

---

## Phase 3 — Failure-isolated manual run (#3) + full status visibility & redrive (#4)

**Manual run becomes an action orchestrating one mutation per schedule** (the cron already does exactly this — `crons.ts:592` — the manual path just never got the same treatment):
- New `internalQuery prepaidExpenses.listActiveForManualRun({orgId})`: does `requireTenantAuth(MANAGE_FINANCE)` + `requireFeature` (auth flows through `ctx.runQuery` from actions) and returns `{ userId, schedules: [{id, expenseTitle}] }`.
- Convert `runAmortizationNow` to an **action**: loop schedules; per schedule `try { ctx.runMutation(internal.prepaidExpenses.catchUpScheduleMutation, …actorId = accountant… ) } catch { ctx.runMutation(internal.prepaidExpenses.recordAmortizationFailure, …) }` and continue. One failing schedule can no longer roll back or block the others; every failure is persisted (same table the cron uses, so retry/alerting is unified).
- Return shape: `{ posted: [{scheduleId, title, monthsPosted}], blocked: [{scheduleId, title, reason}], failed: [{scheduleId, title, error}], upToDateCount }`.
- UI (`PrepaidExpensesTab.tsx`): switch to `useAction`; all-clean → success toast; otherwise a results dialog listing posted / blocked (with `stoppedReason`, e.g. source expense not posted) / failed (with message + retry hint). Bilingual strings.

**Visibility (#4):**
- `listSchedules` additionally aggregates outbox rows for `eventType ∈ {PREPAID_EXPENSE_REFUNDED, PREPAID_EXPENSE_WRITTEN_OFF}` into `pendingCorrectionMinor` / `failedCorrectionMinor` (the current filter that *excludes* them from amortization totals stays — they get their own buckets instead of being invisible).
- Badge precedence in `ScheduleStatusBadge`: **FAILED** if `openFailureCount > 0 || failedMinor > 0 || failedCorrectionMinor > 0` → **PENDING** if `pendingMinor > 0 || pendingCorrectionMinor > 0` → DUE → CANCELLED/COMPLETE → UP TO DATE.
- New status detail popover per row: posted / pending / failed amortization, pending / failed corrections, unresolved failure records with error messages.
- **Schedule-scoped redrive:** factor the entry-draining core of `accountingOutbox.drainPendingForOrg` into a helper that accepts a row subset; new mutation `redriveScheduleEvents({orgId, scheduleId})` (MANAGE_FINANCE) that redrives PENDING+FAILED outbox rows with `sourceType === "prepaidExpenseSchedules"` and matching `payload.scheduleId`. Retry button shows when `failedMinor > 0 || failedCorrectionMinor > 0`, alongside the existing cron-failure retry.

**Tests:** action isolates a throwing schedule (others post; failure recorded); blocked schedule reported not swallowed; failed correction event surfaces in new fields; scheduled redrive posts a FAILED entry once its period opens.

---

## Phase 4 — VAT-aware refunds (#5) + credit-note reference

- **Schema (`convex/schema.ts`):** `prepaidScheduleCorrections` += `refundTaxMinor?: number`, `reference?: string` (vendor credit-note no.).
- **`correctSchedule`:** new optional args `refundTaxMinor`, `reference`. Validation: `refundTaxMinor >= 0`; `> 0` requires `refundMinor > 0`; cap at the source expense's original input VAT minus VAT already refunded by prior corrections (original = `toMinorUnits(expense.taxAmount)`). The net-remainder cap on `refundMinor + writeOffMinor` is unchanged — tax is *not* part of the prepaid asset (schedule totals are net by design).
- **Posting:** `PrepaidExpenseRefundedPayload` += `taxMinor`; `rulePrepaidExpenseRefunded` becomes: Dr cash-account `net + tax` / Cr `PREPAID_EXPENSES` `net` / Cr `VAT_RECEIVABLE` `tax` (3rd line only when `taxMinor > 0`, so existing behavior is byte-identical for tax-free refunds). `hookPrepaidExpenseRefunded` calls `ensureVatReceivableAccount` (already exists) when tax is present.
- **UI:** when refund > 0, show "VAT portion" input (with the remaining-refundable-VAT cap as helper text) + "Credit note / reference" input; correction history dialog renders tax and reference. Bilingual strings.
- **Tests:** gross refund posts a balanced 3-line journal; VAT cap enforced across multiple corrections; zero-tax path unchanged.

---

## Phase 5 — Per-schedule currency (#6)

- `useCurrencyFormatter` hard-codes the org currency; add a currency-aware variant (`hooks/useCurrencyFormatter.ts`): `formatInCurrency(amount, currencyCode, fractionDigits)` using the same locale logic.
- `PrepaidExpensesTab`: compute `scale`/`factor` **per row** from `scaleForCurrency(schedule.currency)`; format all amounts in `schedule.currency`. `CorrectScheduleDialog` + history dialog take the schedule's factor/scale (drop the tab-level ones); correction submission converts with the schedule factor — a USD schedule corrected while the org is on JOD now sends the right minor units.
- Backend already stores and posts in `schedule.currency`; no server change.
- **Test:** unit test on the conversion helper; UI-level correctness covered by the schema/e2e layer (no browser tooling locally — state it, don't claim visual verification).

---

## Phase 6 — Maker-checker write-off approval

Reuses the repo's established approval idiom (`profitApprovalRequests` / `vehicleStatusRequests`): pending → approved/rejected.

- **Rule (recommended):** corrections with `writeOffMinor > 0` submitted by a **non-owner** create a `prepaidCorrectionRequests` row instead of applying immediately; owner submissions and refund-only / term-only corrections apply directly (small-org pragmatism; a configurable threshold is an explicit follow-up). Approver: org owner or any *other* MANAGE_FINANCE holder — the maker can never approve their own request.
- **Schema:** `prepaidCorrectionRequests` { orgId, scheduleId, refundMinor, refundTaxMinor, refundPaymentMethod, writeOffMinor, newTermMonths, reason, reference, status PENDING/APPROVED/REJECTED, requestedBy, decidedBy?, decidedAt?, decisionNote?, idempotencyKey, createdAt } + `by_org_status`, `by_schedule` indexes.
- **Backend:** extract the core of `correctSchedule` into `applyScheduleCorrection(ctx, …)`; the direct path and `approveCorrectionRequest` both call it (approval re-validates against the schedule's *current* state — balances may have moved while pending; reject with a clear error if the remainder no longer covers it). `submitCorrectionRequest` / `approveCorrectionRequest` / `rejectCorrectionRequest` mutations, all idempotent, all audit-logged.
- **UI:** dialog shows "requires approval" notice for non-owner write-offs; pending-requests panel on the tab (approve/reject for eligible checkers); notifications on request + decision (Phase 7 helper).
- **Tests:** non-owner write-off → PENDING, schedule untouched; self-approval rejected; approval applies + posts; stale request (remainder shrank) rejected cleanly.

---

## Phase 7 — Founder independence

**Role-routed notifications:** new `notifyFinanceManagers(ctx, orgId, type, data)` in `convex/utils/notifications.ts` — resolve memberships → roles containing `MANAGE_FINANCE` → notify each holder (dedupe; fall back to `notifyOwner` when none exist). Replace `notifyOwner` in `recordAmortizationFailure` (`prepaidExpenses.ts:353`); use it for Phase 6 approval events. Cron *system* failures (infra, not org-data) keep owner/ops routing.

**Period reopen permission:** add `PERMISSIONS.REOPEN_PERIODS` (`"reopen:accounting_periods"`); `accountingPeriods.reopen` switches from `requireOwner` to `requireTenantAuth(ctx, orgId, [REOPEN_PERIODS])`. Add to the OWNER default template; orgs grant it to a controller role deliberately (not to default ACCOUNTANT — reopening undoes close protections, tier-1 systems gate this to controllers).
⚠️ **HARD REQUIREMENT** (memory `new-permission-needs-backfill`): adding ANY new PERMISSIONS entry breaks `isSystemOwnerRole()`'s fallback for legacy OWNER rows — ship a `migrateRoles.ts` backfill in the same commit and run it against prod immediately after deploy.
The guided prior-period-adjustment workflow (post catch-up into the current period with approver sign-off) is **deferred — needs a product decision**; parked outbox events + the reopen permission close the autonomy gap without it.

**Reconciliation card:** `PrepaidExpensesTab` queries `api.accountingReports.prepaidExpensesReconciliation` (exists at `accountingReports.ts:798`, referenced by zero components today) and renders a per-currency card above the table: GL prepaid-account balance vs subledger remaining, delta, OK (emerald) / MISMATCH (rose) styling, bilingual labels.

**Tests:** notification fan-out (multiple MANAGE_FINANCE holders, fallback path); reopen allowed for permission holder, denied for plain MANAGE_FINANCE; backfill migration idempotence.

---

## Phase 8 — Ship checklist

1. Per phase: `pnpm test`, type-check, lint green before commit; read `convex/_generated/ai/guidelines.md` before the first Convex edit (CLAUDE.md rule).
2. **CI:** `dependency-audit` failure is pre-existing and owned by `agent/pnpm11-audit-fix` — annotate the PR with that pointer rather than chasing it here. CodeRabbit is out of credits (not a signal). Everything else must stay green; add/extend Playwright or Cypress specs only if an existing covered flow changed (expense dialog validation).
3. **Changelog** (standing rule): one bilingual `changelogEntries` row covering the accountant-visible changes (run-now results, failure badges + redrive, VAT-aware refunds, approvals, reconciliation card).
4. **Deploy runbook:** merge PR #72 → fresh worktree from `origin/main` → verify `git log HEAD..origin/main` is empty (memory: verify-deploy-source-branch — a stale-worktree deploy regressed prod on 2026-07-14) → `npx convex deploy` → **run the migrateRoles backfill** (Phase 7 permission) → verify via function spec. The per-org prepaid-schedule backfill from PR #71 is still outstanding — fold it into the same ops window.
5. Update `PROJECT_PLAN.md` + memory files when merged.

## Explicit non-goals (say no, on purpose)

- Immutable effective-dated schedule *segments* — the event derivation gives the same guarantees with no new schema; segments only pay off if we later need as-of-date schedule reconstruction.
- Pre-payment amortization coverage (accrued-expense workflow) — blocked by Phase 2 validation with a clear error, needs its own design.
- Guided prior-period-adjustment flow — product decision pending (same bucket as the Tier-4 audit items).
- Configurable write-off approval thresholds — Phase 6 ships the deterministic rule first.

## Open verification items (resolve during implementation, before relying on them)

1. Reversal/clawback events' eventType vs the `by_org_eventType` forward-event queries (affects Phase 1 *and* pre-existing `listSchedules`).
2. `pendingAccountingEvents` row shape: confirm the parked command's accountingDate is queryable for month bucketing.
3. `requireTenantAuth` behavior via `ctx.runQuery` from an action (expected to work — confirm with a test).
