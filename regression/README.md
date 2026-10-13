# Regression library (SCRUM-761 / SCRUM-760 R1-R4)

`scenarios/**/*.scenario.json` hold one record per scenario; `rulings.json` is a
public snapshot of the owner rulings they cite: comment id, digest, date only.
Never put ruling text or customer data here. Format, validators and rules live in
`scripts/regression/scenarioRecord.ts`; run `pnpm test:regression-library`.

## Known limits (S1)

- Prose is refused structurally (actions/observables are dotted tokens, input/value strings are short space-free tokens), but a single-word token can still be a name. A human reviews every scenario PR for public-data hygiene.
- matrixRow is required for money, permission and tenancy records but only format-checked: the SCRUM-486 matrix is not machine-readable yet, so membership cannot be joined until it is (S2/S3).
- A parameterized (test.each / describe.each) named check is refused: one record per case, or a runner census in S3.
- Skip detection is static and best-effort (indirection such as options held in a variable can beat it); the S3 runner census (named test executed and passed, not skipped or expected-fail) is the binding proof.
- An active cloud-level record is refused until a cloud runner exists (SCRUM-762); park it as a candidate.
- Free-text reasons (retiredReason/candidateReason, 300 chars) and impl.testName are only heuristically screened; reviewers check them for public-data hygiene.
- Records may not share one impl.file + testName; the title is not yet required to carry the scenario id (follow-up).
- impl.testName must equal the registered test title exactly (no substring binding).

## Record kinds

- `scenario` (default): actor + public-API steps.
- `rule` (owner ruling 2026-10-07): a pure-function money/permission rule (e.g. `saleEconomics`) described by `subject` + `inputs` instead of steps. Backend level, non-screen domain; still needs a ruling, a matrixRow and an exact `impl.testName`. Identity (de-dup) is subject + inputs + expected.
- SCRUM-595 loop-generated cases are one record per case, parked as `candidate` until the S3 runner census can bind generated titles (owner ruling 2026-10-07).


## Pilot records (S2b)

Three `rule` records bind exact titles in `convex/consignmentEconomics.test.ts` and cite SCRUM-407#c21031 (financed DIRECT sourced sale: approved-basis, not sale-price). Their `matrixRow` (`SCRUM-41-direct`) is a descriptive label of the originating bug group, not a joined SCRUM-486 row id: the matrix is not machine-readable yet. One `permission` scenario (financed finalize refused without confirm:finance_disbursement, SCRUM-407#c21031) is bound to its existing test; it claims only the refusal half because that test's accountant step is not asserted at its own step. Tenancy records stay deferred until the schema has an invariant ruling-source form.

### Known limits (S2 review)

- A `rule` record's bound test must call its `subject` and assert (static check). The expected VALUES are not compared to the test body; a record-driven runner (S3) is the binding proof.
- The ruling digest normalises whitespace only (no Unicode NFC) and the `date` is the refresh date; both are operator conventions, tracked for S3.
- The fail-closed (withhold) expectations of the pilot records come from SCRUM-41 / SCRUM-49 Lane 4; c21031 governs the approved-basis record directly.

- Ruling ids are `SCRUM-n#cN` (a comment) or `SCRUM-n#description` (the issue description). A non-owner invariant source (e.g. the tenant write guard) has no form yet; tenancy records stay deferred.
- Permission records need a located test that already asserts the refusal. Next candidate: the refusal list in convex/scrum413bDealDoors.test.ts (needs a SCRUM-413#description digest).
- SCRUM-760#c22465 holds two standing rulings (R-CONSISTENCY, R-PERMISSION; Sol 6, owner away, subject to owner override). One comment id, one digest: the digested text is the two quoted ruling sentences, each prefixed with its label (R-CONSISTENCY: / R-PERMISSION:) and joined by a newline, whitespace-normalised. A record cites the comment id and names the rule in its invariant text; there is no per-rule id form.
- SCRUM-795#c22485 (owner Q5 answer «س٥: (أ)», relayed by AF-101): the digested text is the comment's operative ruling sentence, the paragraph after `What the ruling means.`, whitespace-normalised. Five SCRUM-801 money records cite it (OTHER refused at every door during the pilot; refund still available).
