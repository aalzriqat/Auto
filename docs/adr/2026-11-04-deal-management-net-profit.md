# Deal management net profit includes showroom expenses and commissions

Status: implemented locally; independent seats pending. Written before production edits. Jira: SCRUM-908, owner ruling 2026-11-04, "Yes, subtract both".

## Invariant

The deal management net headline subtracts every paid, live, showroom-borne car expense, net of recoverable VAT, and the deal's commissions exactly once; STOCK capitalized costs enter through the full vehicle basis, and unreadable or incomplete evidence withholds the result.

### Round 4 authorization closure (544c1a05)

Invariant: every cost-derived cockpit profit, alias and supplier balance requires server-side `canReadVehicleCost(role)`; finance permission alone retains the other money facts. Accounting calculations and stored money do not change. This implements SCRUM-902 c24475, following [OWASP authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) (server-side checks on every request and authorization tests) and [Convex function authentication](https://docs.convex.dev/auth/functions-auth), checked 2026-11-04.

The bounded class is the two public cockpit responses: application `profit`/`managementProfit` plus supplier party amounts, and cash `profit`/`managementNetProfit` plus supplier party amounts. The verified financed sale keeps `money: null`, its existing single-reader contract. Match PR #766's exact `{ available: false, reason: "CostAccessRequired" }` and nullable supplier amounts; its capitalized-fee census/projection is a separate dependency and is not imported here. The alternative of hiding the entire money block loses permitted finance facts; UI-only hiding leaves the API disclosure open.

Writers, historical documents, transitions, reversals, retries, journals and audit records are unaffected: this is a read projection and reason/label correction. `financedDealOverview` consumes the application cockpit; its authorized derivation must stay unchanged and its no-cost supplier summary must preserve null. `DealCockpitView` consumes both readers; a null supplier balance must never be formatted as zero. No migration or new permission. Runtime deployment and independent seats remain separate gates. The read-only design attack identified the nullable summary input and supplier renderer as required side effects.

Five attacks: original profit alias bypass; supplier balance disclosure outside profit; withheld null printed as zero; cash commission permission bypass; deleted/foreign finalized sale accepted as commission evidence. Public response, DOM and source mutation controls cover these in the evidence record. STOCK cost-basis failure and commission read bounds get distinct truthful EN/AR reasons. Every financed management estimate labels its commissions as registered to date, including the unlinked-sale zero estimate; neither arithmetic nor the SCRUM-879 estimation contract changes.

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
| Caller without cost permission | Withhold the entire management net, including its breakdown, with `CostAccessRequired` | Same |
| Legacy work-order expense without treatment | Infer period treatment only from its same-org, same-vehicle work-order expense link and matching amount | Same; subtract as period spend, never capitalize it |

## Impact and alternatives

Money transitions, postings, reversals, retry identities and historical documents stay unchanged. The earlier review fix records `PERIOD_EXPENSE` on new work-order expenses, matching their existing posting; round 4 leaves that writer untouched. Reads re-evaluate paid/deleted/reversed/removed state, so reversal and restoration affect the headline on the next query. Expenses and legacy work-order provenance use the existing `(org, vehicle)` indexes, with a cap plus one sentinel row; truncated provenance never establishes a treatment. Commissions use the bounded `(org, sale)` read. Both management headline readers use `canReadVehicleCost`; round 4 extends the same visibility gate to original cockpit profit fields and supplier amounts while preserving every accounting calculation.

The commissions row accepts a financed net only when its source headline includes `COMMISSIONS`. This withholds the row's net during the frontend/backend deploy gap without performing client arithmetic. Unset commissions on an existing sale return `CommissionsPending`, rendered separately from unreadable evidence in English and Arabic.

Two optional changes remain for SCRUM-879: removing the preparation helper's unused cutoff API, and making an unlinked-sale estimate pending. The latter changes eight existing overview scenarios that currently estimate with zero registered sale-keyed commissions; it needs its own scenario update. Neither is part of this fix round.

Rejected: changing the GL margin or subtracting commissions in the browser. Either would change accounting semantics or allow headline/lines and permissions to diverge. Chosen: server composition in the existing query snapshot, with a truthful management classification for cash and no schema or migration.

The pre-implementation design review identified row-limit exceptions, pending commissions, post-deal expenses, prepaid categories and cash classification. These are addressed explicitly above. Predicted failures to test: category omission, STOCK double cost, double commission, fee/expense conflation, and partial evidence treated as zero. Additional controls cover permissions, removed/reversed rows, denomination and read caps.

## Sources and verification boundary

[Convex queries](https://docs.convex.dev/functions/query-functions) support server business logic and consistent query reads. [Convex indexes](https://docs.convex.dev/database/reading-data/indexes/) support the existing indexed access paths. These support the architecture, not a correctness claim. Failing-first public-query tests, certification row, scenario record, named regression tests, typechecks and lint must verify the implementation. A serial `convex-test` pass does not establish platform behavior, concurrency, browser layout or production correctness. Independent review seats and the three runtime bug hunters remain release obligations.
