# SCRUM-869 S2 discovery remediation

Invariant: the GL side is discovered independently of surviving supplier rows,
opening allocations and headers; lost current authority produces a difference or
UNAVAILABLE, while a completed financial reset retires its deleted authority.

## Impact map and design

| Area | Inspected surface and consequence |
| --- | --- |
| Writers | `accountingCutover.postOpeningBalanceDirect` / `openingAllocations`, `postingEngine`, `supplierCostRecoveryPosting`, `postingRules`; none changed. Journal entries store sourceType/sourceId, lines store their journalEntryId/accountId. |
| Readers | New report's `computeSupplierReceivablesReconciliation`, `openingRecoveryBasis`, `requireOpeningSettlementBasis`, `loadOpeningSourceIdentity`, `getControlAccountBalancesAsOf`; pending draft helper shared with A/P. Graft's caller graph includes module import edges; this is the scoped inspected reader set, not a claim that every graph node executes the new helper. |
| Historical data | Current live opening selected by GL journal identity. Retained headers checked for absent journal, referenced chart accounts, journal lines AND snapshots. Reference-only legacy stubs still supply recovery-id contradiction evidence. |
| Transitions | Current POSTED opening owns one header. Duplicate, reversed or unowned cutover authority refuses. Future openings use the journal's effective date for cutoff membership. |
| Reversal/unwind | Bounce, return, void, refund, cancel, reversal and merge gain no writer or new financial capability. Existing queued reversal and excluded-status tests remain; retained reversed opening authority refuses. Reset has real continuation-to-completion regression coverage. |
| Idempotency | Read-only query; no event, projection, key or retry writer introduced. |
| Authorization | Existing VIEW_FINANCE and accounting feature checks retained. |
| Tenancy | Queries scoped by org indexes; journal lines and chart accounts rechecked against the same org. Existing foreign-org/permission tests retained. |
| Ledger | Snapshot-aware balance consumer retained (ACC-2). Discovery uses source-family lines for identities, never to replace snapshot amounts. No A/R/A/P netting and no correcting entry. |
| Audit | Nothing persisted. Results expose existing coded refusal or complete per-currency difference. |
| UI | No client added or changed. Existing bilingual GL label and return validator preserved. |
| E2E | Backend report seam and real opening/reset writers in convex-test. Trusted authenticated PR check observed separately; local harness is not a real Convex/platform or screen audit. |
| Runtime/release | Indexed, bounded discovery: 1,000 extra documents (+ one over-limit sentinel), 100 ranges, and at most 1 + openingRecoveries compared accounts. Source identity adds a bounded 101-journal probe. Formula is a static upper-bound calculation, not measured byte/runtime I/O. No deployment. |

Options considered: another allocation scan cannot establish completeness;
refusing every retained header breaks completed resets; discovering GL account
identities and proving retirement addresses both. The existing #710 branch also
starts from opening journal lines, but its ABSENT-with-headers refusal is not
copied because it would retain the reset defect. No dependency on that branch.

The advisory design check identified two gaps before implementation: cap the
discovered account count used by the existing GL budget, and distinguish reset
from current journal loss using retained account identities. Both are included.
The source prefixes supplierCostRecoveries and supplierCostRecoveryReceipts are
scanned independently. Ordinary expense recognition uses expenses and canonical
1240; the two prefix scans do not inventory every supplier expense journal.
Unknown recovery-family account legs refuse instead of disappearing.

The final self-attack found that missing journal/chart metadata alone could
still coexist with retained GL lines or snapshots. Both cases falsely matched
at the first pushed head 4245efa21, and the snapshot-aware consumer independently
read 100,000 minor units. That head is superseded. Retirement now also requires
indexed absence probes for both GL storage paths, inside the same discovery
budget. The probe checks identity presence rather than a net total, so zero-net
residue also refuses. Advisory design and Spec rechecks found no scoped concern;
neither executed tests or certified the result.

Five predicted failures: lost allocations hide a balance; lost header hides a
balance; orphan recovery-family custom GL disappears; old reset headers poison a
fresh opening (or a missing current journal is wrongly called a reset); discovery
omits pending drafts or cutoff checks. The first four have dedicated corruption
or lifecycle regressions; existing custom-draft and future-cutoff tests remain.

## Finding validation

Both findings ACCEPTED; proposed fixes MODIFIED after independent reproduction.
On the clean main integration of cdc9ccf1, new tests retained and independently
read 100,000 minor units from GL after deleting allocation/header/recovery data.
Four cases falsely matched: allocation loss, header loss, and both orphan source
prefixes. Actual reset-to-completion returned OPENING_SOURCE_UNAVAILABLE. The
fresh-opening fixture initially tried to recreate a retained period; corrected
setup reuses it, and then failed for the same report refusal. Three additional
authority-loss/reversal/duplicate controls were already green before the fix.

Red runs: `C:/tmp/714-red.json` (5 intended assertion failures plus one corrected
setup failure), `C:/tmp/714-red-fresh.json` (1 intended assertion failure).
The advisory Standards/Spec checks found a valid-caller regression in the first
implementation: custom partner-capital equity was classified with the writer's
permission flag false and refused. A real opening with a custom equity
counterpart reproduced the refusal (`C:/tmp/714-red-capital.json`). Recognition
now includes the supported custom capital shape as outside A/R, independently of
allocation survival; no posting permission changes. The scoped advisory Spec
recheck found that concern addressed. These checks are not certification seats.

Mutation evidence: omitting `discoverSupplierReceivableGlAccounts` kills eight
of the nine original new cases, including all four false-match reproductions and
the three existing-green authority controls. Forcing retained-header refusal
kills both reset cases (including the ninth case). Restoring false for custom
capital recognition kills its new test. Each failure is an intended report
assertion, not setup/timeout. The source was restored from a saved file copy and
hash-checked. The mutations exercise the new discovery function and its refusal
path; the existing budget test still checks the expanded static formula.

The two retirement GL regressions failed first at the report assertion
(`C:/tmp/714-red-retirement-gl.json`). Omitting the GL-presence refusal kills both.

Named one-worker restored control: 107/107 (83 A/R + 24 A/P), zero skipped.
Twelve new permanent scenario records extend the oracle; the library definition
validator reads 457 records with zero problems. That does not claim 457 scenario
executions. Convex typecheck and changed-file ESLint pass. Convex includes
`convex/` and `test-utils/`, excludes generated entry roots, and does not check
the frontend or scripts project.
These are local convex-test evidence, not platform/OCC/production certification.

## Sources checked

- [ACCA FA1, example 1](https://www.accaglobal.com/content/dam/acca/global/PDF-students/fia/examreports/FA1/FA1%20examiners%20report%20spet-19-aug20.pdf): an error can affect the control account, the list of balances, or both. This supports independent comparison; report-only behavior is SCRUM-869 c23880 OQ-10.
- [Convex indexes](https://docs.convex.dev/database/reading-data/indexes/): source-prefix ranges and journal-entry indexes use maintained native queries.
- [Convex application errors](https://docs.convex.dev/functions/error-handling/application-errors): deliberate client-safe refusals are distinct from unexpected errors; existing generic error boundary retained.
- [Convex limits](https://docs.convex.dev/production/state/limits): document/range budgets are statically bounded; real-backend byte/runtime limits remain unmeasured (SCRUM-879).

Recurrence prevention (`correct`): #710's allocation-loss class (recorded in
`reference_reconciliation_account_discovery_is_independent.md`) and this round's
independently reproduced #714 failures demonstrate recurrence. The correction is
GL-based discovery plus permanent deletion/lifecycle tests, rather than another
instruction-only rule. Broader shared-helper/maintenance work stays in SCRUM-879.
