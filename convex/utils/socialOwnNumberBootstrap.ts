import { ConvexError } from "convex/values";
import { makeFunctionReference, type PaginationResult } from "convex/server";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { markOwnNumbersReady, markUserOwnNumbersReady, prepareOwnNumberMembership, syncJoinedOwnNumber } from "./socialOwnNumbers";
import { applyContactChange, contactRowScopes, invalidateOwnNumberScopes } from "./socialOwnNumberWrites";
import type { ContactTable } from "./socialOwnNumberContacts";

type MemberProgress = { id: Id<"memberships">; cursor: string; nextCursor: string; nextDone: boolean };
export type MigrationPage = { isDone: boolean; continueCursor: string; join?: MemberProgress };
async function bootstrapSource(ctx: MutationCtx, table: ContactTable, doc: Doc<ContactTable>) {
  try {
    await ctx.runMutation(applyContactChange, { table, id: doc._id, operation: "update" });
  } catch {
    console.error("Own-number bootstrap source unavailable");
    await invalidateOwnNumberScopes(ctx, contactRowScopes(table, doc), table, doc._id);
  }
}

async function visitSourcePage<Row>(
  page: PaginationResult<Row>,
  visit: (doc: Row) => Promise<void>,
): Promise<MigrationPage> {
  for (const row of page.page) await visit(row);
  return page;
}

export async function rebuildMembership(
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

async function bootstrapMembership(ctx: MutationCtx, cursor: string | null, state: Doc<"socialOwnNumberSources"> | null): Promise<MigrationPage> {
  try {
    return await ctx.runMutation(makeFunctionReference<"mutation", { cursor: string | null; stateId?: Id<"socialOwnNumberSources"> }, MigrationPage>("socialOwnNumberMigration:membershipPage"), { cursor, stateId: state?._id });
  } catch {
    console.error("Own-number poisoned membership skipped");
    const page = state?.migrationMemberId ? null : await ctx.db.query("memberships").paginate({ cursor, numItems: 1 });
    const member = state?.migrationMemberId ? await ctx.db.get(state.migrationMemberId) : page?.page[0];
    if (member) await invalidateOwnNumberScopes(ctx, [member.userId, member.orgId], "memberships", member._id);
    return { isDone: state?.migrationMemberNextDone ?? page?.isDone ?? true, continueCursor: state?.migrationMemberNextCursor ?? page?.continueCursor ?? "" };
  }
}

export async function runOwnNumberBootstrap(ctx: MutationCtx): Promise<{ done: boolean }> {
    try {
      const key = "migration:v1";
      const state = await ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", key)).unique();
      const table = state?.migrationTable ?? 0;
      const cursor = state?.migrationCursor ?? null;
      const sourcePage = { cursor, numItems: 32, maximumRowsRead: 32, maximumBytesRead: 1024 * 1024 };
      // Pointer rows may hydrate a whole projection; retain their one-row bound.
      const pointerPage = { ...sourcePage, numItems: 1, maximumRowsRead: 1 };
      const phases = [
        async () => visitSourcePage(await ctx.db.query("users").paginate(sourcePage), (doc) => bootstrapSource(ctx, "users", doc)),
        async () => visitSourcePage(await ctx.db.query("marketplaceListings").paginate(sourcePage), (doc) => bootstrapSource(ctx, "marketplaceListings", doc)),
        async () => visitSourcePage(await ctx.db.query("marketplaceIndividualSellerProfiles").paginate(sourcePage), (doc) => bootstrapSource(ctx, "marketplaceIndividualSellerProfiles", doc)),
        async () => visitSourcePage(await ctx.db.query("branches").paginate(sourcePage), (doc) => bootstrapSource(ctx, "branches", doc)),
        async () => visitSourcePage(await ctx.db.query("marketplaceDealerProfiles").paginate(sourcePage), (doc) => bootstrapSource(ctx, "marketplaceDealerProfiles", doc)),
        async () => visitSourcePage(await ctx.db.query("marketplaceWhatsAppFlows").paginate(sourcePage), (doc) => bootstrapSource(ctx, "marketplaceWhatsAppFlows", doc)),
        async () => visitSourcePage(await ctx.db.query("websiteSettings").paginate(pointerPage), (doc) => bootstrapSource(ctx, "websiteSettings", doc)),
        async () => visitSourcePage(await ctx.db.query("websiteDomains").paginate(pointerPage), (doc) => bootstrapSource(ctx, "websiteDomains", doc)),
        async () => visitSourcePage(await ctx.db.query("users").paginate(sourcePage), (doc) => markUserOwnNumbersReady(ctx, doc._id)),
        () => bootstrapMembership(ctx, cursor, state),
        async () => visitSourcePage(await ctx.db.query("organizations").paginate(sourcePage), (doc) => markOwnNumbersReady(ctx, doc._id)),
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
    } catch {
      console.error("Own-number bootstrap failed");
      // Rethrow: catching and returning would commit a partial page.
      throw new ConvexError("Unable to prepare contact matching. Please try again later.");
    }
}
