# Supplier and sourcing readers need view:cost_price

Status: accepted for the rows marked GATED; open owner questions are listed at the end. ADR required before a permission PR by SCRUM-760 c24361. Jira: SCRUM-902 (canonical; SCRUM-903 is a duplicate), follow-up to SCRUM-901 / PR #765. Related: SCRUM-886, SCRUM-869, SCRUM-879 c24467 and c24470.

## Context

For a SOURCED (consigned) car the supplier's entitlement equals the acquisition cost, so any per-car supplier amount is cost-derived.
The supplier statement (#763) and `supplierDueAging.list` and the due-alert amount (#765) already require
`STATEMENT_PERMISSIONS = [view:finance, view:cost_price]` (`convex/supplierStatement.ts`). Six sibling readers still authorize on
`view:finance` alone, so a custom role with finance and without cost access reads what the statement refuses (OWASP A01:2021 Broken
Access Control; API3:2023 property level authorization).

Production exposure (SCRUM-902, read-only count 2026-11-04): 5 of 30 roles have `view:finance` without `view:cost_price`, all named
ACCOUNTANT. Owner ruling SCRUM-886: the rollout backfill (Deploy production step 2e) grants exactly those roles `view:cost_price`, so
after that release no production role has finance without cost. Today's exposure is custom roles created later; re-count at the
release window.

## Decision

The six per-car supplier and sourcing readers call `requireTenantAuth(ctx, orgId, STATEMENT_PERMISSIONS)`, importing the one constant,
so every supplier-amount reader shares a single definition and cannot drift. A refusal names the missing permission and returns
nothing, rows and totals alike. `sales.consignedSalePreview` keeps its fail-soft contract (it runs inside the sale dialog, where a
thrown error replaces the page) and returns `null` unless the caller also holds `view:cost_price`; its existing any-of
(`view:expenses`, `view:reports`, `view:finance`) stays as the second half. Completing a SOURCED sale already needs cost access
(SCRUM-886 round 13), so a caller refused here could not complete the sale anyway.

Rejected alternative: redact amounts and keep the rows. A row with a hidden amount still reveals which obligations and cars exist, and
a zero reads as "nothing owed". Absent beats zeroed, as in `vehicleCostVisibility.ts` and ADR 2026-11-04-supplier-due-aging-cost-permission.

## Class table: every cost-derived reader and its gate

| Reader | Cost it returns | Gate before | Gate after | Class |
| --- | --- | --- | --- | --- |
| `sourcingPayables.list` | per-car supplier amountDue, settlement | view:finance | view:finance + view:cost_price | GATED |
| `sourcingPayables.listBounded` | same rows, bounded | view:finance | both | GATED |
| `sourcingPayables.listPipeline` | vehicle `sourceCost` per car | view:finance | both | GATED |
| `sourcingPayables.get` | raw vehicle row: `sourceCost`, `landedCostTotal`, `minimumProfit` | view:finance | both | GATED |
| `supplierReceivables.list` | per-car margin receivable | view:finance | both | GATED |
| `supplierReceivables.outstandingSummary` | per-currency totals incl. recoveries | view:finance | both | GATED |
| `sales.consignedSalePreview` | supplier entitlement and margin for one SOURCED car | any of view:expenses / reports / finance (else null) | that any-of AND view:cost_price (else null) | GATED (fail-soft null) |
| `supplierStatement.outstanding`, `supplierDueAging.list`, due-alert `amount` | supplier A/P, A/R, recoveries | both (#763, #765) | unchanged | already gated |
| `vehicles.*` readers, `vehicleCostVisibility.ts`, landed-cost section | vehicle cost | view:cost_price (SCRUM-886) | unchanged | already gated |
| `dashboard.stats` | profit and cost metrics | view:expenses / reports / finance (cost block) | unchanged | OWNER QUESTION Q4 |
| `supplierCostRecoveries.list`, `listReceipts` | supplier-borne expense owed back | view:finance | unchanged | OWNER QUESTION Q1 |
| `reports.getSalesAndProfitReport`, `getInventoryReport` | per-sale cost and profit, per-vehicle `purchasePrice` / `sourceCost` / `totalInvestment` for the whole lot | view:reports | unchanged | OWNER QUESTION Q2 |
| `accountingReports.supplierPayablesReconciliation`, `supplierReceivablesReconciliation`, `vehicleInventoryReconciliation` | per-currency supplier and inventory totals (one SOURCED car makes the total that car's cost) | view:finance | unchanged | OWNER QUESTION Q3 |
| `accountingLedger.listJournalEntries`, `getJournalEntry` | inventory and payable journal lines | view:finance | unchanged | OWNER QUESTION Q3 |

## Consequences

- Permission: both grants required; the system owner passes through `requireTenantAuth`. OWNER, ACCOUNTANT and SENIOR_ACCOUNTANT
  templates hold both (ACCOUNTANT after the SCRUM-886 backfill). Until the backfill runs, an ACCOUNTANT role seeded earlier is refused
  by these readers, as it already is by the statement; this PR must not be released before step 2e of the same deploy.
- Marking a payable paid or recording a receipt needs `manage:finance`, but the screens that offer those actions read the lists, so a
  role without cost access no longer reaches them through the sourcing screen. That is the intended effect; the mutations keep their own gates.
- Screens: the web sourcing page and the mobile sourcing module ask for the same pair before they query, skip the queries otherwise,
  and show a truthful note in English and Arabic ("you need cost-price access to view supplier payables") instead of an error or an
  empty list. The recoveries section is not changed (Q1).
- Evidence boundary: `convex-test` role fixtures and rendered screens at desktop and mobile widths. No production run.

## Owner questions (not decided here; no code changed for them)

- Q1. Do `supplierCostRecoveries.list` / `listReceipts` (supplier-borne expenses owed back) count as acquisition cost? Consistency
  argues yes: `supplierDueAging.list` already gates the RECOVERY family on the pair, and `outstandingSummary` (gated here) includes recovery totals.
- Q2. Should `view:reports` holders who lack `view:cost_price` see per-vehicle cost and profit in the sales and inventory reports? Gating
  the whole report removes revenue figures they may legitimately need; the alternative is to omit the cost columns, as the vehicle readers do.
- Q3. Are the GL reconciliations and the journal readers accounting-wide views that `view:finance` alone must keep for the accountant's
  close workflow? Gating them could break that workflow, so they stay as they are until the owner rules.
- Q4. `dashboard.stats` already withholds cost metrics from roles without expenses, reports or finance. Should cost-bearing tiles also
  need `view:cost_price`?
