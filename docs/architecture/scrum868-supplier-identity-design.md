# SCRUM-868 canonical supplier identity: design packet

Status: DESIGN ONLY. No product code is changed by this document.
Author: design-phase implementer (Sonnet 5.5). Reviewers are separate seats and have not seen this yet.
Base: `origin/main` f5b533299. Jira: SCRUM-868 (stage 1), SCRUM-869 (stage 2, blocked by this).

## 0. Read this first: scope, evidence and what I could not see

**S1 is already shipped.** PR #687 merged as 6c71a7654 and is an ancestor of the base. It created the supplier master tables (`suppliers`, `supplierAliases`, `supplierRegistryState`), the per-organisation registry lock, the name and tax-id normalisers and the `convex/suppliers.ts` API. Nothing outside those files consumes them yet. This packet therefore designs slices S2 onward on top of what exists, and judges the S1 shape as evidence, not as proof of quality.

**Two owner/coordinator inputs shape this packet.**
1. Jira comment 23801 (2026-10-27) says an earlier, session-local design (S1 to S8, 11 attack rounds, owner questions Q1 to Q12) was approved by a Codex attacker. That design is not in the repository and I did not have it. Where this packet overlaps it (registry lock, `requireActiveSupplier`, an identified payee on supplier-borne expenses, a `launchEvidence` gate, SCRUM-870) I used only what the Jira comment states. Q1 to Q12 are unknown to me. See open question OQ-10.
2. Owner ruling 2026-10-29, relayed by the coordinator: "no migration needed" for SCRUM-868. The migration plan (dry-run mapping, ambiguity queue, backfill, legacy rollback) is dropped. The supplier id is required from the start for every pilot-enabled money path, with no legacy free-text fallback. Section 4 replaces the migration plan with a no-migration schema plan.

**Evidence labels.**
- INSPECTED: I read the file at the cited line on the base SHA.
- GREP: from a repository-wide search; the hit list is cited but I did not read every hit in context.
- UNVERIFIED: not checked. Listed in section 9 where it matters.

The impact map in section 2 is an enumeration claim. It was built from searches for `sourcedFromName`, `purchaseSupplierName`, `supplierName`, `counterpartyName`, `vendor`, `costBearer` and `supplierId` across `convex/`, `app/`, `components/`, `lib/`, `apps/mobile/`, `scripts/` and `playwright/`. A party stored under a differently named field would be missed. The S1 guard pattern in section 7 (an AST scan, not a grep) is the proposed mechanism to close that gap permanently.

## 1. Invariants

Numbering here is independent of the session-local I1 to I12 that S1 code comments cite.

- **N1. One id per party.** Every real-world supplier, creditor, service provider or cost bearer that appears on a pilot-enabled money record is identified by exactly one `Id<"suppliers">` of the record's own organisation.
- **N2. Never merge by display name.** No code path may decide that two records are the same party, or group, match, dedupe or authorise anything, by a name or alias string. Name keys are for candidate lookup and display only. Two suppliers may share a name; one supplier may have many spellings.
- **N3. Snapshots are immutable.** Each money record keeps the name (and, where S1 versions it, the supplier version) as it stood when the record was created. A later rename, alias, deactivation or legal-identity change never rewrites a snapshot. Display of a current name is a join on the id, never a replacement of the snapshot.
- **N4. Identity work posts nothing and moves no amount.** No new journal entry, accounting event, amount, currency, status or due date changes because a record gained or lost a supplier id. Any code in a slice that changes a posted figure is out of scope for this issue.
- **N5. Unresolved identity fails closed.** A pilot-enabled new money action (create a supplier-linked payable, receivable, recovery or supplier-borne expense; record a payment, receipt or dispute on one; complete a sale that needs one) is refused with a stable coded error when the controlling record has no resolvable `supplierId`. There is no "Unknown supplier" default and no fallback to a name.
- **N6. Org isolation.** A supplier id is accepted only after `requireOwnedRow`-style checks for the caller's organisation. A foreign id and a missing id are refused with the same message (TEN-1, no existence oracle), as S1's `requireActiveSupplier` already does.
- **N7. No second supplier ledger.** Supplier balances remain derived from the existing subledgers (`vehicleSupplierPayables`, `vehicleSupplierReceivables`, `supplierCostRecoveries` and their receipts) and the GL. The master carries no amount, balance, currency or ledger dimension (S1 enforces this with a guard test).
- **N8. Roles are per transaction, not per party.** The same supplier may be a consignment supplier on one vehicle, an on-account creditor on another and a cost bearer on a third. The role is the field the id sits in. A party-level role flag would let a record claim a role the transaction never had.
- **N9. Economic route is not physical title.** Consignment supplier (`SOURCED`), owned on-account creditor (`ON_ACCOUNT`), the settlement route (`THROUGH_DEALERSHIP` / `DIRECT_TO_SUPPLIER`) and the expense service provider are separate facts with separate fields. None is derived from another.
- **N10. Lifecycle.** An inactive supplier takes no new records (N5 by `requireActiveSupplier`) but every existing obligation to or from it can still be paid, received, disputed and reversed.
- **N11. The party on an economic record cannot be swapped after money moves.** Once any payable, receivable, recovery, receipt or supplier-borne expense references a supplier on a vehicle, the vehicle's supplier link is frozen. A wrong party needs a separately reviewed correction, which is out of scope here and is refused, not guessed.
- **N12. Idempotency identity includes the party.** An idempotent retry with the same key and a different supplier id is a conflict, not a dedupe. A retry after a supplier rename writes the snapshot of the first execution.
- **N13. Currency stays on the record.** Balances are per (supplier id, currency) at the record level; an identity change never blends currencies. The organisation currently has one currency (`getOrgCurrency`), so this is a constraint on future reads, not a present branch.

## 2. Impact map: where a party is identified today

Finding: **every money path identifies the party by a free-text name. No `supplierId` exists in any non-test, non-master file.** `supplierId` appears only on `supplierAliases` (`convex/schema.ts:8000`, `:8012`). GREP: 517 occurrences of `purchaseSupplierName|sourcedFromName` in 112 files; most are tests.

### 2.1 Stored fields (all free text)

| Table / object | Field | Role today | Schema line |
|---|---|---|---|
| `vehicles` | `sourcedFromName` (optional) | consignment supplier of a SOURCED car | `convex/schema.ts:1493` |
| `vehicleEdits.payload` | `sourcedFromName`, `purchaseSupplierName` (optional) | approval-workflow copy of the same two names | `convex/schema.ts:1954`, `:1959` |
| `vehicleSupplierPayables` (`supplierPayableCommon`) | `sourcedFromName` (required string) | A/P party: consignment payable, owned on-account creditor and opening supplier/other payable | `convex/schema.ts:104`, table at `:1802-1809` |
| `vehicleSupplierReceivables` | `sourcedFromName` (required) | A/R: margin owed by the supplier on the direct route | `convex/schema.ts:1704`, table at `:1700-1754` |
| `supplierCostRecoveries` (`supplierRecoveryCommon`) | `sourcedFromName` (required) | A/R: supplier-borne cost recovery, native and opening origin | `convex/schema.ts:46`, table at `:1775-1784` |
| `supplierCostRecoveryReceipts` | none (reaches the party through `recoveryId`) | | `convex/schema.ts:65-88`, `:1796-1800` |
| `vehicleOwnershipConversions` | `supplierName` (optional) | snapshot at SOURCED to STOCK conversion | `convex/schema.ts:1840` |
| `financeApplications.supplierGapBasis` | `supplierName` (inside object) | party the PR-C concession was agreed against | `convex/schema.ts:3479` |
| `expenses` | `vendor` (optional string) | service provider / payee, free text | `convex/schema.ts:2503` |
| `expenses` | `costBearer` enum `SHOWROOM`/`SUPPLIER` | bearer type only; the bearer party is implied by `vehicle.sourcedFromName` | `convex/schema.ts:2535`, `convex/utils/costBearer.ts:62-90` |
| `openingBalanceDrafts.allocations[]` | `counterpartyName` on `SUPPLIER_RECOVERABLE`, `SUPPLIER_PAYABLE`, `OTHER_PAYABLE` | opening party | `convex/utils/openingAllocationValidators.ts:43-45`, array at `convex/schema.ts:1313` |
| `journalLines` | none. Only a description string carries the name. No supplier dimension exists; dimensions are vehicle, customer, finance company, salesperson, cashier, bank account | | `convex/schema.ts:909-938`, `convex/accounting/postingRules.ts:253-261` |

The owned on-account creditor has **no vehicle field**. `purchaseSupplierName` is a transient argument (`convex/adminData.ts:174`) and the creditor is stored only as `vehicleSupplierPayables.sourcedFromName` (`convex/vehicles.ts:217-227`). Owned-car creditor and consignment supplier are already structurally separate, which N9 requires and the new design must preserve.

### 2.2 Writers (create / edit / approve / settle / reverse)

Vehicle identity:
- `vehicles.create`: args `convex/vehicles.ts:923-931`; idempotency fingerprint includes the name (`:968`); insert writes `sourcedFromName` (`:1047`); on-account payable created in `postVehicleAcquisitionIfOwned` (`:170-227`, insert at `:217-227`).
- `vehicles.update`: args `:1326-1334`; generic name patch loop `:1464-1475`; only guard on a name change is `assertNoHeldSupplierConcession` (`:1496-1498`); ownership-conversion snapshot `:1549-1562`; acquisition posting `:1594-1606`.
- `vehicles.createSourced`: `:2935-3044` (name written at `:3016`, `:3044`).
- `vehicles.importBulk`: args `:3700-3703`; SOURCED name required `:4124`, `:4368`, `:4398`; on-account creditor `:4035-4042`, `:4431`; **idempotent re-import dedupe by name equality** (`sameText(payable.sourcedFromName, supplier)` at `:4167-4172`, `:3599-3600`).
- `vehicleEdits.requestCreate` (`:132`), `requestUpdate` (`:206`), `resolve` (`:397`): args `:47-52`, `:148-153`, `:223-228`; name-change detection `:513-514`; trim and write `:600-603`; ownership decision `:588-594`; create path `:463-473`. Pending requests are stored name-only.
- Shape rules: `convex/utils/vehicleSourceShape.ts` (`:11-26`, `:100-152`, `:216-221`).

Sale and settlement:
- Sale completion creates the receivable and the payable from the **vehicle's live name**, with a fail-open default: `sourcedFromName: prepared.vehicle.sourcedFromName ?? "Unknown supplier"` at `convex/utils/saleCompletion.ts:2232` (receivable, via `openSupplierReceivable` at `convex/supplierReceivables.ts:72-87`) and `:2246` (payable insert). This violates N5 as written.
- Payables: `sourcingPayables.markPaid` (`:288`), `recordPartialPayment` (`:432`), `setDisputed` (`:577`); the name flows into the GL hook at `convex/sourcingPayables.ts:399`, `:544`.
- Receivables: `supplierReceivables.recordReceipt` (`:268`, name into hook at `:407`, description `:423`), `setDisputed` (`:446`).
- Recoveries: `supplierCostRecoveries.recordReceipt` (`:319`, name `:437`, `:461`), `reverseReceipt` (`:484`); opened by `openSupplierCostRecovery` (`:65-95`), whose party is `args.vehicle.sourcedFromName` read **at expense time** (`:84`).
- GL hooks and rules carry the name only as text: `convex/accounting/workflowHooks.ts:1080-1110`, `:1305-1346`; `convex/accounting/supplierCostRecoveryPosting.ts:85-112`; `convex/accounting/postingRules.ts:543`, `:1766`, `:1779`, `:1819-1822`, `:1861-1864`.
- Concession: `convex/utils/supplierConcession.ts:157` (`sameName` is `trim()` equality), `:165-188`, `:207-227`; written at `convex/financingEconomics.ts:2517`, `:3400`.

Expenses and cost bearer:
- `expenses.create` (`convex/expenses.ts:423` vendor arg, `:482`, `:546`), `update` (`:594`, `:760`); bearer rules `assertCostBearerAllowed` (`:121-149`), side effects `recordPaidExpenseSideEffects` (`:151-262`); the bearer-immutability and no-field-only-reclassification logic at `:673-674`, `:731-742`.
- `workOrders` refuses `SUPPLIER` bearer outright (`convex/workOrders.ts:28`); keep as is.

Openings:
- `materializeOpeningRow` writes `sourcedFromName: row.counterpartyName.trim()` into recoveries and payables (`convex/accounting/openingAllocations.ts:907-946`); validation `:289-290`; verification compares names (`convex/utils/openingSupplierBasis.ts:73`, `:107`; `convex/utils/openingSupplierPosting.ts:93`, `:175`).
- Party-name display: `convex/accountingCutover.ts:938-939`, `:1297`.

### 2.3 Readers

- `supplierReceivables.outstandingSummary` (`:175-257`) **groups by name string** into `bySupplier` (`:196`, `:206-209`, `:237-240`, `:252-254`). Two different suppliers with one name merge; one supplier with two spellings splits. This is a live N2 violation.
- Lists and views: `supplierReceivables.list` (`:108`), `supplierCostRecoveries.list` (`:170`, name at `:227`), `sourcingPayables.list` (`:90`), `listPipeline` (`:173`, name `:242`), `get` (`:258`).
- Deal and sale readers take the **vehicle's live name**, not the record snapshot: `convex/sales.ts:616` (payable snapshot), `:2751`, `:3146`, `:3228`; `convex/applications.ts:1415`, `:2380`, `:4582-4607`, `:4928-4949`, `:6111`; `convex/sourcedAgentImpact.ts:271`; export `convex/vehicles.ts:583`.
- `reports.ts` and `dashboard.ts` hits for "supplier" are settlement amounts and economics, not party names (GREP, first 40 hits read; not exhaustive).
- Crons, HTTP routes, `dealer-worker`, `hooks/`, `.github/`: no supplier or vendor party handling (GREP; `dealer-worker/src/index.ts` and the cron files returned no hits).

### 2.4 Web, mobile and tooling entry points (INSPECTED via a delegated read-only survey, spot-checked)

All are free text. None calls `api.suppliers.*`.

| Entry point | File:line | Binds to |
|---|---|---|
| Vehicle dialog, consignment supplier | `components/vehicles/VehicleDialog.tsx:629-641` | `sourcedFromName` |
| Vehicle dialog, on-account creditor | `VehicleDialog.tsx:922-936` | `purchaseSupplierName` |
| Vehicle submit | `VehicleDialog.tsx:391-422` | `vehicles.create/update`, `vehicleEdits.requestCreate/requestUpdate` |
| Vehicle form schema, gaps | `components/vehicles/vehicle.schema.ts:27,32`, `lib/vehicles/ownershipGaps.ts:62,76-77` | strings |
| Approval ownership chooser | `components/vehicles/ApprovalOwnershipChooser.tsx:25-75,120,147-148`; mounted `app/(dashboard)/[orgId]/vehicles/page.tsx:1092-1129`, resolve at `:245`, `:287-294` | `sourcedFromName` / `purchaseSupplierName` |
| Vehicle bulk import | `components/vehicles/VehicleImportDialog.tsx:84-86,109,278,334-335,378,474,616-620,907-909`; sheet round trip `vehicleSheet.ts:51,66,106,211`, `VehicleExportButton.tsx:50` | one supplier column feeding two fields |
| Sales wizard "source a vehicle" | `components/sales/wizard/components/VehiclePicker.tsx:19,34,171,408,430`; `steps/Step1QuoteSetup.tsx:158,459-483` | `vehicles.createSourced` |
| Expense form vendor | `components/expenses/ExpenseDialog.tsx:475-487` (placeholder hard-coded English at `:482`) | `vendor` |
| Expense form bearer | `ExpenseDialog.tsx:122-129,417-451`, `components/expenses/CostBearerSelect.tsx:14-50` | enum only; no party field |
| Opening allocation editor | `components/accounting/setup/OpeningAllocationEditor.tsx:246-250`; payload `openingAllocationForm.ts:39,48,131-143,163-165` | `counterpartyName`; the form type forbids an id (`partyId: ""`) |
| Supplier payment / receipt / recovery dialogs | `components/sourcing/SupplierPaymentDialog.tsx:15,68`, `SupplierCostRecoveriesSection.tsx:25,192,229`, `components/applications/cockpit/SupplierSettlementDialog.tsx:39,58,107` | display of a name; actions keyed by row id (good) |
| Deal cockpit | `components/applications/cockpit/DealCockpit.tsx:1465,3364,3738,5726,7514-7525` | server name strings |
| Legal invoice issuer | `RecordLegalInvoiceDialog.tsx:123,170,281-295` -> `convex/financeDealCosts.ts:4330-4453` | `issuerName`, a document field |
| Mobile | `apps/mobile/src/features/workspace/modules/vehicles.tsx:636,676`, `expenses.tsx:12,45,80,138`, `VehicleDetailScreen.tsx:705,869-871`, `sourcing.tsx:14-18,79`, types `convexApi.ts:263,430,830,990-998,1671-1674,1768` | names |
| Tooling | `scripts/accountingRehearsalCases.mjs:1650`, `scripts/accountingOpeningRehearsal.mjs:286-312,604,612,766`, `scripts/accountingCleanupRehearsal.mjs:84`, `scripts/intelligence/browserSwarm*Attack.ts`, `playwright/fixtures/dealScenarios.ts:109`, `test-utils/financedDealFixture.ts:88` | names |

Reusable UI: `components/ui/searchable-select.tsx` (server-side search via `onSearchChange`, logical RTL-safe classes, hard-coded English empty-state text at `:163`). No `<bdi>` isolation around supplier names in the vehicle, sourcing or chooser components. No i18n keys exist for a supplier picker; the Arabic dictionary type forces every new English key to have an Arabic twin (`lib/i18n/dictionaries.ts`, per-domain files under `lib/i18n/domains/`).

### 2.5 Defects found while mapping (each has a failing-first test in section 7)

1. `saleCompletion.ts:2232`, `:2246`: unknown supplier defaults to the literal string "Unknown supplier" and the money rows are created anyway (violates N5).
2. `outstandingSummary` groups by name (violates N2).
3. `vehicles.update` and `vehicleEdits.resolve` can change `sourcedFromName` on a SOURCED car after money exists. Recoveries keep the old snapshot, a later sale writes the new name into the payable or receivable, and one supplier's account silently splits across two names (violates N11).
4. `openSupplierCostRecovery` takes the party from the vehicle's name at the time the expense is paid, not from an explicit field on the expense.
5. `importBulk` decides "same payable" by case-sensitive trimmed name equality (violates N2).
6. `supplierGapBasis` and `supplierConcession` authorise a concession by trimmed name equality, so a rename or a same-name different supplier passes or fails wrongly.

## 3. Two designs

### Design A (recommended): extend the S1 supplier registry; links, not roles

`suppliers` stays the single party table. Every money record gets an optional-in-storage, required-at-the-write-boundary `supplierId` in the field that names its role (N8). No role column on the master. The master's `displayName` plus S1's `version` supply the snapshot. A/P, A/R and recovery balances stay in the existing subledgers (N7).

Schema: the field table in section 4. Indexes (each added by a separate small slice): `vehicleSupplierPayables` / `vehicleSupplierReceivables` / `supplierCostRecoveries` each `by_org_and_supplierId_and_status` `["orgId","supplierId","status"]`; `vehicles` `by_org_and_sourcedSupplierId` ; `expenses` `by_org_and_vendorSupplierId` and `by_org_and_costBearerSupplierId`. Convex allows 32 indexes per table and 16 fields per index (Convex indexes documentation); I did not count the current index total on `expenses` and `vehicles` (UNVERIFIED; check before adding).

What it could break:
- The master has no notion of a party that is both a supplier and, say, a customer. Not a regression: customers and finance companies already have their own masters and their ids on `journalLines`.
- Garages and other service providers become rows in a table called `suppliers`. Naming is slightly off for them but accurate: they supply a service. A `kind` or `roles` column can be added later as an optional field with no migration.
- Every writer listed in 2.2 changes, so the blast radius is wide but each change is mechanical and testable.

### Design B: a new Counterparty Master with explicit SUPPLIER role rows

New tables `counterparties` (identity) and `counterpartyRoles` (`counterpartyId`, `role` in SUPPLIER / SERVICE_PROVIDER / ..., status), a new registry lock, new permissions and scenarios. Money records link to `counterpartyId` plus an optional role id.

What it could break:
- Convex has no table rename. S1's three tables are deployed to production (Deploy production run 40586565941 per Jira). B either strands them (dead tables, a purge-order entry, guards and scenarios to retire) or runs two masters in parallel.
- A real unified master only pays off if customers, finance companies and employees move into it. Those already hold ids on `journalLines` and on many tables; moving them is a data migration, which the 2026-10-29 ruling rules out. Without moving them, B creates a second authority for the same parties, against N7's spirit.
- Role rows add a join and a consistency rule (the role on the master must match the role of the field) for no present benefit, because N8 says the role is a property of the transaction.
- S1's lock, normalisers, candidate search, permission matrix rows and the SCRUM-761 scenarios would have to be redone and re-reviewed (two seats each).

### Recommendation: Design A

A reuses the deployed, reviewed S1 master and its lock without a data move, keeps the role where it is true (the transaction), and needs no migration, which is the owner's ruling. B's only advantage, one master for all party types, requires the migration that is now excluded. If the owner later wants a unified party master, A does not preclude it: the `supplierId` fields can point at a future table through a one-time, separately ruled change.

## 4. Schema and rollout without a migration (replaces the migration plan)

### 4.1 What this assumes, stated plainly

The pilot deployments hold **no supplier-bearing documents that need converting**. Concretely, I assume that on the deployment(s) the Bloom Cars pilot runs on, the following contain no rows created before this change: `vehicleSupplierPayables`, `vehicleSupplierReceivables`, `supplierCostRecoveries`, `supplierCostRecoveryReceipts`, SOURCED `vehicles`, `vehicleOwnershipConversions` with a supplier, `financeApplications` with `supplierGapBasis`, `expenses` with `vendor` or `costBearer: "SUPPLIER"`, `vehicleEdits` pending rows, and `openingBalanceDrafts` with supplier allocations. **I have not verified this and cannot from here.** The decided check is the mandatory P7 launch-evidence check (OQ-1, c23873), which refuses the launch if any pilot money row lacks a `supplierId`. An earlier counts-only operator read before P2 is optional and does not replace it.

If the assumption is false for any deployment, nothing in this design converts those rows. They stay readable with their name snapshots, they are reported as unresolved identity (4.5), and every new money action on them is refused (N5).

### 4.2 Convex facts this relies on

- The first push of a changed schema validates all existing documents against it and fails if any does not match; later inserts and updates are checked too (Convex schemas documentation, https://docs.convex.dev/database/schemas). `schemaValidation: false` disables this and is not a migration tool; I do not use it.
- Convex's own guidance for adding a required field is widen (make the field optional), update writers, backfill, then narrow (make it required), and "Convex will not let you deploy a schema that doesn't match the data at rest" (https://stack.convex.dev/migrating-data-with-mutations). The Convex migrations component implements the backfill step.
- **This design performs widen and the writer change, and deliberately skips backfill and narrow.** That is only safe because the field stays optional in storage forever. Narrowing would make the push fail on any deployment holding an old document, which is exactly the dev and preview data question the coordinator asked about.

### 4.3 Exact fields

All new fields are `v.optional(...)` in the stored-document validator, so a push succeeds on a deployment that holds old documents (absent field = valid). Each is **required at the mutation boundary** for the listed workflows, enforced by the mutation and by a guard test (section 7). No existing field is removed or retyped.

| Table / object | New field | Stored as | Required by | Old-row behaviour |
|---|---|---|---|---|
| `vehicles` | `sourcedSupplierId` | `v.optional(v.id("suppliers"))` | create, update, createSourced, import, approval, whenever `sourceType === "SOURCED"` | absent = unresolved; sale completion, payments and expenses against it refused |
| `vehicleEdits.payload` | `sourcedSupplierId`, `purchaseSupplierId` | `v.optional(v.id("suppliers"))` each | request and resolve of a SOURCED or ON_ACCOUNT create | a name-only pending request cannot be approved; the approver must choose a supplier in the chooser, or reject it |
| `vehicleSupplierPayables` (`supplierPayableCommon`) | `supplierId`, `supplierSnapshotVersion` | `v.optional(v.id("suppliers"))`, `v.optional(v.number())` | every insert: on-account creation, sale completion (THROUGH_DEALERSHIP), opening materialisation | payments, partial payments, disputes refused with `SUPPLIER_IDENTITY_UNRESOLVED` |
| `vehicleSupplierReceivables` | `supplierId`, `supplierSnapshotVersion` | same | every insert (DIRECT_TO_SUPPLIER sale completion) | receipts and disputes refused |
| `supplierCostRecoveries` (`supplierRecoveryCommon`, both origins) | `supplierId`, `supplierSnapshotVersion` | same | every insert (expense side effects, opening) | receipts and reversal-receipts refused |
| `vehicleOwnershipConversions` | `supplierId` | `v.optional(v.id("suppliers"))` | conversion writer | none (history only) |
| `financeApplications.supplierGapBasis` | `supplierId` | `v.optional(v.id("suppliers"))` inside the object | concession agreement | concession completion compares ids; a basis without an id is refused |
| `expenses` | `vendorSupplierId` (service provider / payee), `costBearerSupplierId` (cost bearer) | `v.optional(v.id("suppliers"))` each | `costBearerSupplierId`: every `costBearer: "SUPPLIER"` expense. `vendorSupplierId`: see OQ-3 | `vendor` stays as a non-authoritative note |
| `openingBalanceDrafts.allocations[]` (`openingAllocationValidators.ts:43-45`) | `supplierId` on `SUPPLIER_RECOVERABLE`, `SUPPLIER_PAYABLE`; `OTHER_PAYABLE` per OQ-4 | `v.optional(v.id("suppliers"))` | save and post of a supplier allocation | an old draft cannot be posted; a posted one keeps verifying by snapshot name only for replay |
| `journalLines` | `supplierId` | optional | **not in the early slices.** See OQ-5 | absent on every existing line |

Kept unchanged as the immutable snapshot (N3): `vehicles.sourcedFromName`, `vehicleSupplierPayables.sourcedFromName`, `vehicleSupplierReceivables.sourcedFromName`, `supplierCostRecoveries.sourcedFromName` (required strings stay required), `vehicleOwnershipConversions.supplierName`, `supplierGapBasis.supplierName`, `expenses.vendor`, `counterpartyName`. From the pilot onward these are written **by the server** from the master (`displayName` at creation time), never accepted from the client on a pilot-enabled path. Their stored type does not change, so existing documents and the S1-era code that reads them stay valid.

### 4.4 Public arguments and deploy order

The public mutations stop accepting a client-supplied name as the authority for these paths and take ids. A legacy name-only call to a pilot-enabled path is refused with `SUPPLIER_IDENTITY_REQUIRED` (no fallback). Because the web frontend and the Convex backend promote separately (backend deploy is manual, frontend needs a manual Vercel promote), a window exists in which an old frontend talks to a new backend and the reverse:
1. Backend first: the new args are optional in the validator (so a new frontend works and an old frontend gets the coded refusal rather than a validator crash), and the schema push is widen-only.
2. Then promote the frontend.
Because the pilot has not launched, the refusal window costs nothing; it must still be exercised in the contract-skew check (`scripts/contractSkew/`; the baseline lists these name fields as optional strings).

Queued data in flight: accounting events already in the outbox carry `sourcedFromName` text in their payloads (`workflowHooks.ts:1080-1110`, `:1305-1346`). Event payloads gain no required field in this issue (N4), so a pending event drains unchanged.

### 4.5 Unresolved identity is visible and fail-closed, with no conversion

- A read-only, bounded, paginated diagnostic query `suppliers.unresolvedIdentityReport` lists, per table, rows whose `supplierId` is absent (counts and ids only; names are shown only to `VIEW_FINANCE`). It never writes. It exists so a dev or preview deployment with old data shows what is stuck, and so the operator check in 4.1 is repeatable.
- N5 refusals use one stable code, `SUPPLIER_IDENTITY_UNRESOLVED`, with the same message for every table.
- Optional, owner decision (OQ-7): a single explicit action `vehicles.assignSupplierToUnresolvedVehicle` for a SOURCED car with no supplier id and **no money rows**. It is a user action with one chosen supplier, an audit row and the same permission as editing the vehicle. It is not a bulk operation and it is not a migration.

### 4.6 Rollback

There is nothing to roll back in data: no document is rewritten. The code can be reverted at any time; the optional fields are inert when unread, and the S1 tables are untouched. The one-way part is only that new documents carry `supplierId`; reverting code leaves them harmless. Index additions are metadata. Because no snapshot is ever rewritten, an incorrect supplier choice on a new record is corrected by the separately reviewed correction route (N11), not by editing history.

## 5. The expense split: service provider/payee vs cost bearer

Two independent facts on an expense:
- **Service provider / payee** = who was paid for the work (the garage). Field `vendorSupplierId` plus the server-written `vendor` snapshot. It is a payee only. It never creates a payable to the garage and never changes the GL.
- **Cost bearer** = who economically bears the cost. Existing enum `costBearer` (`SHOWROOM` / `SUPPLIER`) is unchanged. When it is `SUPPLIER`, the new `costBearerSupplierId` identifies the party.

Rules, consistent with SCRUM-389 (`convex/utils/costBearer.ts:62-90`, `convex/expenses.ts:121-149`, `:673-674`, `:731-742`):
1. `costBearerSupplierId` is **never client-supplied**. The server sets it from the vehicle's `sourcedSupplierId` when it accepts `costBearer: "SUPPLIER"`. The SCRUM-389 conditions stay exactly as they are: owned SOURCED vehicle, a resolved supplier (the existing "has a supplier name" test becomes "has a resolvable `sourcedSupplierId`"), not prepaid, no VAT, representable amount.
2. A supplier-borne cost against a garage keeps both ids: payee = garage, bearer = consignment supplier. Cash goes to the garage as today. The recovery (`supplierCostRecoveries.supplierId`) points at the **bearer**, copied from `expense.costBearerSupplierId`, not re-read from the vehicle (fixes defect 2.5.4). The garage never appears on an A/R or A/P row.
3. The supplier-borne reimbursement is an A/R recovery (Dr Receivable from Suppliers), never an A/P to the garage and never a showroom expense. No posting rule changes (N4). A recoverable cost with a showroom bearer stays a showroom expense.
4. Immutability: `costBearer` and `costBearerSupplierId` are immutable once the expense is PAID (existing behaviour for `costBearer`, extended). `vendorSupplierId` is immutable once PAID as well; correcting a payee is a separately reviewed correction (OQ-3 asks whether that is too strict).
5. No reclassification from a field-only change: changing `vendorSupplierId` alone never changes `costBearer`, the posting or the recovery; the existing `bearerChanges` refusal at `expenses.ts:673-674` stays the only path that can alter the bearer, and it still refuses on a paid row.
6. A garage and a consignment supplier may be the same master row; that is allowed and means only that one party played two roles, not that the cost nets out.
7. If the vehicle's supplier link is frozen (N11) the bearer party is stable for the cost's lifetime.

## 6. UI change list (web, English and Arabic RTL)

New shared component `SupplierSelect` built on `components/ui/searchable-select.tsx`: server-side search over `api.suppliers.search` (picker projection; readable with `VIEW_VEHICLES` or `VIEW_FINANCE`), shows `displayName` plus a sub-label (tax id tail if the caller has `VIEW_FINANCE`, otherwise status), shows inactive suppliers disabled with a reason, and an inline "Create supplier" action that runs `candidatesFor` first and shows the duplicate-confirmation step S1 already requires (`requireConfirmedCandidates`). Inline create needs `MANAGE_FINANCE`; a user without it sees the picker and a message to ask finance to add the party (OQ-9). Supplier names are rendered in `<bdi>` so Arabic and Latin names do not reorder surrounding text. Replace the hard-coded English strings in the form and the empty-state text with dictionary keys, each with an Arabic key (the dictionary type enforces the pair).

| Entry point | Change |
|---|---|
| `VehicleDialog.tsx:629-641` | consignment supplier text input becomes `SupplierSelect`, binds to `sourcedSupplierId` |
| `VehicleDialog.tsx:922-936` | on-account creditor becomes `SupplierSelect`, binds to `purchaseSupplierId` (transient argument; stored on the payable) |
| `vehicle.schema.ts:27,32`, `ownershipGaps.ts:62,76-77` | zod and gap checks on ids; message keys `SUPPLIER_REQUIRED`, `CREDITOR_REQUIRED` stay |
| `ApprovalOwnershipChooser.tsx:25-75,120,147-148` | both name inputs become `SupplierSelect`; `buildOwnershipDecision` emits ids; the approver is where a name-only pending request gets an identity |
| `VehicleImportDialog.tsx` | after column mapping, a **mapping step** lists each distinct supplier text in the file and requires the user to choose an existing supplier or create one per distinct text. The server receives an id per row and never matches by name. Unmapped texts block the import |
| `VehiclePicker.tsx:19,34,171,408,430` | the "source a vehicle" mini form uses `SupplierSelect`; placeholder "Al-Safeer Motors" is replaced by a key |
| `ExpenseDialog.tsx:475-487` | vendor input becomes `SupplierSelect` labelled "Service provider / payee" (key `VendorPayee` exists); the bearer select stays; when `SUPPLIER` is chosen the form shows the bearer as a read-only line "Cost borne by: {vehicle supplier}" |
| `OpeningAllocationEditor.tsx:246-250`, `openingAllocationForm.ts:39,48,131-165` | counterparty text becomes `SupplierSelect` for supplier kinds; the form type gains `supplierId` |
| `SupplierPaymentDialog.tsx`, `SupplierCostRecoveriesSection.tsx`, `SupplierSettlementDialog.tsx`, `sourcing/client.tsx:275,389`, `DealCockpit.tsx:1465,5726,7514` | display the record snapshot name (not the vehicle's live name) with `<bdi>`; show a link to the supplier; when `supplierId` is absent show an "Identity unresolved" badge and disable the action with the reason |
| Mobile (`apps/mobile`) | pilot is web-only: the SOURCED and ON_ACCOUNT write paths and the expense vendor field refuse with a "use the web app" message instead of sending a name (OQ-6) |
| Diagnostics | a finance-only "Unresolved supplier identity" panel fed by `unresolvedIdentityReport` (section 4.5) |

Every UI slice is verified rendered, authenticated, desktop and phone, English and Arabic, with loading, empty and error states, per the AutoFlow UI rule. Compilation and tests are not accepted as proof.

## 7. Author self-attack: five predicted ways the design is wrong

Each has failing-first tests that must be red on the unmodified code or on a deliberately broken variant before the slice ships (SCRUM-761 rule).

1. **Optional in storage plus required at the boundary leaves a bypass.** Some writer (an internal mutation, a script, the importer, a future slice, a test helper) inserts a money row without `supplierId` and the system keeps working off the name. Tests: (a) an AST guard in the style of `scripts/supplierMasterGuards.test.ts` that fails on any `ctx.db.insert` into `vehicleSupplierPayables`, `vehicleSupplierReceivables`, `supplierCostRecoveries` or `expenses` (with `costBearer` SUPPLIER) whose literal lacks `supplierId`, and on any read of `sourcedFromName` used as a key, comparison or map key; (b) per entry point, a backend test that a call without an id is refused with `SUPPLIER_IDENTITY_REQUIRED` and writes nothing (assert the table counts before and after, including `removed` as well as `added`, per ACC-7); (c) per action on a row without an id, `SUPPLIER_IDENTITY_UNRESOLVED` and no GL delta.
2. **A name-keyed aggregation survives.** `outstandingSummary` is the known one; others may hide behind helper names. Tests: two suppliers with identical `displayName` and an open receivable each produce two `bySupplier` entries; one supplier renamed after two records produces one entry carrying both snapshots; the same grouping is asserted through `sourcingPayables.list` and the deal readers. Plus the AST rule in (1a) for `Map<string,...>` keyed by a name field.
3. **The party is swapped after money moves, or the bearer drifts.** The vehicle's supplier link is edited after a payable, receivable or recovery exists; or `openSupplierCostRecovery` reads the vehicle's link at a different time than the expense. Tests: changing `sourcedSupplierId` is refused once each of {payable, receivable, recovery, supplier-borne expense, held concession} exists, through `vehicles.update`, `vehicleEdits.resolve` and `importBulk`; a recovery's `supplierId` equals the expense's `costBearerSupplierId` even if the vehicle is later changed (which is refused anyway); a supplier-borne expense with a garage payee creates no A/P row and the GL delta is identical to the same expense with no payee id (N4).
4. **Lifecycle and shared-identity misuse.** `requireActiveSupplier` is used where settlement must still work, which would strand an obligation to a deactivated supplier; or a supplier that `sharedLegalIdentityOf` another is treated as the same party for netting. Tests: deactivate a supplier with an open payable and an open receivable, then pay and receive in full (must succeed), while creating a vehicle, an expense or an opening row for that supplier is refused with `SUPPLIER_INACTIVE`; two branch suppliers of one legal identity keep separate payables, receivables and recoveries, and a combined view never nets A/R against A/P.
5. **In-flight and replayed state still carries only names.** Queued accounting events, posted opening drafts verified by name, an idempotent retry, or a pending `vehicleEdits` request. Tests: an outbox event queued with the pre-change payload drains and posts the same lines; an opening allocation posted before this change still replays and verifies through `openingSupplierBasis` by snapshot, while a new receipt against it is refused as unresolved; `vehicles.create` retried with the same idempotency key and a different `purchaseSupplierId` is `SUPPLIER_IDENTITY_CONFLICT`/idempotency conflict, and a retry after a supplier rename returns the original result without rewriting the snapshot; a name-only pending `vehicleEdits` row cannot be approved without an id; cross-organisation and missing ids give the identical refusal message.

Also considered and covered by the slices below rather than separate predictions: Arabic bidi reordering of mixed-script names, a schema push of the widen-only change against a seeded deployment holding legacy-shaped documents (a test that inserts old-shaped documents with the schema in `convex-test` and asserts the schema accepts them; note `convex-test` does not model the real push-time validation of a populated deployment, so a disposable preview with seeded old-shaped data is also required), and the 32-index limit on `expenses`.

Harness caveat (convex-test-harness): nothing here proves concurrency. The registry lock is argued from OCC's documented read set, not demonstrated by any test; the Convex OCC page does not address range reads or phantom inserts (checked 2026-10-29).

## 8. Slicing plan

S1 is merged (6c71a7654). Preconditions already named in Jira: `internal.suppliers.backfillRegistry` must have been run on production so every organisation has a registry document, and SCRUM-871 (supplier lock guard follow-ups, L6/L7) is the stated prerequisite for S2. I did not read SCRUM-871's content (UNVERIFIED).

Every slice follows the AGENTS.md money gates: failing-first tests, Seat 1 and Seat 2 reviews from different model families, `## Skill evidence`, SCRUM-761 scenario rows, SCRUM-486 rows for any money literal.

| Slice | Content | Risk | Independently shippable because |
|---|---|---|---|
| P1 | Widen-only schema: the optional fields and indexes of 4.3 for vehicles, vehicleEdits, the three subledgers, conversions, `supplierGapBasis`; `snapshotSupplier()` helper (same org, active and existence checks as `requireActiveSupplier`, but with coded refusals; returns id, name, version); unresolved-identity code constants. Nothing reads or writes the fields. | LOW-MEDIUM (schema, one-way for the field names) | no behaviour changes; passes schema validation on a populated deployment |
| P2 | Vehicle identity: `vehicles.create/update/createSourced`, `vehicleEdits.request*/resolve`, `importBulk` take and require ids; server writes snapshot names; on-account payable carries `supplierId`; vehicle supplier-link freeze (N11), including `sourcedSupplierId` in `VEHICLE_OWNERSHIP_FIELD_KEYS` so the super-admin data browser cannot rewrite it (failing-first test), and readers re-check the stored supplier's org; web: `SupplierSelect`, VehicleDialog, ApprovalOwnershipChooser, VehiclePicker, import mapping step, EN+AR. Mobile refusal. | HIGH (money-adjacent writers) | sale and settlement paths still read the old name until P3, which is safe because P2 writes the snapshot name too |
| P3 | Sale and settlement: sale completion writes receivable/payable `supplierId` from the vehicle and **removes the "Unknown supplier" default** (fail closed); the pilot-enabled payments and receipts (supplier payable payment, consignment margin receipt, cost-recovery receipt) and disputes require a resolved id. Their reversal, unwind and correction doors must refuse server-side for the pilot (SCRUM-869 c23881) whether or not an id resolves. On the P1 base, sale cancellation already refuses once supplier money has moved (`convex/utils/saleCancellation.ts`, `assertNoPaidSupplierPayable`), but `supplierCostRecoveries.reverseReceipt` is still open; blocking it with server-side block evidence is SCRUM-869 S1 work and a precondition for P3. P3 never adds an id check to a door that does not already refuse; `outstandingSummary` and other readers group by id; concession basis compares ids; deal readers show record snapshots. | HIGH (money) | after P2 a SOURCED sale can resolve its supplier; before P3 the old name paths still work |
| P4 | Expense split: `vendorSupplierId`, `costBearerSupplierId`, recovery `supplierId`, server-side bearer resolution, `ExpenseDialog`, EN+AR. | HIGH (SCRUM-389) | independent of P5 |
| P5 | Openings: allocation validators and editor, materialisation, `openingSupplierBasis`/`openingSupplierPosting` compare ids with snapshot fallback for replay only. | HIGH (openings are one-way once approved) | independent of P4 |
| P6 | Deferred past the pilot (OQ-5, c23873): `journalLines.supplierId` dimension on the supplier control accounts plus payload field, per-supplier GL reconciliation. Posting payloads gain an optional field only (N4). | HIGH (ledger shape) | not part of the pilot; no posting changes before it |
| P7 | Certification: the **mandatory launch-evidence check** (OQ-1, c23873), which counts pilot money rows with no `supplierId` (counts only, no values) and refuses the launch if any exist; authenticated EN and AR RTL journeys on a disposable backend, SCRUM-342/761 scenario registration, SCRUM-486 money literals, SCRUM-810 capability truth, SCRUM-816 consumer coverage, exact-SHA evidence SCRUM-812. Most scenario rows land with P2 to P5; P7 is the gap-closer and the end-to-end journey. | MEDIUM | evidence only |

**SCRUM-869 can start**
- Read-only design and UI shell: now, against S1 and the P1 field names.
- Supplier statement, A/R and A/P panels, aging and the unresolved panel for vehicle-origin rows: after P3 (the subledgers then carry `supplierId` for native sales).
- Expense recoveries in the statement: after P4. Opening allocations in the statement: after P5.
- Per-supplier GL reconciliation: deferred with P6. For the pilot, SCRUM-869 reconciles the supplier subledgers to the control-account totals and shows unlinked differences, without a ledger shape change.

## 9. Open questions and their decisions

Decided on 2026-10-29 in SCRUM-868 comment 23873 (coordinator, within existing rulings; the "no migration" ruling is comment 23871):

- OQ-1 and OQ-12: comment 23871 is the ruling cited. The assumption is checked, not trusted: the P7 launch-evidence check counts pilot money rows with no `supplierId` and refuses the launch if any exist.
- OQ-2: `supplierId` is optional in storage and required at every pilot write path with a stable refusal code.
- OQ-3: a payee id is required on supplier-borne expenses. Other expenses keep their current payee field.
- OQ-4: an opening allocated to a supplier requires the id. A plain `OTHER_PAYABLE` opening with no supplier does not.
- OQ-5: the journal-line supplier dimension (P6) is deferred past the pilot. No posting changes.
- OQ-6: the pilot is web only, so mobile supplier money writes are refused server-side.
- OQ-9: creating a supplier inline needs `MANAGE_FINANCE`, as in S1.

Pilot scope (SCRUM-869 comment 23881, owner): supplier payable payment, consignment margin receipt and cost-recovery receipt are in the pilot and must be certified. Their reversal, unwind and correction doors are not indispensable for launch and must refuse server-side. On the P1 base, `supplierCostRecoveries.reverseReceipt` does not yet refuse; SCRUM-869 S1 blocks it, and P3 depends on that. Resolving a supplier id never enables one of them.

Still open (not decided by c23873): OQ-7, OQ-8, OQ-10 and OQ-11. The design keeps its stated defaults for them until a ruling.

The questions as originally stated, kept for the record:

- **OQ-1.** Confirm that the Production deployment, and any other deployment the pilot uses, holds none of the rows listed in 4.1. I cannot read production. A counts-only operator check is needed before P2. If any exist, the 2026-10-29 "no migration" ruling does not cover them and a ruling is needed.
- **OQ-2.** Schema strictness: keep every new `supplierId` optional in storage and required at the boundary (this design), or make some required in the schema. Required-in-schema makes any push fail on a deployment (dev, preview, CI seeds) that holds an old document, and Convex then offers only the widen-migrate-narrow path or deleting the data.
- **OQ-3.** Expense payee: require `vendorSupplierId` on every paid expense, only on supplier-borne ones (this design), or on vehicle-linked ones. And whether a payee on a paid expense may ever be corrected.
- **OQ-4.** Opening `OTHER_PAYABLE` rows share the supplier payable table and `counterpartyName` but are not necessarily suppliers. Do they require a supplier-master party, or a separate kind?
- **OQ-5.** Add a `supplierId` dimension to supplier control-account journal lines (P6) so SCRUM-869 can reconcile per supplier to the GL, or reconcile by subledger-to-event keys without a ledger shape change.
- **OQ-6.** Mobile: refuse SOURCED/ON_ACCOUNT writes and expense vendors (this design) or build a picker, given the pilot is web-only.
- **OQ-7.** Include the single `assignSupplierToUnresolvedVehicle` action (4.5) for dev and preview data, or require such vehicles to be recreated.
- **OQ-8.** Is `legalInvoiceIssuerName` (`convex/financeDealCosts.ts:4330-4453`, a document field) and the `GOVERNMENT|INSURER|OTHER` handover payee category in or out of scope? I treated both as out of scope (not a financial counterparty with a balance).
- **OQ-9.** Who may create a supplier inline from a vehicle or expense form. S1 requires `MANAGE_FINANCE`; a vehicle manager without it can only pick.
- **OQ-10.** The earlier session-local design's owner questions Q1 to Q12 and its S8 launch-evidence gate are not in the repository. Please confirm none contradicts this packet (especially the identified payee on supplier-borne expenses and the as-of attribution of retained deposits).
- **OQ-11.** Branch suppliers sharing a legal identity (`sharedLegalIdentityOf`): statements in SCRUM-869 must not net across branches; confirm whether a legal-entity rollup view is wanted at all.
- **OQ-12.** A ruling record id for the 2026-10-29 "no migration" decision, so `regression/rulings.json` and the new scenarios can cite it (S1 cites `SCRUM-868#c23794`).

## 10. Sources

Official documentation (fetched 2026-10-29):
- Convex, Schemas: https://docs.convex.dev/database/schemas (first push validates existing documents; `schemaValidation: false` disables validation).
- Convex Stack, Migrating Data With Mutations: https://stack.convex.dev/migrating-data-with-mutations (widen, backfill, narrow; deploy rejected if data does not match).
- Convex, OCC and atomicity: https://docs.convex.dev/database/advanced/occ (read-set serializability; silent on range and phantom reads).
- Convex, Indexes: https://docs.convex.dev/database/reading-data/indexes/ (backfill cost on large tables, 32 indexes per table, 16 fields per index; silent on missing optional fields in an index).
- Convex Components, Migrations (the backfill implementation; named, not used by this design because no backfill is performed): https://www.convex.dev/components/migrations. I cited it from knowledge and did not fetch it in this session (UNVERIFIED).

Master-data and subledger practice, applied from established accounting practice rather than fetched this session (UNVERIFIED as citations): a subledger holds party-level detail while the control account in the GL holds the total, and the two reconcile; a vendor/customer master record is a stable identity with versioned attributes, and transactions keep a snapshot of party attributes at the transaction date. Reviewers should treat these as stated principles, not researched quotations.

Repository evidence: files and lines cited inline in sections 2 and 5; S1 commit 6c71a7654; `AGENTS.md`; `convex/_generated/ai/guidelines.md` (read first, as required).
