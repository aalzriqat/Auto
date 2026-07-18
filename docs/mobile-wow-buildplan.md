# AutoFlow Mobile — "Wow" Build Plan

Grounded against `origin/main` @ e3533879 (2026-07-18). This plan supersedes the
original design critique, most of which is **already shipped** — the doc was
written against a snapshot ~222 commits stale.

## Reality check: what already exists on `main`

The design doc's foundation recommendations are largely done:

| Doc recommendation | Status on `main` | Where |
|---|---|---|
| Automotive palette (teal action / orange opportunity) | ✅ Done | `apps/mobile/src/theme.ts` (`primary #0f766e`, `accent #ea580c`, hero gradient teal→cyan→indigo) |
| Reactive light/dark theme + live toggle | ✅ Done | `theme.ts` `buildTheme(mode)`, `ThemeProvider`, `ThemeToggle` |
| Distinctive typography scale + tabular numerals | 🟡 Partial | scale done (`getTypographyStyle`); **tabular-nums not applied** anywhere |
| Motion / feedback (count-up, staggered reveal) | ✅ Done | `Motion.tsx` `useCountUp`, `FadeSlideIn`; `SmoothAreaChart` |
| Morning-pulse greeting | ✅ Done | `OrgDashboardScreen` `getGreeting` + `api.users.getMe` |
| Today agenda (tasks / approvals / unread) | ✅ Done | `features/dashboard/TodayAgenda.tsx` |
| Skeletons shaped like content | ✅ Done | `SkeletonRow`, `DashboardSkeleton` |

## The real remaining gaps

1. **Role-intelligent Today is NOT role-intelligent.** SALES / RECEPTION /
   ACCOUNTANT are **hard-redirected away** from the dashboard into a single raw
   module (`OrgDashboardScreen.tsx` role `useEffect`). They never see a greeting
   or a Today. → **Increment 1.**
2. **Finance numbers don't use tabular numerals** → prices/installments shimmy on
   count-up and misalign in columns. → **Increment 2.**
3. **Inventory shows a 4-up analytics grid above the cars** (analytics before
   content) → **Increment 3.**
4. **No collections/receivables data in the Today** — the accountant Today can't
   show "JOD due today / cheques this week / overdue receivables" because
   `dashboard.stats` has no such aggregation. → **Wave 2 (backend).**
5. **Sale creation has no live deal summary** — no live monthly/profit/outstanding
   because `lib/financing.ts` is web-only (not in `packages/shared`). → **Wave 3.**

## Shipping model

Every merge to `main` touching `apps/mobile/**` or `packages/shared/**`
auto-publishes the integrated `main` bundle to the EAS `preview` channel
(`.github/workflows/eas-update.yml`). The test device is on `preview`. So:
**land JS-only increments on `main` → CI OTAs to the device.** No native rebuild
needed for any JS/asset change.

## Increment sequence (small, OTA-safe, one PR each)

- **Inc 1 — Role Today (frontend-only).** Remove the role redirect; every role
  lands on the dashboard. Add a prominent role "start here" card (SALES→sales,
  RECEPTION→leads, ACCOUNTANT→accounting) so they keep their one-tap path.
  Gate the owner performance section (SalesHero/metric grid/team) behind a
  finance-permission check so perm-less roles (RECEPTION) don't see empty cards.
  Files: `OrgDashboardScreen.tsx`, `packages/shared/src/i18n.ts`.
- **Inc 2 — Tabular numerals.** Add a numeric text style (`fontVariant:
  ['tabular-nums']`) and apply to money/metric values across the dashboard and
  module screens.
- **Inc 3 — Progressive disclosure on inventory.** Collapse the always-on metric
  grid into one expandable summary; show vehicles first.

## Heavier waves (need backend deploy / refactor — do while attended)

- **Wave 2 — `dashboard.todayForRole`** Convex query: per-role payload
  (collections due, cheques this week, overdue receivables, approvals). Needs new
  indexed reads + `convex deploy`. Enriches the Inc-1 Today with real numbers.
- **Wave 3 — Live deal summary.** Move `lib/financing.ts` → `packages/shared`,
  then wire real amortization (monthly / expected profit / outstanding) into the
  SaleModule wizard (`GuidedStepFlow` already exists).

## Deferred / avoid double-work

- Vehicle-detail shared-element transition — retrofit already explored on another
  branch; defer to avoid conflicts.
