# Opening balance editing, voiding, and corrections

Date: 2026-11-08. Issue: SCRUM-850, comments c24748/c24749.
Status: part 1 accepted for implementation; part 2 design only.
Baseline inspected: a01d5fe5c7d6a665a51c6dd55b2165e554191258.

## Owner authority and invariant

Owner request: "We need to be able to update, delete or change the registered opening balance before or after starting operating on the system."

The coordinator supplied these owner rulings, selected in Arabic on 2026-11-08:

1. "Pending draft (not yet approved): editable in place, same validation, still needs a second-person approval."
2. "Posted opening balance, BEFORE operations start (no ledger activity other than the opening itself): full void and re-entry is allowed with a second person's approval."
3. "AFTER operations start: no deletion. A documented correction entry dated at the opening date, approved by a second person, changing only the named lines; refused when it conflicts with later activity (e.g. removing an opening car since sold, reducing a supplier payable below what was paid)."

Invariant: an opening change preserves the same economic position in the general ledger, account snapshots, bank attribution, and native subledgers, or refuses atomically; posted journal history remains readable and approval cannot come from the requester or preparer of the relevant operation.

### Round 3: exact snapshot totals

Snapshot gross debit and credit operands and every accumulated balance must remain
safe integers. The shared snapshot writer refuses an unsafe total with the coded
`ACCOUNT_SNAPSHOT_UNSAFE_TOTAL` error before updating its shard. That exception
must escape the mutation so earlier journal, native, audit and scheduled writes
roll back. Readers check gross totals before netting and check downstream totals
across accounts. They return their existing UNAVAILABLE result (OVER_LIMIT for
bounded readers, source unavailable for deposits, incomplete history for banks)
or a clean coded refusal for statement, ledger and VAT queries. No partial or
rounded figure is reported, including for closed periods (SCRUM-858 c23884).

This is containment with unchanged Number storage, not a historical repair.
BigInt storage would require a schema/API migration and cannot recover precision
already lost in a stored Number. Neither option authorizes rebuilding sealed
snapshots. The selected checks retain shard-local writes and existing indexed
reads; they introduce no global posting counter or additional database I/O.

The decisions follow [ECMAScript safe integers](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-number.issafeinteger),
[Convex Float64 and Int64 types](https://docs.convex.dev/database/types),
[Convex application errors](https://docs.convex.dev/functions/error-handling/application-errors)
and [Convex transaction atomicity/OCC](https://docs.convex.dev/database/advanced/occ).
Local harness evidence proves serial behavior only; it does not prove platform
OCC, limits or production prevalence.

An edited pending draft remains pending, retains its preparer, and can be edited by that preparer alone. It passes the same currency, date, account, bank, allocation, payroll, and exact-money validation as a new draft. Approval revalidates the latest stored content. An owner has no single-person void exception.

### Round 4: exact cutover attestations

A cutover sign-off stores exact reviewed gross debit and credit totals per
currency, or refuses before inserting the sign-off or its financial audit copy.
Retain both the original opening and its linked reversal in gross history.
Safe account snapshots and a safe net position do not establish safe historical
gross totals. Use the shared checked addition on both journal-line sides,
including the adjacent legacy-to-GL comparison reader.

`CUTOVER_UNSAFE_TOTAL` identifies this journal aggregation refusal. Reusing
`ACCOUNT_SNAPSHOT_UNSAFE_TOTAL` would misidentify a journal-history attestation
as an account snapshot failure. The error has EN/AR messages and escapes the
mutation. Existing attestations remain immutable; this change neither repairs
previously rounded values nor changes schema, permissions, pilot flags or reads.
An exact representation above the safe Number range requires a separately
reviewed schema/API migration. These decisions follow the ECMAScript and Convex
sources above, checked again on 2026-11-09. Local registered-function tests prove
serial refusal and persisted readback, not cloud OCC or historical prevalence.

## Evidence and impact map

The enumeration starts with `postOpeningBalanceDraft`, follows `materializeOpeningAllocations` and every arm of `materializeOpeningRow`, and follows the called writers `materializeOpeningCommission`, `insertOpeningDeposit`, and `ensureReceivableDocument`/`createReceivableDocument`. `graft callers` in both directions and `graft grep openingBalanceDraftId` supplied the cross-reference inventory. Source files, rather than the index, were inspected. Scope is current repository source at the baseline, not production rows written by deleted historical code.

| Family | Opening writer / recorded identity | Consumers and later writers | Void before activity |
| --- | --- | --- | --- |
| Journal header and lines | `convex/accountingCutover.ts`, draft `journalEntryId`, `sourceType=cutover` | `accountingReports`, `accountingLedger`, `financialAudit`, `accounting/reversals` | Retain lines; mark original REVERSED and insert a linked POSTED reversal at the opening date with opposite sides and the same physical bank |
| Account snapshots | `incrementAccountSnapshot` in the shared poster | `accounting/accountSnapshots`, period closing, trial balance | Apply the opposite amounts through the same snapshot writer; require the original period still open, so sealed snapshots cannot be silently invalidated |
| Bank attribution and report eligibility | wrapped mutation triggers in `functions.ts`, `aggregates.ts`, `accounting/bankAggregateTriggers.ts`, `utils/journalReportEligibility.ts` | `bankAccounts`, `bankBalanceBackfill`, `accounting/bankLineAggregate` | Use the wrapped database writer for reversal lines and header changes; retain both sides of the historical attribution |
| Opening stock basis | vehicle result, `vehicles.openingBalanceDraftId` | `utils/openingVehicleBasis`, sales and vehicle cost writers, `OpeningCostBadge` | Clear the posted basis marker, retain the vehicle, purchase price, opening import evidence and command identity; refuse a sold or otherwise consumed basis |
| Customer receivable | receivable result plus canonical document result | `utils/openingReceivableBasis`, `collections`, `subledger`, reconciliation reports | Delete the untouched opening-created legacy row and its canonical document; refuse altered balances or downstream references |
| Employee advance | advance result | `utils/openingAdvanceBasis`, `employeeAdvances`, `payroll`, `employeeAdvanceRecoveries` | Delete the untouched opening advance; refuse any recovery |
| Prepaid benefit | schedule result | `utils/openingPrepaidBasis`, `prepaidExpenses`, amortization and consumer reports | Delete the untouched OPENING schedule; refuse recognition, cancellation, refund, or write-off |
| Supplier recoverable | recovery result | `utils/openingSupplierBasis`, `supplierCostRecoveries`, recovery receipts and reconciliation | Delete the untouched opening claim; refuse receipts or recovered money |
| Supplier / other payable | payable result | `utils/openingSupplierBasis`, `sourcingPayables`, `openingPayablePayments`, supplier reconciliation | Delete the untouched opening payable; refuse payments or changed amount |
| Employee commission | commission result, `openingDraftId` | `utils/openingCommissionLiabilities`, `payroll`, `openingManagementSettlement` | Delete the untouched liability; refuse payment or payroll attachment |
| Partner capital | partner result, opening minor amount and draft marker | `accounting/openingPartnerAllocations`, `utils/openingPartnerBasis`, `partnerEquity` and its transactions | Clear opening amount and marker, retain the original zero-base partner master; refuse subsequent movements |
| Named customer deposit | deposit result | `utils/openingSettlementBasis`, `utils/openingDepositApplication`, payouts, forwards, commitment readers, customer-deposit reconciliation | Delete the untouched HELD opening deposit; refuse applications, payouts, canonical receipt, or commitment references |
| Unallocated liability / suspense | result carries purpose; no native liability row | opening readback and close checks | Reverse the GL line; preserve the allocation and purpose in draft history |
| Draft and audit | `openingBalanceDrafts`, `auditLog` | pending approval panel, opening status and readback, source identity readers | Keep the complete posted draft, immutable allocations/results, requester, approver, reason, times, and linked reversal; terminal status VOIDED excludes it from active source identity |

`utils/openingResetCleanup.ts` is the shared cleanup boundary. Its current reset helpers cover payable ids and source references, while the broader suspended-org reset enumerates whole financial tables. Part 1 will put an exhaustive allocation-result-to-target resolver in that shared module and use it in both the existing reset helpers and the narrow void. The void must not call the suspended-org batch reset, clear retained allocation proof, scan-delete an org, or maintain a separate payable-source list. The resolver covers the result validator's complete discriminated union; a new kind must cause a type error until classified. Literal fixture expectations independently cover its families.

Historical rows without matching result identity, malformed links, partial resets, or incomplete inventories refuse. No migration guesses an opening's provenance. The UI uses a server-resolved capability and permission-filtered content; it cannot authorize a void. Finance authority is required on all commands, payroll authority when payroll allocations are present, and cost authority before returning cost-bearing draft content. Every caller-supplied draft id uses `requireOwnedRow`.

## Review round 6: opening edit audit confidentiality

`EDIT_OPENING_DRAFT` stores summary metadata in both snapshots: draft version,
line count, allocation count, unique allocation kinds, exact total debits,
as-of date and currency. The after snapshot also records whether the memo
changed. It copies no lines, allocations, account/bank/vehicle/employee ids,
individual amounts, descriptions, row keys, notes or memo text. The ordinary
audit envelope retains the actor and draft reference. A malformed retained
draft whose old debit total is unavailable or unsafe records `null`, not a
rounded historical total; a valid replacement still passes posting preflight.

This adopts Option A from S850-R5-1. `financialAudit.listAuditLog` has broader
finance authority than the dedicated cost/payroll readers and returns stored
rows. Minimizing at the writer avoids replicating their authorization policy
across a generic reader. Keeping full content and adding reader redaction is
outside this change. The complete current draft remains behind its dedicated
permissions; the audit summarizes the edit rather than claiming to reconstruct
every earlier draft. Aggregate totals can equal individual amounts in small
drafts; this decision does not claim to prevent inference from permitted totals.

This changes future edit writes, not previously stored audit rows. Void reasons
remain user-entered free text in the existing request/approval audit payloads;
they do not automatically copy allocation data, but may contain what the
operator types. Broader historical remediation and log policy are coordinator
follow-ups, not silently added to this PR.

Checked 2026-11-09: [OWASP Logging Cheat Sheet, event attributes and data to exclude](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#data-to-exclude)
supports summary properties and excluding commercially sensitive or more highly
classified content. [Convex function authentication](https://docs.convex.dev/auth/functions-auth)
supports deriving identity inside server functions. These sources guide the
design; public-function harness tests provide the local behavioral evidence.

## Two void designs

**A, chosen: one bounded approval transaction.** Store a request on the posted draft. Approval reads the complete org-wide POSTED and REVERSED ledger inventory, verifies previously governed void pairs, validates every materialized target and its downstream references, and requires the original period to remain open. It then removes opening-only projections, posts the reversal, updates snapshots, marks the draft VOIDED, and writes an audit row in the same mutation. No intermediate economic state is committed. Bounds refuse rather than delete a partial set. Request and approval repeat activity checks, including queued or existing accounting events, so intervening operations invalidate a request. Replay returns the existing verified reversal without new writes. Fresh opening admission ignores only verified governed void pairs, never a category or a bare REVERSED status.

**B, rejected: suspended multi-batch reset and replacement.** Freeze economic writes, drain children in batches using the org reset, then re-enter. This scales beyond a single mutation but suspends an operating org, spans transactions, risks deleting unrelated financial rows, and needs a recovery protocol. It does not meet the owner's atomic opening-only void rule. The existing admin reset retains its own contract.

A legitimate void does not delete opening stock import commands or partner masters: those predate materialization and are necessary to re-enter an opening. Reversing journal lines, rather than removing old lines, keeps report eligibility and bank aggregates consistent with their existing consumers. Other open periods do not authorize a void after operations in any period. A closed opening period requires separate finance review; this lane does not reopen or rewrite closed snapshots or invalidate signed cutover attestations.

## Two correction designs for part 2

**C, preferred for later implementation: named immutable correction commands with atomic deltas.** A separate pending correction records the base draft, stable row keys, before/after values, opening accounting date, reason, and preparer. A second actor approves after re-reading the affected native rows and later activity. Post only the net delta journal and apply matching native deltas. Preserve the original opening and each correction, and make source readers resolve the original plus the certified correction chain. Examples: an unsold opening car may change basis only if no sale/cost consumption depends on the old amount; a payable cannot fall below payments, and an advance cannot fall below recoveries. Repeated approval identifies the same command and emits no second delta. Correcting a correction is another named command, not deletion. The chain needs a version token so later activity or another correction invalidates stale approval. Closed periods require explicit policy for reopening, rebuilding dependent snapshots and re-signing, before implementation can accept opening-date deltas there.

**D, rejected: full reversal and replay after operations.** Reverse the entire opening and recreate it, then replay every dependent sale, receipt, payroll, supplier settlement, depreciation, deposit application, and report snapshot. This changes unnamed lines and historical dependency identities, requires a general replay engine, and can erase or double-count later activity. It violates the owner's named-line correction constraint.

Part 2 must define row-specific conflict floors and correction-aware source proofs across all readers in the map, historical and closed-period reporting, correction reversal, concurrency on source versions, and pilot activation review. Part 1 introduces no after-operations correction door and enables no deferred financial workflow.

## Five predicted failure modes and proof obligations

The pre-implementation advisory design review inspected the sources and identified additional refusal obligations. Pending or approved `openingManagementSettlementPlans` depend on the posted opening even without a journal. Unpaid `payrollItems.openingCommissionLiabilityIds`, collection approval requests, cheques, allocations, receipt applications, and deposit commitment children also consume source identity before payment. The reset survivor registry in `utils/orgResetReferences.ts` additionally names claims, collection reminders, and payment intents. Void must refuse these later references rather than delete them. These are source-inspected design findings, not an independent review seat or executed evidence.

1. A ledger-only reversal leaves native AP, AR, stock, or commission liabilities alive. Drive all materialization families through registered posting and void commands; assert their literal minor amounts disappear or return to zero while masters survive.
2. A status/category shortcut admits a fresh opening after an ordinary reversal, or forgets activity in a different period. Verify linked governed pairs with original and opposite lines; refuse all other POSTED/REVERSED journals org-wide, including activity inserted after request and direct posting attempts.
3. The requester's approval, changed tenant id, payroll restriction, or a stale edited draft bypasses review. Exercise registered functions with real memberships, foreign documents, and same-actor requests; compare the complete table state before and after each refusal.
4. Ledger, trial balance, account snapshots, or bank attribution disagree after void. Read the actual report and bank consumers and literal per-account nets, retain original/reversal history, and refuse sealed periods instead of rewriting sealed snapshots.
5. Retry, damaged provenance, a downstream child, or a transaction-limit refusal commits half a cleanup. Validate before writes, leave unexpected errors uncaught so Convex rolls back, replay approved requests without writes, and assert every schema table is unchanged on refusal with the scheduler clock frozen.

## Sources and verification boundary

### Review round 5: legacy comparison exactness

S850-R4-1 reproduces an independent consumer of retained legacy cashflow.
Individually safe JOD rows can sum beyond the safe Number range. Both IN and
OUT totals in the public `compareLegacyToGL` query now use `addCutoverMinor`.
An unsafe sum propagates the existing `CUTOVER_UNSAFE_TOTAL` error. The query
returns exact totals or refuses; it does not return a rounded comparison.
No row is netted, dropped, rewritten or persisted by this arithmetic repair.
Date and deletion filters run before conversion and accumulation as before.

This chooses checked Number containment over a versioned BigInt response.
The existing response remains compatible for safe totals. A representation
change would need separate API planning and could not recover already-lost
precision in retained source rows. No new helper, code, schema, permission,
currency behavior, read or write is introduced. The journal-oriented advice
in the existing error text remains generic cutover guidance; the code denotes
the failed cutover total, including legacy cashflow.

The independent failing-first suite is
`convex/accountingCutoverLegacyExactness.scrum850.test.ts` at
`79260cee658a894ab55eec20f6143839af93df01`. Both unsafe cases fail there;
ordinary, below-limit and excluded-row controls pass. Tests call the registered
public query with real memberships and retained synthetic transaction rows.
Separate IN and OUT mutants must each fail. Module census and execution logs
are recorded in the round-5 section of
`docs/architecture/scrum850-round4-evidence.md`.

Checked on 2026-11-09: [ECMAScript Number.isSafeInteger](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-number.issafeinteger)
defines the exact integer boundary. [Convex data types](https://docs.convex.dev/database/types)
distinguishes Float64 Number from Int64 BigInt, so `v.number()` alone does not
prove aggregate exactness. [Convex application errors](https://docs.convex.dev/functions/error-handling/application-errors)
supports a coded `ConvexError` propagated to the caller. These sources support
the design; serial convex-test runs measure the application behavior only.

### Review round 2 decisions

Loading and saving a pending opening without changing money must preserve every
admitted minor integer. Reuse `formatMinorAsMajor` for input text; do not divide
through a major-unit Number or change the numeric `fromMinorUnits` API. The
display formatter with grouping separators is unsuitable for the exact input
parser. Existing editable conversion sites outside this PR are recorded in
`docs/architecture/scrum850-round2-evidence.md` for follow-up.

Approve and reject bind to the draft version the reviewer rendered. An absent
stored version is zero; each successful edit increments it atomically. Both
decisions require `expectedVersion`; stale decisions throw the localized coded
`OPENING_DRAFT_CHANGED` refusal before writes. A content hash was considered but
would require canonicalization of every optional content field. The single
content-edit boundary makes a version simpler and sufficient. This complements
Convex OCC, which cannot bind an earlier client review by itself. Old clients
without the required argument refuse.

A verified governed void pair is neutral to reconciliation source enumeration
as well as fresh-opening admission. One bounded shared inventory derives exact
journal identities from `verifiedOpeningVoidPair`. Both provenance strategies
and supplier cutover discovery use it; categories alone grant no exception.
Malformed pairs and incomplete inventories refuse. Proof reads remain charged
to guarded opening-reader budgets or supplier discovery's existing allowance.
The balance consumers retain both sides and still use closed-period snapshots.

The round 2 expected-version choice follows
[RFC 9110 If-Match](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.1).
Required arguments and safe coded failures follow
[Convex validation](https://docs.convex.dev/functions/validation) and
[application errors](https://docs.convex.dev/functions/error-handling/application-errors).
[Convex OCC](https://docs.convex.dev/database/advanced/occ) distinguishes the
transaction from the earlier review interval.
[ECMAScript toFixed](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-number.prototype.tofixed)
formats an already-rounded Number; string slicing preserves the input integer.
These sources were checked on 2026-11-08. Registered tests prove serial
application behavior, not cloud OCC or limits.

Checked 2026-11-08:

- [Convex mutations and transactions](https://docs.convex.dev/functions/mutation-functions): a mutation runs transactionally. This supports combining source checks and the entire unwind in one mutation; a multi-action workflow would not supply that atomicity.
- [Convex writing data](https://docs.convex.dev/database/writing-data): native transactional writes and transaction headroom support bounded reads and fail-closed approval. Reuse `inTurn` for sequential bounded steps, rather than starting unbounded sibling I/O.
- [Convex indexes](https://docs.convex.dev/database/reading-data/indexes/): the vehicle source census uses the org and opening-draft index, so unrelated consigned stock cannot consume the owned-opening allocation bound. Other source and reference inventories use existing org-leading indexes and refuse incomplete reads.
- [Oracle journal reversals](https://docs.oracle.com/en/cloud/saas/financials/26a/faiac/journal-reversals.html): reversal journals link to the posted original and can switch debit and credit. This ADR chooses that method and retains original entries.
- [University of Virginia accounting journals training](https://uvafinance.virginia.edu/sites/uvafinance/files/2022-05/Accounting%20Journals%20%26%20Accounting%20Adjustments-%20Learner%20Copy.pdf), journal reversal section: original and reversal remain in the ledger as the audit trail. Part 2 uses documented adjustments rather than rewriting posted lines.

Risk: HIGH financial and permission change. Registered-function convex-test evidence establishes application behavior in the serial harness, not OCC, Convex cloud limits, production data parity, or release certification. The coordinator owns Jira and final independent seats. No deployment, push, or pilot certification is authorized in this lane. Rendered desktop/mobile EN/AR verification and all three bug hunters remain separate evidence, never inferred from TypeScript or unit tests.
