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
| Statement context enrichment | Each displayed obligation reread by typed id; at most 300 obligations per query, sequential headroom check before each get; at most four related gets per row | Inherits statement gate; verify org and supplier on obligation, org on each source | Economic role, created timestamp, snapshot payer/payee, source kind/id/label and permission-filtered href; expense sources also carry a separate vehicleSource. Deleted, missing or foreign targets have no link. Budget exhaustion removes unfinished rows and withholds totals |
| supplierRelationships.vehicles, SOURCED | vehicles.by_org_and_sourcedSupplierId; one paginate, default 25, maximum 50 documents read and 1 MiB page bytes | view:finance, requireOwnedRow supplier | Vehicle id, stock label, SOURCED model, vehicle status, permission-filtered vehicle href |
| supplierRelationships.vehicles, OWNED | vehicleSupplierPayables.by_org_and_supplierId_and_status prefix; same pagination bounds, at most one headroom-checked vehicle get per payable | Same; no costs returned | Native purchase payables without saleId whose live vehicle is owned; vehicle id, stock label, OWNED_ON_ACCOUNT model, status and permission-filtered href |
| supplierStatement.paymentsReconciliation | Existing supplier/status and journal indexes, unchanged read budgets | Existing statement gate | Unchanged reconciliation contract |
| Existing vehicles.get (new direct navigation caller) | Direct vehicle get, existing author/image/pending-request reads; no inventory-list page walk. Existing pending-request query uses by_vehicle then a status filter, without a new scan bound | view:vehicles, existing tenant check; existing cost redaction requires view:cost_price | Existing vehicle detail contract, unchanged; new caller opens the existing dialog |

The settled reader invokes its optional A/P projection callback before reading
the A/R family, so heavy claims cannot erase a complete payable section's source
metadata. Pure settled row builders move unchanged to supplierSettledRows to stay
inside the file ceiling. No callback is added to any opening reader.

Each relationship invocation performs one paginated query. Independent cursors
keep the two families separate. Preserve split-cursor metadata and never spread
caller pagination options into the database call. A nonterminal or cut page says
the list is incomplete, even when filtering leaves it empty. No partial total.
The existing indexes fit both access paths, so no index or schema change is needed.
Legacy id-less money rows stay outside the statement. This slice omits their
count because proving an organization-wide count would require another scan.

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

Two designs were considered: add provenance to the shared aging algorithm, or
enrich only the public statement projection. Choose the latter to keep unrelated
aging/alert/balance contracts unchanged. The extra bounded gets trade a small
read cost for a narrow interface; every get shares transaction headroom.

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
[Next.js Link](https://nextjs.org/docs/app/api-reference/components/link)
supports existing internal routes; disable prefetch on financial record links.
[WAI status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)
supports non-focus-moving updates. Use native output for loading/incomplete
notices and alerts for errors, with EN/AR text and logical RTL layout.
Documentation supports the design, not platform/OCC or production verification.
