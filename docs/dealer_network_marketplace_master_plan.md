# AutoFlow Dealer Network — Marketplace Master Plan

**Date:** 2026-07-10 (revised same day after a review round — see A10/A11, Phase 57 consent/cap, Phase 58B)
**Owner:** aalzriqat
**Status:** Phase 56 built on branch (not merged/deployed) · Phases 57–64 planned → sequence into PROJECT_PLAN.md as they start
**Scope:** Turn AutoFlow into a two-sided demand-generation marketplace — buyers submit "I want this car" requests, AutoFlow fans them out to matching dealers, dealers reply and convert into tracked leads with gross-profit attribution. Built as a layer **on top of** the dealer-site infrastructure that already exists, not a rebuild.

> **Non-negotiables (project dev rules, unchanged).** All logic backend-only (Convex). Every mutation/action in `try/catch`, `console.error(raw)`, return `{ success:false, error:"An unexpected error occurred. Please try again later." }`. Optional chaining + fallbacks on all rendered DB data. Zero implicit `any`. Bilingual EN/AR (RTL) for every surface. Soft-delete pattern (`isDeleted/deletedAt/deletedBy`) on every new table. No LLM in Releases 1–3 (matches existing roadmap discipline — AI upgrades route to the deferred backlog, see §5).

---

## 0. Validation gate — before any phase starts (no engineering)

Do not start Phase 56 until this is run: for 2–3 weeks, manually operate the "Request a Car" loop with 5–10 dealers you already know, using a WhatsApp number and a Google Form — no code. Log every request, every dealer response, every conversion by hand.

**Go criterion:** at least a third of requests get a dealer reply within 24h, and at least one produces a sale. **Kill/rethink criterion:** dealers ignore requests, or buyers never materialize even with direct outreach — that's a demand problem no amount of engineering fixes, and it's cheaper to learn that from a spreadsheet than from Phase 56–58.

---

## 0.5. Non-engineering to-do, start now: Meta Business Verification

AutoFlow is currently on Meta's WhatsApp **test** phone number — Business Verification has not been completed. See A5b for the full technical detail. Short version:

- **Doesn't block writing code.** Phase 57/58 can be built and tested end-to-end now; WhatsApp failures degrade gracefully to in-app (and email for 58B) everywhere in this plan.
- **Does block reaching real dealers at scale.** Test mode only messages a small manually-added recipient allowlist (confirm the current cap in the Meta App Dashboard — commonly ~5).
- **Two independent tracks, run in parallel:** (1) start Business Verification with Meta now — it's a paperwork/identity process on their timeline, not engineering; (2) manually allowlist the first handful of founding-dealer numbers in the interim so Phases 57/58 get validated with real people before verification clears.

---

## 1. Architecture decisions that bind the whole epic

| # | Decision | Rationale |
|---|---|---|
| A1 | **The marketplace is a new cross-org layer, not a new tenant type.** New tables are not owned by a single `orgId`; they live outside `app/(dashboard)/[orgId]/`, under a new public `app/marketplace/` route group — same pattern as `app/dealer-site/`. | AutoFlow's entire data model assumes every row belongs to exactly one org ([convex/schema.ts](../convex/schema.ts), `requireTenantAuth`). A buyer request that fans out to N dealers doesn't fit that shape and shouldn't be forced into it. |
| A2 | **Supply side reuses existing dealer-site inventory — it is not duplicated.** A dealer's marketplace visibility is an opt-in flag on top of their existing published website (`websiteDomains`, `websitePublishedSections`, [`websites.ts:854` `resolveDomain`](../convex/websites.ts#L854)/[`websites.ts:843` `preview`](../convex/websites.ts#L843)). No second "marketplace listing" table mirroring `vehicles`. | AutoFlow already has 8+ dealer-site themes (kinetic/prestige/velocity/avant/showcase) with published inventory snapshots. Rebuilding listings would immediately drift from the source of truth. |
| A3 | **Demand side is genuinely new.** `marketplaceRequests` (buyer intent, no owning org) + `marketplaceResponses` (dealer replies) + `marketplaceDealerProfiles` (opt-in + score + badges). | This is the one piece that doesn't already exist anywhere in the codebase. |
| A4 | **The public-lead-submission pattern is the template to generalize, not reinvent.** [`websites.ts:897` `submitPublicLead`](../convex/websites.ts#L897) (action: Turnstile + rate-limit) → [`websites.ts:922` `createPublicLead`](../convex/websites.ts#L922) (internal mutation: resolve org, validate, block-list check, create lead) is a fully-built unauthenticated-write-with-abuse-protection pipeline. The marketplace intake reuses this shape, generalized from "resolve **one** org from a domain" to "resolve **N** matching orgs from criteria." | Don't rebuild Turnstile verification, rate limiting (`enforcePublicLeadRateLimit`), or abuse-event logging (`recordWebsiteLeadAbuseEvent`/blocklist) — call the same utilities. |
| A5 | **Corrected 2026-07-10 — was wrong.** Dealer notification reuses Phase 28's multi-channel *dispatch pattern* (in-app row always created first, email/WhatsApp are additive fire-and-forget scheduled actions that can never block or fail the triggering mutation — [`notifications.ts:29-36,47-57`](../convex/utils/notifications.ts)) but **cannot reuse the existing WhatsApp *send* infra as-is.** `whatsappSend.ts` resolves credentials per-org (`orgSettings.whatsappPhoneNumberId`/`whatsappApiToken`) and sends to that same org's own staff (`users.whatsappPhone`) — it's an internal alert channel, not a platform→external-party channel. Forcing dealers to configure their own Meta Business API credentials just to receive a lead would kill the "just send us your WhatsApp number" GTM promise (§3). **New requirement:** a separate platform-level sender (new module, reads a single `MARKETPLACE_WHATSAPP_PHONE_NUMBER_ID`/`MARKETPLACE_WHATSAPP_API_TOKEN` from `convex/utils/env.ts`, not `orgSettings`) sending to `marketplaceDealerProfiles.whatsappNumber` (a plain phone number, no setup required on the dealer's end). In-app notification (already free, no dependency) remains the always-created fallback per the existing dispatch pattern — WhatsApp is additive, never the sole channel, so this blocker never breaks the feature, only degrades one delivery channel. | Confirmed by direct code read: no marketplace-lead fan-out code exists yet, and the only existing WhatsApp send path is architecturally per-org-to-own-staff, not reusable for cross-org dealer notification without a new platform-level number. |
| A5b | **Blocking dependency, not an engineering task: AutoFlow's own Meta Business Verification + a real (non-test) WhatsApp Business number under AutoFlow's own Meta Business Manager.** Currently on Meta's test number, which cannot message arbitrary phone numbers — only a small manually-added recipient allowlist (commonly ~5; confirm current cap in the Meta App Dashboard). **This does not block writing Phase 57/58 code** — WhatsApp failures degrade gracefully (A5) — it only blocks *real dealer* reach beyond the manually-allowlisted test recipients. **Practical unblock:** manually add the first wave of founding-dealer numbers (§3's target is 30–50, but the very first 5 fit inside the test cap) to the Meta test allowlist now; that's enough to fully validate Phases 57/58 end-to-end with real people before verification completes. Start the Business Verification process in parallel immediately — it's independent of code and typically the longer pole. | User-reported 2026-07-10: "we are still using meta whatsapp test phone number, we haven't gone through the business verification process." Confirmed no test/prod-mode flag exists anywhere in the codebase (`convex/utils/env.ts`) — this is purely a Meta-dashboard/business-process state, not something code can detect or route around automatically. |
| A6 | **Attribution reuses the Social Command Center spine pattern**, not a bespoke scheme. Widen `leads` (currently free-text `source: v.optional(v.string())` at [schema.ts:756](../convex/schema.ts#L756)) with `sourceChannel: "marketplace"` and `marketplaceRequestId?`. Gross-profit rollups reuse [`reports.ts:304-305`](../convex/reports.ts#L304-L305) verbatim. | Same lesson already learned building the Social Command Center plan: retrofitting attribution later costs ~5×. Do it at write time here too. |
| A7 | **Monetization reuses the existing plan-feature gate**, not a new billing concept. [`websites.ts:952` `hasPlanFeature(ctx, orgId, "websiteBuilder")`](../convex/websites.ts#L952) is an existing pattern — add `"marketplace"` / `"marketplaceFeatured"` feature keys to the same gate. | `subscriptions.ts` / `subscriptionGates.ts` already exist and are tested. Don't build a parallel billing system for one feature. |
| A8 | **No LLM in Releases 1–3.** "Turn a WhatsApp voice note into a listing" and "auto-generate car descriptions" are explicitly deferred to the AI backlog (new entry, alongside existing Phases 50–55). Dealer intake in V1 is a guided WhatsApp flow with structured replies, not free-text parsing. **Verified:** this is a build-effort choice, not a Meta-approval blocker — the inbound webhook is already subscribed/approved (`convex/http.ts` `/whatsapp-webhook`), and free-form *session replies* within the 24h customer-service window need no new template approval (only new business-initiated templates would). What's actually missing is code: `whatsappSend.ts` only sends pre-approved templates today, and no conversational state machine exists anywhere in the codebase. | Matches the project's standing no-LLM-budget rule (`project_autoflow_plan`). Rule-based V1 now; LLM upgrade slots in later behind the same interface, per the Social Command Center's A5 precedent. |
| A9 | **New permission group**, not reuse of `requireTenantAuth` alone. A dealer must only ever see requests fanned out to them and their own responses — never the full request pool or other dealers' offers. Added `marketplace:respond`, `marketplace:settings`, `marketplace:analytics` to [`convex/utils/permissions.ts`](../convex/utils/permissions.ts): all three → OWNER (implicit, all permissions) + MANAGER; `respond` only → SALES. | Mirrors the existing split exactly — MANAGER gets the full `WEBSITE_*`/`VIEW_REPORTS`-equivalent set, SALES gets only the day-to-day action (`CREATE_LEADS`-equivalent), not settings/analytics. Confirmed against the live `DEFAULT_ROLE_TEMPLATES` in Phase 56. |
| A10 | **Buyer consent + capped fan-out are required, not optional.** Every `marketplaceRequests` submission must show explicit consent copy before sharing the buyer's phone with dealers, and matching caps out at `MAX_MATCHED_DEALERS` (5) per request. | Original Phase 57 spec didn't state a cap or consent copy — sharing a buyer's phone number with an unbounded number of third parties with no disclosure is a real privacy/trust problem, not a nice-to-have. Caught in review 2026-07-10. Precedent for the copy pattern already exists: `app/dealer-site/[[...slug]]/page.tsx`'s `contactDisclaimer` string, generalized here to the multi-dealer case. |
| A11 | **Internal ops tooling extends the existing `/admin` super-admin console — it does not get a new one.** `convex/adminData.ts`'s `ADMIN_TABLES` allowlist is a generic cross-org browse/edit surface keyed on `{table, index: "by_org"}`; add `marketplaceDealerProfiles` now, and `marketplaceResponses` when Phase 58 ships (both are `by_org`-indexed). `marketplaceRequests` has no `orgId` (per A1/A3) so it needs one small new admin-only query that lists/filters without an org index, plus 1–2 admin-only mutations for "assign to dealer" / "mark spam" once Phase 57 exists. | A from-scratch "AutoFlow Marketplace Console" was proposed in review; ~80% of it already exists (`app/admin/`, `convex/admin*.ts`, per CLAUDE.md). Confirmed by reading `adminData.ts` directly — the allowlist pattern is genuinely generic, not per-table bespoke code. |

---

## 2. How this reconciles with the existing roadmap

Don't let this collide with what's already planned:

- **Phase 34 (Vehicle Acquisition Workflow)** — dealer-*initiated* sourcing via Purchase Orders (private seller, auction, trade-in, fleet). This epic's "trade-in request" (Release 3) is buyer-*initiated* — a buyer asks dealers to make an offer on their current car. It's a different direction of the same relationship. **Design choice:** an accepted trade-in marketplace offer creates a draft Phase 34 Purchase Order rather than a parallel table — one acquisition pipeline, two intake channels.
- **Phase 35 (MENA Marketplace Syndication)** — outbound: push AutoFlow inventory *to* Dubizzle/OpenSooq/Haraj/YallaMotor. This epic is inbound: AutoFlow *becomes* the marketplace buyers search first. They're complementary, not competing — a dealer can run both. No schema overlap (Phase 35 extends `socialPosts`; this epic adds new tables per A3).
- **Social Command Center (Phases 43–49b)** — the attribution-spine pattern (A1/A6 there) is reused directly here (A6). If both epics ship, `leads.sourceChannel` gets one more valid value (`"marketplace"`) alongside `instagram|facebook|whatsapp|website`.
- **Phase numbering** — Social Command Center reserves 43–49b, AI backlog reserves 50–55 (both already written into `PROJECT_PLAN.md` / staged docs). This epic takes **56–64**, next free block.

---

## 3. Go-to-market (runs in parallel with engineering, not after it)

This is a demand-and-supply cold-start problem, not just a build. The plan fails if GTM is treated as an afterthought once Phase 58 ships.

- **Don't pitch software.** Pitch buyers: *"إحنا بنعملك صفحة مجانية للمعرض، وبنوصلك بطلبات زباين بدوروا على سيارات."* Never lead with "use our system."
- **Launch one area at a time** (e.g. وادي صقرة first), not all of Jordan. Ten dealers in one area creates local pressure on the eleventh ("أغلب المعارض حواليك ظهروا على AutoFlow") — ten dealers spread across the country creates none.
- **Founding Dealer package** (first 30–50 dealers): free marketplace opt-in, free leads for a fixed window (e.g. 60 days), `FOUNDING_DEALER` badge, priority placement while the badge is active. Time-box it explicitly — "free forever" isn't a plan, it's a cost center with no conversion trigger.
- **Dealer onboarding must be WhatsApp-only at first**, not a dashboard signup. A staff member (or the dealer's existing WhatsApp) sends business name, location, phone, 5–10 car photos; AutoFlow staff (not the dealer) creates the profile and first listings. "خلص، صفحتك جاهزة" beats "please register and fill in these fields." **This needs no new engineering** — staff creates the dealer's org and adds vehicles through the existing Add Vehicle flow using whatever the dealer sent over WhatsApp. The one small gap: opting the dealer into the marketplace without impersonating them requires `marketplaceDealerProfiles` in the `/admin` allowlist (A11) — a one-line follow-up to Phase 56, not a phase of its own.
- **Buyer acquisition is the harder cold-start side** — the pasted plan under-weights this. Don't assume dealer supply alone creates buyer demand; budget for it explicitly (paid social, WhatsApp groups, referral loop from each fulfilled request) starting alongside Release 1, not after.

---

## 4. Release plan

### Release 1 — Marketplace foundation (Phases 56–58)

#### Phase 56 — Dealer opt-in + marketplace directory ✅ built on branch

**Branch:** `feature/phase-56-marketplace-directory` (committed 2026-07-10, not merged/deployed)
**Goal:** An org can opt into the marketplace and appear in a public, cross-org dealer directory — reusing its existing published dealer-site inventory.

**Follow-up (small, not yet done):** add `marketplaceDealerProfiles` (index `by_org`) to `ADMIN_TABLES` in [`convex/adminData.ts`](../convex/adminData.ts) per A11 — unblocks staff opting a dealer in without impersonation, needed for the WhatsApp-relay onboarding flow in §3.

**Schema:**
- `marketplaceDealerProfiles`: `orgId`, `isOptedIn`, `areas: string[]` (cities served), `brandsCarried: string[]`, `whatsappNumber`, `badges: string[]` (`VERIFIED_PHONE|VERIFIED_LOCATION|FAST_RESPONSE|FINANCE_AVAILABLE|FOUNDING_DEALER`), `responseScore` (`avgResponseMinutes?`, `totalResponses`, `totalAccepted`), `tier: FREE_FOUNDING|LEAD_PACKAGE|FEATURED`, `leadQuota?`, `leadsUsedThisPeriod`, soft-delete. Index `by_org`, `by_opted_in`.

**Backend:**
- `marketplaceDealers.ts` — `optIn`/`optOut`/`updateProfile` (`requireTenantAuth` + `marketplace:settings`), `listPublicDirectory` (public query: opted-in dealers + their existing published site data via `websiteDomains`/`resolveDomain`, no new listings table per A2).
- `permissions.ts` — add `marketplace:respond`, `marketplace:settings`, `marketplace:analytics`.

**Frontend:** `app/(dashboard)/[orgId]/settings/marketplace/page.tsx` (opt-in toggle, areas, brands, WhatsApp number). `app/marketplace/dealers/page.tsx` (public directory, EN/AR).
**Tests:** opt-in gating, permission checks, directory only shows opted-in + active orgs.
**Acceptance:** a dealer opts in and appears in `/marketplace/dealers` within one query, showing their real published inventory count.

#### Phase 57 — Request a Car: capture + fan-out

**Branch:** `feature/phase-57-request-a-car`
**Goal:** Buyer submits a car request; it fans out to matching opted-in dealers via in-app notification always, WhatsApp once A5b's test-allowlist/verification allows reaching that dealer's number.

**Schema:**
- `marketplaceRequests`: no `orgId` (per A1/A3). `createdAt`, `status: OPEN|MATCHED|FULFILLED|EXPIRED|SPAM`, `buyerFirstName`, `buyerPhone`, `buyerWhatsApp?`, `buyerCity`, `make?`, `model?`, `yearMin?`, `yearMax?`, `priceMin?`, `priceMax?`, `paymentType: CASH|FINANCE|EITHER`, `monthlyBudget?`, `buyerTimeframe: ASAP|THIS_WEEK|THIS_MONTH|JUST_LOOKING`, `buyerIntent: COLD|WARM|HOT` (computed at submission, see below), `consentAcceptedAt: v.number()`, `matchedOrgIds: Id<"organizations">[]` (capped, see below), `clientFingerprint`, `clientIpHash`, `expiresAt`. Index `by_status`, `by_city`.

**Backend:**
- `marketplaceRequests.ts` — `submitRequest` (public action: Turnstile + `enforcePublicLeadRateLimit` reused from `websites.ts` per A4; **rejects if `consentAcceptedAt` wasn't set from an explicit checkbox** per A10) → `createRequest` (internal mutation: rule-based match on `areas`/`brandsCarried` from `marketplaceDealerProfiles`, no ML per A8, stamps up to `MAX_MATCHED_DEALERS = 5` `matchedOrgIds` — ranked by `marketplaceDealerProfiles.responseScore` once Phase 60 ships, by opt-in recency until then; A10).
- `buyerIntent` computed at submission: `HOT` if `buyerTimeframe` is `ASAP`/`THIS_WEEK` **and** `paymentType`/budget fields are filled in; `WARM` if budget or timeframe is given but not both; `COLD` otherwise. Rule-based, not inferred — shown to dealers in the notification text (e.g. "طلب مؤكد — الزبون ناوي يشتري خلال أسبوع") so a stronger signal reads as a stronger lead.
- On match: fan-out via `utils/notifications.ts` (new `MARKETPLACE_REQUEST_MATCHED` type, in-app row always created per A5) + a new `marketplaceWhatsAppSend.ts` platform-level sender (per A5/A5b — new module, own `MARKETPLACE_WHATSAPP_*` env credentials, **not** `whatsappSend.ts`'s per-org path) to each matched dealer's `marketplaceDealerProfiles.whatsappNumber`. WhatsApp leg failures (test-allowlist rejection, pre-verification) are caught and logged exactly like the existing `whatsappSend.ts` pattern — never block the request or the in-app notification.
- Cron: expire stale `OPEN` requests after N days.
- Admin: new `adminMarketplace.ts` query (`requireSuperAdmin`) listing `marketplaceRequests` by status — `marketplaceRequests` has no `orgId` so it can't go through the standard `by_org` `ADMIN_TABLES` allowlist path (A11); this is the one genuinely new admin surface this phase needs. Manual "assign to dealer" / "mark spam" mutations ride along here.

**Frontend:** `app/marketplace/request/page.tsx` — public request form, EN/AR, Turnstile-gated, **required consent checkbox** with copy: *"بإرسالك الطلب، أنت توافق أن AutoFlow يشارك معلومات طلبك ورقمك مع معارض سيارات مناسبة للتواصل معك."* (EN equivalent for the English locale).
**Tests:** matching logic (area + brand overlap), fan-out fires to correct orgs only and never exceeds `MAX_MATCHED_DEALERS`, submission rejected without consent, `buyerIntent` computation, rate limiting, expiry cron.
**Acceptance:** a public request from a buyer in Amman for a brand two opted-in Amman dealers carry produces exactly two WhatsApp notifications and zero to non-matching dealers; submitting without checking consent is rejected client- and server-side.

#### Phase 58 — Dealer response + lead attribution

**Branch:** `feature/phase-58-marketplace-response`
**Goal:** Dealer replies to a request from inside AutoFlow's dashboard inbox (the reliable path per A5/A5b) — with a WhatsApp deep link as a bonus shortcut once that dealer's number is reachable, not the only path; reply becomes an attributed lead in their existing pipeline.

**Schema:**
- `marketplaceResponses`: `requestId`, `orgId`, `respondingUserId`, `kind: HAVE_MATCH|HAVE_SIMILAR|CAN_SOURCE|NOT_AVAILABLE`, `vehicleId?` (FK into existing `vehicles`), `offerPriceJod?`, `note?`, `createdAt`. Index `by_request`, `by_org`.
- Widen `leads`: `sourceChannel?` (add `"marketplace"` to the value set shared with Social Command Center's spine), `marketplaceRequestId?: v.id("marketplaceRequests")`.

**Backend:**
- `marketplaceResponses.ts` — `respond` (`requireTenantAuth` + `marketplace:respond`; creates/updates a `leads` row stamped with `sourceChannel`/`marketplaceRequestId`, updates `marketplaceDealerProfiles.responseScore`).
- `marketplaceRequests.ts` — `getStatusForBuyer` (public query by request id + phone, no login, so the buyer can check replies).

**Frontend:** `app/(dashboard)/[orgId]/marketplace/requests/page.tsx` — dealer's inbox of requests routed to them, reply action. `app/marketplace/status/[id]/page.tsx` — public buyer status page.
**Tests:** response creates exactly one lead with correct attribution; response-score math; a dealer cannot see requests not routed to them (A9).
**Acceptance:** dealer opens their AutoFlow dashboard inbox (with or without the WhatsApp ping arriving) and taps "I have this car" on a request → a lead appears in their existing Leads table tagged `marketplace`, with zero manual data entry. Where WhatsApp did reach them, the deep link lands on the same reply action.

#### Phase 58B — Weekly dealer proof report

**Branch:** `feature/phase-58b-marketplace-weekly-report`
**Goal:** Give founding dealers a reason to keep paying attention — proof, not promises, every week on WhatsApp.

**Backend:** `marketplaceReports.ts` — weekly cron per opted-in dealer aggregating: dealer-site page views (reuses the existing site-visitor-analytics event log), vehicle detail views, requests matched, responses sent, avg response time, most-viewed vehicle, requests lost to non-response (`matchedOrgIds` included but no `marketplaceResponses` row before `expiresAt`). Sends via the new platform-level `marketplaceWhatsAppSend.ts` (A5/A5b, not `whatsappSend.ts`) — needs one new approved message **template** (a weekly-summary business-initiated message; unlike Phase 57's dealer-alert flow this **is** outside a 24h reply window, so it needs template approval on top of A5b's number/verification, same category as the existing `autoflow_notification` templates per A8's finding). **Until A5b clears:** falls back to email (already an existing notification channel per Phase 28) so founding dealers still get the proof weekly regardless of WhatsApp status.
**Frontend:** none required for V1.
**Tests:** aggregation correctness against seeded events/requests/responses; report skipped for dealers with zero activity that week (don't spam an empty report); email fallback fires when WhatsApp send fails/is unavailable.
**Acceptance:** an opted-in dealer with at least one request that week receives a summary (WhatsApp once reachable, email otherwise) within a fixed window after the weekly cron fires.

**End of Release 1:** the full concierge loop from Section 0 now runs without human intervention — request in, fan-out, dealer reply, attributed lead out — and dealers get weekly proof it's working.

---

### Release 2 — Public marketplace + trust (Phases 59–61)

#### Phase 59 — Public marketplace browse/search

**Branch:** `feature/phase-59-marketplace-browse`
**Goal:** Buyers can browse cross-org inventory, not only submit blind requests.

**Backend:** `marketplaceBrowse.ts` — `search` (public query: unions each opted-in org's *existing* `activePublishedSnapshot` inventory per A2, filtered by make/model/price/city/payment type; no new listings table). Pagination via cursor, not full scan.
**Frontend:** `app/marketplace/cars/page.tsx` — filters (brand, price, monthly payment, city, finance available), links out to the dealer's existing dealer-site vehicle page.
**Tests:** union-query correctness against multiple orgs' snapshots; filter correctness; excludes non-opted-in orgs.
**Acceptance:** a buyer filters by city + budget and sees real vehicles from ≥2 different dealers on one page.

#### Phase 60 — Verified badges + response ranking

**Branch:** `feature/phase-60-marketplace-badges`
**Goal:** Rank/label dealers so buyers (and the matching algorithm) trust the network.

**Backend:** `marketplaceDealers.ts` — badge computation job (`VERIFIED_PHONE` on confirmed WhatsApp OTP, `FAST_RESPONSE` on rolling `avgResponseMinutes` threshold, `FINANCE_AVAILABLE` from org's existing finance-company settings). Ranking feeds both directory sort order and Phase 57's matching priority.
**Frontend:** badge display on directory + browse pages.
**Tests:** badge computation thresholds; ranking stability.
**Acceptance:** two otherwise-equal dealers rank by response score, not registration order.

**Considered and deferred: exclusivity/speed mechanic** ("first 3 dealers to respond win exclusivity" / "30-minute priority window for top-ranked dealers"). Rejected for V1 — with 5–10 founding dealers per area, most requests will only reach 1–2 relevant dealers at all, so the mechanic has nothing to create pressure against; it also adds real complexity (claim races between concurrent responses, expiry-window state, what the buyer sees if a window lapses unclaimed). Revisit once a launched area has enough concurrent opted-in dealers per brand/city for "first N respond" to be a meaningful constraint, not a formality.

#### Phase 61 — Trust passport (v1: manual/self-reported)

**Branch:** `feature/phase-61-trust-passport`
**Goal:** Add inspection/history disclosure fields to vehicles shown in the marketplace — self-reported first, partner-API-backed later.

**Schema:** widen `vehicles` (already has VIN checksum from Phase 20): `inspectionStatus?: NONE|SELF_REPORTED|PARTNER_VERIFIED`, `accidentDisclosed?: boolean`, `ownerCount?`, `dealerGuarantee?: boolean`. All optional, widen-only.
**Frontend:** "Trust info" panel on marketplace vehicle cards.
**Tests:** optional-field rendering with fallbacks (per core dev rule: `?.` + `||` defaults).
**Acceptance:** a vehicle with disclosed fields visibly differs from one without, no crash on missing data.
**Explicitly out of scope for v1:** any paid third-party report integration (Carseer or similar) — that's a partnership + cost decision, not an engineering task; revisit after Release 2 proves demand.

**End of Release 2:** AutoFlow is a real, browsable, ranked marketplace — not just a request inbox.

---

### Release 3 — Monetization + depth (Phases 62–64)

#### Phase 62 — Finance-first search + trade-in requests

**Branch:** `feature/phase-62-marketplace-finance-tradein`
**Goal:** Let buyers search/request by monthly payment, and request trade-in offers.

**Backend:** reuse `lib/financing.ts` to compute estimated monthly payment on every marketplace vehicle card (same calculator already used in the sales wizard). `marketplaceTradeInRequests` table (buyer's current car details) → dealer offers → accepted offer creates a draft Phase 34 Purchase Order (per §2 reconciliation), not a parallel acquisition flow.
**Tests:** financing estimate matches existing `lib/financing.test.ts` cases; trade-in → PO handoff.
**Acceptance:** buyer searches by "≤300 JD/month" and sees correctly estimated cars; accepted trade-in offer shows up in the dealer's Phase 34 acquisition list.

#### Phase 63 — Monetization: lead packages + featured placement

**Branch:** `feature/phase-63-marketplace-monetization`
**Goal:** Convert opted-in dealers off the Founding tier once value is proven.

**Backend:** extend `hasPlanFeature`/`subscriptions.ts` gate (per A7) with `marketplace` (free directory) vs `marketplaceLeadPackage` (paid quota, enforced via `leadQuota`/`leadsUsedThisPeriod` on `marketplaceDealerProfiles`) vs `marketplaceFeatured` (paid ranking boost).
**Frontend:** upgrade prompts in the dealer's marketplace settings once Founding window expires or lead quota is hit.
**Tests:** quota enforcement blocks further response creation once exhausted; featured boost affects Phase 60 ranking.
**Acceptance:** a Founding dealer past their window sees a clear upgrade path instead of a silent feature cutoff.

#### Phase 64 — WhatsApp-native dealer intake (structured, no LLM)

**Branch:** `feature/phase-64-marketplace-whatsapp-intake`
**Goal:** Let a dealer publish a car by replying to a guided WhatsApp flow (photos + structured prompts), not a web form — lowest-friction inventory intake.
**Backend:** WhatsApp webhook-driven guided flow (reuses existing `convex/whatsapp.ts` inbound handling) collecting make/model/year/price/mileage/photos via sequential prompts → creates a draft `vehicles` row for dealer confirmation in the existing dashboard. **No free-text/voice parsing (A8)** — structured button/reply flow only.
**Tests:** flow state machine; draft vehicle requires dealer confirmation before publish (no auto-publish from an inbound message).
**Acceptance:** a dealer lists a car entirely from WhatsApp in under 2 minutes, with a review step before it goes live.

**End of Release 3:** the marketplace is monetized, finance-aware, and has the lowest-friction dealer intake path available — closing the loop back to the GTM promise in §3 ("send us photos on WhatsApp, we publish it").

---

## 5. Explicitly deferred (AI backlog)

Add to the existing Phases 50–55 AI backlog table, not built here:

| Phase | Feature | Depends On |
|---|---|---|
| 56(AI) | WhatsApp voice-note/photo → structured listing (LLM) | Phase 64's structured flow, as the fallback path when parsing fails |
| 57(AI) | Buyer request → smart dealer match ranking (beyond rule-based area/brand) | Phase 60 response-score data, Phase 57 volume |
| 58(AI) | AI-drafted dealer reply suggestions for marketplace requests | Same infra as existing Phase 50 (social reply suggestions) |

---

## 6. Phase roadmap summary

| Phase | Feature | Release | Status |
|---|---|---|---|
| 56 | Dealer opt-in + marketplace directory | 1 — Foundation | 🟨 Built + tested on branch; not merged/deployed |
| 57 | Request a Car: capture + fan-out (+ consent/cap/intent-tier) | 1 — Foundation | ⬜ Not started |
| 58 | Dealer response + lead attribution | 1 — Foundation | ⬜ Not started |
| 58B | Weekly dealer proof report | 1 — Foundation | ⬜ Not started |
| 59 | Public marketplace browse/search | 2 — Public + Trust | ⬜ Not started |
| 60 | Verified badges + response ranking | 2 — Public + Trust | ⬜ Not started |
| 61 | Trust passport (v1, self-reported) | 2 — Public + Trust | ⬜ Not started |
| 62 | Finance-first search + trade-in requests | 3 — Monetization | ⬜ Not started |
| 63 | Monetization: lead packages + featured | 3 — Monetization | ⬜ Not started |
| 64 | WhatsApp-native dealer intake | 3 — Monetization | ⬜ Not started |

**Critical path:** Section 0 (manual validation, waived 2026-07-10 — risk accepted) → 56 (done on branch) → 57 → 58 → 58B (this replicates and then proves the manual concierge loop in-product) → GTM ramp starts here in parallel with → 59 → 60 → 61 → 62/63/64.
