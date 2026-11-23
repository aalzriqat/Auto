import { defineTable } from "convex/server";
import { v } from "convex/values";

export const dealerConfigurationTables = {
  orgSettings: defineTable({
    orgId: v.id("organizations"),
    currency: v.string(),
    currencySymbol: v.string(),
    vatRate: v.optional(v.number()),
    country: v.optional(v.string()),
    timezone: v.optional(v.string()),
    enabledPaymentTypes: v.array(v.string()),
    logoStorageId: v.optional(v.id("_storage")),
    primaryColor: v.optional(v.string()),
    dealershipName: v.optional(v.string()),
    // The officially registered legal entity name (e.g. "Al-Noor Trading Co. LLC"),
    // shown alongside dealershipName (the trade/showroom name) on every printed
    // legal document — bill of sale, quotes, receipt vouchers.
    legalCompanyName: v.optional(v.string()),
    dealershipAddress: v.optional(v.string()),
    dealershipPhone: v.optional(v.string()),
    // Extra org-wide numbers (sales line, support line, etc.) shown alongside
    // dealershipPhone on the public dealer website. dealershipPhone stays the
    // one used for WhatsApp deep links.
    dealershipPhones: v.optional(v.array(v.string())),
    whatsappPhoneNumberId: v.optional(v.string()),
    whatsappApiToken: v.optional(v.string()),
    whatsappWebhookSecret: v.optional(v.string()),
    approvalThresholdEnabled: v.optional(v.boolean()),
    approvalMinProfitPercent: v.optional(v.number()),
    commissionTiers: v.optional(
      v.array(v.object({ minProfitAmount: v.number(), commissionPct: v.number() }))
    ),
    commissionMode: v.optional(v.union(v.literal("AUTO_TIERS"), v.literal("AUTO_MEMBER"), v.literal("MANUAL"))),
    // Default number of days a vehicle reservation/deposit hold (عربون) lasts
    // before it auto-expires. Falls back to DEFAULT_RESERVATION_HOLD_DAYS
    // (convex/utils/depositHelpers.ts) when unset.
    reservationHoldDays: v.optional(v.number()),
    instagramBusinessAccountId: v.optional(v.string()),
    // The IG profile's "user_id" field — distinct from instagramBusinessAccountId
    // (the OAuth-returned "id"). Meta uses *this* ID in webhook entry[].id;
    // the other one is used for outbound Graph API path calls. Confirmed by
    // direct API probe 2026-06-22 — not documented anywhere obvious.
    instagramWebhookAccountId: v.optional(v.string()),
    instagramAccessToken: v.optional(v.string()),
    instagramTokenExpiresAt: v.optional(v.number()),
    instagramPageName: v.optional(v.string()),
    socialAutoPostEnabled: v.optional(v.boolean()),
    instagramAutoReplyEnabled: v.optional(v.boolean()),
    instagramAutoReplyMessages: v.optional(v.array(v.string())),
    instagramAutoReplyMobileReceivedMessage: v.optional(v.string()),
    instagramAutoReplyLastIndex: v.optional(v.number()),
    // Whether an inbound comment/DM creates a CRM lead. Undefined is treated
    // as true (preserves pre-toggle behavior for orgs that connected before
    // this setting existed) — the interaction is always captured in the
    // Social Inbox and still gets auto-replied to either way; this only
    // gates whether it also produces a Lead in the pipeline + notification.
    instagramLeadFromCommentsEnabled: v.optional(v.boolean()),
    instagramLeadFromDmsEnabled: v.optional(v.boolean()),
    instagramLeadFromDmsRequiresMobile: v.optional(v.boolean()),
    facebookPageId: v.optional(v.string()),
    facebookPageAccessToken: v.optional(v.string()),
    facebookPageName: v.optional(v.string()),
    // The Facebook user ID of whoever connected the Page (from GET /me
    // during token exchange) — distinct from facebookPageId. Needed because
    // Meta's deauthorize/data-deletion signed_request payloads only carry
    // the connecting user's ID, not the Page ID, so this is the only way to
    // resolve which org's connection to clear from those callbacks.
    facebookConnectedByUserId: v.optional(v.string()),
    // Page tokens derived from a long-lived user token typically don't
    // expire, but kept optional/nullable for parity with Instagram and in
    // case Meta changes that behavior.
    facebookTokenExpiresAt: v.optional(v.number()),
    facebookAutoReplyEnabled: v.optional(v.boolean()),
    facebookAutoReplyMessages: v.optional(v.array(v.string())),
    facebookAutoReplyMobileReceivedMessage: v.optional(v.string()),
    facebookAutoReplyLastIndex: v.optional(v.number()),
    facebookLeadFromCommentsEnabled: v.optional(v.boolean()),
    facebookLeadFromDmsEnabled: v.optional(v.boolean()),
    facebookLeadFromDmsRequiresMobile: v.optional(v.boolean()),
    generatedLeadAutoAssignmentEnabled: v.optional(v.boolean()),
    // Smart Reply: rule-based price/financing/availability/vehicleInfo/location
    // auto-answers, distinct from the canned round-robin auto-reply above --
    // requires a vehicleId match (except location/greeting) and only fires for
    // keyword-matched questions. Off by default for all orgs.
    instagramSmartReplyEnabled: v.optional(v.boolean()),
    facebookSmartReplyEnabled: v.optional(v.boolean()),
    // "calculated": compute a "starting from X/month" figure via
    // calculateUnifiedMurabaha using smartReplyDefaultFinanceCompanyId + that
    // company's own maxTermMonths + smartReplyDefaultDownPaymentPercent.
    // "generic": static financing copy, no computed number. Default when unset: generic.
    smartReplyFinancingMode: v.optional(v.union(v.literal("calculated"), v.literal("generic"))),
    smartReplyDefaultDownPaymentPercent: v.optional(v.number()), // e.g. 20 for 20%
    smartReplyDefaultFinanceCompanyId: v.optional(v.id("financeCompanies")),
    // "public": comment-triggered smart replies post publicly under the comment
    // (current canned-reply behavior). "dm": sent privately via DM instead.
    // Shared across both platforms. Default when unset: public.
    smartReplyVisibility: v.optional(v.union(v.literal("public"), v.literal("dm"))),
    // Fallback language for a reply when the inbound text has no detectable
    // script (emoji-only, numeric-only, etc). Default when unset: "en".
    smartReplyDefaultLocale: v.optional(v.union(v.literal("en"), v.literal("ar"))),
    // Granular canned-reply toggles. When set, these override the platform-level
    // facebookAutoReplyEnabled / instagramAutoReplyEnabled for the given kind.
    // Undefined = fall back to the platform-level flag (backward-compatible).
    facebookAutoReplyForDmsEnabled: v.optional(v.boolean()),
    facebookAutoReplyForCommentsEnabled: v.optional(v.boolean()),
    instagramAutoReplyForDmsEnabled: v.optional(v.boolean()),
    instagramAutoReplyForCommentsEnabled: v.optional(v.boolean()),
    // Per-kind smart-reply toggles (same backward-compat pattern).
    facebookSmartReplyForDmsEnabled: v.optional(v.boolean()),
    facebookSmartReplyForCommentsEnabled: v.optional(v.boolean()),
    instagramSmartReplyForDmsEnabled: v.optional(v.boolean()),
    instagramSmartReplyForCommentsEnabled: v.optional(v.boolean()),
    // Custom Smart Reply response templates as JSON strings keyed by intent.
    // Supported keys (same {placeholder} tokens as the built-in defaults):
    //   greeting, location, locationFallback, priceAvailable, financingGeneric,
    //   financingCalculated, availableYes, availableSold, availableUnclear, vehicleInfo
    // Undefined = use the built-in copy from socialSmartReplyEn / socialSmartReplyAr.
    smartReplyCustomTemplatesEn: v.optional(v.string()),
    smartReplyCustomTemplatesAr: v.optional(v.string()),
    // Client-safe picker list: id + name only (no tokens).
    // Populated by exchangeCodeForToken when the user manages >1 Facebook Page.
    // Cleared after selectFacebookPage completes.
    facebookAvailablePages: v.optional(
      v.array(v.object({ id: v.string(), name: v.string() }))
    ),
    // Server-only pending credentials — includes access tokens; never sent to clients.
    // Cleared after selectFacebookPage completes.
    facebookPendingCredentials: v.optional(
      v.array(v.object({ id: v.string(), name: v.string(), token: v.string() }))
    ),
    // SCRUM-841: when the Owner last disconnected Facebook for this org. An OAuth
    // attempt begun at or before it cannot store pending Page credentials, so an
    // exchange already in flight (or an old unconsumed state) cannot undo the
    // disconnect. A timestamp only; never cleared, so it keeps fencing attempts
    // begun before it after later connections. Distinct from the Meta-user
    // `facebookRevocations` fence, which a signed callback sets.
    facebookDisconnectedAt: v.optional(v.number()),
    // SCRUM-841: identifies the OAuth attempt whose Pages are in `facebookPendingCredentials`.
    // A fresh random value is stamped each time pending credentials are saved, so a Page
    // selection begun on an earlier attempt cannot promote a later attempt's credentials
    // even when the user, Page and token are identical. Server-only; cleared with them.
    facebookPendingAttemptId: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_instagram_business_account_id", ["instagramBusinessAccountId"])
    .index("by_instagram_webhook_account_id", ["instagramWebhookAccountId"])
    .index("by_facebook_page_id", ["facebookPageId"])
    .index("by_facebook_connected_user_id", ["facebookConnectedByUserId"]),

  orgCustomFields: defineTable({
    orgId: v.id("organizations"),
    entityType: v.union(v.literal("vehicle"), v.literal("customer"), v.literal("lead")),
    fieldName: v.string(),
    fieldKey: v.string(),
    fieldType: v.union(v.literal("text"), v.literal("number"), v.literal("select"), v.literal("date")),
    isRequired: v.boolean(),
    options: v.optional(v.array(v.string())),
    order: v.number(),
    isActive: v.boolean(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_entity", ["orgId", "entityType"]),

  orgCustomFieldValues: defineTable({
    orgId: v.id("organizations"),
    entityType: v.string(),
    entityId: v.string(),
    fieldId: v.id("orgCustomFields"),
    value: v.string(),
  })
    .index("by_org", ["orgId"])
    // The tenant-scoped lookup. `by_entity` below is NOT org-scoped, so reading
    // through it returns other dealerships' values for the same entity id —
    // always enter this table by org (see convex/orgCustomFields.ts).
    .index("by_org_entity", ["orgId", "entityType", "entityId"])
    .index("by_entity", ["entityType", "entityId"])
    .index("by_entity_field", ["entityId", "fieldId"]),

  orgLeadSources: defineTable({
    orgId: v.id("organizations"),
    label: v.string(),
    isActive: v.boolean(),
    order: v.number(),
  }).index("by_org", ["orgId"]),

  orgValuationCompanies: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    isActive: v.boolean(),
    order: v.number(),
  }).index("by_org", ["orgId"]),

  orgPipelineStages: defineTable({
    orgId: v.id("organizations"),
    stageKey: v.string(), // "NEW" | "CONTACTED" | "INTERESTED" | "TEST_DRIVE" | "NEGOTIATION" | "RESERVED" | "WON" | "LOST"
    label: v.string(), // Custom display label, e.g. "طازج" instead of "New"
    color: v.optional(v.string()), // Hex color, e.g. "#3b82f6"
    order: v.number(),
    isActive: v.boolean(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_key", ["orgId", "stageKey"]),

  orgImportMappings: defineTable({
    orgId: v.id("organizations"),
    entityType: v.union(v.literal("vehicle"), v.literal("customer")),
    mapping: v.array(v.object({
      sourceHeader: v.string(), // normalized header text from the dealer's file
      targetField: v.string(), // schema field key, e.g. "make" / "vin"
    })),
    updatedAt: v.number(),
  }).index("by_org_entity", ["orgId", "entityType"]),

  orgCustomerStatuses: defineTable({
    orgId: v.id("organizations"),
    label: v.string(),
    isActive: v.boolean(),
    order: v.number(),
  }).index("by_org", ["orgId"]),

  profitApprovalRequests: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    requestedProfit: v.number(),
    minimumProfit: v.number(),
    salespersonId: v.id("users"),
    status: v.union(v.literal("PENDING"), v.literal("APPROVED"), v.literal("REJECTED")),
    approvedBy: v.optional(v.id("users")),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    // SCRUM-260: the server-computed priced state this request asks approval
    // for (see convex/utils/profitApproval.ts). An approval authorizes exactly
    // these values; rows written before them carry none and authorize nothing.
    salePriceMinor: v.optional(v.number()),
    listPriceMinor: v.optional(v.number()),
    minimumProfitMinor: v.optional(v.number()),
    currency: v.optional(v.string()),
    // Set when a newer request from the same salesperson replaced this one
    // while it was still PENDING; the row is closed as REJECTED without a
    // rejection notice.
    supersededAt: v.optional(v.number()),
    respondedAt: v.optional(v.number()),
    // Full wizard state snapshot so salesperson can resume after approval.
    // Must stay in step with `wizardSnapshotValidator` in convex/approvals.ts:
    // a field the args validator accepts but this object omits is an "extra
    // field" schema mismatch that throws inside the mutation and rolls the whole
    // request back. The same three execution-commission fields were already
    // missed once on `wizardDrafts.wizardData` above (fixed in c906211c).
    wizardSnapshot: v.optional(v.object({
      paymentType: v.string(),
      vehiclePrice: v.number(),
      desiredProfit: v.number(),
      downPayment: v.number(),
      termMonths: v.number(),
      selectedCompanyId: v.optional(v.string()),
      manualProfitRate: v.optional(v.number()),
      manualInsuranceRate: v.optional(v.number()),
      manualExecutionCommission: v.optional(v.number()),
      manualExecutionFees: v.optional(v.number()),
      manualIncludesCommissionInDebt: v.optional(v.boolean()),
    })),
  })
    .index("by_org", ["orgId"])
    .index("by_vehicle", ["vehicleId"])
    .index("by_salesperson", ["salespersonId"])
    .index("by_status", ["status"])
    // SCRUM-260: the approval lookup for one priced state. Rows written
    // before SCRUM-260 carry no salePriceMinor and are never matched.
    .index("by_org_vehicle_salePrice", ["orgId", "vehicleId", "salePriceMinor"])
    // SCRUM-100. `by_org` + a post-read `.filter(status === "PENDING")` reads
    // every request the org ever created and discards most of them; these rows
    // are fat (`wizardSnapshot` carries the whole sale wizard). Bound in the
    // index instead.
    .index("by_org_status", ["orgId", "status"])
    // SCRUM-100. `orgId` FIRST is the tenant boundary, not an optimisation:
    // `by_salesperson` alone keys on a global user id, so a salesperson who
    // belongs to two dealerships read both. Putting orgId in the access path
    // means a later edit cannot drop the check by forgetting a filter.
    //
    // ⚠️ `status` deliberately absent. The predicate is `!== "REJECTED"` —
    // PENDING *or* APPROVED — because APPROVED rows are the resume-after-
    // approval flow. Pinning the range to PENDING would silently drop them,
    // and encoding the enum here breaks silently if a fourth status is added.
    .index("by_org_salesperson_createdAt", ["orgId", "salespersonId", "createdAt"])
    // `checkPendingApproval` asks "does this salesperson already have a request
    // for this car". It read `by_vehicle` — keyed on the GLOBAL vehicle id —
    // and narrowed by salesperson with a post-read filter, so nothing in the
    // read constrained the REQUEST's org. Verifying that the VEHICLE is in-org
    // proves nothing about a REQUEST that references it, which is the same
    // distinction that produced this ticket one function away.
    .index("by_org_vehicle_salesperson", ["orgId", "vehicleId", "salespersonId"]),
};
