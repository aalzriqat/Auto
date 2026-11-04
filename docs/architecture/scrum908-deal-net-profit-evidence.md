# SCRUM-908 implementation evidence

## PR #772 round 4 at 544c1a05 (2026-11-04)

Required start: `544c1a05324c45c99dc91ceb624d08034ece6d43`, branch `claude/scrum908-deal-net-profit`, worktree `E:\tmp\auto-908`. Fetched main and merge base: `644d785d78361c351b6fb9f1166da18bdfd3527d`, zero commits behind. Both supplied seat files were read fully, then each finding was checked against current source and public-query controls. All three live PR comment surfaces were read; review/inline arrays were empty and CodeRabbit's conversation comment explicitly skipped automatic review. That is no CodeRabbit coverage.

### Findings and remedies independently validated

| Finding | Disposition and bounded remedy |
| --- | --- |
| Seat 2 HIGH; Seat 1 original-profit disclosure note | Accepted. Adopted PR #766's exact `CostAccessRequired` shape for application `money.profit` and `money.managementProfit`, and sale accounting `money.profit`, using `canReadVehicleCost`. Supplier party amounts also follow #766's null projection, preventing the same cost from escaping outside profit. Rest of finance money stays readable. No broader `containsVehicleCost` census/plumbing was imported. |
| Seat 1 cash commission-permission gap | Accepted. Same permission test now runs cash and financed; the cash `mayReadCommissions: true` mutant is killed. |
| Seat 1 deleted/foreign linked sale gap | Accepted. Public financed overview controls use STOCK to keep unrelated supplier-settlement refusal from masking the sale guard. Both fail if the guard becomes `if (!sale)`. |
| Seat 1 wrong refusal wording | Accepted. Missing/mixed STOCK cost basis returns `VehicleCostBasisUnreadable`; excess commission rows return `CommissionsReadBoundExceeded`. Corrupt/foreign/deleted commissions remain `CommissionsUnreadable`, with undecided pay still `CommissionsPending`. Each new reason renders in EN/AR for cash and financed. |
| Seat 1 pre-sale estimate label | Accepted, minimal remedy adopted. Commission working/tiles on a `MANAGEMENT_ESTIMATE` say registered to date in EN/AR, including before a sale exists. Amounts, zero-estimate behavior and SCRUM-879 contract are unchanged. |
| Seat 1 work-order PERIOD_EXPENSE finding | Deferred by explicit task scope; no work-order or posting change in this round. |

The ADR records the invariant, class, alternatives, consumers, lifecycle implications and five predicted failures. [OWASP's Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) and [Convex function authentication](https://docs.convex.dev/auth/functions-auth) were checked before changes. The server derives the role and projects each response; the UI is not the authorization boundary. Complete-response equality plus recursive wire-key/sentinel checks cover both cockpit readers, CASH/FINANCED × STOCK/SOURCED, finance without cost, explicit cost and owner without explicit grants. Verified financed sales still return `money: null` from the sale reader. STOCK's legacy application-only consignment profit remains `NoSupplierSettlement` for authorized roles; its canonical overview positive control still proves the STOCK net.

### Red, green and mutations

- Test/ADR commit `c627ec474bacf0aa8004724601767c01d80225d5` precedes production edits. Corrected first backend run: **7 failed / 36 passed**. Two earlier test setup/expectation errors (STOCK legacy consignment profit and nonexistent sale currency field) were corrected before treating failures as defect evidence.
- The scenario library refuses parameterized bindings. Local test-only commit `91ce0c8a4395fd27c904662a7be6c421423f705c` contains the final single active title, `SCRUM-908 complete cockpit responses withhold every cost projection`; it executes the same four-case nonempty bounded matrix. Re-running it and the refusal controls against the six unchanged production files from `544c1a05` produced **4 failed / 36 passed**; every production file was restored byte-for-byte. The scenario's `bugRef` names this test-bearing red SHA.
- Focused implementation run before matrix consolidation: **61/61** backend/component tests passed. After consolidation the backend suite has 40 test registrations; all four disclosure variants still execute. No assertion, gate, threshold or scenario was removed.
- The first broad 17-file run had **640 passed / 12 failed**. Those 12 were old cash accounting scenarios whose non-owner `FULL_PERMS` fixture lacked cost visibility. Added `view:cost_price` to that authorized calculation fixture only; kept `NO_FINANCE_PERMS` and every accounting/refusal assertion. The dedicated no-cost controls still require withholding. A separate library run caught the invalid `.each` scenario binding; the binding was corrected without loosening the validator.
- Final regression run: **649/649 passed in 17 named files, no skips**. Exact command below. Includes the full SCRUM-486 suite, library loader, cost/basis/overview/accounting compatibility checks and EN/AR components. This is serial `convex-test` and DOM evidence, not Convex platform, OCC or a rendered browser audit.

All mutations ran on actual source with named Vitest files and `--maxWorkers=1 --testTimeout=20000`; every file was restored from an in-memory byte copy in `finally`. Final test structure: cash permission mutant failed **1/40** (cash case); linked-sale `if (!sale)` mutant failed **2/40** (deleted and foreign); application cost gate forced true failed **1/40**; cash original accounting-profit gate forced true failed **1/40**; supplier null-formatting guard removed failed **2/18** EN/AR UI cases; new estimate-label helper forced to use the total label failed **4/18** EN/AR UI cases. All six mutants were killed by right-reason assertions, not setup errors. The mutated functions were `sales.dealCockpit`, `loadProfitCommissions`, `applications.dealCockpit`, `DealPartyFacts`, and `profitLineLabel`. A final restored-source backend/component run passed **58/58**.

```text
pnpm exec vitest run convex/dealNetProfit.scrum908.test.ts convex/utils/dealManagementNet.test.ts convex/dealOverview.test.ts convex/cashDealCockpit.test.ts convex/utils/dealFinancialSummary.test.ts convex/utils/dealerPreparationExpenses.test.ts convex/utils/vehicleCostBasis.test.ts convex/utils/stockManagementProfit.test.ts convex/dealCostsReadable.test.ts convex/scrum486Certification.test.ts components/applications/cockpit/DealCockpitCanonicalProfit.test.tsx components/applications/cockpit/DealFinancialOverview.test.tsx components/applications/cockpit/DealCockpitView.test.tsx components/applications/cockpit/DealCockpitCustomerInvoice.test.tsx components/applications/cockpit/DealCockpitSupplierAuthority.test.tsx components/commissions/DealCommissionsRow.test.tsx scripts/regression/scenarioRecord.test.ts --maxWorkers=1 --testTimeout=20000
```

`pnpm typecheck` and `pnpm typecheck:convex` passed after nullable-consumer and test-type corrections. Root config excludes `convex`, `test-utils`, `apps`, `packages`, `dealer-worker` and `node_modules` as entry sets; imported types can still be traversed. Convex config includes `convex/**/*` and `test-utils/**/*`, excluding `_generated` as an entry set. Neither command separately certifies mobile/shared/worker builds or `.mjs` scripts. ESLint on the 12 changed TS/TSX files: zero errors, seven warnings on unchanged source lines. No NOSONAR. Generated API needs no regeneration: no module or public export was added.

Author guard pass used `clean-code-guard`, `test-guard`, Convex/React review checklists and `/correct`'s behavior-test level. The repeated escape is recorded by the prior round's headline-only permission controls versus this round's independent original-profit/alias and supplier-balance disclosure. A broad new projection framework would conflict with the task's deliberately bounded #766 overlap; the complete-response regression closes this class here. Reuse/simplification review: existing cost predicate and bilingual dictionaries are reused, one label helper serves tiles/working, and null is handled at both display consumers. No new schema, writer, posting or report path.

### Contract baseline close-out

Source commit: `a3f199aef774ec178b360a2ee5a8c0961721036b`. `relocateBaseline.mjs --base 544c1a05324c45c99dc91ceb624d08034ece6d43 --write` proved and relocated 49 identical call expressions, zero refusals. The first evidence check then reported 95 stale entries, zero malformed/missing; their required files intersect exactly the changed `DealCockpit.tsx`, `applications.ts`, and `sales.ts`. Renewed only those 95 entries in 11 shards with committed blob pairs; preserved expiry, classification, cause, multiplicity, fingerprints, rationale and issue. The common renewal note describes this round's response projection and labels, not changed input validators. No argument validator or call payload changed.

Both required final checks passed:

```text
node scripts/contractSkew/renewBaselineReviewed.mjs --check-evidence --reviewed HEAD --pr-base 644d785d78361c351b6fb9f1166da18bdfd3527d
renewal evidence: 945 renewed entries checked, 0 unrenewed, 0 stale, 0 malformed, 0 missing
node scripts/contractSkew/checkBaselineIdentity.mjs
Call identity check: 945 baseline entries matched
```

This is freshness and call identity evidence, not independent review or live backend finding verification. `git diff 544c1a05 --exit-code` on `workOrders.ts`, `convex/accounting`, `reports.ts`, `customerCreditPayoutContainment.ts`, and generated `api.d.ts` is empty.

Unverified: fresh independent seats on the new head, CI/SonarCloud/new-code coverage, build, authenticated E2E, desktop/mobile EN/AR/RTL browser screens, screen audit/explorer swarm, real-backend execution, deployment and production. No watcher or dev server was started. Existing `.gitignore`/`.ignore` remain outside staging. Local commits only; no push, merge or deployment.

## PR #772 review fix round at d83326f0 (2026-11-04)

Started in `E:\tmp\auto-908`, branch `claude/scrum908-deal-net-profit`, at the required full SHA `d83326f0de3af48708a0fd30d3a6722f80e20d3d`. `git fetch origin` found zero commits in `HEAD..origin/main`. No main merge, push, deployment, accounting posting/report change, cash `money.profit` change, or containment-switch change is part of this round. Existing `.gitignore`/`.ignore` changes were left alone.

### Findings reproduced before their fixes

| Finding | Red evidence | Final behavior |
| --- | --- | --- |
| Cost permission | `dealNetProfit.scrum908.test.ts` returned cash `1,775,500` and financed `1,009,200`, including cost lines, to `view:sales` + `view:finance` + `view:commissions`. | Both management readers use `canReadVehicleCost`. Exact refusal is `{ available: false, reason: "CostAccessRequired" }`, with no amount or lines. CASH/FINANCED × STOCK/SOURCED controls also grant cost access and require the real positive amount. |
| Old financed backend | The component passed `2,110,000` to the commission slot with no `COMMISSIONS` line. After strengthening the test to render the real row, temporarily removing only the guard again produced one failure: visible `2,110 JOD` in that row. The source was restored byte-for-byte in `finally`. | The row receives null unless the headline carries `COMMISSIONS`. Its positive control keeps the server net unchanged. |
| Commission reason | The pending test received `CommissionsUnreadable`; three rendered-reason controls failed on the old EN wording/mapping. | Unset commission on a linked sale is `CommissionsPending`. Corrupt/capped/foreign/deleted evidence stays unreadable. Both reasons and the cost note are rendered in EN/AR on cash and financed screens. |
| Work orders | Two public `workOrders.create` → deal-read controls returned unavailable instead of `989,200` financed / `1,755,500` cash after a 20 JOD repair. Separate legacy STOCK/SOURCED link controls also failed before normalization. | Work orders record period treatment; linked legacy rows are recognized and deducted exactly once. Unknown rows, mismatched org/vehicle/amount, and truncated provenance remain unavailable. |
| Scenario provenance | The record test failed because `bugRef` named base `f119b20e5…`. `git show` of its named certification file contained no `SCRUM908-net-profit` test. | This ruling-driven preventive scenario has no `bugRef` and retains the current certification test title. The full library-loader suite passes. |

The initial combined backend run also had an overly specific new assertion on the unknown-legacy refusal reason. STOCK correctly returned `NoVehicleCost`, rather than `PreparationExpensesUnreadable`; that assertion was corrected to the required unavailable state. This was a test expectation error, not separate defect evidence.

### Work-order treatment and historical provenance

The expense has no direct work-order field. Its durable provenance is the inverse `workOrders.expenseId` link. `git log -p HEAD --follow -- convex/workOrders.ts` enumerated all 11 file revisions reachable from this branch: `02f20d103`, `63a4ac185`, `2d669e52b`, `ce92f3009`, `faf3e9b15`, `db145e31d`, `68b74964b`, `29f9dcc17`, `6c64d1ddb`, `976d59357`, `13cd04829`. The introducing version inserts the expense and stores its id on both create and completion-via-update; the intervening diffs retain those assignments. This is repository-history evidence about this writer, not a production-data census.

The GL hook was introduced at `faf3e9b15`. Current `createWorkOrderExpense` calls `hookExpensePosted` without `capitalizeToInventory`, `vehicleId`, `isPrepaid`, or `category`. `convex/accounting/workflowHooks.ts:1450` forwards that posting payload. `classifyExpensePosting` at `convex/accounting/postingRules.ts:2069` requires an explicit capitalization flag plus a vehicle id, so this payload is neither capitalized nor prepaid. `ruleExpensePosted` at line 2079 selects `expenseAccountKeyForCategory(undefined)`, whose default at line 737 is `GENERAL_EXPENSE`. Therefore the recorded treatment is `PERIOD_EXPENSE`; neither the hook nor posting rule was edited.

Both management readers now share the bounded expense loader. Only an absent treatment on a REPAIR row with no prepaid/capitalized metadata, a same-org/same-vehicle work-order link, and a matching amount is normalized in memory. No historical document is rewritten. Both indexed reads use a 200-row bound plus a sentinel. A truncated provenance read supplies no inferred treatment. Explicit stored treatments win. Existing live/deleted/reversed/bearer rules still decide whether the period expense is deducted.

### Checks and limitations

The main named run with coverage collection executed 396 tests in 13 files, all tests passed, with no skips. After strengthening the final cash/financed EN/AR assertions, the three touched suites ran again: 109/109 passed, exit 0. The main run includes the five SCRUM-908 suites, the complete SCRUM-486 certification suite, all three touched test files, and work-order/cost-basis/commission compatibility controls:

```powershell
pnpm exec vitest run convex/dealNetProfit.scrum908.test.ts convex/utils/dealManagementNet.test.ts convex/dealOverview.test.ts convex/cashDealCockpit.test.ts convex/utils/dealerPreparationExpenses.test.ts convex/scrum486Certification.test.ts convex/workOrders.test.ts components/commissions/DealCommissionsRow.test.tsx components/applications/cockpit/DealCockpitCanonicalProfit.test.tsx scripts/regression/scenarioRecord.test.ts convex/utils/vehicleCostBasis.test.ts convex/utils/stockManagementProfit.test.ts convex/dealCostsReadable.test.ts --maxWorkers=1 --testTimeout=20000
```

`pnpm typecheck` and `pnpm typecheck:convex` passed. The root command excludes `convex/`, `test-utils/`, `apps/`, `packages/`, and `dealer-worker/` as entry sets; the Convex command checks the backend and test utilities. Initial new-test type errors were fixed before the passing runs. ESLint on all 11 changed TS/TSX files reports zero errors and seven warnings on pre-existing source. No `NOSONAR` was added.

Local SonarJS 4.2.2 S3776 measured the financial helpers at complexity 1–9. The new expense loader measures 2; its predicates measure 1–2. The complete plugin profile could not load its cached `@sonarsource/analyzer-commons-configurations/secret-patterns.json` dependency, so no full-profile or SonarCloud no-new-smell claim is made.

The same 396-test run collected V8 coverage for `dealProfitReads.ts`, `workOrders.ts`, `sales.ts`, `dealOverview.ts`, and `DealCockpit.tsx` using repeated `--coverage.include=<file>` plus `--coverage --coverage.reportsDirectory=$env:TEMP/scrum908-fix-coverage`. No threshold was overridden. Tests passed, but this scoped whole-file measurement exited 1: 28.48% lines, 27.74% statements, 29.29% branches, 23.39% functions, below the existing 90/90/75/85 thresholds for those large legacy files. It is not a passed repository coverage gate. A separate nonempty LCOV/new-line intersection against `d83326f0…` measured 14/14 executable points covered: 12 in `dealProfitReads`, one in `dealOverview`, and one in `DealCockpit`. The added sales/work-order object properties have no separate V8 line point and receive no independent line-coverage claim; public-query tests exercise their behavior. This local measurement does not certify SonarCloud's new-code set.

The supplied relocation command with `--base 644d785d78361c351b6fb9f1166da18bdfd3527d --write` refused all 49 shifted entries because their prior sites already refer to the PR version. Re-running with the verified starting `d83326f0…` proved 49 identical-call relocations, zero refusals. `checkBaselineIdentity.mjs` matched all 945 entries. Renewal uses committed source blob evidence, retains each entry's UNKNOWN classification and expiry, and is freshness evidence only.

Implementation commit: `362148de9960c60626abd772cec2581bd6ddb039`. Its changed source blobs made 89 entries stale. Renewed those 89 entries in nine CRLF shards, without changing expiry, classification, cause, fingerprint, multiplicity, rationale or issue; the only entry fields changed are call-site coordinates and renewal text. After renewal, `node scripts/contractSkew/renewBaselineReviewed.mjs --reviewed c82890bd --check-evidence --pr-base 644d785d78361c351b6fb9f1166da18bdfd3527d` exited 0: 945 checked, zero stale/malformed/missing. `node scripts/contractSkew/checkBaselineIdentity.mjs` exited 0 with 945 matches. These checks establish freshness and call identity, not independent certification or backend finding identity.

Optional work deferred to SCRUM-879: the unused preparation cutoff argument/always-zero counter, and the unlinked-sale zero commission estimate. Trying the latter exposed eight existing overview scenarios whose estimation contract needs separate revision; their assertions were preserved and the optional behavior change was restored. No tests or gates were weakened.

Author review used `clean-code-guard`, `test-guard`, and the financial invariant checklist. Five failure modes checked were cost inference through the remaining headline, double commission deduction, work-order capitalization/double deduction, forged or truncated legacy provenance, and pending amounts reported as zero/unreadable. The implementing session is neither review seat. Fresh exact-head seats, CI/SonarCloud, authenticated three-hunter checks, desktop/mobile visual verification, real-backend execution, build and deployment remain unverified. DOM rendering covers the EN/AR notes; no dev server was started under the workstation rule. `convex-test` proves serial harness behavior, not Convex platform or concurrency behavior.

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
