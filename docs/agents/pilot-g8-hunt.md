# SCRUM-760 G8: Deals, Sales and Accounting hunt

2026-10-28 · implementer worktree `C:/tmp/auto-g8` · branch
`codex/scrum760-g8-deals-sales-hunt` · base `f5b5332999351fd800143b4798f57468f5e24a97`.

This is an executable hunt plan and an evidence ledger. It is not a passed G8
certificate. New browser journeys have not run in this lane: the owner prohibits
local Playwright, and the coordinator owns pushing, workflow execution and review.
Use only the seeded QA dealership on disposable Convex previews. Bloom Cars is
the business scope, not a source of test data.

## RECEPTION 0/136: what the evidence establishes

Read through the GitHub connector on 2026-10-28:

| Run | RECEPTION job | Public result | Preview cleanup |
| --- | --- | --- | --- |
| [40281850794](https://github.com/aalzriqat/Auto/actions/runs/40281850794), 2026-10-26, 8f7f65c3 | 121436680724 | FAILED, 0/136, isolation false | completed |
| [40462525127](https://github.com/aalzriqat/Auto/actions/runs/40462525127), 2026-10-27, f934adf1 | 122050214604 | FAILED, 0/136, isolation false | completed |
| [40648593449](https://github.com/aalzriqat/Auto/actions/runs/40648593449), 2026-10-28, 2e7ea58c | 122683115522 | SUCCEEDED, 136/136, complete true, isolation true | succeeded |

The latest run's six role jobs succeeded. Its RECEPTION log explicitly reports
`visualReview: UNAVAILABLE_UNTIL_LOCAL_DECRYPT_AND_INSPECTION`.

The denominator is 34 routes × two locales × two widths (375 and 1440), not 136
independent backend authorization probes. `playwright.role-audit.config.ts` makes
the route matrix depend on `role-regressions`; a failed login or any prerequisite
role test prevents the matrix from running. `roles.spec.ts` writes a cell only
after the route, membership, readiness, navigation and capture checks finish.
`publicAuditSummary` counts those files. Zero cells therefore means no completed
route evidence, not 136 denied pages. `requireReadyScreen` already rejects busy
attributes, skeletons, English/Arabic loading text, empty shells, raw values and
wrong destinations. None of those assertions was relaxed.

**Causal classification remains UNRESOLVED.** The small failed-run artifacts
contain encrypted `browser.log` and `role-results.json`. Public logs expose no
failing title, readiness assertion or stack. Both shell GitHub access and the
connector artifact-download URL were blocked by sandbox network permissions.
The later success disproves a persistent failure at that later revision; it does
not distinguish an earlier product defect from an authentication/harness failure.
No speculative RECEPTION fix or fabricated failing-first reproduction is included.

Coordinator diagnosis (private local directory, never upload decrypted files):

```powershell
gh run download 40462525127 --repo aalzriqat/Auto --name pilot-role-audit-RECEPTION --dir <private-run-directory>
gpg --output <private-run-directory>/evidence.tar --decrypt <private-run-directory>/role-evidence.tar.gpg
tar -tf <private-run-directory>/evidence.tar
```

Use the existing local recipient key/agent; do not export a key. Inspect the
archive's `browser.log` and `role-results.json` privately. Record the first failing
prerequisite and whether the route cases were blocked. Repeat for 40281850794.
A harness cause needs its causal red/green test; a product cause gets a failing
product test and a separate product lane. G8 stays open until this is resolved.

## Cell ledger

Each role cell below lists **EN desktop / AR desktop / EN phone / AR phone**.
Desktop is 1440×900. New phone probes are 320×812, the WCAG reflow width;
historical 375×812 execution is recorded separately. These are web viewports,
not the excluded mobile application.

- **C**: an executed, completed route evidence cell at the historical SHA, not a
  visual or money certificate.
- **U**: not covered by executed evidence for this plan today. Added code is U
  until CI executes it. Every new 320px cell is U.
- **A**: actual role audit, `audit-role-access.spec.ts` plus the existing route matrix.
- **S**: scripted E2E, `pilot-scripted` project, `deal-scenarios.spec.ts`, and `pilot-sourced.spec.ts`.
- **E**: unscripted explorer, twelve independent 40-step walks, one Playwright
  test per start (three workspaces × two locales × two widths), each with its own
  page, locale script, timeout and derived seed. It records observations and
  findings; advisory findings are not a correctness verdict.

For an allowed page A requires settled content. A restricted role must see the
explicit localized denial, with no page exception. Each role retains its actual
product template; no extra grant is added to make a test pass. The existing
public owner-only mutation and two-direction tenant probes are retained.
The new UI tests assert paint/refusal, not backend permission dominance.

| Screen or state | Hunters | OWNER | MANAGER | SALES | RECEPTION | ACCOUNTANT | SENIOR_ACCOUNTANT |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Deals list | A,S,E | C/C/U/U | C/C/U/U | C/C/U/U | C/C/U/U | C/C/U/U | C/C/U/U |
| Sales workspace | A,S,E | C/C/U/U | C/C/U/U | C/C/U/U | C/C/U/U | C/C/U/U | C/C/U/U |
| Accounting Overview | A,E | C/C/U/U | C/C/U/U | C/C/U/U | C/C/U/U | C/C/U/U | C/C/U/U |
| Receivables: claims | A | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U |
| Collections: receivables | A | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U |
| Collections: cheques | A | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U |
| Collections: payment links | A | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U |
| Collections: cash drawer | A | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U |
| Collections: payments | A | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U |
| Collections: reports | A | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U |
| Collections: approvals or authority-based absence | A | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U |
| Cash and bank | A | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U |
| Journal: register | A | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U |
| Journal: manual journal OFF notice | A,S | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U |
| Reconcile and close reader | A | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U |
| Statements: trial balance | A | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U |
| Statements: income statement | A | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U |
| Statements: balance sheet | A | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U |
| Statements: VAT return reader | A | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U |
| Assets: fixed-assets OFF reader | A | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U |
| Assets: prepaids | A | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U |
| Assets: equity | A | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U |
| Accounting settings reader | A | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U |
| Sales: CASH entry panel | A,S,E | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U |
| Sales: configured FINANCED entry panel | A,S,E | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U |
| Owned CASH draft detail, linked from Deals | A | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U |
| SOURCED CASH draft detail, linked from Deals | A | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U |
| Owned configured-financier application detail | A | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U |
| SOURCED configured-financier application detail | A | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U | U/U/U/U |

Each row describes all four stated display cells for each of the six roles;
`PILOT_ACCOUNTING_VIEWS` enumerates the 21 Accounting states, including Overview.
The role fixture creates four synthetic draft/application rows through public
APIs as OWNER, then the audited seat follows the real list links or checks denial.
It does not complete those fixtures or claim their monetary correctness.
New captures remain encrypted under the existing pinned recipient. The public
summary still measures 136 top-level cells and now requires all seven real-role
journey tests, instead of four. Do not report 136 as the new subview denominator.

**Project structure (role audit).** The four original role tests stay in
`role-regressions`, which the 136-cell route matrix and the tenant-isolation test
(`chromium`) still depend on, exactly as on `main`. The three G8 journeys carry
the `@pilot-g8` tag and run in a separate `pilot-g8-role-hunt` project (same spec
file, `grep` on the tag; `role-regressions` takes the inverse `grepInvert`).
Nothing depends on `pilot-g8-role-hunt`, so a red G8 journey cannot skip the matrix
or the isolation test. Its only dependency is `setup`, the same depth as
`role-regressions`; Playwright finishes one dependency phase before starting the
next, so it still completes before the matrix isolates the audited seat.
`scripts/pilotG8Coverage.test.ts` pins these facts. A red G8 journey still fails
the run (Playwright exits non-zero), and `scripts/pilotRoleAuditEvidence.mjs`
counts each of the seven cases under the project that must have run it, so a
missing, skipped, duplicated or wrong-project case is not `complete`.
The Accounting traversal scopes every inner-tab lookup to the panel opened by the
previous step (the section's own panel first) and asserts that the requested
section mounted, because the section navigation also has a `receivables` trigger.

The role audit covers every role's UI access/refusal cells. Financial progression
uses only authorized actors and keeps separation of duties; a receptionist is
not asked to finalize a sale. Explorer mutation/race/tenant authority evidence is
separately provided by the trusted attack swarm, not inferred from a UI denial.

## Journeys and permanent checks

| Journey / inputs | Hunter and executable check | Today | Regression binding |
| --- | --- | --- | --- |
| Owned CASH, full 15,000 cash deposit then Submit Sale, open sale cockpit | S: existing `sales.spec.ts`, now selected by `pilot-scripted`; assertions shared unchanged in `fixtures/cashSale.ts` | U in this hunt | g8-owned-cash-delivery-screen |
| Owned configured finance: quotation, independent approval, handover, costs reconciliation, finalize | S: existing `financed-deal-economics.spec.ts`; full literal ledger/deposit/payment variations remain in `deal-scenarios.spec.ts` | U in this hunt | g8-owned-financed-delivery-screen |
| SOURCED CASH: price 12,500, supplier cost 10,000, full deposit, through dealership, completion and cockpit | S: `pilot-sourced.spec.ts`; literal receipt, agency sale and deposit-application journals | U | g8-sourced-cash-delivery-screen + g8-sourced-cash-agency-certification |
| SOURCED configured finance: approved 12,500, first payment 1,250, no deposit/contribution, through dealership; delivery, finalization, full bank receipt, reload | S: `pilot-sourced.spec.ts`; sale Dr1210 12,500 / Cr2400 10,000 / Cr4170 2,500; receipt Dr1110 / Cr1210 12,500 | U | g8-sourced-financed-delivery-screen + g8-sourced-financed-agency-certification + g8-sourced-financier-receipt-certification |
| SOURCED configured finance, same figures, direct to supplier; delivery, finalize, external supplier advice | S: `pilot-sourced.spec.ts`; Dr1240 / Cr4170 2,500, then no dealership journal for the 12,500 external advice | U | g8-sourced-direct-financed-delivery-screen + g8-sourced-direct-agency-certification |
| All Accounting readers and restricted entry states, each real role | A: new traversal, settled panel, localized authority, page reflow and capture | U | g8-accounting-workspace-traversal |
| CASH/configured-finance entry panel, each real role | A: new entry traversal | U | g8-sales-mode-entry |
| Four owned/SOURCED cash/finance draft/detail links, each real role | A: new list-to-cockpit traversal | U | g8-deals-list-to-detail |
| Separate exploratory walks on Deals, Sales and Accounting | E: twelve named pilot tests, one per route, locale and width (`pilot explorer <route> <en\|ar> <desktop\|phone>`), existing action filters and backend attestation retained | U | twelve records `g8-explorer-<route>[-<locale>-<width>]`; the EN desktop walk of each route keeps the plain id `g8-explorer-deals`, `-sales` or `-accounting` |

The 24 G8 records comprise 4 money records and 20 screen records, counted from
`regression/scenarios/**/g8-*.scenario.json`. The four money records bind
public-API tests in `convex/scrum486Certification.test.ts`: three agency cases
use oracle row `SCRUM-760-G8-SOURCED`, and the financier receipt case uses
`SCRUM-760-G8-SOURCED-RECEIPT`.
They use independently written figures; a `convex-test` success is harness
execution, not platform or concurrency proof. Browser records bind exact active
test names. Fingerprints and ruling digests use the existing validator.

The form explorer remains enabled for the full dispatch and retains its
side-effect observations. Existing assertions in the ledger matrix, screen audit
and trusted attack swarm remain. The original random walk also remains,
starting on Dashboard at the default viewport and locale with its base seed, as on
`main`. The twelve pilot walks derive their own seeds from that base seed and the
start's title (recorded in each test's `seed` annotation and report), so a
failing seed reproduces from the base seed alone. The titles are literals because
a scenario record binds to exactly one active, non-parameterized test title;
`scripts/pilotG8Coverage.test.ts` requires them to equal `pilotExplorerStarts()`.
Missing preview/identity evidence now fails the random explorer. Missing second
identity now fails the owned financed journey, instead of silently omitting it.

### Excluded doors and separate certification

Supplier payable payment, consignment margin receipt and cost-recovery receipt
are **in pilot scope and must be certified**, tracked under SCRUM-869. See
[SCRUM-869 c23881](https://autoflowdealer.atlassian.net/browse/SCRUM-869?focusedCommentId=23881)
and [SCRUM-760 c23882](https://autoflowdealer.atlassian.net/browse/SCRUM-760?focusedCommentId=23882).
Their reversal and correction doors remain excluded and need server-side block
evidence. This G8 hunt does not replace SCRUM-869 certification.

Keep customer receipt/refund payouts, manual journals, fixed-asset lifecycle and the
RT11 closed doors blocked. New reader traversal never clicks a financial commit.
The scripted accounting witness retains its manual-journal create refusal;
legacy approve refusal remains in its existing seeded trusted-main lane.
The existing backend containment suites and SCRUM-486 rows remain the authority
for each server-side block; a disabled control is not proof of a backend block.

Completed-sale cancellation/unwind and acquisition-cost corrections are governed
by current SCRUM-760 rulings and PR #696, not by the older decision-B shorthand.
Their certification, G9/G10 supplier identity/settlement, broader supplier costs,
all deposit/gap/tender combinations, and exhaustive backend permission dominance
remain separate gates. This bounded G8 hunt does not certify those gates. The
existing cancellation scenarios are retained even if a deferred payout makes
them red; do not reinterpret a red or skipped scenario as coverage.

## Seat 1 remediation evidence, 2026-10-29

The missing through-dealership financier receipt now has a public-API backend
test, money record and `SCRUM-760-G8-SOURCED-RECEIPT` oracle row. Expected
amounts come from the worked G8 example and SCRUM-407 c21031: receipt
Dr1110 / Cr1210 12,500 JOD each; supplier payable remains 10,000 and agency
revenue remains 2,500. No production behavior changed.

Each command below ran alone with `--maxWorkers=1`:

| Run | Command after `pnpm exec vitest run` | Observed result |
| --- | --- | --- |
| Red before adding the backend test | `scripts/regression/scenarioRecord.test.ts --maxWorkers=1` | 1 failed, 61 passed. The new record's exact backend test name was absent. |
| Initial backend control | `convex/scrum486Certification.test.ts --maxWorkers=1` | 60 passed, including the new receipt test. |
| Temporary posting mutation | `convex/scrum486Certification.test.ts --maxWorkers=1 -t 'SOURCED through dealership × full financier bank receipt'` | 1 failed at the exact journal comparison: both receipt legs were 12,499,000 minor instead of 12,500,000. The other 59 tests were filtered out. |
| Restored backend | `convex/scrum486Certification.test.ts --maxWorkers=1` | 60 passed; no skipped tests. |
| Green records | `scripts/regression/scenarioRecord.test.ts --maxWorkers=1` | 62 passed. |
| Green G8 coverage | `scripts/pilotG8Coverage.test.ts --maxWorkers=1` | 5 passed. |
| Green role evidence validator | `scripts/pilotRoleAuditEvidence.test.ts --maxWorkers=1` | 40 passed. |

The mutation subtracted 1,000 minor from both lines in `ruleFinanceCashReceived`,
preserving balance so the new test had to detect the wrong amount. A `finally`
restored `convex/accounting/postingRules.ts` byte for byte before the full green
run. No mutation is committed. The three SOURCED browser records retain their
screen outcomes and state all journals asserted by their replays. The direct
finance record includes sale Dr1240 / Cr4170 2,500 JOD and an empty journal for
the external supplier advice.

The test uses public mutations and the existing schema-backed harness, following
the [official Convex testing guidance](https://docs.convex.dev/testing/convex-test).
`pnpm exec tsc -p convex/tsconfig.json --noEmit` also passed, checking the Convex
project. The root application typecheck was not run.
This is local harness evidence. Browser hunters, real-backend rehearsal and
independent review of the new head remain required; these runs certify none of
those gates.

## Coordinator workflow dispatches

These commands are a handoff, not commands executed in this lane. Merge through
normal review first: both main-only hunter workflows refuse this feature branch.
Record the exact resulting `main` SHA and the SHA reported by every run; if main
moves between dispatches, the runs do not certify one common candidate.

```powershell
gh workflow run pilot-role-audit.yml --repo aalzriqat/Auto --ref main
gh workflow run deal-scenarios-e2e.yml --repo aalzriqat/Auto --ref main -f form_explorer=true
```

The first dispatch covers six actual roles, the 136 legacy cells per role and
all seven prerequisite journeys. The second covers the three existing scripted
witnesses, full retained ledger matrix, new SOURCED witnesses, the screen audit,
12 pilot explorer walks, form exploration, cross-screen checks and opening proof.
The increased 180-minute job ceiling accommodates those added walks at one
worker. Both create/attest/seed disposable previews with `--preview-create` and
retain their cleanup steps. Inspect cleanup and measured evidence, not just the
job conclusion. No production deployment is part of these commands.

**`browser-attack-swarm.yml` has no manual dispatch.** Its fixed trigger is a
successful `pull_request` run of `playwright.yml` on a same-repository PR; the
trusted main controller then builds the exact tested candidate, provisions its
own disposable preview and runs impact-selected attack workers. The coordinator
opens the normal PR and lets that trigger run, then verifies the tested merge
SHA, worker/mission inventory, artifacts, verdict and cleanup. A docs-only skip
or zero workers does not count. Do not invent a `gh workflow run` invocation for
this controller and do not weaken its trigger to run branch code with secrets.
Do not manually dispatch either main Playwright workflow (duplicate-result gate).

Optional manual exploration uses the existing preview workflow:

```powershell
gh workflow run hunt-preview.yml --repo aalzriqat/Auto --ref main -f action=create
# For each role, use only the deployment printed by create:
gh workflow run hunt-preview.yml --repo aalzriqat/Auto --ref main -f action=set-role -f deployment=<preview-name> -f seat=approver -f role=RECEPTION
# Repeat set-role with OWNER, MANAGER, SALES, ACCOUNTANT, SENIOR_ACCOUNTANT as needed.
gh workflow run hunt-preview.yml --repo aalzriqat/Auto --ref main -f action=delete -f deployment=<preview-name> -f created_at=<createTime>
```

That workflow provisions/re-roles/deletes; it does not run hunters. Never point a
local browser at a production-backed Vercel preview. Confirm the served Convex
socket is the attested preview before interacting. The two automated dispatches
plus the PR-triggered attack swarm are the full automated run set; there is no
single existing workflow dispatch that runs all three controllers.

## Design sources and evidence boundary

- [Playwright auto-waiting](https://playwright.dev/docs/actionability) and
  [retrying assertions](https://playwright.dev/docs/test-assertions): retain
  observable readiness/selected-panel assertions; never replace them with sleep.
- [Playwright project dependencies](https://playwright.dev/docs/test-projects#dependencies):
  a project that nothing depends on cannot skip other projects when it fails.
  In `playwright.scenarios.config.ts` the new `pilot-scripted` project depends only
  on `setup` and is listed after `chromium` (the ledger matrix keeps its original
  dependencies); in the same phase at one worker the matrix therefore runs first.
  Role-specific execution stays separate from the seeded approver's broader
  scripted authority.
- [Playwright page.addInitScript](https://playwright.dev/docs/api/class-page#page-add-init-script):
  the order of several init scripts is not defined, so each locale cell uses its
  own page from `BrowserContext.newPage` with one script.
- [WCAG 2.2 reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html): add
  320 CSS-pixel probes and fail page-level horizontal overflow. Scrollable tables
  are permitted; this check is not a complete WCAG conformance audit.
- [W3C HTML direction](https://www.w3.org/International/questions/qa-html-dir):
  assert `html[lang]` and semantic `dir=rtl` for Arabic.
- [OWASP WSTG authorization testing](https://wstg.owasp.org/v4.2/4-Web_Application_Security_Testing/05-Authorization_Testing/02-Testing_for_Bypassing_Authorization_Schema/):
  use actual roles and public operations, preserve positive controls and foreign
  tenant probes. UI visibility never substitutes for server-side authorization.

No production data, credentials, switches or product implementation changed.
No product defect is reproduced by this lane. RECEPTION's earlier cause and
new browser execution remain unavailable; source inspection and typechecking do
not close them. Independent seats and CI are coordinator-owned and pending.


## Local validation and coordinator handoff

Risk: HIGH, because hunter selection and completeness claims affect the pilot
gate even though no product source changes. The coordinator owns both independent
seats, CodeRabbit, CI and PR publication. No review seat is claimed here.

| Check | Observed result |
| --- | --- |
| Failing-first coverage contract, `pnpm exec vitest run scripts/pilotG8Coverage.test.ts --maxWorkers=1` | Before explorer wiring: 1 failed / 1 passed. Failure: actual explorer source did not call `pilotExplorerStarts`. This measures configuration consumption, not browser execution. |
| Final G8 + role workflow tests, named two files, one worker | 18 passed. Includes explicit project dependency closure, the 12-start manifest and 21-reader inventory. |
| Native audit evidence suite, `scripts/pilotRoleAuditEvidence.test.ts`, one worker | 39 passed, including encryption/decryption, exact seven-case census and refusal of missing/skipped/duplicate cases. |
| Round 2 (project split, per-start explorer, scoped tabs), one worker | `pilotG8Coverage`, `pilotRoleAuditWorkflow`, `explorerProductionGuard`, `playwrightContainedContext`, `convexCredentialBoundary`, `scenarioRecord` (incl. the 12 explorer records): 108 passed. `pilotRoleAuditEvidence` (`os.tmpdir()`): 40 passed. Scratch `tsc` over the changed specs, configs and tests, and ESLint on them: clean. Browser behaviour of the scoped tab lookups is unexecuted (no local Playwright). |
| Full regression validator suite, initial named run | 60 passed; 2 failed with EPERM creating `C:/tmp/scenario-read-*` and `scenario-fresh-*`, outside writable roots. This is not a green full-suite result. |
| Committed-library validation after adding records | Initially red for an overlong token and the existing financed spec's conditional omission; corrected token inputs and mandatory second-identity prerequisite. Final committed-library tests: 2 passed, 60 other tests filtered by `-t`. All 14 new records validate. |
| Selected certification bindings, `convex/scrum486Certification.test.ts`, one worker | 3 passed, 56 other tests filtered by `-t`; in-memory harness only, no real-backend or concurrency claim. |
| `pnpm exec tsc --noEmit --pretty false` | Passed. Root TypeScript configuration excludes `convex/`; no Convex source was edited and no Convex typecheck is claimed. |
| ESLint, named changed TS/MJS files | Passed. |
| `git diff --check` | Passed. |
| Playwright / production build / new CI runs | Not run; local browser execution prohibited, CI and reviews coordinator-owned. |

The native evidence fixture creates its temporary directory under
`os.tmpdir()` (the Node standard). An earlier revision of this branch placed it
inside the worktree because that author's sandbox could not write elsewhere (see the
EPERM note in the table above);
`main` used the worktree's parent directory. Synthetic key material still stays in
its private temporary keyring and is cleaned by the existing bounded cleanup.
No real recipient key was read or exported.

`git fetch origin` was refused at the existing FETCH_HEAD file. The GitHub
connector independently read live main as
`f5b5332999351fd800143b4798f57468f5e24a97`, matching the supplied base and local
origin/main. Shell `gh` and artifact download were network-blocked. The commands
above are therefore for the coordinator, including the private failed-run log
inspection. No Jira/Slack post, push, workflow dispatch or PR was made; publish
this handoff to SCRUM-760 with `[Codex Update]` when coordinating the PR.

G8 remains open for the earlier RECEPTION cause, real preview execution,
inspection of encrypted role captures, measured attack-worker evidence, and
independent review. Product findings: none reproduced; this is not a claim that
the new browser paths are defect-free.
