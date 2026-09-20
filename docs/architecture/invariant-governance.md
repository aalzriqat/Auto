# AutoFlow Invariant Governance

**Owner:** SCRUM-342  
**Purpose:** make known correctness requirements deterministic and repository-enforced so adversarial reviewers can focus on novel defects rather than rediscovering established rules.

## 1. Why this exists

AutoFlow already has strong local controls: failing-first tests, structural ratchets, economic-command census, tenant-write analysis, idempotency checks, release rehearsals, and adversarial regression tests.

That is necessary but not sufficient.

Independent reviewers still find different High/Critical defects because open-ended review is a search problem. A reviewer can follow one lifecycle, one legacy-state branch, or one concurrency path while another follows a different one. Coding conventions constrain implementation style; they do not define every business invariant or force every reviewer to traverse every state transition.

This document separates two jobs:

1. **Deterministic invariant proof** — known critical rules must have named evidence and explicit evidence boundaries.
2. **Open-ended adversarial review** — reviewers attack assumptions and interactions not already captured by deterministic controls.

A green adversarial review is never a substitute for invariant proof. A green invariant catalog is never a claim that the whole product is bug-free.

## 2. Core rule

> A Critical invariant is covered only when there is named evidence capable of turning red for a relevant violation.

For structural analyzers, the analyzer itself must also be attacked. A source scanner that has never demonstrated a red result is observation, not a trustworthy guard.

The machine-readable source of truth is:

- `scripts/autoflowInvariantCatalog.ts`
- `scripts/autoflowInvariantCatalog.test.ts`

The catalog uses stable IDs. Removing an ID is a deliberate governance change and must update the independent required-ID ratchet in the test.

## 3. Evidence types

| Kind | What it can prove | What it cannot prove by itself |
| --- | --- | --- |
| **EXECUTION** | Real application behavior in Vitest/Convex tests: accepted/refused transitions, persisted rows, reversals, accounting effects, permissions, etc. | True platform contention if the harness serializes; undocumented paths not exercised by the test |
| **STRUCTURAL** | Repository-wide source shape: every discovered writer/caller/classification follows a declared structural rule | Runtime semantics, dynamic behavior the analyzer cannot resolve, external callers |
| **PREVIEW** | Behavior on an actual Convex preview/runtime, including properties the in-memory harness cannot honestly authorize | Production-only configuration or states not reproduced; cases the rehearsal does not enumerate |

A STRUCTURAL proof is admissible only when:

- it fails closed on unreadable/undecidable shapes where the claim requires certainty;
- it has an explicit negative/fault/self-test;
- the evidence boundary says what the analyzer enumerates and what it does not.

## 4. Enforcement states

### ENFORCED

The exact invariant statement has sufficient evidence for the claim made in the catalog.

This label is intentionally narrow. It does **not** mean the entire surrounding feature or domain is perfect.

### PARTIAL

The repository has meaningful evidence but not enough to make the exact broad claim without overstatement.

Every PARTIAL invariant must name a Jira owner. In V1 that owner is SCRUM-342. As the work is decomposed, narrower follow-up issues may replace it.

PARTIAL is preferable to a false green.

## 5. Current invariant families

The exact current statements, evidence paths, state, and evidence boundaries live in `scripts/autoflowInvariantCatalog.ts`. The initial families are:

| ID | Family | Baseline |
| --- | --- | --- |
| TEN-1 | Tenant isolation | PARTIAL |
| AUTH-1 | Authorization / segregation of duties | PARTIAL |
| ECON-1 | Economic command classification | ENFORCED |
| ECON-2 | Client command identity lifetime | ENFORCED |
| ACC-1 | Balanced + semantically correct posting | PARTIAL |
| ACC-2 | Immutable history + canonical reversal | PARTIAL |
| ACC-3 | Accounting date / closed-period authority | ENFORCED |
| CONS-1 | Consignment ownership + economics | ENFORCED |
| LIFE-1 | Lifecycle reversal completeness | PARTIAL |
| PERF-1 | Completeness under scale | PARTIAL |
| CONC-1 | Runtime concurrency / atomicity | PARTIAL |
| UI-1 | One UI action / one backend authority | ENFORCED |

The table is a navigation aid only. Do not use it as the proof source; the catalog is authoritative.

## 6. Review protocol for every material change

### Step A — identify impacted invariants

Before implementation/review, map the changed behavior to invariant IDs.

A change can impact an invariant without touching the invariant's current proof file. Examples:

- adding a new money-bearing mutation impacts ECON-1;
- adding a caller of an identity-guarded command impacts ECON-2;
- adding a new caller-supplied tenant resource ID impacts TEN-1;
- adding a cancellation path impacts LIFE-1 and often ACC-2;
- changing a posting rule impacts ACC-1 even if total debit still equals total credit;
- replacing a complete read with a bounded read impacts PERF-1.

### Step B — establish a failing-first counterexample

For a bug fix, reproduce the defect before changing production code whenever technically possible.

The test should fail for the defect, not merely fail because an implementation detail changed.

For a new invariant guard, also attack the guard itself:

- remove one required writer/caller;
- alter one classification;
- introduce one known unsafe shape;
- mutate one source condition;
- prove the guard reports the exact defect.

### Step C — fix the invariant, not only the reported line

For every validated High/Critical finding ask:

1. What invariant became false?
2. What are **all writers** that can make it false?
3. What are **all readers/deciders** that rely on it?
4. What lifecycle transitions create, mutate, reverse, cancel, retry, or repair it?
5. What legacy/pre-existing state can already violate the new assumption?
6. What retry/concurrency path can observe an intermediate or duplicated effect?
7. Can the invariant be centralized so the invalid state is harder to represent?
8. Can a repository-wide ratchet prevent the next sibling path?

A one-line patch is acceptable only when the invariant analysis proves there is only one relevant path.

### Step D — run deterministic proofs first

Run the mapped invariant proofs before asking an LLM reviewer for an open-ended review.

The dedicated catalog command is:

```bash
pnpm test:invariants
```

The normal full suite still matters. The invariant command proves catalog integrity; it does not replace domain tests.

### Step E — adversarial review searches outside the catalog

After deterministic evidence is green, independent reviewers should attack:

- undocumented state combinations;
- legacy data and missing relations;
- transitions between valid states rather than only endpoint validation;
- retry after lost response;
- cancellation/reversal after partial completion;
- concurrency and stale reads;
- source-of-truth disagreements across read models;
- bounded reads and runtime limits;
- migration/backfill re-entry;
- UI/backend authority drift;
- assumptions the invariant catalog itself has not encoded.

A novel finding should normally result in one of three outcomes:

1. existing invariant gets a stronger proof;
2. existing invariant is split because its statement was too broad;
3. a new stable invariant ID is added.

## 7. Finding closure standard

A High/Critical finding is not closed merely because its original reproduction is green.

Closure requires evidence that:

- the failing-first counterexample is green after the fix;
- sibling paths were enumerated rather than assumed absent;
- the fix does not weaken the test or redefine the expected result to match the implementation;
- any structural guard has a demonstrated negative control;
- legacy-state behavior is considered;
- retry/idempotency behavior is considered for economic commands;
- reversal/cancellation behavior is considered for lifecycle changes;
- evidence boundaries are updated if the proof is narrower than previously believed.

If a new reviewer finds a second manifestation of the same invariant violation, the response should expand the invariant proof instead of adding another isolated patch whenever practical.

## 8. Important evidence boundaries in this repository

### Convex test harness

Repository tests explicitly document that `convex-test` serializes and does not provide real OCC contention evidence. Therefore a green serialized concurrency-shaped test must not be described as proof of real platform contention.

Use preview/runtime rehearsal for claims that depend on actual Convex scheduling, transaction conflicts, or platform read/write limits.

### Balanced journals

`total debits === total credits` is necessary but not sufficient. Two wrong amounts can offset and still balance. Posting tests must assert semantic account/amount expectations for material event types.

### Structural source guards

A structural guard can only prove what its grammar enumerates. Unknown/unreadable shapes must not be silently treated as safe. Its report and evidence boundary must distinguish:

- proved absent;
- proved present and compliant;
- unknown/unreadable.

### Coverage percentage

Coverage is supporting telemetry, not invariant proof. A high line/branch percentage does not establish the correctness of a state transition or business oracle.

## 9. CI rollout

### V1 — current PR

- canonical invariant catalog;
- self-audit with negative controls;
- named `test:invariants` command;
- dedicated visible CI job;
- no weakening of existing tests;
- no claim that change-impact mapping is complete.

### V2 — impact reporter

Build a source-aware reporter that maps a PR diff to impacted invariant IDs and prints:

- impacted invariant;
- why it was selected;
- required proof commands/files;
- proof state;
- evidence gaps.

The first version should be **report-only** until false positives and blind spots are measured.

### V3 — state-transition/property harness

For the highest-risk domains, encode transition models rather than isolated examples:

- deposits/reservations;
- sales/cancellation;
- receivables/payments/refunds;
- cheque lifecycle;
- finance application/disbursement;
- sourced/consigned settlement;
- custody;
- posting/reversal/outbox.

The harness should test legal transitions, illegal transitions, inverse transitions, retry behavior, and preservation/conservation properties.

### V4 — calibrated blocking gate

Only after V2/V3 are measured should invariant impact become a required merge gate.

A required gate must fail closed on analyzer uncertainty and must have mutation controls demonstrating that representative violations make it red.

## 10. Metrics

Track these over time:

- **Known-invariant Critical escape rate:** Critical bugs violating an already cataloged invariant after merge.
- **Novel Critical rate:** Critical bugs representing a genuinely new invariant class.
- **Review rounds to convergence:** number of adversarial fix/review rounds before merge-ready.
- **Guard mutation survival:** representative unsafe mutations not caught by the mapped guard.
- **PARTIAL count:** especially Critical PARTIAL invariants and their age.
- **False-positive rate:** invariant-impact warnings that do not correspond to a real proof obligation.

The target is not "no reviewer ever finds another bug." The target is that new reviewers increasingly find novel interactions rather than repeat violations of known critical invariants.
