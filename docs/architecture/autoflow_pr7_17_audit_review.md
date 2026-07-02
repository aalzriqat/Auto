# AutoFlow PRs #7–#17 vs. Production Audit

**Repository:** `aalzriqat/Auto`  
**Integrated main commit:** `3734affc404fccf9a043fe800b085f6920afdced`  
**Reviewed scope:** PRs #7–#17, parent integration PR #6, and the resulting integrated `main`

## Executive verdict

The PR program was substantial and addressed many original audit findings correctly.

- **Fixed:** 23 of 37 priority findings
- **Partially fixed:** 13 of 37
- **Unresolved:** 1 of 37

### Release decision

- Controlled UAT: **GO**
- Limited pilot with reconciliation and monitoring: **Conditional GO**
- Unrestricted financial production: **NO-GO**

The remaining production blockers are:

1. Deposit voiding does not reverse its canonical payment or GL posting.
2. Collection refunds/cancellations do not correctly reverse canonical allocations/receivables.
3. Webhook delivery logging does not form a real deduplicated retry state machine.
4. Direct account creation still emails a reusable password.
5. Finance-company canonical receivables and disbursement allocations remain incomplete.
6. The integrated release has no verified green CI run on the exact main SHA, and Vercel reports failure.

## PR-by-PR result

### PR #7 — Dashboard, reports, notifications, subscriptions

**Good, with remaining scale/reporting work.**

Fixed permission-filtered dashboard data, completed-sales filtering, P&L collection double-counting, notification pagination, truncation indicators, and subscription status/date handling.

Remaining: capped scans are not true pagination, historical profit still relies on mutable operational data in some reports, and GL reporting still needs balance projections and functional/reporting-currency support.

### PR #8 — Deposits, sales, payment intents, subledger

**Major improvement; financial follow-up required.**

Fixed draft-versus-completed sale separation, completed-sale immutability, manual finance payloads, sale receivables, deposit canonical payments, allocations, validation, commission-paid posting, and provider-signature helpers.

Remaining: `voidDeposit` creates a legacy OUT transaction and releases the hold without reversing the canonical payment or original GL event. Payment-intent creation also remains client-authoritative for provider IDs and checkout URLs rather than using a complete server-side provider adapter.

### PR #9 — Accounting

**Strong foundation; partial closure.**

Added accounting feature gates, forfeiture posting, broader audit controls and tests. The generic public accounting-post mutation remains too flexible, and financial reporting remains broad/in-memory with incomplete multicurrency treatment.

### PR #10 — Vehicles and reservations

**Good lifecycle protection; financial reservation edges remain.**

Fixed direct status bypass, reservation expiry, real deposit recording, and stored-file metadata validation.

Remaining: reservation expiry/release must explicitly refund, forfeit, transfer or void associated money; it cannot merely remove a hold when a settled deposit exists.

### PR #11 — Memberships, roles, users and deletion

**Strongest PR; two follow-ups remain.**

Fixed owner invariants, immutable owner-role semantics, atomic ownership transfer, permission allowlisting, tokenized expiring invitations, soft-disabled identity deletion, offboarding retries, reviewed batched organization deletion, and customer-merge coverage.

Remaining:
- Direct account creation still creates and emails a reusable password.
- The explicit organization-deletion registry must stay synchronized; new website-abuse tables are not currently included.

### PR #12 — Applications, collections and expenses

**Important fixes; canonical refunds remain incomplete.**

Fixed required-document enforcement, pending-expense handling, posted-expense mutation restrictions and canonical mirroring for collection payments.

Remaining:
- Refunds create an outbound canonical payment but do not reverse original allocations.
- Cancellation/rescheduling updates only legacy receivables.
- Lazy migration of partially paid receivables can miss historical allocations.
- Payment idempotency remains unbound to request content in important paths.
- Finance-company canonical receivable/payment allocation is incomplete.
- Finance application reads and transitions still use inconsistent permissions.

### PR #13 — Social integrations

**Useful improvement; secrets and observability remain.**

Added Instagram refresh, explicit Facebook Page selection, feature gates and tests.

Remaining:
- Provider access tokens are still plaintext application data.
- Refresh failures are logged and returned rather than thrown, while the cron can count the call as refreshed.

### PR #14 — Website builder and dealer site

**Good.**

Added Turnstile, strict validation, multi-dimensional rate limiting, duplicate suppression, blocklists, abuse telemetry, snapshot serving and feature enforcement.

The mock domain registrar is safely disabled by default, but domain purchasing remains incomplete until a real registrar/payment/renewal workflow exists.

### PR #15 — Tasks and miscellaneous backend

**Good; scale work remains.**

Fixed task tenant isolation, history authorization, alarm resets, permission-filtered global search, completed work-order protection, document permissions, metadata checks, feature gates and registrar safety.

Remaining: branch manager validation, resumable branch migration, indexed WhatsApp matching, and bounded task-alarm processing.

### PR #16 — Frontend, imports, i18n and exports

**Good.**

Fixed spreadsheet formula injection and added invitation acceptance and UX improvements. Backend import batching and resumability still need separate hardening.

### PR #17 — CI, webhooks and worker

**Critical follow-up required.**

Added broader CI scripts, dependency auditing, dealer-worker API allowlisting, non-2xx processing failures, and Stripe/Tap verification helpers.

Remaining webhook defect:
- Intake inserts a `received` row.
- Success/error inserts another row rather than completing that delivery.
- The first row remains `received` and can become a false dead letter.
- Duplicate intake finds the existing row but does not stop processing.
- This is logging, not a durable idempotent webhook inbox.

## Audit matrix

### Fixed

C-01, C-02, C-04, C-07, C-08, C-09, H-01, H-02, H-03, H-04, H-05, H-06, H-10, H-11, H-12, H-13, H-14, H-15, H-17, H-19, H-21, H-22, H-25.

### Partially fixed

C-03, C-05, C-06, C-10, C-11, C-12, H-07, H-08, H-09, H-16, H-18, H-20, H-24.

### Unresolved

H-23: application-level encryption and rotation for social-provider tokens.

## Required P0 follow-up

1. Make deposit void a real GL/canonical reversal.
2. Reverse allocations and reopen canonical receivables during refunds/cancellations.
3. Implement one webhook-inbox row per provider event with atomic claim, retries and replay.
4. Replace emailed passwords with one-time setup links.
5. Create and settle finance-company canonical receivables.
6. Require a green exact-release SHA: root/Convex/worker typecheck, tests, E2E, security scans and Vercel deployment.

## Final decision

The PRs move AutoFlow from a broad NO-GO toward a credible controlled pilot. They do not yet justify unrestricted production because the remaining defects affect money reversal, receivable balances, webhook exactly-once behavior, credential handling and release verification.

---

## Remediation record — 2026-07-02

All six P0 blockers were validated against `main` (`a98ae6a`) — **all six confirmed** — and fixed:

1. **Deposit void reversal** (`convex/deposits.ts`, `subledger.ts`, `accounting/workflowHooks.ts`): `voidDeposit` now voids the canonical payment (`voidCanonicalPayment`, refuses while ACTIVE allocations exist), marks the mirror `collectionPayments` row VOIDED, and reverses the `DEPOSIT_RECEIVED` GL posting via `hookDepositVoided` (reverses if posted, cancels the pending outbox post otherwise).
2. **Collection refunds/cancellations** (`convex/collections.ts`, `accounting/postingRules.ts`): approved refunds now reverse ACTIVE allocations newest-first on the canonical receivable (re-allocating any split remainder) so its outstanding reopens by exactly the refunded amount, and post a new `COLLECTION_REFUND` GL event (DR AR / CR Cash). `CANCEL_RECEIVABLE` marks the canonical document CANCELLED; `RESCHEDULE` moves its `dueDate`.
3. **Webhook inbox** (`convex/adminSystem.ts`, `convex/http.ts`): replaced the two-row logging with a real state machine — `webhookInboxIntake` keeps exactly one row per (source, eventId) with an atomic claim and a 5-minute in-flight lease (concurrent duplicates get 409, processed duplicates get 200 without reprocessing, failed/stale deliveries are reclaimed), and `webhookInboxComplete` moves the same row to success/error. Wired into the Clerk, Resend, WhatsApp, Instagram, and Facebook handlers; the >2 h dead-letter scan is now meaningful.
4. **Emailed passwords** (`convex/memberships.ts`, `convex/email.ts`, `app/setup-account/page.tsx`): direct account creation now creates the Clerk user with no password (`skip_password_requirement`), mints a one-time 7-day Clerk sign-in token (deleting the user and rolling back if minting fails), and emails a `/setup-account?ticket=…` link where the user signs in via the ticket strategy and sets their own password.
5. **Finance-company canonical receivables** (`convex/applications.ts`): `finalizeDeal` opens a canonical `FINANCE_COMPANY` receivable for the financed amount; `confirmDisbursement` records a canonical IN payment (idempotent per application) and settles the receivable by allocation; voiding an undisbursed closed deal cancels the receivable.
6. **CI / release verification** (`.github/workflows/*.yml`, `app/accept-invite/page.tsx`): the Tests workflow had never been green — CI Node 20 broke `convex-test` storage hashing (SubtleCrypto realm bug, 23 test failures) and wrangler (requires Node ≥22); `convex codegen` requires a deployment since Convex 1.42; and `next build` failed on `/accept-invite` (missing Suspense around `useSearchParams`), which is also the Vercel deploy failure. Fixed by bumping CI to Node 22, running Convex validation via `CONVEX_AGENT_MODE=anonymous npx convex dev --once`, and adding the Suspense boundary.

Regression coverage added: deposit void unwind (canonical + mirror + GL reversal), refund allocation reversal / cancel / reschedule canonical sync, finance-company receivable open-settle-cancel lifecycle, and the webhook inbox state machine (dedup, in-flight lease, reclaim).
