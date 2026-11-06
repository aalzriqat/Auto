# Supplier identity before a recoverable cost

Status: proposed implementation, SCRUM-868 P4a. Base: `26ddea47c`.
Extends [the supplier identity design](../architecture/scrum868-supplier-identity-design.md), N3, N5, N6 and N11.
Rulings: SCRUM-868 c23871, c23873 (OQ-3, OQ-5, OQ-6), c24476 and c24646.

## Invariant and scope

A supplier-borne cost recovery, and any expense whose cost bearer is SUPPLIER,
may be created or moved to a money-bearing state only when the bearer resolves
to a canonical, org-matched supplierId from the vehicle's sourcedSupplierId
(or the creditor id used by that route's existing helpers), never from a name.
Otherwise the mutation throws a coded EN/AR refusal and leaves no row, posting,
idempotency claim, notification or partial state.

SOURCED vehicles are consignment. The cost is a supplier receivable, not a
showroom expense or inventory cost. Identity adds no posting or amount change.
No creditor fallback is appropriate for this SOURCED-only expense route.

## Impact map

Enumeration: Graft's supplierCostRecoveries graph (1262 indexed files, one
unreadable file) plus tracked-source `git grep` for supplierCostRecoveries,
openSupplierCostRecovery, recordPaidExpenseSideEffects, supplierBearerRefusal
and costBearer across convex, components, app, apps/mobile, scripts and
dealer-worker at the base. The tracked-source search closes the graph gap.
The table distinguishes proposed identity gates from existing containment.

| Door or consumer | Gate after P4a |
| --- | --- |
| expenses.create PENDING and PAID | Gated before insert by shared bearer resolver; payment rechecks |
| expenses.update effective bearer, vehicle, and PENDING to PAID | Gated before patch by same resolver; payment rechecks stored row |
| recordPaidExpenseSideEffects -> openSupplierCostRecovery | Gated at payment boundary and recovery insert; server snapshot name/version/id |
| workOrders.create/update completion -> expense | SUPPLIER already refused server-side (SCRUM-402); unchanged |
| supplierCostRecoveries.recordReceipt | Existing requireResolvedSupplierId on stored recovery before money and inside idempotent command; unchanged |
| supplierCostRecoveries.reverseReceipt | Existing pilot server refusal before writes; unchanged |
| expenses.reverseExpense/remove -> recovery reversal | Existing supplier reversal/deletion containment; unchanged |
| openingAllocations supplier-recoverable insert | Not identity-gated by P4a; P5 explicitly owns OPENING |
| supplierIdentityRepair repairPage/countPage | Existing explicit link/name proof and unresolved count; unchanged, including terminal rows |
| orgFinancialReset/adminOrgs deletion and openingResetCleanup | Administrative destructive cleanup, not new money; existing auth/reset gates unchanged |
| adminData generic table writes | expenses blocked by assertAdminMayMutateTable; supplierCostRecoveries outside ADMIN_TABLES; unchanged |
| Supplier recovery list/listReceipts/listReceiptBankOptions | Existing tenant and finance/cost access; no new identity gate on historical reads |
| supplierReceivables, accountingReports, supplierStatement via supplierObligationDue | Existing bounded tenant/cost readers; legacy unlinked history remains readable |
| vehicleSupplierIdentity and costBearer conversion refusal | Existing link freeze and open-recovery conversion block; unchanged |
| workflowHooks/postingRules, outbox drain | Payload consumes already-authorized expense; no separate recovery writer or bearer setter |
| crons, webhooks, dealer-worker | No recovery insert or SUPPLIER expense setter found in the tracked-source enumeration |
| web ExpenseDialog -> expenses.create/update | Server gates; picker explains missing supplier link before submit in EN/AR |
| web SupplierCostRecoveriesSection -> recordReceipt | Existing coded error localization and server gate; unchanged |
| web WorkOrderDialog | SUPPLIER disabled and server-refused; unchanged |
| mobile expense form/facade -> expenses.create/update | Does not offer/send costBearer; forged calls encounter same server identity gate |
| e2eBootstrap and accounting rehearsal | Test fixture/diagnostic readers and public-door callers, not bypass writers |

There is no separate expense approval mutation: update is the PENDING to PAID
door. Receipt reversal, expense reversal, return, void, cancellation and refund
gain no new capability here. A sale cancellation does not own a recovery.
Retries keep the first stored snapshot. No migration runs on release.

## Two designs and choice

1. Add separate supplier lookups at every public door. This duplicates the
   definition and can miss a later payment or internal recovery writer.
2. Reuse supplierRegistry resolution in the shared expense gate and the recovery
   writer. Choose this. `requireResolvedSupplierId` checks the expense vehicle's
   stored id without passing origin OPENING. The writer uses
   `requireSupplierSnapshotForCompletion`, which reads id, name and version
   together and shares the same unresolved code. Like existing vehicle-based
   completion, it permits an inactive linked supplier so lifecycle obligations
   remain serviceable. It never guesses from a name. The source vehicle's old
   name remains its intake snapshot; the recovery captures the master at payment.

Keep costBearer's schema-imported module a leaf. Its pure predicate handles
shape restrictions; the async backend resolver handles identity. Expected
identity errors use ConvexError; unexpected lookup failures are logged only on
the server and rethrown as generic errors. Never catch and return after
financial writes. Existing doors without catches retain rollback semantics.

## Explicit exclusions

- The existing id-less RECOVERED row awaits an owner ruling. Do not change its
  count, repair behavior or content. No migration (c23871, c24476, c24646).
- Expense payee and bearer id fields are P4b, including OQ-3.
- Openings are P5. Journal supplier dimensions remain deferred under OQ-5.
- Mobile supplier UX/enablement remains excluded under OQ-6. No argument or
  client contract changes. A valid web payload is not distinguishable by device.

## Five predicted failures and checks

1. Only PAID create is covered: public tests attack PENDING create, bearer edit,
   vehicle edit and payment of an older pending SUPPLIER expense.
2. An id is accepted without ownership/existence: public tests inject foreign
   and deleted supplier ids, require the same coded refusal, and compare state.
3. A refusal follows writes or is swallowed: compare all main-schema tables
   before and after each refused mutation, including posting/outbox/commands.
4. Name/version mix or retry duplicates money: assert literal minor amounts,
   master snapshot, rename then retry, one recovery and unchanged ledger state.
5. Legacy history becomes unreadable or repaired on read: read a terminal
   id-less recovery with a missing vehicle twice and assert unchanged storage;
   existing receipt/reversal containment stays in force.

Pre-code advisory design attack (separate agent): accepted the finding that the
old intake-name predicate must be removed, including the missing-id/missing-name
case. Public tests pin both that refusal and valid-id/empty-name acceptance.
The resolver receives only `{supplierId}`, never an OPENING origin. Added
inactive-link and committed legacy retry controls. The expense picker treats
an unavailable vehicle as unproven and explains this before submission.
Supplier ids survive vehicle cost redaction (`vehicleCostVisibility.ts`).

## Sources and evidence boundary

Checked 2026-11-06: [Convex application errors](https://docs.convex.dev/functions/error-handling/application-errors),
[validation](https://docs.convex.dev/functions/validation),
[mutations](https://docs.convex.dev/functions/mutation-functions), and
[transaction rollback](https://docs.convex.dev/components/using#transactions).
These support structured client-safe errors, runtime validation and atomic
mutations. [Oracle Payables setup](https://docs.oracle.com/cd/E26401_01/doc.122/e48761/T434884T434887.htm)
assigns unique supplier numbers; [Oracle Accounting Hub identifiers](https://docs.oracle.com/cd/E26401_01/doc.122/e48831/T193592sdanechap.htm)
distinguishes transaction identifiers and supplier names/numbers. Using an
immutable party id beside a readable snapshot follows that practice; AutoFlow's
tenant and lifecycle rules determine the actual implementation.

convex-test proves harness behavior, not Convex cloud limits or concurrency.
Rendered EN/AR desktop/mobile verification, the three bug hunters, independent
review seats, actual-backend certification and Sonar new-code coverage require
their own evidence. No deployment or pilot certification is claimed here.

## Round 3: reconciliation linkage after rename

SCRUM-868 c24656 is reproduced through public `suppliers.update`, paid
`expenses.create`, completed `sales.create` and the public reconciliation.
A linked master renamed `Unknown supplier` must remain linked in both recovery
and margin buckets. One row classifier now uses stored `supplierId` first, then
the unchanged normalized-name rule for id-less rows. Money, postings, refusal
reasons and limits do not change. The two rename scenarios cite test-only commit
`19d5faa64723307c0346b52be7575cc831c1e9bc`: 2 failed, 10 passed in the focused run.
The four affected suites pass 168 tests after the fix.

No additional master/org lookup is added to this diagnostic. The report fetches
both tables through `by_org_status`. Native recovery creation resolves the id
with `requireSupplierSnapshotForCompletion` in `supplierCostRecoveries.ts`;
sale preparation does the same before `saleCompletion.ts` passes its resolved
id to `openSupplierReceivable`. The resolver refuses missing and foreign
masters. Existing public P4a tests cover those refusals. The bucket reports a
stored link, not a new certification of master existence or ownership. Extra
reads would change the bounded report's budget and refusal contract. Id-less
legacy rows are patched only in test setup because current native writers
cannot create them. OPENING controls use the public cutover door and stay
id-less until P5. Blank/default/real names retain the legacy split; OPENING
controls cover default and real names because public opening validation refuses
blank counterparties.

The tracked-source census used `git grep -n -E
"isUnlinkedSupplierName|Unknown supplier|sourcedFromName" -- convex/ components/`
and inspected production matches. Disposition for SCRUM-879, without changing
these unrelated decisions:

| Reader | Name use and disposition |
| --- | --- |
| accountingReports.ts, both reconciliation loops | Name-only money buckets fixed here. Id-less fallback retained. |
| utils/saleCompletion.ts, prepareSale | Blank/default intake name refuses even before canonical-id resolution. Follow-up. |
| financingEconomics.ts, supplier concession eligibility | Blank intake name means ineligible, then supplier id is required. Follow-up. |
| utils/supplierConcession.ts, concession validation and frozen basis | Blank name and snapshot-name comparisons accompany supplier-id checks. Follow-up. |
| utils/vehicleSourceShape.ts, assertShapeFor and update checks | Name presence/change enforces source shape. Follow-up. |
| utils/vehicleSupplierIdentity.ts, resolveSourcedForUpdate | A changed nonblank name without an id refuses through the resolver. Follow-up. |
| utils/vehicleSupplierIdentity.ts, first-link proof | Name/alias corroboration for id-less vehicle and obligation history; present ids compare by id. Follow-up. |
| utils/supplierRegistry.ts, supplierNameEvidence | Name/alias evidence corroborates an already selected in-org id. Follow-up. |
| supplierIdentityRepair.ts, PAYABLES/RECEIVABLES/RECOVERIES phases | Only id-less rows use name/version evidence against a vehicle's resolved id. Follow-up. |
| vehicles.ts, import supplier-term and sameCreditor comparisons | Uses ids when both exist, otherwise legacy snapshot-name comparison. Follow-up. |
| utils/openingSupplierBasis.ts and utils/openingSupplierPosting.ts | Name equality proves opening allocation/posting provenance, not a linked money bucket. Preserve; follow-up review with P5. |
| components/vehicles/VehicleImportDialog.tsx, validateRow | Blank sourcedFromName rejects an import row in the UI. Follow-up. |

Other matches in applications, sales, sourcedAgentImpact, sourcingPayables,
supplierCostRecoveries, supplierReceivables and the matching components are
snapshot projection/display, posting memo text, or typed input plumbing.
`supplierReceivables.outstandingSummary` groups by supplierId, using a per-row
unresolved key when absent; snapshot-name arrays do not classify money linkage.
No component match computes the reconciliation buckets.

Sources rechecked on 2026-11-06: [Convex testing](https://docs.convex.dev/testing/convex-test)
supports authenticated public-function tests with real stored documents in the
test implementation. [Convex validation](https://docs.convex.dev/functions/validation)
defines optional ids and runtime argument validation.
[Oracle supplier numbering](https://docs.oracle.com/cd/E26401_01/doc.122/e48761/T434884T434887.htm)
uses unique supplier identifiers. Giving the stored id precedence over a mutable
display name is our application of that identity practice, not an Oracle rule
about AutoFlow's legacy buckets. These checks do not establish cloud/runtime,
production, browser or independent-seat certification.
