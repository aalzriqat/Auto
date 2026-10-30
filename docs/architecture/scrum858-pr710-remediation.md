# PR #710 reader remediation

## Population remediation at reviewed head 25f89c5a

Both seat reports were read in full. The assigned HIGH findings were independently reproduced before production edits: three lost-allocation cases returned AVAILABLE and reconciled, four future-opening cutoffs returned AVAILABLE against different populations, supplier payables accepted a past cutoff, a later native payable hid a cancelled opening at the historical cutoff, and a legitimate public DIRECT sale was labelled an unexplained opening difference by the recoverables reader. The DIRECT fixture uses the existing legacy-cash opt-out in `supplierReceivables.test.ts`, not a production flag change or proof that the route is currently pilot-enabled. Findings ACCEPTED; advisory remedies MODIFIED as follows.

1. `openingAllocationAccounts` now enumerates the actual opening journal lines and verifies allocation coverage for each relevant control before selecting accounts. This reuses the existing opening account policy, including ambiguous custom liabilities and potential custom capital. Missing metadata returns `OPENING_SOURCE_UNAVAILABLE` even when its materialized row is gone. PR #714 was inspected as an independent-discovery precedent; its then-current declaration inventory also used allocations, so it was not copied as proof of completeness.
2. One date guard covers all four readers. Past/non-finite cutoffs refuse. An indexed after-cutoff journal probe also refuses current or future requests that precede recorded future activity, including the omitted-date June 15 / June 17 opening case. Source timestamps and partner movement effective dates provide further refusal. A valid June 17 read reconciles. The probe conservatively refuses unrelated future journals and drafts too. This is containment, not historical reconstruction.
3. Supplier recoverables now verifies cumulative control-account GL provenance independently of supplier rows. Posted and reversed original entries, plus reversal entries, remain in the inventory. Opening, expense-originated supplier recoveries and native recovery receipts are recognized by journal/event identities and event type plus source type. Other or unverifiable families return `SOURCE_FAMILY_UNSUPPORTED`; no amount is silently excluded. The shared scan has a 4,000-line budget, not a whole-checklist resource guarantee. A cancelled DIRECT sale still refuses when its GL nets to zero. A valid opening-recovery receipt still reconciles at 69,000 minor units.

The close checklist has specific date and shared-family warnings in English and Arabic. The prior nested ternary was replaced by a reason map while adding the date case. Other unavailable reasons retain the existing family wording. The queued-payroll regression reproduced the new fourth warning before its expectation was updated; unacknowledged close still refuses and its original financial assertions remain.

The invariant remains: compare independently discovered controls and complete, matching dated populations, or report a coded refusal. No journal, snapshot, plug or capital adjustment is written. The existing 13-area impact map below still applies, extended to native DIRECT sales, commission collections, deposit retention, sale cancellation, and their shared-control GL. Source and row deletion are adversarial corruption controls; native writers and reset/reversal behavior are unchanged. No migration, new spending path, command identity, schema, permission or financial activation switch was added. Employee fee-backed advances remain the explicitly deferred SCRUM-879 concern, not certified by this supplier-family fix.

Five predicted failures were tested: allocation metadata selecting its own GL set; future activity bypassing date refusal; later payable activity offsetting an earlier defect; other source families creating or concealing a discrepancy; and reads changing accounting witnesses. Ledger snapshots around the read assertions remain unchanged.

| Mutation control | Assertions that failed |
| --- | --- |
| Restore allocation-only account discovery | 3 lost-allocation tests. |
| Disable shared date guard and source-date refusals | 4 future-opening tests, past/non-finite payable test, later native payable test, queued-payroll integration: 7. |
| Bypass supplier family verification | DIRECT/deleted-row/offset case and cancelled zero-net case: 2. |
| Reject the supported native recovery-receipt event type | Supported opening-receipt control: 1. |
| Route date and family refusals to generic warnings | Payroll date-warning and DIRECT checklist assertions: 2. |
| Corrupt both new English dictionary entries | Both exact server/dictionary tests: 2. |

Each mutation restored original file bytes in `finally` and verified its SHA-256. The first dictionary-mutant command selected two existing render tests rather than the new dictionary assertions and survived; that was a selection gap, not a claim of mutation coverage. Rerunning the exact dictionary selector killed both intended assertions. The twelve backend cases have literal-title scenario records and certification-matrix bindings. The recurring independent-discovery and dated-population mistakes triggered the `correct` workflow; shared backend decisions and regressions provide in-scope prevention. Broader tooling/rule changes are not included.

The advisory design attack checked cumulative reversed GL and bounded discovery. Advisory Standards and Spec checks do not replace either independent money seat. Both final-head seats must re-certify. Local Convex harness and jsdom results do not prove Convex platform behavior, OCC, live data parity or rendered EN/AR phone/desktop UI. No production inspection or write was performed.

Official Convex validation and application-error documentation and IRS subsidiary balancing guidance linked below were checked live again. They support explicit coded refusal and independent populations at one date. The IRS text is supporting accounting practice, not a dealership-specific legal requirement. Documentation is not implementation proof.

Final local run after the clean main `e99dc762` merge: six named suites passed 121 tests with one worker (49 closure readers, 21 supplier receivables, 17 dialog, 24 commission/payroll, 7 reversal, 3 rounding). The scenario validator passed 62 checks. Root `pnpm typecheck` passed and excludes Convex, apps, packages, dealer-worker and test-utils entry roots; `pnpm typecheck:convex` separately covers Convex/test-utils and excludes generated entry roots. Changed-file ESLint has zero errors and one existing dialog effect warning. No full suite or watcher ran. Both advisory axes found no additional blocker, read-only without rerunning tests. Baseline relocation moved the unchanged close call from 117:13 to 120:13; seven affected entries retain all causes, fingerprints, multiplicities and expiry, with fresh client/defining-file blob evidence. The requested contract-skew README remains absent; `BASELINE-IDENTITY.md` was followed and explicitly does not certify return contracts.

The sections below preserve the earlier remediation history. The population behavior above supersedes their narrower three-reader date and header-only discovery descriptions.

### CI fixture follow-up after fa17f4d19

Tests run `41122887534`, slice 1/4 job `124293636862`, failed nine Phase 1 cases. The same nine failures reproduced locally before editing `accountingPhase1.test.ts`. Those fixtures close January 2026 after that period ends without acknowledging the newly required supplier-payables date warning. Eight successful plain-close fixtures and the owner-override fixture now acknowledge only that exact warning. The close/lock test asserts the coded refusal and exact warning, proves an unacknowledged close still refuses, and keeps the original CLOSED/LOCKED assertions. Other permission, blocker, reopen and posting assertions remain. No production source or acknowledgement gate changed.

An AST census enumerated 38 direct close invocations across 22 matching tracked Convex test files. Named aliases are outside that census. Other unacknowledged callers were inspected; the scoped Phase 2, release-rehearsal, collections and deferred-cheque checks passed (5 selected plus the separately selected D3 case). They use current-period fixtures or deliberately assert refusals. The Phase 1 suite passed 43/43 after correction. Disabling the date refusal and disabling close acknowledgement enforcement each killed the new close/lock assertions, with source bytes restored and hashes matched. A thirteenth scenario record binds this historical-close acknowledgement case. This repeats the earlier payroll fixture adaptation class, so `correct` was applied to the caller census and regression rather than weakening a production gate or adding unrelated tooling.

Final follow-up run: 164 tests passed across seven named suites, plus 62 scenario-validator checks (226 total). Convex typecheck passed; root compilation and production-source lint evidence from fa17f4d19 still apply because this follow-up changes test/scenario/docs only. The Phase 1 file has zero lint errors and four pre-existing explicit-any warnings. Both advisory deltas found no weakening. The Spec advisory corrected the new record's actor to Finance Admin and recorded its fixture permission grant before lock; its fingerprint was regenerated and the 62-check validator passed again. Fresh fetch and bare merge were up to date, with identity/evidence still 928 matched/checked and no drift or stale evidence.

SCRUM-858, reviewed starting head `815714850e5558f1590bb0032a26c879fbc30e6a`.

Invariant: a reconciliation compares GL and subledger at the same date, discovers GL controls independently of surviving subledger rows, and reports a difference or UNAVAILABLE when source evidence cannot support a match.

## Impact and design

The design check was advisory, not a review seat. Two alternatives were considered: reconstruct historical state from all source and lifecycle events, or refuse unsupported historical dates. The latter keeps this remediation local and does not invent missing deletion, write-off or recovery history. A strict timestamp comparison also refuses earlier-today reads. A future requested cutoff is retained, never silently replaced with now.

| Area | Scope and disposition |
| --- | --- |
| Writers | Existing opening cutover, native payroll advances/recoveries, supplier recoveries and partner movements remain unchanged. The fixture drives public opening and partner movement writers. This is not an exhaustive audit of their producers. |
| Readers | `computeSupplierPayablesReconciliation`, the three new family helpers, their public registrations and `computeCloseChecklist`; close dialog translates fixed warnings. Graft caller graphs located these relationships. Supplier receivables belong to #714 and are unchanged. |
| Historical data | No migration. Past/non-finite cutoffs refuse on the three new readers. Current discrepancies remain visible. Orphaned opening authority refuses rather than implying no custom controls. |
| Transitions | No new create/post/approve/cancel/reset operations. Current reads retain deleted/cancelled-source discrepancy behavior. |
| Reversal | No new spending path or reversal obligation. Existing opening reversal refusal remains covered by its named suite. |
| Retry | Queries remain read-only; repeated reads do not mint accounting events. No new command identity. |
| Authorization | Public queries retain tenant authentication, VIEW_FINANCE and accounting-feature checks. Deliberate ConvexError refusals propagate. |
| Tenant isolation | Existing org-scoped source and control indexes retained. No new caller-supplied document id. |
| Ledger | Existing cumulative reader, including closed-period snapshots, retained. No journal, plug or partner-equity adjustment. |
| Audit | Unexpected errors log raw technical detail server-side and throw a generic client error. |
| UI | Truthful payable-source warning in EN/AR; other family unavailable text includes historical reconstruction refusal. Dialog acknowledges original server strings. DOM evidence only. |
| E2E | CI hunters and authenticated execution remain separate evidence. Local convex-test and DOM results do not certify platform, OCC or production behavior. |
| Release | No deploy, environment, schema or flag changes. Merge is not deployment. Final independent seats remain required. |

## Findings and evidence

All three blocking findings were reproduced before changing production code. The new targeted run had eight assertion failures: orphan payable, three dated readers, offsetting partner tamper and three async boundaries. The separate missing-provenance warning test also failed first. Original reader suite contained 31 tests.

After implementation, the four named suites passed 64 tests: readers 40, dialog 14, reversal 7, rounding 3. Command from the worktree root:

```sh
pnpm exec vitest run convex/openingClosureReaders.scrum858.test.ts components/accounting/setup/ClosePeriodReviewDialog.test.tsx convex/openingReversalDoors.scrum858.test.ts convex/openingPrepaidRounding.scrum858.test.ts --maxWorkers=1 --testTimeout=20000
```

Five predicted failures were tested by temporarily breaking the fix and restoring original bytes after each run:

| Mutation | Observed failure |
| --- | --- |
| Remove source-authority refusal | Orphan payable regression fails, 1 assertion failure. |
| Remove historical cutoff refusals in all three helpers | Three dated-reader tests and offsetting draw test fail, 4 failures. |
| Return compute promises without await inside try | All three asynchronous error-boundary tests fail, 3 failures. |
| Route missing-source warning to over-limit fallback | Truthful close-warning regression fails, 1 failure. |
| Corrupt new English payable-source dictionary text | Server/dictionary contract regression fails, 1 failure. |

`pnpm typecheck:convex` passed. It includes Convex and test-utils and excludes generated entry roots, not a frontend compilation check. Changed-source ESLint had zero errors and one existing dialog set-state-in-effect warning. No wide local suite or watcher ran.

## Contract and limitations

The three new public query return contracts are now explicit, including AS_OF_DATE_UNSUPPORTED. Their arguments are unchanged. The requested `scripts/contractSkew/README.md` is absent at the starting head; the repository's `BASELINE-IDENTITY.md` documents the applicable evidence check and states that it does not prove return contracts. Existing baseline causes, fingerprints, multiplicities and expiry remain unchanged. Seven report-call and period create/close entries carry fresh defining-file blob evidence after the bare merge of main `09abccc14`. Both warning paths and tests were retained during conflict resolution. The merged four suites passed 65 tests, including 15 dialog tests. Identity checks matched 928 entries and the evidence checker measured 928 entries with zero unrenewed, stale, malformed or missing. This is maintenance evidence, not independent certification. The scenario validator passed 62 tests after nine new records were added.

Seat 1's fee-backed advances concern and other findings outside the assigned remediation scope remain for SCRUM-879. No new independent review, browser render, production-data inspection, runtime parity or concurrency proof is claimed. The 4,000-row limit branches were independently probed by Seat 2 at the starting head, not added to this local reader suite.

## Sources checked

- [IRS IRM 3.17.15.6.1](https://www.irs.gov/irm/part3/irm_03-017-015r), subsidiary balancing guidance: use balances composed of the same transactions at the balancing date and show unexplained differences. This is supporting accounting practice, not a claim that US tax procedure governs this dealership.
- [Convex application errors](https://docs.convex.dev/functions/error-handling/application-errors): deliberate application refusals may use ConvexError.
- [Convex return validation](https://docs.convex.dev/functions/validation): returns validators enforce the expected result shape.

Documentation supports the choices; executed regressions and mutation controls measure implementation behavior in the local harness.

## CI integration correction

The first pushed candidate, `7faaf1f1190e43017478ccce01730af5f8f86769`, failed Tests slice 1/4 in `openingCommissionPayroll.test.ts`. Its queued-payroll scenario closed January on February 1 without warning acknowledgement. The new historical refusals truthfully introduce three warnings, so that close now refuses. The same failure was reproduced locally before editing the test. The adjusted test asserts exactly those three warnings and each AS_OF_DATE_UNSUPPORTED result, proves unacknowledged close still refuses, then explicitly acknowledges the warnings before continuing the original payroll debt, damaged-source refusal, retry and journal assertions. No production gate or financial assertion was weakened.

The full affected payroll suite passed 24 tests. Two restored source mutations each caused one failure: removing the historical guards erased the expected warnings, and disabling acknowledgement enforcement incorrectly allowed the unacknowledged close. The additional suite is named explicitly and still uses one worker.

The draw/tamper regression also pins Date.now to June15 of its synthetic year and restores it afterwards. An executed January1 control failed on the native writer's future-date refusal before reaching reconciliation; the pinned clock removes that calendar dependency. The scheduler freezer deliberately does not fake Date, so vi.setSystemTime alone was not valid evidence of that control.

## Maintainability correction after the green candidate

At `5f3a39d3ff4ce1d6833ec28f33623f3e8d9e0f72`, Tests, SonarCloud and the producer-bound authenticated PR check passed. Sonar nevertheless reported three introduced HIGH S3776 findings: opening control discovery (30), supplier-family coverage (36), and partner reconciliation (17), against the existing limit of 15. Four introduced duplicate-import findings were also reported. The correction extracts typed helpers for journal totals, allocation coverage, source-family validation and signed dated partner movements, and consolidates imports. No rule, threshold, gate or financial behavior changes.

The cached official SonarJS native rule implementation reproduced all three original scores. With the same limit of 15, it reports none of those functions or the extracted helpers after the correction, and no duplicate imports in the three changed production files. Five pre-existing complexity findings elsewhere in those files remain outside this correction. This local rule execution is scoped evidence, not a substitute for a new exact-head SonarCloud result. The design follows [Convex's helper guidance](https://docs.convex.dev/functions/query-functions#splitting-up-query-code-via-helpers); [SonarSource's S3776 implementation](https://github.com/SonarSource/SonarJS/blob/master/packages/analysis/src/jsts/rules/S3776/rule.ts) documents the default limit.

Four additional restored-byte mutation controls protect the extraction: returning no journal totals fails all three lost-metadata tests; bypassing allocation coverage fails those same three; accepting every supplier journal fails the two foreign-family tests; omitting partner movement amounts fails the later-draw, public contribution/draw and ordinary-operation tests. Both read-only Standards and Spec advisory reviews found no behavior change. They are not independent review seats or financial certification.

Main advanced to `556d7a919e5367af9a3b97a05f420d553ec18d19` during this correction. A bare merge retained the reader changes; all eight named files passed again (226 tests, one worker). Convex typecheck passed after restoring an explicit AVAILABLE discriminant check required by the source-identity union. The unchanged close call moved from 120:13 to 121:13 with import consolidation; the native relocation tool verified its complete call expression, and seven affected evidence entries were refreshed without changing any cause, fingerprint, multiplicity or expiry. The merged bank/inventory work is upstream scope, not newly certified by these reader tests.
