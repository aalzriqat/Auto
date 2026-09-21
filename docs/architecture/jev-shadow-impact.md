# Jev shadow-mode invariant impact mapper

Tracking foundation: SCRUM-342.

## Purpose

Jev is an advisory change-impact and review-routing layer around AutoFlow's existing repository-enforced correctness system. It does not define correctness and it does not replace deterministic proof.

The canonical invariant registry remains `scripts/autoflowInvariantCatalog.ts`. The Jev harness reads that file and creates one System One `Noul` question per active invariant. There is no second invariant registry.

## Authority boundary

The initial integration is intentionally shadow-only:

- existing required CI checks continue to run exactly as before;
- deterministic source-area matching from the canonical catalog is computed before Jev;
- Jev recommendations are unioned with deterministic review requirements, never intersected with them;
- Jev cannot waive, satisfy, skip, or downgrade an invariant proof obligation;
- a missing credential, API error, malformed response, timeout, or unavailable model produces `ADVISORY_UNAVAILABLE` / `SKIPPED_NO_CREDENTIAL`, not a safe verdict;
- the unprivileged `Invariant Governance` workflow first runs the deterministic catalog and Jev-harness tests on the candidate PR with no Jev secret;
- only after that workflow succeeds does the secret-bearing PR analysis run through `workflow_run` from trusted `main`; it fetches the PR commit only as Git data and never checks out or executes PR code;
- the trusted workflow disables external diff and text-conversion execution while reading the candidate diff.

Promotion to blocking authority is out of scope until historical AutoFlow evaluation measures false negatives, false positives, reviewer disagreement, and known High/Critical escape behavior.

## Data sent to TypeSafe

The PR workflow sends only change-analysis state:

- base and head commit SHA;
- changed paths and name/status records;
- diff statistics;
- a bounded patch excerpt, keeping both the head and tail when truncation is necessary.

The request explicitly marks diff contents as untrusted data rather than instructions. The workflow never sends the API key in the state or body; it is supplied only as the HTTP Bearer credential from `TYPESAFE_API_KEY`.

For a pull request, the harness itself and installed dependencies come from trusted `main`. The candidate `autoflowInvariantCatalog.ts` is read from the PR commit as text and parsed by the trusted harness so new/changed invariant metadata can participate in classification without executing candidate code.

The public CI artifact deliberately excludes the raw patch, request state, API key, Authorization header, and raw HTTP response. It records probabilities, model, token usage, deterministic impact, and the derived advisory review matrix.

## Current probability policy

The first shadow calibration uses:

- `0.35` as a candidate threshold;
- `0.65` as an escalation threshold.

These values are routing heuristics, not correctness thresholds. They must be calibrated against historical AutoFlow PRs before any blocking behavior is considered.

## Proof model

The output composes three layers:

1. **Canonical deterministic impact:** changed files are matched against each invariant's existing `sourceAreas`; REQUIRED proof obligations for matched invariants are preserved in the review matrix.
2. **Jev semantic impact:** Jev scores invariant impact plus economic, tenancy, authorization, replay, concurrency, reversal, lifecycle, completeness, external-input, and UI/backend-authority risk surfaces.
3. **Deterministic policy:** the final advisory matrix is the union of deterministic requirements and Jev-added scrutiny.

Tests pin the load-bearing property that Jev cannot subtract deterministic requirements.
