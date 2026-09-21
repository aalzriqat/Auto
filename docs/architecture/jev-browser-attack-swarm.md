# Jev-Directed Browser Adversarial Release Swarm

SCRUM-350 adds a bounded, parallel browser adversarial release harness for AutoFlow preview releases.

The swarm is an exploration and evidence system. It is not a correctness authority.

## Governing rule

Required browser missions are the union of deterministic invariant obligations and Jev suggestions:

```text
required browser missions
  = deterministic invariant missions
    ∪ Jev-suggested missions
```

Jev may add exploration. It may never remove, satisfy, downgrade, or replace deterministic missions.

If the configured mission budget cannot fit the deterministic set, planning fails closed instead of dropping required attacks.

## Correctness authority

A browser agent does not decide whether AutoFlow is correct.

Every mission declares a deterministic oracle such as:

- tenant isolation;
- backend authorization;
- one-intent / one-economic-effect idempotency;
- lifecycle state-transition truth;
- reversal and reconciliation state;
- economic/backend authority;
- list completeness; or
- UI/backend authority parity.

Model suspicion can route a trace for deeper review. It cannot produce PASS or CONFIRMED_BREACH by itself.

A confirmed breach requires a deterministic oracle failure and later a reproducible failing-first regression test.

Harness failures are recorded separately from product breaches.

## Trusted controller boundary

The authoritative swarm is a default-branch `workflow_run` workflow. Candidate code cannot redefine the controller that evaluates the same pull request.

The control plane is bound to immutable and independently verified inputs:

1. The trusted controller checkout is pinned to `${{ github.workflow_sha }}`, not moving `main`.
2. Mandatory invariant impact is derived by trusted code from exact base + source-head Git state using the canonical `jevImpact.mjs` mapper.
3. The pull-request Playwright workflow is a secretless preflight. It runs static browser validation and produces an identity-only descriptor containing only the deterministic preview name, PR number, and exact source-head SHA.
4. That preflight contains no `secrets.*` references. The descriptor contains no Convex URL, deploy credential, Clerk secret, or reusable E2E identity material.
5. The trusted workflow independently recreates and resolves the deterministic preview through Convex's control plane and records the resulting deployment URL as trusted evidence.
6. The trusted workflow fetches GitHub's `refs/pull/<pr>/head` and `refs/pull/<pr>/merge` refs itself.
7. The merge ref is accepted only when it has exactly two parents: the expected trusted base SHA followed by the expected source-head SHA.
8. Full authenticated E2E and adversarial browser execution both check out that validated merge commit as candidate application code, while their controller and test code comes from the immutable trusted workflow revision.

The candidate descriptor is untrusted data. It is size-bounded, archive-shape-checked, parsed by trusted code, and cannot supply backend authority.

## Convex preview authority

The preview URL is not accepted from candidate code.

The trusted controller derives the expected `e2e-*` preview name from the PR number, parses the repository's preview deploy key only to identify its team/project authority, and calls Convex's fixed control-plane endpoint for that named preview.

The trusted resolver:

- uses the project-wide preview deploy key only inside trusted controller execution;
- accepts only a preview deployment response;
- accepts only a bare `https://*.convex.cloud` origin;
- applies a bounded request timeout and response-size limit;
- rejects redirects;
- writes a sanitized authority artifact containing preview name, deployment name, and deployment URL; and
- never persists the deployment admin key returned by the control plane.

Before candidate backend code is deployed, trusted main converts that response into the deployment-scoped `preview:<deploymentName>|...` credential, scrubs the disposable preview environment to an explicit allowlist, overwrites Turnstile with Cloudflare's public always-pass test secret, and verifies the final environment-name set exactly. Candidate backend code therefore receives authority over that disposable preview only. Candidate frontend code receives public configuration only. The project-wide preview deploy key is never passed into a candidate process.

## Clerk authentication boundary

Reusable E2E passwords are entered only against the immutable trusted-controller frontend.

The resulting browser storage state is then reused by the trusted Playwright controller when driving the candidate frontend with `--no-deps`; candidate code is never given the login passwords or verification code.

The candidate server retains its real Clerk middleware. Instead of deleting middleware or supplying `CLERK_SECRET_KEY`, the trusted controller derives Clerk's public JWT verification key and passes only `CLERK_JWT_KEY` to candidate build/runtime.

The trusted controller requires a development/test-instance Clerk publishable key before deriving public JWT verification material. Reusable Clerk secrets and E2E passwords exist only in trusted-main steps and are never passed to candidate containers or retyped into candidate DOM.

This boundary is designed so same-repository pull-request code does not execute with reusable repository credentials. Candidate code can observe its own disposable preview state and public test configuration, but it does not receive project-wide Convex authority, Clerk secret keys, reusable E2E passwords, or GitHub write tokens.

## Phase A — deterministic preview attack harness

Initial control plane:

1. Map impacted invariant IDs to mandatory browser attack families.
2. Add bounded Jev suggestions only after mandatory missions are admitted.
3. Partition missions across at most eight workers.
4. Bind every worker plan to one explicit disposable preview identity.
5. Require the existing SCRUM-143 disposable-preview marker and deployment assertion before browser execution.
6. Store sanitized worker evidence under isolated per-run/per-worker artifact roots.
7. Classify outcomes from deterministic oracles only.

Planned attack-family vocabulary:

- tenant escape;
- authorization abuse;
- duplicate submit;
- stale UI;
- lifecycle reversal;
- sourced/consignment economics;
- finance reordering;
- money boundaries;
- navigation races;
- network interruption/recovery;
- multi-tab races;
- completeness/pagination boundaries;
- RTL parity; and
- optimistic UI/backend authority mismatch.

The vocabulary is broader than the current executable registry. In the present Phase A slice, only `RTL_PARITY` and `UI_BACKEND_MISMATCH` have real browser handlers. A plan containing any other family is refused before manifest creation; it is never allowed to degrade later into a runtime `HARNESS_ERROR`. Adding a new family therefore requires adding its handler and expanding the executable-family registry in the same reviewed change.

## Preview and candidate isolation

The swarm reuses the existing E2E preview bootstrap safety model. It does not invent a competing production/customer-data selector.

A trusted run manifest carries:

- a safe run ID;
- one explicit `e2e-*` preview name;
- the independently resolved Convex cloud URL;
- `requiresPreviewMarker: true`;
- the exact tested merge SHA;
- isolated worker IDs and artifact roots; and
- the bounded mission partition.

The trusted controller performs the existing SCRUM-143 preview assertion before candidate browser execution and exports only a one-bit pre-attestation to the secretless mission runner. The disposable preview marker is still required; a URL string alone is not sufficient.

Candidate-controlled application code is isolated by role:

- candidate backend deployment runs in a pinned container and receives only the exact disposable preview's deployment-scoped admin credential;
- candidate frontend build/runtime runs in pinned containers and receives no Convex deploy credential;
- candidate frontend receives no Clerk secret key;
- candidate frontend receives no E2E login user/password secrets;
- candidate processes receive no GitHub token;
- candidate containers run with all Linux capabilities dropped and `no-new-privileges`;
- candidate containers have no Docker socket or trusted-controller mount; and
- candidate frontend runtime runs on an internal Docker network with only a loopback-published port reachable by the trusted host.

The disposable Convex preview environment is fail-closed to exactly `AUTOFLOW_DEPLOYMENT_CLASS`, both Clerk issuer URLs, `NEXT_PUBLIC_APP_URL`, and `TURNSTILE_SECRET_KEY`. Any newly inherited Preview default outside that allowlist is removed, and the post-scrub equality check fails if the final set differs. The Turnstile value is Cloudflare's public E2E test secret; AutoFlow accepts Cloudflare's `action: "test"` only when both the preview marker and that exact test secret are present.

No production or customer-data attack path is permitted. `PLAYWRIGHT_BASE_URL` must be localhost/loopback, while the backend target must be the trusted bare Convex preview origin.

Timed-out handlers must quiesce after their `AbortSignal` fires before the worker dispatches the next mission; the worker never overlaps a live timed-out mutator with a later attack.

SCRUM-353 remains the prerequisite for any future production/customer-data use.

## Bounded parallelism

Hard initial limits:

- maximum 64 missions per run;
- maximum 8 browser workers;
- deterministic missions admitted before Jev missions;
- stable cost-weighted partitioning;
- no hidden worker multiplication inside Playwright until state isolation is proven.

The initial rollout uses two trusted browser workers when deterministic impact exists. It may increase only with measured cost, collision, and flake evidence.

## Evidence contract

Trusted plan evidence records the canonical invariant impact, Convex control-plane authority, exact source/tested Git identities, and assembled run.

Mission evidence records:

- mission ID;
- worker ID;
- start/completion timestamps;
- deterministic oracle kind;
- deterministic oracle pass/fail summary;
- sanitized relative artifact paths; and
- an optional harness error.

Expected evidence types include Playwright traces, screenshots, backend-state probes, and bounded network/console logs.

Absolute paths, path traversal, raw credentials, raw customer data, and persisted control-plane admin keys are refused.

## Current executable browser attacks

The first executable browser attacks are deliberately preview-only:

- **RTL parity** checks that switching to Arabic reaches `lang=ar` + `dir=rtl` without changing the authenticated organization confirmed by backend authority.
- **UI/backend mismatch** creates one synthetic preview customer through the real UI, verifies exactly one matching backend record, reloads, and checks that the UI still reflects the authoritative state.

Synthetic identities use the reserved E2E preview only. No customer/production data is permitted.

## Phase B — Jev tactical routing

Jev receives sanitized impact/risk context and may propose additional attack families with probabilities.

The control plane validates probabilities and known attack families, applies the advisory threshold, removes redundant suggestions already covered deterministically, and admits only suggestions that fit the remaining mission budget.

Jev does not choose the deterministic oracle and cannot change PASS/FAIL semantics.

## Phase C — anomaly triage and feedback

For suspicious traces:

1. Jev may prioritize or cluster the evidence.
2. Claude/Codex deep-review the suspicious transition/trace.
3. The suspected defect is reproduced deterministically.
4. A failing-first regression is added.
5. The canonical invariant catalog and browser mission mapping are strengthened where appropriate.

## Metrics

Track at minimum:

- missions planned/run;
- deterministic vs Jev-added missions;
- dropped Jev suggestions due to the budget;
- worker utilization and wall clock;
- traces/screenshots/state probes emitted;
- harness errors;
- confirmed breach count;
- unique breach classes;
- false-positive model suspicions;
- Jev tokens/latency/cost;
- browser/CI compute cost; and
- confirmed historical/production escapes that the swarm would have caught.

The objective is not maximum attack count. It is maximum confirmed defect discovery per unit of wall clock and compute while preserving deterministic correctness authority.
