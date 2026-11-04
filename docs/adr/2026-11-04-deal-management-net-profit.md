# Deal management net profit includes showroom expenses and commissions

Status: implemented locally; independent seats pending. Written before production edits. Jira: SCRUM-908, owner ruling 2026-11-04, "Yes, subtract both".

## Invariant

The deal management net headline subtracts every paid, live, showroom-borne car expense, net of recoverable VAT, and the deal's commissions exactly once; STOCK capitalized costs enter through the full vehicle basis, and unreadable or incomplete evidence withholds the result.

## Decision and surface map

| Reader | Class and decision |
| --- | --- |
| `convex/dealOverview.ts`, SOURCED financed overview | Management estimate. Existing approved purchase minus supplier entitlement, contribution and finance fees, then showroom expenses and commissions as separate signed lines. |
| Same reader, STOCK | Management estimate. Full vehicle cost basis already contains capitalized expenses. Deduct paid period expenses and commissions separately. |
| `financingEconomics.ts`: `deriveManagementProfit`, `deriveStockManagementProfit` | Preserve base financing economics and execution-fee authority. Compose management deductions server-side after that base. |
| Same module, `withPreparationExpenses` | Retained for compatibility with its signed expense-line contract. `withDealManagementCosts` now composes both management deductions; the legacy `PREPARATION_EXPENSES` wire key labels all showroom car expenses. |
| `convex/sales.ts` `dealCockpit` | Preserve `money.profit` and its accounting derivation. Add `money.managementNetProfit` as the headline, with `MANAGEMENT_NET` and `postable: false`; it does not claim ledger reconciliation. An older backend missing this field withholds the headline. |
| `dealCockpit` handlers | At this base the handlers are `sales.dealCockpit` and `applications.dealCockpit`, mapped above and below. `git ls-files '*dealCockpit*'` has no `convex/dealCockpit.ts`; the pure derivation tests are `convex/utils/dealCockpitDerivation.test.ts`. |
| `convex/applications.ts` `dealCockpit` | Base consignment economics remains an input to the overview. The UI already uses the overview as its sole financed headline and refuses legacy fallback. |
| `DealCockpit.tsx`, including handover summary | Render canonical server headline and signed derivation lines. Preserve loading, withheld and RTL states. |
| `DealFinancialOverview.tsx` | Overview facts remain separately labelled; the surrounding cockpit owns the canonical headline and its breakdown. No client arithmetic. |
| `DealCommissionsRow.tsx` | Commission details retain `view:commissions`. Read the final management net unchanged; remove the second client subtraction. |
| `dealCommissions.forSale`, `DealCommissionLinesDialog.tsx` | A capped read returns `lineEvidence: UNAVAILABLE` and a null total. Both detail consumers show the unreadable state without a partial list; the dialog offers no Add form. The shared bounded reader retains the existing throwing wrapper for writers. |
| `dealCommissionLines.ts` `netProfitAfterCommissionsMinor` | Keep for accounting-margin consumers. Never feed a management net that already deducted commissions into it. |
| `reports.ts` | Unchanged: ledger/accounting margin and the separately labelled accounting margin after commissions. It is not the approved-basis deal management headline. |
| `dashboard.ts` | Unchanged: period accounting figures, not a deal management headline. |

## Class table

| Evidence | SOURCED | STOCK |
| --- | --- | --- |
| Paid live showroom PERIOD_EXPENSE, any category, including OTHER and PREPAID | Subtract amount minus recoverable tax | Subtract amount minus recoverable tax |
| Paid live CAPITALIZED_INVENTORY | Unavailable: ambiguous ownership history | Included once in full vehicle cost basis; no additional deduction |
| Pending, deleted, reversed or supplier-borne expense | Excluded | Excluded |
| Expense entered after deal registration | Included when paid/live/showroom-borne | Same; no management cutoff |
| `financeDealFees` execution fee | Existing fee operand, separate from car expenses | Same |
| Active `dealCommissionLines` plus recorded salesperson commission | Subtract once | Same |
| Removed commission | Excluded; still counts toward bounded-read cap | Same |
| Linked sale with undecided salesperson commission | Net unavailable | Same |
| No linked sale yet | No recorded sale-keyed commissions exist; zero registered-to-date deduction, estimate remains provisional | Same |
| Unreadable amount, mixed denomination or cap exceeded | Net unavailable, never partial or zero | Same |
| Caller without commission permission | Withhold management net and its deduction lines, preventing inference of private pay | Same |

## Impact and alternatives

This is a read-only change. Writers, money transitions, reversals, retry identities, audit records and historical documents stay unchanged. Reads re-evaluate paid/deleted/reversed/removed state, so reversal and restoration affect the headline on the next query. Expenses use the existing `(org, vehicle)` index and commissions the `(org, sale)` index, each with a cap plus one sentinel row. Tenant checks and existing cost gates remain intact. The unmerged SCRUM-902 cost-gate branch overlaps these readers; its integration belongs to the coordinator, not a base update in this lane.

Rejected: changing the GL margin or subtracting commissions in the browser. Either would change accounting semantics or allow headline/lines and permissions to diverge. Chosen: server composition in the existing query snapshot, with a truthful management classification for cash and no schema or migration.

The pre-implementation design review identified row-limit exceptions, pending commissions, post-deal expenses, prepaid categories and cash classification. These are addressed explicitly above. Predicted failures to test: category omission, STOCK double cost, double commission, fee/expense conflation, and partial evidence treated as zero. Additional controls cover permissions, removed/reversed rows, denomination and read caps.

## Sources and verification boundary

[Convex queries](https://docs.convex.dev/functions/query-functions) support server business logic and consistent query reads. [Convex indexes](https://docs.convex.dev/database/reading-data/indexes/) support the existing indexed access paths. These support the architecture, not a correctness claim. Failing-first public-query tests, certification row, scenario record, named regression tests, typechecks and lint must verify the implementation. A serial `convex-test` pass does not establish platform behavior, concurrency, browser layout or production correctness. Independent review seats and the three runtime bug hunters remain release obligations.
