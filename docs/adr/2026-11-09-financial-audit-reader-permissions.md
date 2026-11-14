# Financial audit copies inherit their source reader's permissions

Date: 2026-11-09. Issue: SCRUM-936. Baseline: 0498711b0cd642631a4b5c85a1b60fca01c7257f.
Status: accepted for implementation, pending independent review.

Invariant: `financialAudit.listAuditLog` must not disclose an amount, protected
identity, or free text that the source reader withholds from the same viewer,
whether through role permissions or plan entitlement. Supported legacy data must
not make the audit page fail. These requirements apply to historical rows too.
`manage:finance` authorizes reading the event trail, not every copied payload.
The coordinator supplied SCRUM-902 c24475 and the S850-R5-1, S850-R6-1 and
S850-R7-PRE-1 reproductions. Jira, review seats and release work belong to the
coordinator. This change writes no production data and activates no pilot door.

## Decision and alternatives

Candidate A projects every result of the four audit query branches through one
exhaustive action-policy table. The action union comes from the stored schema.
An unclassified action fails compilation and a runtime coverage test. The
restricted result contains explicit event metadata, fixed amount-free text and
validated counts. It excludes arbitrary payloads and command keys. Safe opening
edit summaries introduced by #792 retain their existing version/count contract
through an allowlist, including when an older row contains extra amount fields.

Candidate B changes writers to store summaries only. This reduces copied data,
but cannot protect historical rows and permanently discards detail even from
authorized auditors. Every new writer could independently repeat the defect.

Choose A. Also remove numeric totals from new descriptions; structured payloads
remain available to authorized readers. No text parsing determines permission.
Reuse the cost predicate and the existing payroll and commission grants. Opening
payroll checks must cover allocation kinds and legacy employee control lines.
The ordinary-finance, cost and commission classifications are established from
the complete writer census, rather than from action names alone. Mixed actions
such as `POST_EVENT` and `ALLOCATE_PAYMENT` need their resource-specific policy.
Pending manual journal drafts keep the existing `manage:finance` audience.

## Impact and design attacks

Writers remain append-only. Stored rows, reversals, retries and voids pass through
the same projection; there is no migration, deletion, balance change or reversal
obligation. Tenant authentication and indexed organization scoping remain on the
server. Authorized readers retain original rows. Resource, actor, action and time
remain visible, while payload entity ids and arbitrary text are withheld.

Predicted failures to test: a branch bypasses projection; a new action lacks a
classification; legacy descriptions or payload ids leak; cost access bypasses
payroll withholding; ordinary finance or authorized commission readers lose data.
Public-function tests exercise each branch, source-reader negative controls and
authorized positive controls. Mutants remove each branch's projection and the
posted-journal classification. UI consumers are enumerated before finalization.
Local `convex-test` proves serial behavior, not platform limits, OCC, cloud
behavior or production prevalence. Independent seats and CI remain outstanding.

## Sources checked

- [OWASP Logging Cheat Sheet, data to exclude](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#data-to-exclude): restrict sensitive log data and log access.
- [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html): least privilege, deny by default, server-side checks on every request and authorization tests.
- [Convex auth in functions](https://docs.convex.dev/auth/functions-auth): derive identity from the function context on the server.

These sources support the design; repository tests must establish the behavior.


Implementation review refined the projection before freeze. Restricted rows
retain the resource type and audit-event id, and replace protected source ids
with `WITHHELD`. The SCRUM-850 regression now asserts that stronger exclusion.
Opening void text uses the maintenance reader's manage-payroll grant, distinct
from opening allocation readback's view-or-manage grant. Untyped historical edit
payloads without a provable payroll audience are withheld even if today's draft
no longer contains employee controls. Unwind actors retain the same remittance
fields as `unwindStatus`, through its shared predicate, while free text and the
forward contribution stay withheld. Both `lines` and `lineCount` producer shapes
retain their counts.

The new indexed journal-to-opening lookup follows [Convex's native index
pattern](https://docs.convex.dev/database/reading-data/indexes/). Exhaustive
classification uses TypeScript's [`satisfies` operator](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html#the-satisfies-operator).


The final public-reader cross-check also retains the application reader's base
`view:sales` requirement before its finance-field projection. Application finance
audit actions and the full unwind tier require both view:sales and view:finance,
as their dedicated readers do. Sales-only access still withholds finance fields;
finance-only access cannot bypass the application's base gate. The existing
unwind-actor remittance exception remains a partial projection, with its shared
predicate. The new literal public-function regression failed first at
`c941eba60f4c1125e78775b329702a50d5cd57ef`.


The mixed-reader classification was reassessed before another patch/review round.
A uniform module gate is insufficient: an action registered in applications may
copy a cheque whose dedicated reader is collections. The corrected decision is
per actual stored object and field, not per writer module or monetary-looking
name. The source-reader matrix is:

| Action family | Full row | Restricted fields retained |
| --- | --- | --- |
| Supplier disbursement/advice and returned disbursement | view:sales + finance tier | Event metadata only otherwise |
| Cheque-face attestation | view:finance (collections.listCheques) | No sales grant is required |
| Expected-payment correction | view:sales + view:finance | Method/date under sales; cheque ids and correction description under finance |
| Unwind | view:sales + finance tier | Remittance fields under the existing sales/unwind-actor predicate |

The blanket application classification for cheque-face attestation was rejected
because the finance-only collections reader already returns every copied fact.
Public writer tests now prove that positive control and the mixed correction
reader separately. This preserves the central exhaustive projection design while
replacing an incorrect classification assumption. The new literal tests fail at
`9956ef3e01b055416dd920bce89aa85210949c8f`. No reader grant or pilot switch changes.

## Round 2 implementation refinements

Round 2 introduced an in-flight promise cache keyed by opening draft id and
one lazy lookup of the organization's EMPLOYEE_ADVANCES and COMMISSION_PAYABLE
account ids through `by_org_systemKey`. Opening and opening-journal events share
the draft decision. Caches end with the request. Missing or foreign drafts do
not grant access, and foreign account ids cannot match org-scoped controls.
The shared helper still checks employee allocation kinds before control lines.
Cutover and maintenance callers use its original account-read path. Maintenance
now calls that helper instead of maintaining a second payroll rule.

That implementation used native indexed reads and request-local promises rather than a persisted
cache, which would need invalidation when draft content or account keys change.
The public-handler regression observes actual harness database calls and compares
its result with normal public-query dispatch. It does not establish cloud costs,
bytes read, concurrency behavior, or platform-limit compliance.

The undeployed opening lookup index is named
`openingBalanceDrafts.by_orgId_and_journalEntryId`, following the generated
guideline to include every indexed field in its name. Its key order is unchanged.

All four supplier writers retain `paymentMethod`, the stored supplier snapshot
as `supplierName`, and the operation's integer `amountMinor` in `after`.
`markPaid` records the outstanding settlement amount, rather than the cumulative
paid total. Partial payment and both receipt writers record that operation's
amount. Descriptions remain free of amounts and supplier names. The existing
reader policy withholds the entire protected payload from restricted viewers
and returns the original row to authorized viewers. No historical rows are
rewritten, and no financial operation or permission is enabled.

The shared unwind predicate is named `isUnwindActor` because it governs both
forward-return authority and reader projections. Its restored SCRUM-713 comment
explains why CONFIRM alone is insufficient and why a default manager may qualify
without the finance-economics grant. The predicate is unchanged.

Official sources rechecked before these edits on 2026-11-09:

- [Convex transaction limits](https://docs.convex.dev/production/state/limits): bound database reads per function.
- [Convex indexes](https://docs.convex.dev/database/reading-data/indexes/): use equality constraints in declared field order.
- [Convex reading data](https://docs.convex.dev/database/reading-data): retrieve documents through the function context.
- [OWASP Logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html): retain structured event facts while restricting access to sensitive log content.
- [OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html): validate permissions on each request and test both allowed and refused access.

## Round 3 corrections

The projection now lives in `convex/utils/financialAuditProjection.ts`. The query
continues to project each selected row, and authorized readers receive the full
stored row. Extraction and supplier-comment reductions meet main's file-size
ceilings without changing the supplier audit payloads or raising an allowance.

The round 2 system-key lookup assumed uniqueness that legacy accounts do not
have. Replace it with a request-local promise memo keyed by each referenced
account id. The audit projection owns that memo and passes the helper a
read-only map of the draft's resolved line accounts. The helper keeps its direct
`ctx.db.get` for any account not supplied, because the contract-skew provenance
proof for the opening routes resolves only direct native database calls. A
callback or stored-promise read in the shared helper made both opening mutation
allocation arrays opaque. The shared opening payroll helper still checks employee allocations
first, then the actual line account's organization and system key. Active and
inactive EMPLOYEE_ADVANCES and COMMISSION_PAYABLE duplicates are controls.
Selecting a canonical account with `.first()` or the posting resolver would
miss a draft referencing a non-canonical duplicate. Collecting every duplicate
adds unnecessary reads. Missing and foreign drafts remain withheld.

One lazy `hasPlanFeature(ctx, orgId, "accounting")` decision belongs to each audit
request. Apply it before the owner shortcut to manual approvals, ledger posting
and reversal, migration, periods, chart repair/adoption and prepaid correction
details. INIT_CHART, UPDATE_ACCOUNT and ACKNOWLEDGE_CLOSE_WARNINGS follow their
data-class readers even though the census has no current producer for them.
Accounting migration progress also requires the feature, including batch-count
events. Pending manual drafts retain their manage-finance reader audience.

The guard refuses a new direct import from the subscription API module.
`convex/utils/subscriptionFeatures.ts` therefore owns the unchanged native plan
catalogue, getOrgPlan and hasPlanFeature. `subscriptions.ts` retains their exports
for its existing callers. Both requireFeature and the audit projection use the
same native implementation. This adds no new import exception or feature logic.

Two mixed action types need resource-specific treatment. POST_EVENT sign-offs
follow `accountingCutover.listSignOffs`, which has no accounting feature gate.
POST_MANUAL_JOURNAL openings follow the independent opening readers. Without
entitlement, only a same-org journal with category OPENING_BALANCE proves that
exception. A missing, foreign or unresolvable journal does not prove it. Other
opening, supplier, sales, commission, application, bank and cutover sign-off
families retain their existing role checks and full/partial projections.

Use the native subscription decision rather than a new expiry calculation.
`getOrgPlan` maps missing and non-active subscriptions to free. Active status
uses its stored plan even if currentPeriodEnd is old. Restoration is visible on
the next request. A blanket gate on the query would hide independently readable
families and the event trail, so it is rejected. Rewriting stored audit rows
would discard authorized evidence and cannot replace read-time projection.

Sources rechecked on 2026-11-09: [Convex reading data and unique-result behavior](https://docs.convex.dev/database/reading-data#using-a-unique-result),
[indexes](https://docs.convex.dev/database/reading-data/indexes/),
[limits](https://docs.convex.dev/production/state/limits), and the OWASP
[Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
and [Logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
cheat sheets. The regression suite establishes local behavior. These sources do
not establish cloud resource usage, concurrency, or production prevalence.
