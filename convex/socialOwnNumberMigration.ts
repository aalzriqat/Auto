import { v, ConvexError } from "convex/values";
import { internalMutation } from "./functions";
import type { MutationCtx } from "./_generated/server";
import type { Doc, TableNames } from "./_generated/dataModel";
import { markOwnNumbersReady, markUserOwnNumbersReady, syncOwnNumberRow, prepareOwnNumberMembership, syncJoinedOwnNumber } from "./utils/socialOwnNumbers";
import { makeFunctionReference } from "convex/server";
import type { Id } from "./_generated/dataModel";

type MemberProgress = { id: Id<"memberships">; cursor: string; nextCursor: string; nextDone: boolean };
type MigrationPage = { isDone: boolean; continueCursor: string; join?: MemberProgress };

async function rebuildTable<Table extends TableNames>(
  ctx: MutationCtx,
  table: Table,
  cursor: string | null,
  visit: (doc: Doc<Table>) => Promise<void>,
): Promise<MigrationPage> {
  // Source pages have a byte and row budget. Pointer sources may each reach a
  // whole projection by id, so those two tables use one source row per call.
  const numItems = table === "websiteSettings" || table === "websiteDomains" ? 1 : 32;
  const page = await ctx.db.query(table).paginate({ cursor, numItems, maximumRowsRead: numItems, maximumBytesRead: 1024 * 1024 });
  for (const row of page.page) await visit(row);
  return page;
}

async function rebuildMembership(
  ctx: MutationCtx, cursor: string | null, state: Doc<"socialOwnNumberSources"> | null,
): Promise<MigrationPage> {
  let member = state?.migrationMemberId ? await ctx.db.get(state.migrationMemberId) : null;
  let nextCursor = state?.migrationMemberNextCursor ?? "";
  let nextDone = state?.migrationMemberNextDone ?? false;
  if (state?.migrationMemberId && !member) return { isDone: nextDone, continueCursor: nextCursor };
  if (!member) {
    const page = await ctx.db.query("memberships").paginate({ cursor, numItems: 1 });
    member = page.page[0] ?? null;
    nextCursor = page.continueCursor;
    nextDone = page.isDone;
  }
  if (!member) return { isDone: true, continueCursor: nextCursor };
  const marker = await prepareOwnNumberMembership(ctx, member._id, member);
  if (!marker || marker.joinComplete) return { isDone: nextDone, continueCursor: nextCursor };
  if (!state?.migrationMemberId) {
    // Selection and copying use separate invocations: Convex permits only one
    // paginated query in a function, even when the tables are different.
    return { isDone: false, continueCursor: cursor ?? "", join: { id: member._id, cursor: "", nextCursor, nextDone } };
  }
  // The marker is installed first. Concurrent new/removed contacts maintain
  // idempotent membership/phone contributions while this walk is incomplete.
  const phones = await ctx.db.query("socialOwnNumberCounts").withIndex("by_scope", (q) => q.eq("scope", member.userId))
    .paginate({ cursor: state?.migrationMemberCursor || null, numItems: 32, maximumRowsRead: 32, maximumBytesRead: 1024 * 1024 });
  for (const phone of phones.page) await syncJoinedOwnNumber(ctx, member._id, member.orgId, phone.phone, true);
  if (phones.isDone) {
    await ctx.db.patch(marker._id, { joinComplete: true });
    return { isDone: nextDone, continueCursor: nextCursor };
  }
  return { isDone: false, continueCursor: cursor ?? "", join: { id: member._id, cursor: phones.continueCursor, nextCursor, nextDone } };
}

/**
 * Operator-only, resumable bootstrap. Call until `done`; a caller cannot choose
 * a phase or certify an empty prefix. The final phase certifies organizations
 * only after all contact sources and membership edges have been indexed.
 * Fresh organizations are complete from creation through the normal trigger.
 */
export const rebuildPage = internalMutation({
  args: {},
  returns: v.object({ done: v.boolean() }),
  handler: async (ctx) => {
    try {
      const key = "migration:v1";
      const state = await ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", key)).unique();
      const table = state?.migrationTable ?? 0;
      const cursor = state?.migrationCursor ?? null;
      const phases = [
        () => rebuildTable(ctx, "users", cursor, (doc) => syncOwnNumberRow(ctx, { table: "users", doc })),
        () => rebuildTable(ctx, "marketplaceListings", cursor, (doc) => syncOwnNumberRow(ctx, { table: "marketplaceListings", doc })),
        () => rebuildTable(ctx, "marketplaceIndividualSellerProfiles", cursor, (doc) => syncOwnNumberRow(ctx, { table: "marketplaceIndividualSellerProfiles", doc })),
        () => rebuildTable(ctx, "branches", cursor, (doc) => syncOwnNumberRow(ctx, { table: "branches", doc })),
        () => rebuildTable(ctx, "marketplaceDealerProfiles", cursor, (doc) => syncOwnNumberRow(ctx, { table: "marketplaceDealerProfiles", doc })),
        () => rebuildTable(ctx, "marketplaceWhatsAppFlows", cursor, (doc) => syncOwnNumberRow(ctx, { table: "marketplaceWhatsAppFlows", doc })),
        () => rebuildTable(ctx, "websiteSettings", cursor, (doc) => syncOwnNumberRow(ctx, { table: "websiteSettings", doc })),
        () => rebuildTable(ctx, "websiteDomains", cursor, (doc) => syncOwnNumberRow(ctx, { table: "websiteDomains", doc })),
        () => rebuildTable(ctx, "users", cursor, (doc) => markUserOwnNumbersReady(ctx, doc._id)),
        () => rebuildMembership(ctx, cursor, state),
        () => rebuildTable(ctx, "organizations", cursor, (doc) => markOwnNumbersReady(ctx, doc._id)),
      ];
      const phase = phases[table];
      if (!phase) return { done: true };
      const page = await phase();
      const next = { key, scope: "deployment", kind: "migration" as const, phones: [],
        migrationTable: page.isDone ? table + 1 : table,
        migrationCursor: page.isDone ? undefined : page.continueCursor || undefined,
        migrationMemberId: page.join?.id, migrationMemberCursor: page.join?.cursor,
        migrationMemberNextCursor: page.join?.nextCursor, migrationMemberNextDone: page.join?.nextDone };
      if (state) await ctx.db.patch(state._id, next);
      else await ctx.db.insert("socialOwnNumberSources", next);
      return { done: next.migrationTable === phases.length };
    } catch (error) {
      console.error("Own-number bootstrap failed", error);
      // Rethrow: catching and returning would commit a partial page.
      throw new ConvexError("Unable to prepare contact matching. Please try again later.");
    }
  },
});

/** Remove derived personal contact data in bounded transactions after deletion. */
export const purgeDeletedOrgPage = internalMutation({
  args: { orgId: v.id("organizations") },
  returns: v.null(),
  handler: async (ctx, { orgId }) => {
    try {
      if (await ctx.db.get(orgId)) throw new Error("Refusing to purge an existing organization");
      const member = await ctx.db.query("socialOwnNumberSources").withIndex("by_memberOrg", (q) => q.eq("memberOrgId", orgId)).first();
      const source = member ?? await ctx.db.query("socialOwnNumberSources").withIndex("by_scope_kind", (q) => q.eq("scope", orgId)).first();
      if (source) await ctx.db.delete(source._id);
      else {
        const count = await ctx.db.query("socialOwnNumberCounts").withIndex("by_scope", (q) => q.eq("scope", orgId)).first();
        if (!count) return null;
        await ctx.db.delete(count._id);
      }
      await ctx.scheduler.runAfter(0, makeFunctionReference<"mutation", { orgId: Id<"organizations"> }, null>("socialOwnNumberMigration:purgeDeletedOrgPage"), { orgId });
      return null;
    } catch (error) {
      console.error("Own-number deletion cleanup failed", error);
      throw new ConvexError("Unable to finish contact cleanup. Please try again later.");
    }
  },
});
