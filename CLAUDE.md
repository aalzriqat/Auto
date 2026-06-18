# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

AutoFlow is a multi-tenant car dealership management system. The stack is Next.js 16 (App Router) + Convex backend + Clerk auth, with a bilingual UI (English/Arabic).

## Commands

```bash
pnpm dev          # starts Convex dev server + Next.js together
pnpm build        # production build
pnpm lint         # ESLint
pnpm test         # vitest (unit + Convex function tests)
```

To run a single test file: `pnpm test convex/sales.test.ts`

## Architecture

### Provider chain

The root layout wraps all pages in: `ClerkProvider → LanguageProvider → ConvexClientProvider → OrgProvider` (the last three are added in `app/(dashboard)/layout.tsx`).

### Multi-tenancy

Every entity in the database is scoped to an `orgId`. The active org is selected in `OrgProvider` (`components/providers/OrgProvider.tsx`) and persisted in `localStorage`. Users without an org see an onboarding screen.

### Authentication & authorization

- Clerk handles auth. Convex receives user sync via a Svix webhook at `/clerk-webhook` (defined in `convex/http.ts`).
- In Convex functions, use helpers from `convex/utils/tenancy.ts`:
  - `requireAuth(ctx)` — verifies Clerk identity, returns `users` row
  - `requireTenantAuth(ctx, orgId, [permissions])` — verifies org membership + optional permissions
  - `requireOwner(ctx, orgId)` — OWNER-only guard
- Permissions are fine-grained strings (`"action:resource"`) defined as constants in `convex/utils/permissions.ts`. Roles store an array of these strings and are customizable per-org.
- Default role templates: `OWNER`, `MANAGER`, `SALES`, `RECEPTION`, `ACCOUNTANT`.

### Routing

- `app/(dashboard)/` — all authenticated dealership pages (vehicles, customers, leads, sales, expenses, tasks, reports, team, settings, accounting)
- `app/sign-in/` and `app/sign-up/` — Clerk auth pages
- `app/page.tsx` — landing page

### Convex backend

All backend logic lives in `convex/`. Client-facing queries/mutations use `api.*`, private helpers use `internal.*`. Generated types are in `convex/_generated/` (do not edit).

Key patterns used throughout:
- **Soft deletes**: entities have `isDeleted`, `deletedAt`, `deletedBy` fields; always filter these out in queries.
- **Approval workflows**: vehicle creates/edits (`vehicleEdits`), vehicle status changes (`vehicleStatusRequests`), and below-minimum-profit sales (`profitApprovalRequests`) go through a pending → approved/rejected flow.
- **Rate limiting**: the `@convex-dev/rate-limiter` component is mounted in `convex/convex.config.ts`.

### i18n

- Supports English and Arabic (RTL). Locale stored in `localStorage`.
- Use the `useLanguage()` hook (`components/providers/LanguageProvider.tsx`) for the `t()` translation function and `isRtl` flag.
- Translation dictionaries are in `lib/i18n/` split into domain files (`common`, `dashboard`, `vehicles`, `customers`, `leads`, `sales`, `settings`, `expenses`).
- Arabic uses the Cairo font; English uses Inter. The font is swapped dynamically on the `<html>` element.

### Forms & validation

- Forms use `react-hook-form` + `zod`. Each domain has a schema file alongside its component (e.g. `components/vehicles/vehicle.schema.ts`).
- Financing calculations live in `lib/financing.ts` and are tested in `lib/financing.test.ts`.

### UI components

All shadcn/ui components are in `components/ui/`. Use `cn()` from `lib/utils.ts` for conditional Tailwind classes. Toasts use `sonner` via `components/ui/sonner.tsx`.

### Testing

- Convex function tests: `convex/*.test.ts`, using `convex-test` + vitest. Each test file passes `import.meta.glob("./**/*.ts")` as a module map to `convexTest`.
- Library tests: `lib/*.test.ts`.
- Environment is `jsdom` (see `vitest.config.ts`).

### Super Admin dashboard

- `/admin` is a developer-only, cross-tenant control panel — completely separate from per-org RBAC. Gated by `requireSuperAdmin(ctx)` (`convex/utils/tenancy.ts`), which checks the caller's email against the `SUPER_ADMIN_EMAILS` Convex env var (comma-separated). Set it via `npx convex env set SUPER_ADMIN_EMAILS "you@example.com"`.
- Backend lives in `convex/admin*.ts` (`adminAuth`, `adminOrgs`, `adminUsers`, `adminData`, `adminSystem`, `adminAudit`). Frontend lives in `app/admin/` with its own layout/sidebar, outside `app/(dashboard)/[orgId]/`.
- Can suspend/hard-delete any org, disable/delete/change-role any user across orgs, browse and edit/hard-delete any record in ~20 entity tables via a raw-JSON editor (`adminData.ts`), and view system health (cron heartbeats, webhook delivery log). Every admin mutation writes to the `adminAuditLog` table.
- Impersonation deep-links to the Clerk Dashboard's built-in "Impersonate user" feature rather than reimplementing Clerk Actor Tokens in-app.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
