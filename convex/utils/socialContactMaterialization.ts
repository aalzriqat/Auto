import type { GenericDatabaseWriter } from "convex/server";
import type { DataModel, Id } from "../_generated/dataModel";

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
