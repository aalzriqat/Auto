# SCRUM-868 P5 local implementation evidence

Base: `2b1ae16ad436f845db6c2aef6b47ff5cc5bb923d`. The implementation is
`35f4a7fe8a47dfd4245440373a301402ec88f9ab`; the following registration commit
adds literal test registrations, scenarios, this report, the matrix and source
freshness evidence. Nothing is pushed or deployed.

## Invariant and impact

The [ADR](../adr/2026-11-09-opening-supplier-identity.md) contains the invariant,
two designs, the writer/reader and lifecycle impact map, exclusions and five
predicted failures. SUPPLIER_PAYABLE and SUPPLIER_RECOVERABLE require identity.
OTHER_PAYABLE resolves a selected supplier but permits an ordinary creditor.
All posting snapshot fields come from one master snapshot, copied to the
approved allocation and obligation. Historical reads do not repair rows.

The P3 blanket OPENING exception is removed. New settlement of an id-less
supplier opening refuses with SUPPLIER_IDENTITY_UNRESOLVED. Both-idless
historical provenance still verifies by snapshot name for replay. Ordinary
id-less OTHER_PAYABLE remains serviceable. The user and SCRUM-868 c24878 supply
the zero-opening-drafts production count; this session reads no production
data and does not independently certify that count.

## Failing-first and mutation evidence

| Check | Observed result |
| --- | --- |
| Test commit `16d16280cbe2c02cacc5605fc67077b03b6257de` | 40 failed, 2 passed across backend and EN/AR editor files |
| Pending legacy draft at that commit | Approval resolves with a journal instead of rejecting; this exact literal test is the single new bugRef |
| Final new backend/editor suites | 52 backend plus 11 component cases pass |
| Focused basis control | 2 pass |
| Mutant replacing supplier-id comparison with snapshot-name comparison | 2 assertion failures; both same-name different-id cases detect false availability |
| Restored bytes | Same focused 2 cases pass |
| Coverage run, new supplier allocation module and supplier field component | 100% lines, 96.66% statements, 92% branches, 100% functions; repository thresholds retained |

The first coverage attempt passed its 61 tests but failed the existing 90%
line/statement thresholds. An unrelated allocation control and an unexpected
runtime-failure boundary control closed the uncovered paths. The succeeding
run passed 89 tests across the backend and both editor files. This scoped
coverage report is not Sonar's whole-diff new-code coverage result.

## Validation scope

The reference enumeration was generated with:

```powershell
git grep -l -E 'openingAllocations|openingSupplierBasis|openingSupplierPosting|supplierRegistry|accountingCutover|workflowHooks|supplierCostRecoveryPosting|sourcingPayables|supplierCostRecoveries' -- '*test.ts' '*test.tsx'
```

It found 124 files in the working tree, including the new backend suite and
one mobile Jest file. Vitest used named files and `--maxWorkers=1`, in bounded
batches. The mobile test used Jest with `--runInBand --watchAll=false`.
Additional focused editor, form, rehydration, library, route and census files
were run explicitly. This enumerates direct textual references, not every
possible transitive dependency.

| Check or scope | Result |
| --- | --- |
| 105 non-script, non-closure reference files | Exercised in named batches; three stale fixture families required canonical supplier ids and passed on rerun |
| openingBalanceMaintenance, openingRemainingFamilies, payable reconciliation, editor/form/rehydration focused batch | 108 pass |
| openingClosureReaders complete file | 88 pass, including the read-budget controls |
| 15 non-contract infrastructure files | 585 pass, including tenantWriteGuard and supplier master guards |
| Public opening composite, opening rehearsal unit file and admin deletion file | 68 pass after updating public rehearsal and reset/deletion fixtures |
| Supplier receivables reconciliation, contractSkew and renewal unit files | 421 pass |
| authorToolsCli | 58 pass after local CRLF normalization of the two shebang-bearing imports; unchanged Git blobs |
| Mobile sourcing cost gate | 5 pass using the installed Babel runtime through temporary NODE_PATH; environment restored and no dependency files changed |
| New suites plus scenarioRecord | 133 pass after literal test registrations |
| Library | 1,286 records, including 52 P5 records; zero validation problems |
| Root typecheck | Pass; the root config excludes convex and mobile as roots |
| Convex typecheck | Pass separately; not inferred from the root check |
| Touched-file ESLint | Zero errors and zero warnings after final cleanup |
| Guardrails | Pass, no ceiling raised and no count assertion added |
| Baseline call identity | 948 entries match; this measures call identity, not live backend finding identity |
| Both actual opening routes | Focused registered-argument proof passes; unrelated clientPaths cases are filtered out, not claimed executed |
| Contract census | 29 pass |

Initial broader runs failed because old test and rehearsal callers still sent
supplier names alone. Their canonical supplier setup was updated without
changing amounts, assertions or gates. The retained legacy name-classification
control explicitly removes both stored ids after authentic public posting.
An early broad run was interrupted for workstation load, then the complete
closure file and remaining named files ran to completion. Early PowerShell
array invocations selected no files; corrected native Node invocations ran
the actual named-file batches. No empty run is counted as passing evidence.

The source freshness check initially measured 18 stale entries. Those entries
in five baseline shards have per-entry reviewed source/blob notes. Their
identities, causes, fingerprints, multiplicities, rationales, issues, expiries
and UNKNOWN status are unchanged. The pre-commit check reports 948 checked,
zero unrenewed/stale/malformed/missing. The committed-tree check is run again
for the handoff. This CLI additionally requires `--reviewed <base>`:

```powershell
node scripts/contractSkew/renewBaselineReviewed.mjs --check-evidence --reviewed 2b1ae16ad436f845db6c2aef6b47ff5cc5bb923d --pr-base 2b1ae16ad436f845db6c2aef6b47ff5cc5bb923d
```

## Review and limits

Pre-code advisory design inspection found no blocker. The two-axis advisory
review found no financial defect. Its API-shape note was fixed by a typed
materializer request object and re-inspected at the implementation SHA above.
These are advisory inspections, not the two independent money-review seats.

Two test-only coverage follow-ups, with no identified production gap, are
recorded in [SCRUM-879 c24880](https://autoflowdealer.atlassian.net/browse/SCRUM-879?focusedCommentId=24880):
invalid optional supplier ids on OTHER_PAYABLE, and a settlement retry after
an actual master rename. The existing inactive retry does not measure rename.

Not verified here: authenticated EN/AR desktop/phone browser rendering, screen
audit, explorer swarm, hosted CI/Sonar, CodeRabbit, independent review seats,
real-backend schema validation or rehearsal, OCC/cloud limits, production data
parity or pilot certification. No dev server, watcher, Convex deploy, production
key or production data was used. The generated API declaration was extended
using the pinned CLI template's module/import convention, without a connected
codegen or backend push. Source types pass; platform-generated freshness is a
separate CI obligation. P6, P7, migrations and deferred financial activation
remain outside this change. There is no open owner question for P5's decision.
