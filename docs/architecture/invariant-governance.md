# AutoFlow Invariant Governance

**Owner:** SCRUM-342  
**Purpose:** turn known Critical/High correctness rules into deterministic repository-enforced proof obligations so adversarial reviewers can focus on novel interactions.

## 1. Principle

A reviewer should not need to remember every accounting, tenancy, lifecycle, retry, or concurrency rule.

Known rules belong in the repository as stable invariant IDs with explicit proof obligations and evidence boundaries.

A green invariant catalog does **not** mean the product is bug-free. It means the repository can explain which known invariants exist, which proof classes they require, which evidence satisfies those classes, and which gaps remain open.

## 2. One governance system

SCRUM-342 is the single correctness-governance foundation.

Do not create parallel invariant registries, proof registries, state-machine catalogs, or release gates. Property testing, model/state-machine testing, concurrency, fault injection, mutation, reconciliation, change-impact reporting, fuzzing, and production monitors attach to this same catalog.

Machine-readable source of truth:

- `scripts/autoflowInvariantCatalog.ts`
- `scripts/autoflowInvariantCatalog.test.ts`

## 3. Separate WHAT from HOW

### Proof obligation — WHAT must be proved

Supported proof classes include:

- POSITIVE
- NEGATIVE
- BOUNDARY
- REPLAY
- PROPERTY
- STATE_TRANSITION
- CONCURRENCY
- FAULT_INJECTION
- FUZZ
- REVERSAL
- TENANCY
- AUTHORIZATION
- MUTATION
- HISTORICAL_REGRESSION
- RECONCILIATION
- E2E
- PRODUCTION_MONITOR

Each obligation is classified as:

- **REQUIRED** — evidence must exist using an accepted evidence mechanism.
- **DEFERRED** — required for completeness but not yet present; Critical/High gaps need a Jira owner and rationale.
- **NOT_APPLICABLE** — genuinely irrelevant to this exact invariant; requires a rationale.

### Evidence mechanism — HOW it is proved

- **EXECUTION** — behavior executed in application/Convex tests.
- **STRUCTURAL** — source/AST census or ratchet. Requires a demonstrated negative/mutation control.
- **PREVIEW** — real preview/runtime evidence where the serialized test harness cannot prove the property.
- **MANUAL_POLICY** — documented policy only; never substitutes for executable proof where executable proof is possible.
- **PRODUCTION_MONITOR** — runtime detection/reconciliation. Supplementary unless the property is inherently production-only.

A REQUIRED proof declares which evidence mechanisms are admissible. This prevents a structural census from being misread as proof of runtime semantics.

## 4. Enforcement states

### DOCUMENTED

Invariant exists, but meaningful executable evidence is not yet sufficient.

### PARTIAL

Meaningful evidence exists, but one or more applicable proof obligations are explicitly DEFERRED.

PARTIAL is a truthful state, not a failure badge.

### ENFORCED

Every applicable REQUIRED obligation is satisfied by admissible evidence and no DEFERRED obligation remains.

The validator derives this contract mechanically; old ENFORCED labels are not grandfathered.

### RETIRED / SUPERSEDED

An invariant can leave the active set only through explicit retirement metadata with rationale and Jira ownership. SUPERSEDED also names replacement invariant IDs.

Silent deletion is not retirement.

## 5. Assurance profile

Each invariant declares metadata required by later phases:

- economic impact: NONE / INDIRECT / DIRECT;
- concurrency applicability;
- reversal applicability;
- tenant sensitivity;
- authorization sensitivity;
- external-input sensitivity;
- webhook sensitivity;
- scheduled-work sensitivity;
- source areas and optional symbols.

Any invariant whose economic impact is INDIRECT or DIRECT must explicitly assess REPLAY, CONCURRENCY, REVERSAL, and RECONCILIATION. Those assessments may be REQUIRED, DEFERRED, or justified NOT_APPLICABLE; they may not be omitted.

Tenant-sensitive invariants require TENANCY proof. Authorization-sensitive invariants require server-side AUTHORIZATION proof. External-input-sensitive invariants must assess BOUNDARY and FUZZ; webhook-sensitive invariants must assess REPLAY, AUTHORIZATION, and NEGATIVE behavior; scheduled-work-sensitive invariants must have applicable (not NOT_APPLICABLE) REPLAY, CONCURRENCY, and FAULT_INJECTION assessments.

## 6. Evidence boundaries

Every invariant states what its evidence proves and what it does not.

Important repository boundaries:

### Convex test harness

`convex-test` is not evidence of real Convex OCC contention where the harness serializes operations. Ordering tests must not be described as real contention proof.

Use PREVIEW/runtime evidence for properties that depend on actual transaction conflict, scheduling, or platform limits.

Workflow evidence is parsed structurally. A preview marker only counts when it appears in the pinned workflow, trigger, job, runner, named step, and that step's `run` body; the same command in another job or scope is not evidence.

### Structural guards

A structural guard can only prove the shapes it enumerates. Unknown/unreadable shapes must fail closed when certainty is required.

Every structural proof must name an executable direct `test`/`it` negative-control marker. The validator parses the TypeScript AST, requires the pinned analyzer calls to execute, and requires an assertion to consume analyzer-derived data; a matching phrase in a comment, inert string, `describe` title, `test.skip`, skipped suite, or identifier-only decoy does not count. Every proof record also carries its invariant ID; unknown or cross-bound proof IDs fail the self-audit and cannot satisfy a REQUIRED obligation.

### Balanced journals

Debit equals credit is necessary, not sufficient. Semantic posting proof must assert accounts, amounts, ownership basis, dates, and other material event semantics.

### Coverage

Coverage is blind-spot telemetry, not correctness proof.

## 7. Anti-vacuity rules

The governance system must not become green by checking nothing.

The self-audit protects against:

- zero active invariants;
- silent removal/rename of required IDs;
- duplicate IDs;
- missing proof files;
- stale proof markers when markers are used;
- proof records bound to unknown or different invariant IDs;
- evidence markers that exist only in comments, inert strings, or skipped test declarations;
- REQUIRED obligations with no admissible evidence;
- DEFERRED obligations without Jira ownership;
- NOT_APPLICABLE without rationale;
- proof evidence claiming undeclared obligations;
- structural proofs without negative controls;
- tenant/auth sensitivity without corresponding proof requirements;
- INDIRECT or DIRECT economic invariants that omit core economic risk assessments;
- platform-serialization claims without preview concurrency evidence;
- irreversible-by-design claims without explicit reversal N/A rationale;
- external/webhook/scheduled sensitivity without the corresponding proof assessments;
- supersession to unknown, inactive, or self IDs;
- silent retirement.

Structural/domain-specific censuses must separately fail closed when an expected subject population unexpectedly becomes zero.

## 8. Review protocol

For every material change:

1. Map the change to invariant IDs.
2. For a defect, reproduce the failure before changing production code whenever technically possible.
3. Identify all writers/readers/transitions that can violate the invariant.
4. Add or strengthen the proof obligation rather than only patching the reported line.
5. Run deterministic invariant proofs first.
6. Run open-ended adversarial review after known rules are green.
7. A novel finding must normally strengthen an existing invariant, split an overly broad invariant, or create a new stable invariant ID.

The dedicated catalog command is:

```bash
pnpm test:invariants
```

It verifies catalog integrity. It does not replace the full test suite or preview rehearsals.

## 9. Current calibration rule

Existing evidence is reused rather than duplicated.

An invariant remains ENFORCED only when the stronger proof-obligation model supports that exact claim. If property, contention, reversal, reconciliation, or another applicable proof is still missing, the invariant remains PARTIAL and the gap is visible.

## 10. Next phases

All future work extends this same catalog:

1. change-impact reporter mapping touched code/symbols/commands/events to invariant IDs;
2. property-based financial invariants;
3. model/state-machine generation for critical lifecycles;
4. complete economic-command concurrency classification and preview contention cases;
5. fault-injection matrix;
6. mutation completeness for Critical financial/security guards;
7. generative subledger ↔ GL reconciliation;
8. fuzzing of trust boundaries;
9. production invariant monitoring;
10. generated assurance dashboard;
11. calibrated blocking impact gate after false-positive/blind-spot measurement.

## 11. Metrics

Track evidence, not a fake single correctness percentage:

- active Critical/High invariant count;
- ENFORCED vs PARTIAL;
- REQUIRED obligations satisfied/missing by proof class;
- known-invariant Critical escape rate;
- novel Critical rate;
- review rounds to convergence;
- mutation survival;
- age of Critical PARTIAL gaps;
- false-positive rate of change-impact mapping.

The target is not that reviewers never find another bug. The target is that known invariant violations stop escaping repeatedly, while reviewers increasingly spend their effort on genuinely novel interactions.
