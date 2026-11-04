# Supplier statement, slice 1: outstanding A/P and A/R per supplier

Status: accepted and implemented (slices 1 to 3 on branch claude/scrum869-supplier-statement-4a5e0f; slice 4 on claude/scrum869-settled-history; not yet merged). ADR required before a money or permission PR by SCRUM-760 c24361. Jira: SCRUM-869 feature 1 and 2.

## Context

SCRUM-869 asks for a supplier detail and statement that shows what the supplier owes the dealership (A/R) and what the
dealership owes the supplier (A/P) separately, per currency, with aging. On `origin/main` 33301411 the supplier detail screen
(`components/suppliers/management/SupplierDetailScreen.tsx`) reads only `api.suppliers.get`, the profile. The money exists as
three tables keyed by supplier id (SCRUM-868 P1 indexes `by_org_and_supplierId_and_status`; P3 #732 stamps the id on sale and
settlement writes), and S3a (`convex/supplierDueAging.ts`) reads them org-wide by family. No query reads one supplier.

## Decision

Add one read-only query, `api.supplierStatement.outstanding`, in a new `convex/supplierStatement.ts`.

- Args: `orgId`, `supplierId`, `nowMs` (validated within a day of the server clock, as `supplierDueAging.list` does).
- Auth: `requireTenantAuth(VIEW_FINANCE)` and the `accounting` feature, the same gate as the aging list. The organisation
  comes from `ctx.auth`; the supplier is read with `requireOwnedRow`, so another organisation's id is "not found".
- Reads: the three families through `by_org_and_supplierId_and_status`, one bounded read per OPEN status only (PAID,
  CANCELLED, RECOVERED and REVERSED are excluded by the index, so settled history cannot consume the bound; amended
  2026-11-03 after a failing-first test showed 101 PAID rows made the statement report incomplete). Each family is bounded to
  `STATEMENT_FAMILY_LIMIT + 1` rows. A family with more rows reports `complete: false`; a partial sum is never presented as a
  total (SCRUM-869 W14).
- Rows reuse the S3a row reader (`payableFacts`, `receivableFacts`, `recoveryFacts`, `toRow`), so the due date, rule,
  explanation and aging bucket are identical to the aging screen (W3). Settled and cancelled rows drop out: this slice is the
  outstanding statement.
- Output keeps two sections: `payable` (A/P: vehicleSupplierPayables) and `receivable` (A/R: margin receivables plus cost
  recoveries, each row labelled by `kind`). Each section has its own per-currency totals (gross, disputed, overdue) and its own
  `complete` flag. There is **no net field** anywhere in the result. A supplier with open A/P and A/R in the same currency
  gets two totals that are never combined (invariant W1, owner scenario 5). Currencies are never blended (W7).
- Writes nothing, stores nothing, adds no ledger and no index (W13).

## Not in this slice (remaining gaps, in order)

1. Settled history per supplier: done in slice 4 (amendment below). Still open: payer/payee, payment method and per-payment lines.
2. The statement tab on `SupplierDetailScreen` (EN/AR, RTL): done in slice 1.
3. Settlement allocation proof (done in slice 1); there is no audit entry gap: `markPaid`, `recordPartialPayment` and `setDisputed` already call `auditLog` (`convex/sourcingPayables.ts` lines 506, 672 and 782; SCRUM-879 seat finding L1).
4. Per-supplier reconciliation to GL 2400/1240 (org-wide exists, #744).
5. Informational net position: needs an owner ruling (design packet OQ-4). Not built.

## Consequences

- Cost: one tenant-scoped read per family, bounded; no new index.
- Permission: the query requires `view:finance` and `view:cost_price` (`STATEMENT_PERMISSIONS`). A SOURCED car's supplier
  entitlement equals its acquisition cost, so the amounts are cost-derived and finance access alone must not reveal them
  (SCRUM-886 / ACC-10; seat finding on #763).
- Plan gate: the query requires the accounting feature. The screen reads the plan first and shows a gated note instead of an
  error when accounting is not included.
- Risk: opening-balance rows (`origin: "OPENING"`) and legacy rows carry no `supplierId`, so they do not appear under any
  supplier. They are reported by the registry coverage query (SCRUM-888). The result does not carry this limit, so the screen
  does: an always-visible scope note says opening and unlinked lines are not included, and the empty states say "no
  outstanding lines are linked to this supplier" rather than "nothing is owed".

## Sources

Convex pagination and bounded reads: https://docs.convex.dev/database/pagination and the best-practices page cited in
`convex/supplierDueAging.ts`. Subledger-with-control-account pattern (subledger totals shown beside, never merged into, the
control account) is the standard AP/AR practice; the design packet `docs/architecture/scrum869-supplier-workspace-design.md`
on branch `claude/scrum869-design` holds the full invariants W1 to W16.

## Amendment 2026-11-04: settled history (slice 4)

`api.supplierStatement.settled` shows the cash actually paid to the supplier (A/P) and received from it (A/R), as the same two
sections with the same gate (VIEW_FINANCE, accounting feature, `requireOwnedRow`) and no net field. It reads only the statuses
that can hold settled cash through `by_org_and_supplierId_and_status` (payables and receivables PAID and PARTIALLY_PAID; cost
recoveries RECOVERED and PARTIALLY_RECOVERED, plus DISPUTED payables and receivables, which can be part-paid and are left out only
when nothing was paid; CANCELLED and REVERSED rows are not settlements), so open rows cannot use up the bound. Exhaustive `satisfies Record<status, boolean>`
maps classify every status. Each row carries `dueMinor`, `settledMinor` and `lastChangedAt` (the row's `updatedAt`, which is when
the last payment was recorded for a settled row). Rows come back newest-created first (the index orders by `_creationTime`, not `updatedAt`), bounded to `STATEMENT_FAMILY_LIMIT`
per family; `lastChangedAt` is shown separately. Past the bound `complete` is false, the server returns `totals: []`, and the
screen shows "total unavailable" instead of a total (W14). A row whose settled status
holds no settled amount is left out (data defect, gap 4). Not here: payer or payee, payment method and per-payment lines. Those
live in the settlement and cash-movement records and need their own slice; this query reports the running totals on the row.

Known limit: a row stored as PAID/RECOVERED whose amounts still show a remainder is not read here; that data defect belongs to per-supplier GL reconciliation (gap 4).
