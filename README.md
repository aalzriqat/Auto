# AutoFlow

**A multi-tenant operating system for car dealerships.**

AutoFlow is an end-to-end platform that runs the daily operations of an automotive dealership — inventory, sales, financing, accounting, staff, and a cross-dealer marketplace — behind a single bilingual (English / Arabic) interface. It is built as a strictly multi-tenant SaaS: every record is scoped to an organization, and access is governed by fine-grained, per-org role-based permissions.

The platform ships as a web application, a companion mobile app, and an edge worker, sharing one strongly-typed backend.

---

## Highlights

- **True multi-tenancy** — every entity is org-scoped end to end, with an onboarding flow for users without an organization.
- **Fine-grained RBAC** — permissions are `action:resource` strings composed into customizable per-org roles (`OWNER`, `MANAGER`, `SALES`, `RECEPTION`, `ACCOUNTANT`, …). All authorization is enforced server-side.
- **Double-entry accounting** — a general-ledger subledger with journals, COGS/commission recognition, prepaid amortization, and reconciliation reporting.
- **Approval workflows** — vehicle creates/edits, status changes, and below-minimum-profit sales route through a pending → approved/rejected flow with a full audit trail.
- **Dealer marketplace** — a reverse marketplace that matches buyer requests to inventory across dealers, with push notifications and messaging.
- **Bilingual, RTL-aware UI** — first-class English and Arabic support, with dynamic font swapping and full right-to-left layout.
- **Super-admin control plane** — a cross-tenant operations console, isolated from per-org RBAC, for platform administration and system health.

## Feature surface

Inventory & sourcing · Customers & leads · Sales & commissions · Financing applications · Deposits & payments · Expenses & payroll · Accounting & reports · Tasks · Team & permissions · Notifications · Internal messaging · Social inbox · Cross-dealer marketplace.

---

## Architecture

AutoFlow is a **pnpm monorepo** built around a single Convex backend that every client consumes through generated, type-safe APIs.

```
apps/mobile        React Native (Expo) companion app, OTA-updatable
convex/            Backend: queries, mutations, schema, cron jobs, HTTP endpoints
app/               Next.js App Router — dashboard, auth, marketing pages
components/         UI (shadcn/ui + Tailwind), providers, domain components
lib/               Shared client logic (financing math, i18n, utilities)
dealer-worker/     Cloudflare Worker for edge-side dealer integrations
packages/          Shared cross-app code
```

**Stack**

| Layer | Technology |
| --- | --- |
| Frontend | Next.js 16 (App Router), React, TypeScript |
| Backend | Convex (reactive database + server functions) |
| Auth | Clerk (web + native), synced to Convex via Svix webhooks |
| Styling | Tailwind CSS, shadcn/ui, `sonner` toasts |
| Forms | react-hook-form + zod |
| Mobile | React Native / Expo with OTA updates |
| Edge | Cloudflare Workers |
| Observability | Sentry |

**Design principles**

- **Backend owns the truth.** All validation and business logic live in Convex functions; the frontend is never trusted to enforce a rule. Auth is centralized in `convex/utils/tenancy.ts` (`requireAuth`, `requireTenantAuth`, `requireOwner`, `requireSuperAdmin`).
- **Soft deletes everywhere.** Entities carry `isDeleted` / `deletedAt` / `deletedBy` and are filtered out of reads.
- **Defensive frontend.** Optional chaining and fallbacks on all async/nested data, with explicit loading and empty states.
- **Zero-`any` TypeScript.** Types are explicit and generated types are treated as source of truth.

---

## Getting started

**Prerequisites:** Node 22+, pnpm, and Convex / Clerk accounts.

```bash
pnpm install
pnpm dev          # runs the Convex dev server and Next.js together
```

Configure the required environment variables (Clerk keys, Convex deployment, webhook secrets) before first run. The mobile app and dealer worker are managed through the workspace scripts below.

### Common scripts

```bash
pnpm dev              # Convex + Next.js, watched
pnpm build            # production web build
pnpm lint             # ESLint
pnpm test             # unit + Convex function tests (vitest)
pnpm typecheck        # tsc --noEmit
pnpm mobile:start     # start the Expo mobile app
pnpm mobile:android   # run the mobile app on Android
```

---

## Testing

Quality is enforced at multiple levels:

- **Unit & backend tests** — `vitest` with `convex-test` exercises Convex functions in isolation, plus library-level tests for pure logic (financing math, date handling, i18n).
- **End-to-end** — **Playwright** covers the critical flows (sign-in, dashboard, inventory, customers, leads, expenses, an end-to-end cash sale, marketplace listings, and language switching) against a real production build.
- **Load testing** — `k6` smoke and 1,000-user scenarios under `load-tests/`.
- **Coverage** — tracked in CI with per-module thresholds on the accounting core.

```bash
pnpm test                 # unit + backend
pnpm e2e:playwright       # Playwright E2E
pnpm test:coverage        # coverage report
```

---

## Deployment

The web app deploys to Vercel; the Convex backend deploys via the Convex CLI; the mobile app ships production builds and over-the-air updates through Expo/EAS; and the dealer worker deploys to Cloudflare. CI runs linting, type-checking, tests, and the E2E suites on every change.

---

## License

Proprietary. All rights reserved.
