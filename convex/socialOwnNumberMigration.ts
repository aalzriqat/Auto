import { v, ConvexError } from "convex/values";
import { internalMutation } from "./functions";
import { internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { markOwnNumbersReady, markUserOwnNumbersReady, applyOwnNumberChange, recountOwnNumberSource, prepareOwnNumberMembership, syncJoinedOwnNumber } from "./utils/socialOwnNumbers";
import { applyContactChange, invalidateOwnNumberScopes, isContactTable, contactRowScopes } from "./utils/socialOwnNumberWrites";
import { makeFunctionReference } from "convex/server";
import type { Id } from "./_generated/dataModel";
import type { PaginationResult } from "convex/server";

type MemberProgress = { id: Id<"memberships">; cursor: string; nextCursor: string; nextDone: boolean };
type MigrationPage = { isDone: boolean; continueCursor: string; join?: MemberProgress };
function repairContext(ctx: MutationCtx) { return { ...ctx, ownNumberRepair: true }; }
async function sourcePhasesComplete(ctx: MutationCtx) {
  const migration = await ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", "migration:v1")).first();
  return (migration?.migrationTable ?? 0) >= 9;
}

async function bootstrapSource(ctx: MutationCtx, table: string, doc: { _id: string; orgId?: Id<"organizations">; sellerUserId?: Id<"users"> }) {
  try {
    await ctx.runMutation(applyContactChange, { table, id: doc._id, operation: "update" });
  } catch {
    console.error("Own-number bootstrap source unavailable");
    await invalidateOwnNumberScopes(ctx, [doc.orgId ?? doc.sellerUserId ?? doc._id], table, doc._id);
  }
}

/** Only internal code can invoke this child transaction. */
export const applyChange = internalMutation({
  args: { table: v.string(), id: v.string(), operation: v.union(v.literal("insert"), v.literal("update"), v.literal("delete")), repair: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      await applyOwnNumberChange(args.repair ? repairContext(ctx) : ctx, args.table, args.id, args.operation);
      return null;
    } catch {
      console.error("Own-number child transaction rolled back");
      throw new ConvexError("Contact matching is temporarily unavailable.");
    }
  },
});

const driveRef = makeFunctionReference<"mutation", Record<string, never>, null>("socialOwnNumberMigration:drive");
const rebuildRef = makeFunctionReference<"mutation", Record<string, never>, { done: boolean }>("socialOwnNumberMigration:rebuildPage");

/** Recount both scope kinds before retries fan changes back into organizations. */
async function repairPage(ctx: MutationCtx, job: Doc<"socialOwnNumberRepairs">) {
  if (job.phase === "retry") await assertOrganizationRecountsComplete(ctx, job.scope);
  if (job.phase === "clear") {
    const rows = await ctx.db.query("socialOwnNumberCounts").withIndex("by_scope", (q) => q.eq("scope", job.scope)).take(32);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length < 32) await ctx.db.patch(job._id, { phase: "recount" });
  } else if (job.phase === "recount") {
    const page = await ctx.db.query("socialOwnNumberSources").withIndex("by_scope_kind", (q) => q.eq("scope", job.scope))
      .paginate({ cursor: job.cursor ?? null, numItems: 32, maximumRowsRead: 32, maximumBytesRead: 1024 * 1024 });
    for (const source of page.page) await recountOwnNumberSource(repairContext(ctx), source);
    await ctx.db.patch(job._id, { phase: page.isDone ? "retry" : "recount", priority: page.isDone ? job.priority + 2 : job.priority, cursor: page.isDone ? undefined : page.continueCursor });
  } else if (job.phase === "retry") {
    const retry = await ctx.db.query("socialOwnNumberRepairs").withIndex("by_scope_priority", (q) => q.eq("scope", job.scope).eq("priority", 5)).first();
    if (retry?.retryTable && retry.retryId) {
      await assertRepairDependencies(ctx, retry);
      await ctx.runMutation(applyContactChange, { table: retry.retryTable, id: retry.retryId, operation: "update", repair: true });
      await ctx.db.delete(retry._id);
      return;
    }
    await ctx.db.delete(job._id);
    const userId = ctx.db.normalizeId("users", job.scope);
    const orgId = ctx.db.normalizeId("organizations", job.scope);
    if (userId && await ctx.db.get(userId) && await sourcePhasesComplete(ctx)) await markUserOwnNumbersReady(repairContext(ctx), userId);
    const migration = await ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", "migration:v1")).first();
    if (orgId && await ctx.db.get(orgId) && migration?.migrationTable === 11) await markOwnNumbersReady(ctx, orgId);
  }
}

/** A user delta must never change a ledger beneath an organization's saved cursor. */
async function assertOrganizationRecountsComplete(ctx: MutationCtx, scope: string) {
  const userId = ctx.db.normalizeId("users", scope);
  if (!userId) return;
  const organizations = new Set<string>();
  for await (const member of ctx.db.query("memberships").withIndex("by_user", (q) => q.eq("userId", userId))) organizations.add(member.orgId);
  for await (const member of ctx.db.query("socialOwnNumberSources").withIndex("by_scope_kind", (q) => q.eq("scope", userId).eq("kind", "member"))) {
    if (member.memberOrgId) organizations.add(member.memberOrgId);
  }
  await Promise.all([...organizations].map(async (organization) => {
    const dependency = await ctx.db.query("socialOwnNumberRepairs").withIndex("by_key", (q) => q.eq("key", `scope:${organization}`)).first();
    if (dependency?.phase === "clear" || dependency?.phase === "recount") throw new Error("Organization recount remains incomplete");
  }));
}

async function assertRepairDependencies(ctx: MutationCtx, retry: Doc<"socialOwnNumberRepairs">) {
  if (!retry.retryTable || !retry.retryId || !isContactTable(retry.retryTable)) throw new Error("Invalid repair source");
  const id = ctx.db.normalizeId(retry.retryTable, retry.retryId);
  if (!id) throw new Error("Invalid repair source id");
  const source = await ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", `${retry.retryTable}:${retry.retryId}`)).first();
  const scopes = [...contactRowScopes(retry.retryTable, await ctx.db.get(id)), ...(source ? [source.scope] : [])];
  for (const scope of scopes) {
    if (scope === retry.scope || !ctx.db.normalizeId("users", scope)) continue;
    const dependency = await ctx.db.query("socialOwnNumberRepairs").withIndex("by_key", (q) => q.eq("key", `scope:${scope}`)).first();
    if (dependency) throw new Error("Dependent staff contact remains unavailable");
  }
}

export const repairScopePage = internalMutation({
  args: { jobId: v.id("socialOwnNumberRepairs") }, returns: v.null(),
  handler: async (ctx, { jobId }) => {
    try {
      const job = await ctx.db.get(jobId);
      if (job) await repairPage(ctx, job);
      return null;
    } catch {
      console.error("Own-number scope repair rolled back");
      throw new ConvexError("Contact matching repair is temporarily unavailable.");
    }
  },
});

/** Deployed cron starts/restarts this paced chain; completed ticks read one marker. */
export const drive = internalMutation({
  args: {}, returns: v.null(),
  handler: async (ctx) => {
    const state = await ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", "migration:v1")).first();
    if ((state?.retryAt ?? 0) > Date.now()) return null;
    const repair = await ctx.db.query("socialOwnNumberRepairs").withIndex("by_nextAttemptAt_priority", (q) => q.gte("nextAttemptAt", 0).lte("nextAttemptAt", Date.now())).first();
    if (state?.migrationTable === 11 && state.repairQueueVersion === 1 && !repair) return null;
    try {
      if (repair) {
        try {
          await ctx.runMutation(makeFunctionReference<"mutation", { jobId: Id<"socialOwnNumberRepairs"> }, null>("socialOwnNumberMigration:repairScopePage"), { jobId: repair._id });
        } catch {
          const attempts = (repair.attempts ?? 0) + 1;
          const exhausted = attempts >= 5;
          const delay = 1000 * 2 ** attempts;
          console.error("Own-number scope remains fenced", { attempts, exhausted });
          await ctx.db.patch(repair._id, exhausted
            ? { attempts, phase: "blocked", priority: 4, nextAttemptAt: undefined }
            : { attempts, nextAttemptAt: Date.now() + delay });
          if (!exhausted) await ctx.scheduler.runAfter(delay, driveRef, {});
        }
      } else if (state?.repairQueueVersion !== 1) {
        await ctx.runMutation(makeFunctionReference<"mutation", Record<string, never>, null>("socialOwnNumberMigration:adoptLegacyRepairsPage"), {});
      } else await ctx.runMutation(rebuildRef, {});
      const progress = await ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", "migration:v1")).first();
      if (progress) await ctx.db.patch(progress._id, { retryAt: Date.now() + 1000, retryAttempts: 0 });
      await ctx.scheduler.runAfter(1000, driveRef, {});
    } catch {
      console.error("Own-number bootstrap page will retry with backoff");
      const attempts = (state?.retryAttempts ?? 0) + 1;
      const delay = Math.min(300_000, 1000 * 2 ** Math.min(attempts, 9));
      const fields = { retryAttempts: attempts, retryAt: Date.now() + delay };
      if (state) await ctx.db.patch(state._id, fields);
      else await ctx.db.insert("socialOwnNumberSources", { key: "migration:v1", scope: "deployment", kind: "migration", phones: [], ...fields });
      await ctx.scheduler.runAfter(delay, driveRef, {});
    }
    return null;
  },
});

/** Adopt old-format scope jobs once, without requiring a production-state assumption. */
export const adoptLegacyRepairsPage = internalMutation({
  args: {}, returns: v.null(),
  handler: async (ctx) => {
    try {
      const state = await ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", "migration:v1")).unique();
      if (state?.repairQueueVersion === 1) return null;
      const page = await ctx.db.query("socialOwnNumberRepairs").withIndex("by_priority", (q) => q.lt("priority", 5))
        .paginate({ cursor: state?.repairQueueCursor ?? null, numItems: 32, maximumRowsRead: 32, maximumBytesRead: 1024 * 1024 });
      await Promise.all(page.page.filter((job) => job.nextAttemptAt === undefined && job.attempts === undefined).map((job) => ctx.db.patch(job._id, {
        phase: "clear", priority: ctx.db.normalizeId("users", job.scope) ? 0 : 1, cursor: undefined, attempts: 0, nextAttemptAt: 0,
      })));
      const fields = { repairQueueVersion: page.isDone ? 1 : undefined, repairQueueCursor: page.isDone ? undefined : page.continueCursor };
      if (state) await ctx.db.patch(state._id, fields);
      else await ctx.db.insert("socialOwnNumberSources", { key: "migration:v1", scope: "deployment", kind: "migration", phones: [], ...fields });
      return null;
    } catch {
      console.error("Own-number legacy repair adoption rolled back");
      throw new ConvexError("Contact matching repair is temporarily unavailable.");
    }
  },
});

/** A bounded operator restart keeps every fence and reads no customer history. */
export const restartBlockedRepairs = internalMutation({
  args: {}, returns: v.object({ restarted: v.number() }),
  handler: async (ctx) => {
    try {
      const jobs = await ctx.db.query("socialOwnNumberRepairs").withIndex("by_priority", (q) => q.eq("priority", 4)).take(32);
      await Promise.all(jobs.map((job) => ctx.db.patch(job._id, {
        phase: "clear", priority: ctx.db.normalizeId("users", job.scope) ? 0 : 1, cursor: undefined, attempts: 0, nextAttemptAt: 0,
      })));
      if (jobs.length) await ctx.scheduler.runAfter(0, driveRef, {});
      return { restarted: jobs.length };
    } catch {
      console.error("Own-number repair restart rolled back");
      throw new ConvexError("Contact matching repair is temporarily unavailable.");
    }
  },
});

/** Operator diagnostics: counts only; never return source, tenant or phone data. */
export const repairStatus = internalQuery({
  args: {},
  returns: v.object({ fenced: v.number(), clear: v.number(), recount: v.number(), retry: v.number(), blocked: v.number(), waiting: v.number(), oldestAgeMs: v.number() }),
  handler: async (ctx) => {
    try {
      const jobs = await ctx.db.query("socialOwnNumberRepairs").withIndex("by_priority", (q) => q.lt("priority", 5)).take(1001);
      if (jobs.length > 1000) throw new Error("Diagnostic scope limit");
      const result = { fenced: jobs.length, clear: 0, recount: 0, retry: 0, blocked: 0, waiting: 0, oldestAgeMs: 0 };
      for (const job of jobs) {
        result[job.phase]++;
        if ((job.nextAttemptAt ?? 0) > Date.now()) result.waiting++;
        result.oldestAgeMs = Math.max(result.oldestAgeMs, Date.now() - job._creationTime);
      }
      return result;
    } catch {
      console.error("Own-number repair diagnostics unavailable");
      throw new ConvexError("Contact matching status is temporarily unavailable.");
    }
  },
});

async function visitSourcePage<Row>(
  page: PaginationResult<Row>,
  visit: (doc: Row) => Promise<void>,
): Promise<MigrationPage> {
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

export const membershipPage = internalMutation({
  args: { cursor: v.union(v.string(), v.null()), stateId: v.optional(v.id("socialOwnNumberSources")) },
  returns: v.object({ isDone: v.boolean(), continueCursor: v.string(), join: v.optional(v.object({ id: v.id("memberships"), cursor: v.string(), nextCursor: v.string(), nextDone: v.boolean() })) }),
  handler: async (ctx, args): Promise<MigrationPage> => {
    try { return await rebuildMembership(ctx, args.cursor, args.stateId ? await ctx.db.get(args.stateId) : null); }
    catch {
      console.error("Own-number membership bootstrap rolled back");
      throw new ConvexError("Contact membership preparation is temporarily unavailable.");
    }
  },
});

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

/**
 * Self-driving, resumable bootstrap; a caller cannot choose
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
        const repair = await ctx.db.query("socialOwnNumberRepairs").withIndex("by_scope", (q) => q.eq("scope", orgId)).first();
        if (repair) {
          await ctx.db.delete(repair._id);
          await ctx.scheduler.runAfter(0, makeFunctionReference<"mutation", { orgId: Id<"organizations"> }, null>("socialOwnNumberMigration:purgeDeletedOrgPage"), { orgId });
          return null;
        }
        const count = await ctx.db.query("socialOwnNumberCounts").withIndex("by_scope", (q) => q.eq("scope", orgId)).first();
        if (!count) return null;
        await ctx.db.delete(count._id);
      }
      await ctx.scheduler.runAfter(0, makeFunctionReference<"mutation", { orgId: Id<"organizations"> }, null>("socialOwnNumberMigration:purgeDeletedOrgPage"), { orgId });
      return null;
    } catch {
      console.error("Own-number deletion cleanup failed");
      throw new ConvexError("Unable to finish contact cleanup. Please try again later.");
    }
  },
});
