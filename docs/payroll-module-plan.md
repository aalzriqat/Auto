# Payroll Module — Scope & Plan

Status: **IMPLEMENTED (PR #125)** — Phases 0–2 + UI are built and tested; see "Implementation status" at the end of this doc for what shipped, deliberate policy choices, and known limitations. Author: agent, 2026-07-20.

Goal: pay staff a **fixed monthly salary + commissions**, handle **salary advances (سلفة)** correctly, and post it all to the general ledger. Small dealership scale (a handful of employees, cash/bank advances, Jordan).

This plan has two parts:
1. **Commission audit** — what works, what's broken (must be fixed as Phase 0, because payroll consumes commissions).
2. **Payroll module design** — data model, GL, flows, phasing.

---

## Part 1 — Commission audit ("is it working as intended?")

### How it works today
- `orgSettings.commissionMode` ∈ `AUTO_TIERS` | `AUTO_MEMBER` | `MANUAL` (default `AUTO_MEMBER`). Set on the Commission settings page.
- **Grossprofit basis:** `grossProfit = purchasePrice != null ? max(0, salePrice − purchasePrice) : salePrice` ([saleCompletion.ts:137](../convex/utils/saleCompletion.ts#L137)).
- **AUTO_MEMBER:** `commission = grossProfit × membership.commissionRate/100` (rate per person, Team page).
- **AUTO_TIERS:** `calculateCommissionFromTiers` — the highest tier whose `minProfitAmount ≤ grossProfit` sets a single `%` applied to the **whole** grossProfit (flat-at-bracket, not marginal).
- **MANUAL:** completion sets no amount; managers type it per sale on the Commissions page → `sales.setCommissionAmount` ([sales.ts:754](../convex/sales.ts#L754)).
- **GL:** at completion, if `commissionAmount > 0`, `hookCommissionAccrued` posts **Dr Commission Expense / Cr Commission Payable**. `markCommissionPaid` posts **Dr Commission Payable / Cr Cash** ([workflowHooks.ts:466](../convex/accounting/workflowHooks.ts#L466)).

### Verdict
`AUTO_TIERS` and `AUTO_MEMBER` accrue → pay correctly end to end. **`MANUAL` mode and any manual edit are broken at the ledger level.** Details:

| # | Severity | Finding |
|---|----------|---------|
| C1 | **Bug** | `setCommissionAmount` patches `sale.commissionAmount` but **never posts an accrual**. In MANUAL mode the accrual is never created, so **Commission Expense is never recognized**, and when `markCommissionPaid` runs it debits a Commission Payable that was never credited → **payable goes negative / expense missing**. |
| C2 | **Bug** | Editing the amount in an AUTO mode (after completion accrued X) to Y posts **no adjusting entry** — GL keeps X, payment pays Y → permanent **X−Y residual** in Commission Payable. |
| C3 | Risk | grossProfit fallback: when `purchasePrice` is null, commission is computed on the **full sale price**, not profit — can massively over-pay. Likely unintended. |
| C4 | UI divergence | Frontend `useCommission` computes **TIERS only** ([useCommission.ts](../hooks/useCommission.ts)) and ignores `commissionMode`, so in AUTO_MEMBER/MANUAL the wizard preview can show a number that won't match what's booked. |
| C5 | Hardening | `markCommissionPaid` doesn't verify an accrual exists before paying — the root enabler of C1. |

**Fixing C1/C2 is a prerequisite** for payroll, since payroll will consume commission accruals. Each fix must ship with a test that fails on today's code first (repo rule).

---

## Part 2 — Payroll module design

### New data (schema)
- **`employeeCompensation`** (one active row per membership): `orgId`, `userId`, `membershipId`, `monthlySalaryMinor`, `currency`, `effectiveFrom`, `active`, audit. History kept by superseding rows.
- **`employeeAdvances`** (the سلفة ledger): `orgId`, `userId`, `amountMinor`, `date`, `method`, `status` (OUTSTANDING | RECOVERED | WRITTEN_OFF), `recoveredMinor`, `payrollItemId?`, `note`. **This is the fix for سلفة** — an advance is an *asset* (recoverable), not an expense, until offset against a payslip.
- **`payrollRuns`**: `orgId`, `periodYear`, `periodMonth`, `status` (DRAFT | APPROVED | PAID | REVERSED), totals, `approvedBy/paidBy`, dates.
- **`payrollItems`** (one per employee per run): `runId`, `userId`, `baseSalaryMinor`, `commissionMinor`, `otherEarningsMinor`, `advanceDeductionMinor`, `otherDeductionMinor`, `grossMinor`, `netMinor`, `paidMethod`, links.

### New GL accounts (seed into default chart)
- `Salaries Expense` (EXPENSE) — replaces routing salaries into the single General Expenses bucket.
- `Salaries Payable` (LIABILITY) — accrue-then-pay.
- `Employee Advances` (ASSET) — the سلفة receivable.
- Reuse existing `Commission Expense` / `Commission Payable`.
- Requires extending `expenseAccountKeyForCategory` so the `SALARIES` expense category maps to Salaries Expense (today everything → GENERAL_EXPENSE).

### Flows
1. **Compensation setup** — on the Team page, set `monthlySalary` per member (alongside the existing commission rate).
2. **Advance (سلفة)** — recorded via a small form: **Dr Employee Advances / Cr Cash**. Shows on an "Outstanding advances" list. (Replaces treating سلفة as EXPENSE.)
3. **Monthly payroll run**:
   - Gather each active employee's `monthlySalary` + **commissions accrued & unpaid** in the period (from `sales.commissionAmount` / commission accruals) + outstanding advances.
   - `gross = salary + commissions + otherEarnings`; `deductions = advanceRecovery + otherDeductions`; `net = gross − deductions`.
   - **Approve** → accrue: Dr Salaries Expense / Cr Salaries Payable (salary portion; commission already accrued at sale).
   - **Pay** → Dr Salaries Payable + Dr Commission Payable (net split), Cr Cash/Bank for `net`, and **Cr Employee Advances** for the recovered advance amount (clears the سلفة).
4. **Payslip** per employee (bilingual), and a **payroll register** + **advance-aging** report.

### Commission integration decision (needs your call)
- **Option A (recommended):** commissions are paid **through** the payroll run — the run consumes unpaid commission accruals and marks them paid, so an employee gets one payment = salary + commission. Cleaner, single cash outflow.
- **Option B:** keep the separate Commissions page "mark paid" flow; payroll covers salary only. Less integrated, two payments.

### Cross-cutting
- **Permissions:** new `view:payroll`, `manage:payroll`, `run:payroll`. New permissions require a **role backfill migration** for existing OWNER/MANAGER roles (repo rule — a new PERMISSIONS entry breaks `isSystemOwnerRole` for legacy rows).
- **i18n:** payroll/advance/payslip strings in a new `payroll` domain (EN/AR).
- **Changelog:** bilingual entry per shipped phase.
- **Reversibility:** payroll runs reverse via offsetting journal entries (never hard-delete posted GL), mirroring existing reversal hooks.

### Phasing
- **Phase 0 — Commission GL correctness (small, ships alone):** fix C1/C2 (`setCommissionAmount` posts an accrual/adjustment for the delta; guard `markCommissionPaid`), decide C3 fallback, make C4 preview mode-aware. Tests fail-first.
- **Phase 1 — Compensation + Advances:** `employeeCompensation` + `employeeAdvances` + Team-page salary field + advance form + the 3 new GL accounts + SALARIES→Salaries Expense mapping + permission backfill. **This alone corrects the سلفة treatment.**
- **Phase 2 — Payroll run engine:** runs/items, accrual+payment+advance-offset+commission integration (Option A/B).
- **Phase 3 — Payslips & reports:** payslip PDF/print, payroll register, advance aging, i18n polish.

### Effort & risk (rough)
- Phase 0: ~1 PR, low risk, high value (fixes live GL bugs).
- Phase 1: ~1–2 PRs, medium.
- Phase 2: ~2 PRs, medium-high (GL correctness, OCC on runs).
- Phase 3: ~1 PR, low-medium.

Biggest risks: GL balance correctness across accrue/pay/offset (mitigate with reconciliation tests like the existing `commissionPayableReconciliation`), and OCC contention on the payroll run document (shard or per-item writes).

---

## Implementation status (2026-07-20, PR #125)

### Shipped
- **Phase 0 commission fixes** — C1 (MANUAL accrue-then-pay), C2 (completed AUTO locked; MANUAL editable until an ACTIVE accrual exists — a REVERSED accrual unlocks), C3 (no/zero cost basis ⇒ commission 0 + flagged), C5 (markCommissionPaid accrues first). Cost basis is `sourceCost` for SOURCED vehicles, `purchasePrice` otherwise, and **must be > 0** (shared `vehicleHasCostBasis`, aligned with `computeVehicleCapitalizedCost`).
- **Missing-cost remediation**: once the vehicle cost is fixed, the Commissions page shows the sale as "needs recalculation" and `sales.recalculateCommission` computes + accrues one-shot.
- **Payroll**: employeeCompensation (history-aware — a retroactive run pays the salary in force at that period's end), employeeAdvances (سلفة = recoverable asset), createRun/approveRun/payRun/cancelRun, payroll UI with method selection for advance recovery and run payment.
- **Settlement safety**: `payRun` re-derives everything from CURRENT state at pay time — still-unpaid, still-COMPLETED, non-deleted sales only; advances re-read and the GL posted with actual recovered amounts; item + run totals rewritten to what was actually paid; all-zero payslips post nothing. Cross-period double-pay, direct-pay-then-payroll, cancel-after-draft, and stale-advance scenarios are covered by fail-first tests.

### Deliberate policy choices
- **A run sweeps ALL outstanding unpaid commissions**, not just the period's. Rationale: no commission can be stranded (a period-filtered sweep leaves any commission that missed its window unpayable), and double-pay is impossible because payment re-validates against live state. The period label controls salary selection and run identity only.
- **Payroll permissions are a finance capability**: backfill grants them via `manage:finance` or a default template name match — never from `manage:commissions` alone.

### Known limitations (accepted, documented)
- **No reversal for APPROVED/PAID runs** (cancel is DRAFT-only). An approved/paid run posted real GL entries; reversing needs offsetting entries — manual accounting correction until a reversal flow ships.
- Reverting a PAID commission is fail-closed everywhere (`markCommissionUnpaid` rejects paid commissions server-side; the UI offers no Revert action) — undoing a paid commission requires an accounting reversal.
- Timezone: period end is computed in UTC, not org-local time.

> **Salary double-booking**: a SALARIES-category expense is now blocked whenever the org has active payroll compensation (see the round-2 and round-3 notes). The residual gap is only the reverse order — a SALARIES expense recorded *before* payroll is configured for the same period isn't retroactively caught; the robust fix is a payroll-period-overlap / payroll-run link (deferred).

### Deployment order
1. Merge + `npx convex deploy` (schema + functions).
2. `npx convex run migrateRoles:backfillPayrollPermissions --prod` — REQUIRED, or legacy OWNER roles fail `isSystemOwnerRole()` and nobody sees the payroll page.

## Production-hardening round (2026-07-20) — second deep audit

Fixed:
- **Ex-employee salary**: `createRun` includes only members with an active (non-offboarding) membership. A former employee's final settlement is a manual adjustment, not an automatic sweep.
- **Currency safety**: org currency is locked once any financial record exists (`orgSettings.upsert`); `createRun`/`payRun` reject any compensation/advance whose stored currency ≠ run currency. No conversion is performed.
- **Outbound cheque routing**: payroll payments and advance issuance credit `BANK_ACCOUNT` for CHEQUE (dealership-issued), never `CHEQUES_IN_HAND` (customer cheques held). Shared `disbursementAccountKey`.
- **Accrual-before-payment**: when the payment would post now, every prerequisite salary/commission accrual must already be POSTED; a queued accrual (closed period) blocks payment instead of driving a payable negative.
- **Retro accrual date**: salary/commission accrual is dated to the period end (`run.accountingDate`), so a retroactive run recognizes expense in the month worked, not the approval month.
- **No silent salary fallback**: a period before an employee's first compensation record is simply not paid (was: back-paid today's rate).
- **Separation of duties**: a non-owner cannot set their own salary, advance themselves, or approve/pay a run that includes their own payslip (owner exempt).
- **Salary double-booking**: a SALARIES-category expense is blocked once the org has active payroll compensation.
- **Flag semantics**: `missingPurchaseCost`/`needsRecalculation` only apply when `commissionAmount == null`, so a sale that already carries a commission keeps its Pay action even if the vehicle cost is later cleared.
- **Partial advance recovery** (`recoverAdvance` optional `amount`), **paid method** + **approved snapshot** (`approvedGross/NetMinor`) stored on the run for audit, **integer period validation**, and defense-in-depth zero-line guard in `rulePayrollPaid`.

## Third audit round (2026-07-20, ledger-integrity pass)

Fixed:
- **Partial advance recovery now posts every repayment to the GL.** New `employeeAdvanceRecoveries` table: one immutable row per repayment (direct or payroll), each with its own GL identity (`employee_advance_recovered_<recoveryId>`). The old key was `<advanceId>`, so a second partial repayment was silently dropped, leaving Employee Advances overstated. This also gives per-payslip advance-allocation history.
- **Out-of-order settlement in the outbox** (`payrollPostingBlockedReason`, mirroring the prepaid guard): a queued `PAYROLL_PAID` is HELD until its salary/commission accruals post, and a queued `EMPLOYEE_ADVANCE_RECOVERED` until the issuance posts — so a payable/asset is never cleared before it exists, even when events drain across periods.
- **Advance recovery before issuance posts** is blocked in-mutation when the recovery would post now (`assertAdvanceIssuancePosted`), and held in the outbox otherwise.
- **Retro run commission cutoff**: `collectUnpaidCommissions` excludes any sale with `saleDate > periodEnd`, so a run never recognizes a commission earned after its period.
- **Approval re-derives and freezes each payslip** from live state (commission from live sales, advances from current balances), so the amount accrued to the GL, stored on the item, and in `approvedGross/NetMinor` all agree — a MANUAL commission edited between draft and approval is approved at its live value.
- **Currency-lock bypass closed**: the guard now compares against the effective currency (stored, or JOD default when no settings row exists), so a legacy org with financial records can't set a new currency on its first settings write.
- **`recordAdvance` is idempotent** (`runWithIdempotency` + `idempotencyKey`), so a double-click can't issue two advances/disbursements.
- **Partial repayment exposed in the Payroll UI** (per-advance amount input; blank = full).

## Fourth audit round (2026-07-20, cross-flow integrity pass)

Fixed:
- **Pending accrual keeps its original accounting period (engine-wide).** `postOrEnqueue` now no-ops when an unposted `pendingAccountingEvents` row already holds the same `idempotencyKey`. A commission accrued into a closed month (queued at sale completion) that is re-hooked at payroll approval no longer posts a second, differently-dated event that recognizes the expense in the wrong month while the queued original self-dedupes away. `postAccountingEvent` only ever dedupes against POSTED events, so this pending-side guard was the missing half.
- **Payroll payment can't recover an advance whose issuance is still queued.** `payRun` adds `assertAdvanceIssuancesPosted` (mirrors `assertAccrualsPosted`) when the payment posts now, and the outbox guard for a queued `PAYROLL_PAID` now also holds until each recovered advance's issuance posts — traced via `employeeAdvanceRecoveries.by_payroll_item`. Previously only the DIRECT repayment path checked this, so a payroll recovery could credit Employee Advances below a still-queued debit (negative balance).
- **Approval re-derives salary and revalidates membership.** `approveRun` now re-runs `resolveSalariesForPeriod` (a salary corrected up/down/to-zero between draft and approval is what accrues and is approved — not the stale draft snapshot) and rejects a run whose employee was offboarded/removed after drafting. A draft is no longer treated as frozen authorization.
- **`recoverAdvance` self-recovery blocked + idempotent.** Added `assertNotSelfBeneficiary` (a non-owner payroll clerk can't clear the record of their own debt) and `runWithIdempotency` (a duplicate partial repayment with the same key books one recovery, not two against the re-read balance).
- **Salary double-booking guard applied to expense UPDATE.** Shared `assertSalaryExpenseAllowed` now runs on `expenses.update` against the effective category, closing the PENDING/OTHER → SALARIES+PAID bypass of the create guard.
- **Currency lock includes pending expenses.** A PENDING expense (amount stored, nothing posted yet) now locks the org currency, closing the re-denomination window.
- **Future payroll periods rejected.** `createRun` rejects a period whose month begins after now (the current in-progress month is still allowed).
- **Repayment UI** now uses per-advance payment methods (changing one row no longer changes others), rejects an invalid/zero/negative amount instead of silently recovering the full balance, sends an idempotency key, and disables the row while a repayment is in flight.

Deferred (documented, not blocking a small-dealership launch — each needs schema/architecture work):
- Full **reversal flow** for APPROVED/PAID runs (offsetting GL + operational-state restore). Cancel is DRAFT-only.
- **Mandatory reapproval-on-drift** as a state machine (`NEEDS_REAPPROVAL` + immutable per-item approved amounts). Current mitigation: approval freezes an accurate re-derived snapshot and payment recomputes from live state so the dangerous cases (double-pay, paying a cancelled commission) can't occur; a benign post-approval drift (e.g. an advance repaid directly) still pays the correct live amount without a forced re-approval.
- **Subscription/feature gating** for payroll, or auto-provisioning a minimum ledger + a payroll-ledger reconciliation view for non-accounting plans (product decision). Today payroll queues its GL events for orgs without the accounting feature, but those orgs can't view/redrive the outbox.
- **Commission policy snapshot at completion** (rate/mode/tiers/basis on the sale) so a post-hoc recalculation uses the rules in force at sale time.
- **payrollItemVersions** (draft/approved/paid immutable stages). Advance-allocation history exists via `employeeAdvanceRecoveries`.
- **Employee dimension** on journal lines; **payrollPayments** evidence table (cheque number/bank reference/attachment).
- **Maker–checker split** of `manage:payroll` into prepare/approve/pay. Current control: a non-owner can't act on their own payslip, but can still prepare+approve+pay others'.
- **Employment start/end dates + final settlement** and **salary proration** (mid-period hires/raises pay the full monthly rate).
- Period boundaries in **org-local timezone** (currently UTC).
- **Pagination** on the payroll members list / advances / runs (currently first-100 members, unpaginated advances/runs).
- **Role-name-based backfill** can still grant payroll to a customized role that kept its default name — mitigated (finance/template-name only, never commissions); full fix = exact permission-set fingerprint.

## Fifth audit round (2026-07-20, approval-immutability + disbursement-idempotency pass)

Fixed:
- **Reapproval-on-drift (`NEEDS_REAPPROVAL`).** Payment recomputes each payslip from live state (to avoid double-paying), which meant the cash actually paid could differ from what was approved (a new advance issued after approval, a commission paid/cancelled elsewhere, an advance repaid directly). `payRun` now compares each payslip's live payable against an **immutable per-item approved snapshot** (`approvedGrossMinor`/`approvedNetMinor`, frozen at approval and never overwritten by the paid figures); on any difference the run moves to `NEEDS_REAPPROVAL` and payment is blocked. `approveRun` accepts a `NEEDS_REAPPROVAL` run and re-derives/re-freezes it (keeping the already-accrued salary, since its accrual key is idempotent). The transition is *returned*, not thrown, so it persists (a throw would roll it back). No dead-end: a first DRAFT approval that re-derives to zero is rejected (still cancellable), while a re-approval is allowed to settle to zero and pays as an all-zero (skipped) journal.
- **Zero-value first approval rejected** (`approveRun` from DRAFT): "nothing to approve — cancel and rebuild." Prevents a meaningless approved/paid empty run.
- **Advance issuance is idempotent from the UI.** `submitAdvance` now sends a per-submission `idempotencyKey` and disables the button in flight — closing the duplicate cash-disbursement window (the backend already supported the key; the UI wasn't sending one).
- **Full-repayment retry returns the original recovery** instead of throwing on `RECOVERED`: `recoverAdvance` looks up an existing recovery by `idempotencyKey` up front and returns it, so a retried request with the same key yields the same successful result.
- **SonarCloud cognitive complexity**: `payrollPostingBlockedReason` split into `advanceRecoveryBlockedReason` + `payrollPaidBlockedReason` with a flat dispatcher (addresses the open review thread).

Still deferred (each needs schema/architecture or is a product decision — the reviewer agrees these are P1/P2, acceptable for a controlled small-dealership pilot):
- Full **APPROVED/PAID reversal + replacement** flow (linked reversing entries, restored commissions/advances, reversal period/actor/approver). Cancel remains DRAFT-only.
- **Maker–checker permission split** (`prepare` / `approve` / `disburse` / `manage:compensation` / `manage:advances`); today one `manage:payroll` covers all, with only the self-beneficiary guard.
- **Subscription/feature gating** for payroll or auto-provisioned ledger + reconciliation view for non-accounting plans.
- **Employee employment lifecycle**: effective-dated contracts, proration, leave, final settlement, statutory tax/social-security, overtime/bonuses/deductions.
- **Payment evidence/versioning** (bank reference, cheque number, immutable payslip versions), employee GL dimension, bank-file generation + reconciliation, payroll posting-status (`UNPOSTED`/`PARTIALLY_POSTED`/`POSTED`/`FAILED`) surfacing, pagination, org-local timezone.
