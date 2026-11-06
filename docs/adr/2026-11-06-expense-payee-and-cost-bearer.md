# Separate an expense payee from its supplier cost bearer

Status: proposed implementation, SCRUM-868 P4b. Base: `fe87a828f80fc1eb13d8283b316618899230f57b`.
Extends [P4a](2026-11-06-supplier-cost-recovery-identity.md) and the
[supplier identity design](../architecture/scrum868-supplier-identity-design.md), section 4.4.

## Invariant and owner contract

A new supplier-borne expense records an org-owned canonical payee and the
vehicle's server-resolved bearer supplier id; payment recovers from that bearer,
never creates a garage payable, and never recognizes a recoverable showroom cost.

SCRUM-868 c23873 says exactly: "OQ-3: a payee id is required on supplier-borne
expenses, matching the attacked design. Other expenses keep their current payee field."
Apply this to PENDING and PAID creation and new supplier money transitions.
`vendorSupplierId` identifies the garage; `vendor` is its server-read name snapshot.
`costBearerSupplierId` identifies the consignment supplier and is never an argument.
Once PAID, both identities and the payee snapshot are immutable. This preserves
the attacked design's conservative correction policy, without enabling a correction door.

## Impact map

Enumeration at the base: `graft grep SupplierSelect`, `graft callers
recordPaidExpenseSideEffects --depth all`, `graft callers openSupplierCostRecovery
--depth all`; tracked-source `git grep` for expense inserts, expense queries,
costBearer, vendorSupplierId, supplier identity and mobile facade references across
convex, components, app, apps/mobile, scripts and dealer-worker. Graft locates;
source reads establish the paths. Generic admin/reset writers are included below.

| Door or consumer | Identity gated? | Treatment |
| --- | --- | --- |
| expenses.create, PENDING or PAID | Yes | Require selected payee; resolve bearer from live org vehicle before insert; new parties must be ACTIVE |
| expenses.update, bearer/vehicle/economic edit | Yes | Recheck effective SCRUM-389 shape and identities; changing bearer clears/sets canonical fields; never post from identity-only edit |
| expenses.update, notes/payer or unchanged fields | No new party gate | Preserve historical ids/snapshots; do not strand notes when linked supplier/car disappears |
| PENDING to PAID, recordPaidExpenseSideEffects | Yes | Require explicit payee-id confirmation plus stored payee/bearer; prove bearer still matches vehicle; allow inactive parties already accepted on this expense |
| openSupplierCostRecovery | Yes | Resolve name/version from expense bearer id, not the payee; no second financial authority |
| expenses.remove | Existing gate | Posted/live recovery refuses; pending deletion preserves audit identity |
| expenses.reverseExpense; recovery.reverseReceipt | Existing pilot refusal | No supplier unwind enabled; no new refund, void, return, bounce, cancellation or reversal route |
| supplierCostRecoveries.recordReceipt | Existing gate | Stored recovery supplier, independent of payee; no change |
| workOrders create/update completion | Existing refusal | SUPPLIER forbidden server-side, SHOWROOM expense unchanged |
| collections cheque-return fee expense | No supplier party setter | Existing SHOWROOM-only fee; unchanged |
| accountingMigration; migrateExpenseReversals | No new identity writes | Existing treatment/reversal repair; no party inference |
| imports, crons, webhooks, dealer-worker, outbox | No new identity writer | No independent SUPPLIER expense entry found in enumerated sources; outbox consumes authorized payload |
| adminData | Existing table refusal | Expense writes blocked; no generic bypass |
| orgFinancialReset/adminOrgs/openingResetCleanup | Existing administrative gates | Destruction/cleanup, no new money or guessed identity |
| opening allocations | Not covered | P5 owns supplier opening identity |
| expenses.list, ExpenseDialog, expense page | Read auth; write gate above | Return optional fields as stored; picker for supplier payee, distinct read-only bearer explanation, EN/AR and RTL |
| reports, dashboardExpenseSummary, dashboard, vehicleCost/dealProfitReads, branches | Existing read gates | Existing costBearer predicates remain authoritative for money; no new grouping by payee |
| supplierStatement/accountingReports/supplierReceivables | Existing read gates | Recovery bearer id remains authority, never vendorSupplierId |
| vehicleSupplierIdentity; saleCancellation; vehicles readers | Existing lifecycle gates | Pending supplier expense freezes vehicle link; identity-only edits never change economics |
| mobile expense facade and form | Server refuses supplier requests without explicit canonical payee | Facade has no payee-id or bearer controls; name-only supplier creates and PENDING payments, including canonical stored rows, refuse |

The auth token currently supplies no trusted device discriminator. A forged full
web-shaped request cannot be distinguished from web by adding a caller flag.
Every supplier payment requires an explicit canonical payee id in the invocation,
which the mobile facade cannot supply. This slice refuses unsupported mobile-shaped
supplier money writes; it does not claim device attestation. Independent runtime evidence
is required before claiming the stronger interpretation of OQ-6.

Historical storage fields stay optional. Legacy reads and notes never backfill.
An id-less legacy supplier expense cannot acquire a new payment without the
required canonical identities. The supplied production census is 0 PENDING/PAID
supplier expenses and 2 linked live SOURCED cars; this session does not query production.
Retries use the existing org/operation/key command, with selected payee in its
fingerprint. A committed replay returns its first result before party validation.
Create/edit permissions stay CREATE_EXPENSES/EDIT_EXPENSES; inline supplier
creation still requires MANAGE_FINANCE. All supplied document ids need org ownership.
Audit identity remains on the source expense and existing recovery/command records.
No amount, ledger rule, closed-period snapshot or accounting event shape changes.

## Two designs and choice

1. Accept payee and bearer ids or names from the client and resolve each separately.
   Reject: this exposes an independent bearer choice that can contradict the car.
2. Accept only the selected payee id. Reuse the supplier registry for org ownership,
   active-new-use and inactive-completion policies; derive bearer from the car.
   Choose this. Optional typed ids preserve schema compatibility and avoid migration.

New cost against an inactive bearer is refused with SUPPLIER_INACTIVE. Previously
accepted pending obligations may complete with inactive parties; a replacement
payee or newly assigned bearer must be active. This limits new exposure without
stranding accepted rows. Tests distinguish creation from later deactivation.
Any economic edit beyond unchanged payment completion requires active parties;
an inactive pending obligation cannot have its amount increased. Same-id payee
confirmation validates ownership but preserves the accepted vendor snapshot,
including after a master rename. It is not a name refresh.

Narrow the over-broad update gate to relevant economic changes, explicit vehicle
assignment and payment, plus payee changes. Notes/payer and unchanged fields do
not re-resolve identity. Existing posting locks and SCRUM-389 checks remain.
Tests delete a referenced supplier after acceptance and prove notes still work,
identities remain unchanged and new payment refuses. The old P4a title-change
control remains gated because title is an existing material accounting field.

## Five predicted failures

1. Garage id leaks into recovery or A/P: assert distinct ids, literal 200000
   minor-unit receivable/cash lines, zero supplier payables and zero vehicle cost.
2. Client spoofs bearer or payee snapshot: runtime argument rejection for bearer,
   server snapshot overwrites typed vendor; foreign/missing parties return coded refusals.
3. Identity edit silently reclassifies money: pending payee-only edit produces no
   transaction, recovery, journal or outbox change; paid payee edits refuse.
4. New inactive use is accepted or accepted obligations become stranded: test
   inactive creation refusal, inactive completion, legacy reads and ungated notes.
5. Retry duplicates money or rewrites snapshots: rename/deactivate parties after
   success, replay the same command and compare complete stored state.

## Exclusions and proof boundary

Pre-code advisory design review identified the mobile facade's ordinary
status-only payment path, inactive amount increases and same-id snapshot refresh.
All three are accepted and closed in the design above before implementation.

No migration per c23871; no production data/key access. Openings are P5.
Journal-line supplier dimension is post-pilot OQ-5. No mobile supplier feature,
new settlement, write-off, payee correction or automatic reclassification.
The c24650 RECOVERIES=1 test-row exception is unchanged. This is implementer
evidence, not independent seats, cloud/OCC certification, Sonar, or pilot approval.
Browser proof must cover EN/AR at phone/desktop; component tests alone cannot certify it.

## Sources

Checked 2026-11-06: [Convex schemas](https://docs.convex.dev/database/schemas),
[runtime validation](https://docs.convex.dev/functions/validation), and
[ConvexError](https://docs.convex.dev/functions/error-handling/application-errors)
support optional storage fields, typed id arguments and throwing transactional
refusals. Expected supplier errors stay coded; unexpected diagnostics are logged
server-side and rethrown generically, never returned after partial financial writes.
[Oracle third-party payment attributes](https://docs.oracle.com/en/cloud/saas/financials/26d/fappp/what-are-the-changes-in-the-payment-attributes-flow-when-i.html)
distinguishes payee identity from invoice supplier identity.
[IAS 37 paragraphs 53-56](https://www.ifrs.org/content/dam/ifrs/publications/pdf-standards/english/2021/issued/part-a/ias-37-provisions-contingent-liabilities-and-contingent-assets.pdf?bypass=on)
separates reimbursement assets from the underlying obligation. These support
separate roles; SCRUM-389 supplies AutoFlow's actual recognition conditions.

## Implementer closure evidence

ADR first: `6182b5ddd`. Failing tests: `794a6c850`, 10 backend failures/1 pass
and 2 EN/AR picker failures/2 passes. Implementation: `90fa950ed`.
The broad named-file run passed 573 tests in 14 files; the final focused run
passed 23 tests in three files, and the shared supplier-door fixture consumers
passed 43 tests in four files. The regression-record validator and backend suite
passed 83 tests in two files. These runs overlap and must not be summed.

Changing resolveExpenseParties to store the payee id as the bearer killed the
mutant with 5 failures/6 passes; the original source was restored by file copy.
Local V8 evidence over the two new suites measured 145/170 changed executable
line/condition opportunities, 85.29%, against the base. This is a local diff
calculation, not a Sonar measurement. That narrow coverage invocation failed
the existing whole-file thresholds because it did not run the full legacy
expense/dialog coverage set. No threshold was changed.

Root and Convex typechecks passed separately. Root excludes convex; the second
uses convex/tsconfig.json. ESLint reported no errors and existing warnings.
Baseline identity matched 943 entries. The supplied renewal command refused
without the CLI-required --reviewed argument; adding the same base as --reviewed
checked 943 entries with zero stale, malformed or missing evidence. Twenty-one
entries were refreshed in five shards, with their UNKNOWN status unchanged.

Lifecycle closure: create, payment, pending party edit, unchanged completion,
retry, historical read, metadata, permission/tenant boundaries and the journal
route have harness evidence. Partial receipts and excluded reversals retain
their existing suites and pilot refusals. No new spending or cancellation door
exists. The web dialog also omits unchanged vehicle, date and paid method on
metadata submission, so it does not accidentally request a new economic edit.

Not measured here: real-backend execution/OCC, authenticated EN/AR browser at
phone/desktop, screen audit/explorer swarm, remote Sonar, CodeRabbit, independent
money review seats, deployment or production. None is claimed as passed.
