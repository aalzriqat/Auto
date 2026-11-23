import { defineTable } from "convex/server";
import { v } from "convex/values";

export const platformOperationsTables = {
  feedback: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    type: v.union(v.literal("BUG"), v.literal("FEATURE")),
    title: v.string(),
    description: v.optional(v.string()),
    url: v.optional(v.string()),
    status: v.union(v.literal("OPEN"), v.literal("CLOSED")),
    createdAt: v.number(),
    adminReply: v.optional(v.string()),
    adminRepliedAt: v.optional(v.number()),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_user", ["orgId", "userId"])
    .index("by_org_user_type", ["orgId", "userId", "type"])
    .index("by_org_user_status", ["orgId", "userId", "status"])
    .index("by_org_user_type_status", ["orgId", "userId", "type", "status"])
    .index("by_status", ["status"]),

  // ─── Subscription plans ────────────────────────────────────────────────────

  subscriptions: defineTable({
    orgId: v.id("organizations"),
    plan: v.union(
      v.literal("free"),
      v.literal("starter"),
      v.literal("professional"),
      v.literal("enterprise")
    ),
    status: v.union(
      v.literal("active"),     // on free plan or paying subscriber
      v.literal("past_due"),   // payment failed
      v.literal("cancelled"),  // cancelled; access until period end
      v.literal("expired"),    // paid plan lapsed, back to free
    ),
    billingInterval: v.optional(v.union(v.literal("monthly"), v.literal("annual"))),
    currentPeriodStart: v.optional(v.number()),
    currentPeriodEnd: v.optional(v.number()),
    renewalReminderSentAt: v.optional(v.number()),
    cancelledAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_status_period_end", ["status", "currentPeriodEnd"])
    // `plan` sits BEFORE `currentPeriodEnd` so the expiry sweep can exclude free
    // rows through the index instead of `.filter()`. A filter still scans and
    // charges every discarded document, and a Convex transaction is capped at
    // 32,000 scanned documents — so enough free rows carrying a stale period end
    // would abort the query before `.take()` ever reached a lapsed paid row, and
    // abort it again on every subsequent run (SCRUM-145).
    .index("by_status_plan_period_end", ["status", "plan", "currentPeriodEnd"]),

  // ─── Super-admin dashboard (cross-tenant, /admin) ──────────────────────────

  adminAuditLog: defineTable({
    actorUserId: v.id("users"),
    actorEmail: v.string(),
    action: v.string(),
    targetTable: v.optional(v.string()),
    targetId: v.optional(v.string()),
    orgId: v.optional(v.id("organizations")),
    before: v.optional(v.any()),
    after: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_org", ["orgId"]),

  cronHeartbeats: defineTable({
    jobName: v.string(),
    ranAt: v.number(),
    success: v.boolean(),
    detail: v.optional(v.string()),
  })
    // ranAt is part of the key so "newest heartbeat for this job" is a single
    // indexed read rather than a scan-and-max over the whole table.
    .index("by_job_ranAt", ["jobName", "ranAt"])
    // Retention sweeps delete by age; without this they would scan the table
    // they exist to keep small.
    .index("by_ranAt", ["ranAt"]),

  webhookLogs: defineTable({
    source: v.union(
      v.literal("clerk"),
      v.literal("whatsapp"),
      v.literal("resend"),
      v.literal("instagram-oauth"),
      v.literal("instagram"),
      v.literal("facebook-oauth"),
      v.literal("facebook"),
      v.literal("notification-email"),
      v.literal("notification-whatsapp"),
      v.literal("notification-push"),
      v.literal("subscription-reminder"),
      v.literal("support-inbox-notification"),
      v.literal("upgrade-request"),
      v.literal("social-auto-reply-retry"),
      v.literal("fixed-asset-depreciation"),
      v.literal("fi-commission-recognition"),
      v.literal("prepaid-expense-amortization"),
      v.literal("marketplace-weekly-report"),
      v.literal("marketplace-whatsapp"),
      // SCRUM-302: the payment provider webhook. It had no durable log at all,
      // so a settlement refused on organization-lifecycle grounds would have
      // left no evidence that a real provider fact had arrived.
      v.literal("payment")
    ),
    status: v.union(v.literal("received"), v.literal("success"), v.literal("error"), v.literal("dead_letter")),
    summary: v.string(),
    eventId: v.optional(v.string()),
    payloadSha256: v.optional(v.string()),
    rawPayload: v.optional(v.string()),
    payloadPreview: v.optional(v.string()),
    payloadTruncated: v.optional(v.boolean()),
    receiveCount: v.optional(v.number()),
    lastReceivedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_source_and_eventId", ["source", "eventId"])
    .index("by_status_createdAt", ["status", "createdAt"]),

  // Temporary, audited "act as a specific real member" access for super
  // admins: same real-membership-grant pattern as supportOrgAccessGrants
  // above, but grants the target member's exact role rather than a fixed
  // OWNER role. See convex/adminImpersonation.ts.
  impersonationGrants: defineTable({
    actorUserId: v.id("users"), // the super admin
    targetUserId: v.id("users"), // the real member being impersonated
    orgId: v.id("organizations"),
    membershipId: v.id("memberships"), // the temp membership created for actorUserId
    reason: v.string(),
    grantedAt: v.number(),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_actorUserId", ["actorUserId"])
    .index("by_orgId", ["orgId"]),

  // ─── Global site configuration (super-admin controlled) ───────────────────
  // Key-value store for platform-level settings that apply across all orgs.
  // Examples: showPlanPricing (bool), supportNotifyEmails (string[]).
  siteConfig: defineTable({
    key: v.string(),
    value: v.any(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // ─── E2E preview bootstrap marker (SCRUM-143) ───────────────────────────
  //
  // At most one row, and its only writer is `e2eBootstrap:markPreviewDeployment`.
  //
  // ⚠️ THE ROW'S PRESENCE IS AN AUTHORIZATION, so read what actually mints it.
  // The Convex CLI runs that mutation through the deploy command's
  // `--preview-run` hook, and that hook is *ignored* unless the target is a
  // newly-claimed PREVIEW deployment — it is reachable only from the preview
  // branch of the CLI's deploy path. On production, and on a personal dev
  // deployment, this table therefore stays empty forever, and
  // `e2eBootstrap:bootstrapE2EOrganization` refuses to write anything at all
  // without a row here.
  //
  // `convexCloudUrl` is recorded so a marker vouches for exactly ONE
  // deployment. Without it a snapshot import could carry a preview's marker
  // into a real deployment and hand it an authorization it never earned.
  e2ePreviewBootstrap: defineTable({
    markedAt: v.number(),
    convexCloudUrl: v.optional(v.string()),
    /** Set once `bootstrapE2EOrganization` has seeded the QA dealership. */
    orgId: v.optional(v.id("organizations")),
    bootstrappedAt: v.optional(v.number()),
  }),
};
