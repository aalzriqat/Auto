import { convexTestWithComponents } from "../test-utils/convexTest";
import { seedOrgWithMember, VIEWER_PERMISSIONS } from "../test-utils/seedOrg";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { SOCIAL_CONVERSATION_GENERATION } from "./utils/materialization";
import { recordConversationBackfillFailure } from "./migrations";
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

  test("a materialized row from a superseded generation is never served", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrg(t, "gate_stale_generation");
    const customer = await makeCustomer(t, orgId, "Hana");
    await seedLegacyEvents(t, orgId, customer, 2);

    // A genuine, complete backfill of the CURRENT generation.
    vi.useFakeTimers();
    try {
      await t.mutation(internal.migrations.backfillInstagramConversations, { orgId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      await t.mutation(internal.migrations.backfillFacebookConversations, { orgId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }

    // A row left behind by the generation before it, under the key scheme that
    // generation used. This is the case a generation bump is FOR, and it is
    // unreachable by repair: no source event produces this key, so neither the
    // backfill nor a force rebuild ever visits it. `syncSocialConversation`
    // only deletes a row when it recomputes that row's thread and finds it
    // empty — and it never recomputes this one.
    //
    // So completion cannot mean "the table holds exactly the current
    // generation" by walking the source; it can only mean it by the reader
    // refusing to look at anything else.
    await t.run((ctx) =>
      ctx.db.insert("socialConversations", {
        orgId,
        generation: SOCIAL_CONVERSATION_GENERATION - 1,
        conversationKey: "v0::dm::ghost",
        platform: "instagram",
        conversationKind: "dm",
        customerId: customer,
        // Newest activity, so an unfenced reader returns it FIRST rather than
        // somewhere a smaller assertion might miss.
        lastEventAt: Date.now() + 60_000,
        eventCount: 99,
        unansweredCount: 99,
        vehicleIds: [],
        vehicleCount: 0,
        latestSenderRawId: "ghost_sender",
      })
    );

    // The materialized path is unlocked and must answer exactly what the source
    // says — one thread, not two.
    // `eventCount` is the discriminator because the list item does not expose
    // `conversationKey`. The ghost carries 99, so this states the whole
    // expected list rather than merely asserting the ghost's absence — an
    // equality that fails as [99, 2] if the fence is removed.
    const page = await listConversations(asEditor, orgId);
    expect(page.map((c) => c.eventCount)).toEqual([2]);
  });

  test("contradictory duplicate state rows do not unlock the reader", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrg(t, "gate_duplicate_state");
    const customer = await makeCustomer(t, orgId, "Gale");
    await seedLegacyEvents(t, orgId, customer, 2);

    // Two rows for the same (org, generation, platform) that disagree. The
    // lookup is `.first()`, which returns the OLDEST row at equal index keys —
    // so the stale `completed` wins and the live `running` is never seen. The
    // gate is the one place in this feature where being wrong in this direction
    // costs staff their customer messages, so it must not resolve a
    // contradiction by picking whichever row happens to sort first.
    await writeState(t, orgId, "instagram", {});
    await writeState(t, orgId, "instagram", { status: "running", completedAt: undefined });
    await writeState(t, orgId, "facebook", {});

    // Nothing was ever materialised, so trusting the duplicate `completed`
    // reports an empty inbox for an org holding events — the incident this
    // whole mechanism exists to prevent, reached by a different door.
    expect(await t.run((ctx) => ctx.db.query("socialConversations").collect())).toHaveLength(0);

    const page = await listConversations(asEditor, orgId);
    expect(page).toHaveLength(1);
    expect(page[0].eventCount).toBe(2);
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

    // Materialised by its own write, immediately — before the walk gets
    // anywhere near it. Asserting this here is what makes the test about the
    // trigger: without it the walk would reach the row later anyway and the
    // test would pass with the trigger switched off entirely.
    const bobThreadDuringRun = await t.run((ctx) =>
      ctx.db
        .query("socialConversations")
        .filter((q) => q.eq(q.field("customerId"), bob))
        .first()
    );
    expect(bobThreadDuringRun).not.toBeNull();
    expect(bobThreadDuringRun?.latestText).toBe("arrived during the backfill");

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

  test("after completion, a new message still reaches the authoritative view", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrg(t, "post_completion_org");
    const alice = await makeCustomer(t, orgId, "Quin");
    const bob = await makeCustomer(t, orgId, "Rae");
    await seedLegacyEvents(t, orgId, alice, 1);

    vi.useFakeTimers();
    try {
      await t.mutation(internal.migrations.backfillInstagramConversations, { orgId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      await t.mutation(internal.migrations.backfillFacebookConversations, { orgId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }

    // The reader is now authoritative on the materialised table, and the walk
    // is over. From here the trigger is the ONLY thing keeping that table
    // current — if it stopped working, this org's inbox would freeze at the
    // moment the backfill finished and nobody would see a new message again.
    await t.run(async (ctx) => {
      await ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "after_completion_1",
        kind: "dm",
        senderInstagramId: "ig_after",
        customerId: bob,
        text: "arrived after the backfill finished",
      });
    });

    const page = await listConversations(asEditor, orgId);
    expect(page).toHaveLength(2);
    expect(page.find((c) => c.customerId === bob)?.latestText).toBe(
      "arrived after the backfill finished"
    );
  });
});

describe("operator surface", () => {
  test("the fan-out unlocks every org, not just the one someone remembered", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const orgs = [];
    for (const n of ["one", "two", "three"]) {
      const seeded = await seedOrg(t, `fanout_${n}`);
      const customer = await makeCustomer(t, seeded.orgId, n);
      await seedLegacyEvents(t, seeded.orgId, customer, 2);
      orgs.push(seeded);
    }

    // Every org starts on the legacy path.
    for (const org of orgs) {
      expect(
        await org.asEditor.query(api.socialInbox.materializationStatus, { orgId: org.orgId })
      ).toMatchObject({ readerSource: "legacyEvents" });
    }

    vi.useFakeTimers();
    try {
      await t.mutation(internal.migrations.startSocialConversationBackfills, {});
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }

    // ...and every org ends on the fast one, without anyone naming them.
    for (const org of orgs) {
      expect(
        await org.asEditor.query(api.socialInbox.materializationStatus, { orgId: org.orgId })
      ).toMatchObject({ readerSource: "materialized" });
      expect(await listConversations(org.asEditor, org.orgId)).toHaveLength(1);
    }

    const states = await t.run((ctx) => ctx.db.query("socialMaterializationState").collect());
    expect(states).toHaveLength(6);
    expect(states.every((s) => s.status === "completed")).toBe(true);
  });

  test("a fan-out worker stands down if a chain started before it ran", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrg(t, "race_fanout");
    for (const n of ["Mo", "Nel", "Oz"]) {
      const c = await makeCustomer(t, orgId, n);
      await seedLegacyEvents(t, orgId, c, 1);
    }

    // A chain is already live.
    await t.mutation(internal.migrations.backfillInstagramConversations, {
      orgId,
      batchSize: 1,
      continueAutomatically: false,
    });
    const live = await t.run((ctx) =>
      ctx.db
        .query("socialMaterializationState")
        .filter((q) => q.eq(q.field("platform"), "instagram"))
        .first()
    );
    expect(live?.status).toBe("running");

    // A worker scheduled by a fan-out that observed `notStarted` now runs. The
    // fan-out reads and schedules in one transaction and the worker runs in
    // another, so its view was already stale — two concurrent fan-outs can both
    // enqueue the same org and platform. Without `onlyIfIdle` this second
    // worker takes the operator-start path, resets the cursor and fences the
    // chain that was already working.
    const stoodDown = await t.mutation(internal.migrations.backfillInstagramConversations, {
      orgId,
      onlyIfIdle: true,
      continueAutomatically: false,
    });
    expect(stoodDown.status).toBe("staleRun");

    const after = await t.run((ctx) =>
      ctx.db
        .query("socialMaterializationState")
        .filter((q) => q.eq(q.field("platform"), "instagram"))
        .first()
    );
    expect(after?.runId).toBe(live?.runId);
    expect(after?.cursor).toBe(live?.cursor);
    expect(after?.processedCount).toBe(live?.processedCount);

    // A hand-invoked operator start (no `onlyIfIdle`) still restarts, which is
    // what an operator asking for a rebuild means.
    const restarted = await t.mutation(internal.migrations.backfillInstagramConversations, {
      orgId,
      batchSize: 1,
      continueAutomatically: false,
    });
    expect(restarted.status).not.toBe("staleRun");
  });

  test("re-running the fan-out does not restart a run that is still advancing", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrg(t, "inflight_fanout");
    for (const n of ["Ivy", "Jud", "Kit"]) {
      const c = await makeCustomer(t, orgId, n);
      await seedLegacyEvents(t, orgId, c, 1);
    }

    // One page in, chain live.
    await t.mutation(internal.migrations.backfillInstagramConversations, {
      orgId,
      batchSize: 1,
      continueAutomatically: false,
    });
    const midRun = await t.run((ctx) =>
      ctx.db
        .query("socialMaterializationState")
        .filter((q) => q.eq(q.field("platform"), "instagram"))
        .first()
    );
    expect(midRun?.status).toBe("running");

    // The natural operator move: re-run the fan-out to see how far it has got.
    // Without this guard that re-enqueues the org through the operator-start
    // path, which resets the cursor and fences the chain already doing the
    // work — so checking on progress destroys it, and a long walk never lands.
    const again = await t.mutation(internal.migrations.startSocialConversationBackfills, {
      continueAutomatically: false,
    });
    // Per platform: Instagram is mid-walk so it is left alone; Facebook has not
    // started, so it is enqueued. The point is that the live chain is untouched.
    expect(again.skipped).toBe(1);
    expect(again.started).toBe(1);

    const after = await t.run((ctx) =>
      ctx.db
        .query("socialMaterializationState")
        .filter((q) => q.eq(q.field("platform"), "instagram"))
        .first()
    );
    expect(after?.runId).toBe(midRun?.runId);
    expect(after?.cursor).toBe(midRun?.cursor);
    expect(after?.processedCount).toBe(midRun?.processedCount);
  });

  test("force does not schedule a worker for contradictory state", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrg(t, "fanout_force_ambiguous");
    const customer = await makeCustomer(t, orgId, "Ida");
    await seedLegacyEvents(t, orgId, customer, 1);

    // Instagram is contradictory; Facebook has never started.
    await writeState(t, orgId, "instagram", {});
    await writeState(t, orgId, "instagram", { status: "running", completedAt: undefined });

    // `force` exists to override `completed` and `running` — states where a run
    // WOULD be redundant or disruptive. It cannot repair duplicate rows, so
    // letting it through only schedules a worker that refuses, and reports the
    // refusal as work started.
    const result = await t.mutation(internal.migrations.startSocialConversationBackfills, {
      force: true,
      continueAutomatically: false,
    });

    // Facebook is the only platform there is anything to do for.
    expect(result).toMatchObject({ started: 1, skipped: 1 });
  });

  test("re-running the fan-out does not drop migrated orgs back to the full scan", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrg(t, "redrive_fanout");
    const customer = await makeCustomer(t, orgId, "Ann");
    await seedLegacyEvents(t, orgId, customer, 2);

    vi.useFakeTimers();
    try {
      await t.mutation(internal.migrations.startSocialConversationBackfills, {});
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }
    expect(
      await asEditor.query(api.socialInbox.materializationStatus, { orgId })
    ).toMatchObject({ readerSource: "materialized" });

    // A second run must skip it. Restarting would reset the record to `running`
    // and put the org back on the 1.34 GB/week event scan for no gain — across a
    // whole deployment that is every tenant at once.
    const second = await t.mutation(internal.migrations.startSocialConversationBackfills, {
      continueAutomatically: false,
    });
    expect(second.skipped).toBe(2); // both platforms complete
    expect(second.started).toBe(0);
    expect(
      await asEditor.query(api.socialInbox.materializationStatus, { orgId })
    ).toMatchObject({ readerSource: "materialized" });

    // `force` is the deliberate rebuild: it enqueues the org again rather than
    // skipping it. (The org only leaves `materialized` once those scheduled
    // backfills actually start, which is why this asserts the enqueue decision
    // and not a transient reader state.)
    const forced = await t.mutation(internal.migrations.startSocialConversationBackfills, {
      continueAutomatically: false,
      force: true,
    });
    expect(forced.started).toBe(2); // both platforms rebuilt
    expect(forced.skipped).toBe(0);

    // Draining that rebuild leaves the org ready again and the inbox correct.
    vi.useFakeTimers();
    try {
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }
    expect(
      await asEditor.query(api.socialInbox.materializationStatus, { orgId })
    ).toMatchObject({ readerSource: "materialized" });
    expect(await listConversations(asEditor, orgId)).toHaveLength(1);
  });

  test("recording a failure marks the run failed and leaves it un-ready", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrg(t, "failure_org");
    const customer = await makeCustomer(t, orgId, "Zed");
    await seedLegacyEvents(t, orgId, customer, 2);

    // Start a run so there is a real state row to fail.
    await t.mutation(internal.migrations.backfillInstagramConversations, {
      orgId,
      batchSize: 1,
      continueAutomatically: false,
    });

    // The failure recorder is called directly rather than provoked through the
    // backfill. There is no reachable input that makes a page sync throw:
    // `syncSocialConversation` groups events by thread identity and never reads
    // the customer document, so a dangling `customerId` — the obvious candidate
    // — completes normally. Rather than dress a passing run up as a failure
    // test, this exercises the branch itself and asserts unconditionally.
    const before = await t.run((ctx) =>
      ctx.db
        .query("socialMaterializationState")
        .filter((q) => q.eq(q.field("platform"), "instagram"))
        .first()
    );
    expect(before?.status).toBe("running");

    await t.run(async (ctx) => {
      await recordConversationBackfillFailure(
        ctx as unknown as Parameters<typeof recordConversationBackfillFailure>[0],
        before!,
        new Error("read limit exceeded")
      );
    });

    const after = await t.run((ctx) =>
      ctx.db
        .query("socialMaterializationState")
        .filter((q) => q.eq(q.field("platform"), "instagram"))
        .first()
    );
    expect(after?.status).toBe("failed");
    expect(after?.failureMessage).toBe("read limit exceeded");
    expect(after?.completedAt).toBeUndefined();

    // A failed run must not unlock the reader, and the inbox stays correct.
    expect(
      await asEditor.query(api.socialInbox.materializationStatus, { orgId })
    ).toMatchObject({ readerSource: "legacyEvents" });
    expect(await listConversations(asEditor, orgId)).toHaveLength(1);
  });
});

describe("cursor spaces do not cross at the readiness flip", () => {
  test("a legacy cursor is rejected by the materialized path", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrg(t, "cursor_l2m");
    const customer = await makeCustomer(t, orgId, "Sam");
    await seedLegacyEvents(t, orgId, customer, 3);

    // Page one off the legacy path, then readiness flips underneath the client.
    const first = await asEditor.query(api.socialInbox.listConversations, {
      orgId,
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(first.continueCursor.startsWith("legacyOffset:")).toBe(true);
    await markReady(t, orgId);

    // Feeding that cursor to the index-backed path must raise InvalidCursor,
    // which `usePaginatedQuery` recovers from by resetting. Silently coercing it
    // to null would repeat rows the client already rendered.
    await expect(
      asEditor.query(api.socialInbox.listConversations, {
        orgId,
        paginationOpts: { numItems: 1, cursor: first.continueCursor },
      })
    ).rejects.toThrow(/InvalidCursor/);
  });

  test("a materialized cursor is rejected by the legacy path", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrg(t, "cursor_m2l");
    const customer = await makeCustomer(t, orgId, "Tia");
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert("instagramEvents", {
          orgId,
          externalId: `m2l_${i}`,
          kind: "comment",
          postId: `post_${i}`,
          senderInstagramId: "ig_tia",
          customerId: customer,
          text: `message ${i}`,
        });
      }
    });
    await markReady(t, orgId);

    const first = await asEditor.query(api.socialInbox.listConversations, {
      orgId,
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(first.continueCursor.startsWith("legacyOffset:")).toBe(false);

    // Readiness goes backwards — an operator re-runs the backfill, or the
    // generation is bumped. The index cursor now reaches the offset parser,
    // where `Number(...)` would have produced NaN, an empty page, and
    // `isDone: false` forever: a list that shows one page and loads for eternity.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("socialMaterializationState").collect()) {
        await ctx.db.patch(row._id, { status: "running", completedAt: undefined });
      }
    });

    await expect(
      asEditor.query(api.socialInbox.listConversations, {
        orgId,
        paginationOpts: { numItems: 1, cursor: first.continueCursor },
      })
    ).rejects.toThrow(/InvalidCursor/);
  });

  test("the legacy path still pages correctly through its own cursors", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrg(t, "cursor_legacy_walk");
    for (const name of ["Uma", "Vic", "Wes"]) {
      const c = await makeCustomer(t, orgId, name);
      await seedLegacyEvents(t, orgId, c, 1);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const res: { page: { customerId: string }[]; isDone: boolean; continueCursor: string } =
        await asEditor.query(api.socialInbox.listConversations, {
          orgId,
          paginationOpts: { numItems: 2, cursor },
        });
      seen.push(...res.page.map((r) => r.customerId));
      if (res.isDone) break;
      cursor = res.continueCursor;
    }
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });
});
