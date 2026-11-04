# SCRUM-908 implementation evidence

Base: `f119b20e5a969e3503f5aeaba8531dd9711e25ae`. Branch: `claude/scrum908-deal-net-profit`. Synthetic fixtures only. See the [ADR and surface/class tables](../adr/2026-11-04-deal-management-net-profit.md).

## Red before production edits

After installing with `pnpm install --frozen-lockfile --prefer-offline` (exit 0), ran:

```text
pnpm exec vitest run convex/dealNetProfit.scrum908.test.ts --maxWorkers=1
FAIL: expected amountMinor 1009200, received 1433700
14 failed, 1 passed
```

The production files still matched the base. The first fixture attempt lacked the fee's required `source`, and then its supplier payable lacked the sale link. Those setup failures are not defect evidence; the corrected fixture produced the numeric failure above.

The failing-first commissions-row assertion supplied a final net of 875,000 minor units. The unchanged component displayed 750,000, proving its second subtraction. The component run had one failure and three passes.

During implementation, three additional controls failed before their guards were added: a cash STOCK capitalized row with an unreadable capitalized amount, a negative salesperson commission masked by positive lines, and a fractional-minor salesperson commission rounded by the legacy converter. The final tests cover them. An early broad run also caught eight obsolete assertions; the fix preserves the existing cash accounting payload instead of changing its meaning. Root typecheck caught a readonly fixture assignment and two fixtures missing the new management field; these were corrected.

A final cap control reproduced `dealCommissions.forSale` throwing above 100 rows while the overview correctly returned unavailable. The shared bounded reader now lets display readers return `lineEvidence: UNAVAILABLE` with a null total; writer refusals are unchanged. Both detail consumers suppress partial evidence, and the dialog suppresses its Add form. The dialog controls use the real language provider with browser storage stubbed; missing provider/storage setup in their first attempts was corrected before accepting their green result.

## Completed checks

All Vitest commands use named files and one worker, with no watcher or retries. The final runs use `--testTimeout=20000`; one earlier cold import exceeded the default five-second timeout under local load. The EN/AR test initially expected explicit `dir="ltr"`; the existing headline uses `bdi`, so the corrected test checks that isolation element. This is a DOM check, not a visual-order measurement.

| Command/check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile --prefer-offline` | Exit 0, 17m 50s; no manifest or lockfile change |
| `pnpm typecheck` | Exit 0 after the fixture corrections |
| `pnpm typecheck:convex` | Exit 0 |
| `pnpm exec eslint` on all 24 changed TS/TSX files | Exit 0; zero errors, seven warnings whose source lines exist on the base |
| Broad named run below | 305 tests passed in 12 files |
| Final coverage run below | 178 tests passed in ten files |
| Commission reader, ledger and row follow-up | 68 tests passed in four named files |
| `pnpm exec vitest run convex/scrum486Certification.test.ts --maxWorkers=1 --testTimeout=20000 -t SCRUM908` | New certification row passed; 63 unrelated rows excluded by the title filter |
| `pnpm exec vitest run convex/scrum486Certification.test.ts scripts/regression/scenarioRecord.test.ts --maxWorkers=1 --testTimeout=20000` | Final 126 tests passed: 64 certification harness cases and 62 library checks, no skips |
| `node scripts/contractSkew/relocateBaseline.mjs --base f119b20e5a969e3503f5aeaba8531dd9711e25ae --write` | 49 safe relocations, zero refusals; existing call expressions unchanged |
| `node scripts/contractSkew/checkBaselineIdentity.mjs` | 945 entries matched; this does not check backend finding identity |
| SonarJS 4.2.2 S3776 via local ESLint API | Changed financial helpers have cognitive complexity 1–11, below 15 |
| `git diff --check` | Exit 0 |

The broad run was:

```sh
pnpm exec vitest run convex/dealNetProfit.scrum908.test.ts convex/utils/dealManagementNet.test.ts convex/dealOverview.test.ts convex/cashDealCockpit.test.ts convex/utils/dealerPreparationExpenses.test.ts convex/utils/stockManagementProfit.test.ts convex/utils/dealCommissionLines.test.ts components/commissions/DealCommissionsRow.test.tsx components/applications/cockpit/DealCockpitCanonicalProfit.test.tsx components/applications/cockpit/DealCockpitCustomerInvoice.test.tsx components/applications/cockpit/DealCockpitSupplierAuthority.test.tsx scripts/regression/scenarioRecord.test.ts --maxWorkers=1 --testTimeout=20000
```

The final coverage invocation selects the first five backend files from that command, `convex/dealCommissions.test.ts`, `convex/dealCommissionLinesLedger.test.ts`, `DealCommissionsRow.test.tsx`, `DealCommissionLinesDialog.test.tsx` and `DealCockpitCanonicalProfit.test.tsx`, with `--coverage`. Its explicit coverage includes are the ten production files in the table below. Local reports are under `%TEMP%/scrum908-coverage-final`. Global whole-file thresholds were disabled for this scoped measurement; a separate LCOV tally requires every selected file, a nonempty measured set and at least 80% coverage of new/changed executable lines. It measured:

| Production file | Covered / measured new or changed executable lines |
| --- | --- |
| `convex/utils/dealManagementNet.ts` | 15 / 15, entire new helper |
| `convex/utils/dealProfitReads.ts` | 24 / 24, entire new helper |
| `convex/utils/dealCommissionLineReads.ts` | 2 / 2 |
| `convex/dealCommissions.ts` | 4 / 4 |
| `convex/utils/vehicleCostBasis.ts` | 18 / 18 |
| `convex/dealOverview.ts` | 4 / 4 |
| `convex/sales.ts` | 3 / 3 |
| `components/applications/cockpit/DealCockpit.tsx` | 2 / 2 |
| `components/commissions/DealCommissionsRow.tsx` | 2 / 2 |
| `components/commissions/DealCommissionLinesDialog.tsx` | No new LCOV executable line point; both evidence states exercised by component controls |
| Total measured points | **74 / 74, 100%** |

These counts are V8 executable line points intersected with zero-context Git addition ranges, plus the two new helpers. The dialog's added JSX has no separate LCOV line point; it receives no line-coverage PASS claim from this tally. Its unavailable and served states have explicit component assertions. These are not whole-repository or SonarCloud coverage claims. Both new helpers also have 100% whole-file line coverage. The legacy STOCK basis derivation was excluded from the new-helper complexity assertion because its implementation is unchanged. SonarJS was unpacked under ignored `node_modules/.cache`; no dependency was added to the project. An initial standalone lint-API attempt failed on project-config/module loading; the successful S3776-only run used an explicit TypeScript parser and isolated rule configuration. Normal project lint ran separately and passed as recorded above.

Root typecheck excludes `convex/`, `test-utils/`, `apps/`, `packages/` and `dealer-worker/` as entry sets; it is not the backend typecheck. The Convex config covers `convex/` and `test-utils/`, excluding `_generated` as an entry set. Neither command certifies the mobile/shared/worker projects or checks JavaScript bodies with `checkJs`.

## Review and remaining verification

Advisory Standards and Spec reviews found no blocking code defect. Their documentation corrections and SOURCED cash coverage suggestion were applied. They are not either formal money review seat. No `review-evidence` file was written.

Not run: the formal Opus and Codex seats, authenticated scripted E2E, roles × EN/AR × phone/desktop screen audit, unscripted explorer swarm, real-backend rehearsal, production contract-skew probe, CI/SonarCloud, build, deployment or production verification. Serial `convex-test` establishes harness behavior, not platform limits or concurrency. No push was made.

At the final fetch, main had advanced one commit to `644d785d78361c351b6fb9f1166da18bdfd3527d` (SCRUM-869 supplier statement). The requested base is retained. SCRUM-902's unmerged cost-gate changes also overlap these readers and must be integrated by the coordinator without widening cost or commission visibility. No deferred financial capability is enabled by this change.

## CI repair from 908679be (2026-11-04)

The repair started at the required full SHA `908679be89563b6b67caa4adfda7e15f432744f7`, on `claude/scrum908-deal-net-profit` in `E:\tmp\auto-908`. The fetched main was zero commits ahead of that checkout. The repair changes generated declarations and fixtures, with no production calculation, permission, guard or GL posting changes. Contract-skew baseline renewal remains the coordinator's task.

### Validated causes

- **Generated API:** the two new helper modules were missing from the imports and `fullApi`. `npx convex codegen --typecheck disable` completed successfully. Its four new declarations were retained; unrelated Windows ordering changes were undone to match CI's Linux ordering. [Convex documents committing generated API definitions and says codegen does not change deployed code](https://docs.convex.dev/cli/reference/codegen).
- **Cash cockpit:** the fixture supplied the accounting `profit` but omitted `managementNetProfit`, which the new headline correctly requires. This caused missing unavailable-reason labels, sale-price/cost/entitlement tiles and `null` text in the string assertions. The fixture now supplies a separate `MANAGEMENT_NET`, including both zero-valued deductions, or the scenario's original refusal reason. Sale-price, sign, cost, entitlement, no-number, unavailable-reason and no-placeholder assertions remain. Cash's new management note is required, both estimate badges remain forbidden, and the exact tile count includes the two new deductions. The no-breakdown case now explicitly empties the management net's lines. Scoped visible-tile queries are retained instead of broadening text matches, following [Testing Library's text queries](https://testing-library.com/docs/queries/bytext/) and [query scoping guidance](https://testing-library.com/docs/dom-testing-library/api-within/).
- **Financier/customer-obligation fixtures:** both roles already had `ALL_PERMISSIONS`; commission access and expense readability were not the failure. Both directly inserted sales without `commissionAmount`, so the management net correctly refused an undecided commission. The intended readable-profit scenarios now record an explicit zero commission. This is a fixture correction, not a claim that every real sale has decided commissions: real MANUAL sales can still have an unset amount and must still refuse. The SCRUM-908 pending-commission and no-permission controls passed with the production refusal unchanged. Settlement classification assertions in both repaired suites are unchanged.

The unchanged three-file reproduction ran with `--maxWorkers=1 --testTimeout=20000`: 185 tests, 172 passed and 13 failed (10 cockpit, one financier, two customer-obligation). This reproduces the reported failure classes, not CI's reported higher counts. After fixture updates, three more obsolete cash-contract expectations were exposed and corrected as described above. The final standalone cockpit-view run passed all 100 tests.

### Commands and results

All test commands used named files, `vitest run`, `--maxWorkers=1` and `--testTimeout=20000`. The backend enumeration scanned every top-level `convex/*.test.ts` for `dealOverview`, `sales.dealCockpit`, `dealCommissions`, or a direct `./sales` import. It selected these 21 files, all of which passed: **861 tests, zero failures or skips**.

```powershell
pnpm exec vitest run convex/cashApplicationFinancierLeg.test.ts convex/cashDealCockpit.test.ts convex/customerGapComposition.test.ts convex/dealCommissionLinesLedger.test.ts convex/dealCommissions.test.ts convex/dealCommissionsPilot.test.ts convex/dealCostsReadable.test.ts convex/dealerBorneExpected.test.ts convex/dealNetProfit.scrum908.test.ts convex/dealOverview.test.ts convex/dealReadsBoundedUnderLimits.test.ts convex/financedConsignedSettlement.test.ts convex/financierLegNotApplicable.test.ts convex/idempotencyEconomicCommands.test.ts convex/scrum486Certification.test.ts convex/scrum571s2CashSettlement.test.ts convex/scrum571s2CustomerObligation.test.ts convex/scrum761CashReceiptDoors.test.ts convex/scrum761FinancedCustomerShare.test.ts convex/scrum802CashSaleContainment.test.ts convex/unifiedDealFeeAuthority.test.ts --maxWorkers=1 --testTimeout=20000
```

The entire cockpit directory contains 60 test files, with no nested test files omitted. The normal run passed **1,681 tests**, with 36 pre-existing opt-in visual fixture generator cases skipped. The repaired view suite passed in this run as well as standalone.

```powershell
$files = Get-ChildItem components/applications/cockpit -Filter *.test.ts* -File | ForEach-Object { $_.FullName }
pnpm exec vitest run @files --maxWorkers=1 --testTimeout=20000
```

The three opt-in generator files were then rerun with their generation flags and fresh output directories. **110 tests passed, zero skipped**, including all 36 cases skipped by the normal run and 74 repeated controls. Across the two runs, all **1,717 unique cockpit cases** executed successfully. This generates markup; it does not establish browser layout correctness.

```powershell
$env:DEAL_COCKPIT_VISUAL_FIXTURE = '1'
$env:DEAL_COCKPIT_VISUAL_FIXTURE_DIR = 'E:/tmp/scrum908-fixtures-cockpit'
$env:DEAL_MONEY_VISUAL_FIXTURE = '1'
$env:DEAL_MONEY_VISUAL_FIXTURE_DIR = 'E:/tmp/scrum908-fixtures-money'
$env:FC_CHEQUE_VISUAL_FIXTURE = '1'
$env:FC_CHEQUE_VISUAL_FIXTURE_DIR = 'E:/tmp/scrum908-fixtures-cheque'
pnpm exec vitest run components/applications/cockpit/DealCockpitVisualFixture.test.tsx components/applications/cockpit/DealMoneyVisualFixture.test.tsx components/applications/cockpit/FcChequeVisualFixture.test.tsx --maxWorkers=1 --testTimeout=20000
```

The PR's own suites passed **310 tests in 13 named files**, with zero skips. The scoped coverage run measured the two new production helper files with the repository's thresholds unchanged: **39/39 lines (100%), 53/54 statements (98.14%), 52/53 branches (98.11%), 7/7 functions (100%)**. This measures both complete new helper files, not SonarCloud's entire PR new-code set.

```powershell
pnpm exec vitest run convex/dealNetProfit.scrum908.test.ts convex/utils/dealManagementNet.test.ts convex/dealOverview.test.ts convex/cashDealCockpit.test.ts convex/utils/dealerPreparationExpenses.test.ts convex/utils/stockManagementProfit.test.ts convex/utils/dealCommissionLines.test.ts components/commissions/DealCommissionsRow.test.tsx components/commissions/DealCommissionLinesDialog.test.tsx components/applications/cockpit/DealCockpitCanonicalProfit.test.tsx components/applications/cockpit/DealCockpitCustomerInvoice.test.tsx components/applications/cockpit/DealCockpitSupplierAuthority.test.tsx scripts/regression/scenarioRecord.test.ts --maxWorkers=1 --testTimeout=20000 --coverage --coverage.include=convex/utils/dealManagementNet.ts --coverage.include=convex/utils/dealProfitReads.ts --coverage.reportsDirectory=E:/tmp/scrum908-ci-coverage
pnpm typecheck
pnpm typecheck:convex
pnpm exec eslint components/applications/cockpit/DealCockpitView.test.tsx convex/financierLegNotApplicable.test.ts convex/scrum571s2CustomerObligation.test.ts
git diff --check
```

Both typechecks passed. Their scope exclusions remain as documented above. Root typecheck first caught two fixture-union typing errors, both corrected before the passing run. Lint passed with zero errors and four existing unused `_correction` warnings on untouched callback lines. The generated declarations are excluded by the repository's lint configuration. `git diff --check` passed. SonarJS 4.2.2 S3776, run through the local ESLint API at threshold 14, found no violations in the two new helpers or the three repaired test files. No suppression was added. Loading the complete local SonarJS profile was unavailable because its cached package lacks an analyzer configuration dependency; this is not a no-new-smell verdict. SonarCloud's full PR gate remains unverified until the coordinator pushes and CI runs.

The three bug hunters, browser rendering, a production build, real-backend rehearsal, independent money seats, push, CI, merge, deployment and production verification were not performed by this repair lane. `convex-test` results certify serial harness behavior only. No `review-evidence` file or protected containment/waiver file was edited. `.gitignore` and `.ignore` were already dirty at entry and are excluded from the commit.
