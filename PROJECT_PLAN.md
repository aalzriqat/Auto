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
| 10 | feature/phase-10-org-settings | Org Settings Foundation | ✅ Done |
| 11 | feature/phase-11-sales-flow | Pipeline Stages, Approval Thresholds | ✅ Done |
| 12 | feature/phase-12-branding-whatsapp | Org Logo, Brand Color, WhatsApp Webhook | ✅ Done |
| 13 | feature/phase-13-advanced | Custom Fields, Commission Tiers, Onboarding Wizard | ✅ Done |

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
**Commit:** `51c73c7`

### Delivered
- [x] `orgCustomFields` + `orgCustomFieldValues` tables in schema
- [x] `orgSettings.commissionTiers` — array of `{ minProfitAmount, commissionPct }` tiers
- [x] `convex/orgCustomFields.ts` — list, create, update, remove (field defs) + getValues/setValues (values)
- [x] `settings/custom-fields/page.tsx` — add text/number/select/date fields per entity type
- [x] `settings/commission/page.tsx` — tier builder with live preview calculator
- [x] `hooks/useCommission.ts` — `calculate(profit)` + `getAppliedTier(profit)`
- [x] `components/custom-fields/CustomFieldsSection.tsx` — renders active fields in any form; loads existing values on edit
- [x] `VehicleDialog` — includes `CustomFieldsSection`, saves custom field values on create/update
- [x] Onboarding wizard — 5-step: name → currency → lead sources → pipeline → done (each step skippable)

### Deferred
- [ ] CustomerDialog / LeadDialog custom fields (same pattern as VehicleDialog)
- [ ] Regional doc templates (requires template engine — Phase 14)

---

## Execution Order

```
Phase 10 ✅ → Phase 11 → Phase 12 → Phase 13
                ↓
           (stable orgs needed before advanced)
```

---

## Deferred / Pending

- `useCurrency()` rollout — apply to all components still showing hardcoded "JOD" (deferred to a cleanup PR after Phase 11)
- Merge `feature/searchable-selects-db-drafts-i18n-rtl` to `main` (contains searchable selects, VIN improvements, PROJECT_PLAN.md history)
