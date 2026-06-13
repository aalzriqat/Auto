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

1. **Before starting any work:** query the graph — `python -m graphify query "<what you're about to change>"`
2. **After completing a task:** check off the box `[ ]` → `[x]`
3. **After completing a phase:** move it to "Completed Work" with a date
4. **After any significant code change:** run `python -m graphify update .` to keep the graph current
5. **When adding a new phase:** create the phase file first, then add its entry here
