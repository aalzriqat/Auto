# Executive Summary

## 1. Codebase Topology Map
The repository follows a modern Next.js App Router structure with Convex as the backend:

- **`/app`**: Next.js App Router entry points.
  - `/app/(dashboard)`: Authenticated CRM routes (sales, accounting, leads, customers, etc.).
  - `/app/sign-in` & `/sign-up`: Clerk authentication routes.
- **`/components`**: Frontend React components.
  - `/components/ui`: Reusable shadcn/ui generic components.
  - Feature-specific directories (`/sales`, `/applications`, `/accounting`, etc.) containing complex business UI.
- **`/convex`**: The entire backend infrastructure (Serverless Functions, Database schema, Crons, HTTP webhooks).
  - `/convex/schema.ts`: Database definitions for all models.
  - `/convex/http.ts`: Webhook handlers (e.g., Clerk user sync).
  - `/convex/crons.ts`: Scheduled background jobs.
  - `/convex/utils`: Shared backend utilities (tenancy, permissions, notifications).
  - Feature endpoints (`sales.ts`, `reports.ts`, `vehicles.ts`, etc.): API queries and mutations.
- **`/lib`**: Shared frontend utilities (environment validation, PDF generation, general formatting).
- **`/hooks`**: Custom React hooks (e.g., permissions checking).
- **`/public`**: Static assets.

## 2. Tech Stack Summary
- **Runtime / Framework**: Node.js, Next.js (App Router), React 19.
- **Backend / Database / Storage**: Convex (handles serverless functions, real-time database, and object storage).
- **Authentication**: Clerk (integrated with Convex via JWT).
- **Styling / UI**: Tailwind CSS, shadcn/ui, Radix UI, Framer Motion, Recharts.
- **Email Service**: Resend.
- **Error Tracking & Observability**: Sentry (configured for client, server, and edge).
- **PDF Generation**: jsPDF, html2canvas.
- **Tooling**: TypeScript, ESLint, Prettier, Vitest (for unit testing), pnpm (package manager).

## 3. Executive Summary
This application is a multi-tenant automotive dealership management system (CRM/ERP) designed to streamline dealership operations. It serves dealership owners, sales staff, and managers by providing a unified platform to manage vehicle inventory, track customer leads, structure financing deals, handle document approvals, track expenses, and view real-time profit and loss reports. Currently in an advanced MVP/beta state, the codebase leverages Convex for excellent type safety and real-time reactivity. However, as it prepares to scale to thousands of concurrent users, it requires significant hardening. The current implementation suffers from architectural bottlenecks such as severe N+1 query patterns in reporting/listing endpoints, tight coupling of business logic within Convex handlers, inconsistent error propagation, and virtually non-existent test coverage.

## 4. Production Readiness Scorecard

| Dimension               | Score | Summary |
|------------------------|-------|---------|
| Security                | 6/10  | Strong foundation with Clerk/Convex RBAC, but rate limiting is rudimentary and there are missing server-side input validations (Zod not used in Convex args). |
| Error Handling          | 5/10  | Basic `try/catch` with Sonner toasts on frontend. Sentry is installed, but backend errors are often thrown as generic `ConvexError` without structured context. |
| Observability/Logging   | 4/10  | Sentry exists, but no structured logging (e.g., Pino) inside Convex functions. Missing distributed tracing and structured audit trails for all actions. |
| Performance             | 4/10  | High risk. Heavy use of N+1 queries in `reports.ts` and list endpoints. No caching layer for expensive aggregations. |
| Scalability             | 7/10  | Convex inherently scales well, but the current query design (unbounded `collect()` and in-memory filtering) will cause memory exhaustion and timeouts under load. |
| Maintainability         | 5/10  | God files exist (e.g., `schema.ts`, large UI components). Business logic is mixed directly into database queries. |
| Test Coverage           | 2/10  | Only basic setup (`vitest` installed, two test files seen). Critical financial logic lacks unit tests. |
| Documentation           | 3/10  | Barebones `README.md`. No architectural decision records, API documentation, or extensive inline JSDoc for complex calculations. |
| **OVERALL**             | **4.5/10** | **Needs significant optimization and testing before high-scale production launch.** |

## 5. Top 5 Risks if Deployed Today

1. **Unbounded Database Queries (OOM & Timeouts):**
   - *Scenario:* In `reports.ts`, endpoints like `getSalesAndProfitReport` query all sales for an org and filter them in-memory, performing subsequent queries for every single sale in a loop (N+1).
   - *Impact:* With thousands of sales, this will exceed Convex function memory/time limits, bringing down reporting and dashboard features completely.

2. **Missing Input Schema Validation:**
   - *Scenario:* Convex endpoints rely solely on `v.string()` / `v.number()` type checks. There is no business-logic validation (e.g., max string length, positive amounts for financial fields).
   - *Impact:* Malicious or buggy clients can insert negative prices, impossibly long strings, or malformed data, corrupting the financial integrity of the dealership.

3. **Rate Limiting Insufficiency on Critical Paths:**
   - *Scenario:* The `rateLimiter.ts` defines limits for email and uploads, but many heavy read endpoints and mutation endpoints lack rate limiting.
   - *Impact:* A single compromised account or aggressive scraping bot can easily exhaust Convex database bandwidth, causing a Denial of Service (DoS) for all tenants.

4. **Lack of Automated Testing for Financial Logic:**
   - *Scenario:* Deal structuring (quotes, APR calculations, tax) and profit/loss calculations are entirely untested.
   - *Impact:* A minor refactor or edge case in deal structuring could miscalculate taxes or loan terms, leading to legal liability and financial loss for the dealership.

5. **Tight Coupling & Lack of Abstraction:**
   - *Scenario:* Business rules (like what happens when a sale is created) are hardcoded imperatively inside the mutation handlers (e.g., updating vehicle status, creating transactions, closing leads).
   - *Impact:* As the application grows, adding a new feature (e.g., loyalty points on sale) requires modifying massive, brittle god functions, leading to regression bugs and slow development velocity.
