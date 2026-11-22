import { defineTable } from "convex/server";
import { v } from "convex/values";

export const notificationsTables = {
  notifications: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    // Legacy plain-text fields — kept for old rows and for admin-authored
    // broadcasts (type: "system.announcement"), which skip the registry
    // since a super admin types free-form text rather than picking a key.
    title: v.optional(v.string()),
    message: v.optional(v.string()),
    // New typed path: a key into lib/notifications/types.ts, rendered
    // bilingually via lib/notifications/render.ts using `data`.
    type: v.optional(v.string()),
    category: v.optional(v.string()),
    priority: v.optional(
      v.union(v.literal("urgent"), v.literal("normal"), v.literal("low"))
    ),
    data: v.optional(v.any()),
    isRead: v.boolean(),
    isArchived: v.optional(v.boolean()),
    archivedAt: v.optional(v.number()),
    link: v.optional(v.string()), // Optional URL to navigate to when clicked
    relatedTaskId: v.optional(v.id("tasks")),
  })
    .index("by_user", ["userId"])
    .index("by_org_user", ["orgId", "userId"])
    // Unread badge/count without a full-table filter scan.
    .index("by_org_user_read", ["orgId", "userId", "isRead"])
    .index("by_org_user_category", ["orgId", "userId", "category"])
    // Paginated history filtered by archived state without post-cursor memory filtering.
    .index("by_org_user_archived", ["orgId", "userId", "isArchived"]),

  notificationPreferences: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    category: v.string(),
    emailEnabled: v.boolean(),
    whatsappEnabled: v.boolean(),
    pushEnabled: v.optional(v.boolean()),
  }).index("by_org_user_category", ["orgId", "userId", "category"]),

  // One row per (device, org, user) a user has enabled Web Push on. A push
  // endpoint is scoped to the browser origin, not to an AutoFlow org — a
  // user who belongs to several orgs on the same device reuses the same
  // endpoint across all of them, so the natural key is the full triple, not
  // endpoint alone (that would let enabling push in org B silently steal the
  // row from org A).
  pushSubscriptions: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    userAgent: v.optional(v.string()),
    deviceName: v.optional(v.string()),
    enabled: v.boolean(),
    createdAt: v.number(),
    lastSeenAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_org_user", ["orgId", "userId"])
    .index("by_endpoint_org_user", ["endpoint", "orgId", "userId"])
    // Cross-org/user lookup used only to purge every row tied to an endpoint
    // the push service reports as gone (HTTP 404/410) — see removeByEndpoint.
    .index("by_endpoint", ["endpoint"]),

  notificationBroadcasts: defineTable({
    orgId: v.optional(v.id("organizations")), // omitted = platform-wide
    title: v.string(),
    message: v.string(),
    link: v.optional(v.string()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    recipientCount: v.number(),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_org", ["orgId"]),

  // Product-wide "What's New" log — every tenant sees the same entries.
  // Super-admin authored (see convex/changelog.ts); creating an entry can
  // optionally also fire a notificationBroadcast so users get an in-app
  // ping, not just a page to check. Bilingual per-entry (not routed through
  // lib/i18n, since content is free-form copy, not a fixed set of keys).
  changelogEntries: defineTable({
    type: v.union(v.literal("FEATURE"), v.literal("FIX"), v.literal("IMPROVEMENT")),
    titleEn: v.string(),
    titleAr: v.string(),
    descriptionEn: v.string(),
    descriptionAr: v.string(),
    publishedAt: v.number(),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
    updatedBy: v.optional(v.id("users")),
  })
    .index("by_publishedAt", ["publishedAt"]),

  // Published native builds of the Expo mobile app, for the APK-fallback
  // updater. Only NATIVE builds live here (a new APK the user sideloads) —
  // JS-only changes ship over-the-air via expo-updates and never touch this
  // table. The app compares its own buildNumber to the newest row's and, when
  // behind, prompts the user to download the APK.
  mobileAppReleases: defineTable({
    platform: v.union(v.literal("ANDROID"), v.literal("IOS")),
    // Monotonic build ordinal — higher means newer. A numeric compare, so 12
    // always beats 9 (unlike a naive string compare of "1.10" vs "1.9").
    buildNumber: v.number(),
    versionName: v.string(), // human label, e.g. "1.4.0"
    runtimeVersion: v.string(),
    apkUrl: v.string(), // self-hosted signed APK (Huawei has no Play Store)
    releaseNotesEn: v.optional(v.string()),
    releaseNotesAr: v.optional(v.string()),
    mandatory: v.optional(v.boolean()),
    createdBy: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_platform_build", ["platform", "buildNumber"]),

  // Expo push tokens for the native app, one row per user per device. Distinct
  // from pushSubscriptions (browser Web Push / VAPID) and from
  // marketplaceBuyerPushTokens (anonymous buyers keyed by publicId). Granting
  // the OS notification permission and registering a token here IS the mobile
  // push opt-in — delivery to these is not gated by the web `pushEnabled`
  // preference. NOTE: Expo delivers Android push via FCM, so it does not reach
  // devices without Google Play Services (e.g. Huawei/HMS).
  mobilePushTokens: defineTable({
    userId: v.id("users"),
    token: v.string(), // ExponentPushToken[...]
    platform: v.union(v.literal("IOS"), v.literal("ANDROID")),
    deviceName: v.optional(v.string()),
    createdAt: v.number(),
    lastSeenAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_token", ["token"]),
};
