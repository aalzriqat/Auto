# Replay historical bugs against the G6 oracles

SCRUM-344 / SCRUM-760 G6. This measures detection. It does not certify a pilot,
change an existing gate, or authorize enabling a financial operation.

## Run locally

Use the installed controller dependencies and a full Git history. The runner creates
temporary copies outside the worktree. It never checks out over the source tree.

```powershell
node node_modules/vitest/vitest.mjs run scripts/intelligence/oracleReplay.test.ts scripts/intelligence/crossScreenOracle.test.ts scripts/intelligence/jevFormOracle.test.ts scripts/intelligence/sideEffectOracle.test.ts scripts/intelligence/browserSwarmBoundaryOracle.test.ts --maxWorkers=1
node scripts/intelligence/runOracleReplay.mjs --out artifacts/oracle-replay
```

The second command intentionally exits 1 locally. Browser observations require a
disposable preview. It still writes the JSON and Markdown report, with those rows
unavailable. It does not run Playwright, create a preview, or read credentials.

For a bounded investigation, use `--case g6-01 --out artifacts/local/g6-01`.
A single-case report retains the other nine cases as unavailable. It cannot pass
the calibration gate. `ORACLE_REPLAY_KEEP_SCRATCH=1` retains private temporary files
for debugging. Do not upload the scratch directory or its raw logs.

## Run the browser replay

After the coordinator's review and merge, dispatch **G6 Oracle Catch Rate** on
`main`. This secretless preflight triggers **Trusted G6 Oracle Catch Rate** through
`workflow_run` on the default branch. There is no case-selection input. The trusted
matrix enumerates the complete
checked-in corpus, with one worker and one case at a time. Failures do not cancel
the remaining cases. After merge:

```powershell
gh workflow run oracle-catch-rate.yml --repo aalzriqat/Auto --ref main
```

The workflow uses the existing preview and test-instance Clerk secrets by name.
Its jobs check out `github.workflow_sha`. The privileged workflow also requires a
successful same-repository main dispatch whose head equals that controller SHA.
A branch-selectable dispatch does not own the privileged workflow. Each fixed and
reverted subject gets a different disposable preview through
`--preview-create`. The runner validates the preview-key shape, pins the deployment
returned by that creation, scrubs external-provider environment names, seeds the
parent's QA data, verifies the marker with the trusted bootstrap, and deletes the
same pinned deployment. Cleanup refusal makes evidence unavailable. As in the
existing preview lifecycle, a CLI failure before returning a deployment URL can
leave an unpinned preview to expire. A cancelled job relies on the pinned expiry.

The application builds with public configuration and its historical shared package.
The browser controller holds the test login material. A Clerk `pk_test_` key is
mandatory. The existing deny-by-default egress proxy contains authenticated browsers.
Neither project-wide deploy credentials nor login passwords enter the app process.

The browser run executes both auth seats, accounting-period setup, cross-screen
consistency, the seeded random explorer, the form explorer, and the existing swarm.
The swarm receives the same predeclared TEN-1, AUTH-1, ECON-1, ACC-1, ACC-2, CONS-1,
LIFE-1 and UI-1 obligations for every subject. It is not told which bug to seek.
All missions are assigned to one worker. A failure in a screen project does not
suppress the swarm. Side-effect pure-rule tests run locally; no new notification
browser driver is claimed here.

Download the `oracle-catch-rate` artifact. It contains the complete sanitized report.
Per-case artifacts contain `entry.json`. Raw browser captures, backend errors and
temporary source trees are not uploaded. Historical frontend, API or dependency
incompatibility is an unavailable result, not a reason to weaken a check.

## Keep detector inputs separate from answers

The source of truth is `scripts/intelligence/oracleReplayCorpus.json`. It pins
full fix and parent SHAs, production paths, pre-finding test suites, intended
oracle families, expected detection fingerprints, ruling references and witnesses.
Severity is the curator's High financial-risk classification, not a claim about
historical Jira priority. Each row is one selected defect, even when its fix also
repairs companion defects.

1. Archive the parent without Git history, documentation, regression labels or
   post-finding test files. Refuse historical symlinks and submodules before extraction.
2. Overlay the selected fixed production files to make the control. Apply the
   actual inverse Git diff to its separate companion. Verify reverted bytes equal
   the parent before parsing. New production files disappear when reversed.
3. Remove source comments and test descriptions with the TypeScript parser.
   Preserve executable input strings. Run the same parent tests in both copies.
   The baseline is frozen per case; it is not today's regression suite.
4. Run the frozen current browser oracles against each application. The browser
   driver receives directory paths, not the corpus labels, ruling, fix message,
   witness test or expected result. The bootstrap and application inputs come from
   the parent. Generic attacks generate their own synthetic inputs, uniformly
   across the corpus; they are a current-policy replay, not a claim to reproduce
   the original human browsing session or to provide a blinded model evaluation.
5. After detector execution, copy post-finding regression witnesses into the local
   harness only. Require fixed-green and inverse-red with matching test counts.
   These witnesses verify that the selected defect was reproduced. They are not
   hunter catches and never enter detector recall.
6. Join labels with observations for scoring. A different anomaly on the mutant
   is extra review work, not a catch of the selected finding. Swarm fingerprints
   require the intended invariant and an actual invocation of the target public
   function in that same mission. FINANCED-only targets also require that argument.
   The trace records public function names and that enum, not tenant ids or payloads.
   Reviewing the actual backend evidence remains part of independent verification.

The controller dependency versions are reused rather than installing historical
lockfiles. The historical workspace package stays local. The report records the
controller SHA, harness digest, corpus digest, Node version and platform. This is
a compatibility limitation: failure with today's dependencies is unavailable.

## Corpus

The JSON contains full SHAs and the exact baseline and witness files. Four rejected
candidate families and their reasons are recorded there as well.

| Case | Fix | Selected defect | Ruling | Intended oracle |
| --- | --- | --- | --- | --- |
| g6-01 | e4995a36a | Supplier settlement accepts a foreign payment account | SCRUM-773 | TEN-1 |
| g6-02 | 2e7ea58cd | Consigned settlement reclaims supplier VAT | SCRUM-773 c22401 | CONS-1 |
| g6-03 | fa4bdab24 | Queued consigned settlement posts prohibited VAT | SCRUM-760 c23812 | CONS-1 |
| g6-04 | 29de78106 | Salesperson receives a second SALE commission | SCRUM-854 | AUTH-1 |
| g6-05 | b32891eb1 | Non-owner prepares their own opening commission | SCRUM-760 c22465 | AUTH-1 |
| g6-06 | b67957756 | Closed or cancelled deal documents remain writable | SCRUM-422 c21130 | LIFE-1 |
| g6-07 | 2a647c284 | Finalization accepts drifted frozen quote economics | SCRUM-528 | ACC-1 |
| g6-08 | ea13dc298 | Deleted vehicle acquires commercial authority | SCRUM-641 | LIFE-1 |
| g6-09 | b6f64fe24 | Unrelated cost consumes the execution-fee expectation | SCRUM-690 c22119 | ACC-1 |
| g6-10 | 98073b88f | Financed sale bypasses its own finalization door | SCRUM-415 | AUTH-1 |

## Read the result

`caught` requires a clean fixed control, an executed mutant, a reproduced witness
and the expected deterministic signal. `missed` means a complete applicable run
produced no matching signal. `unavailable` includes missing suites, empty or malformed
JSON, mismatched counts, skipped work, non-assertion exceptions, missing observations,
unexecuted missions, cleanup failures and witnesses that did not reproduce cleanly.
It counts as a failure and stays in the denominator.

Primary recall is catches divided by all selected High/Critical entries, including
unavailable entries. On a partial run this is a conservative lower bound, not an
estimate of the missing observations. Baseline, explorer and combined recall are
reported separately. The report lists explorer misses, baseline misses, unavailable
cases and incremental explorer catches. A baseline miss is a detector-coverage
finding, not a claim that the already-fixed product bug is currently open.

Precision uses case-level target-family detections and alerting fixed controls.
Unmatched mutant alerts require adjudication and withhold precision. The report also
counts fixed-control alerts, extra review alerts, browser tests, swarm missions and
elapsed detector time. It does not invent model token, monetary cost, reviewer
disagreement or production-concurrency measurements. Model suggestions are disabled;
the seeded explorer is identified as such.

The calibration gate requires the full corpus, available evidence, measured
precision and no explorer misses. Unadjudicated alerts withhold the verdict.
Invalid or stale dispatches fail a secretless authorization job.
Artifact-download failure is consumed by the scoring step as missing cases, which
fail the report. Missing artifacts remain explicit unavailable rows. Aggregation rejects
stale controller, harness and corpus identities, and recomputes classifications
from paired evidence instead of trusting an entry's verdict string. This gate
does not replace SCRUM-760's independent verification, existing hunters or releases.

## Verification and practice

The [saved local report](evidence/scrum344-local-replay.json) was measured at
`b5a394279cf4b809f6d1b7d413a8defd34a227a1`, before subsequent cloud-only
directory/key checks and the test-only native-I/O timeout correction. It reports
**FAIL**: baseline misses g6-01,
g6-04 and g6-05; seven unavailable baselines; ten unavailable browser results.
Witnesses g6-01, g6-02, g6-04 and g6-05 reproduced fixed-green/inverse-red. The
other six did not reproduce cleanly. Conservative baseline and explorer recall
are 0/10; precision is unavailable. These are not measured browser false negatives.

The final focused command passed 157 tests across seven named files. The root
`tsc --noEmit` passed and excludes `convex/`; backend production code is unchanged.
Named-file ESLint passed. No production or local Playwright execution is claimed.
One repeat of the native Git integration test exceeded Vitest's five-second
default while completing its assertions. Its allowance is now 30 seconds for
bounded Git and tar subprocesses; its assertions and scenarios are unchanged.
The cloud-only correction makes the trusted test directories absolute because
[Playwright resolves test paths relative to its generated configuration](https://playwright.dev/docs/api/class-testconfig#test-config-test-dir).
Its runtime verification remains the coordinator's dispatch.

The initial harness run had **8 failed tests** before implementation. The Git
integration test proves real inverse-patch application outside the source tree.
Subsequent negative controls cover malformed reports, generic crashes, skipped
tests, incomplete swarms, wrong findings and verdicts without observations.
The local execution evidence is stored beside this document when available.
No Playwright or Convex platform execution was performed locally.

The design follows [Stryker's mutation-testing model](https://stryker-mutator.io/docs/)
and distinguishes [mutant states](https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/).
Unlike Stryker's mutation score, the owner requires unavailable work and timeouts
to remain failures in the recall denominator. They are never credited as kills.
[Playwright's JSON reporter](https://playwright.dev/docs/test-reporters#json-reporter)
provides execution counts and attachments. [Convex's preview deployment guidance](https://docs.convex.dev/production/multiple-deployments)
and [deploy CLI reference](https://docs.convex.dev/cli/reference/deploy)
support fresh named previews; `--preview-create` refuses non-preview credentials.
