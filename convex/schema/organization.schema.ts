import { defineTable } from "convex/server";
import { v } from "convex/values";

const organizationDeletionRequestStatus = v.union(
  v.literal("PENDING_REVIEW"),
  v.literal("REJECTED"),
  v.literal("APPROVED"),
  v.literal("RUNNING"),
  v.literal("COMPLETED"),
  v.literal("FAILED")
);

export const organizationTables = {
  users: defineTable({
    clerkId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    disabled: v.optional(v.boolean()),
    disabledAt: v.optional(v.number()),
    disabledReason: v.optional(v.string()),
    clerkDeletedAt: v.optional(v.number()),
    // Server-known language for email/WhatsApp notifications — the client's
    // locale toggle (LanguageProvider) lives only in localStorage, so this
    // mirrors it server-side whenever an authenticated user changes it.
    locale: v.optional(v.union(v.literal("en"), v.literal("ar"))),
    // Staff member's own WhatsApp number for receiving notifications —
    // distinct from customers.whatsapp (a customer's contact number).
    whatsappPhone: v.optional(v.string()),
  }).index("by_clerkId", ["clerkId"])
    .index("by_email", ["email"]),

  organizations: defineTable({
    name: v.string(),
    createdAt: v.number(),
    suspended: v.optional(v.boolean()),
    suspendedAt: v.optional(v.number()),
    suspendedReason: v.optional(v.string()),
    deletionRequestedAt: v.optional(v.number()),
    deletionRequestId: v.optional(v.id("organizationDeletionRequests")),
    /**
     * SCRUM-297 — WHEN DESTRUCTIVE PURGE BECAME IRREVERSIBLE FOR THIS ORG.
     *
     * Written once, in the same transaction as and strictly BEFORE the first
     * destructive step of a purge run. Its PRESENCE — never its value, and
     * never a deletion request's `status` — forbids returning the dealership to
     * service. Destruction outlives the status that described it: a purge that
     * throws marks the *request* FAILED and leaves the organization row alone,
     * and FAILED is not in `ACTIVE_DELETION_STATUSES`, so a status-based guard
     * reads "no purge in flight" over a half-destroyed dealership.
     *
     * ⚠️ NOT DERIVED FROM `deletedCounts`. Counts are patched only AFTER a step
     * returns, while `runDeletionRequestBatch`'s catch block returns normally
     * and therefore COMMITS — a step throwing mid-loop commits up to a full
     * batch of deletions while recording zero counts. A marker derived from
     * them reports "nothing destroyed" after real destruction. This one is
     * written ahead of the delete, so deletions without the marker require a
     * transaction abort, which discards those deletions too.
     *
     * ⚠️ NOTHING CLEARS IT. The field disappears only with the organization row
     * itself, at the end of a completed purge, when there is no longer anything
     * to reactivate.
     *
     * ⚠️ AND A FIELD NOTHING CLEARS IS NOT A GUARD. An earlier version of this
     * comment argued the field was safe because `rejectDeletionRequest` only
     * runs from PENDING_REVIEW and so never meets it. True about the request
     * being rejected, and beside the point: an organization accumulates
     * deletion requests over time, so a fresh PENDING_REVIEW one carries no
     * evidence about an EARLIER purge that already destroyed command authority.
     * `rejectDeletionRequest` cleared `suspended` without reading this field at
     * all. Both former writers now delegate to `reactivateOrganization`, the
     * single function allowed to clear suspension, which reads this field
     * first. `scripts/organizationReactivationGuard.test.ts` catches other code
     * assigning `suspended` a value it cannot prove is `true` — ⚠️ but ONLY for
     * the write shapes it recognises. That detector is explicitly NON-EXHAUSTIVE
     * (owner ruling, SCRUM-297, 2026-09-08): it cannot see `db.replace` clearing
     * the field by omission, the three-argument table-name API, aliases of
     * `ctx.db`, or table-scoped writers. What enforces this invariant is the
     * single fused writer plus `convex/orgPurgeLifecycle.scrum297.test.ts`,
     * which proves by execution that a partially purged organization cannot be
     * returned to service. Do not read a green ratchet as proof of absence.
     *
     * The legal transitions once set are: resume the purge, or complete it.
     * Restoring a partially purged organization is NOT a product requirement
     * (owner ruling 2026-09-07); if it ever becomes one it needs a reviewed
     * reconciliation protocol, not the removal of this field.
     */
    destructivePurgeStartedAt: v.optional(v.number()),
    /**
     * SCRUM-208 — WHICH COMMITMENT AUTHORITY THIS DEALERSHIP RUNS ON.
     *
     * Canonical-state admission is ONE per-org rule, not per-field `undefined`
     * semantics reinvented on every column. Before activation the canonical
     * access paths are simply not consulted for authority; after it, a missing
     * canonical field is CORRUPTION rather than a default.
     *
     *   undefined | 0  → legacy
     *   1              → canonical V1
     *   anything else  → REFUSE
     *
     * ⚠️ AN UNSUPPORTED VERSION IS REFUSED, NEVER CLAMPED. "Unknown, so treat
     * it as the newest I know" is how a half-deployed backend silently grants
     * itself authority it was never activated for. Activation is per org, so a
     * cross-tenant sweep legitimately meets both legacy and canonical rows in
     * one batch — that is normal, and never a reason to fail the batch.
     */
    commitmentAuthorityVersion: v.optional(v.number()),
    /** SCRUM-563 — financial reset counters; absent means 0. Protocol: `convex/utils/orgResetGeneration.ts`. */
    financialResetGeneration: v.optional(v.number()),
    financialResetCompletedGeneration: v.optional(v.number()),
    /** Bounded destructive-cleanup continuations; usable only while suspended. */
    openingCleanupPayableScan: v.optional(v.object({
      resetGeneration: v.number(), cursor: v.union(v.string(), v.null()), complete: v.boolean(),
      pendingDraftIds: v.array(v.id("openingBalanceDrafts")),
      pendingPayableIds: v.array(v.id("vehicleSupplierPayables")),
    })),
    openingCleanupReferenceScan: v.optional(v.object({
      resetGeneration: v.number(), cursor: v.union(v.string(), v.null()), complete: v.boolean(),
      source: v.union(
        v.object({ table: v.literal("openingCommissionLiabilities"), id: v.id("openingCommissionLiabilities") }),
        v.object({ table: v.literal("supplierCostRecoveries"), id: v.id("supplierCostRecoveries") }),
        v.object({ table: v.literal("vehicleSupplierPayables"), id: v.id("vehicleSupplierPayables") }),
      ),
    })),
    /** Incremented whenever journal/period facts or BANK_ACCOUNT mapping change. */
    bankAggregateMappingGeneration: v.optional(v.number()),
  }),

  organizationDeletionRequests: defineTable({
    orgId: v.id("organizations"),
    orgName: v.string(),
    requestedBy: v.id("users"),
    requestedAt: v.number(),
    reason: v.optional(v.string()),
    status: organizationDeletionRequestStatus,
    reviewedBy: v.optional(v.id("users")),
    reviewedAt: v.optional(v.number()),
    reviewNotes: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    failedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    currentStepIndex: v.optional(v.number()),
    deletedCounts: v.optional(v.record(v.string(), v.number())),
    lastProcessedAt: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_status_and_requestedAt", ["status", "requestedAt"]),

  commandIdempotency: defineTable({
    orgId: v.id("organizations"),
    operation: v.string(),
    idempotencyKey: v.string(),
    status: v.union(v.literal("STARTED"), v.literal("COMPLETED")),
    result: v.optional(v.any()),
    // Canonical hash of the request inputs. When present, replaying the same
    // key with materially different inputs is rejected instead of silently
    // returning the prior result.
    fingerprint: v.optional(v.string()),
    /** SCRUM-563. The org's `financialResetGeneration` at write time (absent = 0); see `utils/orgResetGeneration.ts`. */
    resetGeneration: v.optional(v.number()),
    createdBy: v.optional(v.id("users")),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_org_operation_key", ["orgId", "operation", "idempotencyKey"])
    .index("by_org_createdAt", ["orgId", "createdAt"]),

  // Deployment-wide completion history, not tenant data. Internal role migrations
  // record completion with their final page so later rollouts preserve owner choices.
  roleMigrationRuns: defineTable({
    migration: v.string(),
    completedAt: v.number(),
  }).index("by_migration", ["migration"]),

  roles: defineTable({
    orgId: v.id("organizations"), // Roles are scoped to orgs allowing custom roles
    name: v.string(), // "OWNER", "SALES", etc.
    permissions: v.array(v.string()),
    appliedRoleMigrations: v.optional(v.array(v.string())),
    isSystemOwnerRole: v.optional(v.boolean()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  }).index("by_org", ["orgId"]),

  memberships: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    roleId: v.id("roles"),
    branchId: v.optional(v.id("branches")),
    commissionRate: v.optional(v.number()), // % of gross profit per sale
    impersonationGrantId: v.optional(v.id("impersonationGrants")), // set when this membership exists only for an active super-admin impersonation session
    offboardingStatus: v.optional(
      v.union(v.literal("PENDING_EXTERNAL_REMOVAL"), v.literal("EXTERNAL_REMOVAL_RETRYING"))
    ),
    offboardingRequestedAt: v.optional(v.number()),
    offboardingRequestedBy: v.optional(v.id("users")),
    offboardingAttempts: v.optional(v.number()),
    offboardingLastAttemptAt: v.optional(v.number()),
    offboardingLastError: v.optional(v.string()),
    offboardingNextRetryAt: v.optional(v.number()),
    // "Last seen" timestamp for the Team > Members presence indicator. Written
    // by memberships.touchLastSeen, throttled client-side (PresenceTracker)
    // and server-side to a few writes per user per hour — deliberately NOT a
    // live heartbeat/interval, to avoid repeating the liveChatPresence cost
    // (see convex/schema.ts liveChatPresence comment) on a much lower-value feature.
    lastSeenAt: v.optional(v.number()),
    // Opts this member out of the generated-lead round robin (social, website,
    // WhatsApp, marketplace trade-ins). They keep every lead already assigned
    // to them and can still be assigned one by hand — this only removes them
    // from automatic distribution, for someone on leave, a manager who holds
    // the SALES role for reporting, or a rep who shouldn't take new work.
    excludeFromLeadAutoAssignment: v.optional(v.boolean()),
  })
    .index("by_user", ["userId"])
    .index("by_org", ["orgId"])
    .index("by_org_user", ["orgId", "userId"])
    .index("by_org_role", ["orgId", "roleId"]),

  membershipOffboardingJobs: defineTable({
    membershipId: v.id("memberships"),
    orgId: v.id("organizations"),
    userId: v.id("users"),
    clerkId: v.string(),
    requestedBy: v.id("users"),
    requiresClerkUserDeletion: v.boolean(),
    status: v.union(v.literal("PENDING"), v.literal("RETRYING"), v.literal("SUCCEEDED")),
    attempts: v.number(),
    nextAttemptAt: v.number(),
    lastAttemptAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    succeededAt: v.optional(v.number()),
  })
    .index("by_membership", ["membershipId"])
    .index("by_status_and_nextAttemptAt", ["status", "nextAttemptAt"])
    .index("by_org", ["orgId"]),

  // Cross-tenant, super-admin–only table. A single user deletion can span
  // multiple orgs; orgId is optional (null = global event). All access paths
  // must go through requireSuperAdmin — never exposed to org-scoped queries.
  userOffboardingReviews: defineTable({
    orgId: v.optional(v.id("organizations")),
    userId: v.id("users"),
    clerkId: v.string(),
    source: v.union(v.literal("clerk_user_deleted"), v.literal("admin_requested")),
    status: v.union(v.literal("PENDING_REVIEW"), v.literal("RESOLVED")),
    membershipCount: v.number(),
    ownerOrgIds: v.array(v.id("organizations")),
    createdAt: v.number(),
    resolvedAt: v.optional(v.number()),
    resolvedBy: v.optional(v.id("users")),
    notes: v.optional(v.string()),
  })
    .index("by_org_status", ["orgId", "status"])
    .index("by_status", ["status"])
    .index("by_user", ["userId"])
    .index("by_user_status", ["userId", "status"]),

  invitations: defineTable({
    orgId: v.id("organizations"),
    email: v.string(),
    roleId: v.id("roles"),
    createdBy: v.optional(v.id("users")),
    ownerRoleAuthorizedAt: v.optional(v.number()),
    tokenHash: v.optional(v.string()),
    status: v.optional(
      v.union(v.literal("PENDING"), v.literal("ACCEPTED"), v.literal("EXPIRED"), v.literal("REVOKED"))
    ),
    source: v.optional(v.union(v.literal("EMAIL_INVITE"), v.literal("DIRECT_ACCOUNT"))),
    expiresAt: v.optional(v.number()),
    acceptedAt: v.optional(v.number()),
    acceptedBy: v.optional(v.id("users")),
    updatedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_email", ["email"])
    .index("by_org_email", ["orgId", "email"])
    .index("by_tokenHash", ["tokenHash"])
    .index("by_status_and_expiresAt", ["status", "expiresAt"]),

  branches: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    address: v.optional(v.string()),
    phone: v.optional(v.string()),
    // Extra numbers for this branch (mobile lines, additional sales staff, etc.)
    // shown alongside `phone` on the public dealer website.
    additionalPhones: v.optional(v.array(v.string())),
    managerId: v.optional(v.id("users")),
    isActive: v.boolean(),
  })
    .index("by_org", ["orgId"]),
};
