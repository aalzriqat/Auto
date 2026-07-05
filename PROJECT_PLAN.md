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
| 19 | main | Duplicate Detection on Create (CRM data quality, part 1) | ✅ Done |
| 20 | main | VIN Checksum Validation (CRM data quality, part 2) | ✅ Done |
| 22 | main | Social Integrations Settings + Instagram OAuth Connect | ✅ Done |
| 23 | main | Manual "Post to Instagram" Action | ✅ Done |
| 24 | main | Auto-Post Toggle on Vehicle Status → AVAILABLE | ✅ Done |
| — | main | Instagram Post Engagement (likes/comments) + Deauth/Data-Deletion Callbacks | ✅ Done |
| 19a | main | Customer Merge Tool (CRM data quality, part 3) | ✅ Done |
| 19b | main | Lead → Sale Conversion Visibility (CRM data quality, part 4) | ✅ Done |
| 21 | main | Data Quality Dashboard Widget (CRM data quality, part 5) | ✅ Done |
| 25 | main | Instagram Engagement: Comments/DMs Capture, Auto-Reply, Lead Creation, Social Inbox | ✅ Done |
| 26 | main | Facebook Page Integration: Connect, Post, Inbound Engagement + Lead-Creation Toggles | ✅ Done |
| 28 | main | Notification System Overhaul: multi-channel, bilingual, preferences, broadcasts | ✅ Done |

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

## Phase 19 — CRM Data Quality: Duplicate Detection on Create ✅

**Branch:** `main` · First phase of the CRM Data Quality bundle (dedup → merge tool → lead/sale linking → VIN checksum → dashboard widget).

Customers already hard-blocked duplicate `email` on create; this phase extends the same hard-block to `phone` (a more reliable identifier in this market), and adds non-blocking advisory signals for fuzzy/name-based duplicates and redundant open leads — never hard-blocking on a fuzzy match, since dealerships legitimately have repeat customers and common names.

### Delivered
- [x] `convex/schema.ts` — `customers` table gains `.index("by_org_phone", ["orgId", "phone"])`
- [x] `convex/utils/dedup.ts` (new) — `normalizePhone()` (strips formatting, preserves leading `+`) and `namesSimilar()`, shared across customers/leads and reserved for the future merge tool (Phase 19a)
- [x] `convex/customers.ts` — `create`/`update`/`importBulk` now hard-block on duplicate phone (mirroring the existing email check) and store phone in normalized form; new `checkDuplicates` query (bounded `.take(50)` scan) returns exact phone/email matches + possible name matches for client-side pre-submit warnings
- [x] `convex/leads.ts` — new `checkExistingOpenLead` query surfaces a non-blocking "this customer already has an open lead" nudge (ignores WON/LOST leads)
- [x] `components/customers/CustomerDialog.tsx`, `components/leads/LeadDialog.tsx` — debounced duplicate checks wired to the new queries with inline amber warning banners
- [x] `lib/i18n/domains/customers.ts`, `lib/i18n/domains/leads.ts` — `DuplicateCustomerFound`, `ExistingOpenLeadWarning` (EN + AR)
- [x] `convex/customers.test.ts`, `convex/leads.test.ts` — phone hard-block (including format-insensitivity), `checkDuplicates` exact/fuzzy/exclude-self coverage, `checkExistingOpenLead` open/WON-LOST/exclude-self coverage
- [x] Full suite green (170/170 tests), clean typecheck, no new lint issues

## Phase 20 — CRM Data Quality: VIN Checksum Validation ✅

**Branch:** `main` · Second phase of the CRM Data Quality bundle.

Adds ISO 3779 / NHTSA VIN check-digit validation. Scoped deliberately: the check-digit convention is North-America-specific (many non-NA-built vehicles, common in this market, legitimately fail it), so checksum mismatches are a **soft, non-blocking warning** — never a hard rejection. The I/O/Q character rule, by contrast, is universally invalid in *every* VIN scheme, so that one is enforced as a hard rule both client- and server-side.

### Delivered
- [x] `lib/vinHelpers.ts` — `hasInvalidVinCharacters()` and `validateVinChecksum()` (ISO 3779 transliteration table, position weights, mod-11 check digit)
- [x] `lib/vinHelpers.test.ts` — known-good/known-bad checksum vectors, I/O/Q rejection, case-insensitivity
- [x] `components/vehicles/vehicle.schema.ts` and `convex/validations/vehicles.ts` — both gain a hard `.refine()` rejecting I/O/Q (client + server, defense in depth)
- [x] `components/vehicles/VehicleDialog.tsx` — live, non-blocking amber warning under the VIN field when the checksum doesn't match
- [x] `lib/i18n/domains/vehicles.ts` — `VinChecksumWarning` (EN + AR)
- [x] Full suite green (177/177 tests), clean typecheck

## Phase 22 — Social Posting Automation: Integrations Settings + Instagram OAuth Connect ✅

**Branch:** `main` · First phase of the Social Posting Automation bundle (Instagram/Facebook only — Dubizzle/OpenSooq/YallaMotor marketplace syndication and Haraj are explicitly parked/dropped, see PROJECT_PLAN.md scope notes from the planning session).

Lays the OAuth/credentials foundation an org owner uses to connect their Instagram Business account, ahead of the actual posting feature (Phase 23). Buildable and testable entirely in Meta's development mode (no App Review needed yet — that's only required before *other* AutoFlow orgs can connect their own accounts in production).

### Delivered
- [x] `convex/schema.ts` — `orgSettings` gains `instagramBusinessAccountId`, `instagramAccessToken`, `instagramTokenExpiresAt`, `instagramPageName`, `facebookPageId`, `facebookPageAccessToken`, `socialAutoPostEnabled` (all optional); new `oauthStates` table (CSRF protection for the OAuth redirect, one-time-use, 10-min TTL); `webhookLogs.source` union extended with `"instagram-oauth"`
- [x] `convex/utils/env.ts` — optional `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `CONVEX_SITE_URL` added to the validated env schema
- [x] `convex/socialIntegrations.ts` (new) — `createConnectUrl` (owner-only, generates CSRF state + the Meta OAuth dialog URL), `getConnectionStatus`/`disconnect`/`setAutoPostEnabled` (public), `consumeOAuthState`/`saveInstagramCredentials`/`exchangeCodeForToken` (internal — the token exchange calls Meta's Graph API directly via `fetch`, no Node runtime needed)
- [x] `convex/http.ts` — `GET /instagram-oauth-callback`: validates state, exchanges the code, redirects back to `/{orgId}/settings/integrations` with a status query param; always resolves via redirect (never throws), logs via the existing `webhookLogs` convention
- [x] `app/(dashboard)/[orgId]/settings/integrations/{page,client}.tsx` (new) — Connect/Disconnect card + an auto-post toggle (wired to `socialAutoPostEnabled`, disabled until connected); `components/layout/Sidebar.tsx` gains the nav entry (lucide-react has no Instagram/Facebook brand icons — used `Camera` instead, with the connect card's gradient circle carrying the Instagram visual cue)
- [x] `lib/i18n/domains/settings.ts` — Integrations strings (EN + AR)
- [x] `.env.example` — `INSTAGRAM_APP_ID`/`INSTAGRAM_APP_SECRET` placeholders
- [x] `convex/socialIntegrations.test.ts` (new, 8 tests) — owner-gating, connect/disconnect status, auto-post-requires-connection guard, OAuth state one-time-use/expiry
- [x] Full suite green (185/185 tests), clean typecheck
- [x] Meta App created (dev mode) with the "Manage messaging & content on Instagram" use case (API setup with Facebook Login); redirect URI registered against the production deployment's site URL; `INSTAGRAM_APP_ID`/`INSTAGRAM_APP_SECRET` set on the dev deployment via `npx convex env set`

**Design note:** "select the details to post + custom message" (raised mid-build) is addressed in Phase 23, not here — the manual post dialog will include a per-photo checkbox picker (default: all selected) and an editable caption field, not just a caption override.

## Phase 23 — Social Posting Automation: Manual "Post to Instagram" Action ✅

**Branch:** `main`

Manual-trigger posting (per the earlier design call: Instagram's container → poll → publish flow is async and can fail for reasons unrelated to AutoFlow, so it gets its own button/state rather than being wired into the vehicle status-change mutation). Includes a per-photo picker and editable caption, addressing the mid-build requirement that the dealer control exactly what gets posted, not just an auto-generated caption override.

### Delivered
- [x] `convex/schema.ts` — new `socialPosts` table (`orgId`, `vehicleId`, `platform`, `status: PENDING|PUBLISHED|FAILED`, `caption`, `imageStorageIds`, `externalPostId`, `externalPermalink`, `errorMessage`, `triggeredBy: manual|auto`, `requestedBy`, `requestedAt`, `publishedAt`), indexed `by_org` + `by_org_vehicle`; added to `adminOrgs.ts`'s `ORG_SCOPED_TABLES` for cascade-delete
- [x] `convex/rateLimit.ts` — new `socialPosting` bucket (10/min per org)
- [x] `convex/socialPostingData.ts` (new) — `requestPost` (validates connection + selected photos actually belong to the vehicle, inserts PENDING row, schedules the publish action via `ctx.scheduler.runAfter(0, ...)`), `listForVehicle`, plus internal `getPostContext`/`getImageUrls`/`markPostResult` (patches status, notifies the requester on completion either way)
- [x] `convex/socialPosting.ts` (new, `"use node"`) — `publishToInstagram`: builds a single-image or carousel container, polls for `FINISHED` status, publishes, fetches the permalink. Node runtime chosen over the lighter V8 action runtime specifically because the container-polling retry loop needs `setTimeout`
- [x] `components/vehicles/VehicleMarketingTab.tsx` (new) — photo checkbox grid (all selected by default), editable caption textarea (pre-filled with a year/make/model/price template), "Post to Instagram" button, post history with status badges + "View on Instagram" links; shows a connect-prompt empty state if Instagram isn't connected
- [x] `components/vehicles/VehicleDetailsDialog.tsx` — new "Marketing" tab (reuses `VIEW_VEHICLE_INFO` permission rather than adding a new one)
- [x] `lib/i18n/domains/vehicles.ts` — new EN + AR strings
- [x] `convex/socialPostingData.test.ts` (new, 7 tests) — rejects when disconnected, rejects empty selection, rejects photos not belonging to the vehicle, queues correctly, `listForVehicle` ordering, `markPostResult` PUBLISHED/FAILED + notification
- [x] Full suite green (192/192 tests), clean typecheck

## Phase 24 — Social Posting Automation: Auto-Post Toggle on Status → AVAILABLE ✅

**Branch:** `main`

Wires up the `socialAutoPostEnabled` toggle that Phase 22 already exposed in Settings > Integrations but didn't actually do anything — completing the bundle. Opt-in only (off by default), and only takes effect once Instagram is connected and the toggle is explicitly turned on.

A vehicle's status can become AVAILABLE through three different mutations in this codebase, not just one — all three are wired to the same shared, no-throw helper so the behavior is consistent regardless of which path a dealer used:

### Delivered
- [x] `convex/utils/socialAutoPost.ts` (new) — `maybeAutoPostToInstagram()`, mirroring the existing `saleHelpers.ts` shared-helper pattern. No-ops silently (never throws) unless auto-post is enabled, Instagram is connected, and the vehicle has photos; builds the same caption template as the manual-post UI default and queues a `socialPosts` row tagged `triggeredBy: "auto"`, fully `ctx.scheduler.runAfter(0, ...)`-deferred so it can never block or fail the status-change mutation it's called from
- [x] `convex/vehicles.ts` — `update` (direct status edit, for users with full `EDIT_VEHICLES`) now calls the helper when `patch.status` transitions to `AVAILABLE`
- [x] `convex/vehicleRequests.ts` — `resolve` (the dedicated status-approval workflow) calls the helper when an `AVAILABLE` request is approved
- [x] `convex/vehicleEdits.ts` — `resolve` (the general edit-approval workflow, whose payload can also include a status change for non-privileged requesters) calls the helper too, for consistency across all three status-changing paths
- [x] `convex/vehicles.test.ts`, `convex/vehicleRequests.test.ts` (new) — 7 tests: queues on enabled+connected+has-photos, skips when disabled / not connected / no photos / already-AVAILABLE (no-op re-trigger), skips on rejection, skips for non-AVAILABLE approvals
- [x] Full suite green (177 passed, 22 intentionally skipped — see live chat note below), clean typecheck

## Operational — Live Chat Disabled (Excessive Convex Usage) ✅

**Branch:** `main`

The live chat system (Phase 18's dealer + marketing-site widgets, plus the `/support` agent console) was driving excessive Convex function-call usage. Root cause: presence (`updateDealerPresence`/`updateAgentPresence`, every 10s) and typing (`setDealerTyping`/`setAgentTyping`, throttled ~2s) pings write directly onto the `liveChatThreads` row that broader queries (`listQueue`, `getMyThread`, `getThreadForAgent`) subscribe to — every ping fans out into a re-run of every subscribed client's query. The dominant source wasn't the widgets (which, investigation found, are actually **not mounted anywhere in the app** — orphaned since Phase 18 despite being documented as wired up) but **`SupportAccessBanner`**, mounted globally in `app/(dashboard)/[orgId]/layout.tsx`, meaning it ran a live query for every dealer user on every page of the entire app. `app/support/layout.tsx`'s 25s agent heartbeat (fires just from having `/support` open, no active chat needed) was the second contributor.

Disabled fully and reversibly via a kill switch, not a deletion — the Phase 18 implementation is untouched underneath.

### Delivered
- [x] `convex/liveChat.ts` — `LIVE_CHAT_ENABLED = false` constant + `assertLiveChatEnabled()` guard inserted as the first line of all 36 exported query/mutation/internalMutation handlers (backend defense-in-depth — throws `ConvexError("Live chat is currently disabled.")`)
- [x] `lib/featureFlags.ts` (new) — frontend-side mirror of the same flag (separate bundles, can't share the Convex-side constant directly)
- [x] Gated every frontend call site behind the flag (outer wrapper component with no hooks → renders the real implementation only when enabled, avoiding Rules-of-Hooks issues): `components/support/SupportAccessBanner.tsx` (the global one — fixed *before* it could break the dashboard for every user, since the backend guard alone would have made its `useQuery` throw on every page load), `app/support/layout.tsx`, `app/support/page.tsx`, `components/support/LiveChatWidget.tsx`, `components/marketing/MarketingChatWidget.tsx`
- [x] `convex/liveChat.test.ts` — all 22 tests skipped (not deleted) via a local `describe = vitestDescribe.skip` shadow, with a comment pointing back to the flag
- [x] Full suite green (170 passed, 22 skipped intentionally), clean typecheck, no new lint errors

**To re-enable:** flip `LIVE_CHAT_ENABLED` to `true` in both `convex/liveChat.ts` and `lib/featureFlags.ts`, unskip `convex/liveChat.test.ts`, and — before doing so — fix the underlying reactivity issue (move presence/typing off the actively-broadly-queried `liveChatThreads` row, e.g. a separate sparse presence table or a `patch` that doesn't touch fields `listQueue`/`getMyThread` read) so it doesn't immediately reproduce the same usage spike.

## Operational — Instagram Post Engagement + Required Deauth/Data-Deletion Callbacks ✅

**Branch:** `main`

Extends Phase 23's Marketing tab with read access to a published post's performance, plus the two dashboard endpoints Meta requires for every Instagram Login app before App Review can even be submitted.

### Delivered
- [x] `convex/socialIntegrations.ts` — added `instagram_business_manage_comments` to the requested OAuth scope (orgs connected before this change must reconnect to pick it up); new `disconnectByInstagramUserId` internal mutation used by the callbacks below (looks up by IG business account ID, not orgId, since that's all Meta's signed payload identifies)
- [x] `convex/http.ts` — `POST /instagram-deauthorize` and `POST /instagram-data-deletion`, both verifying Meta's `signed_request` (base64url HMAC-SHA256 via Web Crypto, no Node runtime needed) before clearing stored credentials
- [x] `app/data-deletion-status/page.tsx` (new) — minimal confirmation page Meta's data-deletion flow links users back to
- [x] `convex/schema.ts` — `socialPosts` gains `likeCount`/`commentsCount`/`engagementSyncedAt`
- [x] `convex/socialEngagement.ts` (new) — `refreshEngagement` (like/comment counts, needs only the basic scope already in use), `listComments`/`replyToComment`/`setCommentHidden` (need the new comments scope)
- [x] `components/vehicles/VehicleMarketingTab.tsx` — post history rows now show like/comment counts with a refresh button, and an expandable comment thread with reply + hide/unhide
- [x] `components/vehicles/VehicleDetailsDialog.tsx` — widened `max-w-4xl` → `max-w-5xl` and removed the hidden-scrollbar trick on the tab bar, fixing the Marketing tab being clipped with no visible scroll affordance
- [x] CI lint gate fix (was failing since the gate was added in `c3bf0f7`, unrelated to this work but found while verifying): excluded the two standalone CommonJS tooling scripts (`marketing/render-cover.js`, `testsprite_tests/get_token.js`) from ESLint scope; fixed a real `react-hooks/refs` error in `app/support/layout.tsx` (ref write moved from render into a `useEffect`)
- [x] Full suite green, clean typecheck/lint/build

## Phase 19a — CRM Data Quality: Customer Merge Tool ✅

**Branch:** `main` · Third phase of the CRM Data Quality bundle.

- [x] `convex/schema.ts` — new `customerMerges` audit table (`orgId`, `survivorId`, `loserId`, `mergedBy`, `mergedAt`, `reassignedCounts`), indexed `by_org`, added to `adminOrgs.ts`'s `ORG_SCOPED_TABLES`; new `by_org_customer` indexes on `leads`, `sales`, and `tasks` (replacing `.filter()`-after-`by_org` scans in the new merge code and in `checkExistingOpenLead`/`softDelete`/`getLinkedSale`, per the Convex guideline to index rather than filter)
- [x] `convex/utils/permissions.ts` — new `PERMISSIONS.MERGE_CUSTOMERS`, granted to OWNER (automatic — OWNER bypasses the permissions array entirely) and added to the MANAGER default role template
- [x] `convex/utils/mergeHelpers.ts` (new) — `CUSTOMER_REFERENCING_TABLES`, an explicit list (mirroring `ORG_SCOPED_TABLES`) of every table with a `customerId` FK and how to look it up by the most specific available index
- [x] `convex/customers.ts` — `findMergeCandidates` (groups customers by normalized name), `previewMerge` (per-table reassignment counts before confirming), `mergeCustomers` (reassigns every FK, merges scalar fields — survivor's non-empty values win unless `fieldOverrides` picks the loser's, with a guard against violating the phone/email uniqueness constraint against an unrelated third customer — soft-deletes the loser, writes the audit row)
- [x] `components/customers/MergeCustomersDialog.tsx` (new) — duplicate-candidate list → pick survivor/loser (or pick manually) → field-by-field comparison with per-field radio → impact preview → confirm
- [x] `app/(dashboard)/[orgId]/customers/page.tsx` — "Merge Duplicates" entry point gated by `PERMISSIONS.MERGE_CUSTOMERS`
- [x] `lib/i18n/domains/customers.ts` — new EN + AR strings
- [x] `convex/customers.test.ts` — FK reassignment correctness across leads/sales/guarantors, soft-delete of the loser, audit row, self-merge rejection, cross-org rejection, permission rejection

## Phase 19b — CRM Data Quality: Lead → Sale Conversion Visibility ✅

**Branch:** `main` · Fourth phase of the CRM Data Quality bundle. No schema change — `closeLeadsAsWon` (`convex/utils/saleHelpers.ts`) already deterministically links every closed lead to its sale via shared `customerId`+`vehicleId`, so this is a read-side lookup, not a stored FK.

- [x] `convex/leads.ts` — `getLinkedSale` query (single-lead lookup via the new `sales.by_org_customer` index)
- [x] `components/leads/LeadDialog.tsx` — WON leads show "Converted to Sale — $X on [date]" instead of a static stage badge
- [x] `lib/i18n/domains/leads.ts` — new EN + AR strings
- [x] `convex/leads.test.ts` — null for non-WON leads, finds the correct sale for a WON lead

## Phase 21 — CRM Data Quality: Data Quality Dashboard Widget ✅

**Branch:** `main` · Fifth and final phase of the CRM Data Quality bundle.

- [x] `convex/dashboard.ts` — `dataQualityStats` query (bounded scans): customers missing phone/email, vehicles with a VIN checksum warning (reuses Phase 20's `validateVinChecksum` from `lib/vinHelpers.ts`, imported directly into a Convex query — VIN is a required field so "missing VIN" can't happen, the checksum warning is the actually-useful signal)
- [x] `app/(dashboard)/[orgId]/dashboard/page.tsx` — new amber nudge card, only rendered when there's actually something to flag, links to the customers page
- [x] `lib/i18n/domains/dashboard.ts` — new EN + AR strings
- [x] `convex/dashboard.test.ts` (new) — counts match seeded data

**CRM Data Quality bundle (Phases 19, 19a, 19b, 20, 21) is now fully shipped.**

## Phase 25 — Instagram Engagement: Comments/DMs Capture, Auto-Reply, Lead Creation, Social Inbox ✅

**Branch:** `main` · Extends the Social Posting Automation bundle (Phases 22-24) from outbound posting into inbound engagement — capturing customer comments/DMs on dealership posts, replying automatically, and turning them into leads.

Built and debugged live in production. Two undocumented Meta API quirks were found and fixed along the way: (1) Instagram uses two different IDs for the same connected account — the OAuth token exchange's `id` (for outbound Graph API calls) vs. the profile's `user_id` (used in webhook `entry[].id` for routing) — captured separately as `instagramBusinessAccountId`/`instagramWebhookAccountId`; (2) replying to a comment via the Graph API causes Instagram to fire a fresh `comments` webhook for our own reply, which without a guard gets reprocessed as a new inbound comment and auto-replies to itself in a loop.

### Delivered
- [x] `convex/schema.ts` — new `instagramEvents` table (`kind: "comment"|"dm"`, sender info, `customerId`/`leadId`/`vehicleId` links, auto/manual reply fields), indexed `by_org_external` (dedup), `by_org_sender` (cooldown), `by_org`, `by_org_lead`; `orgSettings` gained `instagramWebhookAccountId` + index, `instagramAutoReplyEnabled/Messages/LastIndex`; `customers` gained `instagramUserId`
- [x] `convex/instagramEngagement.ts` (new) — `handleIncomingInstagramEvent` (find/create customer+lead, dedup, vehicle-linking via `socialPosts.by_external_post_id`, round-robin auto-reply with 24h per-sender cooldown shared across comments+DMs), `enrichCustomerProfile` (fetches the sender's real name from Instagram's profile API for DM-only senders, since DM payloads never carry a username), `sendCommentReply`/`sendDirectMessage` (auto-reply actions), `listConversations` (paginated, org-wide, one row per customer conversation — groups all of a lead's events in JS since Convex has no native GROUP BY), `listEventsForLead`, `replyToInstagramComment`/`sendInstagramDirectMessage` (manual reply actions used by the UI)
- [x] `convex/utils/instagramApi.ts` (new) — shared `postCommentReply`/`postDirectMessage` Graph API helpers used by both auto- and manual-reply paths
- [x] `convex/http.ts` — `/instagram-webhook` GET (handshake) + POST (routes comments via `entry[].changes`, DMs via `entry[].messaging`; DM branch skips `is_echo` messages, comment branch skips our own account's `from.id` to prevent the self-reply loop)
- [x] `convex/socialIntegrations.ts` — corrected OAuth scope to `instagram_business_manage_messages`; added the required per-account `POST /{ig-user-id}/subscribed_apps` opt-in call (separate from app-level webhook config) during token exchange
- [x] `app/(dashboard)/[orgId]/social-inbox/page.tsx` (new) — dedicated nav page, one row per conversation (sender, message count, vehicle(s), latest text, status), desktop table + mobile cards
- [x] `components/leads/SocialConversationDialog.tsx` (new) — per-lead conversation view, chat-bubble layout (customer messages start-aligned, our auto/manual replies end-aligned and visually distinct, labeled with the replying staff member's name or "Auto-reply"), per-vehicle context label when a conversation spans more than one post, inline comment-reply composer + bottom DM composer
- [x] `app/(dashboard)/[orgId]/leads/page.tsx` — conversation icon button on Instagram-sourced leads opening the dialog; `?highlightId=` from notification links now scrolls to and highlights the matching row
- [x] `lib/i18n/domains/socialInbox.ts` (new) — EN + AR strings
- [x] `convex/instagramEngagement.test.ts` (new, 22 tests) — webhook event handling, dedup, vehicle linking, auto-reply cooldown, profile enrichment, `listConversations` grouping/ordering, manual reply actions, permission gating
- [x] Full suite green, clean typecheck/lint/build

**Known gap:** the self-reply-loop fix has no automated test — this codebase has no httpAction-level test harness for any webhook route (`convex/http.ts` isn't exercised via `t.fetch` anywhere), so it was verified by reasoning about the documented Graph API behavior and needs live production confirmation, same as the earlier dual-ID bug.

**Not yet pursued:** `instagram_business_manage_messages` App Review submission (still Tester-only).

## Phase 26 — Facebook Page Integration: Connect, Post, Inbound Engagement ✅

**Branch:** `main` · Brings Facebook Pages to parity with Instagram (Phases 22-25) in one pass — connect, manual + auto posting, and inbound comment/Messenger DM engagement — reusing Instagram's proven architecture rather than redesigning from scratch. Also adds a per-platform, per-event-kind toggle for whether inbound comments/DMs create a CRM lead at all (requested mid-build), and reworks the Social Inbox's grouping key from `leadId` to `customerId` to support that.

Key structural difference from Instagram: Facebook Login authenticates a person who may manage multiple Pages, so token exchange has an extra `GET /me/accounts` step to resolve the Page + its own Page Access Token (non-expiring, unlike Instagram's 60-day token) — the first Page returned is used, no multi-page picker. The Instagram self-reply webhook loop (Phase 25 bug) was built in as a day-one guard here, not a follow-up fix.

### Delivered
- [x] `convex/schema.ts` — `orgSettings` gains `facebookPageId`/`facebookPageAccessToken`/`facebookPageName`/`facebookConnectedByUserId`/`facebookTokenExpiresAt`/`facebookAutoReply*` + per-platform `instagramLeadFromCommentsEnabled`/`instagramLeadFromDmsEnabled`/`facebookLeadFromCommentsEnabled`/`facebookLeadFromDmsEnabled` (undefined defaults to `true`, preserving pre-toggle behavior); `customers.facebookUserId`; new `facebookEvents` table mirroring `instagramEvents` (kept separate, not merged, to avoid touching tested live Instagram code); `by_org_customer` index added to both event tables; `webhookLogs.source` gains `facebook`/`facebook-oauth` (in both `schema.ts` and `adminSystem.ts`'s duplicated validator)
- [x] `convex/facebookIntegrations.ts` (new) — OAuth connect (Facebook Login, `pages_show_list`/`pages_manage_posts`/`pages_manage_engagement`/`pages_messaging`/`pages_read_engagement`), token exchange (`/me/accounts` → Page token, `/me` → connecting user ID for deauth/data-deletion resolution), `subscribed_apps` opt-in, `setFacebookLeadCreationConfig`
- [x] `convex/utils/facebookApi.ts` (new) — `postCommentReply`/`postDirectMessage` Graph API helpers
- [x] `convex/facebookEngagement.ts` (new) — `handleIncomingFacebookEvent` (find/create customer+lead-if-enabled+vehicle-link+auto-reply), manual reply/DM actions keyed by `customerId`
- [x] `convex/facebookPosting.ts` (new) — `publishToFacebook`, synchronous (no container-polling needed unlike Instagram): single photo via `/photos`, multi-photo via unpublished photos + `/feed` with `attached_media`
- [x] `convex/http.ts` — `/facebook-oauth-callback`, `/facebook-deauthorize`, `/facebook-data-deletion` (reusing the generic `verifyMetaSignedRequest`/`verifyHubSignature256` helpers as-is), `/facebook-webhook` GET+POST — comment branch includes the self-reply-loop guard from day one (skips events where `from.id` matches the org's own `facebookPageId`)
- [x] `convex/socialPostingData.ts` — `requestPost` takes a `platform` arg, branches connection-check and scheduled action; `markPostResult` notification text is platform-labeled
- [x] `convex/utils/socialAutoPost.ts` — `maybeAutoPostToFacebook`, called alongside `maybeAutoPostToInstagram` at all 3 existing call sites (`vehicles.ts`, `vehicleEdits.ts`, `vehicleRequests.ts`); `socialIntegrations.setAutoPostEnabled`'s connect-gate fixed to accept either platform (was Instagram-only, a real gap for Facebook-only orgs)
- [x] `convex/instagramEngagement.ts`/`facebookEngagement.ts` — lead creation is now independently toggleable per event kind; when off, the event is still captured and still auto-replied to, it just doesn't create a Lead or fire a notification
- [x] `convex/socialInbox.ts` (new) — cross-platform `listConversations`/`listEventsForCustomer`, grouped by `customerId` (not `leadId`, since lead creation is now optional), merging `instagramEvents` + `facebookEvents` in JS and tagging each row with `platform`
- [x] `components/leads/SocialConversationDialog.tsx`, `app/(dashboard)/[orgId]/social-inbox/page.tsx`, `app/(dashboard)/[orgId]/leads/page.tsx` — switched to `socialInbox`/`customerId`, dialog reply/DM actions dispatch by `event.platform`; platform badge (lucide-react has no IG/FB brand icons, used colored initial badges)
- [x] `app/(dashboard)/[orgId]/settings/integrations/client.tsx` — Facebook connect/disconnect card mirroring Instagram's, shared auto-post toggle (gated on either connection, not duplicated per card), per-platform lead-creation toggles
- [x] `components/vehicles/VehicleMarketingTab.tsx` — "Post to Facebook" button alongside Instagram's, platform badge on post history, engagement (likes/comments) panel scoped to Instagram posts only (Facebook has no equivalent wired up)
- [x] `lib/i18n/domains/settings.ts`, `socialInbox.ts`, `vehicles.ts` — new EN + AR strings
- [x] `convex/_generated/api.d.ts` — hand-extended with the new modules; full `npx convex codegen` push was blocked by an unrelated pre-existing gap (the dev deployment was missing several optional env vars `auth.config.ts` transitively references), not pursued further since it's outside this phase's scope
- [x] New test files: `facebookIntegrations.test.ts`, `facebookEngagement.test.ts`, `socialInbox.test.ts` (28 new tests); extended `instagramEngagement.test.ts`, `socialIntegrations.test.ts`, `socialPostingData.test.ts` for the new signatures/toggles
- [x] Full suite green (255 passed, 22 skipped), clean typecheck/lint/build

**Known gaps, same category as Phase 25's:** the self-reply-loop guard has no automated test (no httpAction test harness in this codebase); unconfirmed whether Facebook Login can be added as a second product on the existing Instagram-configured Meta App or needs a separate App — user should expect live Meta dashboard setup, same as every prior integration round. Multi-Page orgs aren't given a picker (first Page returned is used).

## Phase 28 — Notification System Overhaul: Multi-Channel, All-Action Coverage, Preferences, Broadcasts ✅

**Branch:** `main` · Took the notification system from a 13-file, English-only, in-app-only bell dropdown to a typed, bilingual, multi-channel (in-app + email + WhatsApp) system covering ~45 action types across the whole app, with per-user/per-category preferences, a dedicated history page, and super-admin broadcasts. (Phase 27 — WhatsApp Catalog — was reserved but never started; numbering skips it.)

Key design decisions: notifications are now `(type, data)` pairs rendered bilingually at read time (mirrors the existing `convex/utils/smartReplyBuilder.ts` + `lib/i18n/domains/socialSmartReply.ts` cross-import pattern) rather than stored English strings, so Arabic users get Arabic notifications; email is opt-out-by-default only for actionable/account-affecting categories (approvals, role/account changes, vehicle status requests), opt-in for everything else and all of WhatsApp; WhatsApp reuses previously-unused `orgSettings.whatsappPhoneNumberId`/`whatsappApiToken` fields via Meta's Cloud API; legacy `title`/`message` fields stay on the schema (now optional) so pre-existing rows keep rendering without a data migration.

### Delivered
- [x] `convex/schema.ts` — `notifications` gains `type`/`category`/`priority`/`data`/`isArchived`/`archivedAt` (title/message now optional, legacy fallback) + `by_org_user_read`/`by_org_user_category` indexes; new `notificationPreferences` and `notificationBroadcasts` tables; `users` gains `locale`/`whatsappPhone`; `webhookLogs.source` (schema + the duplicated validator in `adminSystem.ts`, same gotcha as Phase 26) gains `notification-email`/`notification-whatsapp`
- [x] `lib/notifications/types.ts` (new) — the ~55-entry notification type registry (category/priority/email-default-opt-out per type); `lib/i18n/domains/notifications.ts` (new) — bilingual EN/AR templates; `lib/notifications/render.ts` (new) — `renderNotification()`, the single rendering path shared by the bell, the notifications page, the email action, and the WhatsApp action (`system.announcement` special-cased to render admin-authored text directly, bypassing the dictionary)
- [x] `convex/utils/notifications.ts` (rewritten) — `dispatch()` core (always inserts in-app, schedules email/WhatsApp per preference with the type's critical-default fallback) plus `notifyUser`/`notifyManagers`/`notifyAllMembers`/`notifyOwner` wrappers
- [x] `convex/email.ts` — `sendNotificationEmail` action; new `convex/whatsappSend.ts` (`"use node"`) — `sendNotificationWhatsapp` action via Meta Graph API, reusing `convex/whatsapp.ts`'s existing `getSettingsByOrg` query (queries can't live in a `"use node"` file); new `notificationWhatsapp` rate bucket
- [x] `convex/notifications.ts` — added `unreadCount`, `listPage` (paginated, category/archived filters), `archive`; `convex/notificationPreferences.ts` (new) — `getMyPreferences`/`setPreference`; `convex/users.ts` — `updateMyNotificationProfile` (locale + WhatsApp number)
- [x] Migrated all 12 pre-existing `notifyUser`/`notifyManagers` call sites (`customers.ts`, `sales.ts`, `leads.ts`, `vehicles.ts`, `vehicleEdits.ts`, `expenses.ts`, `applications.ts`, `guarantors.ts`, `crons.ts`, `facebookEngagement.ts`, `instagramEngagement.ts`, `socialPostingData.ts`, `whatsapp.ts`) from inline English strings to typed `(type, data)` calls
- [x] Added notification coverage to ~20 previously-silent files: approvals (`approvals.ts`, `vehicleRequests.ts`), finance (`transactions.ts`, `deposits.ts`, `claims.ts`, `fixedAssets.ts`/`partnerEquity.ts` via `notifyOwner`), operations (`workOrders.ts`, `tasks.ts`, `test_drives.ts`, `documents.ts`, `quotes.ts`), team/org (`memberships.ts`, `roles.ts`, `branches.ts`, `organizations.ts`), and cross-tenant admin (`adminOrgs.ts` — notified before the cascade-delete in `hardDeleteOrg`, since memberships are gone after; `adminUsers.ts` — fans out across every org membership since disable/enable aren't org-scoped)
- [x] `components/layout/NotificationsBell.tsx` — renders via `renderNotification()` with legacy-row fallback, category icons, "view all" link; `app/(dashboard)/[orgId]/notifications/page.tsx` (new) — Inbox/Archive/Preferences tabs; `lib/navigation.ts` — nav entry; `components/providers/LocaleSync.tsx` (new) — mirrors the client locale into `users.locale`, mounted inside the dashboard layout since `LanguageProvider` sits above `ConvexClientProvider` and can't call Convex hooks itself
- [x] `convex/adminBroadcasts.ts` (new, `requireSuperAdmin`-gated) — `create`/`list`; `app/admin/notifications/page.tsx` (new) — composer + history; `AdminSidebar` nav entry
- [x] `convex/notifications.test.ts`, `convex/utils/notifications.test.ts`, `lib/notifications/render.test.ts` (new, ~25 tests) — auth/CRUD, pagination, fan-out correctness per helper, preference-default gating, bilingual rendering; fixed 5 pre-existing assertions in `facebookEngagement.test.ts`/`instagramEngagement.test.ts`/`socialPostingData.test.ts` that checked the now-removed plain-text `title`; added the new files to `vitest.config.ts` coverage tracking
- [x] 4 new TestSprite plan entries (`TC051`-`TC054`, not yet tool-generated/executed) appended to `testsprite_frontend_test_plan.json`; `Notifications` feature appended to `standard_prd.json`
- [x] Full suite green (318 passed, 22 skipped), coverage thresholds met, clean lint/build

**Frontend coverage note:** per this repo's established convention (`vitest.config.ts`: "all UI components/pages are covered by TestSprite E2E tests instead"), the new pages got TestSprite plan entries, not React Testing Library tests.

**Not yet pursued:** email digest batching (every notification sends instantly, gated only by on/off preference); WhatsApp Cloud API send was implemented and wired but not live-verified against a real Meta number (no sandbox credentials available this session).

---

## Upcoming Roadmap — Phases 29–42

> **Rule:** Any feature tagged `[LLM]` requires an external language model API budget and is deferred to the AI Backlog section below. Do not start those phases until budget is confirmed.

---

### Tier 1 — High ROI, Builds on Existing Data (Phases 29–32)

---

## Phase 29 — Inventory Intelligence

**Branch:** `feature/phase-29-inventory-intelligence`
**Goal:** Give dealers the dashboards and tracking they look at every day. No new entities — all data already exists; this phase surfaces it correctly.

### Scope

- **Aging Dashboard** — vehicles grouped into 0–30 / 31–60 / 61–90 / 90+ day buckets, color-coded (green/yellow/orange/red), with per-bucket counts + average days on lot. "Days on lot" = `now - createdAt` for AVAILABLE vehicles. Top-level summary card on the main Dashboard page.
- **Landed Cost Breakdown** — replace the single "purchase price" field on vehicles with a structured cost table: Purchase Price, Auction Fee, Shipping, Customs, Registration, Repair, Detailing, Photography, Marketing, Finance Cost. Show **Total Landed Cost** = sum of all rows. Profit calculations throughout (`sales.ts`, reports) must use landed cost, not just purchase price.
- **Pricing History Log** — whenever `vehicles.price` changes, append a row to a new `vehiclePriceHistory` table (`vehicleId`, `orgId`, `oldPrice`, `newPrice`, `changedBy`, `changedAt`). Show timeline in vehicle details.
- **Reservation History** — when a vehicle is reserved, capture depositor customer ID, deposit amount, expiry date. Store as `vehicleReservations` table rows (not just the status flag). Show history in vehicle details.

### Tasks
- [ ] `convex/schema.ts` — add `vehiclePriceHistory`, `vehicleReservations`, `vehicleLandedCosts` tables; extend `vehicles` with optional `landedCostTotal`
- [ ] `convex/vehicles.ts` — write price history row on every price change; `getLandedCosts`/`upsertLandedCost` mutations; `getReservationHistory` query
- [ ] `convex/reports.ts` — update profit calculations to use `landedCostTotal ?? purchasePrice`
- [ ] `components/vehicles/VehicleDetailsDialog.tsx` — Landed Cost tab, Pricing History tab, Reservation History section
- [ ] `app/(dashboard)/[orgId]/dashboard/page.tsx` — Inventory Aging card
- [ ] `app/(dashboard)/[orgId]/vehicles/page.tsx` — Aging filter tabs (All / 0-30 / 31-60 / 61-90 / 90+)
- [ ] i18n EN + AR for all new strings
- [ ] Tests for price history write-on-change, landed cost profit calculation, aging bucket logic

---

## Phase 30 — Customer Timeline

**Branch:** `feature/phase-30-customer-timeline`
**Goal:** Every customer gets a single chronological activity stream — the foundation all future CRM depth is built on.

### Scope

One read-only timeline per customer aggregating existing data from:
- WhatsApp messages (`whatsappMessages` / inbound events)
- Instagram DMs + comments (`instagramEvents`)
- Facebook DMs + comments (`facebookEvents`)
- Leads (created, stage changes, won/lost)
- Sales (sale date, vehicle, amount)
- Tasks (created, completed)
- Quotes (generated)
- Notes (manual free-text notes added inline on the timeline)

No new write paths other than manual notes. The timeline is a read-side aggregation query that merges rows from multiple tables, sorted by timestamp descending.

### Tasks
- [ ] `convex/schema.ts` — new `customerNotes` table (`orgId`, `customerId`, `authorId`, `body`, `isPinned`, `createdAt`)
- [ ] `convex/customerTimeline.ts` (new) — `getTimeline` query: fetches events from all source tables for a given `customerId` + `orgId`, merges + sorts in JS, returns a typed union array. Bounded fetches per table (`.take(50)` per source, merge, sort, slice to 100 total) — no unbounded scans.
- [ ] `convex/customerNotes.ts` (new) — `create`, `pin`/`unpin`, `remove` (author or manager only)
- [ ] `components/customers/CustomerTimelinePanel.tsx` (new) — scrollable timeline with event-type icons, grouped by date; inline note composer at top
- [ ] `components/customers/CustomerDialog.tsx` — new "Timeline" tab
- [ ] i18n EN + AR
- [ ] Tests for timeline merge ordering, note CRUD, permission gating

---

## Phase 31 — BI Executive Dashboard

**Branch:** `feature/phase-31-exec-dashboard`
**Goal:** A single page owners and GMs open every morning. All data is already in the system — this phase assembles it into one screen.

### Scope

A new `/dashboard/executive` route (or a new tab on the existing dashboard) showing:

| Section | Metrics |
|---|---|
| Today's Performance | Sales count, revenue, profit, margin % |
| Pipeline Snapshot | Open leads by stage (mini funnel), total open pipeline value |
| Inventory Position | Total vehicles, available count, inventory value (at landed cost), vehicles aged 90+ |
| Cash & Finance | Pending deposits, pending finance applications, overdue collections |
| Pending Actions | Approval requests (vehicle edits, status changes, profit approvals) waiting for owner |
| Top Performer | Salesperson with most revenue this month |
| Alerts | Any vehicle aged 90+, any sale with profit < threshold, any finance rejected this week |

### Tasks
- [ ] `convex/executiveDashboard.ts` (new) — single `getSummary` query that returns all sections above in one call (parallel `Promise.all` fetches internally, no N+1)
- [ ] `app/(dashboard)/[orgId]/dashboard/executive/page.tsx` (new) — grid layout, stat cards, mini funnel, alerts list
- [ ] Dashboard nav — "Executive View" link, gated by `requireOwner` equivalent permission
- [ ] i18n EN + AR
- [ ] Tests for `getSummary` data shape and auth gating

---

## Phase 32 — Customer Tags & Segments

**Branch:** `feature/phase-32-customer-segments`
**Goal:** Manual tagging + rule-based dynamic segments. No ML required.

### Scope

**Tags** — free-form labels per customer: VIP, Repeat Buyer, Fleet, Finance Eligible, High Risk, Wholesale, Referral Partner. Org-defined (not hardcoded). Shown as colored chips on customer rows and in the timeline.

**Segments** — saved filter presets that dynamically compute a customer list at query time. Rules are simple predicates:
- Purchased in last N months
- No purchase in last N months (inactive)
- Has open lead
- Tag includes X
- Lead source = Y
- Created after date

### Tasks
- [ ] `convex/schema.ts` — `customerTags` table (org-defined tag definitions: name, color); `customerTagAssignments` (customerId → tagId); `customerSegments` table (name, rules JSON array, createdBy)
- [ ] `convex/customerTags.ts` (new) — define/list/delete tags; assign/unassign tags to customers
- [ ] `convex/customerSegments.ts` (new) — `create`/`list`/`evaluate` (runs the rule predicates against the customer table, returns matching IDs)
- [ ] `components/customers/CustomerTagsEditor.tsx` (new) — inline multi-select tag editor in CustomerDialog
- [ ] `app/(dashboard)/[orgId]/customers/page.tsx` — tag filter chips, segment dropdown filter
- [ ] `app/(dashboard)/[orgId]/settings/segments/page.tsx` (new) — segment builder UI
- [ ] i18n EN + AR
- [ ] Tests for tag CRUD, assignment uniqueness, segment rule evaluation

---

### Tier 2 — Operational Depth (Phases 33–36)

---

## Phase 33 — Basic Workflow Automation

**Branch:** `feature/phase-33-workflow-automation`
**Goal:** Trigger → Action rules that run automatically. No LLM. Pure event-driven logic.

### Scope

An org-configurable rule engine: **WHEN** [trigger event] **AND** [optional conditions] **THEN** [actions].

**Supported triggers (V1):**
- Lead created
- Lead inactive for N days
- Lead stage changed to X
- Vehicle status changed to AVAILABLE
- Sale recorded
- Low-profit sale (below threshold)

**Supported actions (V1):**
- Create a task (assignee, title, due date offset)
- Send in-app notification to [role]
- Send WhatsApp message to customer (template text only — no LLM)
- Change lead stage to X

**Not in V1:** email sending, external webhooks, complex branching. Those come with the Integration Hub (Phase 42).

### Tasks
- [ ] `convex/schema.ts` — `automationRules` table (`orgId`, `name`, `trigger`, `conditions` JSON, `actions` JSON array, `isActive`, `lastTriggeredAt`, `triggerCount`)
- [ ] `convex/automationRules.ts` (new) — CRUD for rules; `evaluateRules(ctx, orgId, triggerType, payload)` internal mutation — fetches active rules matching the trigger, evaluates conditions, executes actions
- [ ] Wire `evaluateRules` call into existing mutation files: `convex/leads.ts`, `convex/vehicles.ts`, `convex/sales.ts` at the right trigger points
- [ ] `app/(dashboard)/[orgId]/settings/automations/page.tsx` (new) — rule builder UI: trigger picker → condition rows → action rows → save; rule list with on/off toggle + trigger count
- [ ] i18n EN + AR
- [ ] Tests for rule evaluation, condition matching, action dispatch, trigger count increment

---

## Phase 34 — Vehicle Acquisition Workflow

**Branch:** `feature/phase-34-acquisition`
**Goal:** Track how vehicles come into inventory before the Add Vehicle step.

### Scope

A pre-inventory acquisition flow covering:
- **Source types:** Private seller, Auction, Trade-in, Fleet/Corporate, Transfer from branch
- **Purchase Order** — created before the vehicle is formally added to inventory; captures seller, agreed price, terms, payment method
- **Approval flow** — purchase orders above a threshold require manager/owner approval (reuses the existing pending → approved/rejected pattern)
- **Link to vehicle** — when a PO is approved and payment confirmed, it creates the vehicle record pre-filled with the agreed purchase price → feeds Phase 29's landed cost breakdown

### Tasks
- [ ] `convex/schema.ts` — `purchaseOrders` table (`orgId`, `sourceType`, `sellerName`, `sellerContact`, `agreedPrice`, `paymentMethod`, `status: DRAFT|PENDING_APPROVAL|APPROVED|PAID|CANCELLED`, `vehicleId` (nullable — set on approval), `approvedBy`, `notes`, soft-delete fields)
- [ ] `convex/purchaseOrders.ts` (new) — `create`, `submit` (→ PENDING_APPROVAL), `approve`/`reject` (owner/manager), `markPaid` (→ PAID + creates vehicle), `list`, `get`
- [ ] `app/(dashboard)/[orgId]/acquisition/page.tsx` (new) — PO list with status filters; create PO flow
- [ ] `app/(dashboard)/[orgId]/acquisition/[id]/page.tsx` (new) — PO detail + approval action
- [ ] Sidebar nav entry under Inventory section
- [ ] i18n EN + AR
- [ ] Tests for PO state machine, approval gating, vehicle auto-create on PAID

---

## Phase 35 — MENA Marketplace Syndication

**Branch:** `feature/phase-35-marketplace`
**Goal:** Publish inventory to Dubizzle, OpenSooq, Haraj, and YallaMotor — the platforms where MENA buyers actually search. Uses the Phase 23/26 social posting architecture as the pattern.

### Scope

Each marketplace has its own API (or CSV/XML feed). V1 covers:
- **Dubizzle** — REST API or XML feed (research required per their current partner API)
- **OpenSooq** — listing API
- **Haraj** (Saudi) — API or webhook
- **YallaMotor** — XML inventory feed

Per-vehicle: manual "Publish to [platform]" button in the Marketing tab (same UX as Instagram/Facebook). Per-org toggle for auto-publish on status → AVAILABLE.

Synchronized status: when a vehicle is sold/archived in AutoFlow, send a delete/deactivate call to each platform it was published on.

### Tasks
- [ ] Research each platform's current partner API / listing API requirements and document in `docs/marketplace-apis.md`
- [ ] `convex/schema.ts` — extend `socialPosts` platform enum with `"dubizzle" | "opensooq" | "haraj" | "yallamotor"`; or create separate `marketplaceListings` table if the data shape differs significantly
- [ ] `convex/marketplacePosting.ts` (new) — `publishListing` (per platform), `deactivateListing` (on vehicle sold/deleted)
- [ ] `components/vehicles/VehicleMarketingTab.tsx` — marketplace publish buttons, listing status per platform
- [ ] `app/(dashboard)/[orgId]/settings/integrations/client.tsx` — marketplace API key configuration per platform
- [ ] i18n EN + AR
- [ ] Tests for listing create/deactivate per platform, credential validation

---

## Phase 36 — Inspection Module

**Branch:** `feature/phase-36-inspection`
**Goal:** Structured vehicle inspection checklist with photos, separate from work orders.

### Scope

A standalone inspection record per vehicle (can have multiple — pre-purchase, post-repair, pre-delivery):

**Checklist sections:** Exterior, Interior, Engine, Electrical, Tyres, Brakes, Paint, Diagnostics

Each item: **pass / fail / N/A** with optional photo attachment and a free-text note.

**Output:** inspection summary card (overall pass/fail, section scores), linked to the vehicle record and optionally to a purchase order (Phase 34).

### Tasks
- [ ] `convex/schema.ts` — `inspections` table (`orgId`, `vehicleId`, `purchaseOrderId` (optional), `inspectorId`, `status: DRAFT|COMPLETE`, `sections` JSON array, `overallResult`, soft-delete fields); `inspectionPhotos` storage IDs linked to inspection + section item
- [ ] `convex/inspections.ts` (new) — `create`, `updateSection`, `complete`, `list`, `get`, `generateUploadUrl`
- [ ] `components/vehicles/InspectionDialog.tsx` (new) — section accordion, pass/fail/NA toggle per item, photo upload per item, submit button
- [ ] `components/vehicles/VehicleDetailsDialog.tsx` — new "Inspections" tab showing inspection history + "New Inspection" button
- [ ] i18n EN + AR
- [ ] Tests for inspection CRUD, completion guard (all items answered), photo attachment

---

### Tier 3 — Enterprise & Scale (Phases 37–42)

---

## Phase 37 — Document Management

**Branch:** `feature/phase-37-documents`
**Goal:** Versioned document storage with expiry tracking and renewal reminders.

### Scope

Structured documents per vehicle and per customer:

**Vehicle documents:** Registration, Insurance, Inspection Certificate, Purchase Agreement, Title/Ownership, Import Permit, Customs Clearance

**Customer documents:** ID (front/back), Driving License, Proof of Income, Bank Statement, Finance Agreement

**Features:**
- Upload new version (keeps previous versions, doesn't overwrite)
- Document status: VALID / EXPIRING_SOON (within 30 days) / EXPIRED
- Expiry date field per document; cron triggers notifications 30 days before expiry (reuses Phase 28's notification system)
- Document categories enforced by type

### Tasks
- [ ] `convex/schema.ts` — extend existing `documents` table (or create `documentVersions` table) with `version`, `expiresAt`, `status`, `replacedBy` (FK to newer version); `documentTypes` table for org-defined document type definitions
- [ ] `convex/documents.ts` — `uploadNewVersion`, `listVersions`, `getLatest`, `setExpiry`; cron job for expiry notifications
- [ ] `components/documents/DocumentVersionsPanel.tsx` (new) — version history list, upload new version, expiry badge
- [ ] `app/(dashboard)/[orgId]/vehicles/[id]/documents/` — vehicle documents panel
- [ ] `app/(dashboard)/[orgId]/customers/` — customer documents panel
- [ ] i18n EN + AR
- [ ] Tests for version chain, expiry status computation, cron notification trigger

---

## Phase 38 — Multi-Branch Operations

**Branch:** `feature/phase-38-multi-branch`
**Goal:** Branches already exist in the schema. This phase adds vehicle transfers, branch-level inventory views, and branch profitability breakdown.

### Scope

- **Vehicle Transfer** — move a vehicle from one branch to another with an approval flow (manager of destination branch approves). Transfer request captures source branch, destination branch, reason, transport cost (feeds landed cost).
- **Branch Inventory View** — filter the inventory page by branch; show per-branch vehicle count and total value.
- **Branch Profitability** — in Reports, add a Branch tab breaking down revenue, profit, and margin per branch for the selected period.
- **Inter-branch Sales** — a sale can be recorded against a branch other than the vehicle's current branch (e.g., salesperson from branch B sells a car sitting at branch A).

### Tasks
- [ ] `convex/schema.ts` — `vehicleTransfers` table (`orgId`, `vehicleId`, `fromBranchId`, `toBranchId`, `requestedBy`, `status: PENDING|APPROVED|REJECTED|IN_TRANSIT|COMPLETE`, `transportCost`, soft-delete fields); index on `by_org_vehicle`
- [ ] `convex/vehicleTransfers.ts` (new) — `request`, `approve`/`reject`, `markComplete` (updates vehicle's `branchId`); `list`, `get`
- [ ] `convex/reports.ts` — add branch breakdown aggregation
- [ ] `app/(dashboard)/[orgId]/vehicles/page.tsx` — branch filter dropdown
- [ ] `app/(dashboard)/[orgId]/transfers/page.tsx` (new) — transfer requests list + action buttons
- [ ] i18n EN + AR
- [ ] Tests for transfer state machine, branch filter correctness, profitability aggregation

---

## Phase 39 — Sales Funnel Analytics

**Branch:** `feature/phase-39-funnel-analytics`
**Goal:** Visual funnel, marketing ROI by channel, salesperson leaderboard. All computed from existing data.

### Scope

New "Analytics" tab in Reports (or a dedicated `/analytics` route):

**Sales Funnel** — for a date range: Leads created → Leads qualified → Leads quoted → Finance applications → Sales closed. Conversion % at each step.

**Marketing ROI by Channel** — leads grouped by `leadSource` (WhatsApp, Instagram, Facebook, Walk-in, Referral, etc.), showing leads count → sales count → revenue → cost per acquisition (manual cost entry per channel per month).

**Salesperson Leaderboard** — for a date range: each salesperson's sales count, revenue, profit, closing rate (sales / leads assigned), average deal size, average days to close.

**Forecast** — next 30-day revenue projection based on current open pipeline value × historical closing rate. No ML — purely `sum(openLeads.estimatedValue) × closingRate`.

### Tasks
- [ ] `convex/schema.ts` — `marketingChannelCosts` table (`orgId`, `channel`, `month` (YYYY-MM), `cost`) for manual cost entry
- [ ] `convex/analytics.ts` (new) — `getSalesFunnel`, `getMarketingRoi`, `getSalespersonLeaderboard`, `getForecast` queries
- [ ] `app/(dashboard)/[orgId]/reports/page.tsx` — new Analytics tab
- [ ] `components/analytics/` — funnel chart, ROI table, leaderboard table, forecast card
- [ ] i18n EN + AR
- [ ] Tests for funnel conversion rates, leaderboard sorting, forecast formula

---

## Phase 40 — Mobile PWA

**Push/PWA slice: MERGED to main (PR #26, 2026-07-05) and DEPLOYED to production** — VAPID keys
generated and set on Convex prod (`kindly-hound-172`) + Vercel; `npx convex deploy` and a fresh
Vercel production deploy both completed same day. Push notifications are live.
**Branch:** `feature/phase-40-pwa` (Push/PWA slice was built on `feature/phase-40a-push-notifications`)
**Goal:** Installable app, offline inventory/customer lookup, camera VIN scanner, push notifications.

### Scope

- **PWA manifest + service worker** — `next-pwa` or manual `sw.js`. Cache strategy: network-first for API calls, stale-while-revalidate for static assets. Offline fallback shows cached vehicle/customer data (read-only).
- **Push Notifications** — wire Web Push (VAPID keys) into the existing notification system (Phase 28). Dispatch push alongside in-app + email + WhatsApp. User opts in from the Notification Preferences page.
- **Camera VIN Scanner** — on the Add Vehicle form, a "Scan VIN" button opens the device camera, uses a barcode/QR library (`zxing-js/browser` or `quagga2`) to read Code 39/Code 128/DataMatrix VIN barcodes, and pre-fills the VIN field.
- **GPS Check-in (stretch)** — salesperson taps "Check in" from a lead page to record their GPS location + timestamp to the lead's timeline.

### Tasks
- [x] `next.config.ts` CSP — `worker-src` widened to `'self' blob:` so `/sw.js` can register (2026-07-05)
- [x] `public/sw.js` (manual, no `next-pwa`) — push/notificationclick/pushsubscriptionchange handlers only; no asset caching/offline shell yet (2026-07-05)
- [x] `app/manifest.ts` — Next-native PWA manifest; `app/layout.tsx` gained `appleWebApp` + `viewport.themeColor` for iOS installability (2026-07-05)
- [x] `convex/schema.ts` — `pushSubscriptions` table (keyed by `endpoint`, one row per device); `notificationPreferences` gained `pushEnabled` (2026-07-05)
- [x] `convex/pushSend.ts` (new, `"use node"`) — `sendNotificationPush` internalAction using `web-push`, VAPID keys from env, fans out to all enabled devices, prunes 404/410 subscriptions (2026-07-05)
- [x] `convex/pushSubscriptions.ts` (new) — subscribe/unsubscribe/listMyDevices/disableDevice + internal helpers for the action (2026-07-05)
- [x] `convex/utils/notifications.ts` — push dispatch path added alongside email/WhatsApp, opt-in only like WhatsApp (2026-07-05)
- [x] `hooks/usePushNotifications.ts` + `components/notifications/PushPermissionCard.tsx` — SW registration, permission gating, device list, wired into the Notification Preferences page as a 3rd Push column (2026-07-05)
- [x] i18n EN + AR for push UI (2026-07-05)
- [x] Tests for push subscription CRUD + dispatch scheduling (`convex/pushSubscriptions.test.ts`, `convex/utils/notifications.test.ts`) (2026-07-05)
- [x] Bonus (user request, not originally scoped here): wired the internal messenger (`convex/directMessages.ts` `sendMessage`) into the same notification system — DM/group recipients now get in-app + push + email/WhatsApp (per their prefs) via a new `message.received` type, skipped when the recipient has muted that conversation (2026-07-05)
- [ ] `next-pwa`-style asset caching / offline shell for read-only vehicle/customer lookup — not built; current `sw.js` only handles push, no fetch/caching handlers
- [ ] `components/vehicles/VehicleDialog.tsx` — "Scan VIN" button with camera modal — not started
- [ ] `lib/vinScanner.ts` (new) — thin wrapper around `zxing-js/browser` `BrowserBarcodeReader` — not started
- [ ] GPS Check-in (stretch) — not started
- [ ] VAPID keys must still be generated (`npx web-push generate-vapid-keys`) and set on the Convex deployment (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`) + Vercel (`NEXT_PUBLIC_VAPID_PUBLIC_KEY`) before push actually works in production — the feature no-ops quietly until then

---

## Phase 41 — Accounting Depth

**Goal:** Dealership-facing accounting UX that sits on top of the double-entry GL track.

> **Pruned (2026-07-03):** This phase was scoped before the double-entry GL track existed.
> **Cash Register** is superseded by GL Phase 15 (full cash-drawer sessions) and
> **Cheque Management** already shipped (post-dated cheques, clearing, return-after-clearing,
> GL posting) in Accounting Phases 8–9 — both removed from scope here.

**Status: ✅ Done (2026-07-06).** Bank accounts are reference/reconciliation records
(not new GL control accounts — there remains exactly one `BANK_ACCOUNT` control
account); opening balance is a reporting-layer number, not a posted journal entry, so
only one bank account per org (`isReconciliationTarget`) gets real reconciliation math.
Input VAT tracking was added to both `expenses` and `vehicleSupplierPayables` (not just
expenses) so the VAT return's net-due figure isn't misleading. See
[`docs/architecture/accounting-implementation-progress.md`](docs/architecture/accounting-implementation-progress.md)
and [`docs/architecture/accounting-final-phase-plan.md`](docs/architecture/accounting-final-phase-plan.md)
for the GL track this phase sits on top of.

### Scope

- **Bank Accounts** — `convex/bankAccounts.ts` (CRUD, `getBookBalance`), `bankAccounts` table (name, IBAN, currency, opening balance/date, `isReconciliationTarget`). UI: `components/accounting/BankAccountsTab.tsx` + `components/accounting/bankAccounts/*`.
- **Payment Reconciliation** — `convex/bankReconciliation.ts` (CSV/XLSX upload via existing `lib/spreadsheet.ts`, scored `suggestMatches` — exact amount + date proximity, never auto-confirms, `confirmMatch` with a double-claim guard). UI: `components/accounting/bankAccounts/ReconciliationPanel.tsx` + `BankStatementUploadDialog.tsx`.
- **Installment Collections Calendar** — `convex/collections.ts`'s `listReceivablesDueBetween` + `components/accounting/collections/InstallmentCalendar.tsx`, toggled inside the existing Collections tab's Receivables view.
- **VAT Return Export** — `convex/vatReport.ts`'s `generateVatSummary` (output VAT from `SALES_TAX_PAYABLE`, input VAT from new `VAT_RECEIVABLE` system key, self-healing via `ensureVatReceivableAccount`). UI: `components/accounting/reports/VatReturnReport.tsx`, PDF/CSV export reusing `lib/pdf.ts`/`lib/utils/export.ts`, 4th tab in `FinancialReportsTab.tsx`.

### Tasks
- [x] `convex/schema.ts` — `bankAccounts`, `bankStatementLines` tables; `taxAmount` on `expenses`/`vehicleSupplierPayables`
- [x] `convex/bankAccounts.ts` (new) — CRUD + book-balance query
- [x] `convex/bankReconciliation.ts` (new) — upload, suggestMatches, confirmMatch, ignoreLine/unmatch
- [x] `convex/vatReport.ts` (new) — `generateVatSummary` query
- [x] `components/accounting/BankAccountsTab.tsx` + new Bank Accounts tab in `AccountingClient.tsx`; VAT Export tab in `FinancialReportsTab.tsx`
- [x] Installment calendar view inside the Collections tab (no standalone `/collections` route exists)
- [x] i18n EN + AR
- [x] Tests: `convex/bankAccounts.test.ts`, `convex/bankReconciliation.test.ts`, `convex/vatReport.test.ts`, `convex/sourcingPayables.test.ts`, plus VAT-split cases added to `convex/expenses.test.ts`

**Known limitation (by design):** day-to-day postings (collections, cheque clearing,
disbursements) don't carry a per-transaction bank-account tag — the posting engine has
no `ctx` at the rule layer, and no payment dialog lets a user pick a bank account. Full
reconciliation accuracy holds for the common single-operating-account case; additional
registered bank accounts are reference-only until a future phase adds per-transaction
bank selection.

**Not yet done, out of scope for this batch:** no browser-automation tool is available in
this environment, so the new UI (Bank Accounts tab, statement upload, VAT export button,
installment calendar) has been typechecked and unit-tested but not click-tested in a
running app — verify visually in `pnpm dev` before considering this shippable.

---

## Accounting GL Track — Final Phases 10–18 (done, pending merge)

**Reference:** [`docs/architecture/accounting-final-phase-plan.md`](docs/architecture/accounting-final-phase-plan.md)
· continues [`docs/architecture/accounting-implementation-progress.md`](docs/architecture/accounting-implementation-progress.md) (Phases 0–9 ✅)

**Goal:** Move accounting from "strong operational / management-accounting" (core ~85%)
to a complete, audit-ready product (~65–75% → done). Validated against source on 2026-07-03;
9 of 10 gaps confirmed (provider-verification finding was largely outdated — per-provider HMAC already ships).
All 9 phases (10–18) built and committed on `feature/gl-phase-11-fixed-assets` (PR #23) as of
2026-07-04; awaiting Codex/CodeRabbit review and merge go-ahead. Two narrow items deliberately
deferred beyond this batch: legacy-field schema narrowing (Phase 17 — needs the backfill migration
run and verified against live production data first) and full arbitrary-range trial-balance snapshot
support (Phase 18 — the `fromDate`-provided path still does a full scan).

| GL Phase | Description | Status |
|---|---|---|
| 10 | True two-person manual-journal approval (create → authenticated approve/reject) | ✅ Done (2026-07-03) |
| 11 | Fixed-asset lifecycle: capitalize, depreciate, impair, dispose (GL-posted) | ✅ Done (2026-07-04) |
| 12 | Partner equity as immutable contribution/draw/distribution transactions | ✅ Done (2026-07-04) |
| 13 | Claim receivables + settlement postings | ✅ Done (2026-07-04) |
| 14 | Multi-currency reporting correctness (group by accountId + currency) | ✅ Done (2026-07-04) |
| 15 | Full cash-drawer session lifecycle (float → count → variance → deposit → close) | ✅ Done (2026-07-04) |
| 16 | Provider verification breadth (more providers; fail-closed allowlist) | ✅ Done (2026-07-04) |
| 17 | Legacy money → minor-unit migration + accountant sign-off | ✅ Done (2026-07-04; narrowing deferred to prod verification) |
| 18 | Report scalability (balance snapshots, remove full scans / N+1) | ✅ Done (2026-07-04) |

Each phase reuses the established pattern: immutable event table → posting rule in
`postingRules.ts` → `postOrEnqueue` hook → replace direct-edit CRUD → self-heal chart keys → phase test.

---

## Phase 42 — Open API & Integration Hub

**Branch:** `feature/phase-42-open-api`
**Goal:** Let third-party tools connect to AutoFlow via API keys and event webhooks — the foundation for all future integrations.

### Scope

- **API Keys** — org owners can generate named API keys with scopes (read:vehicles, write:leads, read:customers, etc.). Keys are hashed on storage; shown in full only at creation.
- **Outbound Webhooks** — org owners register webhook URLs for specific events (lead.created, vehicle.sold, sale.recorded, etc.). AutoFlow sends a signed `POST` with event payload on each trigger. Reuses the `automationRules` trigger catalogue from Phase 33.
- **Webhook Delivery Log** — per-event delivery attempt record (status code, response body, retry count). Reuses the existing `webhookLogs` pattern from `convex/adminSystem.ts`.
- **Rate Limits** — API key calls are rate-limited per key (not just per org) using the existing `@convex-dev/rate-limiter` component.

### Tasks
- [ ] `convex/schema.ts` — `apiKeys` table (`orgId`, `name`, `keyHash`, `scopes`, `lastUsedAt`, `isActive`); `webhookEndpoints` table (`orgId`, `url`, `events` string array, `secret`, `isActive`); `webhookDeliveries` table (delivery log)
- [ ] `convex/apiKeys.ts` (new) — `create` (returns plaintext key once), `list`, `revoke`
- [ ] `convex/webhookEndpoints.ts` (new) — `create`/`list`/`delete`; `dispatchWebhook` internal action (HMAC-signs payload, `fetch`, logs delivery)
- [ ] Wire `dispatchWebhook` into the same trigger points as `evaluateRules` (Phase 33)
- [ ] `convex/http.ts` — new `/api/v1/*` routes authenticated by API key header, returning org data per granted scopes
- [ ] `app/(dashboard)/[orgId]/settings/api/page.tsx` (new) — API keys management + webhook endpoint config
- [ ] i18n EN + AR
- [ ] Tests for key hashing, scope enforcement, webhook signature verification, delivery retry logic

---

## AI / LLM Backlog — No Budget, Build Later

> Start these phases only after an LLM API budget is confirmed. Each depends on data built in earlier phases.

| Phase | Feature | Depends On | LLM Use |
|---|---|---|---|
| 50 | AI Reply Suggestions (WhatsApp / IG / FB) | Phase 30 Customer Timeline | Generate contextual reply options from conversation history |
| 51 | AI Vehicle Description Generator | Phase 35 Marketplace Syndication | Generate listing copy per platform from vehicle attributes |
| 52 | Lead Scoring | Phase 32 Segments + Phase 39 Funnel data | Predict purchase probability from engagement signals |
| 53 | AI Sales Assistant / Copilot | Phases 30, 32, 39 | Summarize customer, suggest next action, recommend financing |
| 54 | Predictive Sales Forecasting | Phase 39 + 6+ months historical data | Improve on Phase 39's rule-based forecast with ML regression |
| 55 | Call Summary & Sentiment | External call recording integration | Transcribe + summarize calls, extract next actions |

---

## Phase Roadmap Summary

| Phase | Name | Tier | Status |
|---|---|---|---|
| 29 | Inventory Intelligence | 1 — High ROI | ⬜ Not started |
| 30 | Customer Timeline | 1 — High ROI | ⬜ Not started |
| 31 | BI Executive Dashboard | 1 — High ROI | ⬜ Not started |
| 32 | Customer Tags & Segments | 1 — High ROI | ⬜ Not started |
| 33 | Basic Workflow Automation | 2 — Operational Depth | ⬜ Not started |
| 34 | Vehicle Acquisition Workflow | 2 — Operational Depth | ⬜ Not started |
| 35 | MENA Marketplace Syndication | 2 — Operational Depth | ⬜ Not started |
| 36 | Inspection Module | 2 — Operational Depth | ⬜ Not started |
| 37 | Document Management | 3 — Enterprise & Scale | ⬜ Not started |
| 38 | Multi-Branch Operations | 3 — Enterprise & Scale | ⬜ Not started |
| 39 | Sales Funnel Analytics | 3 — Enterprise & Scale | ⬜ Not started |
| 40 | Mobile PWA | 3 — Enterprise & Scale | 🟨 Push/PWA slice MERGED + DEPLOYED to prod (2026-07-05); VIN scanner/GPS check-in not started |
| 41 | Accounting Depth | 3 — Enterprise & Scale | ✅ Done (2026-07-06) |
| 42 | Open API & Integration Hub | 3 — Enterprise & Scale | ⬜ Not started |
| GL 0–9 | Double-Entry Accounting Foundation | Accounting GL Track | ✅ Done |
| GL 10 | True two-person manual-journal approval | Accounting GL Track | ✅ Done |
| GL 11 | Fixed-asset lifecycle and depreciation (GL-posted) | Accounting GL Track | ✅ Done |
| GL 12–18 | Accounting Final Phases (equity, claims, cash-drawer, multi-currency, migration, scale) | Accounting GL Track | ✅ Done |
| 50–55 | AI / LLM Features | Backlog — No Budget | 🔒 Deferred |
