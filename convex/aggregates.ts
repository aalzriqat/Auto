import { TableAggregate } from "@convex-dev/aggregate";
import { Triggers } from "convex-helpers/server/triggers";
import type { GenericDatabaseWriter } from "convex/server";
import { components } from "./_generated/api";
import { DataModel, Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { validateVinChecksum } from "../lib/vinHelpers";
import { SOCIAL_CONVERSATION_GENERATION } from "./utils/materialization";

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

/**
 * Every trigger except the conversation recompute.
 *
 * Shared by both writers below so that adding an aggregate cannot arm one and
 * not the other — the failure that would produce is a tree that drifts only
 * during bulk operations, which is precisely the kind nothing surfaces.
 */
function registerCountingTriggers<Ctx extends MutationCtx>(
  triggers: Triggers<DataModel, Ctx>
): void {
  triggers.register("vehicles", vehiclesByOrg.idempotentTrigger());
  triggers.register("vehicles", vehicleQualityByOrg.idempotentTrigger());
  triggers.register("customers", customersByOrg.idempotentTrigger());
  triggers.register("leads", leadsByOrg.idempotentTrigger());
  triggers.register("memberships", membershipsByOrg.idempotentTrigger());
  triggers.register("instagramEvents", instagramEventsByOrg.idempotentTrigger());
  triggers.register("facebookEvents", facebookEventsByOrg.idempotentTrigger());
  triggers.register("socialContacts", socialContactsByOrg.idempotentTrigger());

  // Insert-only and a single indexed point lookup, so it is cheap enough to
  // keep running inside a bulk loop.
  triggers.register("instagramEvents", async (ctx, change) => {
    if (change.operation !== "insert" || !change.newDoc) return;
    await recordSocialContact(ctx, change.newDoc.orgId, "instagram", change.newDoc.senderInstagramId);
  });
  triggers.register("facebookEvents", async (ctx, change) => {
    if (change.operation !== "insert" || !change.newDoc) return;
    await recordSocialContact(ctx, change.newDoc.orgId, "facebook", change.newDoc.senderFacebookId);
  });
}

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
 * The thread key, namespaced by org — the form every dedupe set uses.
 *
 * `socialConversationKey` deliberately carries no orgId, because it is also the
 * stored `conversationKey` and the table is already partitioned by `orgId` in
 * every index. Anything that dedupes threads *in memory* does need the org in
 * the key, and there are four such sets across the trigger, the bulk writers
 * and the two backfills. One definition, because "a second interpretation of
 * the same thread is how these paths would eventually disagree" is only true if
 * there is genuinely one.
 */
export function namespacedThreadKey(id: SocialConversationIdentity): string {
  return `${id.orgId}:${socialConversationKey(id)}`;
}


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
 * Test seam: how many times a thread has been recomputed.
 *
 * The defect this guards against is a *cost* one — a bulk loop recomputing the
 * same thread once per event — and cost is exactly what a correctness assertion
 * cannot see. Asserting on wall-clock time instead would be flaky and would
 * still pass a quadratic implementation on a small fixture, so the regression
 * test counts recomputes structurally: 400 events in one thread must recompute
 * it once, not 400 times.
 *
 * Deliberately shipped in the production bundle rather than stripped behind
 * a flag: it is one integer that never persists and never allocates, and the
 * tests assert exact positive counts, so a seam that stopped being shared
 * would fail them rather than silently pass. Do not remove it as debug
 * residue — it is the only regression test for this class of defect.
 */
let socialConversationSyncCount = 0;

export function readSocialConversationSyncCount(): number {
  return socialConversationSyncCount;
}

export function resetSocialConversationSyncCount(): void {
  socialConversationSyncCount = 0;
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
 * ## Cost, stated honestly
 *
 * One sync reads *one customer's* events on one platform through
 * `by_org_customer`. For the path this was designed for — a single inbound
 * webhook message — that is a handful of rows, and the trade is a small bounded
 * read on write in exchange for a list query that never reads events at all.
 *
 * ⚠️ It is **not** bounded when a mutation patches many of one customer's
 * events in a loop, because each patch fires a sync that re-reads the whole
 * thread: N patches cost O(N²) reads. Measured superlinear (2x the events gave
 * ~3x the time at n=200, converging on quadratic at higher n). The loops with
 * this shape are `customers.mergeCustomers`, `socialInbox.setConversationVehicle`
 * called without a platform, and the org purge. On a long Messenger thread that
 * can reach Convex's per-transaction read ceiling, and a throw there rolls the
 * whole mutation back — so the merge would fail outright rather than degrade.
 *
 * A per-transaction memo does NOT fix that, which is worth stating because it
 * is the obvious first idea: each patch invalidates the very thread the next
 * patch re-reads, so the cache never hits. The fix has to be to stop
 * recomputing per write at all.
 *
 * All three loops now avoid it. The backfills dedupe thread keys within a
 * batch; `customers.mergeCustomers` and `socialInbox.setConversationVehicle`
 * opt into `deferredThreadTriggers`, which suppresses the per-write recompute
 * so the loop can sync each touched thread exactly once at the end. Measured
 * on the merge path: 400 recomputes for 200 repointed events before, 2 after.
 *
 * The one loop still recomputing eagerly is the org purge
 * (`ORGANIZATION_DELETION_STEPS` in `adminOrgs.ts`). Each event delete
 * recomputes its thread, so a batch dominated by one contact holding N events
 * reads roughly batch x N. Unlike the merge it is not retry-recoverable: the
 * step re-reads the same first rows every time, fails identically, and the
 * abort rolls back the FAILED status the catch block would have written —
 * leaving the request stuck with the org half-deleted.
 *
 * The event steps therefore take a smaller batch (`TRIGGER_HEAVY_BATCH_SIZE`
 * in `adminOrgs.ts`). That moves the threshold, it does not remove it: the
 * product is still linear in N. Against Convex's read ceiling it buys roughly
 * 5x, and production is nowhere near either figure — about 700 events per org
 * in total, across all contacts. The trigger to revisit is still concrete: one
 * social contact in one org holding more than a thousand events on a single
 * platform, at which point route the purge through the deferred writer.
 */
export async function syncSocialConversation(
  ctx: { db: GenericDatabaseWriter<DataModel> },
  id: SocialConversationIdentity
): Promise<void> {
  socialConversationSyncCount += 1;
  const conversationKey = socialConversationKey(id);
  // Generation-scoped, like every authoritative path over this table. A bump
  // changes what `conversationKey` means, so the previous generation's row for
  // "the same" thread is deliberately NOT found here: it is superseded, not
  // updated, and overwriting it would be the one way to lose the old shape
  // before anything had proven the new one.
  const existing = await ctx.db
    .query("socialConversations")
    .withIndex("by_org_generation_key", (q) =>
      q
        .eq("orgId", id.orgId)
        .eq("generation", SOCIAL_CONVERSATION_GENERATION)
        .eq("conversationKey", conversationKey)
    )
    .first();

  const events = await readThreadEvents(ctx, id);

  // Sorted oldest-first, so the newest is the last one. `at(-1)` is only
  // `undefined` for an empty thread, which returned above.
  const latest = events.at(-1);
  if (!latest) {
    if (existing) await ctx.db.delete(existing._id);
    return;
  }
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
    generation: SOCIAL_CONVERSATION_GENERATION,
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
    // Namespaced by org: `socialConversationKey` deliberately carries no
    // orgId, so an update that moved an event between orgs would collide here
    // and rebuild only the old org's thread. Nothing does that today —
    // `adminData.assertPatchDoesNotRetenant` blocks it — but the set is free to
    // make correct and this is a trap for whoever adds an org-move tool.
    const key = namespacedThreadKey(id);
    if (seen.has(key)) continue;
    seen.add(key);
    affected.push(id);
  }
  for (const id of affected) {
    await syncSocialConversation(ctx, id);
  }
}

registerCountingTriggers(aggregateTriggers);

aggregateTriggers.register("instagramEvents", async (ctx, change) => {
  await syncConversationsForEventWrite(ctx, "instagram", change);
});

aggregateTriggers.register("facebookEvents", async (ctx, change) => {
  await syncConversationsForEventWrite(ctx, "facebook", change);
});

/**
 * The writer for mutations that patch many of one customer's social events in a
 * loop. Identical to `aggregateTriggers` except that it does **not** recompute
 * conversation threads per write.
 *
 * ## Why this exists
 *
 * The per-write recompute is bounded by one thread, which is a handful of rows
 * for the inbound-webhook path it was built for. In a loop it is not: each
 * patch re-reads the whole thread, so N patches cost O(N squared) reads.
 * Measured superlinear — 2x the events gave ~3x the time at n=200, converging
 * on quadratic — and on a long Messenger history that reaches Convex's
 * per-transaction read ceiling. The throw then rolls the whole mutation back,
 * so `mergeCustomers` would fail outright for exactly the contacts that most
 * need merging: the same person arriving once on Instagram and once on Facebook.
 *
 * ## Why not a scheduled repoint
 *
 * Moving the event repointing to a paginated background job scales harder but
 * makes an operation that looks atomic stop being atomic — a merge could report
 * success with half its events still on the loser, and would then need
 * intermediate states, resumability, and a UI answer for "partially merged".
 * Deferring *inside* the same transaction keeps the property that matters: the
 * merge either happened completely or it did not happen at all. A throw in the
 * final sync rolls back every patch with it.
 *
 * ## The invariant, and why it is no longer the caller's to keep
 *
 * A mutation built on this writer must recompute every thread it touched before
 * it returns, or it commits event rows whose conversation summary is stale —
 * silently, with nothing failing at write time.
 *
 * That obligation used to sit with the handler: collect each touched thread,
 * then call `syncDeferredSocialThreads` before returning. A build-time guard
 * tried to enforce it by reading the source, and failed open **six times** in
 * the same shape — a comment opener inside a string, a definition at offset 0,
 * a chunk running into its neighbour, an aliased import, explicit type
 * arguments, a destructured local shadow. Each fix was correct and the next
 * hole was a different spelling.
 *
 * The seventh finding is the one that ended the approach: a static check can
 * prove the two calls EXIST somewhere beneath the mutation, and cannot prove
 * they EXECUTE. A handler that puts them inside a closure it never invokes
 * satisfies every syntactic rule while settling nothing.
 *
 * So the obligation moved into the builder. The triggers below record which
 * threads a write touched, and `socialBulkMutation` flushes them from the
 * customization's `onSuccess` after the handler returns. There is no settlement
 * call for a caller to forget, and therefore nothing for a guard to police.
 *
 * The remaining cost is linear in the number of events repointed. A large
 * enough customer could still approach the transaction write limit on volume
 * alone; that is a separate, resumable-pagination design and deliberately not
 * solved here.
 */
/**
 * The context these triggers REQUIRE. Making the tracker part of the type is
 * what stops `wrapDB(ctx)` compiling without one — the earlier version was a
 * plain `Triggers<DataModel>` whose callbacks needed `ctx as never`, and a cast
 * is exactly where a mandatory thing quietly becomes optional.
 */
export type DeferredThreadCtx = MutationCtx & { deferredThreads: DeferredSocialThreads };

export const deferredThreadTriggers = new Triggers<DataModel, DeferredThreadCtx>();
registerCountingTriggers(deferredThreadTriggers);

/**
 * Records the threads an event write touched, instead of recomputing them.
 *
 * Both sides of the write are recorded for the same reason the eager trigger
 * syncs both: an update can MOVE an event between threads, and recording only
 * the new one would leave the old thread counting an event it no longer holds.
 *
 * ⚠️ The tracker is read off `ctx`, which is what makes this per-invocation
 * rather than global. `Triggers.wrapDB` closes over the ctx it is handed and
 * passes it to every trigger as `{ ...ctx, db, innerDb }`, so a tracker placed
 * on the ctx *before* wrapping arrives here untouched. A module-level "current
 * tracker" would have been the obvious alternative and is exactly the shape
 * that breaks when two mutations interleave.
 *
 * ⚠️ A MISSING TRACKER THROWS. It used to return quietly, on the reasoning that
 * a future writer without the customization should "lose the recompute, not the
 * write" — which is precisely backwards. Losing the recompute IS the defect
 * this whole mechanism exists to prevent: the event commits and
 * `socialConversations` silently describes a state that no longer exists, with
 * nothing failing at write time and no build-time guard left to notice.
 * Refusing the write is the only fail-closed answer, and because triggers run
 * inside the mutation's transaction the refusal rolls the write back with it.
 */
function recordDeferredThreads(
  ctx: Partial<DeferredThreadCtx>,
  platform: "instagram" | "facebook",
  change: {
    oldDoc: Doc<"instagramEvents"> | Doc<"facebookEvents"> | null;
    newDoc: Doc<"instagramEvents"> | Doc<"facebookEvents"> | null;
  }
): void {
  const threads = ctx.deferredThreads;
  if (!threads) {
    throw new Error(
      "deferredThreadTriggers was used without a thread tracker. Build the mutation " +
        "with `socialBulkMutation` (see prepareDeferredThreadMutation) rather than " +
        "wrapping this writer directly — otherwise the event write would commit while " +
        "its conversation summary silently went stale."
    );
  }
  collectSocialThread(threads, platform, change.oldDoc);
  collectSocialThread(threads, platform, change.newDoc);
}

deferredThreadTriggers.register("instagramEvents", async (ctx, change) => {
  recordDeferredThreads(ctx, "instagram", change);
});

deferredThreadTriggers.register("facebookEvents", async (ctx, change) => {
  recordDeferredThreads(ctx, "facebook", change);
});

/**
 * The only supported way to obtain the deferred writer.
 *
 * Returns the wrapped `db` and nothing else, keeping the tracker and the full
 * wrapped context captured in this closure. `socialBulkMutation` used to return
 * the whole wrapped ctx, and `customFnBuilder` merges everything under `ctx`
 * into the handler's context — so `deferredThreads` was reachable from inside a
 * handler, which could `.clear()` it and leave `finalize` synchronising an
 * empty map. An implementation detail the caller can reach is an implementation
 * detail the caller can defeat.
 */
export function prepareDeferredThreadMutation(ctx: MutationCtx): {
  db: GenericDatabaseWriter<DataModel>;
  finalize: () => Promise<void>;
} {
  const threads = newDeferredSocialThreads();
  // Tracker first, THEN wrap: `wrapDB` closes over the ctx it is given and
  // hands it to every trigger, so anything added afterwards is invisible there.
  const wrapped = deferredThreadTriggers.wrapDB({ ...ctx, deferredThreads: threads });
  return {
    db: wrapped.db,
    finalize: async () => {
      await syncDeferredSocialThreads(wrapped, threads);
    },
  };
}

/**
 * Threads touched by a bulk operation, keyed canonically so 500 events from one
 * Messenger thread recompute once.
 *
 * The key is org-namespaced exactly like the trigger's own dedupe set — a
 * second interpretation of "the same thread" is how these two paths would
 * eventually disagree.
 */
export type DeferredSocialThreads = Map<string, SocialConversationIdentity>;

export function newDeferredSocialThreads(): DeferredSocialThreads {
  return new Map();
}

/** Records the thread an event belongs to, before and/or after a bulk write. */
export function collectSocialThread(
  threads: DeferredSocialThreads,
  platform: "instagram" | "facebook",
  doc: Doc<"instagramEvents"> | Doc<"facebookEvents"> | null | undefined
): void {
  if (!doc) return;
  const id = socialConversationIdentity(platform, doc);
  if (!id) return;
  threads.set(namespacedThreadKey(id), id);
}

/**
 * Recomputes each collected thread exactly once.
 *
 * ⚠️ NOT called by handlers. `prepareDeferredThreadMutation` captures the
 * tracker and hands this to `socialBulkMutation` as its `onSuccess`, so the
 * recompute runs automatically after a handler returns. The docblock here used
 * to read "call before returning from any mutation built on
 * `deferredThreadTriggers`", which described the manual contract this design
 * replaced — left in place it would let a future session reconstruct the
 * deleted obligation from the documentation alone.
 */
export async function syncDeferredSocialThreads(
  ctx: { db: GenericDatabaseWriter<DataModel> },
  threads: DeferredSocialThreads
): Promise<void> {
  for (const id of threads.values()) {
    await syncSocialConversation(ctx, id);
  }
}
