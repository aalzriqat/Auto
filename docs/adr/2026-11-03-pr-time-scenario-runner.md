# PR-time execution of the regression library's backend scenarios

Status: accepted for the advisory job. Required-check promotion is a separate owner decision. SCRUM-761 R3, SCRUM-760.

## Context

`regression/scenarios/**.scenario.json` records each scenario and binds it to a test (`impl.file`, `impl.testName`).
`pnpm test:regression-library` validates the records, and `scripts/regression/runLocalExecution.mjs` observes one
scenario at a time from a clean export of HEAD. Nothing yet proves, on every PR, that each bound test exists and
passes. The `unit-and-integration` slices run the same files, but they never tie a result back to a record, so a
renamed, skipped or deleted bound test would leave a record that checks nothing.

## Decision

`scripts/regression/prRunner.mjs` selects every `active` record at level `backend` and runs the bound files in one
Vitest invocation (`--maxWorkers=1 --no-file-parallelism --retry=0`, JSON reporter,
[Vitest reporters](https://vitest.dev/guide/reporters#json-reporter)). Each record gets one verdict from the executed
tests: `PASS` only when exactly one test with that exact title ran in that file and passed. Every other outcome fails:
no binding, bound file missing, file not executed, file failed to load, test not found, title found twice, skipped or
todo, failed. A non-zero Vitest exit, a missing report, an unreadable record, zero selected records and any active
`cloud` record (no runner until SCRUM-762) also fail the run.

Output is counts, failure codes and scenario ids. It never prints test titles, file paths or error text, because the
repository and its Actions logs are public. The same text goes to the job summary.

The CI job `PR scenario runner` in `.github/workflows/scenario-runner.yml` runs on pull requests. It installs
dependencies, executes the static Playwright projects, and runs the judge with their JSON reports. Backend bindings
use `convex-test`. The static projects need no Convex deployment or credentials. The job is advisory.

## Browser execution and report policy

At PR time, a browser record is selected when a changed file matches its `sourceGlobs` or its bound spec changed.
Other mapped browser records are counted as `notRequiredAtPrTime`. Missing screen mappings fail validation. An
unreadable PR diff selects every mapped browser record and fails the run.

The PR workflow executes `playwright.visual.config.ts` and `playwright.opening.visual.config.ts`. These collect the
static visual specs, role page controls, audit navigation and bill-of-sale capture fixtures, and opening allocation
and commission visuals. The judge joins selected records to those executions by physical file, exact leaf title,
config, project and suite title path. It requires exactly one passing attempt at retry zero for every collected
execution. The two opening visuals are collected by both configs, so both configs' executions must be present.
JSON reports are consistency-checked evidence, not authenticated attestations.

`PLAYWRIGHT_REQUIRED_REPORTS`, beside `PLAYWRIGHT_CONFIGS` in the judge, owns the required labels:

| Tier | Required labels |
| --- | --- |
| PR | `visual`, `opening-visual` |
| Full (nightly and release) | `tests`, `visual`, `opening-visual`, `scenarios`, `opening-proof` |

Workflow tests compare the labels each workflow passes to this table. Missing evidence must not reduce the
execution obligations. An otherwise passing browser join refuses with `PLAYWRIGHT_REQUIRED_REPORT_MISSING` when
any required label is absent. Every existing refusal takes precedence, including missing execution, invalid or
duplicate results, report errors, unsafe flags, discovery failures and collection mismatches. Multiple report files
for one label remain supported when their executions are disjoint and their union is complete. Repeating a label
does not substitute for another required label. Backend-only invocations without selected browser records retain
their existing behavior.

The fixed tier policy matches the execution scope of each workflow. Deriving configs from selected bindings would
need a separate binding-to-config policy and could make static PRs depend on backend-backed configs. PRs omit
`tests`, `scenarios` and `opening-proof`: their execution depends on the app, authentication and a backend. This
change does not run those authenticated workflows at PR time or certify their absence as success. A caller that
supplies one of those labels in the PR tier is refused with `PLAYWRIGHT_CONFIG_MISMATCH` before that config is
listed. Each tier lists only labels admitted by its policy table. Newly forbidden PR arguments no longer reach
deeper discovery or inventory diagnostics because their configs are not loaded.

The judge obtains its own native Playwright listings for supplied config labels with `--list --reporter=json` and
one worker. Listing does not execute the tests. Discovery refusals are `PLAYWRIGHT_DISCOVERY_FAILED` (subprocess or
JSON-read failure), `PLAYWRIGHT_INVENTORY_INVALID` (invalid inventory), and `PLAYWRIGHT_INVENTORY_EMPTY` (no collected
tests). These are distinct from `PLAYWRIGHT_CONFIG_MISMATCH`, which rejects a wrong label/config identity or
inconsistent config declarations. See the [Playwright CLI](https://playwright.dev/docs/test-cli),
[projects](https://playwright.dev/docs/test-projects), and [JSON reporter](https://playwright.dev/docs/test-reporters#json-reporter).

## Reuse

- Records, validator and ruling snapshot: `scripts/regression/scenarioRecord.ts`, unchanged. The runner reads the JSON
  directly because Node cannot resolve that file's extensionless imports without a loader.
- `runLocalExecution.mjs` (merged in #681 and its follow-ups): kept as the single-scenario, clean-export observer. It is
  too heavy to run for hundreds of records (one export and one Vitest process each), so it is not wired into the PR job.
- Unmerged branches: `codex/scrum761-local-execution` differs from main only by being behind it; the work it carries is
  already on main. `claude/scrum-761-s3-pilot-path` and the other `claude/scrum-761-*` branches carry records that
  `main` already holds. Nothing from them is needed.

## Selection by level, not by domain

The runner selects by level (`backend`), not by domain. Every active backend record is a money, permission, tenancy or backend-level screen record, and all of them are bound to a test that runs under `convex-test` or jsdom in about ten minutes in total, so filtering by domain would only drop checks. Test titles are matched on the leaf title exactly, as `regression/README.md` requires; the same title in two `describe` blocks of one file is `TEST_AMBIGUOUS` (fail-closed).

The discarded Vitest console output is not printed: it carries test titles, file paths and assertion text, and the Actions log is public. Only the summary is printed.

## Not covered, stated plainly

- Selected browser bindings absent from the supplied reports still fail with `BROWSER_REPLAY_NOT_EXECUTED`.
  When reports are supplied, PR-tier records bound to `playwright/tests/audit-role-access.spec.ts` instead fail with
  `ROLE_AUDIT_EVIDENCE_NOT_JOINED`. That role matrix runs in its separate workflow and its encrypted evidence is not
  joined here. The same limitation applies to the full tier. A PR invocation without reports retains the generic
  `BROWSER_REPLAY_NOT_EXECUTED` fallback and its existing SCRUM-762 summary issue. Static report intake does not
  establish authenticated replay coverage or complete SCRUM-762.
- The JSON reporter does not expose `test.fails`. An expected-failure test would report `passed`; the record validator
  refuses it statically, and the runner relies on that.
- Execution is local convex-test, serial. It is not platform or production certification.

## Consequences

The bound test files run twice on a PR (once in `unit-and-integration`, once here). The second run is limited to the
bound files and starts no cloud service, so it adds runner time but no Convex I/O.
