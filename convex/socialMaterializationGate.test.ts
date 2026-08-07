import { convexTestWithComponents } from "../test-utils/convexTest";
import { seedOrgWithMember, VIEWER_PERMISSIONS } from "../test-utils/seedOrg";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { SOCIAL_CONVERSATION_GENERATION } from "./utils/materialization";
import type { Id } from "./_generated/dataModel";

/**
 * The readiness gate in front of `socialInbox.listConversations`.
 *
 * ## The incident these tests exist for
 *
 * On 2026-08-07 the materialised reader was deployed to production while
 * `socialConversations` was still empty, because the backfill had not been run.
 * The Social Inbox answered "no conversations" for an org holding 347 Instagram
 * and 689 Facebook events. Nothing threw, nothing logged, and staff had no way
 * to tell an empty inbox from an unbuilt one — the failure was a *confident*
 * wrong answer, which is the worst kind for a table whose whole purpose is
 * showing customer messages nobody has replied to yet.
 *
 * The fix is that the materialised table is authoritative only when a backfill
 * for the current generation has proven, by exhausting the source, that it
 * holds every thread. Everything else falls back to reading events directly.
 *
 * These tests pin the states that must NOT unlock the fast path. Each one is a
 * way the old code would have shipped an empty or short list.
 */

async function seedOrg(
  t: ReturnType<typeof convexTestWithComponents>,
  clerkId: string
) {
  const { orgId, identity } = await seedOrgWithMember(t, {
    clerkId,
    permissions: VIEWER_PERMISSIONS,
  });
  return { orgId, asEditor: identity };
}

async function makeCustomer(
  t: ReturnType<typeof convexTestWithComponents>,
  orgId: Id<"organizations">,
  first: string
) {
  return await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: first, lastName: "Buyer" })
  );
}

/**
 * Events written with the triggers bypassed — the exact state of every row that
 * already existed when the materialisation shipped.
 */
async function seedLegacyEvents(
  t: ReturnType<typeof convexTestWithComponents>,
  orgId: Id<"organizations">,
  customerId: Id<"customers">,
  count: number
) {
  await t.runUnwrapped(async (ctx) => {
    for (let i = 0; i < count; i++) {
      await ctx.db.insert("instagramEvents", {
        orgId,
        externalId: `legacy_ig_${orgId}_${i}`,
        kind: "dm",
        senderInstagramId: "ig_sender",
        customerId,
        text: `legacy message ${i}`,
      });
    }
  });
}

async function listConversations(
  asEditor: ReturnType<ReturnType<typeof convexTestWithComponents>["withIdentity"]>,
  orgId: Id<"organizations">
) {
  const result = await asEditor.query(api.socialInbox.listConversations, {
    orgId,
    paginationOpts: { numItems: 50, cursor: null },
  });
  return result.page;
}

/** Writes a state row directly, to stage states a real run passes through. */
async function writeState(
  t: ReturnType<typeof convexTestWithComponents>,
  orgId: Id<"organizations">,
  platform: "instagram" | "facebook",
  overrides: Record<string, unknown>
) {
  await t.run((ctx) =>
    ctx.db.insert("socialMaterializationState", {
      orgId,
      platform,
      generation: SOCIAL_CONVERSATION_GENERATION,
      status: "completed",
      runId: "test",
      processedCount: 0,
      materializedCount: 0,
      expectedCount: 0,
      startedAt: Date.now(),
      lastProgressAt: Date.now(),
      completedAt: Date.now(),
      ...overrides,
    })
  );
}

/** Marks both platforms complete at the current generation. */
async function markReady(
  t: ReturnType<typeof convexTestWithComponents>,
  orgId: Id<"organizations">
) {
  await writeState(t, orgId, "instagram", {});
  await writeState(t, orgId, "facebook", {});
}

describe("materialization readiness gate", () => {
  test("THE INCIDENT: empty materialization must not report an empty inbox", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrg(t, "gate_incident");
    const customer = await makeCustomer(t, orgId, "Alice");
    await seedLegacyEvents(t, orgId, customer, 3);

    // Precisely the production state: events exist, nothing is materialised,
    // and no backfill has run.
    expect(await t.run((ctx) => ctx.db.query("socialConversations").collect())).toHaveLength(0);
    expect(
      await t.run((ctx) => ctx.db.query("socialMaterializationState").collect())
    ).toHaveLength(0);

    const page = await listConversations(asEditor, orgId);
    expect(page).toHaveLength(1);
    expect(page[0].eventCount).toBe(3);
    expect(page[0].customerId).toBe(customer);
  });

  test("a run still in progress does not unlock the materialized path", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrg(t, "gate_running");
    // Three separate customers means three separate threads, so a partial run
    // leaves a materialised table that is genuinely SHORT rather than merely
    // unfinished. With a single thread the first page already recomputes it in
    // full and the two paths agree by accident — which would make this test
    // pass with the gate removed, and prove nothing.
    const alice = await makeCustomer(t, orgId, "Bob");
    const bea = await makeCustomer(t, orgId, "Bea");
    const cyd = await makeCustomer(t, orgId, "Cyd");
    for (const c of [alice, bea, cyd]) await seedLegacyEvents(t, orgId, c, 1);

    // Partway through: one thread materialised, status still running.
    await t.mutation(internal.migrations.backfillInstagramConversations, {
      orgId,
      batchSize: 1,
      continueAutomatically: false,
    });
    const midRun = await t.run((ctx) =>
      ctx.db.query("socialMaterializationState").collect()
    );
    expect(midRun.some((r) => r.status === "running")).toBe(true);
    const materialized = await t.run((ctx) => ctx.db.query("socialConversations").collect());
    expect(materialized).toHaveLength(1);

    // The gate must ignore that partial table and answer from the events.
    const page = await listConversations(asEditor, orgId);
    expect(page).toHaveLength(3);
  });

  test("one platform complete is not enough — the inbox lists both", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrg(t, "gate_one_platform");
    const customer = await makeCustomer(t, orgId, "Cara");
    await seedLegacyEvents(t, orgId, customer, 2);
    await writeState(t, orgId, "instagram", {});

    const page = await listConversations(asEditor, orgId);
    expect(page).toHaveLength(1);
    expect(page[0].eventCount).toBe(2);
  });

  test("a COMPLETED record for an older generation does not unlock the reader", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrg(t, "gate_old_gen");
    const customer = await makeCustomer(t, orgId, "Dana");
    await seedLegacyEvents(t, orgId, customer, 2);

    await writeState(t, orgId, "instagram", {
      generation: SOCIAL_CONVERSATION_GENERATION - 1,
    });
    await writeState(t, orgId, "facebook", {
      generation: SOCIAL_CONVERSATION_GENERATION - 1,
    });

    const page = await listConversations(asEditor, orgId);
    expect(page).toHaveLength(1);
    expect(page[0].eventCount).toBe(2);
  });

  test("a failed run does not unlock the reader", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrg(t, "gate_failed");
    const customer = await makeCustomer(t, orgId, "Erin");
    await seedLegacyEvents(t, orgId, customer, 2);
    await writeState(t, orgId, "instagram", { status: "failed", completedAt: undefined });
    await writeState(t, orgId, "facebook", { status: "failed", completedAt: undefined });

    expect(await listConversations(asEditor, orgId)).toHaveLength(1);
  });

  test("proven completion switches the reader to the materialized table", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrg(t, "gate_complete");
    const customer = await makeCustomer(t, orgId, "Finn");
    await seedLegacyEvents(t, orgId, customer, 3);

    const viaLegacy = await listConversations(asEditor, orgId);

    vi.useFakeTimers();
    try {
      await t.mutation(internal.migrations.backfillInstagramConversations, { orgId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      await t.mutation(internal.migrations.backfillFacebookConversations, { orgId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }

    const states = await t.run((ctx) => ctx.db.query("socialMaterializationState").collect());
    expect(states).toHaveLength(2);
    expect(states.every((s) => s.status === "completed")).toBe(true);
    expect(states.every((s) => s.completedAt !== undefined)).toBe(true);

    // Same answer, now off the index rather than a full scan.
    const viaMaterialized = await listConversations(asEditor, orgId);
    expect(viaMaterialized.map((c) => c.customerId)).toEqual(viaLegacy.map((c) => c.customerId));
    expect(viaMaterialized[0].eventCount).toBe(3);
    expect(viaMaterialized[0].latestCreationTime).toBe(viaLegacy[0].latestCreationTime);
  });

  test("one org's completion cannot unlock another org's reader", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ready = await seedOrg(t, "gate_tenant_ready");
    const notReady = await seedOrg(t, "gate_tenant_not_ready");

    const readyCustomer = await makeCustomer(t, ready.orgId, "Gail");
    const otherCustomer = await makeCustomer(t, notReady.orgId, "Hana");
    await seedLegacyEvents(t, ready.orgId, readyCustomer, 2);
    await seedLegacyEvents(t, notReady.orgId, otherCustomer, 5);

    await markReady(t, ready.orgId);

    // The ready org trusts a table that has nothing in it for them yet, which is
    // its own (separately tested) hazard — what matters here is that the second
    // org is unaffected by the first org's record.
    expect(await listConversations(ready.asEditor, ready.orgId)).toHaveLength(0);

    const otherPage = await listConversations(notReady.asEditor, notReady.orgId);
    expect(otherPage).toHaveLength(1);
    expect(otherPage[0].eventCount).toBe(5);
  });

  test("an org with no events completes, and completion is not inferred from emptiness", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrg(t, "gate_zero_rows");

    // Before: no state row at all. Zero conversations is the right answer, but
    // it must come from the legacy path, not from trusting an unbuilt table.
    expect(await listConversations(asEditor, orgId)).toHaveLength(0);
    expect(
      await t.run((ctx) => ctx.db.query("socialMaterializationState").collect())
    ).toHaveLength(0);

    vi.useFakeTimers();
    try {
      const result = await t.mutation(internal.migrations.backfillInstagramConversations, {
        orgId,
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      // Zero eligible rows still proves exhaustion — isDone on the first page.
      expect(result.isDone).toBe(true);
      expect(result.processed).toBe(0);
      expect(result.materialized).toBe(0);
      expect(result.status).toBe("completed");
    } finally {
      vi.useRealTimers();
    }

    const state = await t.run((ctx) =>
      ctx.db.query("socialMaterializationState").collect()
    );
    expect(state).toHaveLength(1);
    expect(state[0].status).toBe("completed");
    expect(state[0].processedCount).toBe(0);
  });

  test("processed and materialized are distinct counts", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrg(t, "gate_counts");
    const customer = await makeCustomer(t, orgId, "Iris");
    // Ten events in ONE thread: ten processed, one materialised.
    await seedLegacyEvents(t, orgId, customer, 10);

    vi.useFakeTimers();
    try {
      await t.mutation(internal.migrations.backfillInstagramConversations, { orgId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }

    const state = await t.run((ctx) =>
      ctx.db
        .query("socialMaterializationState")
        .filter((q) => q.eq(q.field("platform"), "instagram"))
        .first()
    );
    expect(state?.processedCount).toBe(10);
    expect(state?.materializedCount).toBe(1);
    // Collapsing these would make "1" look like a stalled run over 10 events.
    expect(state?.processedCount).not.toBe(state?.materializedCount);
  });

  test("a new organization starts ready, because its eligible set is empty", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const identity = t.withIdentity({ subject: "gate_new_org", email: "new@test.com" });
    const orgId = await identity.mutation(api.organizations.create, { name: "Fresh Dealership" });

    const states = await t.run((ctx) =>
      ctx.db
        .query("socialMaterializationState")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .collect()
    );
    expect(states).toHaveLength(2);
    expect(states.every((s) => s.status === "completed")).toBe(true);
    expect(states.every((s) => s.generation === SOCIAL_CONVERSATION_GENERATION)).toBe(true);
  });
});

describe("backfill resume, retry and exhaustion", () => {
  test("resumes from its own cursor and only completes on exhaustion", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrg(t, "resume_org");
    const customers = await Promise.all(
      ["A", "B", "C", "D"].map((n) => makeCustomer(t, orgId, n))
    );
    for (const c of customers) await seedLegacyEvents(t, orgId, c, 1);

    // Drive it one page at a time, so every intermediate state is observable.
    const seen: { processed: number; status: string; isDone: boolean }[] = [];
    for (let i = 0; i < 4; i++) {
      const state = await t.run((ctx) =>
        ctx.db
          .query("socialMaterializationState")
          .filter((q) => q.eq(q.field("platform"), "instagram"))
          .first()
      );
      const result = await t.mutation(internal.migrations.backfillInstagramConversations, {
        orgId,
        batchSize: 1,
        continueAutomatically: false,
        // After the first page, continue the run the record already owns.
        ...(state ? { runId: state.runId } : {}),
      });
      seen.push({ processed: result.processed, status: result.status, isDone: result.isDone });
      if (result.isDone) break;
    }

    // Intermediate pages must never have claimed completion.
    expect(seen.slice(0, -1).every((s) => s.status === "running")).toBe(true);
    expect(seen.slice(0, -1).every((s) => !s.isDone)).toBe(true);
    expect(seen[seen.length - 1].status).toBe("completed");
    expect(seen[seen.length - 1].processed).toBe(4);
    expect(await t.run((ctx) => ctx.db.query("socialConversations").collect())).toHaveLength(4);
  });

  test("an interrupted run is visible as running, never as completed", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrg(t, "interrupted_org");
    // Three threads, so an interrupted run leaves the table demonstrably short.
    const jo = await makeCustomer(t, orgId, "Jo");
    const kim = await makeCustomer(t, orgId, "Kim");
    const lou = await makeCustomer(t, orgId, "Lou");
    for (const c of [jo, kim, lou]) await seedLegacyEvents(t, orgId, c, 1);

    // One page, then the chain dies — the state row is left as the dead chain
    // left it.
    await t.mutation(internal.migrations.backfillInstagramConversations, {
      orgId,
      batchSize: 1,
      continueAutomatically: false,
    });

    const state = await t.run((ctx) =>
      ctx.db
        .query("socialMaterializationState")
        .filter((q) => q.eq(q.field("platform"), "instagram"))
        .first()
    );
    expect(state?.status).toBe("running");
    expect(state?.completedAt).toBeUndefined();
    expect(state?.cursor).toBeDefined();
    expect(await t.run((ctx) => ctx.db.query("socialConversations").collect())).toHaveLength(1);

    // And the inbox is still complete throughout — three threads, not the one
    // the abandoned run happened to materialise.
    expect(await listConversations(asEditor, orgId)).toHaveLength(3);
  });

  test("a stale continuation cannot advance or complete a superseded run", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrg(t, "fencing_org");
    const customer = await makeCustomer(t, orgId, "Kai");
    await seedLegacyEvents(t, orgId, customer, 3);

    await t.mutation(internal.migrations.backfillInstagramConversations, {
      orgId,
      batchSize: 1,
      continueAutomatically: false,
    });
    const firstRun = await t.run((ctx) =>
      ctx.db
        .query("socialMaterializationState")
        .filter((q) => q.eq(q.field("platform"), "instagram"))
        .first()
    );

    // An operator restarts, which allocates a new run and resets progress.
    await t.mutation(internal.migrations.backfillInstagramConversations, {
      orgId,
      batchSize: 1,
      continueAutomatically: false,
    });
    const secondRun = await t.run((ctx) =>
      ctx.db
        .query("socialMaterializationState")
        .filter((q) => q.eq(q.field("platform"), "instagram"))
        .first()
    );
    expect(secondRun?.runId).not.toBe(firstRun?.runId);

    // The old chain's continuation now arrives. It must do nothing at all —
    // without fencing it would keep advancing a cursor the new run also owns,
    // and whichever chain saw the last page would mark the whole run complete.
    const stale = await t.mutation(internal.migrations.backfillInstagramConversations, {
      orgId,
      runId: firstRun!.runId,
      batchSize: 1,
      continueAutomatically: false,
    });
    expect(stale.status).toBe("staleRun");
    expect(stale.processed).toBe(0);

    const after = await t.run((ctx) =>
      ctx.db
        .query("socialMaterializationState")
        .filter((q) => q.eq(q.field("platform"), "instagram"))
        .first()
    );
    expect(after?.runId).toBe(secondRun?.runId);
    expect(after?.processedCount).toBe(secondRun?.processedCount);
    expect(after?.status).toBe("running");
  });

  test("a continuation cannot resurrect an already-completed run", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrg(t, "completed_fence_org");
    const customer = await makeCustomer(t, orgId, "Lena");
    await seedLegacyEvents(t, orgId, customer, 2);

    vi.useFakeTimers();
    try {
      await t.mutation(internal.migrations.backfillInstagramConversations, { orgId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }
    const done = await t.run((ctx) =>
      ctx.db
        .query("socialMaterializationState")
        .filter((q) => q.eq(q.field("platform"), "instagram"))
        .first()
    );
    expect(done?.status).toBe("completed");

    const late = await t.mutation(internal.migrations.backfillInstagramConversations, {
      orgId,
      runId: done!.runId,
      continueAutomatically: false,
    });
    expect(late.status).toBe("staleRun");
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("socialMaterializationState")
          .filter((q) => q.eq(q.field("platform"), "instagram"))
          .first()
      )
    ).toMatchObject({ status: "completed", processedCount: done!.processedCount });
  });

  test("re-running a completed backfill duplicates nothing and double-counts nothing", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrg(t, "redrive_org");
    const alice = await makeCustomer(t, orgId, "Mia");
    const bob = await makeCustomer(t, orgId, "Ned");
    await seedLegacyEvents(t, orgId, alice, 3);
    await seedLegacyEvents(t, orgId, bob, 2);

    const runOnce = async () => {
      vi.useFakeTimers();
      try {
        await t.mutation(internal.migrations.backfillInstagramConversations, {
          orgId,
          batchSize: 2,
        });
        await t.finishAllScheduledFunctions(vi.runAllTimers);
      } finally {
        vi.useRealTimers();
      }
    };

    await runOnce();
    const first = await t.run((ctx) => ctx.db.query("socialConversations").collect());
    const firstState = await t.run((ctx) =>
      ctx.db
        .query("socialMaterializationState")
        .filter((q) => q.eq(q.field("platform"), "instagram"))
        .first()
    );
    expect(first).toHaveLength(2);
    expect(firstState?.processedCount).toBe(5);

    await runOnce();
    const second = await t.run((ctx) => ctx.db.query("socialConversations").collect());
    const secondState = await t.run((ctx) =>
      ctx.db
        .query("socialMaterializationState")
        .filter((q) => q.eq(q.field("platform"), "instagram"))
        .first()
    );

    // Same rows, and counts restart rather than accumulate across runs.
    expect(second).toHaveLength(2);
    expect(second.map((r) => r.conversationKey).sort()).toEqual(
      first.map((r) => r.conversationKey).sort()
    );
    expect(secondState?.processedCount).toBe(5);
    expect(secondState?.materializedCount).toBe(firstState?.materializedCount);
  });

  test("events arriving mid-run are materialized by the trigger, so completion stays honest", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrg(t, "race_org");
    const alice = await makeCustomer(t, orgId, "Ola");
    const bob = await makeCustomer(t, orgId, "Pat");
    await seedLegacyEvents(t, orgId, alice, 2);

    // Page one of the walk.
    await t.mutation(internal.migrations.backfillInstagramConversations, {
      orgId,
      batchSize: 1,
      continueAutomatically: false,
    });
    const state = await t.run((ctx) =>
      ctx.db
        .query("socialMaterializationState")
        .filter((q) => q.eq(q.field("platform"), "instagram"))
        .first()
    );

    // A new message lands mid-run. This one goes through the trigger, as every
    // live write does.
    await t.run(async (ctx) => {
      await ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "inflight_1",
        kind: "dm",
        senderInstagramId: "ig_new",
        customerId: bob,
        text: "arrived during the backfill",
      });
    });

    // Finish the walk.
    vi.useFakeTimers();
    try {
      await t.mutation(internal.migrations.backfillInstagramConversations, {
        orgId,
        runId: state!.runId,
        batchSize: 1,
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      await t.mutation(internal.migrations.backfillFacebookConversations, { orgId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }

    // Completion must mean the materialised view holds the mid-run arrival too.
    // It does for a reason worth stating: the trigger is live from the moment
    // the code deploys, so a row is materialised either by the walk reaching it
    // or by the write that created it — never neither.
    const page = await listConversations(asEditor, orgId);
    expect(page).toHaveLength(2);
    expect(page.map((c) => c.customerId).sort()).toEqual([alice, bob].sort());
    expect(page.find((c) => c.customerId === bob)?.eventCount).toBe(1);
  });
});
