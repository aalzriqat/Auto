# PR #710 reader remediation

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

The three new public query return contracts are now explicit, including AS_OF_DATE_UNSUPPORTED. Their arguments are unchanged. The requested `scripts/contractSkew/README.md` is absent at the starting head; the repository's `BASELINE-IDENTITY.md` documents the applicable evidence check and states that it does not prove return contracts. Existing baseline causes, fingerprints, multiplicities and expiry must remain unchanged. The report-call and period create/close entries need fresh defining-file evidence after this change and the main merge; that is maintenance evidence, not independent certification.

Seat 1's fee-backed advances concern and other findings outside the assigned remediation scope remain for SCRUM-879. No new independent review, browser render, production-data inspection, runtime parity or concurrency proof is claimed. The 4,000-row limit branches were independently probed by Seat 2 at the starting head, not added to this local reader suite.

## Sources checked

- [IRS IRM 3.17.15.6.1](https://www.irs.gov/irm/part3/irm_03-017-015r), subsidiary balancing guidance: use balances composed of the same transactions at the balancing date and show unexplained differences. This is supporting accounting practice, not a claim that US tax procedure governs this dealership.
- [Convex application errors](https://docs.convex.dev/functions/error-handling/application-errors): deliberate application refusals may use ConvexError.
- [Convex return validation](https://docs.convex.dev/functions/validation): returns validators enforce the expected result shape.

Documentation supports the choices; executed regressions and mutation controls measure implementation behavior in the local harness.
