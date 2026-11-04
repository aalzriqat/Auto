# ADR: supplier "needs attention" view, derived from the alert schedule

Date: 2026-11-04
Status: proposed, implemented on branch claude/scrum869-supplier-alerts (stacked on claude/scrum869-gl-reconciliation; not merged). Jira: SCRUM-869 feature 5, "in-app due/overdue visibility and alerts". ADR required before a money PR by SCRUM-760 c24361.

## Context

Push alerts already exist (PR #716, `convex/supplierDueAlerts.ts`): a cron sweep sends in-app notifications at 3 days before the due date, on it, at 7 days overdue, then weekly. A notification is a point-in-time message. It does not tell an operator who opens a supplier which obligations are alerting now, or why one is silent. The disputed hold-back and the missing due date are decided only inside the private `planAlert`.

## Decision

Add a read-only query `api.supplierStatement.attention`. It reuses `readSupplierOutstanding` and returns, per section (A/P and A/R, never combined), the rows whose alert state is not "not yet", each with its state:

- `ALERTING` with the step reached (`T_MINUS_3`, `DUE_DAY`, `OVERDUE_7`, `OVERDUE_WEEKLY`);
- `HELD` with a reason: `DISPUTED` (an amount is under dispute, the sweep sends nothing) or `NO_DUE_DATE` (the sweep cannot alert).

The decision is one pure function, `alertStatusFor`, in `convex/utils/supplierDueAlertPlan.ts`. `planAlert` in the sweep is changed to call it, so the screen and the sweep cannot disagree. This is a refactor of the eligibility test only; the step schedule, idempotency keys and recipients are unchanged.

No scheduler, cron, notification write or schema change is added. The organization comes from `ctx.auth`. Gate: VIEW_FINANCE, the accounting feature, supplier through `requireOwnedRow`, the same clock check as `outstanding`.

## Invariants

- A1. The screen's alert state equals the sweep's decision for the same row and day: one function decides both (tested by driving both from the same rows).
- A2. A/P and A/R stay in separate sections; no net, no currency blending (W1, W7).
- A3. Amounts are the gross outstanding with the disputed part shown separately, as in the statement.
- A4. Bounded: the section's `complete` flag is passed through; an incomplete read is never presented as the full list (W14).
- A5. Read-only: nothing is written, nothing is scheduled.

## Impact map

- Changed: `planAlert` calls `alertStatusFor` (same behavior). The existing 376-line sweep tests must pass unchanged.
- New: `alertStatusFor` and its tests; `attention` query; a small "Needs attention" block and `SuppliersStmtAttn*` keys.
- Not touched: the schedule, the cron, recipients, schema, posting rules, `customerCreditPayoutContainment.ts`.

## Five ways this could be wrong

1. The refactor changes what the sweep sends. Answer: the existing sweep suite runs unchanged, and a new test pins that a disputed and a no-due-date row are held while the same row undisputed alerts.
2. The screen shows ALERTING for a row the sweep skips, for example a feature-gated org. Answer: the query has the same accounting-feature gate; the sweep's other skips (no recipients, send budget) are delivery facts, not obligation state, and the screen says "alerting", not "sent".
3. A day-boundary mismatch. Answer: both use `daysOverdue` from `readRow` (Amman calendar day), so they share one clock input.
4. A supplier over the read bound shows a partial list as complete. Answer: `complete` is passed through and the UI says the list is partial.
5. A disputed row looks silently healthy. Answer: it is listed as HELD DISPUTED, which is the point of the view.

## Not covered, stated

- Whether a notification was delivered or read.
- Receivables of kind RECOVERY use the same state function; no separate rule.
- Not proven on a live Convex backend or in a browser until rendered.
