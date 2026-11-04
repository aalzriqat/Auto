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
| `expenses.list` | vehicle-linked amounts and tax reconstruct capitalized cost, even when `capitalizedAmount` is removed | view:expenses | A `vehicleId` query needs cost access. Without it the unfiltered page omits every vehicle-linked row before hydration; non-vehicle rows remain, without `capitalizedAmount` | GATED (round 5 F5; cursor metadata preserved). Removing just one field was insufficient |
| `expenses.totalByVehicle` | per-car landed expense total | view:expenses | view:expenses AND view:cost_price | GATED (round 3 H4; refuses). The sale dialog's cost bar skips the query and renders nothing without both |
| `sales.dealCockpit` | `money.profit` lines including `VEHICLE_COST` | view:sales + view:finance | same; `profit` is `{ available: false, reason: "CostAccessRequired" }` without view:cost_price | GATED (round 3 H5; the rest of the cockpit stays) |
| `applications.dealCockpit` (financed) | `money.profit`, `money.managementProfit` | view:finance | same; both are `{ available: false, reason: "CostAccessRequired" }` without view:cost_price | GATED (round 3 H5 sibling) |
| `dealOverview.financedDealOverview` | financed `profit` with the vehicle cost line | view:finance | same; `profit` withheld as `CostAccessRequired` without view:cost_price | GATED (round 3 H5 sibling) |
| `sales.dealCockpit`, `applications.dealCockpit`, deal overview financial summary (`parties` block) | supplier party outstanding `amountMinor` (SOURCED: supplier entitlement is cost, margin is price minus entitlement) | view:sales + view:finance | same; the SUPPLIER row keeps its position and loses `amountMinor` (`null`) without view:cost_price | GATED (cost-derived). The cockpit shows the row without a figure and does not mount the supplier settlement dialog |
| `accountingCutover.postedOpeningAllocationReadback` | `VEHICLE_INVENTORY` row `amountMinor` and vehicle `partyId` | view:finance | view:finance; returns `null` without cost access | GATED (round 5 F2). Previous classification was wrong: inspect returned allocations, not matching words |
| `financingEconomics.getEconomics` | acquisition cost fields in projected application | view:finance_applications | existing role projection (SCRUM-886) | Already gated |
| `accountingCutover.listOpeningStockChoices` | per-car opening cost `amountMinor` for imported stock | manage:finance | manage:finance + view:cost_price, refused otherwise | GATED (owner c24475 "gate all"). After the SCRUM-886 backfill the finance roles that run cutover (accountant, senior accountant, manager, owner) hold view:cost_price. `openingBalanceStatus` returns `canReadOpeningStockCost`; the allocation editor skips the query without it and shows an EN/AR note instead of an empty picker |
| `approvals.checkPendingApproval`, `listPendingApprovals`, `listMyPendingApprovals`, `profitApprovalStatus` | deal margin against the minimum profit | view:vehicles / approval permissions | unchanged | DEFERRED to SCRUM-879 (held under SCRUM-886 c24247). Not widened here by instruction |
| `vehicles.getAcquisitionCostCorrectionContext`, `listAcquisitionCorrectionBankOptions` | purchase price and bank options for a cost correction | `COST_CORRECTION_PERMISSIONS` | unchanged | Already gated (the sweep marks them ungated because the gate is a constant it does not match) |
| `supplierReceivables.listReceiptBankOptions`, `changelog.getLatestPublishedAt` | none ("margin" and "landed" match unrelated words) | n/a | unchanged | NOT cost-bearing |

### Remaining readers and mutation responses

| Reader | Cost surface | Previous authority | Authority / projection now | Disposition |
| --- | --- | --- | --- | --- |
| `financingEconomics.supplierConcessionBasis` | `entitlementMinor` equals the sourced vehicle cost | finance applications + finance | same AND view:cost_price | GATED (F1); cockpit skips without the grant |
| `financingEconomics.resolveAppraisalGap` | equality oracle in observed entitlement and concession bounds | approve finance application + finance | cost grant required before reading the application when a concession or observed entitlement is supplied | GATED (F1); ordinary resolutions retain their authority |
| `accountingCutover.listPendingOpeningBalanceDrafts` | raw allocations, enriched allocations, and balancing inventory lines reconstruct per-car cost | manage:finance | same; returns `[]` without cost grant | GATED (F2); the Setup screen shows an EN/AR note. The whole draft is withheld because line subtraction bypasses per-row hiding |
| `accountingOutbox.listPending` | raw event payload with vehicle id, `cogsMinor`, `costMinor` | view:finance | finance AND cost | GATED (F3), with and without status filter. No direct screen consumer found among the indexed callers |
| `sourcingPayables.recordPartialPayment` | refusal `due`/message; success or replay `amountPaid` and `remainingAmount` | manage:finance | writes retain their authority; no-cost overpayment gets only generic coded EN/AR text; successful response is `{}` without cost | GATED (F4). Response projection runs after idempotency replay, so revoking a grant cannot expose cached figures |
| `sourcingPayables.markPaid` | caller-supplied `expectedSettlementAmountMinor` equality check | manage:finance | cost required if observed amount is supplied | GATED (sibling oracle). Calls without an observation keep their authority and return no figure |
| `sourcingPayables.setDisputed`, `listPaymentBankOptions` | status/id or eligible bank list | existing gates | unchanged | No cost amount returned; payment/refusal sibling inspection |
| `supplierReceivables.recordReceipt` | over-receipt text names claim total; successful/replayed remaining margin reconstructs cost from sale price | manage:finance | no-cost refusal is generic EN/AR; response retains status and omits amount fields after replay | GATED (sweep); authorized figures unchanged |
| `supplierCostRecoveries.recordReceipt` | remaining cost and accumulated recovery per car, including replay | manage:finance | response keeps receipt id/status; amount fields absent without cost, projected after replay | GATED (sweep); writes and durable result unchanged |
| `supplierCostRecoveries.reverseReceipt` | remaining vehicle cost if activated | manage:finance | existing server-side pilot refusal before reads, writes or replay | BLOCKED, not certified for activation. Cost projection must be added before reopening this door; no switch changed |
| `applications.setSupplierSettlementRoute`, `financingEconomics.approveDealerPurchaseAmount` | shared below-entitlement refusal named cost and difference | existing gates | amount-free coded EN/AR refusal for every caller | REDACTED (sweep) at `directSettlementBelowEntitlementRefusal`; comparison and financial effect unchanged |
| `accountingMigration.backfillVehicleInventoryOpeningBalances` | per-car `amountMinor` in dry-run and write results; failure reason may contain amounts | manage:finance | result omits amount and reason without cost grant | REDACTED (sweep); migration work and counts unchanged |

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
- Round 3 (both seats, CHANGES_REQUESTED): the round used a lexical sweep of `query(` in `convex/` for `purchasePrice`, `costMinor`,
  `cogsMinor`, `capitalizedAmount`, `capitalizedCost`, `sourceCost`, `VEHICLE_COST`, `costOfGoodsSold`, `grossProfit`, `margin`,
  `landed`, `totalInvestment`, `minimumProfit`, `recognizedCost`, `supplierEntitlement` and `amountDue` (33 readers hit, 24 already
  gated, the 9 others classified in the table). The mechanism is one of three shared checks: `STATEMENT_PERMISSIONS` for refusing
  readers, `canReadVehicleCost` or `role.permissions.includes(VIEW_COST_PRICE)` for fail-soft readers. Absent beats zeroed.
- Round 3 screens: the GL register view shows a note that car purchase rows and the totals leave them out; the sale dialog cost bar
  renders nothing without the pair; the cash and financed cockpits show the profit tile as "needs cost-price access" in English and
  Arabic. The supplier party amount in the cockpits' `parties` block is withheld (null) without view:cost_price. The opening-stock picker is skipped client-side with a note. Mobile accounting
  lists simply omit the withheld rows, and mobile totals are not separately recomputed.
- Still ungated by design: the AR aging and VAT readers (no cost figures). Any reader added later that returns inventory, COGS, supplier
  or per-car cost needs a row in this table.
- Evidence boundary in this lane: `convex-test` role fixtures and jsdom components. No rendered desktop/mobile browser or production run.

## Owner questions (decided "Yes, gate all", recorded in SCRUM-902; the text below is the question as asked)

- Q1. Do `supplierCostRecoveries.list` / `listReceipts` (supplier-borne expenses owed back) count as acquisition cost? Consistency
  argues yes: `supplierDueAging.list` already gates the RECOVERY family on the pair, and `outstandingSummary` (gated here) includes recovery totals.
- Q2. Should `view:reports` holders who lack `view:cost_price` see per-vehicle cost and profit in the sales and inventory reports? Gating
  the whole report removes revenue figures they may legitimately need; the alternative is to omit the cost columns, as the vehicle readers do.
- Q3. Are the GL reconciliations and the journal readers accounting-wide views that `view:finance` alone must keep for the accountant's
  close workflow? Gating them could break that workflow, so they stay as they are until the owner rules.
- Q4. `dashboard.stats` already withholds cost metrics from roles without expenses, reports or finance. Should cost-bearing tiles also
  need `view:cost_price`?

## Round 5 sweep and evidence boundary (SCRUM-902 c24475)

The implementer scanned 764 exported registrations spelled `query`, `mutation`, or `action` in non-test TypeScript under `convex/`, excluding `_generated`.
A TypeScript AST scan found 45 lexical candidates for purchase price, source cost, COGS, entitlement, capitalized cost, and remaining-amount fields.
A second pass inspected query names and bodies for vehicle, profit, supplier, cost, expense, inventory and landed references and inspected the known raw-allocation/outbox readers.
This is a source scan, not a proof that aliases, dynamically constructed responses, arbitrary free text or helper-returned fields are absent.
The original five findings themselves show why token matching alone cannot certify a reader.

| Additional inspected surface | Classification / disposition |
| --- | --- |
| `accountingMigration.backfillFixedAssetMinorUnits`; `fixedAssets.capitalize`, `remove`, `impair`, `dispose` | Fixed-asset cost, not vehicle acquisition cost. Mutation outputs are migration counts/ids; no vehicle cost figure identified |
| `customerFinanceCompanyPayments.confirmPayment`; `openingCommissionLiabilities.list`; `prepaidExpenses.listSchedules` | Customer finance, payroll commission or non-vehicle prepaid balances; `remainingMinor` is not vehicle acquisition cost |
| `sales.update`; `vehicleEdits.requestCreate`, `resolve`; `vehicles.create`, `createSourced` | Cost tokens occur in input validation/writes; responses are ids or status. Existing cost-field write authorization remains outside this read-only change |
| `vehicleEdits.requestUpdate`; `vehicles.update`, `upsertLandedCosts`, `correctAcquisitionCost`, `importBulk` | Existing cost guards/projections; mutation costs are inputs or guarded correction context. Not newly certified here |
| `vehicles.exportData`, `getAcquisitionCostCorrectionContext`, `listAcquisitionCorrectionBankOptions`; `sales.getBillOfSaleEconomics`; `dealWorkspace.financedDealCockpit` | Existing server projections/gates, or delegation to the already projected cockpit; no replacement reader introduced |
| `vehicles.getPricingHistory`, `getReservationHistory`, `selectorOptions`, `getAgingBuckets`, `getPurchaseCostLockState`; `vehicleRequests.listPending` | Asking/list price, reservation/status/identity or cost-lock boolean; no purchase-cost figure identified in these response allowlists |
| `accountingCutover.listOpeningAccountPolicies`; supplier/payment bank-option readers; supplier registry list/search/get/candidates | Policy, bank or supplier identity; no per-car cost amount identified |
| `adminData.adminGetRecord`, `adminOrgs.getOrgDetail` | Administrative surfaces, outside tenant-reader certification in this PR; no claim that tenant `view:cost_price` gates arbitrary admin reads |
| `approvals.checkPendingApproval`, `listPendingApprovals`, `listMyPendingApprovals`, `profitApprovalStatus`, `requestProfitApproval` | Existing explicit SCRUM-879 / SCRUM-886 c24247 deferral; not changed |
| `workOrders.list` | CLOSED: server requires `view:vehicles` AND `view:cost_price` before either list branch; raw tasks, parts/labor costs and total are withheld by refusal. Both branches reproduced at 24869050 and covered by non-owner positive controls |
| `financeDealCosts.listDealCosts` | CLOSED: server requires `view:finance_applications` AND `view:cost_price` before application lookup or cost loading. Whole-reader gate prevents acquisition lines and aggregate/custody operands from disclosing cost. Cockpit skips the query without cost access and shows the existing EN/AR `HandoverCostsUnavailable` note |
| `openingManagementSettlement.report` | CLOSED: server requires `view:finance` AND `view:cost_price` before date/basis checks or the income statement; refusal discloses no amount. Management panel skips this report without the grant and shows the existing EN/AR financial-statement access note |

Repeated failure evidence: c24487 (event payload/capitalization readers missed) and c24507 (outbox/raw allocation/refusal/unfiltered readers missed).
The `correct` skill prevention here is behavioral tests at public functions, including grant revocation between a payment and its replay.
A central schema/lint authorization redesign is a separate reviewed change; this lane does not infer policy from field spelling.
No whole-repository closure, production authorization, concurrency, rendered browser or cloud-runtime verification is claimed.

### Remaining sweep closure at 24869050 (SCRUM-902 c24475)

Acquisition-cost classification follows the economic meaning, not the fee label or payer. A line carrying the vehicle acquisition amount or its supplier entitlement is cost-class, including `CAPITALIZED_TO_VEHICLE` lines and their estimated/actual amounts. An ordinary licensing, transfer, insurance or finance-company service fee is not acquisition cost merely because it belongs to a deal. The fee schema has no dedicated supplier-entitlement fee type; arbitrary `OTHER_CLOSING_EXPENSE` text cannot establish that an amount is safe to disclose.

The selected mechanism gates the bundled `listDealCosts` reader rather than guessing from labels. Its raw lines, total actual/estimated costs, expected/actual differences and custody balances share one response. Withholding an acquisition line while leaving those operands can reconstruct its amount. Consequently a role without the cost grant also loses ordinary fees in this payload; they are not reclassified as acquisition cost. A separately projected ordinary-fee reader would be a different change. Authorized fee facts, writes, posting rules and custody arithmetic are unchanged.

The guards run inside each public Convex function using the existing tenant authorization helper. This follows [OWASP authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html), especially per-request checks and server-side enforcement, and [Convex auth in functions](https://docs.convex.dev/auth/functions-auth). Client skips prevent render-time errors; they do not enforce the boundary. Approval readers retain the SCRUM-879 deferral.

Red evidence: at unchanged production source 24869050a64b075faed726db606999d770694c7b, both `workOrders.list` branches and `financeDealCosts.listDealCosts` resolved with figures instead of refusing. The management report also resolved instead of refusing after the non-owner cost grant was revoked. Test commit `edac80ff3` records these four cases. A first finance-fixture attempt omitted the required `source` field; after correcting that fixture, its negative assertion reproduced the actual disclosure. The existing custody-viewer and readable cockpit fixtures now hold cost access so their original read assertions still exercise privacy, workflow and write-permission boundaries; the new no-cost roles reproduce the removed authority explicitly. The work-order cases use static registrations with the same shared assertions because the permanent scenario library rejects parameterized bindings.

This is a HIGH permission fix. Five predicted failure modes were checked: the unfiltered work-order branch bypasses a per-vehicle guard; aggregate operands reconstruct a hidden acquisition line; a custom role passes through a display-name assumption; grant revocation discloses report/basis details; and a skipped query leaves the cockpit loading indefinitely. The four backend cases and the management/cockpit component checks cover those boundaries. The financial impact map is read-only: no schema, index, posting hook, bank movement, tax, reversal, idempotency record, scheduler, lifecycle transition or stored cost is changed. The three existing original permission gates remain required. The approval-reader deferral stays unchanged. This is implementer evidence for the coordinator's fresh seats, not independent certification.

### Remaining sweep validation commands

Every Vitest command below used `--maxWorkers=1`; no watcher or dev server was started.

| Command | Result |
| --- | --- |
| `pnpm exec vitest run convex/costSweep.scrum902g.test.ts convex/openingManagementSettlement.test.ts --maxWorkers=1 -t SCRUM-902` at unchanged production source | Four failures initially, including one invalid fee fixture. After adding its required `source`, the named cost-sweep file produced three intended disclosure failures; the management report failure was already reproduced |
| `pnpm exec vitest run convex/costSweep.scrum902g.test.ts convex/openingManagementSettlement.test.ts --maxWorkers=1` after guards | 49 passed |
| `pnpm exec vitest run components/accounting/OpeningManagementSettlementPanel.test.tsx components/applications/cockpit/DealCockpitSupplierAuthority.test.tsx convex/financeDealCosts.test.ts convex/dealCustodyAccounting.test.ts convex/workOrders.test.ts --maxWorkers=1` | 277 passed, two custody-fixture failures. Their original assertions were retained and the reader fixture gained the required cost grant |
| `pnpm exec vitest run convex/costSweep.scrum902g.test.ts convex/openingManagementSettlement.test.ts convex/dealCustodyAccounting.test.ts components/accounting/OpeningManagementSettlementPanel.test.tsx components/applications/cockpit/DealCockpitSupplierAuthority.test.tsx scripts/regression/scenarioRecord.test.ts --maxWorkers=1` | 303 passed, one library failure caused by prose in new scenario values; corrected to tokens |
| `pnpm exec vitest run scripts/regression/scenarioRecord.test.ts components/applications/cockpit/DealCockpitSupplierAuthority.test.tsx components/applications/cockpit/DealCockpitReviewParity.test.tsx --maxWorkers=1` | 265 passed, 28 failed: 27 readable-fixture expectations lacked the new cost grant; one library check required static test registrations. No assertion was removed |
| `pnpm exec vitest run scripts/regression/scenarioRecord.test.ts components/applications/cockpit/DealCockpitReviewParity.test.tsx --maxWorkers=1` after readable-fixture update | 259 passed, one remaining library registration failure |
| `pnpm exec vitest run convex/costSweep.scrum902g.test.ts scripts/regression/scenarioRecord.test.ts components/accounting/OpeningManagementSettlementPanel.test.tsx components/applications/cockpit/DealCockpitSupplierAuthority.test.tsx components/applications/cockpit/DealCockpitReviewParity.test.tsx --maxWorkers=1` after static registrations | 308 passed. Includes the four scenario records, EN/AR management notes, cost-query grant controls, cockpit access note, and 198 cockpit parity tests |
| `pnpm typecheck` | Passed. Root tsconfig excludes `convex`, `test-utils`, `apps`, `packages`, `dealer-worker`, and `node_modules` as roots. Imported dependencies can still be checked |
| `pnpm typecheck:convex` | Passed. Includes Convex and test-utils; excludes `_generated` as roots. Does not check web/mobile applications |
| `pnpm exec eslint` on changed TypeScript/TSX files, with a final targeted repeat on the cost-sweep test and cockpit source/parity test | Exit 0, zero errors. Five pre-existing warnings on untouched cockpit lines: two unused declarations, one set-state-in-effect, and two explicit-any uses |
| Scoped baseline source proof using `callExpressionAt`, canonical shard loading/writing, and `git hash-object --path` | 51 entries in two shards renewed. Full call text and coordinates unchanged; final client/backend blob evidence current. Identity, causes, fingerprints, multiplicity, expiry and UNKNOWN debt preserved |
| `git diff --check` | Passed |

Intermediate management-note tests also exposed a brittle SDK invocation-count assertion. It now requires at least one report hook observation and proves every invocation is skipped; authorization and text assertions remain. The first baseline proof script selected an older evidence segment with a greedy regex; the corrected check selects the final segment and verified all 51 entries. Neither failure changed an application gate.

No live-spec contract monitor, Sonar, real Convex backend, production, rendered EN/AR desktop/mobile browser, scripted E2E, screen audit, explorer swarm or independent review seat ran in this lane. The no-server instruction prevents starting a local browser target. No merge, push or deployment is part of this handoff; the SCRUM-886 same-deploy dependency remains.


### Round 5 validation commands

All Vitest invocations used named files and `--maxWorkers=1`; no watcher or dev server ran.

| Command / named files | Observed result |
| --- | --- |
| `pnpm exec vitest run convex/costDisclosure.scrum902f.test.ts --maxWorkers=1` against unchanged production source at `86abd74b` | 11 failed; all five findings reproduced. Positive controls preceding each negative assertion saw the figure |
| Same command after the first five fixes | 11 passed |
| Same command with first sweep tests, before receipt fixes | 2 failed, 12 passed |
| Same command with second sweep tests, before direct-refusal/backfill fixes | 3 failed, 14 passed |
| `pnpm exec vitest run convex/costDisclosure.scrum902f.test.ts --maxWorkers=1 -t 'sweep markPaid'` with only `convex/sourcingPayables.ts` restored to `86abd74b`, then restored in `finally` | 1 selected test failed as expected; 12 unselected tests. No assertion or production file was left reverted |
| `pnpm exec vitest run convex/costDisclosure.scrum902f.test.ts convex/costReaders.scrum902d.test.ts convex/supplierSourcingCostGate.scrum902.test.ts convex/supplierRefusalTexts.scrum869.test.ts convex/sourcingPayables.test.ts convex/supplierReceivables.test.ts convex/supplierCostRecoveries.test.ts --maxWorkers=1` | 7 files, 116 passed |
| `pnpm exec vitest run convex/costDisclosure.scrum902f.test.ts components/applications/cockpit/DealCockpitSupplierAuthority.test.tsx components/applications/cockpit/ResolveGapDialog.test.tsx components/accounting/AccountingSetupTab.test.tsx components/accounting/setup/OpeningBalanceApprovalContainer.test.tsx components/accounting/setup/OpeningAllocationEditor.test.tsx --maxWorkers=1` | 6 files, 129 passed |
| `pnpm exec vitest run convex/costDisclosure.scrum902f.test.ts convex/financedConsignedSettlement.test.ts convex/supplierConcession.scrum766c.test.ts convex/openingBalanceIndexReads.test.ts convex/accountingPhase9.test.ts convex/referenceReadOwnership.test.ts convex/expensesReferenceOwnership.test.ts convex/costReaders.scrum902d.test.ts convex/supplierSettlement.test.ts scripts/regression/scenarioRecord.test.ts --maxWorkers=1` | 442 passed, 2 failed in referenceReadOwnership. The old fixtures expected vehicle expense rows without cost access. Ownership assertions were preserved; the join fixture gained cost access and the no-cost test now asserts the row is absent with an authorized summary control |
| `pnpm exec vitest run convex/referenceReadOwnership.test.ts scripts/regression/scenarioRecord.test.ts convex/supplierRefusalTexts.scrum869.test.ts --maxWorkers=1` after those fixture corrections | 3 files, 72 passed |
| `pnpm exec vitest run convex/costDisclosure.scrum902f.test.ts convex/referenceReadOwnership.test.ts convex/supplierRefusalTexts.scrum869.test.ts scripts/regression/scenarioRecord.test.ts --maxWorkers=1` (final, including EN/AR refusal checks) | 4 files, 86 passed |
| `pnpm typecheck` | Final exit 0. Root config excludes `convex`, `apps`, `packages`, `dealer-worker`, `test-utils`, and `node_modules` as roots; imported dependencies may still be checked |
| `pnpm typecheck:convex` | Final exit 0. Covers `convex/**/*` and `test-utils/**/*`; excludes `convex/_generated` as roots. It does not check the web/mobile applications |
| Targeted `pnpm exec eslint` on the changed backend functions and three cockpit/setup components | Exit 0; 0 errors, 11 warnings at untouched lines. Sonar was not run |
| `git diff --check` | Passed |
| Contract baseline source checks | 84 affected entries renewed in 11 shards; 49 relocated only after full call-text equality. Current client/backend git blobs and canonical shard loading passed. Expiries, fingerprints, findings and UNKNOWN status were preserved |

The full default `relocateBaseline.mjs --base 86abd74b` compiler scan was stopped after it consumed substantial memory without producing a result. Its result is UNAVAILABLE, not passing. The replacement proof above reuses `callExpressionAt` and the canonical shard loader/writer for the affected entries; it is not a full monitor or live-spec run. Neither `scripts/contractSkew/README.md` nor `scripts/intelligence/README.md` exists at this revision; the baseline procedure was read in `scripts/contractSkew/BASELINE-IDENTITY.md` and the CLI source.
Initial typecheck runs found an introduced JSX syntax error and optional-result inference errors. Both were corrected before the final successful typechecks; assertions were not weakened.
Production, real Convex runtime, mobile typecheck, rendered EN/AR desktop/mobile screens, scripted E2E, screen audit, explorer swarm, Sonar and independent review seats remain unverified in this implementation lane.
