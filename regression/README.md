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
- SCRUM-795#c22485 (owner Q5 answer «س٥: (أ)», relayed by AF-101): the digested text is the comment's operative ruling sentence, the paragraph after `What the ruling means.`, whitespace-normalised. Six SCRUM-801 money records cite it (OTHER refused at every door during the pilot; refund still available).
  - Every door refuses OTHER up front, after auth and ahead of the idempotency claim, whether or not a deposit is held: `applications.finalizeDeal` and the `sales.*` doors (`create`, `completeFromQuote`, `completeDraft`) all return `DEPOSIT_OTHER_TREATMENT_DISABLED` before their first write, so a replay of a pre-switch completion that stated OTHER now refuses too. `sales.completeDraft` reaches the deposit only for a legacy quote-linked draft (SCRUM-425).
  - `refund.liabilityDebited` in the refund record is what the test proves: the refund debits the customer-deposit liability by the full deposit. The seeded deposit has no receipt journal, so a zero net balance is not claimed.

## Screen records (SCRUM-834)

SCRUM-860 also adds nine separate `role-pr-*-paint` records to the anonymous PR visual runner. They paint actual mounted components and shipped EN/AR dictionaries under compiled app CSS at 375px and 1440px: refused Expenses, loading versus empty deposit queues, a configured lead source selected through the actual form, the accountant sales list plus installment wizard choice, a custom lead reader without create actions, and an opened non-vehicle marketplace reply without inventory visibility. Three additional replays paint unresolved lead-source choices without invented options, unresolved quote statuses without empty-configuration copy, and the initial HAVE_SIMILAR choice for an inventory-free responder. The existing NOT_AVAILABLE replay still selects that kind explicitly and does not prove this default or a successful HAVE_SIMILAR submission. The SDK responses are synthetic. The bridge does not reproduce the app shell, Next fonts, hydration, authentication or a real backend. The exact 44-frame inventory rejects missing, duplicate and empty PNG evidence; it does not certify pixels. The existing cockpit census keeps its own scope. These nine records supplement the authenticated role records below and never replace their execution.

SCRUM-860 adds four literal real-role browser replays in `playwright/tests/audit-role-access.spec.ts`: protected route mounting, the lead screen/create dialog, approval queue visibility, and the sales quote picker. They cite the existing SCRUM-760 R-PERMISSION ruling and run for every attested role without role skips. `AUDITED_ROLE` means the actual backend-attested role for that job; expectations use its unchanged permission set. These tests belong to the exact-role preview runner, before its final tenant-isolation mutation. The ordinary authenticated browser config excludes this new role-fixture file because it does not provision that role fixture; the new anonymous paint file runs in its own visual project. Existing matrix cells still cover EN/AR and phone/desktop; these records do not claim that the new full matrix has executed. The component controls remain the lower-level failing-first replays; browser collection alone is not runtime certification.

Seven `screen` / `browser` records bind exact titles in `playwright/tests/deal-cost-reconcile-route.spec.ts`: an unchecked finance-company fee reconciled from its Handover costs row in EN and AR at 1280px and 390px (four records), a disputed appraisal fee corrected then removed (AR, 390px), and the bound execution fee reconciled from its own section (EN 1280px, AR 390px). They are interactive replays in a signed-in session against the real backend; the deal is built through the screens (and, for the execution-fee case, its lender is configured in Settings), but the cost setup runs through public commands, not screens: the cost line is recorded with `recordDealFee` (no screen creates these fee types), the appraisal case also reconciles an anchor line and records a second fee that way, and the execution-fee case binds its line with `bindExecutionFeeLine`. Only the action under test is clicked.

- They cite SCRUM-760#c22465 for R-CONSISTENCY, the nearest standing ruling ("the same business measure must agree across screens"): the closing checklist and the costs panel must agree on what is unchecked and offer the action that clears it. The rule that every readiness blocker has a visible action is stated in SCRUM-834 (finding, not an owner ruling) and SCRUM-417; there is no snapshot entry for it, so no record cites it.
- The generic-row records do not prove the execution-fee path: the default finance company has a zero fee, so that section is not drawn for it. The execution-fee records run on a second deal created against a lender configured with a fee (`EXECUTION_FEE_COMPANY` in `playwright/fixtures/financedDeal.ts`).
- Not in the browser: the permission negatives (both E2E seats hold both permissions, so no seat is refused; the SALES-without-confirm gating is in `HandoverCostRowRoutes.test.tsx` and `HandoverExecutionFeeReconcile.test.tsx`) and the foreign-currency negative (the public command cannot create such a line; component and `financeDealCosts.test.ts` levels).
- A record is bound by title and by static checks only. Whether the replay passes is decided by running it; this change did not run it.

Two permission records bind the literal configuration-choice read-budget tests and their SCRUM-486 matrix rows. They retain the final active row at 8,192 configured rows and refuse an 8,193rd row; inactive rows count. They do not certify platform capacity or measured I/O.
