# Supplier balances report and actionable due alerts

Date: 2026-11-07 · SCRUM-929 / SCRUM-869 · Status: accepted for implementation

## Invariant and impact

For each supplier and currency, the report must equal the outstanding statement to the minor unit. Payables and receivables remain separate; the net is informational and authorizes no settlement or offset. Incomplete evidence withholds figures. This is a read-only feature: no GL, settlement, due-date, opening allocation or financial containment changes.

Readers affected: the new Suppliers balances page, supplier statement presentation, and notification renderer. The only writer changed is `supplierDueAlerts.processOrgSupplierDueAlerts`, which inserts in-app notifications. Its operation, idempotency key, occurrence, recipient and continuation rules remain unchanged. Existing notification rows retain their stored links; there is no migration (c23871).

## Two designs

A. A server query pages the supplier registry and calls `readSupplierOutstanding` sequentially for each supplier. It uses the existing supplier/status indexes, `STATEMENT_FAMILY_LIMIT` and shared transaction headroom. Each supplier's complete sections supply the exact same totals as the statement. This repeats some statement reads, but bounds them and avoids a second financial truth or write-maintained aggregate.

B. The browser pages all three `supplierDueAging.list` families, resolves supplier links, and aggregates them. Those rows currently lack supplier identity; adding it would broaden that public contract. Pages span snapshots, read settled history too, and a browser interruption could produce misleading prefix totals. Moving completeness, money and attribution logic into the client also violates the backend-only owner rule.

Choose A. One native supplier page per invocation, at most five suppliers, with sequential shared-budget reads. No cross-currency sum or book-wide total is returned. A supplier with an incomplete side has no currency figures at all. `complete` describes the entire bounded report: false for multiple supplier pages, continuation pages, or any incomplete supplier; `isDone` describes navigation only. Complete supplier rows on a partial report remain usable. The UI explicitly calls the report partial and offers page navigation; it never accumulates page sums.

`supplierBalances.get` exposes the identical projection for a single owned supplier's summary tiles. It uses `requireOwnedRow` and the same permission/feature gates. The existing `supplierStatement` response is unchanged, including its explicit no-net contract. Detail summary reads duplicate the bounded outstanding read; they introduce no stored aggregate and no additional financial writer.

The report includes active and inactive registry suppliers, including zero-balance suppliers. Like the statement it includes only obligations linked by stored `supplierId`, and excludes unallocated openings and id-less legacy rows. The screen states that scope; it makes no claim to equal the entire GL. Disputed amounts remain in gross and overdue, with disputed payable/receivable amounts also shown separately. Positive net means the supplier owes the showroom; negative means the showroom owes the supplier. Oldest due date is the earliest known due date among open obligations in that currency, including disputed rows. Missing due dates stay unknown.

## Permissions, clock and errors

The report requires `STATEMENT_PERMISSIONS` (`view:finance` and `view:cost_price`) and the accounting feature, enforced server-side through authenticated tenant membership. It accepts no supplier id. Foreign organization requests refuse. A report read failure logs technical detail server-side and returns a generic Convex error; existing permission/plan refusals retain their established shape.

`nowMs` is an explicit, finite, safe integer within the JavaScript date range; the query never reads `Date.now()`. It is an aging reference, not a historical ledger snapshot. The client refreshes the argument hourly, like the statement. No monetary authority depends on that clock.

Alert attribution uses only the obligation's stored supplier id, exactly the statement's attribution; it never guesses from legal/display names or a vehicle. Verify the linked supplier's tenant. Rename-safe links target `/<org>/suppliers/<supplierId>`; an absent, deleted or foreign supplier targets `/<org>/suppliers/balances`. The current supplier display name is included only for recipients allowed to read the amount. Treating the name as cost-derived is deliberately conservative: the alert reveals a financial relationship. Other recipients receive directional, unnamed, amount-free copy. Unresolved suppliers get localized generic wording without invented identity. Existing notification types and legacy generic translation keys retain their meaning; new directional variants are selected only for recognized kinds.

## Screens and editing

Add a balances report page linked from the Suppliers list, with a back link and statement links on each row; no new top-level navigation. Reuse `formatExactMinorAmount` / `moneyDisplayLabel` from the statement (JOD three decimals). CSV is deferred: exporting a paged/incomplete report needs explicit scope and is not a trivial reuse of a complete-report export.

Part 3 is committed separately after the behavior. Use the app's Tailwind v4 `app/globals.css` tokens, shadcn Card/Tabs/Table/Dialog/Skeleton/Badge, cockpit semantic money colors and dashboard spacing. There is no Tailwind config file in this checkout. Use `money-out` for showroom obligations and `profit-positive` for supplier obligations, with text direction as well. Keep logical alignment and `<bdi>` for RTL. Desktop tables have headers and hover rows; phone rows stack as cards. Detail opens as a read-only header/profile card. Summary tiles use the server report projection of that same outstanding result, never client money calculations. Outstanding, Settled and Payments occupy tabs.

Editing follows the existing `CustomerDialog` / `SupplierCreateDialog` Radix dialog pattern. Move the existing supplier form without changing fields, validation, revision token or mutation arguments. `manage:finance` controls the Edit button, as before. Save closes; Cancel, Escape and outside dismissal confirm dirty changes. Creating uses the same existing SupplierFields in a dialog, with dirty-discard confirmation too. No permission is widened.

Aliases are read-only on the profile and retain their existing add/retire controls inside Edit. Their pending text participates in discard confirmation; in-flight alias work prevents dismissal. Draft forms also protect browser unload and navigation through duplicate-candidate links. Query error boundaries and pagination state are keyed by organization/supplier so a route change cannot retain another record's editor or refused query.

Advisory self-review reproduced a missing path: same-document browser Back does not fire `beforeunload`. Add the maintained `nextjs-nav-guard` 1.1.3 functional integration, whose published peers support Next 16 and React 19. Its provider mounts unconditionally in the root layout before async authentication content, as its documentation requires. Only supplier forms register guards. This adds no UI library. Back/Forward and App Router navigation request a localized native confirmation; in-flight writes refuse guarded same-document navigation. Dialog Cancel/Escape/outside dismissal retain the app's own discard dialog. Full-page unload uses the browser-controlled prompt, which the user can accept even during a write. Direct History API calls are not supported navigation doors for forms.

The package wraps private Next router context, which is a maintenance cost; pinning and an executed Chromium regression are preferable here to hand-written history interception. The original package's published 0.2.0 does not declare Next 16 support, so it was rejected in favor of the maintained fork. The offline browser fixture mounts the real create/edit components, provider and Next `useRouter`, with data/auth boundaries and the AppRouterContext's destination consumer replaced. It proves Back cancellation retains the actual field and acceptance unmounts it, and that successful creation and explicitly accepted candidate navigation reach the statement without another prompt. It does not prove authenticated Next route integration, Forward on every browser, or styled layout. Those remain coordinator checks.

A second advisory attack reproduced React batching retaining the dirty guard while a successful create or accepted candidate discard immediately calls `router.push`. The guard can then prompt again or refuse the push as its registration disappears. The shared close-before-navigation helper uses `flushSync` only at these three event/async completion boundaries, so the editor unregisters before the authorized push. React documents this escape hatch for third-party integration ordering; it is not used in render/effects or ordinary field updates. Both save and candidate navigation failed first against the unchanged guard implementation and pass after this correction.

The normal dependency-add command attempted unrelated mobile resolution; its offline form refused missing mobile metadata. The final change adds only the pinned package and its published integrity/peer snapshot to the existing manifest/lock. The downloaded npm tarball's SHA-512 matched its published integrity, and `pnpm install --lockfile-only --frozen-lockfile --offline --ignore-scripts --filter auto` passed. No existing dependency was upgraded.

Test selector changes in part 3: `SupplierManagement.test.tsx` opens Edit before existing form/alias assertions and excludes the new Balances navigation link when asserting that an empty search has no supplier links. Its consecutive-save test reopens after Save and supplies the same returned revision through the reactive record fixture, preserving both revision assertions. `SupplierConfirmations.realBackend.test.tsx` clicks Edit before typing. `SupplierStatementSection.test.tsx` selects Settled or Payments before its existing assertions; its loading check selects Settled explicitly. Amount, refusal and confirmation assertions remain intact.

## Design attacks and proof plan

1. Renamed supplier / conflicting legal name: stored id wins; public alert and report read use current display name.
2. Missing or foreign supplier link: generic alert falls back to report; no foreign name escapes.
3. Recovery settled that day / cancelled receivable: closed rows disappear from the outstanding report exactly as the statement does.
4. Disputed payable and simultaneous A/R: gross, overdue and disputed remain separate; no automatic offset.
5. Two currencies / Amman midnight / oversized book: literal per-currency minor units, explicit day-boundary aging, and unavailable totals when bounded evidence is incomplete.

Tests run through registered Convex functions with real documents and literal money expectations, plus EN/AR component tests. Harness success proves harness behavior, not Convex cloud limits, concurrency, rendered UI or pilot certification. Coordinator performs independent seats and rendered EN/AR desktop/phone verification.

## Sources checked

- [Convex best practices](https://docs.convex.dev/understanding/best-practices): bounded/indexed reads and explicit time arguments for reactive aging.
- [Convex pagination](https://docs.convex.dev/database/pagination) and [transaction headroom](https://docs.convex.dev/database/writing-data): one bounded page, byte-aware reads, no silent prefix totals.
- [Oracle Receivables reports](https://docs.oracle.com/en/cloud/saas/financials/26b/faofc/oracle-receivables-predefined-reports.html): outstanding open-item aging by date/currency. This feature reports current obligations aged at the reference date; it does not claim historical reconstruction or GL certification.
- [WAI tables](https://www.w3.org/WAI/tutorials/tables/), [WCAG 1.4.1](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html), and [ARIA modal dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/): native table semantics, text alongside color, labelled modal focus behavior.
- [Next App Router navigation](https://nextjs.org/docs/app/api-reference/functions/use-router), [MDN popstate](https://developer.mozilla.org/en-US/docs/Web/API/Window/popstate_event), and [the maintained guard's source and setup](https://github.com/br-schneider/nextjs-nav-guard): same-document history requires a guard beyond `beforeunload`; mount its provider before router effects.
- [React flushSync](https://react.dev/reference/react-dom/flushSync): rare integration ordering escape hatch; commit editor closure before invoking the external navigation guard.

## Implementer verification handoff — 2026-11-07

Parts 1 and 2 landed locally in `113b05212`; the separate Part 3 starts at `c333d736b`. No push or deployment was performed. The branch incorporates the file-disjoint main update `684ba04d002edfcbee20162bdad1a2fbfc61a7a5` through merge `8a24e7325`. That remained the remote main tip at the final read-back.

Failing-first evidence is reachable in this branch: `db0dec582` has 26 failures against the original main source. `170c8c9d8` has the same variants grouped into ordinary, executable scenario registrations (20 failures), retained by merge `788896577`. No variant assertions were removed. `271203d5e` reproduces two dirty Back failures. The corrected real-router-context fixture at `11e408f58` reproduces two save/candidate failures while both Back checks pass. The navigation fix is `5497ae835`.

Final local checks:

| Check | Observed result |
| --- | --- |
| All named supplier/statement/aging/alert/notification tests, one Vitest worker | 11 files, 276 passed |
| Scenario library, tenant write guard, economic command census, supplier settlement census, pilot door inventory, i18n key coverage | 6 files, 132 passed |
| Offline Chromium create/edit Back, successful save and accepted candidate navigation | 4 passed, one worker |
| `pnpm typecheck` | Passed; root config excludes convex, apps, packages, dealer-worker and test-utils as roots (imports may still be followed) |
| `pnpm typecheck:convex` | Passed; includes convex and test-utils, excludes generated files as roots; does not compile the frontend as a root |
| ESLint on changed TypeScript/TSX, excluding generated declaration | Passed; final fixture rerun with max-warnings zero corrected the sole missing-dependency warning |
| Contract baseline identity | 945 matched, 0 stranded; backend finding identity is outside this check |
| Baseline renewal, reviewed c82890bd, main 684ba04d0, check-evidence | 945 checked, 0 unrenewed/stale/malformed/missing; exactly nine supplier-update entries renewed with committed blob evidence |
| Role-audit Playwright collection | 162 tests in 5 files; collected, not executed |
| Frozen offline manifest/lock validation | Passed; only nextjs-nav-guard 1.1.3 added |

The scripts-tree query/guard/census filename inventory found no dedicated global public-query count gate. Existing mutation/caller census guards above ran unchanged; tenant mutation pins remain 571 total / 383 analyzed / 15 denied / 173 exempt. Sixteen SCRUM-761 scenario records bind the new money, permission and screen checks; screen scenarios also carry affected source globs. No review-evidence certificate was written.

The five design attacks above are measured in the public Convex contracts: renamed stored identity; missing/foreign/deleted supplier fallback; same-day settled recovery/cancelled claim; disputed payable with simultaneous receivable; and separate currencies plus Amman midnight/family/page/byte bounds. Expected amounts are literals, with additional exact statement comparisons.

Not verified here: styled EN/AR desktop and phone rendering, signed-in route execution, the complete role audit, independent review seats, CI/Sonar results, Convex platform limits/OCC, deployment or production behavior. The coordinator performs rendered and independent checks. Browser fixtures replace data/auth and the route destination consumer, not the actual guarded Next useRouter. CSV remains a follow-up. Existing notifications retain their original stored links.
