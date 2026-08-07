import { v } from "convex/values";
import { internalMutation } from "./functions";
import {
  customersByOrg,
  facebookEventsByOrg,
  instagramEventsByOrg,
  leadsByOrg,
  membershipsByOrg,
  recordSocialContact,
  namespacedThreadKey,
  syncSocialConversation,
  vehicleQualityByOrg,
  vehiclesByOrg,
} from "./aggregates";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  describeMaterializationStatus,
  readMaterializationState,
  SOCIAL_CONVERSATION_GENERATION,
  SOCIAL_PLATFORMS,
  type SocialPlatform,
} from "./utils/materialization";
import { ALL_PERMISSIONS, isSystemOwnerRole, normalizeRoleName, SYSTEM_OWNER_ROLE_NAME } from "./utils/permissions";
import {
  hasActiveDepositHold,
  hasActiveReservationHold,
  syncVehicleHoldStatus,
  resolveHoldTargetStatus,
} from "./utils/depositHelpers";

export const backfillPermissions = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Get all roles
    const roles = await ctx.db.query("roles").collect();

    for (const role of roles) {
      if (isSystemOwnerRole(role) || normalizeRoleName(role.name) === SYSTEM_OWNER_ROLE_NAME) {
        // Owner gets all permissions
        await ctx.db.patch(role._id, {
          permissions: ALL_PERMISSIONS,
          isSystemOwnerRole: true,
        });
      } else if (role.name === "MANAGER") {
        // Add new settings/approval permissions to MANAGER if not present.
        // manage:settings is intentionally NOT granted — settings administration
        // is restricted to OWNER only; approvals use the dedicated approve:requests permission.
        const permissions = new Set(role.permissions);
        permissions.add("view:settings");
        permissions.add("approve:requests");
        permissions.delete("manage:settings");

        await ctx.db.patch(role._id, {
          permissions: Array.from(permissions),
        });
      } else {
        // Other roles might need view:settings if we want them to see finance companies
        // but we'll fix listCompanies to use a less restrictive permission instead.
      }
    }

    return "Permissions backfilled successfully";
  },
});

/**
 * Seeds the `vehiclesByOrg` aggregate from the existing `vehicles` rows.
 *
 * The trigger in `convex/aggregates.ts` only sees writes that happen after it
 * is deployed, so without this every vehicle already in the table is invisible
 * to the B-tree. Worse than showing zero: the idempotent trigger inserts rows
 * as they happen to be edited, so an un-backfilled deployment shows a
 * believable *partial* count rather than an obviously broken one. Run once per
 * deployment after the component ships; a fresh deployment (preview/E2E) starts
 * empty and converges on its own.
 *
 * Paginated because a full-table mutation would blow the write budget on any
 * real org, and idempotent via `insertIfDoesNotExist` so a redrive or a partial
 * run that overlaps a live insert cannot double-count. Pagination is by
 * `_creationTime`, which no pre-existing row can change, so no row is skipped
 * by concurrent writes.
 *
 * Self-scheduling: the alternative was returning the cursor for a human to feed
 * back in, which in practice means one hand-driven dashboard call per 200
 * vehicles and a half-migrated tree whenever someone stops early. A throw rolls
 * back the scheduled continuation along with the batch's writes, so a failure
 * halts the chain cleanly rather than leaving an orphan.
 */
/** Argument shape shared by every aggregate backfill below. */
const BACKFILL_ARGS = {
  cursor: v.optional(v.union(v.string(), v.null())),
  batchSize: v.optional(v.number()),
  /** Set false to run exactly one batch — used by tests to drive it by hand. */
  continueAutomatically: v.optional(v.boolean()),
} as const;

type BackfillArgs = {
  cursor?: string | null;
  batchSize?: number;
  continueAutomatically?: boolean;
};

type BackfillResult = { migrated: number; isDone: boolean; continueCursor: string | null };

/** Tables that have an aggregate to seed. */
type BackfilledTable =
  | "vehicles"
  | "customers"
  | "leads"
  | "memberships"
  | "instagramEvents"
  | "facebookEvents";

/**
 * One page of a backfill: read a bounded slice of `table` and hand each row to
 * `seed`.
 *
 * Deliberately does *not* schedule the continuation. Each caller owns that,
 * because the scheduler needs the concrete `internal.migrations.<name>`
 * reference for its own function, and threading a `FunctionReference` through
 * here costs more in type noise than the four lines it would save.
 */
async function seedAggregatePage<T extends BackfilledTable>(
  ctx: MutationCtx,
  table: T,
  args: BackfillArgs,
  seed: (doc: Doc<T>) => Promise<void>,
): Promise<BackfillResult> {
  // Each row costs several aggregate index reads and node patches on top of
  // its own read, so the ceiling is well below what a plain paginate could
  // take. 250 keeps a batch inside the per-transaction budget; exceeding it
  // would throw and kill the self-scheduled chain.
  const numItems = Math.min(Math.max(args.batchSize ?? 100, 1), 250);

  const page = await ctx.db.query(table).paginate({
    cursor: args.cursor ?? null,
    numItems,
  });

  for (const doc of page.page) {
    // Soft-deleted rows are deliberately included: they live in the tree under
    // the deletedFlag=1 prefix so a later restore is a key move rather than an
    // insert the trigger would have to reason about.
    await seed(doc as Doc<T>);
  }

  return {
    migrated: page.page.length,
    isDone: page.isDone,
    continueCursor: page.isDone ? null : page.continueCursor,
  };
}

/**
 * Seeds the two `vehicles` aggregates from the existing rows.
 *
 * The triggers in `convex/aggregates.ts` only see writes that happen after they
 * are deployed, so without this every vehicle already in the table is invisible
 * to the B-trees. Worse than showing zero: the idempotent trigger inserts rows
 * as they happen to be edited, so an un-backfilled deployment shows a
 * believable *partial* count rather than an obviously broken one. Run once per
 * deployment after the components ship; a fresh deployment (preview/E2E) starts
 * empty and converges on its own.
 *
 * Paginated because a full-table mutation would blow the write budget on any
 * real org, and idempotent via `insertIfDoesNotExist` so a redrive or a partial
 * run that overlaps a live insert cannot double-count. Pagination is by
 * `_creationTime`, which no pre-existing row can change, so no row is skipped
 * by concurrent writes.
 *
 * Self-scheduling: the alternative was returning the cursor for a human to feed
 * back in, which in practice means one hand-driven dashboard call per 200
 * vehicles and a half-migrated tree whenever someone stops early. A throw rolls
 * back the scheduled continuation along with the batch's writes, so a failure
 * halts the chain cleanly rather than leaving an orphan.
 *
 * NOTE: on a deployment that already ran this against the *old* three-element
 * vehicle key, `insertIfDoesNotExist` is a no-op for every row — the position
 * is already occupied, under a key that is now wrong. Such a deployment needs
 * `rebuildVehicleAggregates`, not this.
 */
export const backfillVehicleAggregate = internalMutation({
  args: BACKFILL_ARGS,
  // Explicit: a self-scheduling function that infers its own return type makes
  // the inference cyclic, and the resulting errors surface in unrelated files.
  handler: async (ctx, args): Promise<BackfillResult> => {
    const result = await seedAggregatePage(ctx, "vehicles", args, async (vehicle) => {
      await vehiclesByOrg.insertIfDoesNotExist(ctx, vehicle);
      await vehicleQualityByOrg.insertIfDoesNotExist(ctx, vehicle);
    });

    if (!result.isDone && args.continueAutomatically !== false) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillVehicleAggregate, {
        cursor: result.continueCursor,
        batchSize: args.batchSize,
      });
    }

    return result;
  },
});

/**
 * Drops and re-seeds both vehicle trees.
 *
 * Required exactly once on any deployment that ran `backfillVehicleAggregate`
 * before `sourcedFlag` was added to `vehiclesByOrg`'s sort key. Those rows are
 * stored under a three-element key; the running code reads four-element bounds,
 * so every count would be answered from positions that no longer mean what the
 * reader thinks. `insertIfDoesNotExist` cannot repair that — the row is already
 * in the tree — which is why this clears first.
 *
 * Safe to run on a deployment that never had the old key; it just costs one
 * rebuild. Counts read zero between the clear and the backfill catching up,
 * which for a dashboard tile is the right way round: obviously empty beats
 * confidently wrong.
 */
export const rebuildVehicleAggregates = internalMutation({
  args: { batchSize: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ cleared: true }> => {
    await vehiclesByOrg.clearAll(ctx);
    await vehicleQualityByOrg.clearAll(ctx);

    await ctx.scheduler.runAfter(0, internal.migrations.backfillVehicleAggregate, {
      batchSize: args.batchSize,
    });

    return { cleared: true };
  },
});

/**
 * Drops and re-seeds `customersByOrg`.
 *
 * Required once on any deployment seeded before `socialFlag` entered the key.
 * Same reasoning as `rebuildVehicleAggregates`: the stored positions encode a
 * three-element key while the reader supplies four-element bounds, and
 * `insertIfDoesNotExist` will not touch a row the tree already holds.
 */
export const rebuildCustomerAggregate = internalMutation({
  args: { batchSize: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ cleared: true }> => {
    await customersByOrg.clearAll(ctx);

    await ctx.scheduler.runAfter(0, internal.migrations.backfillCustomerAggregate, {
      batchSize: args.batchSize,
    });

    return { cleared: true };
  },
});

/** Seeds `customersByOrg`. See `backfillVehicleAggregate` for the mechanics. */
export const backfillCustomerAggregate = internalMutation({
  args: BACKFILL_ARGS,
  handler: async (ctx, args): Promise<BackfillResult> => {
    const result = await seedAggregatePage(ctx, "customers", args, async (customer) => {
      await customersByOrg.insertIfDoesNotExist(ctx, customer);
    });

    if (!result.isDone && args.continueAutomatically !== false) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillCustomerAggregate, {
        cursor: result.continueCursor,
        batchSize: args.batchSize,
      });
    }

    return result;
  },
});

/** Seeds `leadsByOrg`. See `backfillVehicleAggregate` for the mechanics. */
export const backfillLeadAggregate = internalMutation({
  args: BACKFILL_ARGS,
  handler: async (ctx, args): Promise<BackfillResult> => {
    const result = await seedAggregatePage(ctx, "leads", args, async (lead) => {
      await leadsByOrg.insertIfDoesNotExist(ctx, lead);
    });

    if (!result.isDone && args.continueAutomatically !== false) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillLeadAggregate, {
        cursor: result.continueCursor,
        batchSize: args.batchSize,
      });
    }

    return result;
  },
});

/**
 * Seeds `instagramEventsByOrg`. See `backfillVehicleAggregate` for the mechanics.
 *
 * Separate from the Facebook one, and from the contact backfills below, because
 * a Convex function may run only one paginated query — a single "backfill the
 * Social Inbox" entry point that walked both tables would pass every test
 * (`convex-test` does not enforce that limit) and fail on its first production
 * call.
 */
export const backfillInstagramEventAggregate = internalMutation({
  args: BACKFILL_ARGS,
  handler: async (ctx, args): Promise<BackfillResult> => {
    const result = await seedAggregatePage(ctx, "instagramEvents", args, async (event) => {
      await instagramEventsByOrg.insertIfDoesNotExist(ctx, event);
    });

    if (!result.isDone && args.continueAutomatically !== false) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillInstagramEventAggregate, {
        cursor: result.continueCursor,
        batchSize: args.batchSize,
      });
    }

    return result;
  },
});

/** Seeds `facebookEventsByOrg`. Counterpart to `backfillInstagramEventAggregate`. */
export const backfillFacebookEventAggregate = internalMutation({
  args: BACKFILL_ARGS,
  handler: async (ctx, args): Promise<BackfillResult> => {
    const result = await seedAggregatePage(ctx, "facebookEvents", args, async (event) => {
      await facebookEventsByOrg.insertIfDoesNotExist(ctx, event);
    });

    if (!result.isDone && args.continueAutomatically !== false) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillFacebookEventAggregate, {
        cursor: result.continueCursor,
        batchSize: args.batchSize,
      });
    }

    return result;
  },
});

/**
 * Materialises a `socialContacts` row for every distinct Instagram sender
 * already in `instagramEvents`.
 *
 * The trigger that maintains this table fires on event *inserts*, so it sees
 * nothing that arrived before it deployed. Without this the "unique contacts"
 * card reads zero and then climbs only as new senders appear.
 *
 * Idempotent by construction: `recordSocialContact` is insert-if-absent against
 * the same unique index the trigger uses, so a redrive, an overlapping live
 * insert, and a second full run all converge on one row per sender. That is the
 * same property `insertIfDoesNotExist` gives the aggregate backfills, obtained
 * here at the table rather than the tree.
 */
export const backfillInstagramSocialContacts = internalMutation({
  args: BACKFILL_ARGS,
  handler: async (ctx, args): Promise<BackfillResult> => {
    const result = await seedAggregatePage(ctx, "instagramEvents", args, async (event) => {
      await recordSocialContact(ctx, event.orgId, "instagram", event.senderInstagramId);
    });

    if (!result.isDone && args.continueAutomatically !== false) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillInstagramSocialContacts, {
        cursor: result.continueCursor,
        batchSize: args.batchSize,
      });
    }

    return result;
  },
});

/** Facebook counterpart to `backfillInstagramSocialContacts`. */
export const backfillFacebookSocialContacts = internalMutation({
  args: BACKFILL_ARGS,
  handler: async (ctx, args): Promise<BackfillResult> => {
    const result = await seedAggregatePage(ctx, "facebookEvents", args, async (event) => {
      await recordSocialContact(ctx, event.orgId, "facebook", event.senderFacebookId);
    });

    if (!result.isDone && args.continueAutomatically !== false) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillFacebookSocialContacts, {
        cursor: result.continueCursor,
        batchSize: args.batchSize,
      });
    }

    return result;
  },
});

/**
 * Rebuilds `socialContacts` from the events that actually exist: clears the
 * rows, then re-derives them from `instagramEvents` and `facebookEvents`.
 *
 * ## One entry point, because the three-step version raced itself
 *
 * This began as a documented runbook — clear, then backfill Instagram, then
 * backfill Facebook. Each step self-schedules its own continuation and returns
 * to the operator after its first page, so on any deployment with more distinct
 * senders than one batch, step 2 started while step 1 was still deleting.
 * Contact rows inserted by the backfill are *newer* than the ones the clear has
 * already passed, so the still-running clear reaches them and deletes them, and
 * "unique contacts" reads permanently low with nothing failing. Following the
 * documented sequence correctly was what triggered it.
 *
 * So the phases chain here instead: each one schedules the next only once its
 * own pagination reports `isDone`. `rebuildVehicleAggregates` already works
 * this way; the runbook version was the odd one out.
 *
 * Exactly one `.paginate()` runs per invocation — the phase picks which table.
 * A Convex function may only run one, and `convex-test` does not enforce that,
 * so it has to hold by construction rather than by testing.
 *
 * ## Scope
 *
 * `orgId` confines every phase to one tenant. Without it the clear walks the
 * whole table, which zeroes the card for *every* org on the deployment until
 * the rebuild catches up — a blast radius no single org's drift justifies. The
 * unscoped form is kept for a genuine full rebuild.
 *
 * Deleting through the wrapped `ctx.db` takes the rows out of
 * `socialContactsByOrg` as it goes, so tree and table stay in step without a
 * separate `clearAll`.
 */
const REPAIR_PHASE = v.union(
  v.literal("clear"),
  v.literal("instagram"),
  v.literal("facebook")
);

type RepairPhase = "clear" | "instagram" | "facebook";

export const repairSocialContacts = internalMutation({
  args: {
    orgId: v.optional(v.id("organizations")),
    phase: v.optional(REPAIR_PHASE),
    cursor: v.optional(v.union(v.string(), v.null())),
    batchSize: v.optional(v.number()),
    continueAutomatically: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args
  ): Promise<BackfillResult & { phase: RepairPhase }> => {
    const phase: RepairPhase = args.phase ?? "clear";
    // Same ceiling and reasoning as `seedAggregatePage`: each row costs
    // aggregate node patches on top of its own write, and an unclamped
    // caller-supplied batch throws mid-chain and leaves the table half-cleared.
    const numItems = Math.min(Math.max(args.batchSize ?? 100, 1), 250);
    const orgId = args.orgId;

    // Exactly one `.paginate()` runs per invocation — the branches are mutually
    // exclusive. A Convex function may only issue one, and `convex-test` does
    // not enforce that, so the branch structure has to guarantee it rather than
    // the tests.
    //
    // Written out per phase rather than behind a generic `paginate(table)`
    // helper: `withIndex`'s field argument cannot narrow across a union of
    // table names, so the `orgId` comparison widens to every table's field
    // paths at once and fails to typecheck.
    let page;
    if (phase === "clear") {
      page = orgId
        ? await ctx.db
            .query("socialContacts")
            .withIndex("by_org", (q) => q.eq("orgId", orgId))
            .paginate({ cursor: args.cursor ?? null, numItems })
        : await ctx.db
            .query("socialContacts")
            .paginate({ cursor: args.cursor ?? null, numItems });
      for (const contact of page.page) {
        await ctx.db.delete(contact._id);
      }
    } else if (phase === "instagram") {
      page = orgId
        ? await ctx.db
            .query("instagramEvents")
            .withIndex("by_org", (q) => q.eq("orgId", orgId))
            .paginate({ cursor: args.cursor ?? null, numItems })
        : await ctx.db
            .query("instagramEvents")
            .paginate({ cursor: args.cursor ?? null, numItems });
      for (const event of page.page) {
        await recordSocialContact(ctx, event.orgId, "instagram", event.senderInstagramId);
      }
    } else {
      page = orgId
        ? await ctx.db
            .query("facebookEvents")
            .withIndex("by_org", (q) => q.eq("orgId", orgId))
            .paginate({ cursor: args.cursor ?? null, numItems })
        : await ctx.db
            .query("facebookEvents")
            .paginate({ cursor: args.cursor ?? null, numItems });
      for (const event of page.page) {
        await recordSocialContact(ctx, event.orgId, "facebook", event.senderFacebookId);
      }
    }

    if (args.continueAutomatically !== false) {
      if (!page.isDone) {
        // The clear restarts from `null`: every row it read is deleted, so the
        // next batch is the new first page. Passing the cursor back would work
        // equally well — Convex cursors encode a sort key, not an offset, so
        // both resume at the same surviving row — but `null` says plainly that
        // there is nothing to resume from. The rebuild phases only insert, so
        // theirs must be carried forward or they would restart each batch.
        await ctx.scheduler.runAfter(0, internal.migrations.repairSocialContacts, {
          orgId,
          phase,
          cursor: phase === "clear" ? null : page.continueCursor,
          batchSize: args.batchSize,
        });
      } else if (phase !== "facebook") {
        await ctx.scheduler.runAfter(0, internal.migrations.repairSocialContacts, {
          orgId,
          phase: phase === "clear" ? "instagram" : "facebook",
          batchSize: args.batchSize,
        });
      }
    }

    return {
      phase,
      migrated: page.page.length,
      isDone: page.isDone,
      // The clear phase reports no cursor, even mid-run, because it has no use
      // for one: its continuation restarts from `null`. Handing back a cursor
      // the function itself never passes invites a caller to think it must be
      // fed in to make progress.
      //
      // It would be *safe* to feed back — Convex cursors encode a sort key, not
      // an offset, so a cursor into deleted rows still resumes at the first
      // surviving row after them, and nothing is skipped. Reporting `null` is a
      // contract choice for clarity, not a guard against data loss.
      continueCursor: page.isDone || phase === "clear" ? null : page.continueCursor,
    };
  },
});

/**
 * Argument shape for the two conversation backfills.
 *
 * Org-scoped, unlike the aggregate backfills above. The aggregates are one
 * global tree per table and a global walk is the honest shape for them. A
 * conversation backfill decides whether one *tenant's* inbox may trust the
 * materialised table, and a global walk cannot answer that for any single org
 * until it has finished for all of them — one noisy tenant would hold every
 * other tenant on the slow path, and worse, there would be no truthful moment
 * at which to record that a given org was done.
 */
const CONVERSATION_BACKFILL_ARGS = {
  orgId: v.id("organizations"),
  /**
   * Present only on a scheduled continuation. Absent means "operator starting a
   * run", which allocates a fresh run and restarts from the beginning.
   */
  runId: v.optional(v.string()),
  /**
   * Set by the fan-out. Makes a start yield to a chain that is already running,
   * instead of resetting its cursor. An operator invoking a backfill by hand
   * leaves it unset and gets the restart they asked for.
   */
  onlyIfIdle: v.optional(v.boolean()),
  batchSize: v.optional(v.number()),
  /** Set false to run exactly one batch — used by tests to drive it by hand. */
  continueAutomatically: v.optional(v.boolean()),
} as const;

type ConversationBackfillResult = {
  status: "running" | "completed" | "failed" | "staleRun";
  processed: number;
  materialized: number;
  isDone: boolean;
};

/**
 * Claims the state row for this page, or returns null when the caller is a
 * continuation of a run that has been superseded.
 *
 * The fencing matters more than it looks. Without it, an operator re-running a
 * backfill while an earlier chain is still in flight leaves two chains writing
 * to one state row, each overwriting the other's cursor — and the one that
 * happens to read the last page marks the whole thing COMPLETED while the
 * other is still somewhere in the middle. Since COMPLETED is what unlocks the
 * materialised reader, that is precisely the false-completion the gate exists
 * to prevent.
 */
/**
 * The next run's sequence number, one past whatever the previous run id
 * carried. Unparseable or absent ids restart at 0, which is safe because the
 * timestamp segment still differs across milliseconds.
 */
function nextRunSequence(previousRunId: string | undefined): number {
  if (!previousRunId) return 0;
  const seq = Number(previousRunId.split(":").at(-1));
  return Number.isInteger(seq) && seq >= 0 ? seq + 1 : 0;
}

async function beginConversationBackfill(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  platform: SocialPlatform,
  runId: string | undefined,
  expectedCount: number,
  onlyIfIdle = false
): Promise<Doc<"socialMaterializationState"> | null> {
  const existing = await readMaterializationState(ctx, orgId, platform);
  const now = Date.now();

  if (runId !== undefined) {
    // A continuation. It may only proceed if it still owns the run.
    if (!existing || existing.runId !== runId) return null;
    if (existing.status !== "running") return null;
    return existing;
  }

  // A fan-out start, which is an operator start that yields to a live chain.
  //
  // The fan-out reads state and schedules in one transaction, but the worker it
  // schedules runs in another — so two fan-out invocations can both observe
  // `notStarted` and both enqueue the same org and platform. The first worker
  // inserts a `running` record; without this the second would take the operator
  // path below, reset the cursor to zero and fence the chain that was already
  // working. Progress restarts, and if that keeps happening the walk never
  // lands.
  //
  // Correctness was never at risk — `syncSocialConversation` is a full
  // recompute, so a duplicate pass converges — but liveness was.
  if (onlyIfIdle && existing) {
    const status = describeMaterializationStatus(existing, now);
    if (status === "running" || status === "completed") return null;
  }

  // An operator start. Restart from the beginning under a new run id, which
  // also fences any chain still running under the old one.
  //
  // The id carries a sequence number taken from the record it replaces, not
  // just a timestamp. `Date.now()` alone looks sufficient and is not: two
  // operator starts inside the same millisecond produce identical ids, the
  // second fails to fence the first, and two chains then share one cursor —
  // which is exactly the false-completion this mechanism exists to prevent.
  // Reading the previous sequence makes it strictly increasing without relying
  // on `Math.random()` or `crypto.randomUUID()`, neither of which this file
  // should assume after `events.at(-1)` had to be proven against a live
  // deployment.
  const nextRunId = `${platform}:${now}:${nextRunSequence(existing?.runId)}`;
  const fresh = {
    orgId,
    platform,
    generation: SOCIAL_CONVERSATION_GENERATION,
    status: "running" as const,
    runId: nextRunId,
    cursor: undefined,
    processedCount: 0,
    materializedCount: 0,
    expectedCount,
    startedAt: now,
    lastProgressAt: now,
    completedAt: undefined,
    failureMessage: undefined,
  };

  if (existing) {
    await ctx.db.patch(existing._id, fresh);
    return { ...existing, ...fresh };
  }
  const id = await ctx.db.insert("socialMaterializationState", fresh);
  const inserted = await ctx.db.get(id);
  if (!inserted) throw new Error("materialization state vanished immediately after insert");
  return inserted;
}

/**
 * Records one page's progress, and completion only on proven exhaustion.
 *
 * `page.isDone` is the *only* thing that may write COMPLETED. Not "the batch
 * returned without throwing", not "nothing changed this time", and not
 * "processed reached expected" — `expectedCount` is a live aggregate that
 * inbound messages move underneath the run, so treating it as a finish line
 * would mark a backfill complete while rows remained, or never at all.
 */
async function recordConversationBackfillProgress(
  ctx: MutationCtx,
  state: Doc<"socialMaterializationState">,
  page: { page: unknown[]; isDone: boolean; continueCursor: string },
  materialized: number,
  expectedCount: number
): Promise<ConversationBackfillResult> {
  const now = Date.now();
  const processedCount = state.processedCount + page.page.length;
  const materializedCount = state.materializedCount + materialized;

  await ctx.db.patch(state._id, {
    processedCount,
    materializedCount,
    expectedCount,
    lastProgressAt: now,
    cursor: page.isDone ? undefined : page.continueCursor,
    status: page.isDone ? "completed" : "running",
    completedAt: page.isDone ? now : undefined,
  });

  return {
    status: page.isDone ? "completed" : "running",
    processed: processedCount,
    materialized: materializedCount,
    isDone: page.isDone,
  };
}

/** Batch ceiling, shared by both conversation backfills. See `seedAggregatePage`. */
function conversationBatchSize(batchSize: number | undefined): number {
  return Math.min(Math.max(batchSize ?? 100, 1), 250);
}

/**
 * Records a run as failed rather than leaving it silently stalled.
 *
 * Only reachable for errors the handler can catch. A Convex transaction limit
 * kills the transaction outright and rolls this write back with everything
 * else, which is why `interrupted` — derived from a stale `lastProgressAt` —
 * remains the catch-all signal. Both are non-`completed`, so the reader falls
 * back either way; the difference is only how legible the state is to whoever
 * has to fix it.
 */
export async function recordConversationBackfillFailure(
  ctx: MutationCtx,
  state: Doc<"socialMaterializationState">,
  error: unknown
): Promise<ConversationBackfillResult> {
  console.error("social conversation backfill failed", error);
  await ctx.db.patch(state._id, {
    status: "failed",
    lastProgressAt: Date.now(),
    // Truncated and generic: this string reaches an admin screen, and raw
    // Convex errors leak schema and row shapes.
    failureMessage:
      error instanceof Error ? error.message.slice(0, 300) : "Unknown backfill error",
  });
  return { status: "failed", processed: state.processedCount, materialized: 0, isDone: false };
}

/**
 * Rebuilds every distinct thread represented in one page of a backfill, and
 * returns how many it rebuilt.
 *
 * One sync per distinct *thread*, not per event. A thread's events are
 * contiguous in creation time — they arrive as a burst — so a batch can be
 * dominated by one thread and would otherwise recompute it once per event,
 * making the batch cost events x history instead of threads x history. That is
 * what pushes a batch past the per-transaction read ceiling, and a throw there
 * rolls back the scheduled continuation too, halting the chain mid-table.
 *
 * Shared by both platform backfills because that rule is the load-bearing part
 * and two copies of it are two places for it to drift. The `.paginate()` calls
 * deliberately stay in the callers: Convex permits exactly one per function,
 * `convex-test` does not enforce it, and this repo has already shipped a
 * backfill that passed the whole suite and then failed on its first production
 * call. That constraint has to stay visible where it applies.
 */
async function syncThreadsInBackfillPage(
  ctx: MutationCtx,
  platform: SocialPlatform,
  events: (Doc<"instagramEvents"> | Doc<"facebookEvents">)[]
): Promise<number> {
  const synced = new Set<string>();
  for (const event of events) {
    if (!event.customerId) continue;
    const identity = {
      orgId: event.orgId,
      platform,
      customerId: event.customerId,
      kind: event.kind,
      postId: event.postId,
    };
    const key = namespacedThreadKey(identity);
    if (synced.has(key)) continue;
    synced.add(key);
    await syncSocialConversation(ctx, identity);
  }
  return synced.size;
}

/**
 * Starts both conversation backfills for every organization.
 *
 * Without this the migration has no operator surface at all: the two backfills
 * are org-scoped, so running them means invoking 2N internal mutations by hand
 * with no way to enumerate N — and until they run, every tenant stays on the
 * legacy full-scan path, which is the entire cost this work exists to remove.
 * A gate that is never unlocked is just a slower inbox.
 *
 * Safe to re-run. Each per-org backfill allocates a fresh run and restarts,
 * and `syncSocialConversation` is a full recompute, so a redrive converges
 * rather than duplicating.
 */
export const startSocialConversationBackfills = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    batchSize: v.optional(v.number()),
    continueAutomatically: v.optional(v.boolean()),
    /** Rebuild orgs that are already proven complete at this generation. */
    force: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args
  ): Promise<{ started: number; skipped: number; isDone: boolean }> => {
    // THE one paginated query. Organizations are walked in pages so a tenant
    // count that grows past a single transaction cannot wedge the fan-out.
    const page = await ctx.db.query("organizations").paginate({
      cursor: args.cursor ?? null,
      numItems: 25,
    });

    // Decided per platform, not per org. An org can have Instagram mid-walk and
    // Facebook not started, and the two want opposite answers.
    const BACKFILL_FOR: Record<SocialPlatform, typeof internal.migrations.backfillInstagramConversations> = {
      instagram: internal.migrations.backfillInstagramConversations,
      facebook: internal.migrations.backfillFacebookConversations,
    };

    let started = 0;
    let skipped = 0;
    const now = Date.now();
    for (const org of page.page) {
      for (const platform of SOCIAL_PLATFORMS) {
        const status = describeMaterializationStatus(
          await readMaterializationState(ctx, org._id, platform),
          now
        );

        // `completed` is skipped because starting a run resets the record to
        // `running`, which un-readies the org and drops it back to the full
        // event scan for the length of the walk. Over a migrated deployment
        // that would put every tenant back on the 1.34 GB/week path at once,
        // for no gain: the rows are already complete and the trigger keeps them
        // current.
        //
        // `running` is skipped for a sharper reason. Re-enqueuing sends it
        // through the operator-start path, which resets `cursor` and
        // `processedCount` and fences the chain already doing the work — so an
        // operator re-running the fan-out to *check on* progress restarts it
        // instead, and on a long walk that is a livelock. `interrupted`,
        // `failed` and `notStarted` all do want a new run.
        const settled = status === "completed" || status === "running";
        if (args.force !== true && settled) {
          skipped += 1;
          continue;
        }

        started += 1;
        // `continueAutomatically` reaches the per-org chains too. Gating only
        // the org walk meant an operator asking for a single step still kicked
        // off full self-chaining runs for up to 25 tenants.
        await ctx.scheduler.runAfter(0, BACKFILL_FOR[platform], {
          orgId: org._id,
          batchSize: args.batchSize,
          continueAutomatically: args.continueAutomatically,
          // The fan-out reads and schedules in separate transactions, so this
          // decision can be stale by the time the worker runs. `onlyIfIdle`
          // makes the worker re-check and stand down rather than restart a
          // chain that started in between. `force` deliberately overrides it.
          onlyIfIdle: args.force !== true,
        });
      }
    }

    if (!page.isDone && args.continueAutomatically !== false) {
      await ctx.scheduler.runAfter(0, internal.migrations.startSocialConversationBackfills, {
        cursor: page.continueCursor,
        batchSize: args.batchSize,
        force: args.force,
        // Carried for symmetry with `force`. Only `true`/`undefined` can reach
        // here today (a `false` short-circuits the branch above), but an
        // asymmetric propagation is how a third semantic for this flag would
        // break silently on page 2 and not page 1.
        continueAutomatically: args.continueAutomatically,
      });
    }

    return { started, skipped, isDone: page.isDone };
  },
});

/**
 * Materialises `socialConversations` for one org's Instagram events that
 * predate the trigger, and records whether that has been proven exhaustive.
 *
 * Idempotent because `syncSocialConversation` is a full recompute keyed on the
 * thread, not an increment: running it twice over the same event, or over two
 * events in the same thread, converges on the identical row. That is the same
 * property the aggregate backfills get from `insertIfDoesNotExist`, obtained
 * here from the rebuild being a pure function of the thread's events. A resumed
 * or restarted run therefore cannot duplicate or double-count a conversation.
 *
 * Separate from the Facebook one because a Convex function may run only one
 * paginated query, and `convex-test` does not enforce that.
 */
export const backfillInstagramConversations = internalMutation({
  args: CONVERSATION_BACKFILL_ARGS,
  handler: async (ctx, args): Promise<ConversationBackfillResult> => {
    const expectedCount = await instagramEventsByOrg.count(ctx, {
      namespace: args.orgId,
      bounds: {},
    });
    const state = await beginConversationBackfill(
      ctx,
      args.orgId,
      "instagram",
      args.runId,
      expectedCount,
      args.onlyIfIdle
    );
    if (!state) return { status: "staleRun", processed: 0, materialized: 0, isDone: false };

    // THE one paginated query this function is allowed. Convex permits exactly
    // one per function and `convex-test` does not enforce it, so keeping it
    // visible here — rather than behind a shared helper — is deliberate.
    const page = await ctx.db
      .query("instagramEvents")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .paginate({
        cursor: state.cursor ?? null,
        numItems: conversationBatchSize(args.batchSize),
      });

    let materialized: number;
    try {
      materialized = await syncThreadsInBackfillPage(ctx, "instagram", page.page);
    } catch (error) {
      // Deliberately not rethrown: rethrowing rolls the transaction back, and
      // with it the very record that says the run failed.
      return await recordConversationBackfillFailure(ctx, state, error);
    }

    const result = await recordConversationBackfillProgress(
      ctx,
      state,
      page,
      materialized,
      expectedCount
    );

    if (!result.isDone && args.continueAutomatically !== false) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillInstagramConversations, {
        orgId: args.orgId,
        runId: state.runId,
        batchSize: args.batchSize,
      });
    }

    return result;
  },
});

/** Facebook counterpart to `backfillInstagramConversations`. */
export const backfillFacebookConversations = internalMutation({
  args: CONVERSATION_BACKFILL_ARGS,
  handler: async (ctx, args): Promise<ConversationBackfillResult> => {
    const expectedCount = await facebookEventsByOrg.count(ctx, {
      namespace: args.orgId,
      bounds: {},
    });
    const state = await beginConversationBackfill(
      ctx,
      args.orgId,
      "facebook",
      args.runId,
      expectedCount,
      args.onlyIfIdle
    );
    if (!state) return { status: "staleRun", processed: 0, materialized: 0, isDone: false };

    // THE one paginated query this function is allowed. Convex permits exactly
    // one per function and `convex-test` does not enforce it, so keeping it
    // visible here — rather than behind a shared helper — is deliberate.
    const page = await ctx.db
      .query("facebookEvents")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .paginate({
        cursor: state.cursor ?? null,
        numItems: conversationBatchSize(args.batchSize),
      });

    let materialized: number;
    try {
      materialized = await syncThreadsInBackfillPage(ctx, "facebook", page.page);
    } catch (error) {
      // Deliberately not rethrown: rethrowing rolls the transaction back, and
      // with it the very record that says the run failed.
      return await recordConversationBackfillFailure(ctx, state, error);
    }

    const result = await recordConversationBackfillProgress(
      ctx,
      state,
      page,
      materialized,
      expectedCount
    );

    if (!result.isDone && args.continueAutomatically !== false) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillFacebookConversations, {
        orgId: args.orgId,
        runId: state.runId,
        batchSize: args.batchSize,
      });
    }

    return result;
  },
});

/** Seeds `membershipsByOrg`. See `backfillVehicleAggregate` for the mechanics. */
export const backfillMembershipAggregate = internalMutation({
  args: BACKFILL_ARGS,
  handler: async (ctx, args): Promise<BackfillResult> => {
    const result = await seedAggregatePage(ctx, "memberships", args, async (membership) => {
      await membershipsByOrg.insertIfDoesNotExist(ctx, membership);
    });

    if (!result.isDone && args.continueAutomatically !== false) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillMembershipAggregate, {
        cursor: result.continueCursor,
        batchSize: args.batchSize,
      });
    }

    return result;
  },
});

/**
 * Re-derives every vehicle's hold status for one org from the holds that
 * actually exist.
 *
 * A vehicle sits at RESERVED because something holds it — an active deposit or
 * an active `vehicleReservations` row. Delete those without touching the
 * vehicle and the status becomes a claim nothing backs: the car reads as
 * unavailable, cannot be sold again, and no release path exists, because
 * `releaseReservation` needs the reservation row that is already gone. That is
 * exactly the state the Bloom Cars financial reset left behind, by design — the
 * decision then was to leave inventory untouched.
 *
 * This calls the application's own `syncVehicleHoldStatus` rather than writing
 * "AVAILABLE" over anything that looks stuck. That helper is what every deposit
 * and reservation path already uses, so a vehicle ends up in the state the app
 * would have put it in, and the two cannot drift. It also means the reconcile
 * is safe in both directions: a vehicle wrongly left AVAILABLE while a hold is
 * live gets moved back to RESERVED.
 *
 * SOLD and ARCHIVED vehicles are skipped by that helper and stay as they are —
 * a sold car is not "unheld", and re-listing one because its sale row was
 * deleted would be worse than the inconsistency it fixes.
 *
 * `dryRun` defaults to **true**: the safe call is the one you get by forgetting
 * the flag.
 */
export const reconcileVehicleHolds = internalMutation({
  args: {
    orgId: v.id("organizations"),
    dryRun: v.optional(v.boolean()),
    batchSize: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args
  ): Promise<{
    dryRun: boolean;
    scanned: number;
    released: Array<{ vehicleId: string; from: string; to: string }>;
  }> => {
    const dryRun = args.dryRun ?? true;
    const limit = Math.min(Math.max(args.batchSize ?? 500, 1), 1000);

    const vehicles = await ctx.db
      .query("vehicles")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(limit);

    const released: Array<{ vehicleId: string; from: string; to: string }> = [];

    for (const vehicle of vehicles) {
      if (vehicle.isDeleted) continue;

      const hasHold =
        (await hasActiveDepositHold(ctx, vehicle._id)) ||
        (await hasActiveReservationHold(ctx, { orgId: args.orgId, vehicleId: vehicle._id }));

      // Ask the hold state machine itself what it would do, rather than
      // re-deriving it here. The previous flat RESERVED/AVAILABLE pair drifted
      // from `syncVehicleHoldStatus` in two ways: it could not see that a
      // SOURCING car with a live hold needs promoting (so the one migration
      // meant to repair hold drift skipped exactly the rows that produced this
      // bug), and it printed "to: AVAILABLE" for a released hold that now
      // restores `preHoldStatus` — a dry run that disagreed with the write.
      //
      // A null target means "leave it alone", which is what keeps SOLD and
      // ARCHIVED out (a sold car is not "unheld", and re-listing one because
      // its sale row was deleted would be worse than the inconsistency being
      // fixed), along with IN_INSPECTION/IN_REPAIR and any unheld SOURCING car
      // that is simply still on order.
      const target = resolveHoldTargetStatus(vehicle, hasHold);
      if (target === null || vehicle.status === target) continue;

      released.push({ vehicleId: vehicle._id.toString(), from: vehicle.status, to: target });
      if (!dryRun) {
        await syncVehicleHoldStatus(ctx, vehicle._id);
      }
    }

    return { dryRun, scanned: vehicles.length, released };
  },
});

/**
 * Strips finance-company accepted-status references that point at customer
 * status rows which no longer exist.
 *
 * `orgCustomerStatuses.remove` used to hard-delete a status without clearing it
 * from `financeCompanies.acceptedStatuses`. Every company that accepted that
 * status was left holding an id naming no row, with two consequences: the
 * company could not be saved at all, because its edit dialog re-sent the
 * dangling id and the finance mutation rejected it; and the sales wizard's
 * finance comparison matched the company against no customer status at all, so
 * it quietly stopped being offered.
 *
 * The delete now cascades and a save repairs the row it touches, so this exists
 * for companies nobody has re-saved since — the silent half of the bug, which
 * shows no error to anyone.
 *
 * A company whose entire list was dangling ends up with an empty array, which
 * the comparison reads as "accepts every customer" — the same meaning it
 * carries for a company that never restricted its statuses.
 *
 * `dryRun` defaults to **true**: the safe call is the one you get by forgetting
 * the flag.
 */
export const cleanupDanglingAcceptedStatuses = internalMutation({
  args: {
    orgId: v.id("organizations"),
    dryRun: v.optional(v.boolean()),
    batchSize: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args
  ): Promise<{
    dryRun: boolean;
    scanned: number;
    repaired: Array<{ companyId: string; name: string; removed: number; remaining: number; deactivated: boolean }>;
    crossOrgReferences: Array<{ companyId: string; name: string; count: number }>;
    isDone: boolean;
    continueCursor: string | null;
  }> => {
    const dryRun = args.dryRun ?? true;
    const batchSize = Math.min(Math.max(args.batchSize ?? 200, 1), 500);

    // Paginated rather than collected: this reads one status document per
    // accepted reference and patches every affected company in a single
    // transaction, so an org with a long company list could blow Convex's read
    // or write limits and fail after reporting what it would have done. Feed
    // `continueCursor` back in until `isDone`.
    const page = await ctx.db
      .query("financeCompanies")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .paginate({ numItems: batchSize, cursor: args.cursor ?? null });
    const companies = page.page;

    const repaired: Array<{ companyId: string; name: string; removed: number; remaining: number; deactivated: boolean }> = [];
    // Reported, never rewritten. A cross-org id is a data problem to look at
    // rather than one to erase silently — but it is also the one value that
    // still makes a company unsaveable, so leaving it out of the report would
    // mark such a row "clean" while it stays stuck. Nothing writes one today;
    // a raw import, a restore or an org merge could.
    const crossOrgReferences: Array<{ companyId: string; name: string; count: number }> = [];

    for (const company of companies) {
      const accepted = company.acceptedStatuses;
      if (!accepted || accepted.length === 0) continue;

      const live: typeof accepted = [];
      let crossOrg = 0;
      for (const statusId of accepted) {
        const status = await ctx.db.get(statusId);
        if (!status) continue;
        if (status.orgId !== args.orgId) crossOrg += 1;
        live.push(statusId);
      }

      if (crossOrg > 0) {
        crossOrgReferences.push({
          companyId: company._id.toString(),
          name: company.name,
          count: crossOrg,
        });
      }

      if (live.length === accepted.length) continue;

      // Same fail-closed rule as the delete cascade: a company whose whole list
      // was dangling would otherwise come out of this repair reading as
      // "accepts every customer". It currently matches nobody, so deactivating
      // preserves the behaviour it already has and makes it visible, instead of
      // quietly widening a lender's eligibility during a cleanup run.
      const deactivate = live.length === 0 && company.isActive;

      repaired.push({
        companyId: company._id.toString(),
        name: company.name,
        removed: accepted.length - live.length,
        remaining: live.length,
        deactivated: deactivate,
      });

      if (!dryRun) {
        await ctx.db.patch(company._id, {
          acceptedStatuses: live,
          ...(deactivate ? { isActive: false } : {}),
        });
      }
    }

    return {
      dryRun,
      scanned: companies.length,
      repaired,
      crossOrgReferences,
      isDone: page.isDone,
      continueCursor: page.isDone ? null : page.continueCursor,
    };
  },
});
