# SCRUM-476 / PR 823: browser evidence correction

Lane 823f, based on `73201e0e922e7cf8daa0c3c278d9dff6fb77c8a5`.
These are offline Chromium fixture measurements, not authenticated or backend
certification.

## Full pre-fix control

Temporarily substitute
`8c0313e733513cc306394e9f901191079a014d77:components/sales/SaleDialog.tsx`
and run:

```powershell
pnpm exec playwright test -c playwright.visual.config.ts playwright/visual/sale-cancellation.visual.spec.ts --workers=1
```

Measured 2026-11-16 before changing the assertions: **exit 1, 12 failed / 4
passed** (1.6 minutes). Status-only cancellation, legacy-native cancellation and
localized refusal each fail four cases. The four ordinary-edit controls pass.
Restore the original source bytes in `finally`.

The earlier `red-476b-receipt.txt` ran a filtered command selecting only
`cash cancellation|legacy warranty cancellation`: its **8 failures among 8
selected tests** are accurate for that subset. That receipt does not establish
the failure count of the complete 16-case replay. Use **12 failures / 4 passes**
when describing the full base-main control. The new full receipt is
`base-main-823f.txt` in the coordinator handoff artifacts; the earlier receipt
remains historical evidence for its recorded command.

The 16 scenario records contained no failure-count claim. Their literal
`impl.testName` bindings and steps are unchanged; their expectations now also
name the dialog, sale-price control and action-row directions, dialog horizontal
overflow, and dialog horizontal viewport containment.

## Direction and containment assertions

The original helper checked `document.body` direction. A temporary
`<DialogContent dir="ltr" ...>` passed the original `--grep ar` command:
**exit 0, 12 passed**, including all eight Arabic cases. The broad filter also
selects four English titles containing `ar`.

The helper retains the page-direction, page-overflow and Save-button bounds
checks. It additionally checks computed direction on the real dialog, the
sale-price input inside it and the Save button's action row, with literal
`rtl`/`ltr` expectations. It checks internal dialog overflow and the dialog's
horizontal bounds because page overflow and button bounds alone can pass
while a fixed, scrollable dialog clips content or extends outside the viewport.

These use Playwright's [computed CSS assertion](https://playwright.dev/docs/api/class-locatorassertions#locator-assertions-to-have-css)
and [retrying assertions](https://playwright.dev/docs/test-assertions), including
`expect.poll` for geometry. No fixed sleep was added. The existing
`rt11-landed.visual.spec.ts` supplies a local element-scoped precedent;
existing project code alone is not proof of quality.

Other visual specs containing ancestor-direction checks were inspected and
reported in `report-823f.md`; they were not changed in this PR lane.

## Targeted negative controls

All mutations were temporary and restored in `finally`; source and spec bytes
were compared with their saved originals after each run. Commands use the same
config, spec and `--workers=1` shown above, with the following `--grep` filters.

| Mutation | Filter | Exit | Result |
|---|---|---|---|
| Dialog forced LTR, corrected assertions | ` · ar · ` | 1 | All 8 Arabic cases fail on dialog direction |
| Dialog forced RTL, corrected assertions | ` · en · ` | 1 | All 8 English cases fail on dialog direction |
| Dialog forced LTR, new direction block removed | ` · ar · ` | 0 | All 8 Arabic cases pass |
| Price input alone forced LTR | `cash cancellation sends only status intent · ar · 390px$` | 1 | 1 failure on price-control direction |
| Action row alone forced LTR | Same one-case filter | 1 | 1 failure on action-row direction |
| Internal 2000px logical-start child, original assertions | Same one-case filter | 0 | 1 pass despite measured 1612px dialog overflow and 0px page overflow |
| Same overflowing child, corrected assertions | Same one-case filter | 1 | 1 failure on dialog overflow, received 1612px |

The geometry experiment measures real browser dimensions. The source of the
extra child is a temporary mutant, not shipped application markup.

## Restored-tree checks

| Command | Exit | Measured result |
|---|---|---|
| Full Playwright command above | 0 | 16 passed (30.3s) |
| Same config, `playwright/visual/supplier-navigation.visual.spec.ts --workers=1` | 0 | Unchanged 4 passed (9.5s) |
| `pnpm exec playwright test -c playwright.visual.config.ts --list` | 0 | Unchanged 582 tests in 20 files; complete listing matches after normalizing source coordinates |
| `pnpm exec vitest run scripts/regression/scenarioRecord.test.ts --maxWorkers=1 --reporter=verbose` | 1 | 68 passed / 2 failed; both failures are sandbox EPERM creating sibling fixture directories under `E:/tmp` |
| `pnpm exec eslint playwright/visual/sale-cancellation.visual.spec.ts --max-warnings=0` | 0 | No warnings or errors |
| `pnpm typecheck` | 0 | Root `tsc --noEmit`; excludes `convex`, `apps`, `packages`, `dealer-worker` and `test-utils` as compilation roots |

The full scenario-record suite remains failed and needs a coordinator rerun
with the required filesystem access. Its two unavailable fixture executions
are not waived by the passing metadata checks. No test timeout override,
watcher, application server, local backend or production access was used.
