# AutoFlow — Master Project Plan

## ⚠️ Standing Rules (Claude must follow every session)

1. **graphify-first**: Run `graphify query "<topic>"` before any non-trivial architectural change.
2. **Branch-per-phase**: One git branch per phase/feature. Commit before moving to next.
3. **Keep this file updated**: Mark tasks ✅ as they complete. Update the Completed Work table after each commit.

---

## Completed Phases

| Phase | Branch | Description | Status |
|-------|--------|-------------|--------|
| 1 | main | Performance & Indexing | ✅ Done |
| 2 | main | Input Validation | ✅ Done |
| 3 | main | Configuration Hardening | ✅ Done |
| 4 | main | Test Coverage | ✅ Done |
| 5 | main | API Rate Limiting | ✅ Done |
| 6 | feature/searchable-selects-db-drafts-i18n-rtl | SearchableSelect rollout, DB drafts, i18n fixes, hydration fix | ✅ Done |
| 7 | feature/searchable-selects-db-drafts-i18n-rtl | VIN decode improvements (parallel NHTSA + WMI), mileage optional | ✅ Done |
| 8 | main | Structured Error Handling & Logging | ✅ Done |
| 9 | main | CI/CD & Deployment Hardening | ✅ Done |
| 10 | feature/phase-10-org-settings | Org Settings Foundation | ✅ Done |
| 11 | feature/phase-11-sales-flow | Pipeline Stages, Approval Thresholds | ✅ Done |
| 12 | feature/phase-12-branding-whatsapp | Org Logo, Brand Color, WhatsApp Webhook | ✅ Done |
| 13 | feature/phase-13-advanced | Custom Fields, Commission Tiers, Onboarding Wizard | ✅ Done |
| 14 | main | Feedback Widget (floating bug/feature reporter + admin inbox) | ✅ Done |
| 15 | main | Commission Mode (AUTO tier-based vs MANUAL per-sale editing) | ✅ Done |
| 17 | feature/phase-17-super-admin | Super Admin Dashboard (cross-tenant developer control panel) | ✅ Done |

---

## Phase 1 — Critical Performance & Indexing ✅

**Branch:** `main` · **Completed:** 2026-06-13

### Delivered
- [x] `by_status_alarm` index added in `convex/schema.ts`
- [x] `convex/crons.ts` uses the index (no more full-table scan)
- [x] `convex/reports.ts` bulk-fetch + `Promise.all` pattern — N+1 eliminated

---

## Phase 2 — Input Validation Layer ✅

**Branch:** `main` · **Completed:** 2026-06-13

### Delivered
- [x] `convex/validations/` — sales, vehicles, customers, expenses schemas
- [x] `convex/utils/validation.ts` with `validateInput()` helper
- [x] Applied to sales, vehicles, customers, expenses mutations

---

## Phase 3 — Configuration & Environment Hardening ✅

**Branch:** `main` · **Completed:** 2026-06-13

### Delivered
- [x] `convex/utils/env.ts` — `getValidatedEnv()` validates required env vars at startup
- [x] Applied to `email.ts`, `http.ts`, `auth.config.ts`
- [x] `.env.example` added

---

## Phase 4 — Test Coverage Foundation ✅

**Branch:** `main` · **Completed:** 2026-06-13

### Delivered
- [x] `lib/financing.test.ts` — APR / monthly payment calculations
- [x] `convex/sales.test.ts` — sale creation, profit checks
- [x] `convex/approvals.test.ts` — approval workflow states
- [x] `convex/utils/permissions.test.ts` — RBAC permission checks
- [x] `.github/workflows/test.yml` — CI runs lint + tests on every PR

---

## Phase 5 — API Rate Limiting & DoS Protection ✅

**Branch:** `main` · **Completed:** 2026-06-13

### Delivered
- [x] `heavyRead` + `standardApi` buckets in `convex/rateLimit.ts`
- [x] `heavyRead` applied to all 6 queries in `convex/reports.ts`
- [x] `standardApi` applied to update/softDelete in expenses, customers, sales, vehicles

---

## Phase 6 — SearchableSelect + DB Drafts + i18n Fixes ✅

**Branch:** `feature/searchable-selects-db-drafts-i18n-rtl` · **Completed:** 2026-06-15

### Delivered
- [x] `SearchableSelect` component — searchable combobox replacing plain `<Select>` in high-volume dropdowns
- [x] `wizardDrafts` table — persists in-progress sale wizard state to Convex so it survives page refresh
- [x] `SalesWizard` — `resumeDraft` prop + draft auto-save on step change
- [x] `sales/page.tsx` — "Resume Draft" card shown when a saved draft exists
- [x] `LanguageProvider` SSR fix — eliminated client/server hydration mismatch
- [x] RTL layout improvements

---

## Phase 7 — VIN Decode Improvements ✅

**Branch:** `feature/searchable-selects-db-drafts-i18n-rtl` · **Completed:** 2026-06-15

### Delivered
- [x] Parallel WMI + full NHTSA VIN lookup via `Promise.allSettled`
- [x] `decodeVinYear(char)` — ISO 3779 position-10 year decode with 30-year cycle
- [x] `toCarBrand(name)` — smart case (≤3 chars → ALL-CAPS, longer → Title Case)
- [x] `cleanMfrName(mfr)` — strips legal suffixes (CORPORATION, CO., LTD, MOTOR…)
- [x] WMI wins for Make (better international coverage); NHTSA provides model/trim/fuel/year
- [x] `VehicleImportDialog` — mileage column made optional; split TYPE/Name → make + model

---

## Phase 8 — Structured Error Handling & Logging ✅

**Branch:** `main` · **Completed:** 2026-06-13

### Delivered
- [x] `convex/utils/errors.ts` — `AppErrorCode` const + `throwAppError()` factory
- [x] Structured `{ code, message }` errors in `sales.ts` (13 throws) and `utils/tenancy.ts` (7 throws)
- [x] `sonner.tsx` `formatFriendlyError` parses structured JSON errors before keyword matching

### Remaining (incremental)
- [ ] Other 28 files still use plain `ConvexError(string)` — migrate using `throwAppError()` pattern

---

## Phase 9 — CI/CD & Deployment Hardening ✅

**Branch:** `main` · **Completed:** 2026-06-13

### Delivered
- [x] `.github/workflows/test.yml` — lint + typecheck + tests on every PR to `main`

### Remaining
- [ ] Convex deploy step to CI (staging environment)
- [ ] Branch protection rule: PRs require passing CI before merge
- [ ] Document rollback procedure in CLAUDE.md

---

## Production Readiness Scorecard

| Dimension             | Score  | Summary |
|-----------------------|--------|---------|
| Security              | 6/10   | Clerk/Convex RBAC solid; rate limiting rudimentary; Zod not used in Convex args |
| Error Handling        | 5/10   | Basic try/catch + Sonner toasts; backend errors lack structured context |
| Observability/Logging | 4/10   | Sentry installed; no structured logging inside Convex; no distributed tracing |
| Performance           | 4/10   | Severe N+1 patterns in reports.ts; no caching layer |
| Scalability           | 7/10   | Convex scales well; unbounded collect() + in-memory filter will OOM under load |
| Maintainability       | 5/10   | God files exist (schema.ts, large UI components); business logic inside DB queries |
| Test Coverage         | 2/10   | vitest installed; critical financial logic has zero tests |
| Documentation         | 3/10   | Barebones README; no ADRs; no API docs |
| **OVERALL**           | **4.5/10** | **Needs significant optimization and testing before high-scale production launch** |

---

## Phase 10 — Org Settings Foundation ✅

**Branch:** `feature/phase-10-org-settings`
**Commit:** `1925dc9`

### Delivered
- [x] `convex/schema.ts` — added `orgSettings`, `orgLeadSources`, `orgValuationCompanies` tables
- [x] `convex/orgSettings.ts` — `get` query, `upsert` mutation (owner-only), `generateLogoUploadUrl`
- [x] `convex/orgLeadSources.ts` — `list`, `seed`, `create`, `update`, `remove`, `reorder`
- [x] `convex/orgValuationCompanies.ts` — `list`, `seed`, `create`, `update`, `remove`
- [x] `hooks/useOrgSettings.ts` — reads org settings, skips when no org
- [x] `hooks/useCurrency.ts` — `format(n)` → `"14,500 JOD"`, `formatCompact(n)`
- [x] `app/(dashboard)/settings/general/page.tsx` — currency, country, VAT, timezone, payment types, color, logo
- [x] `app/(dashboard)/settings/lead-sources/page.tsx` — add, toggle, reorder, delete, seed defaults
- [x] `app/(dashboard)/settings/valuation-companies/page.tsx` — add, toggle, delete, seed defaults
- [x] `components/leads/LeadDialog.tsx` — dynamic lead sources from DB with static fallback
- [x] `app/(dashboard)/sales/page.tsx` — payment type buttons gated by `enabledPaymentTypes`

---

## Phase 11 — Sales Flow Customization ✅

**Branch:** `feature/phase-11-sales-flow`
**Commit:** `7dc8bbb`

### Delivered
- [x] `orgPipelineStages` table — stageKey, label, color, order, isActive per org
- [x] `convex/orgPipelineStages.ts` — list, seed, update, reorder
- [x] `orgSettings` gains `approvalThresholdEnabled` + `approvalMinProfitPercent`
- [x] `app/(dashboard)/settings/pipeline/page.tsx` — inline label edit, color picker, reorder, active toggle
- [x] `app/(dashboard)/settings/general/page.tsx` — Approvals tab with threshold toggle + percent input
- [x] `components/leads/LeadDialog.tsx` — stage dropdown driven by `orgPipelineStages` with static fallback

---

## Phase 12 — Branding + WhatsApp Integration ✅

**Branch:** `feature/phase-12-branding-whatsapp`
**Commit:** `b3d3a53`

### Delivered
- [x] `convex/orgSettings.ts` — `getLogoUrl` query returns Convex storage URL for org logo
- [x] `Sidebar.tsx` + `TopNav.tsx` — dynamic org logo; falls back to `/logo.png`
- [x] `lib/colorUtils.ts` — `hexToHslString()` converts hex → shadcn/ui HSL format
- [x] `app/(dashboard)/layout.tsx` — applies `orgSettings.primaryColor` as `--primary` CSS variable
- [x] `settings/general/page.tsx` — WhatsApp tab (Phone Number ID, API token, webhook secret)
- [x] `convex/whatsapp.ts` — `handleIncomingMessage` internal mutation (find/create customer + open NEW lead)
- [x] `convex/http.ts` — GET `/whatsapp-webhook` (Meta verification) + POST (message → lead)

---

## Phase 13 — Advanced Customization ✅

**Branch:** `feature/phase-13-advanced`
**Commit:** `89a0dfb`

### Delivered
- [x] `orgCustomFields` + `orgCustomFieldValues` tables in schema
- [x] `orgSettings.commissionTiers` — array of `{ minProfitAmount, commissionPct }` tiers
- [x] `convex/orgCustomFields.ts` — list, create, update, remove (field defs) + getValues/setValues (values)
- [x] `settings/custom-fields/page.tsx` — add text/number/select/date fields per entity type
- [x] `settings/commission/page.tsx` — tier builder with live preview calculator
- [x] `hooks/useCommission.ts` — `calculate(profit)` + `getAppliedTier(profit)`
- [x] `components/custom-fields/CustomFieldsSection.tsx` — renders active fields in any form; loads existing values on edit
- [x] `VehicleDialog` — CustomFieldsSection + parallel WMI+NHTSA VIN decode with smart brand name helpers
- [x] `CustomerDialog` / `LeadDialog` — CustomFieldsSection for customer and lead entity types
- [x] Onboarding wizard — 5-step: name → currency → lead sources → pipeline → done (each step skippable)

---

## Phase 14 — Feedback Widget ✅

**Branch:** `main`
**Completed:** 2026-06-16

### Delivered
- [x] `feedback` table in `convex/schema.ts` — `{ orgId, userId, type: BUG|FEATURE, title, description, url, status: OPEN|CLOSED, createdAt }`
- [x] `convex/feedback.ts` — `submit` mutation (any member), `list` query (owner-only), `setStatus` mutation
- [x] `components/feedback/FeedbackWidget.tsx` — floating button (bottom-right) on all dashboard pages; two-step: pick Bug/Feature → fill title + description; auto-captures page URL
- [x] `app/(dashboard)/layout.tsx` — `<FeedbackWidget />` mounted inside `DashboardWrapper`
- [x] `app/(dashboard)/settings/feedback/page.tsx` — owner-only inbox with type/status filters, mark open/closed
- [x] Sidebar "Feedback Inbox" link (`manage:users` permission, i.e. owner/manager only)
- [x] Full EN + AR i18n for all new strings (FeedbackWidgetTitle, FeedbackTypeBug, FeedbackTypeFeature, FeedbackSuccess, etc.)

---

## Phase 15 — Commission Mode ✅

**Branch:** `main`
**Completed:** 2026-06-16

### Delivered
- [x] `commissionMode: "AUTO" | "MANUAL"` added to `orgSettings` table in schema
- [x] `convex/orgSettings.ts` — `upsert` accepts `commissionMode`
- [x] `convex/sales.ts` — `setCommissionAmount` mutation (manage:commissions guard)
- [x] `settings/commission/page.tsx` — mode selector card at top: AUTO (tier-based) vs MANUAL (per-sale)
- [x] `commissions/page.tsx` — in MANUAL mode, commission cell shows pencil-edit inline input (owner/manager only, blocked after paid)
- [x] `hooks/useOrgSettings.ts` — `commissionMode` is readable everywhere via existing hook
- [x] Full EN + AR i18n (CommissionMode, CommissionModeAuto, CommissionModeManual, EditCommission, etc.)

---

## Architectural Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-06-13 | Keep approval workflows in pending→approved/rejected pattern | Auditable, supports multi-level review |
| 2026-06-13 | Soft deletes on all entities | Auditability, recoverability, multi-tenant data safety |
| 2026-06-13 | Rate limiting per orgId (not per userId) | Prevents one tenant from DoS-ing another; allows fair org-level quotas |
| 2026-06-15 | WMI wins for Make in VIN decode | ISO 3780 global registry more reliable than NHTSA for non-US manufacturers |

---

## Deferred / Pending

- `useCurrency()` rollout — apply to all components still showing hardcoded "JOD"
- Regional doc templates (requires template engine — Phase 14)
- Expense category custom fields

---

## Phase 16 — Mobile-First Responsive Design

**Branch:** `feature/phase-16-mobile-first`
**Goal:** Make AutoFlow fully usable on phones (390px–428px) and tablets (768px) without regressing any desktop (1280px+) behaviour. Strategy: mobile styles are the base; `md:` and `lg:` prefixes add desktop enhancements — never the other way around.

**Guiding constraints:**
- No new libraries required — Tailwind breakpoints + existing shadcn/ui Sheet/Dialog primitives cover everything.
- Desktop layout, data density, and feature set must stay identical.
- RTL (Arabic) must be tested alongside every change.
- Touch targets must be ≥ 44px.

---

### 16.1 — Navigation Shell (Quick wins)

**Files:** `components/layout/TopNav.tsx`, `components/layout/Sidebar.tsx`, `app/(dashboard)/layout.tsx`

**Current issues:**
- Search input is `hidden md:flex` → mobile users cannot search.
- `OrgSwitcher` is `hidden sm:block` → missing on small phones.
- Page title is inside `hidden md:flex` block → not visible on mobile.

**Tasks:**
- [x] **TopNav — mobile search**: Search icon button on mobile toggles an inline search bar below the header row; desktop inline search unchanged.
- [x] **TopNav — always-visible OrgSwitcher**: Removed `hidden sm:block` wrapper; OrgSwitcher shows icon-only on mobile (text+chevron hidden with `hidden sm:*`), full label on sm+.
- [x] **TopNav — mobile page title**: Page title rendered inline in the nav bar on mobile (`md:hidden`); deduped from the `hidden md:flex` desktop block using a shared `pageTitle` variable.
- [x] **Main layout padding**: Changed to `p-3 sm:p-4 md:p-6 lg:p-8`.
- [x] **iOS safe area**: `pb-[calc(0.75rem+env(safe-area-inset-bottom))]` on main scroll container.

---

### 16.2 — Data Tables → Scroll + Card Pattern

All primary list pages use bare `<Table>` with 7–9 columns. On a 390px screen these clip.

**Affected pages (in priority order):**
1. `app/(dashboard)/vehicles/page.tsx` — 9-column table
2. `app/(dashboard)/customers/page.tsx`
3. `app/(dashboard)/sales/page.tsx` + `sales/sales/page.tsx`
4. `app/(dashboard)/leads/page.tsx`
5. `app/(dashboard)/expenses/page.tsx`
6. `app/(dashboard)/tasks/page.tsx`
7. `app/(dashboard)/team/page.tsx`
8. `app/(dashboard)/commissions/page.tsx`
9. `app/(dashboard)/approvals/page.tsx`
10. `components/accounting/AccountingClient.tsx`

**Strategy (two tiers):**

*Tier A — overflow scroll (all 10 pages, fast):*
Wrap every `<Table>` in `<div className="overflow-x-auto -mx-3 sm:mx-0 rounded-xl border">`. This preserves the full desktop table unchanged; mobile users can horizontal-scroll. `-mx-3 sm:mx-0` makes the scroll area bleed to screen edges on phones for a native feel.

*Tier B — card view (Vehicles, Customers, Sales, Leads only — highest traffic):*
Add a card-grid that renders on mobile and is hidden on desktop. Pattern:
```tsx
// Mobile card list  
<div className="flex flex-col gap-3 md:hidden">
  {rows.map(row => <VehicleCard key={row._id} vehicle={row} />)}
</div>
// Desktop table (unchanged)
<div className="hidden md:block overflow-x-auto">
  <Table>…</Table>
</div>
```
Each card shows: primary identifier (make/model or name), 2–3 key fields, status badge, and a tap-target action button. Keeps the desktop table completely untouched.

**Tasks:**
- [x] Wrap all tables in `overflow-x-auto` containers (Tier A) — vehicles, customers, sales/sales, expenses, tasks, team (×2), commissions, accounting/GeneralLedger, dashboard recent-leads
- [x] Filter bars: `flex-wrap gap-2` on vehicles action buttons and sales/sales action buttons; tasks/commissions already had `flex-wrap`
- [x] Build `VehicleCard`, `CustomerCard`, `LeadCard`, `SaleCard` mobile card components
- [x] Replace mobile table view with card components on the 4 high-traffic pages (Tier B)

---

### 16.3 — Dashboard Responsive Layout

**File:** `app/(dashboard)/dashboard/page.tsx`

**Current issues:**
- Hero stat grid is `grid gap-4 md:grid-cols-3` → 1 column on mobile (fine) but the hero card is a large fixed-height gradient block that doesn't adapt well to 390px.
- Lower stat grid is also `md:grid-cols-3`.
- Recent sales uses a `<Table>` with no overflow wrapper.

**Tasks:**
- [x] Stats grids: `grid-cols-2 md:grid-cols-3` — Vehicles + Leads side-by-side; Team card spans `col-span-2 md:col-span-1` (full-width on mobile).
- [x] Hero card: removed fixed `h-[220px]`, restructured inner layout to `flex-col md:flex-row`; chart column (`hidden md:flex`); mobile time-range picker added inline; numbers downscaled to `text-3xl md:text-5xl`.
- [x] Donut chart in Leads card: `hidden sm:flex` so it doesn't crowd the 2-col grid on small phones.
- [x] Recent leads table: `overflow-x-auto` wrapper (done in 16.2A).
- [x] Loading skeletons: updated to match new 2-col grid.

---

### 16.4 — Dialogs & Forms

**Current issues:**
- Internal form grids use `grid-cols-2` or `grid-cols-3` with no `sm:` guard → cramped at 390px.
- `max-h-[90vh]` is correct but `90dvh` is safer on iOS (accounts for browser chrome resize).
- `max-w-3xl` dialogs are full-width on mobile anyway, but the close button and header padding eat into usable space.

**Affected components:** `VehicleDialog.tsx`, `CustomerDialog.tsx`, `SaleDialog.tsx`, `LeadDialog.tsx`, `ExpenseDialog.tsx`, `TaskDialog.tsx`, `GuarantorDialog.tsx`, `QuoteDialog.tsx`

**Tasks:**
- [x] `max-h-[90vh]` → `max-h-[90dvh]` across all 6 `DialogContent` usages (Vehicle, Sale, Customer, Lead, Expense, Task, Quote).
- [x] `GuarantorDialog`: both bare `grid-cols-2` grids → `grid-cols-1 sm:grid-cols-2`.
- [x] `VehicleDialog` image thumbnail grid: `grid-cols-2 md:grid-cols-4` → `grid-cols-2 sm:grid-cols-4`.
- [ ] Dialog header padding: use `p-4 md:p-6` — deferred, shadcn/ui Dialog handles this via internal padding.

---

### 16.5 — Sales Wizard Mobile Layout

**File:** `components/sales/SalesWizard.tsx` + all wizard step files

**Current issues:**
- The wizard renders as a full-page overlay (not a Dialog) — good for mobile.
- `StepIndicator` with 4 steps and labels likely clips on 390px.
- Step 1 (Quote Setup) and Step 3 (Review) have side-by-side panel layouts that need stacking.

**Tasks:**
- [x] `StepIndicator`: on mobile show only step numbers + current label, hide non-active labels (`hidden sm:block`); connector bars `w-10 sm:w-16`; circle `w-9 h-9 md:w-10 md:h-10`.
- [x] `Step1QuoteSetup`: Next button `w-full sm:w-auto` (stacks full-width on mobile).
- [x] `Step3Review`: Back + Generate buttons `flex-col-reverse sm:flex-row`, `w-full sm:w-auto`.
- [x] `Step2Customer`: Back + Next buttons `flex-col-reverse sm:flex-row`, `w-full sm:w-auto`.
- [x] `SalesWizard.tsx`: resume prompt `flex-wrap`; header `text-xl md:text-2xl`.

---

### 16.6 — Settings Pages

**Affected:** `settings/general`, `settings/commission`, `settings/custom-fields`, `settings/pipeline`, `settings/finance`, `settings/branches`

**Current issues:**
- Settings pages with many tabs (General has ~6 tabs) will overflow horizontally on mobile.
- Commission tier table has inline number inputs that become unusable at 390px.

**Tasks:**
- [x] Tab bars: `<div className="overflow-x-auto">` wrapper + `w-max` on `TabsList` — applied to General Settings (5 tabs) and Custom Fields (3 tabs).
- [x] `RolePermissionsEditor`: already uses Accordion + responsive flex layouts; no table overflow needed.
- [x] Commission mode cards: already `grid-cols-1 sm:grid-cols-3` ✓. Tier rows use `flex items-end gap-3` with `flex-1` inputs — functional at 390px.
- [x] Branch settings table: `rounded-md border overflow-x-auto`; alert card `flex-wrap gap-4` + `shrink-0` button.
- [x] Finance settings: both Finance Companies + Document Rules tables wrapped with `overflow-x-auto`.

---

### 16.7 — Reports & Accounting

**Files:** `app/(dashboard)/reports/page.tsx`, `components/accounting/AccountingClient.tsx`, `components/accounting/GeneralLedgerTab.tsx`

**Tasks:**
- [x] Reports page 5-tab `TabsList`: wrapped in `overflow-x-auto` div with `w-max` on the list.
- [x] All 5 report section headers: `flex-wrap gap-2` so Export/Print buttons wrap on narrow screens.
- [x] All 5 report tables: `overflow-x-auto` added to the enclosing `Card`.
- [x] Accounting `TabsList` (4 tabs): `overflow-x-auto` wrapper + `w-max` on list; `self-start w-full sm:w-auto` on wrapper.
- [x] General Ledger: already had `overflow-x-auto` ✓; all 4 accounting tabs (FixedAssets, PartnerEquity, Claims + Ledger) now have `overflow-x-auto` table wrappers.

---

### 16.8 — Polish & Cross-Cutting

**Tasks:**
- [x] **Touch targets**: Mobile card buttons in Vehicles, Customers, Sales cards: `h-9 w-9` → `h-10 w-10` (36px→40px). Leads delete button: `p-2` → `p-3` (raw button, 32px→40px). TopNav mobile search toggle: `h-9 w-9` → `h-10 w-10`.
- [ ] **RTL + mobile**: Visual test — verify `me-`, `ms-`, `start-`, `end-` directional classes render correctly in Arabic mode at 390px. All Phase 16 changes use directional classes throughout.
- [ ] **Landscape phone**: Visual test at 667×375 (iPhone SE landscape) — dialogs scroll, wizard fits.
- [ ] **Tablet (768px)**: Visual verify sidebar + `md:` breakpoint transitions on key pages.
- [ ] **Font sizes**: All mobile card text uses `text-xs` (12px) minimum — `text-[10px]` used only for mono VIN and status chips where density is required.
- [x] **Feedback widget**: `bottom-5` → `bottom-[calc(1.25rem+env(safe-area-inset-bottom))]` for iOS home indicator clearance.

---

### Delivery Order

| Sub-phase | Effort | Impact | Branch milestone |
|-----------|--------|--------|-----------------|
| 16.1 Navigation shell | ~1 day | High (every page) | Commit A |
| 16.2 Table overflow (Tier A) | ~0.5 day | High (all list pages) | Commit B |
| 16.3 Dashboard | ~0.5 day | High (landing page) | Commit C |
| 16.4 Dialogs & forms | ~1 day | High (all create/edit flows) | Commit D |
| 16.2 Card views (Tier B) | ~1.5 days | Medium (4 key pages) | Commit E |
| 16.5 Sales Wizard | ~1 day | High (core transaction flow) | Commit F |
| 16.6 Settings | ~0.5 day | Medium | Commit G |
| 16.7 Reports & Accounting | ~0.5 day | Medium | Commit H |
| 16.8 Polish & RTL testing | ~1 day | High (quality gate) | Commit I |

**Total estimated effort:** ~7–8 dev days

---

### Definition of Done

- [ ] All primary pages render without horizontal overflow on a 390px viewport (Chrome DevTools iPhone 16 profile)
- [ ] All dialogs are scrollable and fully usable on mobile
- [ ] Desktop layout at 1280px is pixel-identical to pre-Phase-16
- [ ] Arabic (RTL) mode passes the same mobile checks
- [ ] No new TypeScript errors (`pnpm build` clean)
- [ ] `pnpm test` still passes

---

## Phase 17 — Super Admin Dashboard ✅

**Branch:** `feature/phase-17-super-admin`

A developer-only, cross-tenant control panel — fully separate from per-org RBAC — for full visibility into and control over every organization's data.

### Delivered
- [x] 17.1 — `requireSuperAdmin(ctx)` (`convex/utils/tenancy.ts`) gated by `SUPER_ADMIN_EMAILS` env var; `/admin` route shell (`app/admin/layout.tsx`) outside `app/(dashboard)/[orgId]/` since `OrgProvider` can't accommodate cross-org browsing
- [x] 17.2 — `convex/adminOrgs.ts`: list/suspend/unsuspend/hard-delete any org (typed-confirmation delete cascades across all ~37 org-scoped tables); `organizations.suspended` flag enforced in `requireTenantAuth`
- [x] 17.3 — `convex/adminUsers.ts`: cross-org user list, disable/enable (`users.disabled` enforced in `requireAuth`), change role, remove membership, hard-delete (DB + Clerk account); impersonation deep-links to the Clerk Dashboard's built-in "Impersonate user" feature
- [x] 17.4 — `convex/adminData.ts`: generic cross-org data browser over ~20 entity tables — list/get/update/hard-delete via one module instead of per-table CRUD (isolated `as any` cast where Convex's `Id<TableName>` can't be parameterized by a runtime string); `app/admin/data/page.tsx` raw-JSON editor
- [x] 17.5 — `convex/adminSystem.ts`: cross-org entity counts, cron heartbeats (`cronHeartbeats` table, written by `crons.ts`), webhook delivery log (`webhookLogs` table, written by `http.ts`'s Clerk + WhatsApp handlers); links out to Sentry for error logs
- [x] 17.6 — `convex/adminAudit.ts`: `adminAuditLog` table + `logAdminAction()` helper called by every admin mutation; `app/admin/audit/page.tsx` viewer
- [x] 17.7 — `convex/admin*.test.ts` (4 files, allowlist-gate + cross-org-write coverage); `CLAUDE.md` Super Admin section; 138/138 tests passing, clean typecheck/build/lint

### Setup
Set the allowlist on the Convex deployment: `npx convex env set SUPER_ADMIN_EMAILS "you@example.com"` (comma-separated for multiple developers).

## Phase 18 — Landing Page Legal Pages, Contact Form & Marketing Chat Assistant ✅

Public-facing additions to the marketing landing page: a working Privacy Policy / Terms of Service, a functioning Contact Us form, and a self-service FAQ chat assistant with live-agent escalation for anonymous visitors.

### Delivered
- [x] 18.1 — `app/privacy/page.tsx`, `app/terms/page.tsx`: bilingual (EN/AR) legal pages styled to match the landing page; `components/marketing/MarketingShell.tsx` shared header/footer for new public pages
- [x] 18.2 — `app/contact/page.tsx`: react-hook-form + zod contact form (`components/marketing/contact.schema.ts`) wired to a new public `convex/support.submitContactMessage` mutation — reuses the existing email support inbox (`supportThreads`/`supportMessages`, same tables/auto-reply the Resend webhook already populates) so submissions show up in `/admin/support` and get an auto-reply; new `contactForm` rate-limit bucket (3/10min, keyed by email) in `convex/rateLimit.ts`
- [x] 18.3 — `proxy.ts`: added `/privacy`, `/terms`, `/contact` to the public route matcher (Clerk middleware was redirecting anonymous visitors to `/sign-in`)
- [x] 18.4 — Extended `liveChatThreads`/`liveChatMessages` (`convex/schema.ts`) with optional `kind`/`leadId`/`leadEmail` fields (undefined `kind` = pre-existing dealer rows) so anonymous marketing-site visitors can flow through the **same** WAITING/OFFERED/ACTIVE/CLOSED agent queue as dealer live-chat — no separate routing system. Anonymous identity is a random capability token (`leadId`, stored in the visitor's localStorage) instead of a Clerk session
- [x] 18.5 — `convex/liveChat.ts`: new lead-facing public functions (`startOrGetLeadThread`, `getLeadThread`, `getLeadThreadMessages`, `sendLeadMessage`, `markLeadThreadRead`, `setLeadTyping`, `updateLeadPresence`, `endThreadByLead`); `requestOrgAccess`/`revokeOrgAccess` guarded against orgId-less LEAD threads; 5 new tests in `convex/liveChat.test.ts` (22/22 passing)
- [x] 18.6 — `components/marketing/MarketingChatWidget.tsx`: floating chat bot on the landing page — sends a greeting, offers FAQ category/question chips (`lib/marketingFaq.ts`), replies inline, and escalates to the real-time agent queue ("Talk to a human") with an optional name/email capture step
- [x] 18.7 — `app/support/page.tsx`: agent console now labels LEAD threads ("Website Lead" badge + captured email) and hides the dealer-only "Get access to dealer's dashboard" action for them
- [x] 18.8 — Full suite green (164/164 tests, clean typecheck/lint); graph updated via `python -m graphify update .`
