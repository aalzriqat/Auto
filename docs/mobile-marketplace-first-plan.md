# AutoFlow Mobile — Marketplace-First Architecture Plan

**Status:** Proposed (awaiting approval) · **Date:** 2026-07-19 · **Author:** design review + eng grounding

## 1. Goal & principle

Invert the mobile app so the **public buyer marketplace is the product** and the **dealer workspace is a protected secondary mode**. One app, two clearly separated experiences, shared brand/data/infra.

- Buyers browse freely; auth is requested only when it genuinely adds value (Apple's browse-first guidance; friction proportional to value).
- Business logic: buyer demand is the flywheel that attracts dealers.

Buyer promise: *"the easiest place to find a car — or ask the market to find one for me."*
Dealer promise: *"the system where I manage my dealership and respond to real buyer demand."*

## 2. Current state (grounded)

| Area | Today | Implication |
|---|---|---|
| Root route `/` | `(app)/index.tsx` → `HomeScreen` = dealer-first landing ("Run AutoFlow from your phone", Sign In primary, Browse secondary) | Must be replaced by the buyer marketplace |
| Marketplace | `/marketplace` → `MarketplaceScreen`, **no Clerk check**; 5 tabs are in-component `BuyerTab` state ("cars"\|"request"\|"tradein"\|"dealers"\|"offers"), not routes | Already public ✅; tabs trivial to restructure |
| Buyer identity | **Anonymous, outside Clerk** — on-device `publicId` + `marketplaceFingerprint`; requests/offers/Request Rooms keyed by `publicId`+phone; `marketplaceBuyerPushTokens` keyed by publicId | Level 1 + most of Level 2 already built ✅ |
| Buyer verification | Cloudflare **Turnstile** (bot check) in `BuyerIntakePanels` — NOT SMS OTP | "Text me a code" is the one new auth primitive |
| Dealer auth | Clerk custom form: email/username + **password** + **Google OAuth** (`app/(auth)/sign-in.tsx`) | No phone auth; Google ⇒ iOS needs Apple |
| Dealer workspace | `(app)/org/[orgId]/(tabs)/` = Today·Inventory(operations)·Sales(pipeline)·Inbox(finance)·More(admin) via `WorkspaceTabsLayout` | Reused verbatim, moved behind dealer gate |
| Tenancy | Every dealer query/mutation enforces `requireTenantAuth`/membership server-side | "Backend must enforce, not just gate routes" **already satisfied** ✅ |
| Identity model | `User` + `memberships[]` (NOT `role = BUYER\|DEALER`) | "A person can be both" **already true** ✅ |
| Convex marketplace | `marketplaceBrowse`, `marketplaceBuyerActions`, `marketplaceBuyerPush`, `marketplaceAffordability`, `adminMarketplace` | Browse/request/offer backend exists |

**Net:** Phases 1–2 are mostly frontend/routing. The only substantial *new* backend is Phase 3 (full buyer accounts + SMS OTP + saved-sync + guest→account merge).

## 3. Target Expo Router structure

```
app/
├── _layout.tsx                      # AppProviders + root Stack (unchanged)
├── (marketplace)/                   # PUBLIC — no Clerk requirement
│   ├── _layout.tsx                  # buyer Tabs: Browse · Request · Saved · Account
│   ├── index.tsx                    # Browse (DEFAULT LANDING at "/")
│   ├── request.tsx                  # Request hub (segmented: New request | My requests)
│   ├── saved.tsx                    # Saved (local-first)
│   ├── account.tsx                  # Buyer account + "Dealer sign in" entry
│   ├── vehicle/[vehicleId].tsx      # Native vehicle detail (conversion screen)
│   ├── dealer/[dealerId].tsx        # Dealer profile
│   └── requests/[publicId].tsx      # Request Room
├── (auth)/
│   ├── _layout.tsx
│   ├── buyer-sign-in.tsx            # phone OTP-led (+ optional Apple/Google)
│   └── dealer-sign-in.tsx          # existing email/password + Google (+ Apple)
└── (dealer)/                        # PROTECTED — Clerk + membership gate
    ├── _layout.tsx                  # gate: auth ✔ + convex session ✔ + membership ✔
    ├── workspaces.tsx              # workspace picker (was HomeScreen list)
    └── org/[orgId]/(tabs)/          # existing 5-tab dealer OS (unchanged)
        ├── home.tsx  operations.tsx  pipeline.tsx  finance.tsx  admin.tsx
```

`nativeRoutes` (in `packages/shared/src/routes.ts`) changes: `home: "/"` now = Browse; add `buyerRequest`, `saved`, `account`, `buyerSignIn`, `dealerSignIn`, `dealerWorkspaces`; `orgHome` etc. unchanged. Audit every `router.replace(nativeRoutes.home)` (e.g. dashboard back button) → dealer "back" must target `dealerWorkspaces`, not the buyer root.

## 4. Phase 1 — Invert the app (frontend, 1 PR)

**Outcome:** opening AutoFlow lands on the buyer marketplace; dealer access is a deliberate, secondary path. No new backend.

1. Create `(marketplace)/_layout.tsx` with a 4-tab buyer bar (Browse·Request·Saved·Account) mirroring `WorkspaceTabsLayout`'s pattern but consumer-styled.
2. Move `HomeScreen`'s dealer landing → `(dealer)/workspaces.tsx`. Delete the "Run AutoFlow from your phone" hero; the buyer Browse screen is the new first screen.
3. `(marketplace)/index.tsx` = Browse (Phase 2 fills content; Phase 1 can reuse `MarketplaceScreen`'s "cars" view to start).
4. **Login intent**: add `type LoginIntent = "BUYER" | "DEALER"` persisted transiently (SecureStore/route param). Gate the **single-workspace auto-enter** (currently in `HomeScreen`) so it only fires when intent === "DEALER". A dealer who opens the app normally lands on Browse, not their dashboard.
5. `account.tsx`: buyer account section + a visually secondary **"Are you a car dealer? → Dealer sign in"** → `(auth)/dealer-sign-in`.
6. Reuse the **#106 account sheet** content (theme/language/build/sign-out) as the buyer Account tab's settings.
7. Redirect audit: `/` → Browse; dealer deep links still resolve; `(dealer)` group redirects unauthenticated users to `buyer-sign-in`/Account.

**Risk:** most invasive to routing. Ship after #106 merges; rebase carefully against any in-flight mobile branches (dark redesign, role-today).

## 5. Phase 2 — Reorganize the buyer marketplace (frontend, 1–2 PRs)

1. Replace the 5-tab `BuyerTab` segmented control with the 4 buyer tabs.
2. **Request hub** (`request.tsx`): internal segmented `[New request | My requests]`; New = `[Find me a car | Trade in my car]` (merges today's Request + Trade-in); My requests = statuses, offers, Request Rooms, dealer comms (merges today's Offers). Dealers are discovered via listings/search/profiles — no top-level Dealers tab.
3. **Browse** (`index.tsx`): search bar + city + filter chips + recommended/new/price-drops/finance-eligible/trusted-dealers/recently-viewed + request-a-car promo. Advanced filters move to a **bottom sheet** (replaces the desktop-style filter form); results show before advanced controls.
4. **Native vehicle detail** (`vehicle/[vehicleId].tsx`): gallery, price + monthly, trust block (verification, inspection, accident disclosure, owner count, warranty, finance availability, response time, freshness), primary actions Message/Call/Request financing/Trade-in. De-emphasize opening external listing URLs — keep the journey in-app.
5. **Buyer design language**: large photography, more whitespace, search-led, prices/payments prominent, orange for offers/opportunities, friendly copy. (Dealer mode stays dense/teal/status-oriented.)

## 6. Phase 3 — Progressive identity (frontend + **new backend**, 2–3 PRs)

Three levels, friction proportional to value:

| Level | Who | Unlocks | Auth |
|---|---|---|---|
| 1 Anonymous | visitor | browse, search, filter, vehicle detail, dealer info, call, share, finance calc, **save locally**, recently viewed | none (device `publicId`/fingerprint — mostly exists) |
| 2 Verified guest | high-intent | request a car, trade-in, message dealer, receive offers | **phone + SMS OTP** ("Where should dealers send offers?") → lightweight buyer identity keyed to verified phone |
| 3 Full buyer account | power | cross-device sync, saved-car sync, price/availability/saved-search alerts, multiple requests, persistent conversations, notif prefs | account (Clerk phone, or Clerk + phone) |

New backend work:
- **Saved vehicles** store: local-first (device) for L1; `savedVehicles` table keyed by buyer identity for L3 sync. (No favorites table today.)
- **SMS OTP**: today is Turnstile only. Options in §9. Mints/looks-up a buyer identity by verified phone.
- **Buyer profile** table(s): phone-keyed identity, prefs, alert subscriptions; links to existing `publicId` request history.
- **Guest → account merge**: on account creation, adopt device `publicId` requests + local saved cars into the buyer profile (idempotent, like the changelog seed pattern).
- Alerts: price-drop / availability / saved-search → reuse `marketplaceBuyerPush` token infra.

## 7. Phase 4 — Dealer mode switch (frontend + light backend, 1 PR)

1. **Dealer sign-in intent** distinct from buyer (separate entry, copy, post-auth behavior).
2. **Membership resolver** after auth: 0 memberships → back to buyer Account with "No dealership connected — ask your owner to invite you"; 1 → that org's Today; N → workspace picker. (Generalizes today's auto-enter, now intent-gated.)
3. **`(dealer)` route group gate**: Clerk authed ✔ + Convex session ✔ + membership ✔ + route/module permission ✔ — visual gate backed by the existing server-side `requireTenantAuth` (already enforced).
4. **Mode switch**: dealers see "Open dealer workspace · <Org> · <Role>" in buyer Account; dealer workspace shows a clear "Browse marketplace" — a controlled mode switch, not a blended UI. Preserve the existing 5-tab dealer experience verbatim.

## 8. Cross-cutting

- **iOS Sign in with Apple**: buyer sign-in offering Google ⇒ Apple required (Guideline 4.8). Phone-OTP-primary minimizes exposure; add Apple when Google is offered on the buyer side. Dealer staff keep business credentials.
- **Testing / the 100% jest gate**: mobile has a local-only 100% coverage gate (`src/components/*.tsx`, `app/**/*.tsx`, providers, etc.). New buyer screens under `app/(marketplace)/**` land in the `app/**/*.tsx` set → each needs full-coverage tests. Pre-existing debt: `sign-in.tsx` is untested (drags the global gate; documented follow-up). No CI runs mobile jest, so it's non-blocking but we keep it green.
- **Coordination**: inverting the root route conflicts easily with in-flight mobile branches. Sequence after #106; rebase against active mobile work.

## 9. Open decisions (need your call before Phase 3)

1. **SMS OTP mechanism** — (a) **Clerk phone auth** (real accounts, cross-device, but adds a Clerk strategy + cost) vs (b) **lightweight non-Clerk phone verification** (SMS code → buyer identity keyed by phone/publicId, matches today's outside-Clerk buyer model, cheaper, but "account" is thinner). Recommendation: (b) for L2, promote to Clerk phone for L3.
2. **Keep password login for buyers?** Recommendation: no — buyers use phone OTP (+ optional Apple/Google); password stays dealer-only.
3. **Apple sign-in timing** — add in Phase 1 buyer sign-in, or defer until Google is offered buyer-side? Recommendation: defer Google buyer-side until Apple ships alongside.
4. **Saved cars** — local-only first (Phase 2) then sync (Phase 3), or account-synced from the start? Recommendation: local-first.
5. **`#106` merge** — merge independently now (recommended) or fold into Phase 1?

## 10. Sequencing & PR breakdown

| PR | Phase | Scope | New backend? | Rough size |
|---|---|---|---|---|
| #106 (open) | P0 | header/OTA/label cleanup + account sheet | no | small (done) |
| A | 1 | invert routing, buyer tab shell, login intent, dealer-under-Account | no | medium |
| B | 2 | buyer tabs reorg, Request hub, Browse, filter bottom sheet | no | medium |
| C | 2 | native vehicle detail conversion screen | no | medium |
| D | 3 | local saved cars + recently viewed | small | small |
| E | 3 | SMS OTP + buyer profile + guest→account merge | **yes** | large |
| F | 3 | alerts (price/availability/saved-search) | medium | medium |
| G | 4 | dealer sign-in intent, membership resolver, `(dealer)` gate, mode switch | light | medium |

Dependencies: A → B → C; A → G; B/C → D → E → F. Apple sign-in bundles with whichever PR first offers Google buyer-side.
