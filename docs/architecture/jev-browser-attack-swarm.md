# Jev-Directed Browser Adversarial Release Swarm

SCRUM-350 builds a bounded, massively parallel browser adversarial harness for AutoFlow preview releases.

The swarm is an exploration and evidence system. It is not a correctness authority.

## Governing rule

Required browser missions are the union of deterministic invariant obligations and Jev suggestions:

```
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

## Phase A — deterministic preview attack harness

Initial control plane:

1. Map impacted invariant IDs to mandatory browser attack families.
2. Add bounded Jev suggestions only after mandatory missions are admitted.
3. Partition missions across at most eight workers.
4. Bind every worker plan to one explicit disposable preview identity.
5. Require the existing SCRUM-143 preview marker + URL identity assertion before browser execution.
6. Store sanitized worker evidence under isolated per-run/per-worker artifact roots.
7. Classify outcomes from deterministic oracles only.

Initial attack families:

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

## Preview safety

The swarm reuses the existing E2E preview bootstrap safety model. It does not invent a competing environment selector.

A run manifest carries:

- a safe run ID;
- one explicit `e2e-*` preview name;
- the expected Convex cloud URL;
- `requiresPreviewMarker: true`;
- isolated worker IDs and artifact roots; and
- the bounded mission partition.

The execution layer must call the existing preview assertion path before any adversarial write. The preview marker is the authority proving that the deployment is disposable; a URL string alone is not sufficient.

No production or customer-data attack path is permitted. SCRUM-353 remains the prerequisite for any future production/customer-data use.

## Bounded parallelism

Hard initial limits:

- maximum 64 missions per run;
- maximum 8 browser workers;
- deterministic missions admitted before Jev missions;
- stable cost-weighted partitioning;
- no hidden worker multiplication inside Playwright until state isolation is proven.

The initial production rollout should begin below those maximums and increase only with measured cost, collision, and flake evidence.

## Evidence contract

Mission evidence records:

- mission ID;
- worker ID;
- start/completion timestamps;
- deterministic oracle kind;
- deterministic oracle pass/fail summary;
- sanitized relative artifact paths; and
- an optional harness error.

Expected evidence types include Playwright traces, screenshots, backend-state probes, and bounded network/console logs.

Absolute paths, path traversal, raw credentials, and raw customer data are refused.

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
