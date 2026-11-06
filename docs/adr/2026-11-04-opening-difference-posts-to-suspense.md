# The opening-balance difference posts to a suspense account

Status: accepted. Owner ruling SCRUM-858 c24449, 2026-11-04 ("Suspense account"). It also applies to SCRUM-852.

## Context

An opening set whose entered lines did not balance was refused with "Manual journal is unbalanced". The owner ruled that
the difference is posted to a suspense account, not to owner's capital, and stays there as an open item until someone
classifies it.

## Decision

- A new system account, `OPENING_SUSPENSE` (code 1900, "Opening Balance Suspense"), is seeded for new organizations. Existing
  organizations get it the first time it is needed (`ensureOpeningSuspenseAccount`).
- `draftOpeningBalance` and `postOpeningBalanceDirect` call `withSuspenseBalancing` before validation. When the entered
  debits and credits differ, it appends one line on the suspense account for the difference: a credit when debits exceed
  credits, a debit otherwise. Per-line validation, the all-zero refusal and the safe-integer guard still apply.
- The suspense line is stored in the draft, so the approver reads exactly what will post. The account's opening policy is
  `LEDGER_ONLY`: it takes no allocation and changes no subledger.
- While the account carries a balance, or its balance cannot be read in full, the close checklist emits
  `OPENING_SUSPENSE_OPEN_WARNING`. Nothing closes the balance to equity. Clearing it to its real accounts needs a manual
  journal. Manual journals are turned off during the pilot (`MANUAL_JOURNALS_PILOT_DISABLED`, both doors refuse), so
  while the pilot lasts nothing can clear the balance and the texts say so. Whether to keep posting to suspense under that
  condition is an open owner question; this change does not enable manual journals or add another route.
- The opening card accepts a valid unbalanced set and shows the amount that will go to suspense.

## Two readings the owner accepted

1. "The opening balances do not balance" means the entered lines do not balance. It does not mean the difference between the
   general ledger and a subledger. That reconciliation difference is still reported under the 2026-10-28 label and is never
   posted.
2. The suspense account is typed asset with a debit normal balance. A credit difference therefore shows as a negative
   balance on that account. No separate liability suspense account exists.

## Not changed

The narrow pilot is unchanged. Receipt, refund and correction stay blocked server-side, and the switches in
`convex/utils/customerCreditPayoutContainment.ts` are untouched.

## Consequences

- A typing error in an opening set now posts instead of refusing. The close warning is the only prompt, so the checklist
  must be read before a period closes.
- The suspense account stays on the balance sheet until a manual journal clears it. That is the intended visibility. During
  the pilot no such journal can be posted, so the balance cannot be cleared until manual journals are enabled by a separate
  owner decision.
- A set whose debit or credit total exceeds `Number.MAX_SAFE_INTEGER` is refused (`OPENING_TOTAL_TOO_LARGE`), because the
  journal validator compares double totals and cannot balance such a set exactly. The suspense difference itself is computed
  exactly (BigInt).
- Read limits: the balance read is bounded at 2,000 journal lines. Past that, the account reads as open.
