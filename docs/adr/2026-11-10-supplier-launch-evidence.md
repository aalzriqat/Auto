# Refuse launch without complete supplier identity evidence

Status: proposed implementation, SCRUM-868 P7. Base: `68be2346d9e2441e9d5bcf88cb980d9ad9189cd6`.
Rulings: SCRUM-868 c23871/c23873, OQ-1/OQ-3/OQ-4/OQ-12; SCRUM-760/761/762.
Extends the P4a, P4b and P5 ADRs. This is evidence and release gating only.

## Invariant and census

Launch refuses unless a complete read of the supplier-bearing pilot records
finds zero missing canonical identities. An incomplete read is UNAVAILABLE.
No client role can read this report. The internal query never writes.

The census extends the ten tables in design section 4.1 with
openingPayablePayments, whose P5 writer binds a supplier opening payment through
its payable. Omitting that parent link would hide orphan payment evidence.
Two role clarifications prevent false positives: OWNED ON_ACCOUNT intake stores
its creditor on the payable, not the vehicle; recovery receipts inherit identity
through their recovery, rather than a nonexistent receipt supplierId field.

| Table | Required identity | Exemption | Count index |
| --- | --- | --- | --- |
| vehicleSupplierPayables | supplierId | OPENING OTHER_PAYABLE without a selected supplier, exactly P5/OQ-4 | by_creation_time |
| vehicleSupplierReceivables | supplierId | none, including terminal rows | by_creation_time |
| supplierCostRecoveries | supplierId | none, including OPENING and terminal rows | by_creation_time |
| supplierCostRecoveryReceipts | same-org recoveryId parent supplierId | none; absent/foreign parent counts unresolved | by_creation_time, parent get |
| openingPayablePayments | same-org payableId parent supplierId | parent is ordinary OPENING OTHER_PAYABLE | by_creation_time, parent get |
| vehicles | sourcedSupplierId when SOURCED | STOCK; soft-deleted vehicles, as P3 count | by_creation_time |
| vehicleOwnershipConversions | supplierId when supplierName exists or fromSourceType SOURCED | history without a supplier; toSourceType alone does not imply a stored supplier | by_creation_time |
| financeApplications | supplierGapBasis.supplierId when basis exists | no basis | by_creation_time |
| expenses | vendorSupplierId and costBearerSupplierId when SUPPLIER | ordinary SHOWROOM vendor text per OQ-3; deleted expenses | by_creation_time |
| vehicleEdits | effective sourcedSupplierId or payload.purchaseSupplierId for pending supplier intake | resolved requests; metadata-only updates inherit existing sourced identity | by_creation_time, vehicle get |
| openingBalanceDrafts | allocations[].supplierId for SUPPLIER_PAYABLE and SUPPLIER_RECOVERABLE | other allocation kinds; id-less OTHER_PAYABLE ordinary creditor | by_creation_time |

Each reason counts affected rows, not amounts. A draft with two unresolved
supplier allocations counts once per reason. No status exemption is invented
for posted, rejected or voided drafts. Historical replay fallback is not launch
evidence. Missing UPDATE source vehicles make the table UNAVAILABLE.

## Two places to run the check

1. The trusted exact-SHA accounting rehearsal executes against a disposable
   runner-local backend. It can prove synthetic behavior but cannot measure
   the deployment's existing data. A clean rehearsal cannot prove no migration.
2. The existing post-deploy rollout uses CONVEX_PROD_OPERATOR_KEY to run internal
   queries after deployment identity verification. Choose this path. Add a
   read-only phase before either successful exit, after the existing P3 repair
   on a populated deployment. Preserve that separately authorized repair.

The deploy has already happened when this phase refuses. The run must say
DEPLOYED but INCOMPLETE, never launch-ready. No new secret, deploy key,
environment, branch-protection rule or workflow authority is required. No
workflow YAML change is needed. The existing exact-SHA rehearsal and producer
bound trusted-accounting-release-verdict remain separate required evidence.

## Read limits and failure handling

Scan each table globally in its native by_creation_time index, including rows
whose organization no longer exists. One query performs one paginate call,
at most eight source documents and eight same-table parent/source gets, with
maximumRowsRead 64 and maximumBytesRead four MiB. The scan has no filter and
returns at most eight documents. The byte budget plus one maximum-size document
of stopping headroom and eight maximum-size joined documents is thirteen MiB,
below the sixteen MiB transaction limit. There are at most nine index ranges.
The row budget is deliberately above numItems: reaching maximumRowsRead itself
can return SplitRequired, even on small documents. SplitRequired refuses with
UNAVAILABLE because its page may be incomplete. No collect or post-filtered
bounded sample can stand in for a full walk.

The caller walks each continuation to READY within the shared rollout deadline
and a fixed page cap. A limit, exception, malformed page, non-progressing or
repeated cursor, excessive page size, unknown reason, unsafe count, missing
table result or exhausted bound is UNAVAILABLE. Partial counts are withheld.
Unexpected query errors are logged server-side and return a fixed coded
UNAVAILABLE response. Counts and fixed table/reason codes are the public output;
the opaque pagination cursor is transport metadata and is never logged.

Pagination is not a deployment-wide atomic snapshot. Supported new writers
already require identity. This proves the completed bounded walk, not absence
of later administrative patches, OCC behavior, cloud limits under load or
full accounting certification. The harness cannot certify those properties.

## Exclusions

No posting, settlement, allocation or opening policy change; no P6 journal
dimension; no migration, backfill or automatic repair; no SCRUM-869 reversal,
unwind or correction activation; no mobile money writes. Existing production
rows, including the accepted test recovery, receive no newly invented exemption.
If such a row fails the census, launch stays refused pending the coordinator's
owner ruling. This session does not read production.

## Five predicted failures

1. A truncated read becomes zero. Test pagination across a page and over-budget,
   malformed, unavailable and stalled continuation responses.
2. A table or role is missed. Use an independent literal eleven-table oracle and
   real missing-id fixtures per table; remove a table as a source mutant.
3. An exemption hides a real supplier. Test OPENING supplier rows beside an
   ordinary creditor, supplier-borne payee and bearer separately, and terminal
   recoveries beside active ones.
4. A partial edit or inherited receipt is falsely clean. Test typed-name swaps,
   metadata updates, missing source vehicles and missing/foreign recovery parents.
5. Evidence leaks tenant values or a release exits early. Deep-equal the entire
   query and gate result; exercise both rollout success exits with refusal and
   failed-call evidence. Register the preventive scenarios without bugRef.

## Sources

Checked 2026-11-10: [Convex transaction limits](https://docs.convex.dev/production/state/limits),
[pagination and native read budgets](https://docs.convex.dev/database/pagination),
[indexes](https://docs.convex.dev/database/reading-data/indexes/), and
[internal functions](https://docs.convex.dev/functions/internal-functions).
The internal query and CLI caller follow these native patterns; a maintained
counter would require money-writer changes and cannot certify old documents.
[GitHub Actions secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)
supports preserving the existing step-scoped credential rather than adding one.
Documentation supports the design; executed tests and runtime evidence must
separately prove its implementation.
