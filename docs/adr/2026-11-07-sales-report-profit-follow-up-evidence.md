# SCRUM-928 profit follow-up evidence

Owner ruling supplied on 2026-11-07, asked in Arabic: "قبل العمولات (مقترح)".
The profit column is before commissions. The separate after-commission column
matches the deal page. The [ADR](2026-11-07-sales-report-matches-deal-page.md)
records the derivation, permission boundary and retained ruling reference.
This is implementer evidence. It is not independent review or runtime certification.
The implementation commit is `ead75b8819a74d14e8a0f9ddb82329219bc65015`.
The following evidence/baseline commit changes no TypeScript source.

## Field contract

For the synthetic SOURCED financed fixture with a 451,300 fee, 300,000 preparation,
110,000 sale commission and 25,000 commission line, all values below are major JOD.
The deal page returns 998,700 minor units. Both the real MANAGER template and an
ADMIN caller exercise the public Sales and Performance queries.

| Field | At a7d31e68a | Follow-up |
| --- | ---: | ---: |
| Sales row netProfit | 998.7 | 1133.7 |
| Sales totalProfit | 998.7 | 1133.7 |
| Performance totalProfit | 998.7 | 1133.7 |
| Sales row netProfitAfterCommissions | 998.7 | 998.7 |
| Sales totalNetProfitAfterCommissions | 998.7 | 998.7 |
| Performance totalNetProfitAfterCommissions | 998.7 | 998.7 |
| Commission component | 135 | 135 |

The equivalent CASH fixture returns 1900 before and 1765 after. The unchanged
`convex/dealCommissions.test.ts` retains its 5000 / 4875 contract. Its Git blob
is `38aa6e4f25455522f30e7169ac97150478efd16b`, identical to a7d31e68a.
Pending commissions leave before profit available, after profit null, after
totals zero for that excluded row, and the incomplete count incremented.
Permissions remain those from 894433d9b. No new ruling comment id was supplied;
`regression/rulings.json` and scenario references retain `SCRUM-928#c24715`.

## Failing-first and passing evidence

The first run, before implementation, used HEAD
`a7d31e68aa8e55f3f07c995ae20eebaa1c8cf28b` plus the new report assertions.
The named report and untouched commission suites initially produced
22 failed / 28 passed across 50 tests. After adding two settlement-pending
assertions, the run produced 24 failed / 28 passed across 52 tests.

The final test definitions were also replayed against the exact committed bytes
of all seven changed production files at a7d31e68a, then restored byte-for-byte.
The replay ran:

```text
pnpm exec vitest run --maxWorkers=1 convex/reports.matchesDeal.test.ts convex/dealCommissions.test.ts components/reports/ReportsPage.matchesDeal.test.tsx
```

That replay exited 1 with 27 failed / 29 passed across 56 tests: report 23/4,
unchanged commission suite 1/24, and page 3/1, expressed as failed/passed.
The errors were incorrect before profit, pending base profit unavailable, and
old payload/labels admitted. The final green runs contain those same 56 cases.
The initial EN/AR label run separately produced 2 failed / 1 passed before the
label change. No test was skipped or weakened.

The prior 26-file table now has 1139 passed, zero failed and zero skipped.
Six additional suites add 261 passes. Combined, the four disjoint named-file
runs have 1400 passed, zero failed and zero skipped across 32 files. Every
invocation used `pnpm exec vitest run --maxWorkers=1` with explicit file names.

| Test file | Passed |
| --- | ---: |
| `components/reports/ReportsPage.matchesDeal.test.tsx` | 4 |
| `convex/accountingVehicleInventory.test.ts` | 169 |
| `convex/consignedReporting.test.ts` | 57 |
| `convex/consignmentEconomics.test.ts` | 49 |
| `convex/costReaders.scrum902.test.ts` | 18 |
| `convex/costReaders.scrum902c.test.ts` | 14 |
| `convex/costReaders.scrum902d.test.ts` | 18 |
| `convex/dealCommissions.test.ts` | 25 |
| `convex/dealNetProfit.scrum908.test.ts` | 40 |
| `convex/dealerBorneExpected.test.ts` | 7 |
| `convex/depositRevenueRecognition.test.ts` | 20 |
| `convex/financedConsignedSettlement.test.ts` | 243 |
| `convex/migrateExpenseReversals.test.ts` | 3 |
| `convex/openingPrepaidConsumerReports.test.ts` | 3 |
| `convex/prepaidExpenses.test.ts` | 89 |
| `convex/reportGlParity.test.ts` | 11 |
| `convex/reports.matchesDeal.test.ts` | 27 |
| `convex/reports.test.ts` | 8 |
| `convex/sales.test.ts` | 16 |
| `convex/scrum411DirectRoute.test.ts` | 28 |
| `convex/scrum411ReportBasis.test.ts` | 21 |
| `convex/scrum486Certification.test.ts` | 64 |
| `convex/sourcedVehicleHolds.test.ts` | 22 |
| `convex/supplierCostRecoveries.test.ts` | 27 |
| `convex/unifiedDealFeeAuthority.test.ts` | 141 |
| `convex/utils/dealFinancialSummary.test.ts` | 64 |
| `convex/utils/dealManagementNet.test.ts` | 5 |
| `convex/vehicleCostCorrection.test.ts` | 61 |
| `convex/vehicles.test.ts` | 58 |
| `lib/saleReporting.test.ts` | 14 |
| `scripts/protectedSourcePins.test.ts` | 4 |
| `scripts/regression/scenarioRecord.test.ts` | 70 |

## Verification boundaries

The final post-typecheck focused run passed 61/61: the 56 red-replay cases plus
the shared management-net unit suite's five existing tests.

The author checked these predicted failures with the real public queries:

| Predicted failure | Executed evidence |
| --- | --- |
| Base profit still subtracts commissions | Four MANAGER/ADMIN financed/CASH literal split cases |
| Sale or line commission is omitted or deducted twice | Commission component 135, financed after 998.7 and CASH after 1765 |
| Pending pay withholds base profit | Pending CASH and SOURCED cases keep base available and count after as incomplete |
| Pending pay hides the settlement-dependent fee decision | Forecast base 985 versus settled base 1133.7, both with pending after |
| Internal component leaks through the deal query | Commission-denied overview has no profitBeforeCommissions field |
| Old payload is admitted under the restored base label | Missing marker and V1 are refused, V2 renders EN/AR amounts and headers |

Both `pnpm typecheck` and `pnpm typecheck:convex` passed. `git diff --check`
passed. `node scripts/contractSkew/checkBaselineIdentity.mjs` exited 0 with
945 matched entries and zero stranded. After the source commit,
`node scripts/contractSkew/renewBaselineReviewed.mjs --reviewed c82890bd --check-evidence --pr-base 684ba04d0`
first reported 13 stale entries. After individual source-attribution review and
blob renewal, it exited 0 with 945 checked, zero unrenewed, zero stale, zero
malformed and zero missing. The 13 entries cover eight web date operands and
five mobile organization-id operands. Their input contracts and recorded analysis
gaps remain unchanged. Only `renewal` text changed; fingerprints, causes,
rationales, multiplicities, issues and expiries are preserved.

Each renewed entry contains its own committed client/backend `evidence-blobs`
pair. The three distinct blobs are:

| File | Git blob at the implementation commit |
| --- | --- |
| app/(dashboard)/[orgId]/reports/page.tsx | 81160b029a48dddae533225185b1ade1eea2ea52 |
| apps/mobile/src/features/workspace/modules/reports.tsx | e5dbdd3f0abcf8ed60220767dc997f18246ce124 |
| convex/reports.ts | 6a41277c483595974493c5b2bc9e8f9efb02ca03 |

`pnpm typecheck` checks the root project. Its configured exclusions are
`node_modules`, `apps`, `packages`, `convex`, `dealer-worker` and `test-utils`.
Imports may still bring excluded files into that TypeScript program.
`pnpm typecheck:convex` checks `convex/**/*` and `test-utils/**/*`, with
`convex/_generated` excluded as a root. It does not replace mobile, shared-package
or dealer-worker typechecks.

ESLint covers all 13 touched TypeScript and TSX files. Its 22 warnings are
identical to a7d31e68a by file, rule, message and position; there are zero errors
and zero added messages. Neither a local lint result nor these tests is a
SonarCloud verdict.

No server, watcher, Jira access, push, deployment or production-data read was
used. Independent seats, CI/SonarCloud, the three live bug hunters, signed-in
browser flows, desktop/mobile layout, actual CSV download, cloud limits/OCC and
production parity remain unverified. EN/AR headers, amounts, payload refusal and
direction are covered in jsdom, which does not prove browser layout.
