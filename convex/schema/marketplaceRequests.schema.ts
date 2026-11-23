import { defineTable } from "convex/server";
import { v } from "convex/values";

export const marketplaceRequestsTables = {
  // ─── Dealer Network Marketplace (Phase 56+) ──────────────────────────────
  // Cross-org layer: a dealer's marketplace presence is an opt-in flag on top
  // of their existing dealer-site inventory (see docs/dealer_network_marketplace_master_plan.md
  // decision A2) — this table does not duplicate `vehicles` or `websiteSettings`.
  marketplaceDealerProfiles: defineTable({
    orgId: v.id("organizations"),
    isOptedIn: v.boolean(),
    areas: v.array(v.string()),
    brandsCarried: v.array(v.string()),
    whatsappNumber: v.optional(v.string()),
    badges: v.array(
      v.union(
        v.literal("VERIFIED_PHONE"),
        v.literal("VERIFIED_LOCATION"),
        v.literal("FAST_RESPONSE"),
        v.literal("FINANCE_AVAILABLE"),
        v.literal("FOUNDING_DEALER")
      )
    ),
    avgResponseMinutes: v.optional(v.number()),
    totalResponses: v.number(),
    totalAccepted: v.number(),
    // Phase 60: staff-confirmed WhatsApp reachability. There's no automated
    // OTP-over-WhatsApp send yet — same Business Verification blocker as the
    // rest of this epic's WhatsApp features (master plan A5b) — so this is
    // set manually by AutoFlow staff via the admin console after confirming
    // the number by phone/WhatsApp, mirroring the manual-first pattern
    // already used for dealer notifications (Phase 57) and proof reports
    // (Phase 58B).
    phoneVerifiedAt: v.optional(v.number()),
    phoneVerifiedBy: v.optional(v.id("users")),
    tier: v.union(
      v.literal("FREE_FOUNDING"),
      v.literal("LEAD_PACKAGE"),
      v.literal("FEATURED")
    ),
    leadQuota: v.optional(v.number()),
    leadsUsedThisPeriod: v.number(),
    // Phase 63: when the FREE_FOUNDING tier's free-leads window closes. Set at
    // profile creation; left undefined for rows created before Phase 63 —
    // `marketplaceDealers.ts`'s `effectiveFoundingWindowEndsAt` lazily derives
    // the same value from `createdAt` so no backfill migration is needed.
    foundingWindowEndsAt: v.optional(v.number()),
    // Phase 63: rolling-window start for `leadsUsedThisPeriod` (LEAD_PACKAGE
    // tier only) — reset lazily once a period elapses, same no-backfill
    // reasoning as `foundingWindowEndsAt`.
    leadPeriodStartedAt: v.optional(v.number()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.id("users")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_opted_in", ["isOptedIn"]),

  // Buyer intent capture (Phase 57). Deliberately has no `orgId` — a request
  // isn't owned by any single tenant, it fans out to N matched dealers via
  // `marketplaceRequestMatches`. See master plan A1/A3.
  marketplaceRequests: defineTable({
    status: v.union(
      v.literal("OPEN"),
      v.literal("MATCHED"),
      // Legacy: any fulfilling dealer reply used to set this directly. New
      // rows use OFFERS_RECEIVED (dealer replied) → ACCEPTED/COMPLETED
      // (buyer action) instead; kept until prod rows are migrated.
      v.literal("FULFILLED"),
      v.literal("OFFERS_RECEIVED"),
      v.literal("ACCEPTED"),
      v.literal("COMPLETED"),
      v.literal("EXPIRED"),
      v.literal("SPAM")
    ),
    // Unguessable share token — the buyer's only key to their Request Room.
    // Optional because rows predating it exist in prod; backfilled by
    // migrateMarketplacePublicIds. Raw document ids stay accepted for the
    // legacy status lookup but must never gate buyer actions.
    publicId: v.optional(v.string()),
    buyerFirstName: v.string(),
    buyerPhone: v.string(),
    buyerWhatsApp: v.optional(v.string()),
    buyerCity: v.string(),
    make: v.optional(v.string()),
    model: v.optional(v.string()),
    yearMin: v.optional(v.number()),
    yearMax: v.optional(v.number()),
    priceMin: v.optional(v.number()),
    priceMax: v.optional(v.number()),
    paymentType: v.union(v.literal("CASH"), v.literal("FINANCE"), v.literal("EITHER")),
    monthlyBudget: v.optional(v.number()),
    // Buyer's own financing constraints — drives personalized installment
    // estimates and finance-aware matching, unlike the fixed 20%/60mo
    // illustrative defaults used when these are absent.
    financePreferences: v.optional(
      v.object({
        downPaymentAmount: v.optional(v.number()),
        preferredTermMonths: v.optional(v.number()),
        maximumMonthlyPayment: v.optional(v.number()),
        allowHigherDownPayment: v.optional(v.boolean()),
        maximumHigherDownPayment: v.optional(v.number()),
        allowLongerTerm: v.optional(v.boolean()),
        maximumTermMonths: v.optional(v.number()),
      })
    ),
    bodyType: v.optional(v.string()),
    // What the buyer allows dealers to flex on when proposing similar options.
    flexibility: v.optional(
      v.object({
        yearDelta: v.optional(v.number()),
        budgetDelta: v.optional(v.number()),
        allowSimilarModel: v.optional(v.boolean()),
        allowNearbyCity: v.optional(v.boolean()),
        allowDifferentColor: v.optional(v.boolean()),
      })
    ),
    buyerTimeframe: v.union(
      v.literal("ASAP"),
      v.literal("THIS_WEEK"),
      v.literal("THIS_MONTH"),
      v.literal("JUST_LOOKING")
    ),
    // Rule-based, computed at submission — see master plan Phase 57 A10/§4.
    buyerIntent: v.union(v.literal("COLD"), v.literal("WARM"), v.literal("HOT")),
    consentAcceptedAt: v.number(),
    clientFingerprint: v.string(),
    clientIpHash: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_city", ["buyerCity"])
    .index("by_publicId", ["publicId"])
    // SCRUM-807 — lets the daily expiry sweep read only requests past expiresAt.
    .index("by_status_expires", ["status", "expiresAt"]),

  // One row per matched dealer per request — not a flat array on
  // marketplaceRequests — so notify/respond timestamps are trackable per
  // dealer for Phase 60's response-time scoring. Capped at
  // MAX_MATCHED_DEALERS (5) per request per master plan A10.
  marketplaceRequestMatches: defineTable({
    requestId: v.id("marketplaceRequests"),
    orgId: v.id("organizations"),
    matchedAt: v.number(),
    notifiedAt: v.optional(v.number()),
    notifiedVia: v.optional(v.union(v.literal("WHATSAPP_MANUAL"), v.literal("WHATSAPP_AUTO"))),
    // INVENTORY = a concrete published vehicle scored against the request;
    // ELIGIBLE = city/brand backfill kept for sourcing capacity. Absent on
    // rows matched before finance-aware matching shipped.
    matchTier: v.optional(v.union(v.literal("INVENTORY"), v.literal("ELIGIBLE"))),
    matchedVehicleId: v.optional(v.id("vehicles")),
    estimatedMonthlyPayment: v.optional(v.number()),
    estimatedTotalContractValue: v.optional(v.number()),
    matchScore: v.optional(v.number()),
    matchReasons: v.optional(v.array(v.string())),
    financeCompanyId: v.optional(v.id("financeCompanies")),
    // Terms as of match time — finance-company rates drift, and the buyer
    // must keep seeing the numbers their estimate was actually built from.
    calculationSnapshot: v.optional(
      v.object({
        vehiclePrice: v.number(),
        downPayment: v.number(),
        termMonths: v.number(),
        annualProfitRate: v.number(),
        annualInsuranceRate: v.number(),
        commission: v.number(),
        processingFees: v.number(),
      })
    ),
    // Buyer consented to reveal their phone to this one dealer.
    contactUnlockedAt: v.optional(v.number()),
  })
    .index("by_request", ["requestId"])
    .index("by_org", ["orgId"])
    // Weekly proof report (SCRUM-807): range-bounds the read by date BEFORE any row cap.
    .index("by_org_matchedAt", ["orgId", "matchedAt"]),

  // A matched dealer's reply to a buyer request (Phase 58). Reused across
  // both the dealer-facing inbox and the public buyer-status page.
  marketplaceResponses: defineTable({
    requestId: v.id("marketplaceRequests"),
    orgId: v.id("organizations"),
    respondingUserId: v.id("users"),
    kind: v.union(
      v.literal("HAVE_MATCH"),
      v.literal("HAVE_SIMILAR"),
      v.literal("CAN_SOURCE"),
      v.literal("NOT_AVAILABLE")
    ),
    vehicleId: v.optional(v.id("vehicles")),
    offerPriceJod: v.optional(v.number()),
    note: v.optional(v.string()),
    // Full computed offer, AutoFlow-calculated from the dealer's selected
    // finance company + down/term — the dealer never types the installment.
    // Snapshot semantics: what the buyer was quoted survives rate changes.
    financeOffer: v.optional(
      v.object({
        vehiclePrice: v.number(),
        downPayment: v.number(),
        termMonths: v.number(),
        monthlyInstallment: v.number(),
        totalContractValue: v.number(),
        totalProfit: v.number(),
        insuranceAmount: v.number(),
        commission: v.number(),
        processingFees: v.number(),
        financeCompanyId: v.optional(v.id("financeCompanies")),
        expiresAt: v.optional(v.number()),
      })
    ),
    // CAN_SOURCE replies carry an honest range + ETA instead of pretending a
    // concrete vehicle exists.
    sourcingRange: v.optional(
      v.object({
        minJod: v.number(),
        maxJod: v.number(),
        etaDays: v.number(),
      })
    ),
    buyerAction: v.optional(
      v.union(v.literal("SHORTLISTED"), v.literal("ACCEPTED"), v.literal("DECLINED"))
    ),
    buyerActionAt: v.optional(v.number()),
    // Buyer consented to reveal their phone to this response's dealer.
    contactUnlockedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_request", ["requestId"])
    .index("by_org", ["orgId"])
    // Weekly proof report (SCRUM-807): range-bounds the read by date BEFORE any row cap.
    .index("by_org_createdAt", ["orgId", "createdAt"]),

  // Funnel telemetry (request submitted, offer sent/viewed/accepted, contact
  // unlocked, ...) — powers dealer response-SLA scoring and liquidity
  // metrics. Append-only; no PII beyond the ids.
  marketplaceEvents: defineTable({
    requestId: v.optional(v.id("marketplaceRequests")),
    orgId: v.optional(v.id("organizations")),
    event: v.string(),
    meta: v.optional(v.record(v.string(), v.union(v.string(), v.number(), v.boolean()))),
    createdAt: v.number(),
  })
    .index("by_request", ["requestId"])
    .index("by_org_event", ["orgId", "event"]),

  // Anonymous buyers have no Clerk account — push tokens key off the
  // request's publicId instead.
  marketplaceBuyerPushTokens: defineTable({
    publicId: v.string(),
    token: v.string(),
    platform: v.union(v.literal("IOS"), v.literal("ANDROID"), v.literal("WEB")),
    createdAt: v.number(),
  })
    .index("by_publicId", ["publicId"])
    .index("by_token", ["token"]),

  // Tracks manual WhatsApp sends of the weekly proof report (Phase 58B),
  // same wa.me deep-link pattern as marketplaceRequestMatches' notifiedAt —
  // one row per (orgId, weekStart) so the admin console can show "Sent" and
  // avoid staff double-sending. weekStart is the most recent Monday 00:00 UTC
  // at send time, not tied to the report's own trailing-7-day stat window.
  marketplaceWeeklyReportSends: defineTable({
    orgId: v.id("organizations"),
    weekStart: v.number(),
    sentAt: v.number(),
    sentBy: v.id("users"),
  }).index("by_org_week", ["orgId", "weekStart"]),

  // SCRUM-807 — one row per business week of the automatic weekly proof-report
  // email. The business-level idempotency/result/window binding: the frozen
  // `since`/`until` window, the roster cursor and the run's own status. Not a
  // lease or a queue (Workpool owns the queue). History is kept on purpose.
  marketplaceWeeklyReportRuns: defineTable({
    // `currentWeekStart(runStartedAt)`: one run per week, however often the cron fires.
    weekKey: v.number(),
    runStartedAt: v.number(),
    since: v.number(),
    until: v.number(),
    status: v.union(
      v.literal("PRODUCING"),
      v.literal("PRODUCED"),
      v.literal("COMPLETE"),
      v.literal("CANCELED"),
      v.literal("STALLED")
    ),
    // Roster pagination cursor; null before the first page and after the last.
    cursor: v.union(v.string(), v.null()),
    cancelRequestedAt: v.optional(v.number()),
  }).index("by_weekKey", ["weekKey"]),

  // One row per (run, dealer org): the frozen full email, the per-attempt send
  // state, and the final honest result. Provider acceptance is not delivery.
  marketplaceWeeklyReportDeliveries: defineTable({
    runId: v.id("marketplaceWeeklyReportRuns"),
    orgId: v.id("organizations"),
    state: v.union(
      v.literal("PENDING"),
      v.literal("FROZEN"),
      v.literal("SKIPPED"),
      v.literal("SENDING"),
      v.literal("ACCEPTED"),
      v.literal("MOCK"),
      v.literal("FAILED_TERMINAL"),
      v.literal("AMBIGUOUS"),
      v.literal("CANCELED")
    ),
    // Stable per (week, org); Resend returns the original for the same key and payload for 24 h.
    idempotencyKey: v.string(),
    envelope: v.optional(
      v.object({ from: v.string(), to: v.string(), subject: v.string(), html: v.string() })
    ),
    report: v.optional(
      v.object({
        pageViews: v.number(),
        vehicleDetailViews: v.number(),
        requestsMatched: v.number(),
        responsesSent: v.number(),
        avgResponseMinutes: v.union(v.number(), v.null()),
        mostViewedVehicle: v.union(
          v.null(),
          v.object({ make: v.string(), model: v.string(), year: v.number(), views: v.number() })
        ),
        requestsLost: v.number(),
        lowerBound: v.optional(v.array(v.string())),
        unavailable: v.optional(v.array(v.string())),
      })
    ),
    firstAttemptAt: v.optional(v.number()),
    attempts: v.number(),
    // Per attempt: reset to "ambiguous" by `beginWeeklySend` before the provider call.
    errorClass: v.optional(v.union(v.literal("rejected"), v.literal("ambiguous"))),
    errorName: v.optional(v.string()),
    // Monotonic: set once an earlier attempt may have been accepted; never cleared.
    anyAttemptAmbiguous: v.boolean(),
    providerEmailId: v.optional(v.string()),
    // The Workpool id of this row's freeze job. Freeze jobs are enqueued as one
    // batch per roster page, which shares a single onComplete context, so a
    // failed/canceled freeze finds its row by this id.
    freezeWorkId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_run_org", ["runId", "orgId"])
    .index("by_run_state", ["runId", "state"])
    .index("by_freezeWorkId", ["freezeWorkId"]),

  // Phase 62 — buyer-submitted trade-in request, directed at a single dealer
  // (whichever listing the buyer was viewing), not fanned out like
  // marketplaceRequests. An accepted offer creates a lead in that dealer's
  // existing pipeline — Phase 34 (Purchase Orders) doesn't exist in this
  // codebase yet, so this deliberately does NOT create a purchase order;
  // see master plan Phase 62 notes for the reasoning.
  marketplaceTradeInRequests: defineTable({
    orgId: v.id("organizations"),
    buyerFirstName: v.string(),
    buyerPhone: v.string(),
    currentMake: v.string(),
    currentModel: v.string(),
    currentYear: v.number(),
    currentMileage: v.number(),
    condition: v.union(
      v.literal("EXCELLENT"),
      v.literal("GOOD"),
      v.literal("FAIR"),
      v.literal("POOR")
    ),
    notes: v.optional(v.string()),
    status: v.union(
      v.literal("PENDING"),
      v.literal("OFFERED"),
      v.literal("ACCEPTED"),
      v.literal("DECLINED")
    ),
    offerAmountJod: v.optional(v.number()),
    offeredAt: v.optional(v.number()),
    offeredBy: v.optional(v.id("users")),
    respondedAt: v.optional(v.number()),
    leadId: v.optional(v.id("leads")),
    consentAcceptedAt: v.number(),
    clientFingerprint: v.string(),
    clientIpHash: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"]),
};
