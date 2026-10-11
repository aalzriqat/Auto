# SCRUM-815 — forfeiture report closure packet

## Invariant and scope

A posted deposit forfeiture contributes other income on its journal date. A
posted reversal offsets that income on its own date. A held receipt and a refund
contribute no forfeiture income. Turnover is unchanged. This change reads money;
it does not post, move, or reverse money.

The proven discrepancy is in the legacy public backend
`reports.getProfitAndLoss` endpoint. The visible Accounting income statement
uses `accountingReports.incomeStatement` and was already correct. This patch is
not evidence of a changed screen or a deployed backend.

## Impact map

| Area | Path and obligation |
| --- | --- |
| Writers | `releaseHeldDeposit` and slice resolution call `hookDepositForfeited`; `postDomainEvent` writes `accountingEvents`, journal entries, and lines; `reverseAccountingEvent` writes a linked reversal journal. No writer changes here. |
| Readers | `reports.getProfitAndLoss` gains forfeiture income; `accountingReports.incomeStatement` remains the GL comparator. Repository-wide source search found no app/component caller of the legacy endpoint. |
| Historical | Current chart `systemKey` is not stable: `repairMissingSystemAccounts` may clear it on an old account. Read immutable event/journal links and current account type as the GL report does. |
| Transitions | HELD receipt: zero; FORFEITED with pending/failed accounting event: zero until a posted journal exists; posted forfeiture: positive; posted reversal: negative; reversal of reversal: positive. |
| Reversal | Follow `reversalOfEventId` with cycle and depth guards. Count each journal on its own `accountingDate`, including original `REVERSED` journals. |
| Idempotency | The existing posting and reversal writers own event identity. This read-only query counts each persisted posted event once. |
| Authorization | Existing `VIEW_REPORTS` tenant authorization and heavy-read rate limit remain. No new endpoint or client authority. |
| Tenant | Event index is org-scoped; every reversal ancestor, journal entry, line, and account is checked against the same org. |
| Ledger | Read posted journal lines under `OTHER_INCOME` accounts; sum credit minus debit in minor units. The visible GL income statement uses the same account type and posted/reversed journal status. |
| Audit | Existing event and reversal links remain the evidence trail. No audit row is written by this query. |
| UI | Visible Accounting report already shows GL other income. No verified UI change; the legacy API has no source-level app/component consumer. |
| E2E | M486C4 is added to the trusted release rehearsal for an exact-SHA disposable preview. It has only passed against a fake backend locally; platform and browser results remain UNAVAILABLE. |
| Release | Backend is not deployed. SCRUM-486/SCRUM-760 stay open until preview proof and all other gates; no production deploy or readiness claim. |

## Reproduced and tested

- Before the fix, an owned CASH 200 JOD HELD deposit forfeited through the public
  mutation gave 200 JOD GL other income but a 0 JOD operational profit change:
  focused harness suite 26 pass / 1 fail.
- The changed harness suite checks the same public path, receipt turnover stays
  unchanged, and net profit rises 200 JOD. It clears the historical account's
  current system key and requires both reports still to show 200 JOD.
- A separate journal-level test checks the original forfeiture in May, its
  reversal in June, and reversal of that reversal in July. It does not certify
  a no-code business correction flow for a forfeited deposit.
- A faulted posted event with its journal link removed causes the report to
  reject instead of returning a falsely complete total.
- The M486C4 rehearsal checks an owned cash held deposit, creator refusal,
  literal receipt and forfeiture journals, unchanged turnover, 200 JOD other
  income in both report APIs, and one incoming collection with no payout.
  Local negative controls make it fail if the operational API omits income or
  an outbound collection appears. This is fake-backend rehearsal evidence;
  exact-SHA platform execution is still required.
- Convex typecheck and focused money-report suites must be rerun at the final
  frozen SHA. Exact-head platform, UI, and production evidence remain UNAVAILABLE.

## Five ways the fix could be wrong

1. A current account mapping could change after posting and erase historical
   income from a report. The event/journal source and remapping regression
   guard this case.
2. A reversed original journal could be dropped while its inverted journal is
   retained, creating negative income. Both `POSTED` and `REVERSED` journals
   are included; month-specific reversal regression checks this.
3. A second-level reversal could be missed if only direct parent event type is
   checked. The lineage loop and July regression check this.
4. An unrelated or foreign-tenant reversal could be counted as forfeiture.
   Event lineage and org checks guard this; exact-head adversarial review is
   still required.
5. A posted event with missing journal evidence could silently count zero.
   The query fails closed for missing/mismatched entry, line, or account. A
   harness missing-journal negative control passes; real-platform proof remains
   UNAVAILABLE.

## Known limits

The legacy `transactions` table has no currency column. Existing turnover and
expenses in this endpoint are therefore not a complete multi-currency ledger
report. The new forfeiture field exposes amounts by currency and adds only the
organization-currency amount to its legacy top-level net-profit figure; the GL
income statement remains the authority for full per-currency reporting. Broad
windows may hit Convex read limits and must fail rather than return a partial
total. No measured platform I/O claim is made.
