import { v } from "convex/values";
import { internalMutation } from "./functions";
import {
  customersByOrg,
  facebookEventsByOrg,
  instagramEventsByOrg,
  leadsByOrg,
  membershipsByOrg,
  recordSocialContact,
  socialConversationKey,
  syncSocialConversation,
  vehicleQualityByOrg,
  vehiclesByOrg,
} from "./aggregates";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
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
 * Materialises `socialConversations` for the Instagram events that predate the
 * trigger.
 *
 * Idempotent because `syncSocialConversation` is a full recompute keyed on the
 * thread, not an increment: running it twice over the same event, or over two
 * events in the same thread, converges on the identical row. That is the same
 * property the aggregate backfills get from `insertIfDoesNotExist`, obtained
 * here from the rebuild being a pure function of the thread's events.
 *
 * Separate from the Facebook one because a Convex function may run only one
 * paginated query, and `convex-test` does not enforce that.
 */
export const backfillInstagramConversations = internalMutation({
  args: BACKFILL_ARGS,
  handler: async (ctx, args): Promise<BackfillResult> => {
    // One sync per distinct thread, not per event. A thread's events are
    // contiguous in creation time — they arrive as a burst — so a batch can be
    // dominated by one thread and would otherwise recompute it once per event,
    // making the batch cost events x history instead of threads x history. That
    // is what pushes a batch past the per-transaction read ceiling, and a throw
    // there rolls back the scheduled continuation too, halting the chain
    // mid-table and leaving the inbox permanently half-materialised.
    const synced = new Set<string>();
    const result = await seedAggregatePage(ctx, "instagramEvents", args, async (event) => {
      if (!event.customerId) return;
      const identity = {
        orgId: event.orgId,
        platform: "instagram" as const,
        customerId: event.customerId,
        kind: event.kind,
        postId: event.postId,
      };
      const key = `${identity.orgId}:${socialConversationKey(identity)}`;
      if (synced.has(key)) return;
      synced.add(key);
      await syncSocialConversation(ctx, identity);
    });

    if (!result.isDone && args.continueAutomatically !== false) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillInstagramConversations, {
        cursor: result.continueCursor,
        batchSize: args.batchSize,
      });
    }

    return result;
  },
});

/** Facebook counterpart to `backfillInstagramConversations`. */
export const backfillFacebookConversations = internalMutation({
  args: BACKFILL_ARGS,
  handler: async (ctx, args): Promise<BackfillResult> => {
    // One sync per distinct thread, not per event. A thread's events are
    // contiguous in creation time — they arrive as a burst — so a batch can be
    // dominated by one thread and would otherwise recompute it once per event,
    // making the batch cost events x history instead of threads x history. That
    // is what pushes a batch past the per-transaction read ceiling, and a throw
    // there rolls back the scheduled continuation too, halting the chain
    // mid-table and leaving the inbox permanently half-materialised.
    const synced = new Set<string>();
    const result = await seedAggregatePage(ctx, "facebookEvents", args, async (event) => {
      if (!event.customerId) return;
      const identity = {
        orgId: event.orgId,
        platform: "facebook" as const,
        customerId: event.customerId,
        kind: event.kind,
        postId: event.postId,
      };
      const key = `${identity.orgId}:${socialConversationKey(identity)}`;
      if (synced.has(key)) return;
      synced.add(key);
      await syncSocialConversation(ctx, identity);
    });

    if (!result.isDone && args.continueAutomatically !== false) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillFacebookConversations, {
        cursor: result.continueCursor,
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
