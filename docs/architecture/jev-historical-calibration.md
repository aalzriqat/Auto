# Jev Historical Calibration

SCRUM-344 measures whether AutoFlow's Jev advisory layer would have requested useful scrutiny on historical changes before later reviewer findings were known.

## Hindsight boundary

Calibration snapshots and finding labels are separate source modules. Snapshot definitions contain only a stable case ID, PR number, exact base/head SHAs, and the snapshot timestamp. The Jev execution module never imports the label module. The CLI runs every Jev request first and dynamically imports labels only after all model calls have completed.

Historical finding text, severity, reviewer identity, later remediation commits, and later comments must never be included in the model state or questions.

## Snapshot selection

A positive case uses the last exact commit that existed before the known finding was reported. A negative control uses a small historical change with no known High/Critical correctness finding in the selected review window. Branch heads that later accumulated unrelated work are not valid controls; select the exact historical commit range instead.

The initial dataset contains:

- PR #319 at `ee86c470...2aab6f0a` before the first Critical/Major production-readiness findings.
- PR #321 at `ee86c470...be045635` before governance false-green findings.
- PR #285 at `65debcaa...03fbdb2a`, the single Add Vehicle Playwright helper correction, as a low-risk control.
- PR #309 at `a0486e48...f18da057`, the one-commit landing-page pricing-copy removal, as a low-risk control.

## Severity normalization

Reviewer-native severity is preserved in `sourceSeverity`. For the cross-reviewer metric, CodeRabbit `Major` is normalized to AutoFlow `HIGH`; `Critical` remains `CRITICAL`. This normalization exists only in hidden scoring labels and is not shown to Jev.

## Metrics

Primary:

- deterministic High/Critical recall
- Jev High/Critical recall
- combined High/Critical recall
- incremental Jev hits missed by deterministic routing

Review-load controls:

- negative-control added-review rate
- negative-control escalation rate
- total and unique Jev-only review/proof requirements

Operational:

- input/output tokens
- Jev latency

The dataset will expand before any threshold recommendation is accepted.

## Authority

Calibration can tune advisory thresholds and routing only. It cannot suppress, waive, satisfy, or retire deterministic invariant proofs, tests, preview rehearsals, required checks, or reviewer decisions.

A high Jev score is not proof of a bug. A low Jev score is not proof of safety.
