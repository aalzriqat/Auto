import { v, ConvexError } from "convex/values";
import { internalMutation } from "./functions";
import { internalQuery, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { markOwnNumbersReady, markUserOwnNumbersReady, applyOwnNumberChange, ownNumberSourceDeltas, applyOwnNumberDeltas } from "./utils/socialOwnNumbers";
import { applyContactChange, isContactTable, contactRowScopes, affectedOwnNumberScopes } from "./utils/socialOwnNumberWrites";
import { makeFunctionReference } from "convex/server";
import { rebuildMembership, runOwnNumberBootstrap, type MigrationPage } from "./utils/socialOwnNumberBootstrap";

function repairContext(ctx: MutationCtx) { return { ...ctx, ownNumberRepair: true }; }
async function sourcePhasesComplete(ctx: MutationCtx) {
  const migration = await ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", "migration:v1")).first();
  return (migration?.migrationTable ?? 0) >= 9;
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
function repairPage(ctx: MutationCtx, job: Doc<"socialOwnNumberRepairs">) {
  switch (job.phase) {
    case "clear": return clearRepairPage(ctx, job);
    case "recount": return recountRepairPage(ctx, job);
    case "retry": return retryRepairPage(ctx, job);
    case "blocked": return;
  }
}

async function clearRepairPage(ctx: MutationCtx, job: Doc<"socialOwnNumberRepairs">) {
  const rows = await ctx.db.query("socialOwnNumberCounts").withIndex("by_scope", (q) => q.eq("scope", job.scope)).take(32);
  await Promise.all(rows.map((row) => ctx.db.delete(row._id)));
  if (rows.length < 32) await ctx.db.patch(job._id, { phase: "recount" });
}

async function recountRepairPage(ctx: MutationCtx, job: Doc<"socialOwnNumberRepairs">) {
  const page = await ctx.db.query("socialOwnNumberSources").withIndex("by_scope_kind", (q) => q.eq("scope", job.scope))
    .paginate({ cursor: job.cursor ?? null, numItems: 32, maximumRowsRead: 32, maximumBytesRead: 1024 * 1024 });
  const deltas = ownNumberSourceDeltas(page.page);
  await applyOwnNumberDeltas(repairContext(ctx), job.scope, deltas);
  await ctx.db.patch(job._id, { phase: page.isDone ? "retry" : "recount", priority: page.isDone ? job.priority + 2 : job.priority, cursor: page.isDone ? undefined : page.continueCursor });
}

async function retryRepairPage(ctx: MutationCtx, job: Doc<"socialOwnNumberRepairs">) {
  await assertOrganizationRecountsComplete(ctx, job.scope);
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
  // At phase 10 every source and membership has been processed. The readiness
  // scan can already have passed this organization while its repair was fenced.
  if (orgId && (migration?.migrationTable ?? 0) >= 10 && await ctx.db.get(orgId)) {
    await markOwnNumbersReady(ctx, orgId);
  }
}

/** A user delta must never change a ledger beneath an organization's saved cursor. */
async function assertOrganizationRecountsComplete(ctx: MutationCtx, scope: string) {
  const userId = ctx.db.normalizeId("users", scope);
  if (!userId) return;
  const organizations = await affectedOwnNumberScopes(ctx, [userId]);
  organizations.delete(userId);
  await Promise.all([...organizations].map(async (organization) => {
    const dependency = await ctx.db.query("socialOwnNumberRepairs").withIndex("by_key", (q) => q.eq("key", `scope:${organization}`)).first();
    if (dependency?.phase === "clear" || dependency?.phase === "recount") throw new Error("Organization recount remains incomplete");
  }));
}

async function assertRepairDependencies(ctx: MutationCtx, retry: Doc<"socialOwnNumberRepairs">) {
  const scopes = await sourceRepairScopes(ctx, retry);
  const currentIsUser = ctx.db.normalizeId("users", retry.scope) !== null;
  await Promise.all([...scopes].map(async (scope) => {
    if (scope === retry.scope) return;
    const dependency = await ctx.db.query("socialOwnNumberRepairs").withIndex("by_key", (q) => q.eq("key", `scope:${scope}`)).first();
    if (dependency && (dependency.phase === "clear" || dependency.phase === "recount"
      || (!currentIsUser && ctx.db.normalizeId("users", scope)))) throw new Error("Dependent contact remains unavailable");
  }));
}

async function sourceRepairScopes(ctx: MutationCtx, retry: Doc<"socialOwnNumberRepairs">) {
  if (!retry.retryTable || !retry.retryId || !isContactTable(retry.retryTable)) throw new Error("Invalid repair source");
  const id = ctx.db.normalizeId(retry.retryTable, retry.retryId);
  if (!id) throw new Error("Invalid repair source id");
  const source = await ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", `${retry.retryTable}:${retry.retryId}`)).first();
  const scopes = [...contactRowScopes(retry.retryTable, await ctx.db.get(id)), ...(source ? [source.scope] : [])];
  if (retry.retryTable === "websitePublishSnapshots") {
    const snapshotId = ctx.db.normalizeId("websitePublishSnapshots", retry.retryId);
    if (!snapshotId) throw new Error("Invalid published contact source");
    for await (const ref of ctx.db.query("socialOwnNumberSources").withIndex("by_snapshot", (q) => q.eq("snapshotId", snapshotId))) scopes.push(ref.scope);
  }
  return affectedOwnNumberScopes(ctx, scopes);
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
    await driveTick(ctx);
    return null;
  },
});

async function attemptRepair(ctx: MutationCtx, repair: Doc<"socialOwnNumberRepairs">) {
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
}

async function driveTick(ctx: MutationCtx) {
    const state = await ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", "migration:v1")).first();
    if ((state?.retryAt ?? 0) > Date.now()) return;
    const repair = await ctx.db.query("socialOwnNumberRepairs").withIndex("by_nextAttemptAt_priority", (q) => q.gte("nextAttemptAt", 0).lte("nextAttemptAt", Date.now())).first();
    if (state?.migrationTable === 11 && state.repairQueueVersion === 1 && !repair) return;
    // Deployment can start the cron before the fresh-launch zero-state check.
    // Leave a truly empty deployment write-free, including its repair queue.
    if (!state && !repair && !await ctx.db.query("organizations").first() &&
        !await ctx.db.query("users").first() && !await ctx.db.query("socialOwnNumberRepairs").first()) return;
    try {
      if (repair) {
        await attemptRepair(ctx, repair);
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

}

/** Adopt old-format scope jobs once, without requiring a production-state assumption. */
export const adoptLegacyRepairsPage = internalMutation({
  args: {}, returns: v.null(),
  handler: async (ctx) => {
    await adoptLegacyRepairs(ctx);
    return null;
  },
});

async function adoptLegacyRepairs(ctx: MutationCtx) {
    try {
      const state = await ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", "migration:v1")).unique();
      if (state?.repairQueueVersion === 1) return;
      const page = await ctx.db.query("socialOwnNumberRepairs").withIndex("by_priority", (q) => q.lt("priority", 5))
        .paginate({ cursor: state?.repairQueueCursor ?? null, numItems: 32, maximumRowsRead: 32, maximumBytesRead: 1024 * 1024 });
      await Promise.all(page.page.filter((job) => job.nextAttemptAt === undefined && job.attempts === undefined).map((job) => ctx.db.patch(job._id, {
        phase: "clear", priority: ctx.db.normalizeId("users", job.scope) ? 0 : 1, cursor: undefined, attempts: 0, nextAttemptAt: 0,
      })));
      const fields = { repairQueueVersion: page.isDone ? 1 : undefined, repairQueueCursor: page.isDone ? undefined : page.continueCursor };
      if (state) await ctx.db.patch(state._id, fields);
      else await ctx.db.insert("socialOwnNumberSources", { key: "migration:v1", scope: "deployment", kind: "migration", phones: [], ...fields });
      return;
    } catch {
      console.error("Own-number legacy repair adoption rolled back");
      throw new ConvexError("Contact matching repair is temporarily unavailable.");
    }
}

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

/**
 * Self-driving, resumable bootstrap; a caller cannot choose
 * a phase or certify an empty prefix. The final phase certifies organizations
 * only after all contact sources and membership edges have been indexed.
 * Fresh organizations are complete from creation through the normal trigger.
 */
export const rebuildPage = internalMutation({
  args: {},
  returns: v.object({ done: v.boolean() }),
  handler: runOwnNumberBootstrap,
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
