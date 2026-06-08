The brutal truth — read this before anything else

This is a 0% production ready application right now. Not because it's badly written — the architecture is actually decent — but because it has no tests, no rate limiting, no input-level security hardening, fake dashboard data being shown to users, 5 garbage scripts committed to the root of the repo, zero pagination on any list (meaning one large dealership with 2,000 vehicles will bring the UI to its knees), and no monitoring/alerting if the whole thing falls over at 2am. You are one Convex subscription storm away from a $3,000 bill and a white screen for every user. The backend RBAC structure is solid but it's unproven — there are no tests that verify a staff member cannot access another org's data. In a SaaS handling financial data and customer PII, that gap is a legal liability in most jurisdictions. The good news: the foundation is sound. Two to three focused engineering weeks will get you to a launchable state. This plan tells you exactly what to do in what order.

0%

Production ready today

~2–3 wks

To launchable MVP

7

Hard blockers

Good

Architecture bones

Plan overview

Phase 1
Hard blockers — fix before any user touches this (3–4 days)
Phase 2
Security & data integrity — before public launch (3–4 days)
Phase 3
Performance & scalability — before growth (3–4 days)
Phase 4
Observability & ops — before sleeping at night (2–3 days)
Phase 5
Code quality & maintainability — ongoing (parallel)
Phase 1 — Hard Blockers
Things that are broken or dangerous right now

3–4 days
BLOCKER Dashboard is showing fake hardcoded data to users

mockLineData in app/(dashboard)/dashboard/page.tsx is a disconnected node — it has exactly 1 edge in the entire graph and it's a containment edge, not a data edge. This means your charts are rendering made-up numbers while convex/dashboard.ts → stats has a real working query sitting idle. If a dealership owner makes a business decision based on what they see on the dashboard, they are making it on fiction. This is the worst bug in the app.

// Replace this:
const mockLineData = [{ month: "Jan", sales: 12 }, ...]

// With this:
const stats = useQuery(api.dashboard.stats, { orgId: org._id });
BLOCKER No tests — zero. None. Zilch.

There are 14 nodes in the graph with "test" in their label. Every single one is either the TestDrive feature, a Convex docs reference, or a guidelines doc. There is not a single test file in this codebase. Not one. In a SaaS that handles customer PII, financial calculations (Murabaha DBR), vehicle valuations, multi-tenant permissions, and money-adjacent documents — this is not acceptable for production. At minimum, before launch you need: (1) auth boundary tests verifying cross-org data isolation, (2) unit tests for calculateUnifiedMurabaha() and calculateDBR() with known inputs and expected outputs, (3) permission matrix tests verifying each role can and cannot do what it's supposed to. The Murabaha calculation is used in financial quotes given to customers. A bug there is a compliance and liability issue.

# Priority test files to create first:
convex/utils/permissions.test.ts   # RBAC matrix — highest priority
lib/financing.test.ts              # Murabaha + DBR — financial correctness
convex/utils/tenancy.test.ts       # Cross-org isolation
lib/pdf.test.ts                    # PDF output correctness
BLOCKER No pagination anywhere — any list query will explode at scale

Every Convex query (vehicles.list, customers.list, sales.list, leads.list, etc.) almost certainly returns all records. There is no pagination node anywhere in the graph. Convex has a built-in function budget — queries that read too many documents will be killed. A dealership with 500 vehicles, 2,000 customers, and 5,000 sales records will trigger Convex's limits and get errors. Worse: Convex reactive subscriptions mean every user on the vehicles page is re-rendering every time any vehicle changes. With 10 concurrent users and 500 vehicles, this is already a problem. Use usePaginatedQuery on every list endpoint, starting with vehicles and customers.

// Before (will break at scale):
const vehicles = useQuery(api.vehicles.list, { orgId })

// After:
const { results, loadMore, status } = usePaginatedQuery(
  api.vehicles.list, { orgId }, { initialNumItems: 25 }
)
BLOCKER Tenancy isolation is code-only — never proven

requireTenantAuth() and requireOwner() are called across all 24 Convex modules. That's the right pattern. But without tests, you don't know if every query and mutation actually enforces it — or if you missed one. In a multi-tenant SaaS, one missing requireTenantAuth() call on a single query means Org A can read Org B's customer financial data. That's not a bug — that's a data breach. Write a test suite that calls every backend function with a mismatched orgId and asserts it throws. This is the highest-severity security issue in the codebase.

BLOCKER generateUploadUrl on vehicles and documents is publicly callable without file-type validation

Both convex/vehicles.ts → generateUploadUrl and convex/documents.ts → generateUploadUrl appear in the graph without any associated validation node. Convex's generateUploadUrl gives the caller a direct upload URL to Convex file storage. If you're not validating file type and size server-side before issuing the URL, anyone with a valid session can upload arbitrary files — including executables, malicious PDFs, or multi-gigabyte files — to your Convex storage at your cost. You must validate MIME type and set a max file size in the mutation before issuing the URL.

BLOCKER 5 hack scripts committed to the repo root

fix_vehicledialog.js, update_vehicledialog.js, update_vehicledialog2.js, update_vehicledialog3.js, update_saledialog.js. Five. These are codemod/patch scripts from when you were iterating. They are in your production repository, they are tracked by Graphify, they will confuse future AI assistants, and they will confuse any engineer who joins the team. They use fs to read and write files — they should never have been committed. Delete them now, update the commit, and add *.patch.js and fix_*.js to your .gitignore.

BLOCKER Single ErrorBoundary() at the app root — no feature-level error isolation

There is exactly one error node in the graph: app/error.tsx → ErrorBoundary(). This means if any component throws — a bad Convex query, a rendering error in the sales table, a PDF generation failure — the entire dashboard goes blank. For a dealership with 5 staff members using this simultaneously, one person's bad data can white-screen everyone. Add error boundaries at the page level and around each major feature section (vehicles list, customer details, reports). Wrap Convex mutations in try/catch and surface errors via the sonner toast (which you already have installed).

Phase 2 — Security & Data Integrity
Before any real user data enters the system

3–4 days
HIGH No rate limiting on any Convex mutation

There is no rate limiting node anywhere in the graph. Every mutation — create customer, create sale, invite team member, send email — can be called at any frequency by any authenticated session. A disgruntled employee, a browser refresh loop, or a compromised session can spam convex/email.ts → sendTeamInvite and run up your Resend bill, or spam convex/customers.ts → create and fill your database with junk. Implement rate limiting in Convex using the @convex-dev/ratelimiter component on at least: all email-sending actions, all create mutations, and all file upload URL generations.

HIGH Middleware only checks auth — no permission checks at the route level

middleware.ts has only 2 connections in the graph: isPublicRoute and config. It's doing Clerk auth gating — is the user signed in? — but nothing more. Anyone with a valid account can navigate directly to /settings/finance, /team, or /reports regardless of their role. Your PERMISSIONS system and usePermissions() hook are almost certainly doing client-side permission checks only, which means the UI hides buttons but doesn't actually block the route. A savvy user can bypass this trivially. Route-level permission checks must happen server-side in the middleware or as a server component check, not just by hiding UI elements.

HIGH calculateUnifiedMurabaha() and calculateDBR() — untested financial logic

These two functions in lib/financing.ts are the financial heart of your application. They drive customer quotes and loan eligibility decisions. They have 4 edges total in the graph — both are called from CustomerFinancialsTab. No tests exist for them. Murabaha calculation errors can lead to customers being quoted incorrect financing terms — this is a regulatory issue in Islamic finance jurisdictions. DBR (Debt Burden Ratio) errors can lead to incorrect credit decisions. You need unit tests covering edge cases: zero principal, 100% DBR, minimum/maximum tenor ranges, and correct profit rate application.

HIGH convex/users.ts → deleteUser — data deletion with no audit trail

deleteUser exists. remove exists on customers, vehicles, leads, and sales. In a financial SaaS, hard deletion of records is typically a compliance violation. Automotive dealerships are required to maintain sales records in most jurisdictions. You need a soft-delete pattern: add an isDeleted flag to your schema and filter it in list queries, rather than permanently destroying records. The existing remove functions should be converted or removed from the public API.

// In your schema, add to every table that has remove():
isDeleted: v.optional(v.boolean()),
deletedAt: v.optional(v.number()),
deletedBy: v.optional(v.id("users")),
HIGH No CSRF protection or input sanitization visible

There are zero sanitize/escape/XSS-related nodes in the graph. Convex handles most injection risks at the transport layer, but your PDF generation (generateBillOfSale, generateQuote) takes customer names, vehicle details, and financial figures as strings. If a customer name contains <script> tags or special PDF characters, you could get rendering corruption or worse. Sanitize all user-provided strings before they enter PDF generation. Also verify that jspdf escapes HTML entities — it does not by default.

HIGH convex/migrations.ts functions are publicly accessible

backfillPermissions and grantTaskPermissionsToAll are in convex/migrations.ts. fixExistingRoles is in convex/migrateRoles.ts. These are one-time migration functions that should not be callable from a production client. If they are exposed as mutations rather than internal functions, any authenticated user with access to the Convex dashboard or a raw API call could trigger them and corrupt the permission state of every org. Mark them as internalMutation and invoke them only from a trusted admin context.

MED Zod validation is on the frontend only — Convex args need validators too

You use zod with react-hook-form for form validation, which is client-side only. Convex has its own v.* validator system for function arguments. Every mutation and query must have explicit args: { ... } validators — not just args: {} — so that Convex rejects malformed inputs at the API boundary. Without this, crafted payloads that bypass the React form can reach your database.

Phase 3 — Performance & Scalability
Before you have more than one active dealership

3–4 days
HIGH useOrg() and useLanguage() — 166 subscriptions per page load

These two hooks are called by every page and every dialog simultaneously. If 10 dialogs are open and the org data changes, Convex re-renders all 10. If the language changes, all 10 re-render again. These hooks trigger reactive subscriptions — meaning every component that calls them is a live subscriber. With 15 pages and ~20 dialogs all subscribed to the same providers, you're burning Convex subscription budget unnecessarily. Wrap both in React Context at the layout level and distribute via context — components should consume context, not call the hook independently. This is the single biggest performance optimization available to you without changing the backend.

// hooks/useAppContext.ts — compose both into one subscription point
export function AppProvider({ children }) {
  const org = useQuery(api.organizations.get, ...)
  const { locale, t } = useLanguage()
  return (
    <AppContext.Provider value={{ org, locale, t }}>
      {children}
    </AppContext.Provider>
  )
}
// Then every component: const { org, t } = useAppContext() — no extra subscriptions
HIGH VehicleDetailsDialog is the heaviest component in the graph (41 edges)

VehicleDetailsDialog.tsx has 41 graph edges — it's the most connected component after the providers and UI primitives. This tells me it imports from many places, likely renders a large amount of data, and is probably making multiple Convex queries. Dialogs that make multiple queries are a common source of subscription bloat. Audit this file: use parallel queries where possible, consider lazy loading the tabs (history, valuations) only when the tab is selected, and make sure images are lazy-loaded since vehicles have image galleries.

HIGH Reports page — defaultEndDate and defaultStartDate are isolated nodes

The reports page has 34 edges but its date range variables are disconnected nodes. This pattern strongly suggests that date filtering is done client-side by filtering a full dataset returned from the server — meaning for sales and profit reports, you're pulling all records and filtering in JavaScript. With a dealership that has 3 years of data, this will be extremely slow. All reports with date ranges must filter at the database layer: pass startDate and endDate as query args and use Convex index ranges.

MED 118 communities for ~90 app source files — no shared feature abstractions

Leiden found 118 clusters because each feature domain is an island. There are no shared hooks like useVehicleActions(), useCustomerActions(), or useSaleWorkflow(). This means when a permission changes, or a Convex query signature changes, you're updating it in 15 places instead of one. This is a scalability problem for the codebase, not the runtime — but it will slow down every future feature addition significantly. Start building feature-level hooks as you touch each area.

MED framer-motion is installed but usage is unverified

Framer Motion is in your dependencies but has no connection edges in the graph beyond the package listing — no component imports it. This is either dead weight (35kB gzipped you're shipping for no reason) or it's used in a way Graphify couldn't detect. Verify: if it's unused, remove it. If it's used in the Sidebar component, that's fine — but audit the bundle. Run npx next build --analyze and look at what's in your First Load JS. For a dashboard SaaS, First Load JS above 200kB is a problem for slower connections.

MED Vehicle image handling — no CDN, no compression pipeline

vehicles.generateUploadUrl and vehicles.deleteImage exist, meaning vehicle images are being stored in Convex file storage. Convex file storage is not a CDN. Serving large vehicle photos (typically 2–5MB per image) directly from Convex will be slow for users and expensive in Convex bandwidth costs. Configure Cloudflare Images, Vercel Image Optimization, or a pre-upload client-side compression step before the image reaches Convex. At minimum, validate max file size in generateUploadUrl.

Phase 4 — Observability & Ops
So you know when things break before users tell you

2–3 days
HIGH Zero monitoring — you are flying completely blind

There is no Sentry, no PostHog, no Datadog, no LogRocket, no uptime monitoring — nothing. Convex gives you a dashboard but it doesn't alert you. If a Convex function starts throwing for one org, if PDF generation breaks, if email delivery fails, if a mutation takes 30 seconds — you will find out when a customer complains. Add Sentry to both the Next.js frontend and as a Convex action error wrapper. Set up uptime monitoring (Better Uptime or Betterstack — free tier is fine). Configure Convex's webhook to push function exceptions to a Slack channel. This is 4 hours of work and will save you days of debugging blind.

# Install:
pnpm add @sentry/nextjs

# Wrap Convex mutations:
export const create = mutation({
  handler: async (ctx, args) => {
    try { ... }
    catch (e) { Sentry.captureException(e); throw e; }
  }
})
HIGH No environment variable validation at startup

The graph shows environment variable references in the Clerk and Convex skill docs but no runtime validation. If RESEND_API_KEY is missing, email silently fails. If NEXT_PUBLIC_CONVEX_URL is wrong, the app loads a blank screen. Create a lib/env.ts file that validates all required env vars at startup using zod (you already have it) and throws a clear error message in development if any are missing. This prevents "works on my machine" deployment failures.

// lib/env.ts
import { z } from "zod"
const envSchema = z.object({
  NEXT_PUBLIC_CONVEX_URL: z.string().url(),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
  RESEND_API_KEY: z.string().min(1),
  // ... all required env vars
})
export const env = envSchema.parse(process.env)
MED No deployment pipeline or staging environment

There is no CI/CD configuration tracked in the graph — no GitHub Actions, no Vercel config, no environment separation. You need at minimum: a staging Convex deployment (Convex supports multiple deployments per project) connected to a Vercel preview environment, and a production deployment that only updates on merge to main. Right now if you push a breaking change, it goes straight to every user. A staging environment is not optional for a financial SaaS.

MED Email delivery with no deliverability setup

convex/email.ts uses Resend for sendTaskAlarm and sendTeamInvite. Team invite emails going to spam is a common and devastating UX failure that kills user activation. Verify: custom domain is configured in Resend, SPF/DKIM/DMARC records are set on your sending domain, and you're not sending from a gmail.com or convex.dev address. Test email delivery end-to-end before launch, including checking spam folder.

MED Svix webhooks — verify payload signature validation

svix is installed — this is used for Clerk webhooks (user created, user deleted, org events). convex/http.ts handles the webhook endpoint. Verify that the Svix webhook signature is being validated in http.ts — without signature validation, anyone on the internet can POST to your webhook endpoint and forge user creation/deletion events. The Svix SDK makes this a 3-line check but it must be there.

Phase 5 — Code Quality
Technical debt to pay down in parallel

Ongoing
MED Community 0: form schemas are not co-located with their features (cohesion 0.08)

51 nodes — ExpenseDialogProps, LeadFormValues, QuoteDialogProps, and 43 more — are clustered into a single weak community. This means your Zod schemas and TypeScript prop types are either in a catch-all file or Graphify is pulling them together because they share no clear home. Co-locate: components/expenses/expense.schema.ts, components/leads/lead.schema.ts. This makes it trivially obvious where to find the validation for any feature and eliminates the cross-feature coupling.

MED RTL audit script is a code smell — RTL should be built-in, not audited

rtl-audit.js is a script that walks the codebase looking for RTL issues. The fact that this script exists tells me RTL support was bolted on rather than designed in. For an Arabic-language SaaS, RTL is not an audit item — it's a core requirement. Every new component added without RTL awareness needs the audit again. The fix: adopt a dir="rtl" strategy at the root layout level using Tailwind's RTL plugin (tailwindcss-rtl) so that ms-4/me-4 handle both directions automatically. Then delete the audit script.

MED STAGES in leads page is an isolated, disconnected constant

STAGES in app/(dashboard)/leads/page.tsx is an isolated node — it's not connected to convex/leads.ts → leadStage. This means the pipeline stage labels visible in the UI are hardcoded client-side, while the backend uses its own stage enum. If someone adds a stage to the backend, the UI won't show it. The single source of truth for stage definitions must be the Convex schema. Derive the frontend stage labels from the backend enum, not a separate hardcoded array.

LOW @base-ui/react alongside Radix UI — redundant dependency

You have both @base-ui/react (the new library from the Radix/MUI team) and the full Radix UI primitive set installed. These serve the same purpose. Unless you're actively migrating to Base UI, this is dead weight in your bundle. Identify which is actually being used and remove the other.

LOW No loading.tsx files in any route segment

Next.js App Router supports loading.tsx as a route-level Suspense boundary. You have a Skeleton() component in components/ui/skeleton.tsx but no loading.tsx files anywhere. This means navigating between dashboard routes shows a blank screen while Convex data loads. Add a loading.tsx to each route segment that renders appropriate skeleton placeholders. This alone will make the app feel dramatically more polished.

Launch Gate
Every item below must be checked before a single real user enters

○
Dashboard charts wired to real convex/dashboard.ts → stats query
○
Tenancy isolation tests written and passing for every Convex module
○
calculateUnifiedMurabaha() and calculateDBR() unit tests written
○
usePaginatedQuery implemented on vehicles, customers, sales, leads
○
generateUploadUrl validates file type + size before issuing URL
○
Fix scripts deleted from repo root (5 files)
○
Migration functions marked internalMutation
○
Rate limiting on email, create mutations, and upload URLs
○
Soft-delete implemented — no hard removal of financial records
○
Sentry installed and capturing exceptions
○
Svix webhook signature validation confirmed in convex/http.ts
○
Staging environment deployed and tested
○
env.ts startup validation in place
○
Email deliverability tested end-to-end (check spam)
○
Bundle size analyzed — First Load JS under 200kB
○
Error boundaries added at page and feature section level
○
STAGES synced to backend leadStage enum (single source of truth)
○
Reports date filtering moved to database layer (not JS filter)
The honest timeline

If you are working solo: 3 weeks minimum to reach a state I'd be comfortable calling production-ready for early customers. The architecture decisions you've made — Convex, Clerk, Next.js App Router, Zod, shadcn — are all the right calls for this type of app. The skeleton is solid. What's missing is the layer of hardening that turns a working demo into a trustworthy product. Phase 1 is non-negotiable and takes about 4 days. Phase 2 is the difference between a product and a liability. Phases 3–5 can be iterative. Do not skip Phase 1. Do not show this to paying customers before Phase 1 and Phase 2 are done.