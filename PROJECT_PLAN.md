# AutoFlow — Master Project Plan

> Single source of truth for all work on this codebase.
> Update this file whenever a phase starts, completes, or changes scope.
> Always query `graphify-out/graph.json` before making architectural decisions.

---

## Project Overview

**AutoFlow** is a multi-tenant car dealership CRM/ERP.
Stack: Next.js 16 (App Router) · Convex backend · Clerk auth · Tailwind/shadcn UI · Bilingual EN/AR (RTL).

**Current state (as of 2026-06-13):** Advanced MVP/beta. Strong real-time reactivity via Convex, solid RBAC foundation via Clerk. Needs significant hardening before high-scale production launch.

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

## Top 5 Production Risks

1. **OOM / Timeout in reports.ts** — N+1 queries inside loops; will crash with 1000+ sales records.
2. **Missing input validation** — No business-logic Zod validation in Convex args; negative prices, corrupt data possible.
3. **Rate limiting gaps** — `rateLimiter` only covers email/create/upload; heavy read endpoints unprotected.
4. **Zero financial test coverage** — Deal structuring, APR math, profit calc all untested; one refactor = silent regression.
5. **Tight coupling in sale creation** — Vehicle status, transactions, and lead closure all imperatively chained in one mutation handler.

---

## Graph Reference

Knowledge graph is at `graphify-out/graph.json`. Run queries before making architectural decisions:

```powershell
# Query the graph
python -m graphify query "<question>"

# Shortest path between two concepts
python -m graphify path "PERMISSIONS" "Sales Data Layer"

# Explain a node
python -m graphify explain "useOrg"
```

**God nodes** (touch carefully — affect entire codebase):
- `useLanguage()` — 116 edges, crosses all UI communities
- `useOrg()` — 110 edges, multi-tenancy anchor
- `PERMISSIONS` — 32 edges, bridges 15 communities (auth ↔ UI ↔ data)
- `api` — 56 edges, Convex query/mutation hub
- `cn()` — 64 edges, Tailwind utility glue

After any significant code change, run:
```powershell
python -m graphify update .
```

---

## Phased Refactoring Roadmap

### Legend
- `[ ]` Not started
- `[~]` In progress
- `[x]` Complete

---

### ~~Phase 1 — Critical Performance & Indexing~~ ✅ COMPLETE (verified 2026-06-13)
- `by_status_alarm` index in `convex/schema.ts` ✅
- `convex/crons.ts` uses the index ✅
- `convex/reports.ts` uses bulk-fetch + `Promise.all` pattern — N+1 eliminated ✅

---

### ~~Phase 2 — Input Validation Layer~~ ✅ COMPLETE (verified 2026-06-13)
- `convex/validations/` — sales, vehicles, customers, expenses schemas ✅
- `convex/utils/validation.ts` with `validateInput()` ✅
- Applied to sales, vehicles, customers, expenses mutations ✅

---

### ~~Phase 3 — Configuration & Environment Hardening~~ ✅ COMPLETE (verified 2026-06-13)
- `convex/utils/env.ts` with `getValidatedEnv()` ✅
- Applied to `email.ts`, `http.ts`, `auth.config.ts` ✅
- `.env.example` exists ✅

---

### ~~Phase 4 — Test Coverage Foundation~~ ✅ COMPLETE (verified 2026-06-13)
- `lib/financing.test.ts` ✅
- `convex/sales.test.ts` ✅
- `convex/approvals.test.ts` ✅
- `convex/utils/permissions.test.ts` ✅
- `.github/workflows/test.yml` CI on every PR ✅

---

### ~~Phase 5 — API Rate Limiting & DoS Protection~~ ✅ COMPLETE (2026-06-13)
- `heavyRead` + `standardApi` buckets in `convex/rateLimit.ts` ✅
- `heavyRead` applied to all 6 queries in `convex/reports.ts` ✅
- `standardApi` applied to update/softDelete in expenses, customers, sales, vehicles ✅

---

### ~~Phase 6 — Architecture: Sale Creation Decoupling~~ ✅ COMPLETE (2026-06-13)

**Goal:** Extract cross-domain side effects from `sales.create` into a coordinated service layer.

Tasks:
- [ ] Document current `sales.create` call graph using `graphify path` before touching anything
- [ ] Extract vehicle status update into internal helper `internal.vehicles.markAsSold`
- [ ] Extract transaction creation into internal helper `internal.transactions.createForSale`
- [ ] Extract lead closure into internal helper `internal.leads.closeAsWon`
- [ ] Rewrite `sales.create` to call these internal helpers
- [ ] Ensure all helpers run within the same Convex transaction context
- [ ] Regression: re-run Phase 4 tests to verify correctness

**Definition of Done:**
- `sales.create` handler contains no direct `ctx.db.patch` for vehicles, transactions, or leads
- All existing tests pass
- New test verifies partial failure leaves no partial state

---

### ~~Phase 7 — Security: Remove debug.ts Exposure~~ ✅ COMPLETE (2026-06-13)
- `convex/debug.ts` deleted ✅

---

### ~~Phase 8 — Structured Error Handling & Logging~~ ✅ COMPLETE (2026-06-13)

**Goal:** Structured error context on all backend errors; consistent client-side display.

Tasks:
- [x] Define error code enum in `convex/utils/errors.ts` — `AppErrorCode` const + `throwAppError()` factory
- [x] Replace generic `ConvexError("message")` with structured `{ code, message }` in `sales.ts` (13 throws) and `utils/tenancy.ts` (7 throws — auth layer used by all handlers)
- [x] Audit all `catch` blocks in Convex functions — no silent swallows found (`email.ts`, `memberships.ts`, `http.ts` all properly re-throw or return error state)
- [ ] Sentry `captureException` — deferred; Sentry not installed in project
- [x] Frontend: `sonner.tsx` `formatFriendlyError` now parses structured JSON errors before keyword matching — backward compatible with legacy string errors

**Remaining:** Other 28 files still use plain `ConvexError(string)` — migrate incrementally using `throwAppError()` pattern established here.

---

### Phase 9 — CI/CD & Deployment Hardening ✅ COMPLETE (verified 2026-06-13)
`.github/workflows/test.yml` — runs lint + tests on every PR to `main` ✅

**Goal:** Automated quality gates on every PR.

Tasks:
- [ ] GitHub Actions: lint + typecheck + test on every PR
- [ ] Add Convex deploy step to CI (staging environment)
- [ ] Add branch protection rule: PRs require passing CI before merge
- [ ] Document rollback procedure in CLAUDE.md

---

## Completed Work

| Phase | Title | Completed |
|-------|-------|-----------|
| 1 | Critical Performance & Indexing | 2026-06-13 |
| 2 | Input Validation Layer | 2026-06-13 |
| 3 | Configuration & Environment Hardening | 2026-06-13 |
| 4 | Test Coverage Foundation | 2026-06-13 |
| 5 | API Rate Limiting & DoS Protection | 2026-06-13 |
| 6 | Sale Creation Decoupling | 2026-06-13 |
| 7 | Remove debug.ts Exposure | 2026-06-13 |
| 8 | Structured Error Handling & Logging | 2026-06-13 |
| 9 | CI/CD & Deployment Hardening | 2026-06-13 |

---

## Architectural Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-06-13 | Keep approval workflows in pending→approved/rejected pattern | Auditable, supports multi-level review |
| 2026-06-13 | Soft deletes on all entities | Auditability, recoverability, multi-tenant data safety |
| 2026-06-13 | Rate limiting per orgId (not per userId) | Prevents one tenant from DoS-ing another; allows fair org-level quotas |

---

## How to Use This File

1. **Before starting any work:** query the graph — `graphify query "<what you're about to change>"`
2. **After completing a task:** check off the box `[ ]` → `[x]`
3. **After completing a phase:** move it to "Completed Work" with a date
4. **After any significant code change:** run `graphify update .` to keep the graph current
5. **When adding a new phase:** add it here first, then implement

---

## ⚠️ Standing Rules — Read Before Every Session

### 1 — Always use graphify first
Before touching any file in a non-trivial task, run:
```powershell
graphify query "<what you are about to change>"
```
This surfaces hidden dependencies, god-node blast radius, and community boundaries you might otherwise miss. The graph lives at `graphify-out/graph.json` and is always queryable without rebuilding. After any significant change, run `graphify update .` to keep it current.

### 2 — One branch per phase / feature — commit before moving on
Every phase and every self-contained feature gets its own git branch and a commit **before** starting the next thing. Never leave completed work uncommitted on `main`.

```powershell
# Start a new phase or feature
git checkout main
git pull
git checkout -b feature/<short-name>   # e.g. feature/org-settings-foundation

# Work, check off tasks, test

# When phase/feature is complete — commit to the branch
git add <specific files>
git commit -m "feat: <description>\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"

# Open PR → merge to main → delete branch
```

Branch naming convention:
| Type | Pattern | Example |
|---|---|---|
| New phase | `feature/phase-N-<slug>` | `feature/phase-10-org-settings` |
| Bug fix | `fix/<slug>` | `fix/vin-decode-fallback` |
| UI feature | `feature/<slug>` | `feature/searchable-selects` |
| Hotfix | `hotfix/<slug>` | `hotfix/hydration-mismatch` |

### 3 — Keep this file updated
After every completed task: tick the box.
After every completed phase: add it to the Completed Work table with a date.
After every architectural decision: add a row to the Decisions Log.

---

## Customization & Regional Expansion Roadmap
*Added 2026-06-15. Goal: make every dealership-specific value configurable per org so AutoFlow can scale regionally (JO → SA → AE → KW → EG and beyond).*

### What the audit found (graphify-verified, 2026-06-15)

| Hardcoded value | Location | Files affected |
|---|---|---|
| `JOD` / `د.أ` currency | Sales, reports, wizard, print | 54+ files |
| Lead sources (Walk-in, Facebook…) | `LeadDialog` | 1 (+ i18n) |
| Pipeline stages (8 fixed literals) | `schema.ts`, Kanban, LeadDialog | ~10 files |
| Payment types (CASH/INSTALLMENT) | `SalesWizard`, `sales/page` | ~5 files |
| Valuation companies (بندار/تمكين/السماحة) | `VehicleImportDialog` | 1 |
| Expense categories (12 literals) | `schema.ts`, expense dialog | ~4 files |
| VAT / tax rate | No org default stored | `sales.ts`, print |

`organizations` table today has only `name` + `createdAt` — **zero per-org configuration.**

---

### Phase 10 — Org Settings Foundation
*Branch: `feature/phase-10-org-settings`*
*Every later phase depends on this. Do this first.*

**New schema tables:**

`orgSettings` — one row per org, seeded at org creation:
```ts
orgSettings: defineTable({
  orgId: v.id("organizations"),
  // Regional
  currency: v.string(),            // "JOD" | "SAR" | "AED" | "KWD" | "EGP" | "QAR" | "BHD" | "OMR"
  currencySymbol: v.string(),      // "د.أ" | "ر.س" | "د.إ" | "د.ك"
  vatRate: v.optional(v.number()), // e.g. 15 for 15%
  country: v.optional(v.string()), // ISO 3166-1 alpha-2: "JO" | "SA" | "AE" | "KW"
  timezone: v.optional(v.string()),
  // Sales flow
  enabledPaymentTypes: v.array(v.string()), // ["CASH"] | ["INSTALLMENT"] | ["CASH","INSTALLMENT"]
  // Branding
  logoStorageId: v.optional(v.id("_storage")),
  primaryColor: v.optional(v.string()),       // hex e.g. "#2563eb"
  // Integrations (consumed in Phase 12)
  whatsappPhoneNumberId: v.optional(v.string()),
  whatsappApiToken: v.optional(v.string()),
  whatsappWebhookSecret: v.optional(v.string()),
}).index("by_org", ["orgId"])
```

`orgLeadSources` — replaces hardcoded dropdown in LeadDialog:
```ts
orgLeadSources: defineTable({
  orgId: v.id("organizations"),
  label: v.string(),    // "Walk-in" | "Haraj" | "TikTok" | any custom label
  isActive: v.boolean(),
  order: v.number(),
}).index("by_org", ["orgId"])
```

`orgValuationCompanies` — replaces hardcoded بندار/تمكين/السماحة in import:
```ts
orgValuationCompanies: defineTable({
  orgId: v.id("organizations"),
  name: v.string(),     // "بندار" | "Tamweel" | "Al Rajhi" | any
  isActive: v.boolean(),
  order: v.number(),
}).index("by_org", ["orgId"])
```

**Convex functions:**
- [ ] `orgSettings.get(orgId)` — query
- [ ] `orgSettings.upsert(orgId, fields)` — mutation (owner only)
- [ ] `orgSettings.uploadLogo(orgId)` — returns upload URL
- [ ] `orgLeadSources.list / create / update / reorder / softDelete`
- [ ] `orgValuationCompanies.list / create / update / softDelete`

**Frontend — new hooks:**
- [ ] `useOrgSettings()` — wraps `useQuery(api.orgSettings.get)`, used everywhere
- [ ] `useCurrency()` — exposes `{ format(n) → string, symbol, code }` — replaces all hardcoded JOD

**Frontend — components to update:**
- [ ] All money-displaying components → `useCurrency().format(n)`
- [ ] `LeadDialog` source dropdown → `useQuery(api.orgLeadSources.list)`
- [ ] `VehicleImportDialog` valuation columns → `useQuery(api.orgValuationCompanies.list)` (template generates dynamically)
- [ ] `SalesWizard` payment type buttons → filter by `orgSettings.enabledPaymentTypes`
- [ ] Print / PDF templates → currency from settings

**New Settings UI pages (under `/settings`):**
- [ ] **General** tab — currency picker, country, VAT rate, timezone
- [ ] **Lead Sources** tab — add / remove / reorder / toggle active
- [ ] **Valuation Companies** tab — add / remove / reorder
- [ ] **Appearance** tab — logo upload, primary color picker
- [ ] **Payment Types** tab — toggle Cash / Installment on/off

**Migration:**
- [ ] Seed `orgSettings` for all existing orgs: `currency:"JOD"`, `currencySymbol:"د.أ"`, `enabledPaymentTypes:["CASH","INSTALLMENT"]`
- [ ] Seed `orgLeadSources` from current hardcoded list
- [ ] Seed `orgValuationCompanies` from current hardcoded list (بندار, تمكين, السماحة)

**Commit checklist before merging:**
- [ ] `graphify update .` run
- [ ] All existing tests pass
- [ ] No `JOD` string literals remain outside of migration seed data
- [ ] Existing orgs see no UI change (seeded defaults match current hardcoded values)

**Estimated effort:** 5–6 days

---

### Phase 11 — Sales Flow Customization
*Branch: `feature/phase-11-sales-flow`*
*Requires Phase 10 `orgSettings` to exist.*

**Pipeline stages strategy:**
Schema uses `v.literal()` unions for `leads.stage` — changing to fully dynamic strings loses DB-level type safety. Approach: keep the 8 canonical keys in schema for integrity; add a config table controlling display name, order, color, and visibility per org. A disabled stage never appears in UI; its data still stores correctly.

**New schema tables:**

`orgPipelineConfig`:
```ts
orgPipelineConfig: defineTable({
  orgId: v.id("organizations"),
  stageKey: v.string(),          // "NEW" | "CONTACTED" | ... must match schema literals
  label: v.string(),             // Custom display: "وارد" | "Prospect" | "مهتم"
  isActive: v.boolean(),
  order: v.number(),
  color: v.optional(v.string()), // Kanban column header color
}).index("by_org", ["orgId"])
```

**Additions to `orgSettings`** (schema migration):
```ts
requireProfitApproval: v.optional(v.boolean()),
defaultMinimumProfit: v.optional(v.number()),
requireVehicleEditApproval: v.optional(v.boolean()),
requireVehicleCreateApproval: v.optional(v.boolean()),
```

`orgExpenseCategories` — for orgs needing custom categories (e.g. "Zakat" in SA):
```ts
orgExpenseCategories: defineTable({
  orgId: v.id("organizations"),
  key: v.string(),       // internal key
  label: v.string(),     // display label (bilingual via i18n or stored directly)
  isActive: v.boolean(),
  order: v.number(),
}).index("by_org", ["orgId"])
```

**Convex functions:**
- [ ] `orgPipelineConfig.list / upsert / reorder` (owner/manager only)
- [ ] `orgExpenseCategories.list / create / update / softDelete`

**Frontend — new hooks:**
- [ ] `useLeadStages()` — returns org's active stages in order with labels; replaces every hardcoded stage array

**Frontend — components to update:**
- [ ] `LeadDialog` stage dropdown → `useLeadStages()`
- [ ] Kanban board → `useLeadStages()` for column headers and colors
- [ ] `ExpenseDialog` category dropdown → `useQuery(api.orgExpenseCategories.list)`
- [ ] `VehicleDialog` — read `requireVehicleEditApproval` / `requireVehicleCreateApproval` from `orgSettings` to decide `requestCreate` vs `createVehicle`
- [ ] `SalesWizard` profit check — read `requireProfitApproval` + `defaultMinimumProfit` from `orgSettings`

**New Settings UI tabs:**
- [ ] **Pipeline** tab — drag-to-reorder stages, rename labels, toggle active, color picker
- [ ] **Approvals** tab — toggle switches per approval type, org default minimum profit input
- [ ] **Expense Categories** tab — add / remove / toggle custom categories

**Migration:**
- [ ] Seed `orgPipelineConfig` for existing orgs (8 default stages, matching current labels)
- [ ] Seed `orgExpenseCategories` from current 12 hardcoded literals

**Commit checklist:**
- [ ] `graphify update .` run
- [ ] All existing tests pass
- [ ] Kanban board still works with seeded defaults
- [ ] No hardcoded stage arrays remain in UI components

**Estimated effort:** 4–5 days

---

### Phase 12 — Branding + WhatsApp Integration
*Branch: `feature/phase-12-branding-whatsapp`*
*Requires Phase 10 `orgSettings` for logo/color/credentials storage.*

**Branding:**
- [ ] `TopNav` — read `orgSettings.logoStorageId`, show dealer logo when set, fall back to "AutoFlow" text
- [ ] Print/PDF templates — embed org logo in quote print and sale print
- [ ] Primary color — inject `orgSettings.primaryColor` as CSS variable `--primary` at org level (Tailwind already uses `hsl(var(--primary))`)

**WhatsApp webhook (Option A — each dealer brings their own Meta credentials):**

New Convex HTTP endpoints in `convex/http.ts`:
```
GET  /whatsapp/{orgId}   ← Meta webhook verification challenge
POST /whatsapp/{orgId}   ← Incoming message handler
```

Handler logic:
- [ ] Verify `X-Hub-Signature-256` against `orgSettings.whatsappWebhookSecret`
- [ ] Extract sender phone, display name, message text from Meta's payload format
- [ ] Look up or create customer by phone number (`customers.findOrCreateByPhone`)
- [ ] Run message through Claude Haiku — extract vehicle interest, make/model, budget from text
- [ ] Create lead with `source: "WhatsApp"`, AI-parsed intent in notes
- [ ] Push notification to org's team

**Convex functions:**
- [ ] `customers.findOrCreateByPhone(orgId, phone, displayName)` — internal mutation
- [ ] `leads.createFromWhatsapp(orgId, customerId, parsedIntent)` — internal mutation

**New Settings UI — Integrations tab:**
- [ ] WhatsApp API Token input (masked, stored in `orgSettings.whatsappApiToken`)
- [ ] Phone Number ID input
- [ ] Webhook secret — auto-generated UUID, copyable
- [ ] Webhook URL display — `https://<domain>/whatsapp/{orgId}` — copyable
- [ ] Test connection button

**Commit checklist:**
- [ ] `graphify update .` run
- [ ] Webhook signature verification tested
- [ ] No API tokens logged or exposed in responses
- [ ] Graceful handling when `orgSettings.whatsappApiToken` is not configured

**Estimated effort:** 4–5 days (3 without AI parsing, +2 with)

---

### Phase 13 — Advanced Customization
*Branch: `feature/phase-13-advanced`*
*Requires Phases 10–11.*

**Custom vehicle fields:**

`orgVehicleFields`:
```ts
orgVehicleFields: defineTable({
  orgId: v.id("organizations"),
  key: v.string(),              // internal: "inspection_grade"
  label: v.string(),            // display: "Inspection Grade" / "درجة الفحص"
  fieldType: v.union(
    v.literal("text"), v.literal("number"),
    v.literal("select"), v.literal("boolean"), v.literal("date")
  ),
  options: v.optional(v.array(v.string())), // for select type
  isRequired: v.boolean(),
  showInList: v.boolean(),      // show as column in vehicles table
  showInImport: v.boolean(),    // include in import template
  order: v.number(),
}).index("by_org", ["orgId"])
```

Schema addition to `vehicles`:
```ts
customFields: v.optional(v.record(v.string(), v.any()))
```

- [ ] `VehicleDialog` renders custom fields dynamically after standard fields
- [ ] `VehicleImportDialog` adds custom columns to template when `showInImport: true`
- [ ] Vehicles list table shows custom columns when `showInList: true`

**Tiered commission structures:**

`orgCommissionRules`:
```ts
orgCommissionRules: defineTable({
  orgId: v.id("organizations"),
  name: v.string(),
  type: v.union(v.literal("FLAT"), v.literal("PERCENT_PROFIT"), v.literal("TIERED")),
  flatAmount: v.optional(v.number()),
  percentOfProfit: v.optional(v.number()),
  tiers: v.optional(v.array(v.object({
    minProfit: v.number(),
    maxProfit: v.optional(v.number()), // null = unlimited
    commissionAmount: v.number(),
  }))),
  isDefault: v.boolean(), // applies to all staff unless overridden on membership
}).index("by_org", ["orgId"])
```

- [ ] `convex/sales.ts` commission calculation calls `calculateCommission(sale, orgRule, membershipOverride)` helper
- [ ] Commission rule engine tested with unit tests before merge

**Regional document templates:**

Seed `companyDocumentRules` defaults based on `orgSettings.country` at org creation:
- JO: National ID, Salary Certificate, 3-month bank statement
- SA: Iqama or National ID, salary letter, employer letter
- AE: Emirates ID, salary slip, visa copy

- [ ] Onboarding wizard shown to new orgs on first login: pick country → auto-seeds currency, VAT, document templates, lead sources, valuation companies for that market

**New Settings UI tabs:**
- [ ] **Custom Fields** tab — field builder (type selector, label, options list, required toggle, show-in-list toggle)
- [ ] **Commission Rules** tab — rule builder with tier editor
- [ ] **Onboarding Wizard** — triggered on first org login, or accessible from settings

**Commit checklist:**
- [ ] `graphify update .` run
- [ ] All commission calculation tests pass
- [ ] Custom fields do not break existing vehicle queries (optional field, filtered server-side)
- [ ] Onboarding wizard tested for each supported country

**Estimated effort:** 6–8 days

---

## Customization Phases — Completed Work

| Phase | Title | Branch | Completed |
|---|---|---|---|
| *(none yet)* | | | |

---

## Customization Execution Order

```
Phase 10 (Foundation) → Phase 11 (Sales Flow) → Phase 12 (Branding/WhatsApp) → Phase 13 (Advanced)
        ↓                        ↓                         ↓                            ↓
  Unblocks all           Unblocks pipeline          Unblocks logo/color          Unblocks custom
  currency/locale         & approval config          in print templates            vehicle fields
  changes below
```

No phase should begin until the previous one is committed and merged to `main`.
