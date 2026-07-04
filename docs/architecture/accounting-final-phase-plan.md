# Accounting Final-Phase Plan (Phases 10–18)

Date drafted: 2026-07-03

Status: Plan. Not yet implemented. Supersedes the "Remaining Risks / Future Work"
sections of `accounting-implementation-progress.md` Phases 7–9 by turning them into
scheduled phases.

## Purpose

Phases 0–9 delivered the double-entry foundation: chart of accounts, periods,
posting engine, versioned posting rules, receivables/payments/allocations
subledger, workflow hooks, a durable posting outbox, reversal engine, manual
journals, migration audit tooling, and ledger-backed reports. This document plans
the remaining work required to move AutoFlow from a strong operational /
management-accounting system to a complete, audit-ready accounting product.

## Findings Validation (2026-07-03)

Each finding was re-verified against current source before planning.

| # | Finding | Verdict | Evidence |
|---|---------|---------|----------|
| 1 | Fixed assets are CRUD-only, no posting | Confirmed | `convex/fixedAssets.ts` is `add/update/remove` only; `purchaseValue: v.number()`; no `postAccountingEvent`/hook calls. |
| 2 | Partner equity directly editable, no events | Confirmed | `convex/partnerEquity.ts` patches `initialCapital`/`currentBalance` directly; schema comment claims auto-calculation but nothing calculates it. |
| 3 | Claims status change posts nothing | Confirmed | `convex/claims.ts` patches `status` with no receivable/payment/journal; `claimAmount: v.number()`. |
| 4 | Manual-journal "approval" is not two-step | Confirmed | Logged as deferred in this doc's CodeRabbit PR#2 section; poster's own request supplies `reviewedBy`, no separate authenticated approve step. |
| 5 | Trial balance mixes currencies | Confirmed | `convex/accountingReports.ts` `trialBalance` groups by `line.accountId` only, then infers display currency from the account. |
| 6 | No full cash-drawer lifecycle | Confirmed (partial exists) | A `cashierReconciliation` submit+review flow exists; open-float → drawer → handover → count → variance → bank-deposit → close (R17) does not. |
| 7 | Provider verification is a generic secret | Largely outdated | `convex/utils/paymentWebhook.ts` already does per-provider HMAC for Stripe and Tap (timestamp tolerance, replay window, constant-time compare), wired into `convex/http.ts`. Residual: only `stripe` + `tap` implemented; other allowlisted providers fall through to "Unsupported"; no RSA providers. |
| 8 | Legacy tables use JS `number` money | Confirmed | `schema.ts`: `purchaseValue`, `initialCapital`, `currentBalance`, `claimAmount` are `v.number()`; GL tables use `amountMinor`. Logged as R10. |
| 9 | Migration tooled but not signed off | Confirmed | `convex/accountingMigration.ts` skips `PARTNER_DRAW`/`CLAIM_PAYMENT` (no rule for category); no production backfill / opening-balance approval / accountant sign-off. |
| 10 | Reports full-scan in memory | Confirmed | `accountingReports.ts` `getPostedLines` collects all entries + all lines then filters in JS; N+1 allocation loops in aging/reconciliation. |

Net: 9 of 10 findings are accurate and match the repository's own deferred-risk
register. Finding 7 is stale — provider-specific HMAC already shipped for the two
live providers; the residual is provider breadth, not the core mechanism.

## Architectural Basis

The posting infrastructure already exists and is proven. The incomplete modules
(fixed assets, partner equity, claims) are not missing an engine — they were never
wired into it. Each remaining module therefore follows the **established pattern**,
which every new phase below reuses:

1. Immutable event/transaction table (append-only, no in-place money edits).
2. New `EventType` + payload interface + versioned posting rule in
   `convex/accounting/postingRules.ts`.
3. Workflow hook routed through `postOrEnqueue` (`convex/accounting/workflowHooks.ts`)
   so events post immediately or durably enqueue to `pendingAccountingEvents`.
4. Replace direct-edit CRUD mutations with event-emitting mutations.
5. New default-chart system keys with an `ensure*` self-heal helper (same pattern
   as `GENERAL_EXPENSE` from Phase 9), so existing orgs backfill without a migration.
6. A phase test file mirroring `accountingPhaseN.test.ts`.

## Sequencing

Ordered by dependency and risk. 10–13 are independent, additive, and each closes a
known gap using the existing engine (highest value, lowest risk). 14 and 16 are
contained correctness fixes. 15 is a new subsystem. 17 and 18 are heavy,
cross-cutting tracks that depend on 11–13 defining target shapes, so they come last.

```text
10  Two-step manual-journal approval
11  Fixed-asset lifecycle
12  Partner-equity transactions
13  Claim receivables + settlement
14  Multi-currency reporting correctness
15  Full cash-drawer sessions
16  Provider verification breadth
17  Legacy money migration + accountant sign-off   (depends on 11,12,13)
18  Report scalability
```

---

# Phase 10 — True Two-Person Manual-Journal Approval

**Status: ✅ Done (2026-07-03).** Implemented as planned: `manualJournalDrafts` table;
`financialAudit.createManualJournal` / `approveManualJournal` / `rejectManualJournal`;
legacy `postManualJournal` removed (no UI depended on it); pending-approval queue UI
added as a new "Manual Journal" tab in the accounting section; tests in
`convex/accountingPhase10.test.ts`.

Rationale: smallest change, unblocks trust in every manual entry, and removes the
one deferred item that directly weakens segregation-of-duties.

## Scope

Replace the single-shot `postManualJournal` (which trusts a poster-supplied
`reviewedBy`) with a create → approve/reject workflow where the reviewer
authenticates and acts themselves.

## Schema Changes

- New `manualJournalDrafts` table: `orgId`, `status` (PENDING_APPROVAL /
  POSTED / REJECTED), `memo`, `lines` (array of {accountId, debitMinor, creditMinor,
  currency}), `currency`, `createdBy`, `createdAt`, `reviewedBy?`, `decidedAt?`,
  `rejectionReason?`, `journalEntryId?`. Indexes `by_org_status`, `by_org_time`.

## Tasks

- `financialAudit.createManualJournal` — validates balance and per-line rules
  (safe integers, not both debit and credit, non-zero), writes `PENDING_APPROVAL`
  draft; does **not** post.
- `financialAudit.approveManualJournal` — authenticated as the reviewer's own
  Clerk identity via `requireTenantAuth(ctx, orgId, [MANAGE_FINANCE])`; asserts
  `reviewer !== createdBy`; posts via the engine; sets draft `POSTED`; writes
  `POST_MANUAL_JOURNAL` audit entry.
- `financialAudit.rejectManualJournal` — reviewer-authenticated; requires reason;
  sets `REJECTED`; posts nothing.
- UI: pending manual-journal queue in the accounting section, reusing the existing
  approvals UI pattern (`vehicleEdits` / `profitApprovalRequests` style).

## Acceptance Gates (target)

- A poster cannot approve their own draft.
- A reviewer without `MANAGE_FINANCE` is rejected.
- Approve posts exactly one balanced journal entry and an audit row.
- Reject posts nothing and records the reason.
- Legacy `postManualJournal` is removed or made an internal shim behind the new flow.

## Tests to Add

`convex/accountingPhase10.test.ts`.

---

# Phase 11 — Fixed-Asset Lifecycle and Depreciation

## Scope

Add capitalization, straight-line depreciation, impairment, and disposal with
gain/loss — all posted to the GL.

## Schema Changes

- Widen `fixedAssets` (widen-migrate-narrow): `costMinor`, `currency`,
  `salvageValueMinor`, `usefulLifeMonths`, `method` (STRAIGHT_LINE), `depreciationStartDate`,
  `status` (ACTIVE / DISPOSED / IMPAIRED), `accumulatedDepreciationMinor` (derived
  cache). Keep `purchaseValue` optional during the transition.
- New immutable `fixedAssetEvents` table: `orgId`, `assetId`, `type`
  (CAPITALIZE / DEPRECIATE / IMPAIR / DISPOSE), `amountMinor`, `currency`,
  `occurredAt`, `accountingEventId?`, `actorId`.

## Default Chart Additions

System keys with `ensure*` self-heal: `FIXED_ASSETS`, `ACCUMULATED_DEPRECIATION`,
`DEPRECIATION_EXPENSE`, `GAIN_ON_DISPOSAL`, `LOSS_ON_DISPOSAL`, `IMPAIRMENT_LOSS`.

## Posting Rules

- `ASSET_CAPITALIZED` — DR Fixed Assets / CR Bank (or AP).
- `DEPRECIATION_POSTED` — DR Depreciation Expense / CR Accumulated Depreciation.
- `ASSET_IMPAIRED` — DR Impairment Loss / CR Accumulated Depreciation (or asset).
- `ASSET_DISPOSED` — derecognize cost and accumulated depreciation, DR Bank for
  proceeds, book the balancing Gain or Loss on Disposal.

## Tasks

- Convert `add/update/remove` money handling to minor units.
- Add lifecycle mutations that emit events + hooks.
- Monthly depreciation cron in `convex/crons.ts`: for each ACTIVE asset with an open
  period, post straight-line depreciation; idempotency key `depr_<assetId>_<yyyymm>`.

## Acceptance Gates (target)

- Capitalization, depreciation, impairment, and disposal each post a balanced entry.
- Disposal gain/loss balances to the difference between proceeds and net book value.
- Re-running the depreciation cron for the same month does not double-post.

## Tests to Add

`convex/accountingPhase11.test.ts`.

---

# Phase 12 — Partner Equity as Immutable Transactions

## Scope

Replace directly-editable capital balances with contribution / draw / distribution
transactions; make `currentBalance` a derived read.

## Schema Changes

- New `partnerEquityTransactions` table: `orgId`, `partnerId` (or `partnerName`),
  `type` (CONTRIBUTION / DRAW / PROFIT_DISTRIBUTION), `amountMinor`, `currency`,
  `ownershipBps?`, `occurredAt`, `accountingEventId?`, `actorId`.
- `partnerEquity.currentBalance` becomes derived (sum of transactions); direct
  patching of `initialCapital`/`currentBalance` is removed.

## Default Chart Additions

`PARTNER_CAPITAL`, `PARTNER_DRAWINGS`, `RETAINED_EARNINGS` (the last is also required
by future period-close).

## Posting Rules

- `CAPITAL_CONTRIBUTED` — DR Bank / CR Partner Capital.
- `PARTNER_DREW` — DR Partner Drawings / CR Bank.
- `PROFIT_DISTRIBUTED` — DR Retained Earnings / CR Partner Capital (or a payable).

## Acceptance Gates (target)

- Contribution, draw, and distribution each post a balanced entry.
- `currentBalance` matches capital − draws + distributions from transactions.
- `partnerEquity.update` no longer accepts direct balance edits.
- Closes the Phase 6 migration `PARTNER_DRAW` skip gap.

## Tests to Add

`convex/accountingPhase12.test.ts`.

---

# Phase 13 — Claim Receivables and Settlement

## Scope

Turn claims into subledger receivables with real settlement postings.

## Schema Changes

- Widen `claims` to minor units (`claimAmountMinor`, `currency`); add
  `receivableDocumentId?` link.

## Tasks

- On claim create → `subledger.createReceivable` (payerType FINANCE_COMPANY).
- On status → PAID → `subledger.recordPayment` + `allocate` + a `CLAIM_SETTLED`
  GL event (DR Bank / CR Finance-company AR), or reuse `COLLECTION_PAYMENT`.
- On status → REJECTED → write-off event (DR write-off expense / CR AR).
- Status becomes event-driven; direct free-form status patching is removed.

## Acceptance Gates (target)

- Creating a claim opens a receivable; paying it settles and allocates it.
- Rejecting a claim writes it off with a balanced entry.
- Closes the Phase 6 migration `CLAIM_PAYMENT` skip gap.

## Tests to Add

`convex/accountingPhase13.test.ts`.

---

# Phase 14 — Multi-Currency Reporting Correctness

## Scope

Stop summing raw minor units across currencies; report per currency or translate to
a reporting currency.

## Schema Changes

- Optional new `exchangeRates` table: `orgId`, `fromCurrency`, `toCurrency`, `rate`,
  `asOfDate`. JOD-only orgs take a no-op fast path.

## Tasks

- Change aggregation key in `trialBalance`, `incomeStatement`, and `balanceSheet`
  from `accountId` to `(accountId, line.currency)`; return per-currency subtotals.
- Add optional reporting-currency translation through defined rates.

## Acceptance Gates (target)

- Two journal lines in different currencies on one unrestricted account are not
  summed as raw minor units.
- JOD-only orgs see no behavioral change.

## Tests to Add

`convex/accountingPhase14.test.ts`.

---

# Phase 15 — Full Cash-Drawer Sessions

## Scope

Extend the existing reconciliation into a full drawer lifecycle (R17).

## Schema Changes

- New `cashDrawerSessions`: `orgId`, `branchId?`, `openingFloatMinor`, `openedBy`,
  `openedAt`, `status` (OPEN / COUNTING / CLOSED / APPROVED), `closingCountMinor?`,
  `varianceMinor?`, `approvedBy?`, `approvedAt?`, `currency`.
- New `cashMovements`: `orgId`, `sessionId`, `type` (SALE / PAYOUT / HANDOVER /
  BANK_DEPOSIT), `amountMinor`, `occurredAt`, `accountingEventId?`.

## Tasks

- Lifecycle mutations: open (with float) → record movements → count → close (compute
  variance) → variance approval (separate approver, reuse `financialGuards`
  separation) → `BANK_DEPOSIT` GL event (DR Bank / CR Cash-on-hand).

## Acceptance Gates (target)

- A drawer session moves open → count → close → approve with variance recorded.
- Variance approval cannot be performed by the person who counted the drawer.
- Bank deposit posts a balanced GL entry.

## Tests to Add

`convex/accountingPhase15.test.ts`.

---

# Phase 16 — Provider Verification Breadth

Rationale: the verification mechanism already exists; this phase is smaller than the
original finding implied.

## Scope

Extend per-provider verification to the providers actually onboarded and fail closed
for the rest.

## Tasks

- Add verifiers in `convex/utils/paymentWebhook.ts` for onboarded providers
  (e.g. Telr / HyperPay signature schemes); add an RSA verify helper alongside
  `hmacSha256Hex` where required.
- Restrict the `convex/http.ts` provider allowlist to providers that have a real
  verifier, so unsupported providers fail closed rather than being allowlisted.

## Acceptance Gates (target)

- Each supported provider validates its native signature, timestamp, and replay window.
- A provider without a verifier is rejected, not silently accepted.

## Tests to Add

Extend `convex/paymentWebhook.test.ts`.

---

# Phase 17 — Legacy Money Migration + Accountant Sign-Off

Depends on Phases 11–13 (target shapes must be defined first).

## Scope

Migrate remaining legacy `number` money fields to minor units and complete a
provable production cutover.

## Tasks

- Widen-migrate-narrow each legacy money table via `@convex-dev/migrations`:
  `fixedAssets`, `partnerEquity`, `claims`, and any other `v.number()` money fields.
- Extend `convex/accountingMigration.ts` posting rules to cover the previously
  skipped `PARTNER_DRAW` and `CLAIM_PAYMENT` categories (unblocked by 12 and 13).
- Add an opening-balance journal workflow plus an accountant reconciliation sign-off
  record (approval + snapshot).
- Add a parallel-reporting comparison query (legacy operational totals vs GL) for the
  cutover period.

## Acceptance Gates (target)

- No operational money table stores a JS `number` amount.
- Migration covers all legacy categories with no permanent `no_rule_for_category` skips.
- An opening balance is posted, approved, and reconciled with a recorded sign-off.

## Tests to Add

`convex/accountingPhase17.test.ts`.

---

# Phase 18 — Report Scalability

## Scope

Remove full-table scans and N+1 patterns from reporting.

## Schema Changes

- New `accountBalanceSnapshots`: `orgId`, `accountId`, `periodId`, `runningDebitMinor`,
  `runningCreditMinor`, updated on post/reverse.

## Tasks

- Reports read snapshot + delta since snapshot instead of collecting all journal lines.
- Replace N+1 allocation loops in aging and reconciliation with an indexed
  allocations-by-org sweep.
- Add pagination / export jobs and cached close snapshots.

## Acceptance Gates (target)

- Trial balance and balance sheet no longer collect all journal lines into memory.
- Report cost scales with account/period count, not total posted line count.

## Tests to Add

`convex/accountingPhase18.test.ts`.

---

## Cross-Phase Risks

- Widen-migrate-narrow on live money tables (Phases 11, 13, 17) must run additively
  first and narrow only after backfill is verified.
- Depreciation and any other cron-driven postings must be strictly idempotent per
  period to survive retries and redrive.
- Removing direct balance edits (Phases 12, 13) is a backward-incompatible mutation
  surface change; UI callers must migrate to the event mutations in the same release.

## Out of Scope (still deferred beyond Phase 18)

- Statutory / tax accounting (VAT returns, withholding, statutory report formats).
- Period-close automation to retained earnings (currently folded into the balance
  sheet pre-close equation).
