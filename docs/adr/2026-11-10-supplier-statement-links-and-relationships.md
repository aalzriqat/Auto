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
The census is a tripwire, not a proof of correctness. The original 721
outstanding cells retain their literal outcomes and base-choice design in
`scripts/intelligence/supplierNavigationDoors.test.ts`. Within
`convex/utils/supplierNavigation.ts` only, the read allowlist and original 22
statement fingerprints refuse new reads through `readCached` or `ctx.db.get`.
The relationship reader's `ownedVehicle` calls `readCached` outside that scan.

The caller census scans recursive non-test, non-generated Convex TypeScript.
It enumerates callable navigation exports regardless of parameter spelling or
imported permission types, except the two non-permission helpers
`supplierVehicleLabel` and `supplierNavigationFailure`, which the original
fingerprints pin. Literal dynamic `import()`, `require()` and import-equals
references to the navigation module refuse and require reviewed static callers.

| Forwarding site | Structural pins | Behavioural evidence |
| --- | --- | --- |
| `supplierStatement.settled`, AP and AR | Complete query declaration and tenancy import; exact scope initializer and both helper argument lists | Original 38 settled cells; 16 multi-row source/role cells; eight cross-permission cells; four opening/expense partial-recovery gate cells; 20 round-4 distinct-target, mixed-section and renamed-role cells |
| `supplierStatement.outstanding`, AP and AR | Complete query declaration and tenancy import; exact scope initializer and both helper argument lists | Original 721 cells; 16 multi-row source/role cells; eight cross-permission cells; four outstanding partial-recovery cells; 20 round-4 distinct-target, mixed-section and renamed-role cells |
| `supplierRelationships.vehicles`, SOURCED | Complete query declaration and tenancy import; exact `project(vehicle, "SOURCED", role.permissions)` arguments | Original denied/admitted cells; denied/admitted two-row, numItems 26 and endCursor cells; renamed-role, SOLD, BMW and non-null cursor cells |
| `supplierRelationships.vehicles`, OWNED | Same declaration/import; exact `project(vehicle, "OWNED_ON_ACCOUNT", role.permissions, payable._id)` arguments | Same conditions for owned stock, plus distinct valid/deleted and valid/foreign vehicle pages |
| `supplierRelationships.project` | Complete function declaration and exact `supplierVehicleHref` arguments | Both public relationship branches |
| `supplierNavigation.vehicleSource` | Original statement fingerprint and exact `supplierVehicleHref` arguments | Outstanding vehicle cells and settled native AP cells |

Enclosing-statement fingerprints cover auth destructuring, role provenance inside
the handler, all later writes to role or scope permissions, conditions and both
public forwarding branches. They do not follow imported helper implementations. Supplier-specific cache pins and dependency contracts extend the declared boundary as described below.
Every changed fingerprint requires re-deriving the affected cells and rerunning
mutants before reviewing a new pin.

Each settled and relationship registration has an independently declared,
non-empty literal argument/cell/outcome table. The census requires an exact
match, including denied and foreign/deleted rows, and a single top-level awaited
helper call. The runtime helpers refuse empty lists; navigationCells also checks
that every supplied tuple finishes. The original relationship four tuples and
38 settled outcomes are retained. The new tests seed synthetic settlement state
directly, never call payment writers, and claim query coverage only. The old
recovery fixture marked 10,000 recovered of 20,000 as RECOVERED; recordReceipt's
recoveryStatusFor derives PARTIALLY_RECOVERED. The fixture now uses that status,
and the new partial cells assert due 20,000, settled 10,000 and PARTIAL.
Relationship endCursor comes from an earlier invocation of the same query.

`attention`, `unlinkedAttention` and `paymentsReconciliation` return no row
context or link and are outside this navigation caller census.

Boundaries remain: computed module specifiers and indirect runtime loaders are
not resolved; the scan follows direct static imports, not arbitrary module graphs;
imported helper bodies and authentication semantics require their own checks;
reviewers can update a declared table or fingerprint incorrectly; finite harness
cells do not prove platform pagination, cloud limits, concurrency or correctness
under every possible input. The fingerprint review and behavioural tests are
complementary evidence, and neither is a security boundary.
A missing document needs no separate ownership row: `readCached` returns null with
or without `owned`, so a removed ownership check cannot separate the outcomes.
Existing financed-application missing rows remain listed. openingBalanceDrafts and financeApplications have
no isDeleted field, so their supported hidden variants are foreign and missing,
not soft-deleted documents.

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

SCRUM-943 review round 2, checked 2026-11-11: use the maintained
[TypeScript compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API)
for syntax, binding and fingerprints. Use
[mutation testing](https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/)
to measure whether each injected fault fails a check, not to infer untested
properties. [Convex pagination options](https://docs.convex.dev/api/interfaces/server.PaginationOptions)
documents endCursor page splitting, and
[function authorization](https://docs.convex.dev/auth/functions-auth)
keeps caller access on the server. These checks run public queries using
[convex-test](https://docs.convex.dev/testing/convex-test), a mock backend;
they do not certify the Convex platform or production.

## SCRUM-943 runner integrity, round 3

Every handed caller tuple must reach its final result assertion exactly once.
The runners record completion at that assertion, compare the sequence after the
loop and repeat the comparison during teardown, including after an early return
or a swallowed failure. Expected row multiplicity comes from the declared cell,
not from whether the duplicate fixture step happened to execute. Relationship
tuples have named literal types and runtime allow-lists on every field. The
endCursor fixture asserts its first page contains the seeded newest vehicle
before selecting the expected bounded page.

Complete declaration fingerprints of the behavioural helpers and fixture
constants are a tripwire for the regression "who tests the test helper", requiring
the runner mutants to run again after edits rather than proving helper correctness.
These supplement the original 22 navigation and six forwarding fingerprints.
The literal declaration table also includes four outstanding partial-recovery
cells and eight cross-permission multi-row cells per statement query. Opening
and expense recoveries with 20000 due and 10000 recovered remain outstanding.
They are synthetic state fixtures and do not execute payment writers.

The recursive production census scans .ts and excludes tests and _generated.
It does not scan .tsx, .mts, .cts, .js, .mjs, .cjs or .jsx. A recursive filesystem enumeration
on 2026-11-11 found zero non-test, non-generated files in those extensions under
convex/; the two generated .js files are excluded. Computed loaders, code outside
that tree, imported helper semantics and incorrectly renewed pins remain limits.
[Vitest assertion state](https://vitest.dev/api/expect.html#expect-getstate)
in installed Vitest 4.1.9 counts `expect()` calls in `assertionCalls`, not matcher
executions. That counter detects an omitted expect call, not a bare expect or
a weakened comparison. The direct helper contract checks that a mismatch throws,
a match adds exactly one receipt and a missing receipt fails verification.
The strict/partial matcher canaries and helper pins complement this check. A
finite mutant suite measures those injected faults and does not establish
platform, concurrency or production correctness.


## SCRUM-943 closed test file and dependency contracts, round 4

A bound title owes a literal number of asserted cells in the file's pinned
afterEach, whether or not its runner opened an audit. The census compares this
literal title/count table with DECLARED_CALLER_CELLS and the older door cells.
Teardown requires one audit and the declared receipt count, then verifies the
ordered receipts. A no-op runner, entry return or parameter truncation therefore
fails behaviourally. These checks cover 891 caller cells: 86 settled,
769 outstanding and 36 relationship cells. The original 831 outcomes are retained.
Settlement fixtures still write synthetic state directly, without payment writers.

The behavioural file has a closed top-level inventory. Imports are pinned as a
complete list, including bindings and type imports. Runtime declarations and the
single afterEach are fingerprinted. Type declaration names and kinds remain
listed, but their 13 content hashes were dropped because types do not execute.
The remaining allowed statements are literal test/describe registrations. Any
other top-level statement refuses and names its source and location. Across the
whole file, including old tests and nested functions, the census refuses writes,
compound writes, deletes and updates rooted at a top-level name; classes;
matcher extensions/equality testers/serializers; mock/doMock/hoisted; spyOn and
stubGlobal targeting expect or a protected name; extra lifecycle hooks; and
eval/Function identifiers. It also refuses matcher-state writes and modified
test registrations, including an older nested test.only that could suppress the
bound registrations. The existing call-through db.get spy is allowed.
Pins on runtime declarations still protect method-based mutations inside helpers.
The whole-file guard checks API references before they escape into aliases,
destructuring or arguments. Hook values cannot leave the single pinned afterEach.
vi APIs and expect.getState belong in pinned runtime declarations; imported
values and the native any/arrayContaining/objectContaining builders retain their
reviewed direct forms. Other static expect API references refuse by default.
This prevents identity-returning methods and chainable APIs from bypassing the
reference check. Negative override probes use the pinned import context for fast
AST checks; unlisted statements/imports and the formatting controls still use the
complete real behavioural file.
The declaration diagnostic explicitly forbids renewing cells and their declaration
together merely to silence a failure.

[Vitest hooks](https://vitest.dev/api/hooks.html) run afterEach after each test,
with after hooks reversed in the default stack sequence. The repository setup
hook registers before this file; this file's teardown runs first. An installed
4.1.9 probe checks the hook order and currentTestName at teardown. The 45 bound
registrations are top-level literal titles, so currentTestName matches the table
key directly. Nested suite titles use a ` > ` separator and would need an explicit full-name key and census
support before becoming bound registrations.

vitest.config.ts loads vitest.setup.ts. Read in this round, that file registers
lazy React DOM cleanup only and has no matcher override. It executes before the
test module and is outside this PR's closed inventory; it could be edited to
override matchers. Configuration, setup files, Vitest and imported test helper
implementations are outside this PR and are not fingerprinted. The canary detects
the tested always-pass overrides, not arbitrary targeted framework manipulation.

Distinct-target cells cover valid plus deleted/foreign vehicles, sales and
expenses, and valid plus foreign/missing applications and opening drafts, through
both statement queries. Each compares every returned context in both sections.
Other cells combine native AP with expense AR and sale AP with opening AR under
denied/admitted gates. Older AP cash and financed outstanding cells now assert
their seeded AR row. Relationship cells cover distinct valid/hidden OWNED
vehicles, renamed roles, SOLD, BMW and a non-null cursor from an earlier call of
the same query. These are base-choice interactions, not a full cross product.

The declared production boundary is the three handlers (settled, outstanding,
vehicles), project, the navigation module (original fingerprints and cells),
readCached/createSupplierReadCache (supplier-specific pins plus exact-document
contracts), and requireTenantAuth (permission preservation contract only).
The cache contract writes three distinct literal documents plus a deleted id in
each of its five table families, then checks misses and hits against independently
written full snapshots, including literal creation times and seeded ids. Missing
results stay null. Auth contracts compare returned and persisted role permissions
with independent literal snapshots across names, cardinalities and system owner
roles. No tenancy.ts declaration is fingerprinted: shared auth must remain free
to evolve for unrelated backend lanes.
Each cache registration requires nine expect calls outside its helper, and the
auth snapshot registration requires twenty, so an empty helper/loop fails. These
are call counts, not matcher-execution proof. Separate negative contracts exercise
the receipt-count checker and each cache fingerprint with a deliberately wrong
input, independently of their normal positive callers.

A finite table cannot refute an arbitrary predicate over values that a navigation
permission decision does not evaluate, such as a role display name, make or future
time. Whole-body pins close unreviewed predicates inside their declared statements;
contracts give finite behavioural evidence at imported boundaries. Neither proves
arbitrary predicates further down the import graph. Out of scope are money and due
reader internals (supplierObligationDue, supplierObligationFacts, supplierSettledRows,
supplierSettlement, money, supplierDueDates), transactionReadHeadroom, subscriptions,
requireAuth/impersonation internals, permissions, and other transitive imports.

The syntax scan does not evaluate general computed property names, aliases
constructed without a direct test-API reference,
reflection, prototype/constructor lookup, generated code, computed loaders or code
inside imported modules. For example, indirect reflective writes or a constructed
global property name are outside its proof. Literal forbidden forms and rooted
assignment syntax are refused, not sandboxed. A coordinated wrong renewal of pins,
counts and cells remains a review risk. This is a tripwire, not a security boundary.
