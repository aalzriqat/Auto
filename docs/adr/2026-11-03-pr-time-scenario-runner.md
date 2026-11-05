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
dependencies and runs the runner; it needs no Convex deployment, because the bound tests use `convex-test`. It is not
a required check.

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

- Browser-level records follow SCRUM-760 item 3: at PR time a record is required only when the PR touches its screen (a changed file matches the record's `sourceGlobs`, or its own bound spec changed); the rest belong to the nightly and release runs and are counted as `notRequiredAtPrTime`. A required record cannot be executed here (it needs a browser and a backend, SCRUM-762), so it FAILS with `BROWSER_REPLAY_NOT_EXECUTED` and the summary names the reason. The job is therefore red for a PR that touches such a screen until SCRUM-762 lands. Records with no `sourceGlobs` (38 of 49 at 2026-11-03) cannot be mapped to a screen; they are reported as `unmappedToAScreen`, not guessed. Mapping them is follow-up work. If the PR diff cannot be read, every active browser record counts as selected and the run fails.
- The JSON reporter does not expose `test.fails`. An expected-failure test would report `passed`; the record validator
  refuses it statically, and the runner relies on that.
- Execution is local convex-test, serial. It is not platform or production certification.

## Consequences

The bound test files run twice on a PR (once in `unit-and-integration`, once here). The second run is limited to the
bound files and starts no cloud service, so it adds runner time but no Convex I/O.
