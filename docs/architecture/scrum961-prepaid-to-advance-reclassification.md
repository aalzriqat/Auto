# SCRUM-961 — Reclassify employee advances out of an opening prepaid schedule: Invariant Closure Packet

Status: DESIGN ONLY. No production code, no tests, nothing pushed. Worktree `C:\tmp\auto-961r`, branch `agent/scrum-961-prepaid-to-advances`, base `origin/main` d870012d6 (fetched 2026-11-27).
Owner request: SCRUM-961 comments 25989, 26002, 26004 (read in full, with the rest of the thread). Comment 26004 supersedes the partner-drawings line of 26002: Thaer's 150 is treated as an employee advance, capital is not touched.
Draft PR #840 (`origin/codex/scrum961-untouched-prepaid`) was read as a precedent only. It is not revived and not modified.

## 1. Verified facts (production, read-only, Bloom Cars org, 2026-11-27)

Amounts are minor units (1 JOD = 1000). Read through the Convex production read-only connector, bounded queries, nothing written. People are named by first name only.

| Fact | Reported | Verified |
|---|---|---|
| Opening posted, period 2026-11 open | yes | CONFIRMED. One `openingBalanceDrafts` row, POSTED, `autoApproved:false` (two-person), `asOfDate` 1794268800000 (2026-11-10), no `voidRequest`, no `suspenseClassification`. Period 2026 no.2 (start 1793491200000) is OPEN; period no.1 is CLOSED. |
| Prepaid "other establishment expenses" schedule 7,748,000 over 6 months | yes | CONFIRMED. Schedule `zs7byx3s...` (title in Arabic, "other establishment/foundation expenses"), `kind:OPENING`, `expenseSystemKey:GENERAL_EXPENSE`, `totalMinor 7,748,000`, `termMonths 6`, `startYearMonth 2026-11`, ACTIVE. Allocation row `oballoc-20`. |
| One month recognised, 1,291,333 | yes | CONFIRMED. `recognizedMinor 1,291,333`, `monthsRecognized 1`, `lastRecognizedYearMonth 2026-11`. Exactly one POSTED `PREPAID_EXPENSE_AMORTIZED` event (key `prepaid_amort_<schedule>_2026-11`, amount 1,291,333, dated ~2026-11-11, journal JE-P3958J3HPB: Dr General Expenses 6300 / Cr Prepaid 1450). No pending or failed outbox rows, no amortisation failures, no corrections or correction requests. |
| No EMPLOYEE_ADVANCE allocation in the opening | yes | CONFIRMED. Allocations are supplier-recoverable, partner capital, supplier payable, customer deposits, three PREPAID_EXPENSE rows, four vehicles. The opening journal has no line on Employee Advances (1230). |
| Void/repost blocked by later activity | yes | CONFIRMED in kind. Prepaid 1450 has three later amortisation journals, a later ordinary prepaid expense (40,000, expense-backed schedule `zs787e...`, 6,666 recognised) and that one's recognition. `openingLedgerHasActivity` is org-wide anyway. Consequence for design: any "account untouched since opening" test (the SCRUM-829/#840 style creation-order scan) REFUSES on 1450 today. The guard for this change must be scoped to the one schedule's own chain, not to the account. |
| Amer and Thaer exist | yes | CONFIRMED as members (users `amer`, `Thaer`, neither offboarded). Both have an active `employeeCompensation` row, so both are on payroll and payroll recovery is meaningful. Thaer has a separate `partnerEquity` row (opening capital 27,220,900) whose `userId` is unset. The employee advance attaches to his USER, the partner row is not touched. |
| Employee Advances account | n/a | Code 1230, systemKey EMPLOYEE_ADVANCES, control account, manual posting disallowed. 11 ordinary advances exist, all CASH, all OUTSTANDING, recoveredMinor 0, total 600,000, none carries `openingBalanceDraftId`. Payroll: one run, CANCELLED; zero advance recoveries. |
| NEW, not in the report: Amer already has four ordinary CASH advances | not reported | Four rows for Amer: 20,000 + 120,000 + 20,000 + 10,000 = 170,000 outstanding. Thaer has none. If any of those is the same money as the 470, adding 470 would double count. Owner question Q1. |
| NEW: opening balance sheet effect | not reported | The 103,333 true-up raises November profit and equity by 103,333. This is the truthful result, the owner should know it. |

Not verified: that the 620 is in fact inside the 7,748 row (owner's statement, not provable from data: the schedule has no sub-lines); that the 6-month term stays right after removal; the currency of the 620 (assumed JOD, schedule currency is JOD); permissions of the individual finance users (role names only, I did not resolve permission lists); whether two finance+payroll users other than Amer/Thaer exist (three members share one role, unresolved); production behaviour of the engine under OCC (the harness cannot prove it).

## 2. Invariants

Before / during / after, in the order I will test them. "Txn" = inside the one write transaction (re-read there, never trusted from request time).

I1 Ledger exact. The posted event has Σdebit = Σcredit in minor units, every line integer, scale 3, currency = schedule currency = draft currency. Nothing typed by a caller decides an amount, a date, an account or a currency; amounts derive from stored schedule, events and the request's per-person lines (`requireEventPosting` hook re-derives, the SCRUM-1012 mechanism).
I2 Cash, bank, receivable, payable, equity (capital, drawings, partner rows) untouched: the event has no line on 1100/1110/bank/3xxx accounts; `partnerEquity` rows byte-identical (owner ruling c26004).
I3 Prepaid asset and schedule agree after: GL(1450) delta = −(reclass total) + trueUp = −516,667 here, and Σ remaining of ACTIVE schedules moves by the same amount. `prepaidExpensesReconciliation` stays zero-difference; `computePrepaidRecognitionShortfall` stays 0.
I4 Recognised-to-date is derived, never typed: corrected recognised = what the existing monthly algorithm (`amortizeScheduleForMonth`: floor(remaining/remainingMonths), last month absorbs) would have recognised for `monthsRecognized` months on the corrected total over the SAME term. True-up = Σ POSTED amortisation events of this schedule − corrected recognised, must be ≥ 0 and ≤ reclass total, else refuse. `recognizedMinor` must equal Σ posted events and `monthsRecognized` must equal the event count (else the books and the schedule already disagree: refuse, do not paper over).
I5 Future months: after the change the unmodified cron algorithm yields remaining months summing exactly to corrected total − corrected recognised, no residue (section 3).
I6 Each person's advance exists once per request: one `employeeAdvances` row per (reclassification, user), amount = that person's line, `method` and `bankAccountId` undefined (no cash moved), `openingBalanceDraftId` UNSET, new field `prepaidReclassificationId` set, date = the posting date. Σ advance rows = Σ 1230 debits of the event = reclass total.
I7 Recoverable through the existing path: `openingAdvanceBasis` returns a verified non-ORDINARY, non-INVALID basis for these rows, so `recoverAdvance`, payroll runs and the outbox guard (`payrollSourceLedger`) accept them without an EMPLOYEE_ADVANCE_PAID issuance event, and payroll cannot recover before the posting date. A row whose link cannot be verified is INVALID (fail closed), never ORDINARY.
I8 Tied to this correction: the advance row, the request row, the event, the journal and the schedule change reference each other; each link is re-verified by the readers (a marker alone is never authority, same rule as `openingAdvanceBasis` today).
I9 Posted history preserved: no edit of any posted journal or event, the opening journal, its lines, the draft's `allocations`/`allocationResults`, and the original 1,291,333 recognition event stay byte-identical. The change is a NEW linked event/journal. The schedule's `totalMinor`/`recognizedMinor` change is the only mutation of existing money state, and the original amounts stay derivable (allocation.amountMinor is the immutable original).
I10 Idempotent: engine idempotency key `prepaid_reclass_<requestId>` (unique per request, DB-enforced by `by_org_idempotency`); replay of approve returns the same event/journal and creates no second journal, advance or schedule change; replay of request with the same figures returns the same version.
I11 Approval: second authorised person. Project rule found: SCRUM-850 void, SCRUM-829 suspense classification and #840 all require requester != approver (`OPENING_CHANGE_SECOND_PERSON`/`OPENING_SUSPENSE_SECOND_PERSON`), MANAGE_FINANCE, plus MANAGE_PAYROLL when the opening contains employee-advance control (`requireOpeningMaintenanceAuthority`), refused under impersonation (829). I add: neither requester nor approver may be a beneficiary of the advance.
I12 Open period only, rechecked in Txn: posting date = `max(opening asOfDate, latest recognition event date of the schedule)` (derived), its period must be OPEN and must also contain every recognition event being trued up, so that the P&L of the month that was over-expensed is the month that is corrected. Otherwise refuse (no cross-period restatement in v1).
I13 Tenant scoped: every id (schedule, draft, accounts, users, events, journals) is `requireOwnedRow`/org-checked; a foreign org id fails closed; `assertOrgEconomicallyActive`; refused while reset or opening cleanup scans are in progress (`orgResetState`, `openingCleanupPayableScan`, `openingCleanupReferenceScan`).
I14 Eligibility is the schedule's own chain, re-read in Txn: schedule OPENING and ACTIVE, `resolvePrepaidScheduleSource` AVAILABLE, no earlier approved reclassification (v1 allows one per schedule), no pending/failed outbox event with key prefix `prepaid_amort_<id>_`, no open `prepaidAmortizationFailures`, draft POSTED and not voided/requested-void, original journal POSTED and not reversed.
I15 Request snapshot equals Txn state at approval (original total, recognised, months, last month, Σ events, original journal id, accounts); any difference refuses with `OPENING_DRAFT_CHANGED` and a new request is required (829 rule). Closed or no-longer-open period refuses.
I16 Payroll-sensitive data (names, amounts per person, reason) is visible only to MANAGE_PAYROLL readers; journal memo and line descriptions are fixed generic strings (829 payroll-restricted-GL leak lesson, c25318).
I17 Reversibility: the event type refuses generic `reverseAccountingEvent` (same as SCRUM-1012 `LATE_BANK_OPENING_NOT_REVERSIBLE`), because a half reversal would leave advances and schedule disagreeing. A real reversal (not built in v1, section 4) must undo atomically: the journal (linked reversal), every advance row (only if `recoveredMinor 0`, no recovery rows, not deleted), the schedule's total and recognised, the request state; and only while no later recognition and no recovery exists. Until built, a mistake is corrected by a new reviewed change, never by editing.
I18 Economic-guard and census invariants: the new commands appear in `economicCommandCensus`, `tenantWriteGuard`, the blocked-door inventory, SCRUM-486 matrix and a replay scenario; the new table is classified in `purgeImpactMap`, org reset references and org deletion steps.

## 3. Exact journals for Bloom Cars

Accounts by code: 1230 Employee Advances, 1450 Prepaid Expenses, 6300 General Expenses (GENERAL_EXPENSE, the schedule's `expenseSystemKey`).

Arithmetic (minor units):
- original total 7,748,000, term 6, month 1 recognised floor(7,748,000/6) = 1,291,333 (matches production).
- corrected total = 7,748,000 − 620,000 = 7,128,000. 7,128,000 / 6 = 1,188,000 exactly.
- corrected month-1 recognition = 1,188,000. True-up = 1,291,333 − 1,188,000 = 103,333.
- Remaining after correction: 7,128,000 − 1,188,000 = 5,940,000 over 5 months, floor(5,940,000/5) = 1,188,000 each, last absorbs remainder = 0. Σ months 2..6 = 5,940,000 exactly. Check: corrected recognised 1,188,000 + 5,940,000 = 7,128,000 = corrected total.
- Non-dividing illustration (rounding rule): reclass 621,000 gives total 7,127,000; month 1 floor = 1,187,833; remaining 5,939,167 over 5 months: 1,187,833, 1,187,833, 1,187,833, 1,187,834, 1,187,834 = 5,939,167. The rule is the existing `amortizeScheduleForMonth` loop, unchanged: floor(remaining / months left), final month takes the rest.

One engine event (`PREPAID_OPENING_RECLASSIFIED_TO_ADVANCES`, source `openingPrepaidReclassifications`, source id = request id), dated D = max(opening date 2026-11-10, recognition date ~2026-11-11) in the OPEN Nov period:

| Line | Account | Debit | Credit | Note |
|---|---|---|---|---|
| 1 | 1230 Employee Advances | 470,000 | | Amer's advance |
| 2 | 1230 Employee Advances | 150,000 | | Thaer's advance (treated as advance, owner c26004) |
| 3 | 1450 Prepaid Expenses | | 620,000 | removes advances from the prepaid asset |
| 4 | 1450 Prepaid Expenses | 103,333 | | gives back the over-recognised month |
| 5 | 6300 General Expenses | | 103,333 | November expense corrected |
| Total | | 723,333 | 723,333 | balanced |

Net effect: 1230 +620,000; 1450 −516,667; 6300 −103,333; cash 0; equity accounts 0 (November profit +103,333). Prepaid control check: GL 1450 before 17,121,668 = Σ remaining of the four ACTIVE schedules (215,000 + 10,416,667 + 6,456,667 + 33,334); after 16,605,001 = schedule remaining 6,456,667 → 5,940,000 (the others unchanged). Both sides move by 516,667.

Schedule row after approval (same transaction): `totalMinor 7,128,000`, `recognizedMinor 1,188,000`, `monthsRecognized 1`, `lastRecognizedYearMonth 2026-11` unchanged, status ACTIVE. Two `employeeAdvances` rows (470,000 and 150,000, OUTSTANDING, no method).

Opening journal and 1,291,333 event are untouched; the event list shows the original recognition plus the linked reclass event.

## 4. Design options

Precedents studied (protocol: where the invariant comes from, what I do not copy):
- SCRUM-829 `openingSuspenseClassification` + `openingBalanceMaintenance` (request, second-person approve, in-transaction re-inspection, versioned snapshot, replay reader, fixed generic memo, `openingChangeBoundary`). Works because the stored request pins what the approver saw and approval re-derives everything from the posted journal in the same transaction. NOT copied: its "account untouched since opening" creation-order scan (fails on 1450 today), its direct `journalEntries` insert (a direct journal on 1230 makes `employeeAdvancesReconciliation` return SOURCE_FAMILY_UNSUPPORTED, because `evaluateControlProvenance` requires an `accountingEvents` row of the family), its LEDGER_ONLY target policy (1230 is a control account), the field-on-the-draft storage (this change needs several rows).
- SCRUM-1012 late bank opening (`postAccountingEvent` with a new event type, `requireEventPosting` re-derives the payload from stored records, DB-unique idempotency key per bank, event refuses reversal). Works because the posting engine, not the caller, owns amounts and idempotency, and the event gives every reader (provenance, display group, census) one identity. NOT copied: owner-only door, bank specifics.
- `openingAdvanceBasis.ts` (an opening advance is valid only when its row, the immutable allocation and the real posted journal agree; marker alone is never authority). I extend it with a second, equally verified origin instead of writing to the posted draft.
- #840 `openingPrepaidAdjustment.ts` (chain-aware `resolvePrepaidScheduleSource`: original amount plus a verified linked adjustment equals schedule total). Right idea, I reuse it. NOT copied: refusal of any recognition (the case at hand has one), the equity offset account, a single-slot `openingBasisChange` object on the schedule row (cannot hold history or two versions), the `take(3)` cap.

Judged against recognised practice (sources in section 10): a prior misclassification inside an open period is corrected by a dated correcting entry that leaves the original entry and audit trail intact; a re-post of an unrelated, already-used opening is neither possible (activity) nor desirable.

Option A (RECOMMENDED): "Move part of an opening prepaid schedule to employee advances", request/approve, posted through the accounting-event engine. Parameters: schedule id, 1..N lines `{userId, amountMinor}`, reason. Destination fixed (Employee Advances for named employees), source fixed (an OPENING prepaid schedule), not a general account-to-account door. New table `openingPrepaidReclassifications` (one row per request: status PENDING/APPROVED/DISMISSED, version, lines, snapshot, requestedBy, approval {by, at, eventId, journalId, trueUpMinor, accountingDate, advanceIds}). New event type with posting rule, hook proof, reversal refusal. Chain-aware resolvers for prepaid and advance basis. Cost: roughly 12 files plus tests, mostly mechanical registries; the three real risks are the two resolver changes and the provenance family.
  Trade-offs: heaviest, but every consumer (payroll, reconciliations, close checks, reports) sees one verified chain; reuses the certified request/approve shape. Generality: N people is needed already (two). The source stays opening-prepaid-only until a second real use exists.
Option B: general "reclassify part of an opening balance to any allocated control account" door. Rejected: no second real use, every target kind (customer deposit, supplier payable, commission, partner) has its own subledger and its own basis resolver; it widens the attack surface of a pilot release (SCRUM-760).
Option C: narrowest one-purpose command with the Bloom ids/amounts fixed, run once by an operator (internal mutation). Smallest code but it needs the same two resolver changes and the same event/provenance work to leave readers correct, loses the two-person control and the replay/refusal evidence, and is a production data patch without the project's own review shape. Rejected unless the owner prefers speed over control. It would NOT save time on the hard parts.
Option D: void and repost the opening: blocked (`OPENING_VOID_ACTIVITY`), also destroys 1,291,333 posted history. Option E: manual journal: control accounts disallow manual posting, creates no per-employee subledger row, payroll cannot recover. Option F (owner's first idea, reduce prepaid via #840 then add advances manually): records a second CASH payout (`recordAdvance` posts Dr 1230 / Cr cash) for money that left before the opening, understating cash by 620; also #840 cannot true up a recognised month. Rejected (agrees with c25991).

Sub-decisions inside A (my recommendations, orchestrator may overrule):
- D1 engine event, not direct journal (reason above).
- D2 posting date derived, not typed: `max(opening date, latest recognition date)`.
- D3 v1 has NO reversal door; the event refuses `reverseAccountingEvent`; reversal is specified in I17 for a later ticket. Reason: schedule before November close, and each extra door multiplies review surface. Risk accepted: a wrong approval can only be fixed by a new reviewed change.
- D4 `openingAdvanceBasis` returns the existing `{kind:"OPENING", basisDate}` for verified reclass rows so the four consumers (payroll recoverAdvance, assertRecoverableAdvanceBasis, outbox advanceRecoveryBlockedReason, payrollPaidBlockedReason) need no change; no new union member that a consumer could mishandle as ORDINARY. The reclass check runs BEFORE the existing `ORDINARY` shortcut.
- D5 at most one approved reclassification per schedule in v1 (resolver sums one adjustment, not a list).
- D6 do not write to the draft's `allocations`/`allocationResults` (immutable provenance, read by void proof, 858 closure readers and cleanup). The link lives in the new table and on the advance row.

## 5. Impact map

Schema (`convex/schema/*`, `convex/schema.ts`):
- NEW table `openingPrepaidReclassifications` (indexes `by_org_schedule`, `by_org_status`).
- `employeeAdvances`: new optional `prepaidReclassificationId`.
- `prepaidExpenseSchedules` OPENING shape: no new field required (the chain lives in the new table), `totalMinor`/`recognizedMinor` already exist.
- `financialAuditLog` actionType literals: REQUEST/APPROVE/DISMISS_OPENING_PREPAID_RECLASSIFICATION (+ `utils/financialAuditProjection.ts`).

Posting engine (`convex/accounting/*`): `postingRules.ts` (EventType union, `ALL_EVENT_TYPES`, the exhaustive `satisfies Record<EventType, boolean>` tables for AP and supplier-receivable effect, `applyPostingRule` case, new rule), `postingHooks.ts` (+ new `openingPrepaidReclassification.ts` proof module, mirrors `lateBankOpening.ts`), `reversals.ts` (refuse), `journalDisplay.ts` (group PAYROLL), `docs/architecture/accounting-event-matrix.md`, SCRUM-486 oracle doc/row (`docs/architecture/scrum486-certification-oracle.md`, `convex/scrum486Certification.test.ts`).

Readers that must learn the new origin:
- `convex/utils/openingPrepaidBasis.ts` `resolvePrepaidScheduleSource`: replace `allocation.amountMinor !== schedule.totalMinor` by "original − verified approved reduction = total". Every caller depends on it: `amortizeScheduleForMonth`, `catchUpPrepaidSchedule`, `prepaidExpenses.listSchedules/scheduleView`, `accountingReports.computePrepaidExpensesReconciliation` (THROWS for the whole org if any one source is UNAVAILABLE), `computePrepaidRecognitionShortfall` (close blocker), `diagnosePrepaidLedgerIntegrity`.
- `listSchedules` posted/pending sums only count `PREPAID_EXPENSE_AMORTIZED`, so after the true-up "posted" (1,291,333) differs from `recognizedMinor` (1,188,000): add the verified true-up to the posted figure or the dialog shows a false shortfall.
- `convex/utils/openingAdvanceBasis.ts`: new branch (I7). Consumers: `payroll.ts` (`recoverAdvance` ~l.263, `assertRecoverableAdvanceBasis` ~l.721, outstanding-advance selection ~l.752/977), `utils/payrollSourceLedger.ts` (outbox holds).
- `accountingReports.ts`: `SUPPORTED_SOURCE_FAMILIES.EMPLOYEE_ADVANCE` (+ `eventConfirmsOriginal`/`reconciliationEventFamilySupported`) for the new source/event, `readEmployeeAdvancesReconciliation` (rows will sum with the new ones), prepaid reconciliation, `hasQueuedPosting`.
- Opening-closure readers (SCRUM-858) and `openingPayrollVisibility.containsEmployeeAdvanceControl`: payroll-gated visibility for the new request/rows; `openingBalanceMaintenance.status` capability (a new optional section, same permission filter).
- `orgSettings.ts` currency lock (reads `employeeAdvances`): unchanged but listed.

Old code paths that gain a new obligation:
- Opening void/cleanup/reset: `openingVoidCleanup.ts`, `openingVoidReferences.ts` (`assertNoOpeningVoidReferences` must treat the new table/rows as references), `openingResetCleanup.ts` (`OPENING_MATERIALIZED_TABLES` already lists `employeeAdvances` and `prepaidExpenseSchedules`; targets come from `allocationResults`, so the new advances are NOT discovered: the reference scan must refuse or clear them), `utils/orgResetReferences.ts` (declare every new id reference), `adminOrgs.ts` deletion steps, `scripts/orgDeletionCoverage.test.ts`.
- Period close: recognition-shortfall blocker (above), snapshots via `incrementAccountSnapshot` (engine does this).
- Sale/advance reversal: no advance delete/write-off door exists on main (verified by grep for `isDeleted: true`/`WRITTEN_OFF` writers); the new rows are recoverable only through `recoverAdvance` and payroll. Obligation: if a write-off or delete door is ever added it must handle these rows (note in ADR).
- Pilot gates: `convex/utils/purgeImpactMap.ts` (SCRUM-1023: the new table must be classified, census `scripts/purgeImpactMapCensus.test.ts`; the new event/journal are never purge candidates: not a reversed pair), `scripts/economicCommandCensus.ts` (+test), `scripts/tenantWriteGuard.ts` (+test), `docs/pilot/blocked-server-side-doors.inventory.json` and `.md`, contract-skew baselines (`scripts/contractSkew`, regenerated for new `api.*` calls and the new UI form), `convex/_generated/api.d.ts`.
- `docs/adr/2026-11-27-reclassify-opening-prepaid-to-advances.md` (an ADR is required before every money PR).
- Regression library: one money scenario and one permission scenario under `regression/scenarios/{money,permission}/`, plus SCRUM-486 matrix row.

Error codes and strings: new codes in `utils/openingMaintenanceErrors.ts` (e.g. `OPENING_RECLASS_INELIGIBLE`, `OPENING_RECLASS_SECOND_PERSON`, `OPENING_RECLASS_REASON`, `OPENING_RECLASS_LINES`, `OPENING_RECLASS_PERIOD`) and Arabic in `lib/i18n/domains/common.ts` (`ServerError_<code>`); UI strings in the accounting dictionary (EN and AR), plus the contract-skew extraction of new form fields.

UI surface (names to confirm with `graft` in the implementation turn): `components/accounting/PrepaidExpensesTab.tsx` (opening schedule row shows `correctionAllowed:false` today; add "Move part to employee advances" request dialog and a pending-request/approve panel, patterned on `PendingCorrectionRequest` and `OpeningBalanceApprovalPanel`); payroll page advances list (`app/(dashboard)/[orgId]/payroll/page.tsx`) to label these rows as "Opening reclassification"; the opening setup card is not touched.

## 6. Attacks on the design

- Two approvals at once: both read the request row and schedule; Convex OCC serialises, the second finds `approval` set and returns the replay reader result; the DB-unique idempotency key is the backstop (the harness cannot prove OCC; evidence needs the real-backend rehearsal).
- Recognition cron between request and approve: it patches the same schedule row, so OCC orders them. If it ran first, the snapshot comparison (I15) refuses and the request must be redone; the true-up is derived at approval, never copied from the request.
- Payroll run in flight: no run recovers these advances until they exist; approval and a run touching the same advance row serialise on that row. A run created before approval cannot include rows that do not exist; one created after sees OUTSTANDING advances with basis OPENING and basisDate D.
- Partial failure: schedule patch, advance inserts, event posting and request update are one mutation; any throw rolls back all. The engine can queue instead of posting when no open period exists: the command checks the period first and throws if the result has no `journalEntryId` (an UNCAUGHT throw, never caught-and-continued: a caught exception would still commit, see convex-test-harness).
- Replay: request replay returns the same version; approve replay verifies the stored event/journal/advances and returns them; changed arguments with the same identity refuse.
- Period closed between request and approve: the Txn re-reads the period, refuses `OPENING_RECLASS_PERIOD`; nothing written. Cross-period (recognition in a closed month) refuses in v1.
- An advance later recovered/repaid, then reversal wanted: v1 has no reversal; the event is non-reversible; a future reversal must refuse when `recoveredMinor > 0` or recovery rows exist.
- Schedule already fully recognised / cancelled: refuse (status must be ACTIVE; for FULLY_AMORTIZED the correcting entry would be Dr 1230 / Cr expense with no prepaid leg, a different journal, out of scope).
- Amount larger than unrecognised remainder: corrected total must be > 0, corrected recognised ≤ corrected total, true-up in [0, reclass total]; reclass total must not exceed `totalMinor − recognised-corrected` after derivation; else refuse. Reclass larger than the schedule: refused by the same check.
- Wrong person: each user must be an active member of this org, not offboarded, distinct, not the requester/approver; duplicate users merged by refusal not by silent summing; a user of another org refused (tenant check).
- Foreign org ids: schedule, draft, accounts, users, events all org-checked before use; an event/journal with another org's id makes the basis INVALID.
- Impersonation/reset: refused for request and approve (`membership.impersonationGrantId`, `orgResetState`, cleanup scans).
- Shared accounts: unrelated activity on 1450/1230/6300 must NOT block, and must not be consumed: the amounts come from the schedule's own events only.
- Hidden second recognition ledger: an expense-backed schedule on the same expense account is irrelevant by construction (events are matched by `payload.scheduleId` AND idempotency key prefix, both).
- Leakage: finance-only user (no payroll) must not read request lines/reason/advance rows and sees a fixed memo in the GL.

## 7. Five predicted ways this fix could be wrong, and the test that catches each

1. The prepaid resolver is not made chain-aware, or is made so for one caller only. After approval `resolvePrepaidScheduleSource` returns UNAVAILABLE and `computePrepaidExpensesReconciliation` throws for the whole org, the close blocker and the cron stop. Test: after approve, reconciliation returns zero difference, shortfall 0, `listSchedules` source OPENING and posted/recognised consistent, and the next cron month posts exactly 1,188,000.
2. The advance basis returns ORDINARY or INVALID for the new rows. Payroll cannot recover them, or the outbox holds `PAYROLL_PAID`/`EMPLOYEE_ADVANCE_RECOVERED` forever for want of an issuance event. Test: run a payroll run that recovers a reclassified advance end to end (item posted, outbox not held, `recoveredMinor` updated, 1230 credited) and a direct repayment; plus a mutation test: strip the link field and expect INVALID, not ORDINARY.
3. The new journal is not part of the employee-advance source family. `employeeAdvancesReconciliation` becomes UNAVAILABLE (`SOURCE_FAMILY_UNSUPPORTED`). Test: reconciliation AVAILABLE with zero difference with the 11 ordinary rows plus the 2 new ones (Σ 1,220,000), before and after.
4. True-up wrong in sign, size or source (derived from `recognizedMinor` instead of posted events, double counted, or rounded differently from the cron). Test: table-driven numeric cases (7,748,000/620,000 -> 103,333; 621,000 non-dividing; 1-month and 2-month recognised; a schedule whose recognised disagrees with events -> refusal), plus a property test that corrected recognised + Σ later cron months = corrected total for every term 1..12.
5. Replay/concurrency/partial write: second approve, approve after the cron recognised another month, or an engine call that queues, yields a second journal, orphan advance rows, or a schedule changed with no journal. Test: approve twice (one event, two advances, one schedule patch), approve after extra recognition (refused `OPENING_DRAFT_CHANGED`, nothing written), approve in a period that closed (refused), engine returning no journal (throws, zero rows changed), plus real-backend replay evidence through the SCRUM-762 rehearsal.

Further, lower probability: payroll-restricted leakage through GL/readers; foreign-id acceptance; a stale `listSchedules` posted figure; census/inventory files not updated (CI only).

## 8. Test plan

Backend first (convex-test, `convex/openingPrepaidReclassification.scrum961.test.ts` and extensions of existing suites). Each of these is written to FAIL first against current main (no command exists, so the reader assertions fail: UNAVAILABLE/ORDINARY/UNSUPPORTED):
- The Bloom fixture: opening with the 7,748,000 row, one recognised month, 2 members with compensation; request, approve; assert the five journal lines, snapshots, schedule patch, two advance rows, audit rows.
- Readers after approval: prepaid reconciliation, shortfall, employee-advance reconciliation, trial balance, `listSchedules`, GL list with and without payroll permission, cron next month.
- Payroll: recovery run and direct repayment of a reclassified advance; before-basis-date refusal.
- Refusals (each its own test, nothing changed): same user approves, impersonation, no MANAGE_PAYROLL, foreign org schedule/user/account, closed period, period closed between request and approve, recognition changed between request and approve, fully amortised, duplicate/zero/negative/over-amount lines, offboarded user, second request while pending, replay, reset in progress, voided opening.
- SCRUM-486 matrix row and one money + one permission regression scenario (lowest level: backend). Census/guard/inventory/purge tests updated in the same change.
- Mutation-proof the numeric rule and the "OPENING before ORDINARY" ordering in `openingAdvanceBasis`.
- Real backend: the SCRUM-762 rehearsal case for approve replay and approve/cron concurrency (harness cannot prove OCC).
Rendered (never claimed from tests alone): request dialog, pending panel, approve action, refusal states, payroll advances row label; EN and AR, RTL, 1280 desktop and 390 mobile, loading/empty/error/disabled states, for roles: finance+payroll requester, second approver, finance-only (sees nothing). A preview must stay read-only against production services; worktrees cannot run the signed-in app (no Clerk secret by design), so rendered evidence is fixture/test-harness or post-deploy.

## 9. Questions

Owner only (business facts):
- Q1 Amer already shows four ordinary CASH advances totalling 170.000 outstanding. Is any of that the same money as the 470? If yes, the amount to add is smaller (470 less the overlap) and the old rows may need to be closed instead.
- Q2 Are the exact figures Amer 470.000 and Thaer 150.000 JOD, total 620.000 (currency was only assumed)? Is the 620 entirely inside the 7,748 row and is the 6-month term still right for the rest?
- Q3 Who are the two people who will request and approve? Both need finance and payroll permission and neither can be Amer or Thaer (beneficiaries cannot approve their own advance).
- Q4 How should payroll recover each advance (whole amount in one payslip or in instalments, and from which month)? The system recovers what payroll is told; this is a business rule, not code.
- Q5 Confirm the owner is aware that November profit and equity rise by 103.333 JOD from correcting the over-recognised month.
- Q6 Per SCRUM-760 a new financial door needs owner approval before it is enabled for the pilot dealership; confirm that c25989/c26004 is that approval for this specific door.

Mine to decide (recommendations, orchestrator confirms): D1 engine event; D2 derived posting date; D3 no reversal door in v1; D4 reuse `OPENING` basis kind for verified reclass rows; D5 one reclass per schedule; D6 no write to the draft's allocations; plus: who approves the ADR and whether the Gemini seat covers Seat 2 for this money change (memory rule 2026-11-26).

## 10. Sources and what was not checked

Checked this turn:
- Convex OCC and serializability: https://docs.convex.dev/database/advanced/occ (mutations are serialisable; a conflicting commit retries; all-or-nothing writes). Convex limits: https://docs.convex.dev/production/state/limits (per function: 16 MiB read/written, 32,000 documents read, 16,000 written, 4,096 index ranges). The design's reads are a small constant (one schedule, <=20 lines, <=12 events, a few journals), far inside these.
- IAS 8 (ifrs.org page fetched): prior-period errors are restated retrospectively; the page does not cover errors found in the same period. The treatment used here (correct a same-period misclassification by a dated correcting entry in the open period, leave the original entries, re-derive the amortisation true-up) is general accounting practice that I could NOT confirm against a fetched source; I am not presenting it as researched. Documentation supports the design, it does not prove the implementation.
- Project code is judged against the above, not accepted as quality: the 829 direct-journal approach and #840's single-slot schedule field are explicitly not copied.

Not checked: recognised-practice sources beyond IAS 8 and the two Convex pages (no IAS 1/AICPA fetch); Convex indexing/idempotency doc pages beyond OCC and limits; user permission lists; the existing UI components' exact structure (graft names only); real-backend OCC behaviour; whether `postAccountingEvent` returns a journal id for a backdated posting in the open period (assumed from SCRUM-1012, must be shown by the first failing test); coord claim (the session already holds AF-245, refused to open a second one, left untouched).

## 11. As built (2026-11-27, backend only): where the implementation differs from sections 2 to 9

1. I12 posting date. The journal and the advances are dated at approval time (`Date.now()`), not at a derived date. The only date rule is that the approval day's period is OPEN (`PREPAID_RECLASS_PERIOD`). The true-up therefore lands in the period of the approval, not in the earlier month that was over-expensed. A cross-period restatement is not built; a closed approval day refuses.
2. I14 outbox checks. The command does not look for pending or failed `prepaid_amort_<id>_` outbox events or open `prepaidAmortizationFailures`. Eligibility is: schedule OPENING and ACTIVE, the prepaid source resolver returns OPENING, no earlier approved reclassification (`PREPAID_RECLASS_ALREADY`), no other pending request (`PREPAID_RECLASS_PENDING`), and the schedule's stored recognised figure equals what the cron's own rule gives for its months recognised (`PREPAID_RECLASS_INELIGIBLE` otherwise, which also covers a schedule with a failed or skipped month). The amortisation outbox is not read.
3. I4 true-up rule. Recognised-to-date is recomputed with the cron's iterative rule (`share = left <= 1 ? remaining : floor(remaining / left)`), not with the largest-remainder reader (`recognizedThroughMonthsMinor`). The two can differ by a few minor units for totals that do not divide, so the cron rule is the one that makes the next month exact. The shortfall reader at the approval date reports none for every tested case.
4. Errors. Fifteen coded `PREPAID_RECLASS_*` errors with EN and AR strings. Every refusal throws (a caught exception commits in Convex), so a refused request writes nothing.
5. Refused states. A schedule at its last month, a reclassification that is not smaller than the unrecognised remainder (`PREPAID_RECLASS_AMOUNT`), and a true-up that is negative or not smaller than the moved amount are refused.
6. I17 reversal is not built. `reverseAccountingEvent` refuses the event with `PREPAID_RECLASS_REVERSAL`. The specification in I17 is recorded as an obligation in the ADR.
7. I16 visibility. `prepaidReclassificationStatus` returns a restricted shape (eligibility only) to a caller without both finance and payroll management; names, amounts and the reason are returned only to a caller who holds both.
8. Registries as built: `economicCommandCensus` (approve is STATE_GUARDED), `tenantWriteGuard` (+3 analysed), door inventory (three ENABLED_CERTIFIED doors), SCRUM-486 oracle section, purge impact map (REFUSE_IF_REFERENCED, index by_org), reset survivor preflight and known surviving references, org deletion step, opening void reference index, `api.d.ts` (hand-inserted, no codegen run), audit action projection (policy OPENING).