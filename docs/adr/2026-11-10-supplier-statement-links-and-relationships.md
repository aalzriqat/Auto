# Navigate supplier statements and vehicle relationships by id

Status: implemented for local verification, SCRUM-869 feature 1 and SCRUM-887 slice B.
Base: `68be2346d9e2441e9d5bcf88cb980d9ad9189cd6`.
Extends the supplier identity design and the P4a, P4b and P5 ADRs.
Rulings: SCRUM-869 c24419/c24460/c24511, SCRUM-887 c24237,
SCRUM-902 c24475, SCRUM-760 and SCRUM-868 N2/N6/N9.

## Invariant and role policy

A row shown under a supplier is linked to that supplier by canonical id only.
Names are display snapshots, never lookup, grouping or authorization keys.
Finance and cost-price permission remain required for statement rows and totals.
Relationship readers require finance permission and return an explicit stock
metadata allowlist, without costs, prices or monetary totals. Target permissions
decide whether a source label is a link. Backend target readers retain authority.

## Reader census

| Reader | Index and bound | Permission | Returned fields |
| --- | --- | --- | --- |
| supplierStatement.outstanding | Three obligation tables, by_org_and_supplierId_and_status; existing 100 rows per family, status sentinels and shared transaction headroom | view:finance, view:cost_price, accounting plan, requireOwnedRow supplier | Existing separate A/P and A/R rows, amounts in minor units, currency, due facts and complete totals; source context added |
| supplierStatement.settled | Same supplier/status indexes and existing 100 rows per family; existing bounded receipt journal provenance | Same as outstanding | Existing status, actual settled cash, due amount, settlement basis, timestamps and completeness; source context added |
| Statement context enrichment | Reuses obligation documents already read in the same query; at most 100 rows per family. One per-call cache shared with outstanding due facts, for vehicles, sales, applications, expenses and opening drafts; only cache misses spend headroom | Inherits statement gate and supplier-index scope; org checked on every source | Economic role, created timestamp, snapshot payer/payee, source kind/id/label and permission-filtered href; expense sources also carry a separate vehicleSource. Internal documents are stripped before returning rows. On decoration exhaustion, retain every computed row, total and completeness flag, with source and vehicleSource null |
| supplierRelationships.vehicles, SOURCED | vehicles.by_org_and_sourcedSupplierId; one paginate, default 25, maximum 50 documents read and 1 MiB page bytes | view:finance, requireOwnedRow supplier | Vehicle id, stock label, SOURCED model, vehicle status, permission-filtered vehicle href |
| supplierRelationships.vehicles, OWNED | vehicleSupplierPayables.by_org_and_supplierId_and_status prefix; same pagination bounds, at most one headroom-checked get per distinct vehicle per call | Same; no costs returned | Native purchase payables without saleId whose live vehicle is owned; stable payable relationship id, vehicle id, stock label, OWNED_ON_ACCOUNT model, status and permission-filtered href |
| supplierStatement.paymentsReconciliation | Existing supplier/status and journal indexes, unchanged read budgets | Existing statement gate | Unchanged reconciliation contract |
| Existing vehicles.get (new direct navigation caller) | Direct vehicle get, existing author/image/pending-request reads; no inventory-list page walk. Existing pending-request query uses by_vehicle then a status filter, without a new scan bound | view:vehicles, existing tenant check; existing cost redaction requires view:cost_price | Existing vehicle detail contract, unchanged; new caller opens the existing dialog |

The money readers return the documents they already hold alongside internal rows.
The handler projects navigation after money reading finishes, without a callback.
The navigation catch wraps only enrichment. Money-reader failures retain their
existing contract, and the client error boundary shows a localized load error.
The UI trusts the server href, including null, with no per-row permission lookup.
Pure settled row builders remain in supplierSettledRows. No opening callback exists.

Each relationship invocation performs one paginated query. Independent cursors
keep the two families separate. Preserve native options and split-cursor metadata,
then override numItems, maximumRowsRead and maximumBytesRead with server clamps.
The shared boundedCount preserves existing registry callers' behavior. A nonterminal or cut page says
the list is incomplete, even when filtering leaves it empty. No partial total.
The existing indexes fit both access paths, so no index or schema change is needed.
Legacy id-less money rows stay outside the statement. This slice omits their
count because proving an organization-wide count would require another scan.

Each OWNED row represents a native purchase obligation. Separate invoices or
acquisition episodes can refer to the same vehicle, including a settled historical
obligation beside a current one. Retaining both relationships is correct; the
workspace does not infer that they are the same invoice or merge their money.
Use the payable document id as the stable React key on every page. SOURCED rows
use their vehicle id. No page-local deduplication hides one purchase relationship.
This is the review request's permitted repeated-vehicle option, rather than a
unique-vehicle inventory summary. The two-page regression proves distinct keys.

The existing vehicles route gains a supplierVehicleId query parameter. Its
existing vehicles.get reader validates the id, tenant and cost redaction before
the existing detail dialog opens. This avoids the existing highlight hook's
20-page search cap without changing that cap or adding a route.

## Existing link targets

| Source | Existing route | Required target permission |
| --- | --- | --- |
| Vehicle | /[orgId]/vehicles?supplierVehicleId=[vehicleId] | view:vehicles; existing vehicles route opens its existing detail dialog through vehicles.get, independent of list pagination |
| Cash sale | /[orgId]/sales/[saleId]/deal | view:sales |
| Financed sale with application | /[orgId]/applications/[applicationId]/deal | view:sales; org-matched application |
| Opening obligation | /[orgId]/accounting?section=settings | view:finance, view:cost_price and manage:finance; existing opening readback is in Settings |
| Expense-origin recovery | Expense label, plus the vehicle route above | No individual expense screen exists; preserve its document id/title and link the recorded vehicle with view:vehicles |

A financed sale whose application is foreign or deleted falls back to kind
SALE with a null link, including for viewers without view:sales. A foreign sale,
expense or opening draft, or a soft-deleted sale or expense, yields no source.
The covered public-query test rows are declared in
`scripts/intelligence/supplierNavigationDoors.ts`. The adjacent census test binds
those rows to literal test titles and counts ownership lookups and permission gates.
A missing document needs no separate ownership row: `readCached` returns null with
or without `owned`, so a removed ownership check cannot separate the outcomes.
Existing financed-application missing rows remain listed. openingBalanceDrafts has
no isDeleted field, so no soft-deleted opening-draft behaviour is claimed.

Route census scope: recursive page.tsx enumeration under
app/(dashboard)/[orgId]/expenses returned only expenses/page.tsx. This is why
an expense keeps a plain source label rather than an invented detail route.

Opening provenance takes precedence over native vehicle/sale provenance. A
statement's immutable supplier name snapshot identifies the payer for A/R or
payee for A/P. It is not the employee who recorded payment, nor the expense
service provider. Timestamp labels distinguish creation from last change.

## Impact and alternatives

The public statement projections and supplier detail screen consume this change.
The shared due/aging, alert and balance algorithms keep their existing formulas. Existing
money writers, transitions, cancellation, reversal, retry/idempotency, ledger and
audit records are unchanged because these are reads. Historical rows remain
readable without repair; missing links never infer identity. Repeated queries
write nothing. The UI preserves separate currency amounts and separate A/R and
A/P regions. Local public-query tests and synthetic component renders prove
these reads; real-backend hunters and final independent seats remain separate
SCRUM-760 evidence. Backend deployment and matching frontend promotion remain
manual release work outside this lane.

Two designs were considered: enrich while the money reader runs, or carry its
already-read documents to the public projection. Round 2 chooses the latter.
Shared aging and alert projections keep their contracts, and balances consume
only their existing fields. Cached source gets share transaction headroom;
decoration never determines whether a computed money figure is available.

At the 100-row-per-family bound, instrumented handler calls with distinct targets
perform 803 gets for outstanding and 803 for settled, including three authorization
and supplier gets. Round 1 performed 1503 and 1103 respectively. Outstanding uses
at most 3 source gets per native payable/receivable and 2 per expense recovery.
With shared targets across all 300 outstanding obligations, the measured count is
7. Fifty purchase relationships sharing one vehicle use 4 gets, previously 53.
These are call-through harness I/O counts, not cloud usage or latency measurements.
Those fixtures use ordinary memberships. The unchanged impersonation-grant check
adds one get, so the source-derived full-query maxima for that path are 1504 to
804 for outstanding and 1104 to 804 for settled. This extra auth read is outside
the measured normal-role fixtures.

## Exclusions

Alerts feature 5; money writes, settlement, reversal, correction and offsets;
A/R versus A/P netting; P6 journal supplier dimensions; migration/backfill;
mobile; P7 launch evidence; workflows, release scripts and Playwright changes.

## Five predicted failures and checks

1. A SALES or custom finance viewer gets cost fields. Assert the entire
   relationship response and statement refusal without cost permission.
2. A same-name party or id-less legacy row enters the list. Seed both alongside
   linked records and assert exact ids through the public queries.
3. Reading grows with the table or a far endCursor defeats the cap. Bound native
   paginate options, exercise continuation and mark nonterminal output incomplete.
4. A label links to an inaccessible or foreign target. Test absent target
   permissions, foreign/deleted records and EN/AR plain-label rendering.
5. P5 opening rows are treated as vehicle obligations. Seed opening payable and
   recovery records and assert opening navigation, role, snapshot and timestamps.

## Sources and evidence boundary

Checked 2026-11-10: [Convex indexes](https://docs.convex.dev/database/reading-data/indexes/),
[pagination](https://docs.convex.dev/database/pagination),
[read limits](https://docs.convex.dev/production/state/limits), and
[query authentication](https://docs.convex.dev/auth/functions-auth).
Use indexed prefixes, one native pagination per invocation and server auth.
[Convex OCC and serializability](https://docs.convex.dev/database/advanced/occ)
supports reusing documents from one consistent query snapshot. A second obligation
get cannot discover an identity change inside that snapshot, so that throw is
removed. [React list keys](https://react.dev/learn/rendering-lists) requires stable,
unique sibling keys; use the database relationship ids rather than vehicle ids
for purchase-obligation rows.
[Next.js Link](https://nextjs.org/docs/app/api-reference/components/link)
supports existing internal routes; disable prefetch on financial record links.
[WAI status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)
supports non-focus-moving updates. Use native output for loading/incomplete
notices and alerts for errors, with EN/AR text and logical RTL layout.
Documentation supports the design, not platform/OCC or production verification.
