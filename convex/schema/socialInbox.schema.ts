import { defineTable } from "convex/server";
import { v } from "convex/values";

const socialEventReplyFields = {
  vehicleMatchHintText: v.optional(v.string()),
  vehicleMatchHintSource: v.optional(v.union(v.literal("message"), v.literal("post"))),
  autoRepliedAt: v.optional(v.number()),
  autoReplyText: v.optional(v.string()),
  autoReplySource: v.optional(v.union(v.literal("smart"), v.literal("canned"))),
  pendingAutoReplyText: v.optional(v.string()),
  pendingAutoReplySource: v.optional(v.union(v.literal("smart"), v.literal("canned"))),
  pendingAutoReply: v.optional(v.boolean()),
  pendingAutoReplyChannel: v.optional(v.union(v.literal("comment"), v.literal("dm"))),
  autoReplyRetryCount: v.optional(v.number()),
  manualReplyText: v.optional(v.string()),
  manualRepliedAt: v.optional(v.number()),
  manualRepliedByUserId: v.optional(v.id("users")),
  manualReplyAiDraftId: v.optional(v.id("aiDrafts")),
};

export const socialInboxTables = {
  // SCRUM-949: a polymorphic contact index. `scope` is an organization or
  // user id. User contacts join organizations through the member source rows;
  // customer fields never enter this index. Source rows make rebuilds idempotent.
  socialOwnNumberSources: defineTable({
    key: v.string(),
    scope: v.string(),
    kind: v.union(v.literal("contact"), v.literal("member"), v.literal("join"), v.literal("ready"), v.literal("migration")),
    phones: v.array(v.string()),
    memberOrgId: v.optional(v.id("organizations")),
    membershipId: v.optional(v.id("memberships")),
    joinComplete: v.optional(v.boolean()),
    snapshotId: v.optional(v.id("websitePublishSnapshots")),
    migrationTable: v.optional(v.number()),
    repairQueueVersion: v.optional(v.number()),
    repairQueueCursor: v.optional(v.string()),
    migrationCursor: v.optional(v.string()),
    migrationMemberId: v.optional(v.id("memberships")),
    migrationMemberCursor: v.optional(v.string()),
    migrationMemberNextCursor: v.optional(v.string()),
    migrationMemberNextDone: v.optional(v.boolean()),
    retryAt: v.optional(v.number()),
    retryAttempts: v.optional(v.number()),
  }).index("by_key", ["key"])
    .index("by_scope_kind", ["scope", "kind"])
    .index("by_memberOrg", ["memberOrgId"])
    .index("by_membership_kind", ["membershipId", "kind"])
    .index("by_snapshot", ["snapshotId"]),

  socialOwnNumberCounts: defineTable({
    scope: v.string(),
    phone: v.string(),
    references: v.number(),
  }).index("by_scope_phone", ["scope", "phone"])
    .index("by_scope", ["scope"]),

  // Operational repair state is separate from the contact contribution ledger.
  socialOwnNumberRepairs: defineTable({
    key: v.string(),
    scope: v.string(),
    priority: v.number(), // recount users/orgs (0/1), retry users/orgs (2/3), blocked (4), source (5)
    phase: v.union(v.literal("clear"), v.literal("recount"), v.literal("retry"), v.literal("blocked")),
    cursor: v.optional(v.string()),
    attempts: v.optional(v.number()),
    nextAttemptAt: v.optional(v.number()),
    retryTable: v.optional(v.string()),
    retryId: v.optional(v.string()),
  }).index("by_key", ["key"])
    .index("by_priority", ["priority"])
    .index("by_nextAttemptAt_priority", ["nextAttemptAt", "priority"])
    .index("by_scope", ["scope"])
    .index("by_scope_priority", ["scope", "priority"]),

  oauthStates: defineTable({
    orgId: v.id("organizations"),
    state: v.string(),
    provider: v.union(v.literal("instagram"), v.literal("facebook")),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_state", ["state"])
    .index("by_org", ["orgId"]),

  // SCRUM-841: per-Facebook-user revocation fence. Meta's signed deauthorize and
  // data-deletion callbacks record when a user revoked access, even if that user
  // has no org row yet. An OAuth attempt begun at or before `revokedAt` is
  // refused when it tries to store pending Page credentials, so a callback that
  // lands while the attempt is in flight cannot be undone by it. One row per
  // user, keyed by Facebook user id (not org-scoped, so the org hard-delete does
  // not touch it). `facebookUserId` is a Facebook user identifier, i.e. personal
  // data; the row holds that id and a timestamp only — no tokens and no other
  // user content. It is retained deliberately as a security
  // record: a data-deletion request writes it rather than erasing it, since it is
  // what stops an in-flight connection undoing that request. Since SCRUM-807
  // nothing deletes it (operational records are preserved); correctness does not
  // depend on removal (see utils/facebookRevocation.ts).
  facebookRevocations: defineTable({
    facebookUserId: v.string(),
    revokedAt: v.number(),
  })
    .index("by_facebook_user_id", ["facebookUserId"])
    .index("by_revoked_at", ["revokedAt"]),

  instagramEvents: defineTable({
    orgId: v.id("organizations"),
    externalId: v.string(),
    kind: v.union(v.literal("comment"), v.literal("dm")),
    senderInstagramId: v.string(),
    senderUsername: v.optional(v.string()),
    customerId: v.optional(v.id("customers")),
    leadId: v.optional(v.id("leads")),
    vehicleId: v.optional(v.id("vehicles")),
    text: v.optional(v.string()),
    postId: v.optional(v.string()),
    ...socialEventReplyFields,
  })
    .index("by_org_external", ["orgId", "externalId"])
    .index("by_org_sender", ["orgId", "senderInstagramId"])
    .index("by_org", ["orgId"])
    .index("by_org_lead", ["orgId", "leadId"])
    .index("by_org_customer", ["orgId", "customerId"])
    .index("by_org_customer_kind", ["orgId", "customerId", "kind"])
    .index("by_pending_reply", ["pendingAutoReply"]),

  facebookEvents: defineTable({
    orgId: v.id("organizations"),
    externalId: v.string(),
    kind: v.union(v.literal("comment"), v.literal("dm")),
    senderFacebookId: v.string(),
    senderName: v.optional(v.string()),
    customerId: v.optional(v.id("customers")),
    leadId: v.optional(v.id("leads")),
    vehicleId: v.optional(v.id("vehicles")),
    text: v.optional(v.string()),
    postId: v.optional(v.string()),
    sourceSurface: v.optional(v.union(v.literal("post"), v.literal("reel"), v.literal("story"), v.literal("ad"), v.literal("unknown"))),
    ...socialEventReplyFields,
  })
    .index("by_org_external", ["orgId", "externalId"])
    .index("by_org_sender", ["orgId", "senderFacebookId"])
    .index("by_org", ["orgId"])
    .index("by_org_lead", ["orgId", "leadId"])
    .index("by_org_customer", ["orgId", "customerId"])
    .index("by_org_customer_kind", ["orgId", "customerId", "kind"])
    .index("by_pending_reply", ["pendingAutoReply"]),

  /**
   * One row per distinct social sender the org has ever heard from, per
   * platform. Exists solely so `socialInbox.platformStats` can report
   * "unique contacts" without reading every event row to build a Set.
   *
   * A distinct count is the one question a `TableAggregate` cannot answer: it
   * counts keys, not distinct values of a key. Materialising each distinct
   * sender as its own row turns that question back into a plain count, which
   * `socialContactsByOrg` then answers off the B-tree.
   *
   * Keyed on the raw platform id (`senderInstagramId` / `senderFacebookId`),
   * NOT on `customerId`. The two are 1:1 at ingest, but a customer merge
   * repoints several senders at one customer row — counting customers would
   * silently under-report exactly the orgs that have tidied their contacts,
   * and the Set this replaces counted senders.
   */
  socialContacts: defineTable({
    orgId: v.id("organizations"),
    platform: v.union(v.literal("instagram"), v.literal("facebook")),
    senderRawId: v.string(),
  })
    // Point lookup for the insert-if-absent path on every inbound event.
    .index("by_org_platform_sender", ["orgId", "platform", "senderRawId"])
    .index("by_org", ["orgId"]),

  /**
   * One row per Social Inbox conversation thread — the unit the inbox list
   * actually displays, materialised so it can be paginated.
   *
   * `socialInbox.listConversations` derived these by `.collect()`-ing every
   * Instagram and Facebook event the org had ever received and grouping them in
   * JavaScript: a live subscription over the tables ingestion writes to, so
   * every inbound message made it re-read the whole history. A conversation is
   * not a row, so there was nothing to paginate — the "cursor" was an offset
   * into an in-memory array and each page re-scanned everything.
   *
   * ## Grouping key
   *
   * `conversationKey` is the exact string the old grouping used, so the split
   * is unchanged: comments thread per (platform × customer × post), DMs per
   * (platform × customer). Stored rather than recomputed so the upsert is one
   * indexed point lookup.
   *
   * ⚠️ The key's inputs are MUTATED after insert — `socialInboxBackfill`
   * patches `postId`, and a customer merge repoints `customerId`. So the
   * maintenance path must handle RE-KEYING, not just insert and delete.
   *
   * ## Why the denormalised fields are here
   *
   * `lastEventAt` is the sort key — the list orders by most recent activity, so
   * it has to be indexed, not computed. The rest (`latestText`, the sender
   * fields, `eventCount`, `unansweredCount`, `vehicleIds`, `leadId`) are what a
   * row renders; keeping them here is what lets a page read 25 small rows
   * instead of every event in the org.
   *
   * `unansweredCount` is a count, not the `needsReply` boolean the UI wants,
   * because a boolean cannot be maintained: answering one event tells you
   * nothing about whether the others are still unanswered. `needsReply` is
   * `unansweredCount > 0`.
   *
   * `vehicleIds` is the distinct set in first-seen order, because the list
   * shows both a count of linked vehicles and a summary of the first one.
   */
  socialConversations: defineTable({
    orgId: v.id("organizations"),
    /**
     * The materialisation shape this row was written under.
     *
     * The readiness record is generation-scoped, but that only fences the
     * *claim*; without this field it could not fence the *data* the claim
     * authorises. `SOCIAL_CONVERSATION_GENERATION` must be bumped whenever
     * `conversationKey` changes meaning — and on that bump the old keys do not
     * collide with the new ones, so nothing overwrites them and no backfill
     * ever visits them again. They would simply sit in the table until the new
     * generation reached `completed` and then be served as real threads.
     *
     * Stamping the generation onto the row makes that impossible: the reader
     * selects one generation, and superseded rows become inert garbage that can
     * be swept whenever, by anything, with no correctness deadline.
     *
     * ⚠️ This fences generation-mismatched rows, NOT same-generation orphans.
     * A row whose thread still exists under the current scheme is only ever
     * corrected by a write to that thread, so a bulk writer that patches events
     * without collecting every thread it touched still leaves a stale row this
     * cannot see. That risk lived in the writer, and is now structural: the deferred
     * writer records every thread a write touches and `socialBulkMutation`
     * recomputes them automatically, so a bulk handler has no settlement step to
     * omit.
     */
    generation: v.number(),
    conversationKey: v.string(),
    platform: v.union(v.literal("instagram"), v.literal("facebook")),
    conversationKind: v.union(v.literal("comment"), v.literal("dm")),
    conversationPostId: v.optional(v.string()),
    customerId: v.id("customers"),
    lastEventAt: v.number(),
    eventCount: v.number(),
    unansweredCount: v.number(),
    vehicleIds: v.array(v.id("vehicles")),
    // `vehicleIds.length`, stored: Convex's filter expressions cannot measure an
    // array, and the "has a linked vehicle" filter has to run inside the
    // paginated read rather than after it.
    vehicleCount: v.number(),
    leadId: v.optional(v.id("leads")),
    latestText: v.optional(v.string()),
    latestSenderHandle: v.optional(v.string()),
    latestSenderRawId: v.string(),
  })
    // Upsert path: resolve a thread from an event in one lookup.
    .index("by_org_generation_key", ["orgId", "generation", "conversationKey"])
    // The list itself — descending gives most-recent-activity order directly.
    .index("by_org_generation_lastEventAt", ["orgId", "generation", "lastEventAt"])
    // The two filters the inbox offers as first-class controls; the rest
    // (hasVehicle, needsReply) are evaluated against the paginated stream,
    // which reads these small rows rather than the events behind them.
    .index("by_org_generation_platform_lastEventAt", [
      "orgId",
      "generation",
      "platform",
      "lastEventAt",
    ])
    .index("by_org_generation_kind_lastEventAt", [
      "orgId",
      "generation",
      "conversationKind",
      "lastEventAt",
    ])
    // Deliberately NOT generation-scoped, and the only index that must not be:
    // teardown has to reach every row an org owns, including rows left behind
    // by superseded generations. A purge that walked the current generation
    // alone would report a clean org while leaving its customer messages
    // behind — which is the failure this index exists to prevent, not an
    // optimisation.
    .index("by_org_lastEventAt", ["orgId", "lastEventAt"]),

  /**
   * Whether `socialConversations` may be trusted as the authoritative source
   * for one org and platform.
   *
   * This table exists because of a real production incident (SCRUM-20). The
   * materialised reader was deployed while the table behind it was still empty,
   * and the Social Inbox answered "no conversations" with total confidence for
   * an org holding a thousand events. Code and schema existing is not evidence
   * that the data behind them exists, so readiness has to be recorded durably
   * rather than inferred — and it cannot be inferred from row counts either,
   * because zero conversations is a legitimate completed result for a quiet org.
   *
   * One row per (org, generation, platform). Absence means NOT STARTED, which
   * is why the reader treats a missing row as "not ready" rather than as an
   * empty result: fail closed toward the slow-but-correct legacy path.
   *
   * `generation` is what stops an old completed backfill from vouching for a
   * newer materialisation shape. Bump `SOCIAL_CONVERSATION_GENERATION` whenever
   * the meaning of a `socialConversations` row changes, and every reader falls
   * back until the new generation is proven complete.
   */
  socialMaterializationState: defineTable({
    orgId: v.id("organizations"),
    platform: v.union(v.literal("instagram"), v.literal("facebook")),
    generation: v.number(),
    // No "notStarted": that is the absence of the row. No "interrupted"
    // either — an abandoned chain leaves `running` with a stale
    // `lastProgressAt`, and interruption is derived from that rather than
    // stored, because the process that would have written it is by definition
    // the one that died.
    status: v.union(v.literal("running"), v.literal("completed"), v.literal("failed")),
    // Fences concurrent chains: a scheduled continuation carries the runId it
    // was started under and aborts if the record has moved on to another.
    runId: v.string(),
    cursor: v.optional(v.string()),
    // Source rows read, and threads recomputed. Deliberately distinct: a batch
    // of 250 events belonging to 3 threads processes 250 and materialises 3,
    // and collapsing them would make "0 changed" indistinguishable from
    // "0 examined".
    processedCount: v.number(),
    materializedCount: v.number(),
    // The aggregate's event count at the last progress write. A progress
    // indicator only — never the completion criterion, which is pagination
    // exhaustion. Events arriving mid-run move this number.
    expectedCount: v.number(),
    startedAt: v.number(),
    lastProgressAt: v.number(),
    completedAt: v.optional(v.number()),
    failureMessage: v.optional(v.string()),
  })
    .index("by_org_generation_platform", ["orgId", "generation", "platform"])
    .index("by_org", ["orgId"]),

  // Full Messenger thread: one row per message (in or out), enabling complete
  // conversation history including messages sent before AutoFlow existed.
  facebookMessages: defineTable({
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    direction: v.union(v.literal("in"), v.literal("out")),
    text: v.optional(v.string()),
    timestamp: v.number(),
    fbMessageId: v.string(),
    fbConversationId: v.optional(v.string()),
    sentByUserId: v.optional(v.id("users")),
  })
    .index("by_org", ["orgId"])
    .index("by_org_customer_ts", ["orgId", "customerId", "timestamp"])
    .index("by_org_fb_message", ["orgId", "fbMessageId"]),

  socialPosts: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    platform: v.union(v.literal("instagram"), v.literal("facebook")),
    status: v.union(v.literal("PENDING"), v.literal("PUBLISHED"), v.literal("FAILED")),
    caption: v.optional(v.string()),
    imageStorageIds: v.array(v.id("_storage")),
    externalPostId: v.optional(v.string()),
    externalPermalink: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    triggeredBy: v.union(v.literal("manual"), v.literal("auto")),
    requestedBy: v.id("users"),
    requestedAt: v.number(),
    publishedAt: v.optional(v.number()),
    likeCount: v.optional(v.number()),
    commentsCount: v.optional(v.number()),
    engagementSyncedAt: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_vehicle", ["orgId", "vehicleId"])
    .index("by_external_post_id", ["externalPostId"]),
};
