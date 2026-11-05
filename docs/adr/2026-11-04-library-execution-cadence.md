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

Every active browser record must have non-empty `sourceGlobs`. The record validator rejects missing mappings, and the
runner independently fails them with `BROWSER_SCREEN_MAPPING_MISSING`, including in the full tier. An unmapped record
cannot be counted as unrelated to a PR. The 38 mappings added after seat review follow these executed surfaces:

| Records | Mapping source |
| --- | --- |
| `g8-explorer-*` (12) | `jev-explorer.spec.ts` follows navigation links after its start. All app routes and components are in scope, plus `lib/navigation.ts` and `pilotHunt.ts`; mapping just the start route would be false. |
| `role-routes-mount-after-authority` | `SCREEN_AUDIT_ROUTES` spans the dashboard route matrix, so app routes, components, navigation and that route fixture are in scope. |
| `g8-accounting-workspace-traversal` | Accounting route, accounting, collections and deposit components, from `PILOT_ACCOUNTING_VIEWS`. |
| `g8-deals-list-to-detail`, delivery records, Sales entry and picker records | The visited Sales wizard, Deals list and deal detail routes, with their sales, cockpit, deposit, vehicle or customer components. |
| `role-pr-*`, lead and approval authority records | The particular route and components mounted by `RoleAccessVisualFixture.test.tsx` or visited by `audit-role-access.spec.ts`. Shared paint dependencies include CSS, UI, auth and provider components. |
| `phone-audit-*` (4) | Synthetic DOM checks exercise `playwright/role-audit/readiness.ts`; they do not visit an app screen. Their mapping names that helper. |

No active browser record remains without a derivable mapping. Broad navigation walks intentionally have broader mappings
than fixed-screen records. Mappings describe impact selection, not proof that a replay executed.

The 12 `g8-explorer-*` records and the opted-in cross-screen oracle share `formExplorer/attestedPreview.ts`. For the exact
`http://127.0.0.1:3210` backend, `AUTOFLOW_LOCAL_CONVEX_CI=1` permits an attestation attempt without a cloud preview name.
It never substitutes for proof: `assertExistingE2EPreview` still checks the self-hosted credential pair, rejects cloud
credentials, and asks the backend to attest its disposable marker, identity and seeded Clerk/QA organization. Cloud
previews still need their name and the same bootstrap proof. Each browser must observe the matching Convex websocket,
stay on the local app and open that QA organization. The random explorer now uses this shared guard instead of a second,
cloud-only implementation. Attestation failures expose a code, not subprocess diagnostics.

Browser verdicts: PASS only when every execution of the bound title (one per project that collects the file) has status
`expected`. No execution is `BROWSER_REPLAY_NOT_EXECUTED`; `skipped` is `TEST_SKIPPED`; `unexpected` is `TEST_FAILED`; `flaky`
(passed only on a retry) is `TEST_FLAKY`, so a first-attempt failure is never hidden by the CI retry. A missing or
unreadable report, an active cloud record and a `candidate` record (a parked scenario nobody runs) each fail the run.

Release wiring: the dispatch step refuses unless `commit_sha` is a full SHA equal to the workflow's SHA and to main's live tip.
The job is named `regression-library`; it is not yet in `.github/release-waivers.json`'s required set (see Not done).

The tripwire is guarded the way `reference_tripwire_test_pin_whole_span_not_keys` requires: `scripts/regressionLibraryWorkflow.test.ts`
deep-equals every step of the job (so count, order and env are pinned), pins workflow- and job-level env to nothing, uses strict
schemas, and requires `verify`, `stop` and the judge to run exactly `if: always()`. Each browser command group accumulates
red configs (`|| status=1`, then `exit`) instead of `continue-on-error`, which the test forbids. Static visuals run after
the backend-backed projects under `if: ${{ !cancelled() }}`. A red snapshot cannot suppress those earlier browser runs,
and a red backend-backed config cannot suppress the later static visuals. This follows
[GitHub's status-function guidance](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#status-check-functions):
an omitted status condition defaults to `success()`; `!cancelled()` permits independent work after failure.

## Not done, stated plainly

- **Never run in CI yet.** `workflow_dispatch` from a branch is refused by the main-only guard, so the first real run is
  after merge. Until it has run, treat the nightly's pass/fail as unproven. The five Playwright commands are copied from
  `trusted-main-e2e.yml`, `deal-scenarios-e2e.yml` and the opening proof; running them on one shared backend is untested.
- **Explorer/oracle local runtime remains unverified.** The prior guaranteed refusal on a local backend is fixed at the
  shared guard and covered by unit controls plus the existing bootstrap-target tests. No browser was run locally during
  remediation. The first full CI run must demonstrate all 12 explorer records and `CROSS_SCREEN_ORACLE=1` executing on
  the shared local backend; unit tests do not establish that browser result.
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
- **Public artifacts contain only the verdict summary.** The runner's counts, codes and scenario ids upload for 14 days.
  Raw Playwright JSON, console/error text, attachment bodies and visual artifacts stay on the disposable runner.
  [GitHub artifact access](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)
  extends to signed-in readers of this public repository; it is not a private diagnostics channel.
- The library has `level: "cloud"` records only if SCRUM-762 defines a runner; the validator refuses active ones today.

## Reuse

`scripts/localConvexBackend.mjs` (start, env, mark, verify, stop), `scripts/e2ePreviewBootstrap.mjs`, the existing
Playwright configs, and the PR-time runner. No new registry, no new test level.
