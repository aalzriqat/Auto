# Regression library (SCRUM-761 / SCRUM-760 R1-R4)

`scenarios/**/*.scenario.json` hold one record per scenario; `rulings.json` is a
public snapshot of the owner rulings they cite: comment id, digest, date only.
Never put ruling text or customer data here. Format, validators and rules live in
`scripts/regression/scenarioRecord.ts`; run `pnpm test:regression-library`.

## Known limits (S1)

- Prose is refused structurally (actions/observables are dotted tokens, input/value strings are short space-free tokens), but a single-word token can still be a name. A human reviews every scenario PR for public-data hygiene.
- matrixRow is required for money, permission and tenancy records but only format-checked: the SCRUM-486 matrix is not machine-readable yet, so membership cannot be joined until it is (S2/S3).
- A parameterized (test.each / describe.each) named check is refused: one record per case, or a runner census in S3.
