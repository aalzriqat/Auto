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
