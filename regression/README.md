# Regression library (SCRUM-761 / SCRUM-760 R1-R4)

`scenarios/**/*.scenario.json` hold one record per scenario; `rulings.json` is a
public snapshot of the owner rulings they cite: comment id, digest, date only.
Never put ruling text or customer data here. Format, validators and rules live in
`scripts/regression/scenarioRecord.ts`; run `pnpm test:regression-library`.
