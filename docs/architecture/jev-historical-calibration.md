# Jev Historical Calibration

SCRUM-344 measures whether AutoFlow's Jev advisory layer would have requested useful scrutiny on historical changes before later reviewer findings were known.

## Two-track experiment

### Primary blind risk replay

The historical diff is sent with generic risk questions only. The blind track receives no current invariant IDs, invariant statements, source-area metadata, later reviewer findings, severity labels, or remediation information.

This is the primary hindsight-free Jev measurement.

### Secondary current-policy replay

The same historical diff is also replayed through the currently deployed SCRUM-342 invariant policy. This answers a different operational question: how would today's AutoFlow router treat this historical change?

Because today's invariant catalog is newer than several historical cases, current-policy replay must never be described as hindsight-free.

## Hindsight boundary

Calibration snapshots and finding labels are separate source modules. Snapshot definitions contain only a stable case ID, PR number, exact base/head SHAs, and the snapshot timestamp. The Jev execution module never imports the label module.

The CLI performs every blind and current-policy Jev call first. Only after all calls complete does it dynamically import labels for scoring.

Historical finding text, severity, reviewer identity, later remediation commits, and later comments must never be included in either model state.

## Snapshot provenance

A positive case uses the last exact commit that existed before the known finding was reported. A negative control uses a small historical change with no known High/Critical correctness finding in the selected review window.

Branch heads that later accumulated unrelated work are not valid controls; select the exact historical commit range instead.

Calibration fails closed unless:

- the base SHA is an ancestor of the head SHA; and
- the stored snapshot timestamp matches the head commit's Git committer timestamp exactly after ISO normalization.

The initial dataset contains:

- PR #319 at `ee86c470...2aab6f0a` before the first Critical/Major production-readiness findings.
- PR #321 at `ee86c470...be045635` before governance false-green findings.
- PR #285 at `65debcaa...03fbdb2a`, the single Add Vehicle Playwright helper correction, as a low-risk control.
- PR #309 at `a0486e48...f18da057`, the one-commit landing-page pricing-copy removal, as a low-risk control.

This is only the initial harness dataset. Threshold recommendations are forbidden until the broader SCRUM-344 historical set is measured.

## Severity normalization

Reviewer-native severity is preserved in `sourceSeverity`. For the cross-reviewer metric, CodeRabbit `Major` is normalized to AutoFlow `HIGH`; `Critical` remains `CRITICAL`. This normalization exists only in hidden scoring labels and is not shown to Jev.

## Metrics

Primary recall:

- current deterministic replay recall;
- blind Jev High/Critical scrutiny recall at the candidate threshold;
- blind Jev High/Critical escalation recall at the escalation threshold;
- current-policy Jev scrutiny and escalation recall;
- operational combined recall; and
- incremental Jev hits missed by deterministic routing.

Review-load controls:

- blind and current-policy negative-control added-review rates;
- blind and current-policy negative-control escalation rates; and
- total and unique Jev-only proof/review requirements.

Operational:

- blind and current-policy availability;
- unavailable track count;
- input/output tokens by track; and
- latency by track.

A candidate-threshold hit means Jev requested relevant scrutiny. It is not equivalent to a strong finding. Escalation recall is reported separately so weak advisory signals cannot be presented as strong catches.

## Unavailable or malformed model output

Each blind and policy track is isolated. An API failure, malformed response, timeout, or schema error is recorded as `UNAVAILABLE` with a bounded, sanitized reason. The other track and later cases continue running.

An unavailable track:

- never receives credit for catching a finding;
- does not erase deterministic replay evidence;
- is excluded from negative-control false-positive denominators and reported separately through availability metrics; and
- causes the CLI workflow to finish non-zero only after the sanitized calibration artifact has been written and uploaded.

This preserves failure evidence without turning provider unavailability into either a false clean result or a lost experiment.

## Secret and artifact boundary

Candidate PR CI receives no TypeSafe credential. Real calibration runs only from trusted `main` after merge.

Public calibration artifacts may contain exact historical SHAs, sanitized probabilities, review requirements, usage, latency, availability state, and hidden-label scoring results. They must not contain the raw patch excerpt, raw prompt state, Authorization headers, or the TypeSafe credential.

## Authority

Calibration can tune advisory thresholds and routing only. It cannot suppress, waive, satisfy, or retire deterministic invariant proofs, tests, preview rehearsals, required checks, or reviewer decisions.

A high Jev score is not proof of a bug. A low Jev score is not proof of safety. Provider unavailability is not proof of safety.
