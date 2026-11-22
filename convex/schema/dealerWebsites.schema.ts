import { defineTable } from "convex/server";
import { v } from "convex/values";

export const dealerWebsitesTables = {
  websiteSettings: defineTable({
    orgId: v.id("organizations"),
    enabled: v.boolean(),
    status: v.union(
      v.literal("disabled"),
      v.literal("draft"),
      v.literal("active"),
      v.literal("suspended")
    ),
    defaultSubdomain: v.optional(v.string()),
    activeDomainId: v.optional(v.id("websiteDomains")),
    templateId: v.string(),
    defaultLanguage: v.union(v.literal("en"), v.literal("ar")),
    supportedLanguages: v.array(v.union(v.literal("en"), v.literal("ar"))),
    primaryColor: v.optional(v.string()),
    secondaryColor: v.optional(v.string()),
    logoUrl: v.optional(v.string()),
    heroTitle: v.optional(v.string()),
    heroSubtitle: v.optional(v.string()),
    // Free-text badge shown as a small pill over the hero (e.g. Kinetic Sales'
    // hero). Replaces showing a raw "N+ cars available" count.
    heroBadgeText: v.optional(v.string()),
    slogan: v.optional(v.string()),
    // Which of the org's finance companies (see `financeCompanies`) the public
    // site's finance calculator uses for its rate/term. Unset falls back to a
    // generic illustrative rate.
    activeFinanceCompanyId: v.optional(v.id("financeCompanies")),
    themeConfig: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
    publishedAt: v.optional(v.number()),
    publishedSnapshotId: v.optional(v.id("websitePublishSnapshots")),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"]),

  websiteDomains: defineTable({
    orgId: v.id("organizations"),
    websiteSettingsId: v.id("websiteSettings"),
    domain: v.string(),
    type: v.union(
      v.literal("platform_subdomain"),
      v.literal("purchased_custom_domain"),
      v.literal("external_custom_domain")
    ),
    status: v.union(
      v.literal("pending"),
      v.literal("active"),
      v.literal("failed"),
      v.literal("suspended")
    ),
    isPrimary: v.boolean(),
    registrarProvider: v.optional(v.string()),
    registrarDomainId: v.optional(v.string()),
    dnsStatus: v.union(v.literal("pending"), v.literal("configured"), v.literal("failed")),
    sslStatus: v.union(v.literal("pending"), v.literal("active"), v.literal("failed")),
    registrationExpiresAt: v.optional(v.number()),
    autoRenew: v.boolean(),
    publishedSnapshotId: v.optional(v.id("websitePublishSnapshots")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_domain", ["domain"])
    .index("by_org_primary", ["orgId", "isPrimary"]),

  websitePublishedSections: defineTable({
    orgId: v.id("organizations"),
    websiteSettingsId: v.id("websiteSettings"),
    sectionKey: v.string(),
    enabled: v.boolean(),
    configJson: v.optional(v.any()),
  })
    .index("by_org", ["orgId"])
    .index("by_settings", ["websiteSettingsId"])
    .index("by_org_settings_section", ["orgId", "websiteSettingsId", "sectionKey"]),

  websiteLeadRouting: defineTable({
    orgId: v.id("organizations"),
    websiteSettingsId: v.id("websiteSettings"),
    formType: v.string(),
    routeToUserId: v.optional(v.id("users")),
    routeToRole: v.optional(v.string()),
    routeToBranchId: v.optional(v.id("branches")),
    createTask: v.boolean(),
    notifyByEmail: v.boolean(),
    notifyByWhatsApp: v.boolean(),
    configJson: v.optional(v.any()),
  })
    .index("by_settings", ["websiteSettingsId"])
    .index("by_org_settings_form", ["orgId", "websiteSettingsId", "formType"]),

  websiteLeadAbuseEvents: defineTable({
    orgId: v.id("organizations"),
    host: v.string(),
    formType: v.string(),
    reason: v.union(
      v.literal("blocked"),
      v.literal("rate_limited"),
      v.literal("duplicate_suppressed"),
      v.literal("validation_failed")
    ),
    fingerprintHash: v.optional(v.string()),
    clientIpHash: v.optional(v.string()),
    contactKeyHash: v.optional(v.string()),
    detail: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_org_createdAt", ["orgId", "createdAt"])
    .index("by_host_createdAt", ["host", "createdAt"])
    .index("by_reason_createdAt", ["reason", "createdAt"]),

  // orgId is undefined for AutoFlow's own marketing/auth pages (landing, sign-in,
  // sign-up); it's set for dealer-site storefront traffic. Append-only event log,
  // no soft-delete triple (same convention as websiteLeadAbuseEvents above).
  siteVisitorEvents: defineTable({
    orgId: v.optional(v.id("organizations")),
    host: v.string(),
    visitorId: v.string(),
    sessionId: v.string(),
    type: v.union(v.literal("page_view"), v.literal("link_click")),
    path: v.string(),
    linkTarget: v.optional(v.string()),
    linkLabel: v.optional(v.string()),
    referrerHost: v.optional(v.string()),
    referrerUrl: v.optional(v.string()),
    utmSource: v.optional(v.string()),
    utmMedium: v.optional(v.string()),
    utmCampaign: v.optional(v.string()),
    utmTerm: v.optional(v.string()),
    utmContent: v.optional(v.string()),
    clickIdType: v.optional(v.string()),
    clickIdValue: v.optional(v.string()),
    trafficSource: v.string(),
    userAgent: v.optional(v.string()),
    language: v.optional(v.string()),
    timezone: v.optional(v.string()),
    screenWidth: v.optional(v.number()),
    screenHeight: v.optional(v.number()),
    viewportWidth: v.optional(v.number()),
    viewportHeight: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_org_createdAt", ["orgId", "createdAt"])
    .index("by_visitor_createdAt", ["visitorId", "createdAt"])
    .index("by_host_createdAt", ["host", "createdAt"])
    .index("by_createdAt", ["createdAt"]),

  // One upserted profile row per anonymous (orgId, visitorId) pair. orgId undefined
  // scopes to AutoFlow's own marketing/auth pages, same convention as above.
  siteVisitors: defineTable({
    orgId: v.optional(v.id("organizations")),
    host: v.string(),
    visitorId: v.string(),
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
    visitCount: v.number(),
    pageViewCount: v.number(),
    linkClickCount: v.number(),
    firstTrafficSource: v.string(),
    firstReferrerHost: v.optional(v.string()),
    firstUtmSource: v.optional(v.string()),
    firstUtmMedium: v.optional(v.string()),
    firstUtmCampaign: v.optional(v.string()),
    deviceType: v.string(),
    browserName: v.string(),
    osName: v.string(),
    country: v.optional(v.string()),
    region: v.optional(v.string()),
    city: v.optional(v.string()),
    geoLookupStatus: v.optional(
      v.union(v.literal("pending"), v.literal("done"), v.literal("failed"))
    ),
    // Used to detect a "new visit" (new browser session from a known visitor)
    // vs. another page_view/link_click within the same ongoing session.
    lastSessionId: v.optional(v.string()),
  })
    .index("by_org_visitor", ["orgId", "visitorId"])
    .index("by_org_firstSeenAt", ["orgId", "firstSeenAt"])
    .index("by_firstSeenAt", ["firstSeenAt"]),

  websiteLeadBlocklist: defineTable({
    orgId: v.id("organizations"),
    host: v.optional(v.string()),
    kind: v.union(
      v.literal("fingerprint"),
      v.literal("ipHash"),
      v.literal("email"),
      v.literal("emailDomain"),
      v.literal("phone")
    ),
    // The SHA-256 hex digest of the normalised value, never the value itself —
    // see `websiteLeadBlocklistValueHash` in convex/websites.ts, which is the
    // only thing allowed to produce this column so the read and write sides
    // cannot drift into comparing a raw value against a digest.
    valueHash: v.string(),
    reason: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    createdAt: v.number(),
    createdBy: v.optional(v.id("users")),
  })
    // orgId leads the key on purpose. The previous `["kind", "valueHash"]`
    // index was global, so the lookup had to over-read every org's rows for a
    // value and filter afterwards — with a bounded `.take()`, an org's own
    // block could be pushed out of the window by other orgs blocking the same
    // email and the submission would be allowed. Scoping the index to the org
    // makes the tenant boundary part of the read rather than a post-filter.
    .index("by_org_kind_valueHash", ["orgId", "kind", "valueHash"])
    .index("by_org", ["orgId"])
    .index("by_host", ["host"]),

  websitePublishSnapshots: defineTable({
    orgId: v.id("organizations"),
    websiteSettingsId: v.id("websiteSettings"),
    domain: v.optional(v.string()),
    version: v.optional(v.string()),
    snapshotJson: v.any(),
    createdAt: v.number(),
    publishedAt: v.optional(v.number()),
    publishedByUserId: v.id("users"),
  })
    .index("by_org", ["orgId"])
    .index("by_settings", ["websiteSettingsId"])
    .index("by_domain_version", ["domain", "version"]),

  domainSearchLogs: defineTable({
    orgId: v.id("organizations"),
    query: v.string(),
    available: v.boolean(),
    price: v.optional(v.number()),
    provider: v.string(),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_createdAt", ["orgId", "createdAt"]),
};
