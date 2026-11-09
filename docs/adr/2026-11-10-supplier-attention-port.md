# Supplier attention from authoritative obligation pages

Status: proposed implementation, SCRUM-869 feature 5. Base: `df1fd388bc717dddc946c71fcbde2d3fcf2e8e70`.
Ports `d4c551d2a`, `fb7ec375a`, `dc840b6c3` and the cost gate in
`408857137`, from the never-merged supplier-alerts branch. That branch stays unchanged.
Extends the supplier row-links ADR and SCRUM-868 P4/P5 identity decisions.

## Invariant and role policy

Supplier attention derives from canonical supplier-id obligations and the same
eligibility decision as the in-app reminder sweep. A/P and A/R remain separate.
Names never match records. Every cost-bearing response requires both
`view:finance` and `view:cost_price`, or system owner authority, plus the
accounting plan. Missing permissions withhold the entire response as null.
A nonterminal page is incomplete, never a complete count or total.

## Owner text and alert definitions

SCRUM-869 feature 5 requires "Pilot in-app due/overdue visibility and alerts
for supplier payables/receivables". External messaging is not required.
c23883 specifies three days before due, due day, seven days overdue, then weekly,
in Asia/Amman. It also says disputed obligations remain visible but generate no
ordinary reminder, and an obligation without a due date must not be overdue.
c23906 defines delivery as recorded handover and cleared proceeds as recorded
financier funding. Reuse those existing fact readers without new due rules.

Port `alertStatusFor`: ALERTING has the latest reached schedule step; HELD has
NO_DUE_DATE or DISPUTED; NOT_YET is omitted. Display due date and actual days
overdue beside the schedule label, including days 1 through 6. Eligibility does
not claim a notification was delivered. Preserve the sweep's hold precedence,
step, occurrence, recipient and idempotency behavior.

Id-less rows never appear in a supplier account. A separate presence flag warns
that this organisation has unlinked records in that family, including history.
It names no supplier, shows no amount/count and offers no repair or money action.
SCRUM-858 c23884 requires complete figures or UNAVAILABLE. This panel returns no
aggregate figures. Each listed row retains its authoritative amount/currency.
SCRUM-902 c24475 and SCRUM-869 c24460 require the cost gate.

## Reader census

| Reader | Index and bound | Permission | Returned fields |
| --- | --- | --- | --- |
| supplierStatement.attention, one family per call | vehicleSupplierPayables, vehicleSupplierReceivables or supplierCostRecoveries, existing by_org_and_supplierId_and_status prefix; one native paginate, initial 25, maximum 50 documents and 1 MiB, server clamps caller limits | Authenticated tenant, owned supplier, finance + cost, accounting plan | Nullable response; attention rows with kind/id/currency/outstanding/disputed minor amounts, due date, days overdue, discriminated eligibility; native cursor/split metadata, completeness, unlinked presence. No total/count/net |
| Shared obligation facts | Existing sale get and application get, at most two per page row; tenant check on both; query aborts safely on unreadable facts | Inherits public query or existing sweep gate | Existing due/aging and outstanding facts, projected to attention allowlist |
| Unlinked presence, one family per call | Same index, orgId and supplierId=undefined prefix, first() reads at most one document | Same attention gate | Boolean existence, explicitly organisation-wide and includes history; false means this indexed range is empty, not all identity defects are absent |
| Existing supplierDueAlerts worker | Existing org pagination, membership pages and send budget unchanged | Existing server-resolved recipients and cost redaction unchanged | Existing notifications unchanged; delegates eligibility to ported pure decision |

The existing compound indexes fit supplier and missing-id prefixes, so no index
or schema change is needed. Pagination scans settled rows too; an empty filtered
page with more source rows remains incomplete and offers continuation. No
aggregate is accumulated over pages. The shared page reader retains existing
org-wide callers. It introduces no opening-reader callback or query wrapper hook.

## Impact, time and alternatives

Writers, state transitions, cancellation, reversal, idempotency, ledger and audit
are unchanged: reads post nothing. Historical rows remain unchanged. No migration
runs. The statement, balances and row links keep their contracts. The existing
sweep is the only behavior consumer of the shared eligibility refactor.
UI queries run inline, behind the same permission and plan gates, with independent
family cursors and tenant/supplier-keyed error boundaries. EN/AR use existing
Tailwind tokens, Card/Badge/Button and Money, logical alignment and bidi isolation.
Routine loading/incomplete notices use output; errors use role=alert without focus moves.

The explicit nowMs follows the statement's clock contract, validated within one
day of server time. Refresh hourly and at Amman midnight. A skewed client clock
can still disagree with the sweep within that window; the panel labels its as-of
date and does not control payment authority or promise delivery.

The original bounded all-family projection was considered against native family
pages. Choose family pages to avoid a permanent 100-row cutoff and satisfy this
lane's pagination requirement while retaining the old decision and UI meanings.
Each page independently derives rows; it never turns loaded pages into a total.

## Exclusions

Money writes, settlements, reversal/unwind/correction doors (c23881), A/R and A/P
netting, external notifications, new schedules, P6 journal dimensions, migrations,
backfills, mobile, workflows, release/rehearsal scripts and Playwright files.
Independent seats and real-backend hunters remain coordinator release work.

## Five predicted failures

1. Same-name or id-less rows enter an account. Public-query fixtures include both
   beside linked rows and assert exact returned ids and the separate warning.
2. Finance-only staff receive costs. Assert the entire null response with toEqual,
   plus positive and frontend skip controls, including plan loading/denial.
3. A cut or filtered page looks healthy. Exercise a small page and continuation,
   suppress empty/full claims, expose incomplete, and return no counts or totals.
4. Amman midnight changes eligibility incorrectly. Fake Date around the boundary,
   assert literal due date/days/step, and test client refresh at midnight.
5. Porting changes the sweep or leaks raw errors. Run existing sweep tests,
   cover holds/recovery/schedule steps and malformed stored facts through the
   public query, and require coded generic EN/AR errors with server-only logging.

## Official sources checked 2026-11-10

[Convex indexes](https://docs.convex.dev/database/reading-data/indexes/),
[pagination](https://docs.convex.dev/database/pagination),
[read limits](https://docs.convex.dev/production/state/limits) and
[query auth](https://docs.convex.dev/auth/functions-auth) support indexed prefixes,
bounded native pages and authenticated backend checks.
[WAI alerts](https://www.w3.org/WAI/ARIA/apg/patterns/alert/) and
[status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)
support error announcements and routine updates without moving focus.
These sources guide design; harness tests and synthetic renders do not certify
Convex cloud limits, OCC, production data or the SCRUM-760 launch gate.
