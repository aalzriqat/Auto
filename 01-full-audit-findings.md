# Full Codebase Audit Findings

This document contains a representative sample of the critical and high-priority issues discovered during the codebase audit, categorized by severity.

## 2.1 — Critical Issues (Must fix before any production deployment)

📁 **FILE:** `convex/reports.ts`
📍 **LINE(S):** 28-59, 89-109, 140-156, 198-234, 298-316
🔴 **SEVERITY:** Critical
🏷️ **CATEGORY:** Performance & Scalability
📝 **ISSUE:** Severe N+1 query patterns in reporting endpoints. Inside loops processing `collect()` results, the code performs individual `ctx.db.get()` and `ctx.db.query().collect()` calls for related records (e.g., fetching `expenses` for every single `vehicleId`).
💡 **WHY IT MATTERS:** As the dealership records more sales and expenses, these queries will grow linearly. Convex serverless functions have execution time and memory limits. Once the dataset exceeds a few hundred records, the reports dashboard will completely crash with timeout or OOM (Out of Memory) errors, taking down the application.
✅ **FIX:** 
1. Use `Promise.all` to fetch related records concurrently if small, but preferably:
2. Pre-fetch all necessary related records in bulk (e.g., fetch all expenses for the org, then group them by vehicleId in memory using a `Map`).
3. For aggregations over large datasets, consider a denormalized summary table or background cron job that pre-calculates daily rollups.

📁 **FILE:** `convex/sales.ts`
📍 **LINE(S):** 111-132, 243-262
🔴 **SEVERITY:** Critical
🏷️ **CATEGORY:** Input Validation
📝 **ISSUE:** Convex `args` definitions rely solely on basic types (e.g., `v.number()`, `v.string()`). There is no business-logic validation (e.g., checking if `salePrice` > 0, if `downPayment` <= `salePrice`, or limiting `notes` string length).
💡 **WHY IT MATTERS:** Malicious actors or UI bugs can send corrupted data (negative prices, NaN, impossibly large arrays) directly to the database. This compromises the integrity of the financial system, leading to incorrect profit reports, broken UI rendering, and potential application crashes.
✅ **FIX:** Wrap Convex args with a validation library like `zod` via an abstraction layer, or implement manual assertions at the very beginning of the `handler` before any database reads/writes occur.

📁 **FILE:** `convex/sales.ts` (and similar mutations like `transactions.ts`, `vehicles.ts`)
📍 **LINE(S):** 133-237
🔴 **SEVERITY:** Critical
🏷️ **CATEGORY:** Architecture & Maintainability
📝 **ISSUE:** Tight coupling of cross-domain business logic. The `create` sale mutation manually marks vehicles as SOLD, creates transaction records, and iterates over leads to close them as WON. 
💡 **WHY IT MATTERS:** If the `transactions.ts` schema changes, or if a bug occurs while closing leads, the entire sale creation fails (or succeeds partially if not transacted safely). This makes testing impossible and vendor switching impossible.
✅ **FIX:** Abstract the "Sale Creation Workflow" into a service/domain layer that coordinates these updates, utilizing Convex's transactional guarantees properly without mixing it directly in the API handler.

## 2.2 — High Priority Issues (Fix before launch or within first sprint)

📁 **FILE:** `convex/email.ts`
📍 **LINE(S):** 93-101
🟠 **SEVERITY:** High
🏷️ **CATEGORY:** Configuration & Environment
📝 **ISSUE:** Hard dependency on `NEXT_PUBLIC_APP_URL` environment variable for critical backend logic (team invites).
💡 **WHY IT MATTERS:** If `NEXT_PUBLIC_APP_URL` is omitted or misconfigured in production, team invites will silently fail or send broken links, preventing user onboarding.
✅ **FIX:** Enforce strict startup environment variable validation (using the existing `lib/env.ts` pattern, but extended for backend secrets) to ensure the server refuses to boot if critical variables are missing.

📁 **FILE:** `convex/crons.ts`
📍 **LINE(S):** 24-36
🟠 **SEVERITY:** High
🏷️ **CATEGORY:** Scalability
📝 **ISSUE:** The cron job `triggerAlarms` performs a full table scan across all tenants (`q.eq("orgId", "" as any)` or scanning the entire `tasks` table) because it lacks an appropriate index on `status` and `alarmTriggered`.
💡 **WHY IT MATTERS:** This runs every 5 minutes. As the number of tasks grows globally across all organizations, this full table scan will consume excessive database bandwidth and eventually exceed the function timeout.
✅ **FIX:** Define a new index in `schema.ts` on the `tasks` table: `.index("by_status_alarm", ["status", "alarmTriggered"])` and rewrite the query to utilize it.

📁 **FILE:** `package.json`
📍 **LINE(S):** 70
🟠 **SEVERITY:** High
🏷️ **CATEGORY:** Testing
📝 **ISSUE:** Almost zero test coverage. `vitest` is installed, but critical financial structuring (`lib/financing.ts`), PDF generation (`lib/pdf.ts`), and backend mutations (`convex/sales.ts`) lack automated tests.
💡 **WHY IT MATTERS:** Refactoring or adding features to financial calculators or PDF templates is extremely dangerous without regression tests. The risk of breaking production with a bad deployment is high.
✅ **FIX:** Write unit tests for all utility functions in `lib/` and implement integration tests for critical user journeys (creating a sale, generating a quote, adding a vehicle).

## 2.3 — Medium Priority Issues (Fix within first month)

📁 **FILE:** `convex/sales.ts`
📍 **LINE(S):** 108
🟡 **SEVERITY:** Medium
🏷️ **CATEGORY:** API & Network Security
📝 **ISSUE:** Rate limiting is applied to the `create` sale mutation (`rateLimiter.limit(ctx, "create")`), but many other endpoints (e.g., `update`, `softDelete`, and heavy read queries) lack rate limiting.
💡 **WHY IT MATTERS:** While basic rate limiting protects against rapid creation spam, heavy read endpoints (like reports) can still be abused to cause Denial of Service (DoS) and spike billing costs.
✅ **FIX:** Apply rate limiting to all authenticated endpoints based on a tier system (e.g., lighter limits for reads, stricter limits for expensive reports and mutations).

📁 **FILE:** `lib/env.ts`
📍 **LINE(S):** 3-17
🟡 **SEVERITY:** Medium
🏷️ **CATEGORY:** Configuration
📝 **ISSUE:** Convex backend environment variables (like `RESEND_API_KEY`, `CLERK_WEBHOOK_SECRET`) are not validated centrally. `env.ts` only validates Next.js environment variables.
💡 **WHY IT MATTERS:** Backend configuration errors are only discovered at runtime when a specific code path is hit (e.g., sending an email throws an error because the key is missing).
✅ **FIX:** Create a `convex/env.ts` that uses Zod to validate all `process.env` variables required by the Convex backend at initialization.

## 2.4 — Low Priority & Informational (Fix when time allows)

📁 **FILE:** `lib/sanitize.ts`
📍 **LINE(S):** 5-11
🟢 **SEVERITY:** Low
🏷️ **CATEGORY:** Security
📝 **ISSUE:** Custom sanitization logic (`replace(/[\x00-\x1F\x7F]/g, "")`) is used to prevent PDF injection.
💡 **WHY IT MATTERS:** Custom sanitization is prone to edge cases. While sufficient for PDF parsing, it might not catch complex Unicode exploits or XSS if this input is ever rendered back to the DOM without proper escaping.
✅ **FIX:** Use a mature sanitization library like `DOMPurify` (if rendering HTML) or ensure strict input schema validation upstream to reject invalid characters entirely.

📁 **FILE:** `convex/debug.ts`
📍 **LINE(S):** 2-9
ℹ️ **SEVERITY:** Info
🏷️ **CATEGORY:** Security
📝 **ISSUE:** A `debug.ts` endpoint exists that dumps entire tables (`vehicles`, `expenses`) without any authentication checks.
💡 **WHY IT MATTERS:** If this endpoint is ever deployed to production and exposed via HTTP or client queries, it represents a massive data leak.
✅ **FIX:** Delete this file or restrict it strictly to administrative users with `MANAGE_SETTINGS` permissions.
