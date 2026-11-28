// sha256 of each workflow that can reach a Convex credential.
export const CREDENTIAL_WORKFLOW_PINS: Record<string, string> = {
  // SCRUM-826: re-pinned for two prepare-job steps only — the trusted
  // pre-provisioning coverage gate (`pnpm browser-swarm:coverage-gate` in
  // `trusted/`, no secrets, no candidate path) and the upload of its refusal
  // evidence — plus the coverage json in the plan evidence upload.
  // SCRUM-777: re-pinned for the swarm's own concurrency group (no longer the
  // Playwright group) and three `contents: read` live-head checks: in prepare
  // before the preview is created, in trusted-e2e before it deploys over the
  // preview, and in attack-worker before the missions. None of them touches a
  // Convex credential or a candidate path.
  // SCRUM-350 G4 / SCRUM-411: also re-pinned for the swarm accounting period
  // setup in trusted-e2e — the same trusted spec (`playwright test` of one
  // trusted spec, no secret, no candidate path) run twice, once before the full
  // E2E suite and once after it — plus both runs' report and results folders
  // in the E2E report upload. The steps are named for what they measure (open
  // the period, drain the pending outbox); they do not claim a later posting
  // will settle.
  // #650: re-pinned for two guards only — the prepare job stops before it claims
  // the preview, and the scrub step before it changes it, when the preview's
  // cleanup pin was not recorded. No new secret, trigger or candidate path.
  "browser-attack-swarm.yml":
    // SCRUM-858 B672-2: owner-authorized independent opening Preview, matching
    // URL-baked build and strict cleanup-gated verdict. Canonical credential
    // commands and negative controls remain unchanged; final source reviews bind this hash.
    // Minor closure: existing bounded creation backoff and cancellation-aware opening admission only.
    // SCRUM-757: counted authenticated PR-head verdict, default-branch-only
    // publishers and a secret-free source archive replace privileged candidate
    // checkouts. Canonical deploy/audit commands and their tamper tests remain.
    // SCRUM-757 follow-up: preview-cleanup `needs` now lists the three new
    // jobs (e2e-gate-begin, candidate-source, e2e-gate-finish) so the
    // disposable preview is deleted only after every other job (SCRUM-377).
    // A `needs` list only; no step, secret or checkout changed.
    // Sonar S7631 follow-up: e2e-gate-begin, candidate-source and e2e-gate-finish
    // gain the same-repository `head_repository.full_name == github.repository`
    // job condition, so a fork's workflow_run skips them. This only NARROWS where
    // those jobs run; no step, secret, permission or checkout ref changed. Fork
    // PRs are judged by the pull_request_target admission workflow instead.
    // SCRUM-757 review remediation (PR #704, Seat 1 F2/F3/F4, Seat 2 P1/P2).
    // NOT yet reviewed by an independent seat; read the hunks. Hunks: (1) the gate
    // concurrency group keys on workflow_run.head_sha, not pull_requests[0];
    // (2) e2e-gate-begin gains `actions: read` (origin proof); (3) prepare gains
    // `needs: e2e-gate-begin` and `checks: read`; candidate-source, candidate-build
    // and trusted-e2e gain `checks: read` only (never write); (4) each of those
    // four runs a first `trustedPrE2eGateCli.mjs armed` step that refuses to start
    // while a success stands; candidate-source also checks out the immutable
    // workflow revision as `trusted` for that step; (5) e2e-gate-finish gains a
    // `reset` step before its evidence download. No secret, credential command or
    // candidate checkout ref changed. Previous: 118099 bytes (LF), pin aa713e3d;
    // new: 121298 bytes (LF), pin below.
    // SCRUM-892: the swarm leaves cloud Convex previews for a runner-local
    // self-hosted backend in each backend-owning job (trusted-e2e,
    // attack-worker, opening-proof). Hunks: (1) every CONVEX_PREVIEW_DEPLOY_KEY
    // reference, the preview create/pin/resolve/scrub steps and the
    // opening-prepare/opening-build/opening-cleanup/preview-cleanup jobs are
    // removed, so the workflow holds no `secrets.CONVEX_*` at all; (2) the
    // backend is started, configured and marked by the trusted
    // `scripts/localConvexBackend.mjs` (admin key minted at run time, masked
    // before it is written to GITHUB_ENV, backend stopped by an always() step);
    // (3) the staged deploy keeps its exact container hardening and mounts and
    // joins ONLY the backend container's network namespace
    // (LOCAL_STAGED_DEPLOY_COMMAND above); (4) workers and the opening proof
    // consume candidate-source and the one candidate-build. The workflow is
    // still pinned because the local admin key is classified as a credential
    // (LOCAL_BACKEND_KEY). NOT yet reviewed by an independent seat.
    // PR #757 round 5: re-pinned for the tripwire only. `mark` and the new
    // `verify` step get the two public env-plan inputs (the pk_test key and the
    // loopback app URL; no admin key, no other secret), `verify` runs right
    // before the backend stops, and the deploy comment no longer claims the key
    // is out of candidate reach. No trigger, checkout or candidate path changed.
    // PR #757 round 8: re-pinned for shell comments only. The three deploy
    // steps' network comment no longer claims nothing else on the runner is
    // reachable: it discloses bridge reachability. Every changed line is a `#`
    // comment inside `run:`; no command, env, trigger or checkout changed.
    // SCRUM-762 / PR #831: the existing trusted runner uses the QA attestation
    // credentials for selected explorer walks against the isolated candidate.
    // Chromium has a separate launch environment. Candidate container env,
    // egress proof, backend tripwire and token permissions keep their controls.
    // Raw explorer reports remain on the runner. The G5 publisher receives the
    // immutable artifact ID under its existing Actions read permission.
    // SCRUM-762 candidate role evidence adds six separate workers. They share
    // the pinned staged deploy and candidate runtime steps, authenticate on
    // main and publish encrypted reports plus a bounded public summary.
    // SCRUM-762: run the three existing sourced witnesses in the contained, exact-candidate suite.
    // SCRUM-762 / PR #833: the existing explorer step runs after discovery
    // and before organization-creating suite journeys. Its command, environment
    // and strict attestation are unchanged; evidence directories are created first.
    // SCRUM-877: carry the native job ID only in the protected publish step.
    "f3e5679d0db586638eabb1417b3552573c091771419945646e22347cfa035c08",
  "contract-skew.yml":
    // SCRUM-866: reviewed native-render step executes checked-out main before
    // the secret-bearing comparison, without a credential env. Triggers,
    // environment policy, checkout and credential-through-env remain unchanged.
    // Both comparison branches pass --current only when the complete render
    // exists; failed/timed-out output is deleted. Artifact also retains it.
    // Advisory Standards review inspected this boundary; no seat is claimed.
    // SCRUM-866 Sonar remediation removes only --experimental-vm-modules
    // from the credential-free render step's NODE_OPTIONS. Each runtime world
    // now imports emitted ESM in a child process with an empty environment and
    // a fixed 256 MiB heap. The parent retains its 6144 MiB cap. No trigger,
    // grant, checkout, credential step, timeout or output path changed.
    // SCRUM-873 baseline shards: only two message strings change (the exit-10
    // annotation and the failure-issue body now name the baseline shards).
    // No trigger, grant, checkout, credential step, timeout or output path changed.
    "a85c50d0de39a660a9e5ffb69b2a6669b13afcd410b13e3a59cde71f0461243b",
  "deal-scenarios-e2e.yml":
    // SCRUM-616/617: the reviewed change opts into the cross-screen oracle.
    // SCRUM-760 G8: job timeout 120 -> 180 minutes for the larger deals/sales
    // hunt library. Nothing else in the workflow changed: still main-only, same
    // steps, secrets, permissions and checkouts.
    "2f1d2e3816f6927ec6d7cde133d044223a9a13029e6bfa63a845f30ffe7f9db8",
  // SCRUM-616: main-only; SCRUM-892: each role job runs a local self-hosted
  // backend, with no cloud preview or credential. This whole-workflow pin keeps
  // its triggers, credentials, deploy and cleanup inside the review.
  "pilot-role-audit.yml":
    // SCRUM-892: re-pinned for the local backend: the cloud preview create, pin
    // and delete steps and the preview deploy key are gone; each role job starts,
    // marks, verifies and stops its own runner-local backend. Triggers and
    // permissions are unchanged.
    // Previous pin d3fdaa32ecd1da4412a636bf8d0a2b36636fafb13ff96ed0aaa41a947e4bad8d.
    // Previous pin d8fdcec7304c4c8e92da8251f220bd57914b78064148445dcd42dd9c1834cae6 (verify's if was conditional).
    "c6e255670342aabb42ff1c6d47e195da637ac2fde3e81fcec8e9ee2337de7cf1",
  "hunt-preview.yml":
    "cd526cad1f393adedc440a324e436b67e18804a7846df626f37c27b91f02f0ee",
  "prune-convex-previews.yml":
    "a47a5289bc35c018cbb378d68d7b0d389f3f78774272d4ada03f64eb4197f54d",
  // SCRUM-761 R3: nightly and release full-library run on the runner-local backend
  // (start, env, deploy, mark, seed, browser projects, verify, stop). No preview and
  // no Convex cloud credential; pinned in regressionLibraryWorkflow.test.ts.
  // F3/F4 review remediation: publish only the counts/codes/ids summary; move
  // static visuals after the browser under !cancelled(). Credential steps,
  // grants and exact always() verify/stop/judge are unchanged and deep-equal pinned.
  // Restore only the credential-free static config's outputDir upload under
  // always(), with 14-day retention. Raw backend-backed reports stay private to
  // the runner; no credential step, grant or tripwire change.
  // SCRUM-761 lane 761c: each of the five Playwright runs is preceded by its own
  // `--list --reporter=json` collection, and the judge step receives the five
  // inventories. No credential step, grant, trigger or tripwire change.
  // Previous pin ec9b121da9e2bde3bc368631614749b6fb7c118690fb4693329fce7ec9622d52.
  // SCRUM-761d: the judge owns discovery; supplied inventory steps/arguments are removed.
  // Previous pin 4ea2cee021fa279d8140c5ebb8bd04067ded98420f1abc54c340286583f4e4ac.
  "regression-library.yml":
    "14c5a2390fbfe4c57c6a67b106185ec20fac8ed4daa562e92bfd0c686685b661",
  "convex-preview-key-diagnostic.yml":
    "cb33b1b8f2e26457d00f78f31b6460e14df19b2b6f8254e720ca097a8c66dd8c",
  // SCRUM-1026 PR B: self-hosted release target (target selector step, a
  // self-hosted gate/deploy/zero-state/rollout beside the unchanged cloud steps).
  // Previous pin 61789e5b96d2a5e5e9b41be44fcf2afccf9bd372865e3c39a1154cb3788edde2.
  // Review round 1: the self-hosted deploy step runs
  // `node scripts/assertSelfHostedDeployEnv.mjs` first (the Convex CLI does not
  // refuse a cloud key beside the self-hosted pair). Cloud steps unchanged.
  // Round-0 pin e55bc28523678c67a3be2d240b19cd59209df258cacfdb6ae1a1aaf3d700da8b.
  "deploy-production.yml":
    "af2a043a4ec175b71910507a3914e773bae0f5e63302110b77e97d00e9790c1f",
  // SCRUM-883: PR-only trusted Git path gate before provisioning, neutral
  // NOT_APPLICABLE check and gate evidence. Credential commands, provenance,
  // staged deployment and exact-SHA release verdict remain unchanged.
  // Round 3 adds only TESTED_SHA (the provenance merge) to the path-gate step env, with no secret.
  // SCRUM-892 option A: the pull-request path runs on the runner-local backend
  // (start, staged deploy, mark, cases, verify, stop) and creates no preview;
  // the cloud steps run only for repository_dispatch, their bodies unchanged.
  // SCRUM-892 c24441: the release runs the same local lifecycle; every cloud
  // step and the preview credential are gone. The release refusals (preflight,
  // provenance, release verdict) stay byte-identical, pinned in
  // trustedAccountingRehearsalReleasePath.test.ts. PR #760 round 3: verify runs
  // under always() plus the run condition, so a missing baseline refuses.
  "trusted-accounting-rehearsal.yml":
    "3c288c65ca0c64d48a5ac8c8f6fdf650d23533ba4cf4e09b3177c8d3ad114bad",
  // SCRUM-976: manual main-only timing for ordinary Explorer journeys. Each
  // shard owns a disposable loopback backend and emits only timing and census.
  "explorer-shard-benchmark.yml":
    "15d950efb4958f65e0e64a2854a168b44b2d0b5b8d609f88ca6802b157d601b4",
  // SCRUM-860: reviewed addition of the role frame census before preview
  // provisioning, with no step secrets. All credential steps, preview targeting,
  // cleanup and canonical-command/tamper controls remain pinned unchanged.
  "trusted-main-e2e.yml":
    // SCRUM-892 (owner ruling c24441): the Convex cloud preview, its preview deploy
    // key and its create/pin/delete steps are removed; the one `playwright` job
    // starts, deploys to, marks, verifies and stops a per-job local backend through
    // scripts/localConvexBackend.mjs. The job id, name, triggers, main-only `if`,
    // concurrency and permissions are unchanged (trustedMainE2eWorkflow.test.ts).
    // The suite step gains the AUTOFLOW_LOCAL_CONVEX_CI switch. No trigger, grant,
    // checkout or secret other than the Clerk keys the suite already read.
    // Verify now runs exactly always(), so a missing baseline refuses (#760 round 3).
    // Previous pin 3ff3286a70bdbaffe6a228184f7c1933c4c9c111b08925c9bee2b3412709c437.
    "4022cb739d446ac59dc204737ebbc5eb1bf08dda9c586b9a079ed754a016baa1",
  // SCRUM-1005: advisory Bombadil explorer of the signed-out pages (main, nightly,
  // manual; no pull_request trigger). The explorer step blanks the local admin key
  // and holds no secret; only the app step reads the two Clerk values.
  "bombadil-explorer.yml":
    "b90bd209372a11c6cb2b87d6901341abb3679cae7fe7a9ce3aace2128ff9c2f8",
};
