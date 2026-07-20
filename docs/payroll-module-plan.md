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
- **Salary double-booking is possible by operator error**: recording a salary through the Expenses page (SALARIES category → immediate Dr Salaries Expense) AND paying the same month through a payroll run books the expense twice. Until a guard exists, orgs using the payroll module should record salaries ONLY through payroll.
- Timezone: period end is computed in UTC, not org-local time.

### Deployment order
1. Merge + `npx convex deploy` (schema + functions).
2. `npx convex run migrateRoles:backfillPayrollPermissions --prod` — REQUIRED, or legacy OWNER roles fail `isSystemOwnerRole()` and nobody sees the payroll page.
