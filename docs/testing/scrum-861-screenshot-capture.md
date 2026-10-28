# SCRUM-861: Chromium screenshot failure investigation

Investigated 2026-10-28 against `68c514e62cf9a8a62399973c4af1946a5137d94c`
in `C:/tmp/auto-861`, branch `claude/scrum861-screenshot-flake`.
Risk: MEDIUM (test capture infrastructure, no application or workflow changes).

## Finding and evidence boundary

The recorded failure is Chromium returning no image from its capture operation.
The reason Linux Chromium sometimes returns that empty image remains **UNPROVEN**.
This change implements the current task's permitted narrow transport recovery;
it is not a demonstrated repair of Chromium's underlying compositor failure.

`gh run list` and `gh run view 40647283601 --attempt 1 --log-failed` were attempted,
but the shell cannot connect to api.github.com. Read-only GitHub connector calls
retrieved run lists, attempt-specific jobs and full decoded job logs instead.
`git fetch origin` cannot write this worktree's FETCH_HEAD. The live branches API
initially confirmed main at the base above. Main later advanced one commit to
`549267ae07a3a44fd92f3cb9dfc6919300ceb1db` (#697). The live compare shows no changes
to these capture files, but it changes the cockpit component used by a bridge.
The coordinator must integrate and validate that interaction on the PR head.

## Failure inventory

Window: latest six failed PR workflow runs as of the initial read, plus the
latest six failed push-triggered main workflow runs. The PR window contains four
runs with this signature (five failed attempts), and two fixture-mock failures.
The main window contains two runs with this signature. An additional older PR
role-access failure is included below. These are not counts over all history.

Every row has the exact error:

```text
page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot
```

PR rows fail step **Deal cockpit visual gate (static, no credentials)**; main
rows fail **Deal cockpit visual gate**. Every row is an explicit `page.screenshot`
request, not `toHaveScreenshot`, trace filmstrip capture or failure attachment.
Every call log says `waiting for fonts to load...` followed by `fonts loaded`.
Role-access additionally says `disabled all CSS animations`.

Viewport dimensions below are from each spec's configured context. Page creation
and capture-start timestamps were not logged. Durations are whole-test timings,
not exact page age; each test creates its page inside its timed body, so they
provide approximate upper bounds. Exact page age is **UNAVAILABLE**.

| Run / attempt / job | Spec and failed scenario | Capture call at that revision | Configured viewport; document facts | Whole-test duration |
| --- | --- | --- | --- | --- |
| [40651211043](https://github.com/aalzriqat/Auto/actions/runs/40651211043) / 1 / 122691456483 | `bill-of-sale.visual.spec.ts:128`, financed-no-rate / ar / 1280 | `:192`, `captureWithDiagnostics` → `browserCaptureDiagnostics.ts:114`, fullPage | 1280×900; logged document height 1274, horizontal overflow 0 | 169ms |
| [40647283601](https://github.com/aalzriqat/Auto/actions/runs/40647283601/attempts/1) / 1 / 122678942412 (#698) | `deal-money.visual.spec.ts:176`, deal-viewer / en / 1280 | `:224`, helper → `:114`, fullPage | 1280×900; exact capture-time document size unavailable in decoded log | 88ms |
| [40647283601](https://github.com/aalzriqat/Auto/actions/runs/40647283601/attempts/2) / 2 / 122714316456 (#698) | `role-access.visual.spec.ts:110`, loading versus empty deposit queues | `:100`, raw fullPage + animations disabled | 375×900 or 1440×900; exact state/locale/width within the loop unavailable in log | 329ms |
| [40626784310](https://github.com/aalzriqat/Auto/actions/runs/40626784310) / 1 / 122613517247 | `bill-of-sale.visual.spec.ts:128`, financed / en / 1280 | `:192`, helper → `:114`, fullPage | 1280×900; logged document height 1353, horizontal overflow 0 | 169ms |
| [40608430476](https://github.com/aalzriqat/Auto/actions/runs/40608430476) / 1 / 122553681793 | `bill-of-sale.visual.spec.ts:128`, load-failed / ar / 390 | `:192`, helper → `:114`, fullPage | 390×844; logged document height 1446, horizontal overflow 0 | 135ms |
| [40520070346](https://github.com/aalzriqat/Auto/actions/runs/40520070346) / 1 / 122244439431 (additional older PR) | `role-access.visual.spec.ts:122`, marketplace-only non-vehicle reply | `:100`, raw fullPage + animations disabled | 375×900 or 1440×900; exact locale/width unavailable in log | 103ms |
| [40413738195](https://github.com/aalzriqat/Auto/actions/runs/40413738195/attempts/2) / 2 / 121912230813 (main) | `bill-of-sale.visual.spec.ts:128`, unavailable-not-completed / en / 390 | `:192`, helper → `:74`, fullPage | 390×844; exact capture-time document size unavailable in decoded log | 205ms |
| [39845183274](https://github.com/aalzriqat/Auto/actions/runs/39845183274) / 1 / 120056459395 (main) | `deal-cockpit.visual.spec.ts:630`, en / light / 390, UX5 recorded line and mobile step bar | `:707`, raw **viewport-only** capture | 390×844 | 377ms |

Excluded from this signature: PR runs 40620827916 and 40614674012 fail bridge setup
with missing `useCurrencyFormatterInCurrency` mock exports. Main runs 39590444914,
39585255434, 39582540621 and 39562616383 fail authenticated locator assertions or
timeouts, not this protocol error. Main 40413738195 attempt 1 was cancelled.
These remain real failures; this recovery does not classify them as flakes.

Round 2 also inspected [run 40698345146](https://github.com/aalzriqat/Auto/actions/runs/40698345146),
job 122851045706: **two** empty-image failures, role-access's marketplace-only
non-vehicle reply (`:122`, raw capture at `:100`) and Bill of Sale's
cash-consigned-direct / en / 1280 (`:192`, helper). Both finished the font wait;
role-access disabled animations. The run reports 503 passed, 2 failed and 36 not
run. The initial inventory above is therefore not the latest complete inventory.

## Round 2: CI control failure and paint receipts

Reviewed head: `47faefb96fedd6f0cd2d55934bec5fab5e14f158`.
`gh run view 40713227734 --repo aalzriqat/Auto --log-failed` was blocked by the
shell network policy. The connected GitHub tool retrieved the decoded log for
job 122903837936 in [run 40713227734](https://github.com/aalzriqat/Auto/actions/runs/40713227734).
At 15:23:40 UTC the positive recovery control failed; the final summary is
**1 failed, 548 passed**. The other seven recovery controls passed.
The positive control captures warning output, so its retry outcome is absent
from stdout. Its helper rethrows the injected first error when recovery fails;
the log cannot identify the second error. The old failure marker did not classify it.

The reviewer's already-downloaded artifacts were read directly in round 2:
artifact **12798760023** (run 40647283601, attempt 1) and **12828006957**
(run 40713227734). This avoids treating a download reference as inspected bytes.
The earlier artifact contains **44 document receipts** and one failure diagnostic
matching `capture-*.json`, rather than 45 document receipts. Of those 44 receipts,
43 succeeded: 38 had first paint before capture, five first reported it after
capture, and none lacked it after a successful capture.

| Receipt | Status | `firstPaint` before / after | `observedAt` before / after (ms) |
| --- | --- | --- | --- |
| #698 deal-viewer / en / 1280 | CAPTURE_FAILED | null / null | 46.6 / 53.5 |
| #701 injected positive recovery control | CAPTURE_FAILED | null / null | 52.8 / 193.9 |

The control's receipt also records a visible, complete document, loaded fonts,
390×1203 document geometry at DPR 1, and no crash/disconnect. Its first failure
was injected, not a natural Chromium failure. The recovery failed while the
document still had no recorded first paint. These receipts support a timing
hypothesis; they do not prove that absent paint caused Chromium's failure or
establish the second error's signature. The defect in our recovery policy is
that an immediate retry requires no new readiness evidence.

## Diagnosis and design

* **Validated failure mechanism:** Chromium 149's `ScreenshotCaptured` emits this
  response when `image.IsEmpty()`. That does not distinguish first-paint timing,
  resource pressure, a lost surface or another compositor problem.
  [Chromium 149 source](https://github.com/chromium/chromium/blob/149.0.7827.55/content/browser/devtools/protocol/page_handler.cc#L1642).
* **Size alone cannot explain the class:** the main cockpit failure is viewport-only;
  the observed full-page documents above are ordinary-sized. DPR defaults to 1 in
  these manually created contexts; no affected caller requests HiDPI. A cap would
  remove required full-page evidence without explaining the viewport failure.
  Large pages can produce the same message, as reported in
  [Playwright #32144](https://github.com/microsoft/playwright/issues/32144), but that
  report is not evidence of this incident's cause.
* **A font wait is already present:** Playwright 1.61.1 waits for `document.fonts.ready`
  before calling capture. The logs confirm that stage completed. Role-access fails
  even with animations disabled. Blanket animation changes would also change
  spinner frames that the current gate intentionally captures.
  [Screenshotter source](https://github.com/microsoft/playwright/blob/v1.61.1/packages/playwright-core/src/server/screenshotter.ts#L236).
* **Navigation/first-frame timing remains a hypothesis:** the static pages are newly
  opened file documents or `setContent` documents, with no SSO or pending application
  navigation. [Playwright #38103](https://github.com/microsoft/playwright/issues/38103)
  records the same error around navigation, not a proven fix for these static pages.
  Two frame callbacks would not certify surface readiness after a full-page resize.
  The receipts above now motivate observing the first-paint entry before recovery.
* **No supported flag fix was established:** the PR container already uses `--ipc=host`;
  logged pre-suite shared memory is 7.9GiB with 84KiB used, and roughly 14GiB host
  memory is available. These are not capture-time or cgroup measurements. Playwright's
  installed Chromium launch defaults already include `--disable-dev-shm-usage`.
  GPU/cgroup failure has not been excluded. No speculative GPU flag is added.
  [Playwright Docker guidance](https://playwright.dev/docs/docker#recommended-docker-configuration).
* **Increasing timeout is unsupported:** these fail in 88–377ms with a protocol
  response, not a timeout. The static config already allows 120 seconds per test.

The permitted recovery is placed immediately around the failing SDK request:
match the entire first error line, require a connected Chromium browser and open
page with no observed crash/disconnect, and retain first-failure diagnostics.
Round 2 replaces the immediate retry with a bounded first-paint wait, followed
by at most **one** further capture. The first capture remains immediate and
unchanged: waiting before every capture would change successful paths and obscure
first-attempt evidence. Only recovery polls for
`performance.getEntriesByName("first-paint", "paint")`, using Playwright's native
[`page.waitForFunction`](https://playwright.dev/docs/api/class-page#page-wait-for-function)
with animation-frame polling and an explicit timeout. This tests the paint entry,
not a fixed sleep or an assumed number of frames.

The paint wait is capped at 1,000 ms, an experimental recovery allowance rather
than a measured Linux requirement. The wait and second capture share a maximum
5,000 ms budget, reduced to a smaller explicit screenshot timeout when supplied.
The second capture receives only the remaining positive budget; zero must never
reach Playwright because it disables its timeout. FullPage, path, scale,
animation and clip options are preserved. Diagnostic I/O retains its separate
existing bounds. There is no page reload, test retry or assertion retry.

Paint Timing [does not guarantee a first-paint entry](https://www.w3.org/TR/paint-timing/#mark-paint-timing),
particularly for a blank document. Missing paint, a wait timeout, persistent
capture failure or a different second failure all retain the original rejection.
Even observed first paint does not certify the later resized capture surface.
`BROWSER_CAPTURE_RETRY_FAILED` reports only `classification=same-signature` or
`classification=other`, including `other` when the paint wait fails before a
second request. It never prints the second error's text.
Recovered captures log success, optional document receipts say
`CAPTURE_SUCCEEDED_AFTER_RETRY`, and each recovery appends a
`browser-capture-recovery` annotation with fixed metadata to the current test,
following [Playwright's runtime annotation API](https://playwright.dev/docs/test-annotations#runtime-annotations).
Normal successful captures still make one request and do not wait for paint.

This is a bounded mitigation for a read that failed to produce an image. It does
not make an assertion failure pass. It follows the principle of bounding retries
at the immediate failing layer rather than multiplying test-level attempts.
[Google SRE retry budgets](https://sre.google/sre-book/handling-overload/#deciding-to-retry).
The existing static gate has zero test retries; that setting and all assertions,
variants, thresholds and frame censuses stay unchanged.

## Verification

Round 1 local environment: Windows, Playwright 1.61.1 / Chromium 149.0.7827.55, one
Playwright worker. No app server, Clerk, Convex or production services were used.
Docker has no available daemon; WSL enumeration is denied.

* Before implementation, unchanged Bill of Sale: **41 passed**, including all
  40 captures. This did not reproduce the Linux flake.
* Failing-before control: `bill-of-sale-capture.spec.ts`, grep
  `one empty Chromium|recovery stops`: **3 failed**. The first exact-error injection
  aborts capture; persistent-error controls report expected 2 attempts, received 1.
  Log: `test-results/scrum861-red.log`.
* Recovery control suite after implementation: **22 passed (3.8s)**.
  Log: `test-results/scrum861-controls-final.log`.
  The recovery control injects the recorded response at the Playwright SDK boundary,
  then uses **real** Chromium to write and return a 390×1203 full-page PNG. It checks
  file bytes, dimensions, preserved diagnostics, receipt status and visible retry
  markers. Other controls cover persistent errors, timeout/error matching and a
  closed page. This proves recovery behavior, not the original Linux trigger.
* Affected static specs: `bill-of-sale.visual.spec.ts`, `deal-money.visual.spec.ts`,
  `deal-cockpit.visual.spec.ts`, `role-access.visual.spec.ts`: **207 passed (1.7m)**,
  with original assertions and image options. No natural retry marker occurred.
  Log: `test-results/scrum861-affected.log`.
* `node node_modules/typescript/bin/tsc --noEmit`: **exit 0**. This is the root
  typecheck; `convex/`, mobile, packages and dealer-worker are excluded by its
  tsconfig. No backend code was changed.
* ESLint on the three changed TypeScript files: **exit 0**, no diagnostics.
  `git diff --check`: **exit 0**.

Changed files: `playwright/visual/browserCaptureDiagnostics.ts` (bounded recovery),
`playwright/tests/role-access.visual.spec.ts` (use the same helper),
`playwright/tests/bill-of-sale-capture.spec.ts` (eight recovery controls), and this
report. Self-review used the repository engineering principles and Test Guard:
the regression controls mock the third-party SDK boundary, use a real PNG for
successful recovery, and assert failures outside the code that preserves errors.
Independent review is pending with the coordinator. No commits, staging, pushes,
workflow dispatches or external posts were made.

### Round 2 verification

* New/extended controls against the unchanged helper: **4 failed**. Replaying the
  final tests against the helper from `47faefb9` also produced **4 failed**:
  the positive control observed zero paint entries at retry, the blank-document
  control accepted bytes without paint, and both second-error controls exposed
  missing classifications. Logs: `test-results/scrum861-r2-red.log` and
  `test-results/scrum861-r2-baseline-red.log`.
* Updated capture controls: **23 passed (5.1s)**; final rerun after restoring the
  mutations: **23 passed (4.2s)**, one worker. Final log:
  `test-results/scrum861-r2-final-controls.log`. The positive control
  still injects exactly one SDK failure and uses real Chromium for its second
  capture, checking PNG bytes, 390×1203 dimensions, disk contents, original
  diagnostics, receipt, logs, observed first paint and recovery annotation.
  Its local receipt changed from no paint at 106.1 ms to first paint at 192 ms
  and successful recovery by 303.2 ms. This is Windows evidence only.
* Removing the retry branch makes the real-PNG positive control **fail** with
  the original error. Removing only the first-paint wait makes the blank-document
  control **fail** because unpainted recovery returns bytes instead of refusing.
  Each mutation was verified in the helper and the exact original bytes restored.
  Logs: `scrum861-r2-no-retry.log`, `scrum861-r2-no-wait.log` in `test-results/`.
* All four affected static specs: **207 passed (1.9m)**, one worker, with original
  variants, geometry/overflow assertions and image options. The log has no
  `BROWSER_CAPTURE_RETRY` marker. Log: `test-results/scrum861-r2-affected.log`.
* Root `tsc --noEmit`: **exit 0**; excludes `convex/`, mobile, packages and
  dealer-worker. ESLint on both changed TypeScript files: **exit 0**.

Round 2 changes only the helper, its capture control spec and this document.
The coordinator owns commit/push, Jira updates and independent re-review.

Commands (from the worktree root):

```powershell
node node_modules/@playwright/test/cli.js test -c playwright.visual.config.ts bill-of-sale-capture.spec.ts --project=audit-controls --workers=1
node node_modules/@playwright/test/cli.js test -c playwright.visual.config.ts bill-of-sale.visual.spec.ts deal-money.visual.spec.ts deal-cockpit.visual.spec.ts role-access.visual.spec.ts --project=chromium --project=role-page-controls --workers=1
node node_modules/typescript/bin/tsc --noEmit
```

Linux first-attempt behavior, recovery frequency and full visual-gate acceptance
on the integrated PR head remain **UNAVAILABLE** until ordinary CI runs. Do not
dispatch either Playwright workflow manually. This report does not close
SCRUM-861's causal investigation, certify pilot readiness, or supply independent
review seats. The coordinator owns Jira updates, final review, commit and PR.
