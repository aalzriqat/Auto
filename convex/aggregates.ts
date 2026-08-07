import { TableAggregate } from "@convex-dev/aggregate";
import { Triggers } from "convex-helpers/server/triggers";
import type { GenericDatabaseWriter } from "convex/server";
import { components } from "./_generated/api";
import { DataModel, Doc, Id } from "./_generated/dataModel";
import { validateVinChecksum } from "../lib/vinHelpers";

/**
 * Maintained counts for vehicles, so the dashboard can answer "how many" and
 * "how old" without reading the rows.
 *
 * `vehicles.getAgingBuckets` used to iterate every AVAILABLE vehicle's full
 * document to build a four-bucket histogram. Per Convex's own per-function
 * breakdown it was 1.19 GB of database bandwidth.
 *
 * ## What this does and does not buy
 *
 * It cuts the *bytes read per execution*, not the number of executions. The
 * B-tree's interior nodes are themselves documents, so a write that patches a
 * node inside a range the query reads still invalidates the subscription — the
 * dashboard re-runs about as often as it did against the index scan. What
 * changes is that a re-run reads ~15-20 node documents instead of every
 * matching vehicle row.
 *
 * Genuinely reducing the *rate* of re-execution is a different change
 * (decoupling the tiles from a live query), and is deliberately not attempted
 * here.
 *
 * ## Key layout
 *
 * `namespace` is the orgId, so one org's counts are never read or invalidated
 * by another org's writes — the same tenant boundary the tables have.
 *
 * `sortKey` is `[deletedFlag, sourcedFlag, status, createdAt]`, a prefix-ordered
 * tuple:
 *
 * - `deletedFlag` (0 = live, 1 = soft-deleted) keeps soft-deleted rows *in* the
 *   tree rather than removing them. That matters: a soft delete is a `patch`,
 *   so the trigger sees an update and moves the key, which is exactly one
 *   B-tree operation. Removing-on-delete would need the trigger to reason about
 *   whether the row was previously counted, which is where drift creeps in.
 * - `sourcedFlag` (0 = own stock, 1 = sourced/drop-ship) exists because
 *   `dashboard.stats` counts inventory as `sourceType !== "SOURCED"` — it is
 *   reporting cars the dealer actually holds. `sourceType` is optional, and
 *   both `undefined` and `"STOCK"` mean own stock, so the flag is
 *   `=== "SOURCED" ? 1 : 0` to match the filter exactly rather than
 *   three-valued. It sits *above* `status` so "every status, own stock only" is
 *   one contiguous range; below it, that read would need one range per status.
 * - `status` lets a bounded read count just AVAILABLE vehicles.
 * - `createdAt` makes the age buckets pure range counts.
 *
 * Adding `sourcedFlag` changed the key, which invalidates every stored position
 * — see `migrations.rebuildVehicleAggregates`, which must run once per deployment
 * that already had the old three-element key.
 *
 * `sumValue` is `createdAt` *offset by `SUM_EPOCH`*, so average age within a
 * bucket comes from `sum / count` instead of reading the rows.
 *
 * Two things about that sum are load-bearing.
 *
 * **It must be an integer.** The component keeps a running sum per B-tree node
 * and, before splitting one, asserts the incrementally accumulated sum equals
 * the re-associated `left + right + pivot` within an *absolute* 1e-5 — throwing
 * a plain `Error("bad sum split")`, which rolls back the dealer's whole
 * mutation, when it doesn't. `createdAt` is absent on legacy rows and on
 * everything `importBulk` and the approval-workflow create insert, so
 * `vehicleCreatedAt` falls back to `_creationTime` — which Convex makes
 * *fractional* to keep it unique per document. Summing fractional values at a
 * magnitude of ~1e13 accumulates reassociation drift far past 1e-5, and an
 * affected org can no longer create, edit, sell or delete any vehicle at all
 * from around 250 rows, permanently, with no self-recovery. `Math.floor` makes
 * every summand integral; day-granularity `avgDays` cannot notice, and the sort
 * key keeps full precision.
 *
 * **It must stay well under 2^53**, past which float64 stops representing
 * integers exactly and the same assertion fires. Raw epoch milliseconds are
 * ~1.79e12, so a node's sum would cross 2^53 at roughly 5,000 rows while a full
 * height-2 node holds up to 4,912 — no margin at all. Offsetting to a recent
 * epoch leaves ~8.6e10 per row today, i.e. ~105,000 rows in one node, and that
 * headroom shrinks each year as `createdAt` grows (~69,000 by 2028).
 *
 * Changing SUM_EPOCH later invalidates every stored sum and requires clearing
 * and rebuilding the tree, so it is fixed here deliberately.
 *
 * ## Invariant
 *
 * Every write to `vehicles` must go through a mutation built by
 * `convex/functions.ts`, whose wrapped `ctx.db` fires the trigger that keeps
 * this tree in step with the table. `convex/aggregateWiring.test.ts` fails the
 * build if any Convex module takes a mutation builder straight from
 * `_generated/server`, because such a mutation would write the table and
 * silently skip the tree.
 */
export const vehiclesByOrg = new TableAggregate<{
  Namespace: Id<"organizations">;
  Key: [number, number, string, number];
  DataModel: DataModel;
  TableName: "vehicles";
}>(components.vehiclesByOrg, {
  namespace: (doc) => doc.orgId,
  sortKey: (doc) => [
    doc.isDeleted === true ? 1 : 0,
    isSourced(doc) ? 1 : 0,
    doc.status,
    vehicleCreatedAt(doc),
  ],
  sumValue: (doc) => Math.floor(vehicleCreatedAt(doc)) - SUM_EPOCH,
});

/**
 * Whether a vehicle is sourced on demand from another dealer rather than held
 * as the dealer's own stock. `sourceType` is optional; `undefined` predates the
 * field and means own stock, which is why this is not `!== "STOCK"`.
 *
 * Exported so the aggregate key and `dashboard.stats` cannot drift apart on
 * what "inventory" means.
 */
export function isSourced(doc: { sourceType?: "STOCK" | "SOURCED" }): boolean {
  return doc.sourceType === "SOURCED";
}

/**
 * `createdAt` is optional on older vehicle rows; `getAgingBuckets` has always
 * fallen back to `_creationTime` for those. The aggregate has to use the exact
 * same expression, or a backfilled row would land in a different bucket than
 * the row scan put it in.
 */
export function vehicleCreatedAt(doc: {
  createdAt?: number;
  _creationTime: number;
}): number {
  return doc.createdAt ?? doc._creationTime;
}

/**
 * Origin the aggregate's stored sums are measured from. Keeps node sums far
 * below 2^53 — see the note on `sumValue` above. 2023-11-14T22:13:20Z, chosen
 * to predate every row in the system.
 */
export const SUM_EPOCH = 1_700_000_000_000;

/** Sort-key prefix for live (non-soft-deleted) rows. */
export const LIVE = 0;
export const SOFT_DELETED = 1;

/** Own stock vs. sourced-on-demand, as encoded in `vehiclesByOrg`'s key. */
export const OWN_STOCK = 0;
export const SOURCED = 1;

/** Present/absent flags, as encoded in the data-quality keys below. */
export const ABSENT = 0;
export const PRESENT = 1;

/** VIN check-digit outcome, as encoded in `vehicleQualityByOrg`'s key. */
export const VIN_OK = 0;
export const VIN_INVALID = 1;

/**
 * How a customer row came to exist, as encoded in `customersByOrg`'s key.
 * DIRECT means the dealership created it; SOCIAL means Instagram/Facebook
 * ingestion did.
 */
export const DIRECT = 0;
export const SOCIAL = 1;

/**
 * Counts of vehicles whose stored VIN fails its ISO 3779 check digit, for the
 * dashboard's data-quality nudge card. `dataQualityStats` used to read up to
 * 2,000 vehicle documents to produce this single number.
 *
 * ## Why this is a separate tree from `vehiclesByOrg`
 *
 * Every other key element in this file is a *stored field*, so the tree can
 * only be wrong if a write skips the trigger — which `aggregateWiring.test.ts`
 * makes impossible. This one is a *computed predicate*: it calls
 * `validateVinChecksum`. If that function's behaviour ever changes, every
 * stored key silently becomes wrong, with no failing write and no signal.
 *
 * Isolating it means such a change invalidates one small tree used by one
 * nudge card, rather than the inventory tree that the dashboard's headline
 * counts and the aging histogram both depend on. `vinChecksumPinned.test.ts`
 * turns that silent hazard into a build failure.
 *
 * Folding it into `vehiclesByOrg` as a fifth key element was the alternative.
 * It would need to sit above `createdAt` to be countable, which doubles the
 * ranges every aging-bucket and inventory read has to scan — 16 instead of 8 —
 * to marginalise a dimension none of them care about.
 *
 * `sortKey` is `[deletedFlag, vinInvalidFlag]`. Vehicles with no VIN at all
 * count as valid: the card nudges about VINs that look wrong, not missing ones.
 */
export const vehicleQualityByOrg = new TableAggregate<{
  Namespace: Id<"organizations">;
  Key: [number, number];
  DataModel: DataModel;
  TableName: "vehicles";
}>(components.vehicleQualityByOrg, {
  namespace: (doc) => doc.orgId,
  sortKey: (doc) => [doc.isDeleted === true ? 1 : 0, hasVinWarning(doc) ? 1 : 0],
});

/**
 * Whether a vehicle's VIN is present but fails its check digit — the exact
 * predicate `dataQualityStats` reported by scanning rows.
 *
 * Exported so the aggregate key and the pinning test share one definition.
 */
export function hasVinWarning(doc: { vin?: string }): boolean {
  return !!doc.vin && !validateVinChecksum(doc.vin);
}

/**
 * Counts of customers missing a phone number or an email address, for the same
 * nudge card. Replaces a scan of up to 2,000 customer documents.
 *
 * `sortKey` is `[deletedFlag, socialFlag, hasPhone, hasEmail]`.
 *
 * ## Why `socialFlag` is in the key
 *
 * The Instagram and Facebook ingestion paths materialise a customer row per
 * inbound interaction, named after the sender's handle with no phone and no
 * email — on production that is roughly one every five minutes. Counting them
 * made the nudge card structurally unactionable: it reported ~450 of 470
 * customers "missing a phone number", when the dealer has no phone number to
 * enter and never did. A card that cannot reach zero is not a nudge, it is
 * furniture. Excluding them lets the number mean "records you can actually go
 * and fix".
 *
 * The flag sits directly under `deletedFlag` so "live, not social" is a prefix
 * every one of the card's reads shares.
 *
 * Empty strings count as missing, matching the falsy check the row scan used —
 * a customer saved with `phone: ""` was never a customer with a phone number.
 *
 * Adding `socialFlag` changed the key, so any deployment that already seeded
 * this tree needs `migrations.rebuildCustomerAggregate`.
 */
export const customersByOrg = new TableAggregate<{
  Namespace: Id<"organizations">;
  Key: [number, number, number, number];
  DataModel: DataModel;
  TableName: "customers";
}>(components.customersByOrg, {
  namespace: (doc) => doc.orgId,
  sortKey: (doc) => [
    doc.isDeleted === true ? 1 : 0,
    isSocialOriginated(doc) ? SOCIAL : DIRECT,
    doc.phone ? PRESENT : ABSENT,
    doc.email ? PRESENT : ABSENT,
  ],
});

/**
 * Whether a customer row was created by social ingestion rather than entered by
 * the dealership.
 *
 * Keys off the linked account id, not `source`. Both are stamped at creation by
 * `instagramEngagement.ts` and `facebookEngagement.ts`, but `source` is a free
 * `v.string()` that any other code path — or a future import — could set to
 * "Instagram" without the row being a social contact at all. The id fields are
 * written in exactly two places in the whole repo, both of them the ingestion
 * paths themselves, which makes this predicate mean what it says.
 *
 * A social contact who later shares a phone number keeps the flag. That is
 * deliberate and costs nothing: having a phone already takes them out of the
 * "missing phone" count, and re-classifying a row as the dealer fills it in
 * would move it between key prefixes on every edit for no benefit.
 */
export function isSocialOriginated(doc: {
  instagramUserId?: string;
  facebookUserId?: string;
}): boolean {
  return !!doc.instagramUserId || !!doc.facebookUserId;
}

/**
 * Counts of leads by pipeline stage, for `dashboard.stats`' "active leads"
 * tile. Replaces a scan of up to 1,000 lead documents.
 *
 * `sortKey` is `[deletedFlag, stage]` — the raw stage, deliberately, rather
 * than a precomputed "is open" flag. "Active" means *not* WON and *not* LOST,
 * and baking that rule into the key would mean any change to the pipeline (a
 * new terminal stage, a renamed one) silently mis-sorts every stored row with
 * nothing to catch it. Keeping the stage verbatim leaves the business rule in
 * the query, where changing it is just a different subtraction.
 */
export const leadsByOrg = new TableAggregate<{
  Namespace: Id<"organizations">;
  Key: [number, string];
  DataModel: DataModel;
  TableName: "leads";
}>(components.leadsByOrg, {
  namespace: (doc) => doc.orgId,
  sortKey: (doc) => [doc.isDeleted === true ? 1 : 0, doc.stage],
});

/**
 * Membership count per org, for `dashboard.stats`' "team members" tile.
 *
 * `memberships` has no soft-delete column — a removed member's row is deleted
 * outright — so the whole namespace is the count and the key carries no flags.
 * `_creationTime` is used as the key rather than a constant so the tree stays
 * ordered by something meaningful and a future "members joined this month"
 * read is a range rather than a rebuild.
 */
export const membershipsByOrg = new TableAggregate<{
  Namespace: Id<"organizations">;
  Key: number;
  DataModel: DataModel;
  TableName: "memberships";
}>(components.membershipsByOrg, {
  namespace: (doc) => doc.orgId,
  sortKey: (doc) => doc._creationTime,
});

/**
 * Event counts per org for the Social Inbox's analytics cards, one tree per
 * platform table.
 *
 * `socialInbox.platformStats` reported six numbers — comments, DMs and total,
 * for each of Instagram and Facebook — by `.collect()`-ing both event tables in
 * full and counting the results in JavaScript. Per Convex's own per-function
 * breakdown that was 1.08 GB of database bandwidth in one week against a
 * production table of roughly a thousand rows, because the query is a live
 * subscription over the exact tables that social ingestion writes to: every
 * inbound comment or DM invalidated it and made it read everything again.
 *
 * `sortKey` is `[kind]` — the stored field verbatim, so "how many comments" is
 * one contiguous range and "how many events" is the whole namespace. `kind` is
 * written once at ingest and never patched, which is what makes these trees
 * effectively insert-only and so about as drift-resistant as an aggregate gets.
 *
 * Two trees rather than one because a `TableAggregate` is bound to a single
 * table, and Instagram and Facebook events live in separate tables with
 * differently-named sender columns.
 */
export const instagramEventsByOrg = new TableAggregate<{
  Namespace: Id<"organizations">;
  Key: [string];
  DataModel: DataModel;
  TableName: "instagramEvents";
}>(components.instagramEventsByOrg, {
  namespace: (doc) => doc.orgId,
  sortKey: (doc) => [doc.kind],
});

/** Facebook's counterpart to `instagramEventsByOrg`. */
export const facebookEventsByOrg = new TableAggregate<{
  Namespace: Id<"organizations">;
  Key: [string];
  DataModel: DataModel;
  TableName: "facebookEvents";
}>(components.facebookEventsByOrg, {
  namespace: (doc) => doc.orgId,
  sortKey: (doc) => [doc.kind],
});

/**
 * Distinct-sender counts per org, keyed by platform — the "unique contacts"
 * figure on the same analytics cards.
 *
 * Counts rows of `socialContacts`, which materialises one row per distinct
 * sender precisely so this stays a count rather than a `Set` built over every
 * event. See that table's comment for why it keys on the raw platform id.
 */
export const socialContactsByOrg = new TableAggregate<{
  Namespace: Id<"organizations">;
  Key: [string];
  DataModel: DataModel;
  TableName: "socialContacts";
}>(components.socialContactsByOrg, {
  namespace: (doc) => doc.orgId,
  sortKey: (doc) => [doc.platform],
});

/**
 * The trigger registrations that keep every aggregate above in step with its
 * table.
 *
 * Declared here, next to the aggregates themselves, rather than inside
 * `convex/functions.ts`, so that both the production mutation builders and the
 * test harness can install the *same* instance. `convex-test`'s `t.run` hands
 * out a raw `ctx.db` that fires no triggers, so a test that seeds through it
 * would leave the tree describing a table state that no longer exists — and the
 * next real mutation on that row would collide on a stale key. Sharing the
 * registrations lets `test-utils/convexTest.ts` wrap `t.run` too, so seeding in
 * a test behaves exactly like a write in production.
 *
 * `idempotentTrigger`, not `trigger`, and the difference matters in production.
 * The strict trigger throws DELETE_MISSING_KEY when it updates a row the tree
 * has never seen — which is every pre-existing vehicle in the window between
 * this deploying and `migrations.backfillVehicleAggregate` finishing. That
 * would not merely misreport a count: it would make editing a vehicle fail
 * outright for real dealers, for as long as the backfill took. Trading a
 * possibly-stale count for a write that always succeeds is the right way round
 * — the count is a dashboard tile, the write is someone's job.
 */
export const aggregateTriggers = new Triggers<DataModel>();

aggregateTriggers.register("vehicles", vehiclesByOrg.idempotentTrigger());
aggregateTriggers.register("vehicles", vehicleQualityByOrg.idempotentTrigger());
aggregateTriggers.register("customers", customersByOrg.idempotentTrigger());
aggregateTriggers.register("leads", leadsByOrg.idempotentTrigger());
aggregateTriggers.register("memberships", membershipsByOrg.idempotentTrigger());
aggregateTriggers.register("instagramEvents", instagramEventsByOrg.idempotentTrigger());
aggregateTriggers.register("facebookEvents", facebookEventsByOrg.idempotentTrigger());
aggregateTriggers.register("socialContacts", socialContactsByOrg.idempotentTrigger());

/**
 * Materialises the distinct sender behind an inbound social event.
 *
 * Registered as a trigger rather than called from the ingestion mutations
 * because the event tables are written from five production modules and some
 * twenty call sites (auto-reply bookkeeping, manual replies, postId repair, the
 * resync backfills). Hanging this off the same wrapped `ctx.db` that the
 * aggregates already use means there is no such thing as a write that forgets
 * to maintain it, which is the only version of this that stays correct.
 *
 * Inserts only. The sender id is stamped once at ingest and never patched, so
 * an update carries no new sender, and re-deriving on every reply would put an
 * indexed read in front of routine bookkeeping writes for nothing.
 *
 * Deliberately does NOT delete on event deletion, because *nothing in the
 * product deletes an individual event*. The only deletion is the org purge
 * (`adminOrgs.ts`), which removes the contact rows directly in the same pass.
 * The super-admin raw-record editor cannot reach these tables: `adminData.ts`
 * gates every hard delete on `ADMIN_TABLES`, which lists neither
 * `instagramEvents` nor `facebookEvents`.
 *
 * That absence is what makes insert-only safe, so it is load-bearing rather
 * than incidental — adding either table to `ADMIN_TABLES` is a one-line change
 * that would make "unique contacts" read permanently high, silently.
 * `socialInboxStats.test.ts` fails the build if either appears there. If the
 * product ever does need per-event deletion, the honest fix is a decrement that
 * first checks for other events from the same sender, not this trigger;
 * `migrations.repairSocialContacts` is the recovery path in the meantime.
 */
export async function recordSocialContact(
  ctx: { db: GenericDatabaseWriter<DataModel> },
  orgId: Id<"organizations">,
  platform: "instagram" | "facebook",
  senderRawId: string
): Promise<void> {
  // A deliberate, documented divergence from the `Set` this replaces.
  //
  // `new Set(events.map(e => e.senderInstagramId))` counted `""` as a contact:
  // one anonymous bucket, reported to the dealer as a real person. Skipping it
  // means an org whose webhook failed to identify a sender now reads one lower
  // than it used to.
  //
  // Measured on production (kindly-hound-172, 2026-08-07): 347 Instagram and
  // 682 Facebook events, zero blank sender ids. That is a reading, not an
  // invariant — three of the four ingest paths in `http.ts` drop an
  // unidentified sender (`if (!fromId) continue` at the Instagram comment
  // path, `if (!senderId) continue` at both DM paths) but the Facebook *feed
  // comment* path does not, so a page comment arriving with no `from.id` would
  // still be stored with an empty sender. Adding the fourth guard would change
  // what gets ingested, which is a product decision and not this change's to
  // make; it is left as a follow-up.
  //
  // Kept as a guard rather than "fixed" to match the old count, because the
  // alternative is materialising a `socialContacts` row keyed on the empty
  // string: a permanent phantom contact per org that no later event can
  // reconcile away.
  if (!senderRawId) return;
  const existing = await ctx.db
    .query("socialContacts")
    .withIndex("by_org_platform_sender", (q) =>
      q.eq("orgId", orgId).eq("platform", platform).eq("senderRawId", senderRawId)
    )
    .first();
  if (existing) return;
  await ctx.db.insert("socialContacts", { orgId, platform, senderRawId });
}

aggregateTriggers.register("instagramEvents", async (ctx, change) => {
  if (change.operation !== "insert" || !change.newDoc) return;
  await recordSocialContact(ctx, change.newDoc.orgId, "instagram", change.newDoc.senderInstagramId);
});

aggregateTriggers.register("facebookEvents", async (ctx, change) => {
  if (change.operation !== "insert" || !change.newDoc) return;
  await recordSocialContact(ctx, change.newDoc.orgId, "facebook", change.newDoc.senderFacebookId);
});

/**
 * The grouping the Social Inbox has always used, lifted out of the query so the
 * materialised table and any future reader cannot drift on what a "thread" is.
 *
 * Comments thread per (platform × customer × post); DMs per (platform ×
 * customer). A comment whose `postId` has not been resolved yet lands in a
 * shared `__none__` bucket, exactly as before, until a resync fills it in.
 */
export function socialConversationKey(id: {
  platform: "instagram" | "facebook";
  customerId: Id<"customers">;
  kind: "comment" | "dm";
  postId?: string;
}): string {
  if (id.kind === "dm") return `${id.platform}:${id.customerId}:dm`;
  return `${id.platform}:${id.customerId}:comment:${id.postId ?? "__none__"}`;
}

export type SocialConversationIdentity = {
  orgId: Id<"organizations">;
  platform: "instagram" | "facebook";
  customerId: Id<"customers">;
  kind: "comment" | "dm";
  postId?: string;
};

/**
 * Which thread an event belongs to, or `null` if it belongs to none.
 *
 * An event with no `customerId` has no thread. The grouping query skipped those
 * outright (`if (!ev.customerId) continue`), so materialising one would put a
 * row in the inbox that the old list never showed.
 */
function socialConversationIdentity(
  platform: "instagram" | "facebook",
  doc: Doc<"instagramEvents"> | Doc<"facebookEvents">
): SocialConversationIdentity | null {
  if (!doc.customerId) return null;
  return {
    orgId: doc.orgId,
    platform,
    customerId: doc.customerId,
    kind: doc.kind,
    postId: doc.postId,
  };
}

/**
 * One thread's events, oldest first, with the per-platform sender columns
 * flattened.
 *
 * Normalised here rather than at the call site because the two tables name the
 * same thing differently (`senderInstagramId`/`senderUsername` against
 * `senderFacebookId`/`senderName`), and a union of the two document types
 * cannot be narrowed by an `in` check — the platform is the discriminator, and
 * it is known at the point the query is chosen.
 */
type ThreadEvent = {
  _creationTime: number;
  kind: "comment" | "dm";
  postId?: string;
  text?: string;
  vehicleId?: Id<"vehicles">;
  leadId?: Id<"leads">;
  autoRepliedAt?: number;
  manualRepliedAt?: number;
  senderRawId: string;
  senderHandle?: string;
};

async function readThreadEvents(
  ctx: { db: GenericDatabaseWriter<DataModel> },
  id: SocialConversationIdentity
): Promise<ThreadEvent[]> {
  const rows: ThreadEvent[] =
    id.platform === "instagram"
      ? (
          await ctx.db
            .query("instagramEvents")
            .withIndex("by_org_customer", (q) =>
              q.eq("orgId", id.orgId).eq("customerId", id.customerId)
            )
            .collect()
        ).map((row) => ({ ...row, senderRawId: row.senderInstagramId, senderHandle: row.senderUsername }))
      : (
          await ctx.db
            .query("facebookEvents")
            .withIndex("by_org_customer", (q) =>
              q.eq("orgId", id.orgId).eq("customerId", id.customerId)
            )
            .collect()
        ).map((row) => ({ ...row, senderRawId: row.senderFacebookId, senderHandle: row.senderName }));

  return rows
    .filter((row) => {
      if (row.kind !== id.kind) return false;
      if (id.kind !== "comment") return true;
      return (row.postId ?? null) === (id.postId ?? null);
    })
    .sort((a, b) => a._creationTime - b._creationTime);
}

/**
 * Rebuilds one thread's row from the events that currently exist, or deletes it
 * when none remain.
 *
 * ## Why a full recompute rather than an incremental delta
 *
 * A delta has to reason about the transition — was this event already counted,
 * was it already answered, did that vehicle appear anywhere else in the thread
 * — and every one of those is a place a counter drifts silently. This project
 * has already paid for that lesson once. Recomputing removes the entire class:
 * the row is a pure function of the thread's events, so a wrong row can only
 * survive until the next write touches it.
 *
 * The cost is bounded by *one customer's* events on one platform, read through
 * `by_org_customer` — a handful of rows — not by the org's history. That is the
 * trade: a small bounded read on write, in exchange for a list query that never
 * reads events at all.
 */
export async function syncSocialConversation(
  ctx: { db: GenericDatabaseWriter<DataModel> },
  id: SocialConversationIdentity
): Promise<void> {
  const conversationKey = socialConversationKey(id);
  const existing = await ctx.db
    .query("socialConversations")
    .withIndex("by_org_key", (q) =>
      q.eq("orgId", id.orgId).eq("conversationKey", conversationKey)
    )
    .first();

  const events = await readThreadEvents(ctx, id);

  if (events.length === 0) {
    if (existing) await ctx.db.delete(existing._id);
    return;
  }

  const latest = events[events.length - 1];
  // Distinct, in first-seen order: the list shows how many vehicles a thread
  // touched and a summary of the first one.
  const vehicleIds: Id<"vehicles">[] = [];
  for (const event of events) {
    if (event.vehicleId && !vehicleIds.includes(event.vehicleId)) {
      vehicleIds.push(event.vehicleId);
    }
  }
  // The most recent event carrying a lead, matching the old
  // `[...events].reverse().find((e) => e.leadId)`.
  let leadId: Id<"leads"> | undefined;
  for (const event of events) {
    if (event.leadId) leadId = event.leadId;
  }

  const row = {
    orgId: id.orgId,
    conversationKey,
    platform: id.platform,
    conversationKind: id.kind,
    conversationPostId: id.kind === "comment" ? id.postId : undefined,
    customerId: id.customerId,
    lastEventAt: latest._creationTime,
    eventCount: events.length,
    unansweredCount: events.filter((e) => !e.autoRepliedAt && !e.manualRepliedAt).length,
    vehicleIds,
    vehicleCount: vehicleIds.length,
    leadId,
    latestText: latest.text,
    latestSenderHandle: latest.senderHandle,
    latestSenderRawId: latest.senderRawId,
  };

  if (existing) {
    await ctx.db.patch(existing._id, row);
  } else {
    await ctx.db.insert("socialConversations", row);
  }
}

/**
 * Keeps `socialConversations` in step with an event write.
 *
 * Registered as a trigger for the same reason `recordSocialContact` is: these
 * tables are written from five modules and some twenty call sites, and a
 * materialised view maintained at the call sites is a view that one of them
 * eventually forgets.
 *
 * Both sides of the write are synced, because an update can *move* an event
 * between threads — `socialInboxBackfill` patches `postId`, which re-keys a
 * comment, and a customer merge repoints `customerId`. Syncing only the new
 * thread would leave the old one counting an event it no longer holds.
 */
async function syncConversationsForEventWrite(
  ctx: { db: GenericDatabaseWriter<DataModel> },
  platform: "instagram" | "facebook",
  change: {
    oldDoc: Doc<"instagramEvents"> | Doc<"facebookEvents"> | null;
    newDoc: Doc<"instagramEvents"> | Doc<"facebookEvents"> | null;
  }
): Promise<void> {
  const affected: SocialConversationIdentity[] = [];
  const seen = new Set<string>();
  for (const doc of [change.oldDoc, change.newDoc]) {
    if (!doc) continue;
    const id = socialConversationIdentity(platform, doc);
    if (!id) continue;
    const key = socialConversationKey(id);
    if (seen.has(key)) continue;
    seen.add(key);
    affected.push(id);
  }
  for (const id of affected) {
    await syncSocialConversation(ctx, id);
  }
}

aggregateTriggers.register("instagramEvents", async (ctx, change) => {
  await syncConversationsForEventWrite(ctx, "instagram", change);
});

aggregateTriggers.register("facebookEvents", async (ctx, change) => {
  await syncConversationsForEventWrite(ctx, "facebook", change);
});
