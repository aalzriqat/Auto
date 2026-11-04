# Supplier and sourcing readers need view:cost_price

Status: accepted for the rows marked GATED, including Q1-Q4 (owner: "Yes, gate all"); a short list of same-class readers is still unruled (see Consequences). ADR required before a permission PR by SCRUM-760 c24361. Jira: SCRUM-902 (canonical; SCRUM-903 is a duplicate), follow-up to SCRUM-901 / PR #765. Related: SCRUM-886, SCRUM-869, SCRUM-879 c24467 and c24470.

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
| `dashboard.stats` | profit and cost metrics | view:expenses / reports / finance (cost block) | that any-of AND view:cost_price (else gross basis, no margin) | GATED (Q4, "Yes, gate all"; fail-soft) |
| `supplierCostRecoveries.list`, `listReceipts` | supplier-borne expense owed back | view:finance | both (`STATEMENT_PERMISSIONS`) | GATED (Q1) |
| `reports.getSalesAndProfitReport`, `getInventoryReport` | per-sale cost and profit, per-vehicle `purchasePrice` / `sourceCost` / `totalInvestment` for the whole lot | view:reports | view:reports AND view:cost_price (else `null`) | GATED (Q2; fail-soft null) |
| `accountingReports.supplierPayablesReconciliation`, `supplierReceivablesReconciliation`, `vehicleInventoryReconciliation` | per-currency supplier and inventory totals (one SOURCED car makes the total that car's cost) | view:finance | both (`STATEMENT_PERMISSIONS`) | GATED (Q3; refuses) |
| `accountingLedger.listJournalEntries`, `getJournalEntry` | inventory and payable journal lines | view:finance | both (`STATEMENT_PERMISSIONS`) | GATED (Q3; refuses) |
| `accountingReports.trialBalance` | debit and credit totals of every account, including vehicle inventory and COGS | view:finance | both (`STATEMENT_PERMISSIONS`) | GATED (class sweep; refuses) |
| `accountingReports.incomeStatement` | cost of goods sold and gross margin | view:finance | both (`STATEMENT_PERMISSIONS`) | GATED (class sweep; refuses) |
| `accountingReports.balanceSheet` | vehicle inventory asset line and retained earnings | view:finance | both (`STATEMENT_PERMISSIONS`) | GATED (class sweep; refuses) |
| `accountingLedger.getAccountActivity` | every journal line of one account; the account can be inventory or COGS (the chart is per organization) | view:finance | both (`STATEMENT_PERMISSIONS`) | GATED (class sweep; refuses). Gating by account type would leave the aggregate recoverable and needs a type check per request, so the whole reader is gated |
| `reports.getSalespersonPerformance` | per-rep revenue and profit; profit is revenue less `capitalizedCost` per sale | view:reports | view:reports AND view:cost_price (else `null`) | GATED (class sweep; fail-soft null) |
| `reports.getExpensesReport` | expense rows with the related vehicle; vehicle-linked rows are landed cost per car | view:reports | view:reports AND view:cost_price (else `null`) | GATED (class sweep; fail-soft null). Trade-off: a report-only role loses the operational expense report, as with Q2 |
| `accountingReports.subledgerReconciliation` | AR control accounts against the receivables subledger (customer and finance-company receivables) | view:finance | unchanged | NOT cost-bearing: it reads only AR accounts and customer receivables, no inventory, COGS, supplier or per-car cost. A scenario pins that `view:finance` alone still reads |
| `transactions.list` | `VEHICLE_PURCHASE` rows: `amount` is the purchase price, with the vehicle label | view:finance | view:finance; rows with category `VEHICLE_PURCHASE` are withheld unless the caller holds view:cost_price | GATED (round 3 H1; rows absent, not zeroed). Other categories are not cost. The GL register view shows an English and Arabic note and its totals leave the rows out |
| `reports.getProfitAndLoss` | `costOfGoodsSold`, `grossProfit` | view:reports | view:reports AND view:cost_price (else `null`) | GATED (round 3 H2; fail-soft null) |
| `accountingLedger.listAccountingEvents` | raw event payloads with `costMinor`, `cogsMinor` | view:finance | both (`STATEMENT_PERMISSIONS`) | GATED (round 3 H3; refuses). The release rehearsal reads it as the owner, who passes |
| `expenses.list` | `capitalizedAmount` per row; with a `vehicleId` the rows are the car's landed cost | view:expenses | view:expenses. `capitalizedAmount` is removed from every row for a caller without view:cost_price. A `vehicleId` query needs both | GATED (round 3 H4; field absent, rows kept) |
| `expenses.totalByVehicle` | per-car landed expense total | view:expenses | view:expenses AND view:cost_price | GATED (round 3 H4; refuses). The sale dialog's cost bar skips the query and renders nothing without both |
| `sales.dealCockpit` | `money.profit` lines including `VEHICLE_COST` | view:sales + view:finance | same; `profit` is `{ available: false, reason: "CostAccessRequired" }` without view:cost_price | GATED (round 3 H5; the rest of the cockpit stays) |
| `applications.dealCockpit` (financed) | `money.profit`, `money.managementProfit` | view:finance | same; both are `{ available: false, reason: "CostAccessRequired" }` without view:cost_price | GATED (round 3 H5 sibling) |
| `dealOverview.financedDealOverview` | financed `profit` with the vehicle cost line | view:finance | same; `profit` withheld as `CostAccessRequired` without view:cost_price | GATED (round 3 H5 sibling) |
| `accountingCutover.postedOpeningAllocationReadback`, `financingEconomics.getEconomics` | `landed` / `costMinor` tokens | their own gates | unchanged | Already gated or not a cost surface: the readback holds `landed` only in a status word, and `getEconomics` is gated on cost access (SCRUM-886) |
| `accountingCutover.listOpeningStockChoices` | per-car opening cost `amountMinor` for imported stock | manage:finance | unchanged | RULED OUT, owner to confirm. The amount is the figure finance imported and must exhaust to approve the opening balance. Gating it strands the cutover wizard for a finance role without cost access, and the posted opening journal that shows the same total is already gated. Flagged to the coordinator in the round note |
| `approvals.checkPendingApproval`, `listPendingApprovals`, `listMyPendingApprovals`, `profitApprovalStatus` | deal margin against the minimum profit | view:vehicles / approval permissions | unchanged | DEFERRED to SCRUM-879 (held under SCRUM-886 c24247). Not widened here by instruction |
| `vehicles.getAcquisitionCostCorrectionContext`, `listAcquisitionCorrectionBankOptions` | purchase price and bank options for a cost correction | `COST_CORRECTION_PERMISSIONS` | unchanged | Already gated (the sweep marks them ungated because the gate is a constant it does not match) |
| `supplierReceivables.listReceiptBankOptions`, `changelog.getLatestPublishedAt` | none ("margin" and "landed" match unrelated words) | n/a | unchanged | NOT cost-bearing |

## Consequences

- Permission: both grants required; the system owner passes through `requireTenantAuth`. OWNER, ACCOUNTANT and SENIOR_ACCOUNTANT
  templates hold both (ACCOUNTANT after the SCRUM-886 backfill). Until the backfill runs, an ACCOUNTANT role seeded earlier is refused
  by these readers, as it already is by the statement; this PR must not be released before step 2e of the same deploy.
- Marking a payable paid or recording a receipt needs `manage:finance`, but the screens that offer those actions read the lists, so a
  role without cost access no longer reaches them through the sourcing screen. That is the intended effect; the mutations keep their own gates.
- Screens: the web sourcing page and the mobile sourcing module ask for the same pair before they query, skip the queries otherwise,
  and show a truthful note in English and Arabic ("you need cost-price access to view supplier payables") instead of an error or an
  empty list. The recoveries section (inside the sourcing page) now needs the same pair and renders nothing without it.
- Follow-up (owner ruling "Yes, gate all", Q1-Q4): the sales and inventory reports return `null` without `view:cost_price`; the web
  reports page and the mobile reports module skip those two queries and show an English and Arabic note (mobile tiles show a dash,
  not a zero). The web General Ledger tab shows a note instead of the journal, since its readers now refuse. The reconciliations have
  no screen. `dashboard.stats` already degrades to the gross basis, so the dashboard screen is unchanged.
- Trade-off of Q2: a report-only role loses revenue figures with the cost, because the report is one payload. The alternative is to
  withhold only cost columns; that is a separate change if the owner wants revenue kept.
- Class sweep (owner: "Yes, gate all", not to be asked again): the six readers left open by the first follow-up are classified in the
  table above. Five are gated; `subledgerReconciliation` is not cost-bearing. `incomeStatement` was not on that list but carries COGS, so
  it is gated with them. The web Financial Reports tab and the web and mobile reports screens skip the gated queries and show an English
  and Arabic note; the VAT return tab is unchanged. `getAccountActivity` has no screen.
- Round 3 (both seats, CHANGES_REQUESTED): the class was closed by sweeping every `query(` in `convex/` for `purchasePrice`, `costMinor`,
  `cogsMinor`, `capitalizedAmount`, `capitalizedCost`, `sourceCost`, `VEHICLE_COST`, `costOfGoodsSold`, `grossProfit`, `margin`,
  `landed`, `totalInvestment`, `minimumProfit`, `recognizedCost`, `supplierEntitlement` and `amountDue` (33 readers hit, 24 already
  gated, the 9 others classified in the table). The mechanism is one of three shared checks: `STATEMENT_PERMISSIONS` for refusing
  readers, `canReadVehicleCost` or `role.permissions.includes(VIEW_COST_PRICE)` for fail-soft readers. Absent beats zeroed.
- Round 3 screens: the GL register view shows a note that car purchase rows and the totals leave them out; the sale dialog cost bar
  renders nothing without the pair; the cash and financed cockpits show the profit tile as "needs cost-price access" in English and
  Arabic. Open sibling, not changed: the supplier party outstanding amount inside the cockpits' `parties` block. Mobile accounting
  lists simply omit the withheld rows, and mobile totals are not separately recomputed.
- Still ungated by design: the AR aging and VAT readers (no cost figures). Any reader added later that returns inventory, COGS, supplier
  or per-car cost needs a row in this table.
- Evidence boundary: `convex-test` role fixtures and rendered screens at desktop and mobile widths. No production run.

## Owner questions (decided "Yes, gate all", recorded in SCRUM-902; the text below is the question as asked)

- Q1. Do `supplierCostRecoveries.list` / `listReceipts` (supplier-borne expenses owed back) count as acquisition cost? Consistency
  argues yes: `supplierDueAging.list` already gates the RECOVERY family on the pair, and `outstandingSummary` (gated here) includes recovery totals.
- Q2. Should `view:reports` holders who lack `view:cost_price` see per-vehicle cost and profit in the sales and inventory reports? Gating
  the whole report removes revenue figures they may legitimately need; the alternative is to omit the cost columns, as the vehicle readers do.
- Q3. Are the GL reconciliations and the journal readers accounting-wide views that `view:finance` alone must keep for the accountant's
  close workflow? Gating them could break that workflow, so they stay as they are until the owner rules.
- Q4. `dashboard.stats` already withholds cost metrics from roles without expenses, reports or finance. Should cost-bearing tiles also
  need `view:cost_price`?
