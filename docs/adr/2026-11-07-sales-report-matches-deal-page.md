# Sales report figures match the deal page

Date: 2026-11-07. Issue: SCRUM-928, part 1. Status: accepted for implementation.

## Invariant and scope

For each completed, live sale, the report's customer sale price, profit and net
after commissions use the deal page's shared value derivation, to the minor
unit, with the same evidence refusals. Unknown is never zero. Access follows
main's report rules at `684ba04d0`, independently of deal-page access. The report
does not change deal economics, posting, commission amounts or lifecycle rules.

## Permission ruling: "Keep today's view"

The owner's 2026-11-07 ruling supersedes role-parity withholding from the initial
implementation. The reports keep main's permission gates exactly. A caller who
could see a figure on main still sees it, and a caller who could not still
cannot. `view:finance` must not become a new requirement for report profit,
sale price, net after commissions, totals, Performance or CSV. Parity with the
deal page applies to values. Access follows main's report rules.

Both Sales and Performance require tenant membership and `view:reports`, and
return null without `view:cost_price`. System owners retain their existing
bypass. Base profit, revenue, costs and sale price require no commission or
finance grant. Commission fields and the separate net-after-commissions fields
retain `view:commissions`. The loader reads the complete commission operands
internally for profit, and the queries project the commission fields using
that separate grant. Stored sale FINANCE fields still pass through
`projectSaleRow`, retaining their own finance gate. CSV uses the same projected
report fields. The deal page's own authorization is unchanged.

The access comparison below uses R = `view:reports`, C = `view:cost_price`,
M = `view:commissions`, and F = `view:finance`. Existing system-owner bypasses
apply. Evidence refusals for genuinely unreadable amounts remain separate.

| Report fields | Main `684ba04d0` | Initial head `1bcd76af2` | Fixed |
| --- | --- | --- | --- |
| Sales customer sale price | R+C | R+C+F | R+C |
| Sales base profit, recognized revenue, costs and their totals/completeness | R+C | R+C+F+M | R+C |
| Sales commission total and pending flag | R+C+M | R+C+M | R+C+M |
| Sales separate net after commissions and its totals/completeness | R+C+M | R+C+F+M | R+C+M |
| Sales vehicle cost, gross volume, supplier settlement, agent count and metadata | R+C | R+C | R+C |
| Projected sale `commissionBase` and `consignedSupplierConcessionMinor` | R+C+F | R+C+F | R+C+F |
| Remaining projected sale fields | R+C | R+C | R+C |
| Performance revenue/profit totals and completeness | R+C | R+C+F+M | R+C |
| Performance commission/net totals and completeness | R+C+M | R+C+F+M | R+C+M |
| Performance salesperson, count and gross volume | R+C | R+C | R+C |
| Inventory, Expenses and legacy P&L, unchanged query bodies | R+C | R+C | R+C |
| Lead conversion, unchanged query body | R | R | R |
| CSV base fields; separate commission/net columns | R+C; R+C+M | Inherits added backend gates | R+C; R+C+M |

The owner confirmed the mismatch on a production test deal; its identifier
stays out of this public repository. The test fixtures reproduce its shape: a
SOURCED financed deal whose management net includes the execution fee, a
showroom preparation cost and commissions.

## Two designs

| Candidate | Read cost | Freshness | Permissions |
| --- | --- | --- | --- |
| A. Shared pure derivation, with report inputs loaded in batches | Load distinct applications and vehicles once, and indexed child collections once per report batch. No per-sale query invocation. Bound reads and refuse an incomplete report rather than publish a prefix. | Live fees, removed expenses and commission changes appear on both reactive readers. | Main's report and cost gates authorize base figures. Commission fields retain their separate grant. Deal-page finance access is not a report prerequisite. |
| B. Freeze management net and customer price at completion | Cheap date-indexed sales reads, but requires new stored fields, a backfill and invalidation at every later cost edit. | Incorrect after a late execution-fee actual, expense removal or commission correction unless every writer maintains the snapshot. | A single stored net cannot replace current role-specific withholding. A second permission projection is still needed. |

Choose A. Completion is not the last time costs can change. B would introduce a
second authority and new write obligations into this read-only repair. Keep
database loading separate from pure figure derivation. Reuse the existing fee,
supplier-evidence, vehicle-cost and commission authorities instead of adding
report-specific arithmetic. Batch child rows by tenant, group by their actual
application, sale or vehicle id, and retain their order and completeness rules.
Distinct referenced document ids are fetched once. A bounded batch that cannot
be read completely refuses with a clean read-limit error; it never serves a
truncated set as complete. A 366-day date range is not itself a row bound.

The batch limits are 800 completed sales and 10,000 child rows shared across
the indexed child reads. Expenses, work orders, commissions and supplier rows
are tenant batches. Fees use the selected application-id envelope, matching
the deal page's application-keyed input even when a fee has a malformed tenant
stamp. Settlement-sensitive legacy rows additionally use an invoice-id envelope
for allocations, and the tenant's sale-completed event prefix. Intervening rows
are discarded before derivation, but still consume the read budget. Thus other
retained history, including intervening foreign-parent rows in the two global
envelopes, can refuse a report. Narrowing dates does not guarantee recovery.
This is an explicit availability tradeoff to preserve the existing authorities
and avoid per-sale child queries without new stored state or indexes. No figure
from an intervening parent is served. Actual cloud read headroom is unverified.

Settlement is loaded only when deriving both settled and unsettled versions
changes the amount or refusal. Settlement can switch legacy forecast expenses
to actuals. Both versions call the same pure derivation. The selected result
follows the existing supplier, financier and canonical-invoice proof. Keep the
cockpit's SOURCED fee-completion rule and the overview's STOCK fee-completion
rule distinct, as they are today.

## Column and card meaning

The existing profit field becomes management net, including commissions, as on
the deal page. Label it "Net profit (after commissions)" in English and Arabic.
The net-after-commissions column is the same amount; never subtract commissions
again. Keep the commission column as a disclosed component, when authorized.
The sale-price column uses the deal page's legal-invoice, submitted-quotation,
target-amount precedence. Cash uses the sale cockpit's management net.

Revenue retains the existing recognized-revenue convention: consigned gross is
deal volume, not dealership turnover. The difference between that recognized
revenue and management net is labelled "Deal costs and reconciliation". It
includes fees, showroom expenses and commissions, and can also bridge a legacy
revenue basis to the application basis. It is not labelled as actual spending. Per-row costs
and revenue join the totals only when both revenue and management net are
complete and in the organization currency. Thus the same included rows satisfy
revenue minus costs equals net profit. Count and disclose excluded rows. Keep
gross deal volume and supplier settlement as separate, qualified figures.
Do not label these management totals as the GL income statement.

The salesperson performance tab publishes the same per-deal profit and will
sum the same derived rows. Inventory, expenses, lead conversion, dashboard and
legacy P&L are part 2; their different measures need separate owner decisions.

The response carries `DEAL_MANAGEMENT_NET_V1`. A frontend running against the
previous backend withholds the Sales and Performance tables with an explicit
update-required message, rather than mislabelling accounting margin or
formatting a row without its new currency field. Loading also states no number.

## Impact map and design risks

| Area | Decision or proof obligation |
| --- | --- |
| Writers | No new financial writer or stored field. |
| Readers | Sales report, its CSV and performance tab; financed overview and cash cockpit share extracted helpers. |
| Historical rows | Preserve unknown evidence, unsafe amount and missing-link refusals. |
| State transitions | Late costs are live; cancelled and deleted sales remain excluded. |
| Reversal | Deleted, reversed, voided and supplier-borne costs retain the existing exclusion rules. |
| Idempotency | Read-only; repeated reads do not write. |
| Authorization | Preserve main's report gates field by field, including the projected sale FINANCE fields. No unknown-to-zero fallback. |
| Tenancy | Tenant indexes and reciprocal application-sale linkage; no cross-tenant evidence. |
| Ledger | No postings, events or journal changes. |
| Audit | Failing-first commit, regression record and certification-matrix row. |
| UI | Existing table and RTL, bilingual labels and CSV semantics. |
| End-to-end | Public report and deal-query fixtures assert literal amounts and parity. Rendered-role audits remain separate evidence. |
| Runtime | Local typechecks and harness tests do not establish Convex cloud limits, scheduling or production parity. |

Five predicted failures, to test before freezing: a fee recorded after completion
leaves stale profit; deleted or supplier-borne expenses are still deducted; a
THROUGH_SHOWROOM payable is confused with a DIRECT supplier claim; a cash sale
without an application uses financed arithmetic; and corrupt or foreign fee
evidence becomes zero. Permission, cancelled-sale and repeated-vehicle fixtures
also exercise the public readers.

## Local evidence and remaining certification

The permission follow-up reproduced four failing role cases before its fix.
Afterward, all 19 report tests and all 70 scenario validators pass. The real
`DEFAULT_ROLE_TEMPLATES` MANAGER permissions are used for CASH and SOURCED
financed sales, and match a system owner's report figures. Both TypeScript
checks pass. The scenario's executable test name includes the verbatim ruling
"Keep today's view"; the closed JSON schemas still reject free-form ruling
text. The supplied source identifies c24730 as the problem comment, not the
owner answer. The answer's comment id remains unverified.

The untouched `dealCommissions.test.ts` exposes a separate contract conflict.
It requires `netProfit` and `totalProfit` to remain pre-commission margin 5000,
and the separate net-after-commissions fields to be 4875. The PR defines both
as management net. After restoring access, the assertion fails with 4875
versus 5000, rather than null versus 5000. Changing only permission inputs
cannot satisfy both definitions. This follow-up does not change the test or
introduce a role-dependent value formula. Resolving that contract needs an
explicit scope decision before this PR can pass its required suite.

The first public-query red run at `173185b2d` was 9 failed, 1 passed. The expanded
tests against committed snapshot `442fa7d18` were 20 failed, 14 passed. The
implementation then passed all 34 expanded backend, card and real-page jsdom
checks. Expectations are literal amounts from the finding and worked fixtures.

| Self-attack | Public check and result |
| --- | --- |
| A fee changes after completion | Late actual 500,000 yields 975,000 minor on both readers. |
| Deleted or supplier-borne expenses get deducted | Deleted 700 and supplier-borne 900 stay excluded; removing the live 300 expense changes both nets to 1,323,700. |
| Supplier routes or repeated vehicles get mixed | THROUGH_SHOWROOM uses this sale's payable; cancelled and deleted siblings on the same vehicle do not add rows or costs. |
| Cash is accidentally treated as financed | No application; both report and cash cockpit yield 1,790,000 minor. |
| Unknown or mixed-currency fees become zero | NaN yields ExpensesUnreadable; USD actual on JOD deal yields ExpensesMixedDenomination on both readers. |

Design review additionally caught that settlement can change the amount. Posted
canonical-invoice fixtures prove legacy forecast 600,000 versus actual 451,300:
unsettled net is 875,000; settled net is 1,023,700. Application-linked malformed
fee stamps, finance-less report access and corrupt strongest price documents also have
public-query controls. A frontend legacy-payload reproduction failed with the
missing-currency `.trim()` crash before the figure-basis gate; it passes with
the explicit update-required state.

The repeated independent-derivation mistake affected profit and customer sale
price. The `correct` skill's architecture-first remedy is the shared pure
derivation and public-seam tests, rather than another prose-only rule. The
applications source pin is renewed for this explicitly requested extraction,
and a new full-file pin covers the moved decisions in
`utils/dealSettlementFigures.ts`. Both byte length and hash assertions remain.
These pins track change control; they do not claim independent certification.

A final local SonarJS 4.2.2 check found two complex extracted functions and
nested conditionals. Small named helpers now express the same branches; both
the cognitive-complexity rule (limit 15) and nested-conditional rule pass for
all four new figure modules. This limited rule check is not a SonarCloud verdict.

The existing suites' accounting assertions remain. Report assertions that
expected pre-commission margin are updated to management net. Missing commission
decisions remain unavailable, and a missing vehicle cannot invent preparation
evidence. Dashboard and legacy P&L assertions keep their original basis for part 2.

Independent Opus and Codex seats, CI/Sonar, the three live bug hunters, rendered
desktop/mobile layout checks, actual CSV download, real-backend limits/OCC and
production parity are not certified by these local runs. No dev server, watcher,
Convex deployment or production-data read is part of this lane. Deploy the
frontend's compatibility gate before the new backend contract, through the
existing release process. The local work is committed without pushing.

## Sources

- [Convex best practices](https://docs.convex.dev/understanding/best-practices):
  plain TypeScript helpers, indexed reads, bounded collections and sparing use
  of nested query calls. This supports the shared pure derivation and batch loader.
- [OWASP authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html):
  enforce authorization on the server and test the allowed and refused cases.
  The owner's report-specific policy determines which grants each field needs.
- [IFRS management performance measures discussion](https://www.ifrs.org/content/dam/ifrs/meetings/2022/january/iasb/ap21a-pfs-management-performance-measures-disclosures-usefulness-and-reconciliations.pdf):
  disclose the measure's meaning and reconciliation. This supports explicit
  management labels and arithmetically closing cards, not a claim of IFRS certification.
- Jira SCRUM-928 description and c24713/c24715, read 2026-11-07; owner ruling
  "Match the deal page". Owner definitions take precedence over generic reporting conventions.
