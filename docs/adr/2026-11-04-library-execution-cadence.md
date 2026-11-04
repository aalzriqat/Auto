# Regression library execution cadence: PR, nightly, release

Status: accepted for advisory jobs. Making any of them a required check is a separate owner decision. SCRUM-761 R3, SCRUM-760 item 3, SCRUM-892.

## Context

SCRUM-760 item 3 sets the cadence: a pull request runs the money and permission scenarios and the replays of the screens it
touches; nightly runs the full library; a release runs the full library against a real backend. A scenario that cannot run
is a failure, never a skip. SCRUM-892 (owner ruling c24441) says every trusted workflow gives itself a per-job runner-local
Convex backend through the `mark`/`verify` tripwire and never uses a cloud preview, because previews consume the Convex I/O quota.

## Decision

| Cadence | Workflow | What runs | Backend |
| --- | --- | --- | --- |
| Pull request | `scenario-runner.yml` | every active backend record at its bound test; browser records only for screens the PR touches (a touched screen fails, because a browser replay cannot run there) | none (`convex-test`) |
| Nightly | `regression-library.yml` (schedule, 02:30 UTC) | every active record | runner-local Convex, `mark`/`verify` |
| Release | `regression-library.yml` (`repository_dispatch` `autoflow-release-regression-library`, `client_payload.commit_sha` = main's full tip) | every active record at that SHA | runner-local Convex, `mark`/`verify` |

One runner, `scripts/regression/prRunner.mjs`, serves all three. `--tier pr` is the default. `--tier full` requires every
active record: backend records run in one serial Vitest invocation, and browser records are judged from the Playwright JSON
reports ([JSON reporter](https://playwright.dev/docs/test-reporters#json-reporter)) that the same job produced.

Browser verdicts: PASS only when every execution of the bound title (one per project that collects the file) has status
`expected`. No execution is `BROWSER_REPLAY_NOT_EXECUTED`; `skipped` is `TEST_SKIPPED`; `unexpected` is `TEST_FAILED`; `flaky`
(passed only on a retry) is `TEST_FLAKY`, so a first-attempt failure is never hidden by the CI retry. A missing or
unreadable report, an active cloud record and a `candidate` record (a parked scenario nobody runs) each fail the run.

Release wiring: the dispatch step refuses unless `commit_sha` is a full SHA equal to the workflow's SHA and to main's live tip.
The job is named `regression-library`; it is not yet in `.github/release-waivers.json`'s required set (see Not done).

The tripwire is guarded the way `reference_tripwire_test_pin_whole_span_not_keys` requires: `scripts/regressionLibraryWorkflow.test.ts`
deep-equals every step of the job (so count, order and env are pinned), pins workflow- and job-level env to nothing, uses strict
schemas, and requires `verify` to run exactly `if: always()`. The browser steps tolerate a red config (`|| status=1`, then
`exit`) inside one step instead of `continue-on-error`, which the test forbids.

## Not done, stated plainly

- **Never run in CI yet.** `workflow_dispatch` from a branch is refused by the main-only guard, so the first real run is
  after merge. Until it has run, treat the nightly's pass/fail as unproven. The five Playwright commands are copied from
  `trusted-main-e2e.yml`, `deal-scenarios-e2e.yml` and the opening proof; running them on one shared backend is untested.
- **Role-fixture records fail by design.** Records bound to `playwright/tests/audit-role-access.spec.ts` need the attested
  exact-role runner (`pilot-role-audit.yml`, encrypted evidence). They have no report here and fail
  `ROLE_AUDIT_EVIDENCE_NOT_JOINED` (7 records today) until that evidence is joined or those specs are folded into this
  job. The code names the reason, so the failure is a recorded gap and not a mystery. It is not a skip, and the nightly
  stays red until the SCRUM-761 follow-up lands. The 10 records bound to `role-access.visual.spec.ts` are not affected: the
  static visual step runs them.
- **No legacy manual-journal seed.** `E2E_SEED_LEGACY_MANUAL_JOURNAL` (SCRUM-795) is requested only by `trusted-main-e2e.yml`;
  `legacyManualJournalSeedScope.test.ts` fails any other workflow that names it, and its allowlist is unchanged. The
  approve-door test in `accounting.spec.ts` is therefore not registered here. No library record binds that file today
  (checked: zero records name it), so no verdict depends on it. A record added later for that test fails
  `BROWSER_REPLAY_NOT_EXECUTED`, never skips.
- **Not a required check**, and not in the release guard. Requiring `regression-library` at release changes the release
  policy and needs the owner. Until then the release dispatch produces a result nobody enforces.
- **Fresh hunt.** The nightly runs the recorded library. Appending new scenarios from a fresh explorer hunt is the swarm
  workflows' job (`browser-attack-swarm.yml`, SCRUM-376); `JEV_FORM_EXPLORER` is off here.
- **Other cloud-preview workflows remain.** `deal-scenarios-e2e.yml` (nightly 01:00) still creates a cloud preview. It overlaps
  this workflow's scenario matrix and should move to the local backend or be retired once this one is proven.
- **Reports are public.** Playwright JSON reports upload as 14-day artifacts, as `trusted-main-e2e.yml` already does.
- The library has `level: "cloud"` records only if SCRUM-762 defines a runner; the validator refuses active ones today.

## Reuse

`scripts/localConvexBackend.mjs` (start, env, mark, verify, stop), `scripts/e2ePreviewBootstrap.mjs`, the existing
Playwright configs, and the PR-time runner. No new registry, no new test level.
