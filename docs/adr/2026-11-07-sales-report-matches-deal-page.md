# Sales report figures match the deal page

Date: 2026-11-07. Issue: SCRUM-928, part 1. Status: accepted for implementation.

## Invariant and scope

For each completed, live sale, the report's customer sale price, profit and net
after commissions equal the deal page's figures for the same role, to the minor
unit, or have the same unavailable reason. Unknown is never zero. The report
moves to the deal page's definition. It does not change deal economics, posting,
commission amounts, permissions or lifecycle rules.

The confirmed example is D-000005: customer sale price 12,100.000 JOD and
management net 1,023.700 JOD, including the 451.300 execution fee, 300.000
showroom preparation cost and 110.000 commissions.

## Two designs

| Candidate | Read cost | Freshness | Permissions |
| --- | --- | --- | --- |
| A. Shared pure derivation, with report inputs loaded in batches | Load distinct applications and vehicles once, and indexed child collections once per report batch. No per-sale query invocation. Bound reads and refuse an incomplete report rather than publish a prefix. | Live fees, removed expenses and commission changes appear on both reactive readers. | The caller's existing finance, cost and commission rights are inputs. The report stays null without cost access. No commission-free substitute for a withheld net. |
| B. Freeze management net and customer price at completion | Cheap date-indexed sales reads, but requires new stored fields, a backfill and invalidation at every later cost edit. | Incorrect after a late execution-fee actual, expense removal or commission correction unless every writer maintains the snapshot. | A single stored net cannot replace current role-specific withholding. A second permission projection is still needed. |

Choose A. Completion is not the last time costs can change. B would introduce a
second authority and new write obligations into this read-only repair. Keep
database loading separate from pure figure derivation. Reuse the existing fee,
supplier-evidence, vehicle-cost and commission authorities instead of adding
report-specific arithmetic. Batch child rows by tenant, group by their actual
application, sale or vehicle id, and retain their order and completeness rules.
Distinct referenced document ids are fetched once. A bounded batch that cannot
be read completely refuses with a clean narrow-range error; it never serves a
truncated set as complete. A 366-day date range is not itself a row bound.

## Column and card meaning

The existing profit field becomes management net, including commissions, as on
the deal page. Label it "Net profit (after commissions)" in English and Arabic.
The net-after-commissions column is the same amount; never subtract commissions
again. Keep the commission column as a disclosed component, when authorized.
The sale-price column uses the deal page's legal-invoice, submitted-quotation,
target-amount precedence. Cash uses the sale cockpit's management net.

Revenue retains the existing recognized-revenue convention: consigned gross is
deal volume, not dealership turnover. Costs become all deductions between that
recognized revenue and management net. Label the card "Total deal costs" and
explain that fees, showroom expenses and commissions are included. Per-row costs
and revenue join the totals only when both revenue and management net are
complete and in the organization currency. Thus the same included rows satisfy
revenue minus costs equals net profit. Count and disclose excluded rows. Keep
gross deal volume and supplier settlement as separate, qualified figures.
Do not label these management totals as the GL income statement.

The salesperson performance tab publishes the same per-deal profit and will
sum the same derived rows. Inventory, expenses, lead conversion, dashboard and
legacy P&L are part 2; their different measures need separate owner decisions.

## Impact map and design risks

| Area | Decision or proof obligation |
| --- | --- |
| Writers | No new financial writer or stored field. |
| Readers | Sales report, its CSV and performance tab; financed overview and cash cockpit share extracted helpers. |
| Historical rows | Preserve unknown evidence, unsafe amount and missing-link refusals. |
| State transitions | Late costs are live; cancelled and deleted sales remain excluded. |
| Reversal | Deleted, reversed, voided and supplier-borne costs retain the existing exclusion rules. |
| Idempotency | Read-only; repeated reads do not write. |
| Authorization | Preserve finance, cost and commission withholding. No unknown-to-zero fallback. |
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

## Sources

- [Convex best practices](https://docs.convex.dev/understanding/best-practices):
  plain TypeScript helpers, indexed reads, bounded collections and sparing use
  of nested query calls. This supports the shared pure derivation and batch loader.
- [IFRS management performance measures discussion](https://www.ifrs.org/content/dam/ifrs/meetings/2022/january/iasb/ap21a-pfs-management-performance-measures-disclosures-usefulness-and-reconciliations.pdf):
  disclose the measure's meaning and reconciliation. This supports explicit
  management labels and arithmetically closing cards, not a claim of IFRS certification.
- Jira SCRUM-928 description and c24713/c24715, read 2026-11-07; owner ruling
  "Match the deal page". Owner definitions take precedence over generic reporting conventions.
