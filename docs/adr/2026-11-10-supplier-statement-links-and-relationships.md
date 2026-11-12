# Navigate supplier statements and vehicle relationships by id

Status: feature design and local test evidence, SCRUM-869, SCRUM-887 and SCRUM-943.
Feature-design base: `68be2346d9e2441e9d5bcf88cb980d9ad9189cd6`.
SCRUM-943 comparison base: `029386d9b107c1ef7f71fb40d6785f280b41795b`.
Extends the supplier identity design and the P4a, P4b and P5 ADRs.
Rulings: SCRUM-869 c24419/c24460/c24511, SCRUM-887 c24237,
SCRUM-902 c24475, SCRUM-760 and SCRUM-868 N2/N6/N9.

## Current test contract, SCRUM-943 round 7

This section describes the round-7 implementation. The round-3 through round-5
sections below are historical, not current-head certification. This PR changes
tests, scenario records and this ADR, with no production behavior change.

The independent literal caller inventory remains 48 registrations and 897 cells:
89 settled, 772 outstanding and 36 relationship cells. No earlier literal outcome
is removed. Regenerate and exercise the declaration, receipt and query contracts:

```powershell
pnpm exec vitest run convex/supplierNavigation.scrum869.test.ts scripts/intelligence/supplierNavigationDoors.test.ts --maxWorkers=1 --reporter=verbose
```

The executable closure pins statements and normalized source text in nine files:
`convex/supplierNavigation.scrum869.test.ts`,
`scripts/intelligence/supplierNavigationDoors.test.ts`, `vitest.setup.ts`,
`vitest.config.ts`, `convex/utils/tenancy.test.ts`,
`convex/utils/supplierReadCache.test.ts`, `test-utils/convexTest.ts`,
`test-utils/supplierFixture.ts` and `scripts/autoflowInvariantCatalog.ts`.
Only the validated literal `EXECUTABLE_CLOSURE` declaration node in its owning
census file is exempt. Reserved names elsewhere, duplicate tables, computed
properties, re-exports and inserted statements require review. Each file has
insertion controls. Text hashes cover compiler and loader comments too; LF and
CRLF normalize to the same input.

`package.json`, the lockfile, workspace configuration, both TypeScript configs
and the two checked-in package patches have text pins. Alternative Vite/Vitest
configuration files and install hooks refuse. Changes to setup, global setup,
projects, environments, aliases, plugins, transforms, config inheritance, custom
runners or serializers change a pinned input. Existing test-helper imports and
module globs are pinned with their containing statements and text. A new helper
or loader needs review. The source reader obtains Node's filesystem builtin
directly, so a Vitest `node:fs` mock cannot serve an old setup image to that check.

The authorization graph starts at the three public query declarations identified
by `NAVIGATION_CALLERS`. TypeScript symbols discover twelve reachable helpers:
`requireTenantAuth`, `requireAuth`, `throwAppError`, `isSystemOwnerRole`,
`holdsTheFrozenOwnerSet`, `enforceImpersonationGrant`, `isMutationCtx`,
`writeAuditLog`, `requireOwnedRow`, `requireFeature`, `hasPlanFeature` and
`getOrgPlan`. Local aliases resolve. The discovered graph must match reviewed
helper contracts, each with behavioral kill rows. Helper bodies and their modules'
initialization statements are fingerprinted. Unreviewed calls, extra helpers,
re-exports, computed calls, initialization writes and unparseable source refuse.

There are 72 decision entries paired with differing literal admission or audit
outcomes, and 47 executed authorization rows. The new rows cover absent identities,
missing/disabled users in query and mutation contexts, supplier ownership, and
missing/free/expired/active accounting plans. The plan-label lookup selects error
text rather than admission and is covered by its helper pin. Mismatched live
impersonation-grant references remain a separate product question; this lane does
not introduce a new refusal for them. Run the dependency oracles and their census:

```powershell
pnpm exec vitest run convex/utils/tenancy.test.ts convex/utils/supplierReadCache.test.ts scripts/intelligence/supplierNavigationDoors.test.ts --maxWorkers=1 --reporter=verbose
```

Each of the five cache registrations requires 56 `expect()` calls, not nine.
The older permission-snapshot registration still asserts 24 literal rows and 72
expect calls. Counts detect missing work, not arbitrary matcher manipulation;
source pins and negative controls complement them.

Main's combined 100-rows-per-family settled test is restored beside the three
family tests. Its complete callback is compared with the body at main `029386d9b`,
preserving both original assertions. Combined A/R must remain complete with 100
receivables and 100 recoveries: the limit is per family. Separate family tests
alone do not establish that property.

| Call-through fixture | Actual `db.get` calls | Literal complete totals, JOD minor units |
| --- | ---: | --- |
| Outstanding, 100 per family, distinct targets | 803 | A/P gross 1,000,000; A/R gross 2,000,000 |
| Settled, 100 per family together, distinct targets | 803 | A/P settled 1,000,000; A/R settled 2,000,000 |
| Settled payable family | 303 | A/P settled 1,000,000; empty A/R |
| Settled receivable family | 303 | Empty A/P; A/R settled 1,000,000 |
| Settled recovery family | 203 | Empty A/P; A/R settled 1,000,000 |

The first command regenerates these `SUPPLIER_GETS` measurements and asserts the
literal totals and completeness. They are mock-backend I/O counts, not cloud
usage, platform limits, latency or concurrency evidence.

Mutation equivalence is explicit. Removing `requiredPermissions.length > 0 &&`
while retaining the owner check and missing-permission refusal is equivalent:
empty requirements produce an empty missing set and no refusal. Removing the
frozen-owner-set length precheck is also equivalent while `every(Set.has)` remains.
Those removals are structural-only kills. Raising the missing-permission threshold
or replacing `every` with `some` is non-equivalent and must fail behaviorally.

Trusted inputs remain the requested command, Node and its builtins, installed
dependencies and review of pin renewals. Alternative CLI/config selection that
excludes the checks, a modified runtime or installation, or coordinated wrong pin
renewals are not certified by an in-process test. Money-reader internals beyond
the measured contracts remain outside this authorization graph. Hosted CI,
SonarCloud, independent seats and real-backend certification are separate evidence.

Checked this round: [Vitest setup](https://vitest.dev/config/setupfiles.html),
[configuration selection](https://vitest.dev/config/),
[environment directives](https://vitest.dev/guide/environment.html),
[TypeScript compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API),
[Convex authorization](https://docs.convex.dev/auth/functions-auth),
[Node builtin access](https://nodejs.org/api/process.html#processgetbuiltinmoduleid)
and [OWASP authorization practice](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).
Installed Vitest 4.1.9's `detectCodeBlock` and TypeScript 6.0.3 were inspected too;
the current Vitest website documents a newer release. The generated repository
Convex guidelines govern the fixture API. Documentation supports the design;
executed controls establish only the behavior they exercised.

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

A financed sale whose application is foreign or missing falls back to kind
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
| `supplierStatement.settled`, AP and AR | Complete query declaration and tenancy import; exact scope initializer and both helper argument lists | Current 89 settled caller cells, retaining the original 38 and later multi-row, permission, partial-recovery, distinct-target and mixed-section outcomes |
| `supplierStatement.outstanding`, AP and AR | Complete query declaration and tenancy import; exact scope initializer and both helper argument lists | Current 772 outstanding caller cells, retaining the original 721 and later multi-row, permission, partial-recovery, distinct-target and mixed-section outcomes |
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

Historical feature measurement, 2026-11-10: at the 100-row-per-family bound, instrumented handler calls with distinct targets
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

## Historical SCRUM-943 runner integrity, round 3

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


## Historical SCRUM-943 contracts, rounds 4 and 5

The following records the earlier design. Round 6 added execution-closure and
authorization-condition checks. Round 7 supersedes the limits identified below.
Use the current contract above for evidence at this head.

A bound title owes a literal number of asserted cells in the file's pinned
afterEach, whether or not its runner opened an audit. The census compares this
literal title/count table with DECLARED_CALLER_CELLS and the older door cells.
Teardown requires one audit and the declared receipt count, then verifies the
ordered receipts. A no-op runner, entry return or parameter truncation therefore
fails behaviourally. Round four declared 891 caller cells. This was an inventory,
not evidence that a registration resolves to its intended runner. Round five adds
six denied-viewer cells, giving literal inventories of 89 settled, 772 outstanding
and 36 relationship cells. The original 831 outcomes are retained.
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
Iteration targets in for/in, for/of and for/await/of are writes too, including
nested destructuring and property targets. The guard unwraps parentheses,
non-null assertions, both type-assertion spellings and satisfies expressions
before checking the root. This follows the [ECMAScript iteration assignment
semantics](https://tc39.es/ecma262/2026/multipage/ecmascript-language-statements-and-declarations.html#sec-for-in-and-for-of-statements)
[TypeScript assertion erasure](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html#type-assertions),
and [satisfies checking](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html#the-satisfies-operator).
These static forms cannot be treated as opaque dynamic code: a replacement that
forges receipts otherwise passes the per-title count without executing cells.
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

Round five replaces the premise that enumerating prohibited write syntax is
sufficient. `ADMITTED_RUNNER_REFERENCES` is a literal per-name table of reviewed
declaration or registration sites, reference forms and exact counts. The inventory
covers every pinned top-level declaration and import binding, including types and
Vitest APIs. A second binding with a protected name refuses anywhere in the file:
parameters, defaults, destructuring, local variables, named functions/classes,
catch bindings and import aliases. Labels and noncomputed property keys are not
bindings or value references. Four existing helper-local shadows were renamed to
satisfy this rule; only their runner fingerprints were renewed.

Each protected reference must match that table. `navigationCells` and
`relationshipCells` are admitted only as direct callees in literal registration
bodies. Receipt state is admitted only within its fingerprinted declarations and
teardown. `callerAudits` has five references: four in teardown and one in
`beginCallerAssertions`. `EXPECTED_CALLER_RECEIPTS` has one reference, in teardown.
The assertion helpers also have exact-count admissions in the existing direct
helper contract. An alias, argument, spread, property/method reference, reflection
argument, typeof or export outside these sites refuses. Every test/describe/it
callback, including nested ones, must be an arrow or function expression with zero
parameters. No current callback requires a context exception. Unbound titles must
leave zero receipts, independently checked by teardown.

Given these admissions and the runner pins, bound cells run and assert through the
pinned runner. The table is a tripwire, not a proof of arbitrary JavaScript.
TypeScript compiler symbols resolve mutation roots: assignment, compound update,
delete and iteration writes require a binding declared in this file. The listed
Object/Reflect mutation APIs require their first argument's binding to be declared
inside the enclosing function. There are no existing Object/Reflect mutation API
sites in the behavioural file that require exceptions. Dynamic import() refuses.
Literal bracket members and erased wrappers resolve to the same intrinsic API as
dot access. A mutator method cannot escape into an alias, bind/call chain or other
value position. This follows [ECMAScript property-access evaluation](https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-property-accessors)
and uses the TypeScript AST rather than callee-text matching. The new regression
first failed when literal bracket and parenthesized calls were admitted.
The ordinary call-through db.get spy remained within its pinned helper. At round
5 no census read supplierReadCache.test.ts or tenancy.test.ts. Round 7 supersedes
that limitation with closure pins and an authorization-row census.

[Vitest hooks](https://vitest.dev/api/hooks.html) run afterEach after each test,
with after hooks reversed in the default stack sequence. The repository setup
hook registers before this file; this file's teardown runs first. An installed
4.1.9 probe checks the hook order and currentTestName at teardown. The 48 bound
registrations are top-level literal titles, so currentTestName matches the table
key directly. Nested suite titles use a ` > ` separator and would need an explicit full-name key and census
support before becoming bound registrations.

At round 5, vitest.config.ts loaded vitest.setup.ts. Read in that round, it registered
lazy React DOM cleanup only and had no matcher override. It executed before the
test module and was outside that round's closed inventory; it could be edited to
override matchers. Configuration, setup files, Vitest and imported test helper
implementations were not fingerprinted at that round. Round 7 supersedes this
setup/config/helper limitation. The canary detected
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
contracts), and at round 5 requireTenantAuth (permission preservation only).
Round 7 extends authorization through the derived helper graph above.
The cache contract writes three distinct literal documents plus a deleted id in
each of its five table families, then checks misses and hits against independently
written full snapshots, including literal creation times and seeded ids. Missing
results stay null. Auth contracts compare returned and persisted role permissions
with independent literal snapshots across names, cardinalities, deleted roles,
explicit and legacy system-owner states, and live impersonation grants in query
and mutation contexts. OWNER-named roles have both false and absent flags, each
with full and short sets; a same-length set missing a frozen permission varies
the fallback membership check. Missing, revoked, expired and exact-expiry grants,
disabled users, suspended organizations and offboarding memberships refuse before
returning a role. Grant fixtures use the actor, target, membership and expiry
fields written by adminImpersonation. Current production admits a deleted role
whose stored permissions satisfy the request; this contract pins that behavior
and left the product decision to the owner. At round 5 no tenancy.ts declaration
was fingerprinted. Round 7 pins reached helper declarations and module
initializers; unrelated function bodies remain outside that inventory.
Each round-4 cache registration required nine expect calls outside its helper, and the
auth snapshot registration requires seventy-two, including caller-role identity,
so an empty helper/loop fails. These
are call counts, not matcher-execution proof. Separate negative contracts exercise
the receipt-count checker and each cache fingerprint with a deliberately wrong
input, independently of their normal positive callers.

A finite table cannot refute an arbitrary predicate over values that a navigation
permission decision does not evaluate, such as a role display name, make or future
time. Whole-body pins close unreviewed predicates inside their declared statements;
contracts give finite behavioural evidence at imported boundaries. Neither proves
arbitrary predicates further down the import graph. Out of scope are money and due
reader internals (supplierObligationDue, supplierObligationFacts, supplierSettledRows,
supplierSettlement, money, supplierDueDates) and transactionReadHeadroom. At round
5 subscriptions and deeper requireAuth/impersonation/owner implementations also
lay outside the contract; round 7 includes their reached authorization helpers.
Other transitive imports retain the trust boundary described above.

The syntax scan still cannot evaluate general computed member names, reflection
through a value obtained outside the file, prototype/constructor indirection,
generated code, computed loaders or code inside imported modules. At round 5 the
setup file, test framework and runner/census implementation remained trusted inputs;
neither an admitted reference nor a fingerprint proves their arbitrary semantics.
Direct intrinsic/global mutation syntax and dynamic imports in the behavioural
file refuse. A local alias of an external value can still hide reflective effects.
A coordinated wrong renewal of pins, reference admissions, counts and cells
remains a review risk. This is a tripwire, not a security boundary.
