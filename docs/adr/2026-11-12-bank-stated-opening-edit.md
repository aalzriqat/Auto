# A bank's stated opening balance is editable, audited and validated

Date: 2026-11-12. Issue: SCRUM-945 (from SCRUM-944 c24993). Baseline: origin/main 029386d9b.
Status: accepted for implementation, pending independent review.

## Context

The stated opening balance and date of a bank account (`bankAccounts.openingBalanceMinor`,
`openingBalanceDate`) could only be set in the Create dialog. Correcting a mistyped value meant
editing the document by hand in the Convex dashboard, which leaves no trace. The backend mutation
`bankAccounts.update` already accepted both fields behind `MANAGE_FINANCE`, but checked only
`Number.isFinite`, wrote no audit row, and no screen called it.

SCRUM-858 S5 compares this figure with each bank's posted opening line and reports a difference
under the owner's label. So the figure is a control signal: a wrong value shows a false difference,
and silently changing it can hide a real one.

## Invariant

The stated opening is reference metadata. It is never added to any balance, never posts a journal,
and never touches a bank aggregate. `bankAccounts.getBookBalance` returns the same result before and
after an edit, and an edit adds no journal entry or line. The posting engine,
`bankOpeningReconciliation.ts` logic and the aggregates are unchanged. Tests:
`convex/bankAccounts.scrum945.test.ts` and the SCRUM-945 case in
`convex/openingBankReconciliation.scrum858.test.ts` (posted opening, difference cleared by the edit,
journal and line counts unchanged).

## Decisions

D1. Audit. A call to `update` that really changes the amount or the date writes exactly one
`financialAuditLog` row through `auditLog`: new action `UPDATE_BANK_OPENING_REFERENCE`, resource
`bankAccounts`, `before` and `after` of `{ openingBalanceMinor, openingBalanceDate }`, a plain
description naming the bank. No row when neither value changes. The action is classified `FINANCE`
in `AUDIT_READ_POLICY`: the finance-only readers of the bank screen already see the figure, so the
row discloses nothing they cannot read. Precedent: `IGNORE_BANK_STATEMENT_LINE`
(`convex/bankReconciliation.ts`), which also exists so a control signal cannot be cleared untraced.

D2. Validation, in one helper used by `create` and `update`. The amount must satisfy
`Number.isSafeInteger`. Negatives are allowed: an overdrawn bank has a real negative stated balance,
so `isValidMinorAmount` (which refuses them) is not used. The date must be a safe integer with
absolute value at most 8.64e15 ms, the range of an ECMAScript `Date`. Anything else is refused with a
`ConvexError` and nothing is written.

D3. Screen input. The dialog parses the typed amount exactly with `parseOpeningMoneyMinor` (BigInt,
no floating point) at the bank's own currency scale, behind a thin wrapper that allows one leading
minus. It formats the stored value back with the same scale. Too many decimals, non-numbers and
out-of-range values show an inline error and disable Save. The existing parser is unchanged.

D4. Permission is unchanged: `MANAGE_FINANCE` to edit, and the control is shown only to holders of it.
The server still decides.

## Alternatives rejected

- Write to `adminAuditLog` via `writeAuditLog`: that is the platform-admin trail, not the
  organization's finance trail that finance managers and auditors read.
- No audit row: a control signal could be changed, and a difference made to disappear, with no trace.
- Refuse all edits (the direction of open PR #611): this conflicts with the SCRUM-858 S5
  reconciliation, which reads this figure and needs it to be correctable. Flagged for the owner,
  unresolved here. If the owner rules edits out, the screen and the tests are removed together.
- Validate only on the screen: the server is the authority. `v.number()` also accepts fractions,
  NaN and Infinity.

## Consequences

- The schema change is one additive literal in the `actionType` union. Older rows are unaffected.
- The backend must be deployed before the screen works in production. Merged is not deployed.
  Before the deploy the new audit action is also unknown to a production database.
- Edits to name, IBAN, account number and notes remain unaudited, as before.
- The Create dialog still converts the amount with `Math.round(Number(x) * factor)`. Follow-up:
  reuse the exact parser there. The server now refuses a non-integer or unsafe result.
- `convex-test` runs serially: it shows the logic, not production concurrency or OCC.
- Rendered check: static visual gate `playwright/visual/bank-opening-edit.visual.spec.ts`
  (EN and AR, 375 and 1440 px). It is not a check against a real backend.

## Sources checked

Opened and read for this change:

- [MDN, Number.isSafeInteger](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/isSafeInteger):
  safe integers are the integers from -(2^53 - 1) to 2^53 - 1; NaN, Infinity and 3.1 return false.
- [MDN, Date](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date):
  a time value is at most 8,640,000,000,000,000 ms either side of the epoch; outside it the date is
  invalid (NaN).
- [Convex data types](https://docs.convex.dev/database/types): `v.number()` is Float64, which
  supports all IEEE-754 doubles including NaN; the page does not state how Infinity is treated, so
  the repository test (`convex/bankAccounts.scrum945.test.ts`) is the evidence for rejection.
  `v.int64()` (bigint) exists but is not used here.

Not opened: ECMA-262 itself. The MDN pages above are the secondary source for its time-value limit.
These sources support the design; the repository tests establish the behavior.
