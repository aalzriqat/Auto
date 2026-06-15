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

## Phase 12 — Branding + WhatsApp Integration

**Branch:** `feature/phase-12-branding-whatsapp`
**Goal:** Show org logo in TopNav/print layouts; WhatsApp webhook → auto-create leads.

### Tasks
- [ ] Display `orgSettings.logoStorageId` in TopNav (next to org name)
- [ ] Apply `primaryColor` as CSS variable via `useOrgSettings` in root layout
- [ ] Print layout component uses org logo + name
- [ ] WhatsApp webhook endpoint `convex/http.ts` — receive message, extract sender phone, map to customer or create new, create lead
- [ ] Convex action: call Claude API to classify message intent and extract vehicle interest
- [ ] `orgSettings.whatsappPhoneNumberId` + `whatsappAccessToken` fields (encrypted-at-rest note)
- [ ] Settings UI: WhatsApp tab in general settings for credentials entry

---

## Phase 13 — Advanced Customization

**Branch:** `feature/phase-13-advanced`
**Goal:** Custom vehicle fields, tiered commissions, onboarding wizard, regional doc templates.

### Tasks
- [ ] `orgCustomFields` table — define custom fields per entity type (vehicle, customer, lead)
- [ ] VehicleDialog / CustomerDialog render custom fields dynamically
- [ ] Tiered commission config in `orgSettings` — JSON array of tiers `{ minProfit, commissionPct }`
- [ ] Commission calculator uses org tiers instead of hardcoded value
- [ ] Onboarding wizard (new org flow): currency → logo → lead sources → pipeline stages → done
- [ ] Regional doc templates — print layouts per country/language

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
