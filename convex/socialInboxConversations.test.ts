import { convexTestWithComponents } from "../test-utils/convexTest";
import {
  MANAGER_PERMISSIONS,
  seedOrgWithMember,
  VIEWER_PERMISSIONS,
} from "../test-utils/seedOrg";
import { expect, test, describe, vi, beforeEach } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import {
  readSocialConversationSyncCount,
  resetSocialConversationSyncCount,
} from "./aggregates";
import type { Id } from "./_generated/dataModel";
import { SOCIAL_CONVERSATION_GENERATION } from "./utils/materialization";

/**
 * `socialInbox.listConversations` used to `.collect()` every Instagram and
 * Facebook event the org had ever received and group them in JavaScript — 1.34
 * GB of production bandwidth in the week of 2026-08-01. A conversation was not
 * a row, so there was nothing to paginate: the "cursor" was an offset into an
 * in-memory array and every page re-scanned the whole history.
 *
 * It now reads `socialConversations`, materialised by a trigger.
 *
 * The hazard that introduces is not a slow query, it is a *stale* one. The
 * grouping key — (platform, customer, kind, postId) — is mutated after insert:
 * `socialInboxBackfill` patches `postId`, and a customer merge repoints
 * `customerId`. A materialised thread therefore has to handle **re-keying**,
 * not just insert and delete, and a row left behind under the old key is a
 * conversation the inbox shows that no longer exists.
 *
 * So the central tests here are an equivalence oracle against the original
 * grouping, and direct exercise of every way an event can move between threads.
 */

/**
 * Which source the suite is currently exercising.
 *
 * Every test below runs twice. That is not thoroughness for its own sake: when
 * the readiness gate landed, `seedOrgWithMember` created its org with a raw
 * insert and therefore no readiness record, so this entire file silently moved
 * onto the legacy fallback. The suite stayed green while the materialised
 * reader's filters, index selection and cursor pagination had no coverage at
 * all — inverting `hasVehicle` on the materialised path passed all 37 tests.
 *
 * Green because nothing was examined is indistinguishable from green because
 * nothing is wrong, which is the same failure the gate itself exists to stop.
 * `actualConversations` therefore also asserts which path answered, so the
 * suite fails loudly rather than quietly if it ever drifts back.
 */
type ReaderSource = "legacy" | "materialized";
let currentSource: ReaderSource = "legacy";

/** Records both platforms complete, which is what unlocks the indexed reader. */
async function markMaterializationReady(
  t: ReturnType<typeof convexTestWithComponents>,
  orgId: Id<"organizations">
) {
  for (const platform of ["instagram", "facebook"] as const) {
    await t.run((ctx) =>
      ctx.db.insert("socialMaterializationState", {
        orgId,
        platform,
        generation: SOCIAL_CONVERSATION_GENERATION,
        status: "completed" as const,
        runId: `suite:${platform}`,
        processedCount: 0,
        materializedCount: 0,
        expectedCount: 0,
        startedAt: Date.now(),
        lastProgressAt: Date.now(),
        completedAt: Date.now(),
      })
    );
  }
}

/** Thin wrapper so call sites keep reading `asEditor` / `asUser`. */
async function seedOrg(
  t: ReturnType<typeof convexTestWithComponents>,
  clerkId = "conv_editor_001",
  permissions: string[] = VIEWER_PERMISSIONS,
  options: { markReady?: boolean } = {}
) {
  const { orgId, identity } = await seedOrgWithMember(t, { clerkId, permissions });
  if ((options.markReady ?? true) && currentSource === "materialized") {
    await markMaterializationReady(t, orgId);
  }
  return { orgId, identity, asEditor: identity, asUser: identity };
}

async function makeCustomer(
  t: ReturnType<typeof convexTestWithComponents>,
  orgId: Id<"organizations">,
  first: string,
  last: string
) {
  return await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: first, lastName: last }));
}

/**
 * The exact grouping the query used before the table replaced it, recomputed
 * from the raw event rows. Returns one entry per thread, most recent first.
 */
async function oracleConversations(
  t: ReturnType<typeof convexTestWithComponents>,
  orgId: Id<"organizations">
) {
  const ig = await t.run((ctx) => ctx.db.query("instagramEvents").collect());
  const fb = await t.run((ctx) => ctx.db.query("facebookEvents").collect());
  const all = [
    ...ig
      .filter((e) => e.orgId === orgId)
      .map((e) => ({ ...e, platform: "instagram" as const, senderRawId: e.senderInstagramId })),
    ...fb
      .filter((e) => e.orgId === orgId)
      .map((e) => ({ ...e, platform: "facebook" as const, senderRawId: e.senderFacebookId })),
  ];

  const grouped = new Map<string, typeof all>();
  for (const ev of all) {
    if (!ev.customerId) continue;
    const key =
      ev.kind === "dm"
        ? `${ev.platform}:${ev.customerId}:dm`
        : `${ev.platform}:${ev.customerId}:comment:${ev.postId ?? "__none__"}`;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(ev);
    else grouped.set(key, [ev]);
  }

  return Array.from(grouped.entries())
    .map(([key, events]) => {
      const latest = events.reduce((a, b) => (b._creationTime > a._creationTime ? b : a), events[0]);
      const vehicleIds = new Set(events.filter((e) => e.vehicleId).map((e) => e.vehicleId!));
      return {
        key,
        customerId: latest.customerId!,
        platform: latest.platform,
        conversationKind: events[0].kind,
        latestCreationTime: latest._creationTime,
        latestText: latest.text,
        eventCount: events.length,
        needsReply: events.some((e) => !e.autoRepliedAt && !e.manualRepliedAt),
        vehicleCount: vehicleIds.size,
      };
    })
    .sort((a, b) => b.latestCreationTime - a.latestCreationTime);
}

/** Everything the query returns, as the oracle's comparable shape. */
async function actualConversations(
  asEditor: ReturnType<ReturnType<typeof convexTestWithComponents>["withIdentity"]>,
  orgId: Id<"organizations">,
  args: Record<string, unknown> = {},
  // "any" is for the one test that deliberately crosses the boundary mid-test.
  expectSource: ReaderSource | "any" = currentSource
) {
  // Armed guard: prove the intended path actually answered. Without this the
  // whole suite can drift onto one source and still pass.
  if (expectSource !== "any") {
    const status = await asEditor.query(api.socialInbox.materializationStatus, { orgId });
    expect(status.readerSource).toBe(
      expectSource === "materialized" ? "materialized" : "legacyEvents"
    );
  }

  const result = await asEditor.query(api.socialInbox.listConversations, {
    orgId,
    paginationOpts: { numItems: 100, cursor: null },
    ...args,
  });
  return result.page.map((row) => ({
    customerId: row.customerId,
    platform: row.platform,
    conversationKind: row.conversationKind,
    latestCreationTime: row.latestCreationTime,
    latestText: row.latestText,
    eventCount: row.eventCount,
    needsReply: row.needsReply,
    vehicleCount: row.vehicleCount,
  }));
}

describe.each(["legacy", "materialized"] as const)(
  "socialInbox.listConversations — %s source",
  (source) => {
  beforeEach(() => {
    currentSource = source;
  });

  test("matches the original grouping across platforms, kinds, posts and replies", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrg(t);
    const alice = await makeCustomer(t, orgId, "Alice", "Buyer");
    const bob = await makeCustomer(t, orgId, "Bob", "Buyer");

    // Two comments on one post, one on another, a DM, a Facebook DM for the
    // same customer, and an answered event — so the oracle and the table have
    // to agree on grouping, counts, recency and needsReply all at once.
    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId, externalId: "c1", kind: "comment", senderInstagramId: "ig_alice",
        customerId: alice, postId: "post_a", text: "first",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId, externalId: "c2", kind: "comment", senderInstagramId: "ig_alice",
        customerId: alice, postId: "post_a", text: "second", autoRepliedAt: Date.now(),
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId, externalId: "c3", kind: "comment", senderInstagramId: "ig_alice",
        customerId: alice, postId: "post_b", text: "other post",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId, externalId: "d1", kind: "dm", senderInstagramId: "ig_alice",
        customerId: alice, text: "a dm",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("facebookEvents", {
        orgId, externalId: "f1", kind: "dm", senderFacebookId: "fb_bob",
        customerId: bob, text: "fb dm",
      })
    );

    const expected = await oracleConversations(t, orgId);
    const actual = await actualConversations(asEditor, orgId);

    expect(actual).toHaveLength(4);
    expect(actual).toEqual(
      expected.map((e) => ({
        customerId: e.customerId,
        platform: e.platform,
        conversationKind: e.conversationKind,
        latestCreationTime: e.latestCreationTime,
        latestText: e.latestText,
        eventCount: e.eventCount,
        needsReply: e.needsReply,
        vehicleCount: e.vehicleCount,
      }))
    );
    // The post_a thread holds both of its comments and is fully answered only
    // if every event is — it is not, so it still needs a reply.
    const postA = actual.find((c) => c.eventCount === 2);
    expect(postA?.needsReply).toBe(true);
  });

  test("an event with no customer produces no conversation", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrg(t);

    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId, externalId: "orphan", kind: "dm", senderInstagramId: "ig_orphan", text: "hi",
      })
    );

    // The old grouping skipped these outright; materialising one would put a
    // row in the inbox the list never showed.
    expect(await actualConversations(asEditor, orgId)).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("socialConversations").collect())).toHaveLength(0);
  });

  test("resolving a comment's postId re-keys the thread instead of leaving two", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrg(t);
    const alice = await makeCustomer(t, orgId, "Alice", "Buyer");

    // Both land in the shared "__none__" bucket, exactly as the old grouping did.
    const unresolved = await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId, externalId: "u1", kind: "comment", senderInstagramId: "ig_alice",
        customerId: alice, text: "no post yet",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId, externalId: "u2", kind: "comment", senderInstagramId: "ig_alice",
        customerId: alice, text: "also no post",
      })
    );
    expect(await actualConversations(asEditor, orgId)).toHaveLength(1);

    // This is what `socialInboxBackfill.resyncEvents` does. It changes the
    // grouping key, so the event must leave one thread and join another.
    await t.run((ctx) => ctx.db.patch(unresolved, { postId: "post_found" }));

    const actual = await actualConversations(asEditor, orgId);
    const expected = await oracleConversations(t, orgId);
    expect(actual).toHaveLength(2);
    expect(actual.map((c) => c.eventCount).sort((a, b) => a - b)).toEqual([1, 1]);
    expect(actual.map((c) => c.eventCount).sort((a, b) => a - b)).toEqual(
      expected.map((c) => c.eventCount).sort((a, b) => a - b)
    );
    // No orphan left under the old key.
    expect(await t.run((ctx) => ctx.db.query("socialConversations").collect())).toHaveLength(2);
  });

  test("repointing an event at a merged customer moves its thread", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrg(t);
    const duplicate = await makeCustomer(t, orgId, "Dup", "Buyer");
    const survivor = await makeCustomer(t, orgId, "Survivor", "Buyer");

    const eventId = await t.run((ctx) =>
      ctx.db.insert("facebookEvents", {
        orgId, externalId: "m1", kind: "dm", senderFacebookId: "fb_dup",
        customerId: duplicate, text: "merge me",
      })
    );
    expect((await actualConversations(asEditor, orgId))[0].customerId).toBe(duplicate);

    await t.run((ctx) => ctx.db.patch(eventId, { customerId: survivor }));

    const actual = await actualConversations(asEditor, orgId);
    expect(actual).toHaveLength(1);
    expect(actual[0].customerId).toBe(survivor);
    // The duplicate's thread is gone, not merely hidden.
    const rows = await t.run((ctx) => ctx.db.query("socialConversations").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].customerId).toBe(survivor);
  });

  test("deleting the last event in a thread removes the thread", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrg(t);
    const alice = await makeCustomer(t, orgId, "Alice", "Buyer");

    const first = await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId, externalId: "k1", kind: "dm", senderInstagramId: "ig_alice",
        customerId: alice, text: "one",
      })
    );
    const second = await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId, externalId: "k2", kind: "dm", senderInstagramId: "ig_alice",
        customerId: alice, text: "two",
      })
    );

    await t.run((ctx) => ctx.db.delete(second));
    let actual = await actualConversations(asEditor, orgId);
    expect(actual).toHaveLength(1);
    // The thread falls back to the surviving event, including its preview text.
    expect(actual[0].eventCount).toBe(1);
    expect(actual[0].latestText).toBe("one");

    await t.run((ctx) => ctx.db.delete(first));
    actual = await actualConversations(asEditor, orgId);
    expect(actual).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("socialConversations").collect())).toHaveLength(0);
  });

  test("answering every event clears needsReply, and a new message sets it again", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrg(t);
    const alice = await makeCustomer(t, orgId, "Alice", "Buyer");

    const one = await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId, externalId: "r1", kind: "dm", senderInstagramId: "ig_alice",
        customerId: alice, text: "question",
      })
    );
    expect((await actualConversations(asEditor, orgId))[0].needsReply).toBe(true);

    await t.run((ctx) => ctx.db.patch(one, { manualRepliedAt: Date.now(), manualReplyText: "answered" }));
    expect((await actualConversations(asEditor, orgId))[0].needsReply).toBe(false);

    // A boolean could not survive this: the thread has an answered event and an
    // unanswered one, and only a count knows the difference.
    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId, externalId: "r2", kind: "dm", senderInstagramId: "ig_alice",
        customerId: alice, text: "follow-up",
      })
    );
    const after = await actualConversations(asEditor, orgId);
    expect(after[0].needsReply).toBe(true);
    expect(after[0].eventCount).toBe(2);
  });

  test("linking a vehicle updates the count and summary without duplicating it", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrg(t);
    const alice = await makeCustomer(t, orgId, "Alice", "Buyer");
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: "VINCONV1", make: "Toyota", model: "Corolla", year: 2021,
        mileage: 100, color: "White", fuelType: "Gas", transmission: "Automatic",
        sellingPrice: 10000, status: "AVAILABLE", createdAt: Date.now(),
      })
    );

    const a = await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId, externalId: "v1", kind: "comment", senderInstagramId: "ig_alice",
        customerId: alice, postId: "p", text: "interested",
      })
    );
    const b = await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId, externalId: "v2", kind: "comment", senderInstagramId: "ig_alice",
        customerId: alice, postId: "p", text: "still interested",
      })
    );

    expect((await actualConversations(asEditor, orgId))[0].vehicleCount).toBe(0);

    // Both events point at the same car — one distinct vehicle, not two.
    await t.run((ctx) => ctx.db.patch(a, { vehicleId }));
    await t.run((ctx) => ctx.db.patch(b, { vehicleId }));

    const actual = await actualConversations(asEditor, orgId);
    expect(actual[0].vehicleCount).toBe(1);
    const page = await asEditor.query(api.socialInbox.listConversations, {
      orgId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(page.page[0].vehicleSummary).toBe("2021 Toyota Corolla");
  });

  test("every filter combination agrees with the original predicates", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrg(t);
    const alice = await makeCustomer(t, orgId, "Alice", "Buyer");
    const bob = await makeCustomer(t, orgId, "Bob", "Buyer");
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: "VINCONV2", make: "Kia", model: "Rio", year: 2022,
        mileage: 100, color: "Red", fuelType: "Gas", transmission: "Automatic",
        sellingPrice: 9000, status: "AVAILABLE", createdAt: Date.now(),
      })
    );

    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId, externalId: "fx1", kind: "comment", senderInstagramId: "ig_alice",
        customerId: alice, postId: "p1", text: "ig comment, vehicle, needs reply", vehicleId,
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId, externalId: "fx2", kind: "dm", senderInstagramId: "ig_alice",
        customerId: alice, text: "ig dm, no vehicle, answered", autoRepliedAt: Date.now(),
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("facebookEvents", {
        orgId, externalId: "fx3", kind: "comment", senderFacebookId: "fb_bob",
        customerId: bob, postId: "p2", text: "fb comment, no vehicle, needs reply",
      })
    );

    const oracle = await oracleConversations(t, orgId);
    const matches = (
      c: (typeof oracle)[number],
      f: { platform?: string; kind?: string; hasVehicle?: boolean; needsReply?: boolean }
    ) =>
      (f.platform === undefined || c.platform === f.platform) &&
      (f.kind === undefined || c.conversationKind === f.kind) &&
      (f.hasVehicle === undefined || (f.hasVehicle ? c.vehicleCount > 0 : c.vehicleCount === 0)) &&
      (f.needsReply === undefined || c.needsReply === f.needsReply);

    const filters: Record<string, unknown>[] = [
      {},
      { platform: "instagram" },
      { platform: "facebook" },
      { kind: "comment" },
      { kind: "dm" },
      { hasVehicle: true },
      { hasVehicle: false },
      { needsReply: true },
      { needsReply: false },
      { platform: "instagram", kind: "comment" },
      { platform: "instagram", kind: "dm" },
      { platform: "instagram", hasVehicle: true },
      { platform: "facebook", needsReply: true },
      { kind: "comment", hasVehicle: false },
      // The only two-clause all-false case: where a q.and arity slip or a
      // `=== false` vs falsy mistake would show.
      { hasVehicle: false, needsReply: false },
      { platform: "instagram", kind: "comment", hasVehicle: true, needsReply: true },
    ];

    for (const f of filters) {
      const actual = await actualConversations(asEditor, orgId, f);
      const expected = oracle.filter((c) => matches(c, f));
      expect(
        actual.map((c) => c.latestCreationTime),
        `filter ${JSON.stringify(f)}`
      ).toEqual(expected.map((c) => c.latestCreationTime));
    }
  });

  test("paginates at the database, covering every thread exactly once", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrg(t);

    for (const i of [0, 1, 2, 3, 4, 5, 6]) {
      const customerId = await makeCustomer(t, orgId, `C${i}`, "Buyer");
      await t.run((ctx) =>
        ctx.db.insert("instagramEvents", {
          orgId, externalId: `pg_${i}`, kind: "dm", senderInstagramId: `ig_${i}`,
          customerId, text: `msg ${i}`,
        })
      );
    }

    const seen: number[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const result: {
        page: { latestCreationTime: number }[];
        isDone: boolean;
        continueCursor: string;
      } = await asEditor.query(api.socialInbox.listConversations, {
        orgId,
        paginationOpts: { numItems: 3, cursor },
      });
      seen.push(...result.page.map((r) => r.latestCreationTime));
      if (result.isDone) break;
      cursor = result.continueCursor;
    }

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    // Still newest-first across the page boundary, which an offset cursor over
    // a re-sorted array could not promise once a new event arrived mid-scroll.
    expect([...seen].sort((a, b) => b - a)).toEqual(seen);
  });

  test("one org's threads never appear in another's inbox", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrg(t);
    const { orgId: otherOrgId } = await seedOrg(t, "conv_editor_002");
    const mine = await makeCustomer(t, orgId, "Mine", "Buyer");
    const theirs = await makeCustomer(t, otherOrgId, "Theirs", "Buyer");

    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId, externalId: "t1", kind: "dm", senderInstagramId: "shared_sender",
        customerId: mine, text: "mine",
      })
    );
    for (const i of [0, 1]) {
      await t.run((ctx) =>
        ctx.db.insert("instagramEvents", {
          orgId: otherOrgId, externalId: `t_other_${i}`, kind: "dm",
          senderInstagramId: "shared_sender", customerId: theirs, text: "theirs",
        })
      );
    }

    const actual = await actualConversations(asEditor, orgId);
    expect(actual).toHaveLength(1);
    expect(actual[0].customerId).toBe(mine);
    expect(actual[0].latestText).toBe("mine");
  });

  test("backfills threads that predate the trigger, and is idempotent", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
      // Always starts un-ready: this test IS the transition from one source to
      // the other, so it must not be pre-marked by the variant.
      const { orgId, asEditor } = await seedOrg(t, undefined, undefined, {
        markReady: false,
      });
      const alice = await makeCustomer(t, orgId, "Alice", "Buyer");
      const bob = await makeCustomer(t, orgId, "Bob", "Buyer");

      // `runUnwrapped` skips the triggers — the exact state of every event that
      // already existed when this shipped.
      await t.runUnwrapped(async (ctx) => {
        await ctx.db.insert("instagramEvents", {
          orgId, externalId: "legacy_1", kind: "comment", senderInstagramId: "ig_alice",
          customerId: alice, postId: "p", text: "old one",
        });
        await ctx.db.insert("instagramEvents", {
          orgId, externalId: "legacy_2", kind: "comment", senderInstagramId: "ig_alice",
          customerId: alice, postId: "p", text: "old two",
        });
        await ctx.db.insert("facebookEvents", {
          orgId, externalId: "legacy_3", kind: "dm", senderFacebookId: "fb_bob",
          customerId: bob, text: "old three",
        });
      });

      // Materialisation is empty and unproven, so the reader must fall back to
      // the events rather than report an empty inbox. Before the readiness
      // gate this returned 0 — which is exactly what a production deployment
      // showed staff over a thousand live events.
      const beforeBackfill = await actualConversations(asEditor, orgId, {}, "legacy");
      expect(beforeBackfill).toHaveLength(2);
      expect(await t.run((ctx) => ctx.db.query("socialConversations").collect())).toHaveLength(0);

      const runBackfills = async () => {
        await t.mutation(internal.migrations.backfillInstagramConversations, {
          orgId,
          batchSize: 1,
        });
        await t.finishAllScheduledFunctions(vi.runAllTimers);
        await t.mutation(internal.migrations.backfillFacebookConversations, {
          orgId,
          batchSize: 1,
        });
        await t.finishAllScheduledFunctions(vi.runAllTimers);
      };

      await runBackfills();
      // The backfill proved exhaustion, so the reader has switched sources.
      const healed = await actualConversations(asEditor, orgId, {}, "materialized");
      const expected = await oracleConversations(t, orgId);
      expect(healed).toHaveLength(2);
      expect(healed.map((c) => c.eventCount).sort((a, b) => a - b)).toEqual([1, 2]);
      expect(healed.map((c) => c.latestCreationTime)).toEqual(
        expected.map((c) => c.latestCreationTime)
      );

      // Two events in one thread means the backfill syncs that thread twice
      // even in a single run; a redrive does it twice more. A recompute
      // converges, an increment would not.
      await runBackfills();
      expect(await actualConversations(asEditor, orgId, {}, "materialized")).toEqual(healed);
      expect(await t.run((ctx) => ctx.db.query("socialConversations").collect())).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a real customer merge carries the thread to the survivor", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    // `mergeCustomers` needs its own permission, so this org's role gets it.
    const orgId = await t.run(async (ctx) =>
      ctx.db.insert("organizations", { name: "Merge Org", createdAt: Date.now() })
    );
    await t.run(async (ctx) =>
      ctx.db.insert("subscriptions", {
        orgId, plan: "professional", status: "active",
        createdAt: Date.now(), updatedAt: Date.now(),
      })
    );
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { clerkId: "conv_merger", email: "merger@test.com", name: "Merger" })
    );
    const roleId = await t.run(async (ctx) =>
      ctx.db.insert("roles", {
        orgId, name: "MANAGER",
        permissions: ["view:leads", "view:customers", "merge:customers"],
      })
    );
    await t.run(async (ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    // This org is built by hand rather than through `seedOrg`, so it needs the
    // readiness record the variant would otherwise have added.
    if (currentSource === "materialized") await markMaterializationReady(t, orgId);
    const asMerger = t.withIdentity({ subject: "conv_merger" });

    const survivorId = await makeCustomer(t, orgId, "Survivor", "Customer");
    const loserId = await makeCustomer(t, orgId, "Loser", "Customer");

    await t.run((ctx) =>
      ctx.db.insert("facebookEvents", {
        orgId, externalId: "merge_evt", kind: "dm", senderFacebookId: "fb_loser",
        customerId: loserId, text: "from the duplicate",
      })
    );
    expect((await actualConversations(asMerger, orgId))[0].customerId).toBe(loserId);

    await asMerger.mutation(api.customers.mergeCustomers, { orgId, survivorId, loserId });

    // `socialConversations` is deliberately absent from
    // CUSTOMER_REFERENCING_TABLES: its `conversationKey` embeds the customer
    // id, so a blind `customerId` patch would leave the key naming the loser
    // and the next message would open a second thread beside the orphan. The
    // merge repoints the *events*; the trigger rebuilds from those. This is the
    // test that the exemption is a design decision and not a gap.
    const after = await actualConversations(asMerger, orgId);
    expect(after).toHaveLength(1);
    expect(after[0].customerId).toBe(survivorId);

    const rows = await t.run((ctx) => ctx.db.query("socialConversations").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].customerId).toBe(survivorId);
    expect(rows[0].conversationKey).toContain(survivorId);
    expect(rows[0].conversationKey).not.toContain(loserId);
  });

  /**
   * The bulk paths recompute each touched thread ONCE, not once per event.
   *
   * This is a cost defect, which a correctness assertion cannot see — a
   * quadratic implementation returns exactly the same rows. Asserting on
   * elapsed time would be flaky and would still pass on a small fixture, so
   * these count recomputes structurally.
   */
  describe("bulk operations defer the thread recompute", () => {
    test("merging 200 events in one thread recomputes it a bounded number of times", async () => {
      const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
      const { orgId, asUser } = await seedOrg(t, "bulk_merge_1", MANAGER_PERMISSIONS);
      const survivorId = await makeCustomer(t, orgId, "Survivor", "C");
      const loserId = await makeCustomer(t, orgId, "Loser", "C");

      await t.run(async (ctx) => {
        for (let i = 0; i < 200; i += 1) {
          await ctx.db.insert("facebookEvents", {
            orgId, externalId: "bulk_" + i, kind: "dm",
            senderFacebookId: "fb_bulk", customerId: loserId, text: "m" + i,
          });
        }
      });

      resetSocialConversationSyncCount();
      await asUser.mutation(api.customers.mergeCustomers, { orgId, survivorId, loserId });
      const recomputes = readSocialConversationSyncCount();

      // Two threads are affected — the loser's (emptied) and the survivor's
      // (filled) — so two recomputes. Before the deferred writer this was 400.
      expect(recomputes).toBe(2);

      const after = await actualConversations(asUser, orgId);
      expect(after).toHaveLength(1);
      expect(after[0].customerId).toBe(survivorId);
      expect(after[0].eventCount).toBe(200);
    }, 300000);

    test("events spread across four threads recompute four times, not once per event", async () => {
      const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
      const { orgId, asUser } = await seedOrg(t, "bulk_merge_2", MANAGER_PERMISSIONS);
      const survivorId = await makeCustomer(t, orgId, "Survivor", "C");
      const loserId = await makeCustomer(t, orgId, "Loser", "C");

      // 4 threads: an IG DM, an FB DM, and two IG comment threads on different
      // posts — 200 events total.
      await t.run(async (ctx) => {
        for (let i = 0; i < 50; i += 1) {
          await ctx.db.insert("instagramEvents", {
            orgId, externalId: "ig_dm_" + i, kind: "dm",
            senderInstagramId: "ig_b", customerId: loserId, text: "a" + i,
          });
          await ctx.db.insert("facebookEvents", {
            orgId, externalId: "fb_dm_" + i, kind: "dm",
            senderFacebookId: "fb_b", customerId: loserId, text: "b" + i,
          });
          await ctx.db.insert("instagramEvents", {
            orgId, externalId: "ig_p1_" + i, kind: "comment", postId: "p1",
            senderInstagramId: "ig_b", customerId: loserId, text: "c" + i,
          });
          await ctx.db.insert("instagramEvents", {
            orgId, externalId: "ig_p2_" + i, kind: "comment", postId: "p2",
            senderInstagramId: "ig_b", customerId: loserId, text: "d" + i,
          });
        }
      });

      resetSocialConversationSyncCount();
      await asUser.mutation(api.customers.mergeCustomers, { orgId, survivorId, loserId });

      // 4 loser threads + 4 survivor threads. Proportional to threads, not to
      // the 200 events — the whole point.
      expect(readSocialConversationSyncCount()).toBe(8);
      expect(await actualConversations(asUser, orgId)).toHaveLength(4);
    }, 300000);

    test("recompute count stays flat as the thread grows — the scaling regression", async () => {
      const counts: number[] = [];
      for (const n of [100, 200, 400]) {
        const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
        const { orgId, asUser } = await seedOrg(t, "bulk_scale_" + n, MANAGER_PERMISSIONS);
        const survivorId = await makeCustomer(t, orgId, "S", "C");
        const loserId = await makeCustomer(t, orgId, "L", "C");
        await t.run(async (ctx) => {
          for (let i = 0; i < n; i += 1) {
            await ctx.db.insert("facebookEvents", {
              orgId, externalId: "s_" + i, kind: "dm",
              senderFacebookId: "fb_s", customerId: loserId, text: "m" + i,
            });
          }
        });
        resetSocialConversationSyncCount();
        await asUser.mutation(api.customers.mergeCustomers, { orgId, survivorId, loserId });
        counts.push(readSocialConversationSyncCount());
      }

      // Quadratic would give 200 / 400 / 800 here. Constant is the fix.
      expect(counts).toEqual([2, 2, 2]);
    }, 600000);

    test("linking a vehicle across a customer's whole history recomputes once per thread", async () => {
      const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
      const { orgId, asUser } = await seedOrg(t, "bulk_vehicle", MANAGER_PERMISSIONS);
      const customerId = await makeCustomer(t, orgId, "Chatty", "C");
      const vehicleId = await t.run((ctx) =>
        ctx.db.insert("vehicles", {
          orgId, vin: "VINBULK1", make: "Kia", model: "Sportage", year: 2023,
          mileage: 10, color: "Blue", fuelType: "Gas", transmission: "Automatic",
          sellingPrice: 20000, status: "AVAILABLE", createdAt: Date.now(),
        })
      );

      await t.run(async (ctx) => {
        for (let i = 0; i < 60; i += 1) {
          await ctx.db.insert("instagramEvents", {
            orgId, externalId: "veh_" + i, kind: "dm",
            senderInstagramId: "ig_v", customerId, text: "m" + i,
          });
        }
      });

      resetSocialConversationSyncCount();
      // The leads-page shape: no platform, no kind, so every unlinked event for
      // the customer is repointed.
      await asUser.mutation(api.socialInbox.setConversationVehicle, {
        orgId, customerId, vehicleId,
      });

      // One thread touched. `vehicleId` is not part of the key, so old and new
      // collapse to the same entry.
      expect(readSocialConversationSyncCount()).toBe(1);

      const after = await actualConversations(asUser, orgId);
      expect(after).toHaveLength(1);
      expect(after[0].vehicleCount).toBe(1);
      expect(after[0].eventCount).toBe(60);
    }, 300000);

    // Scope, stated honestly: deleting the survivor makes `mergeCustomers`
    // throw in its survivor lookup (`customers.ts`, before the reassignment
    // loop), so what this proves is that a merge which fails *before* patching
    // leaves both the events and the materialised rows untouched.
    //
    // The window it does NOT reach is a throw after the event patches and
    // during `syncDeferredSocialThreads` — the one the deferred writer newly
    // introduces. Injecting a failure there needs a seam inside the sync that
    // this suite has no way to reach: convex-test runs the handler through the
    // real module graph, so the sync cannot be stubbed, and no input makes a
    // full thread recompute throw on its own. That window rests on Convex
    // transaction atomicity, which is a platform guarantee rather than
    // something this code can get wrong — a throw anywhere in the mutation
    // rolls back every write in it, patches included.
    test("a merge that fails before patching leaves events and threads untouched", async () => {
      const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
      const { orgId, asUser } = await seedOrg(t, "bulk_rollback", MANAGER_PERMISSIONS);
      const survivorId = await makeCustomer(t, orgId, "Survivor", "C");
      const loserId = await makeCustomer(t, orgId, "Loser", "C");

      await t.run((ctx) =>
        ctx.db.insert("facebookEvents", {
          orgId, externalId: "rb_1", kind: "dm",
          senderFacebookId: "fb_rb", customerId: loserId, text: "keep me",
        })
      );

      // Deleting the survivor makes the merge throw in its survivor lookup,
      // which runs before the reassignment loop.
      await t.run((ctx) => ctx.db.delete(survivorId));
      await expect(
        asUser.mutation(api.customers.mergeCustomers, { orgId, survivorId, loserId })
      ).rejects.toThrow();

      const events = await t.run((ctx) => ctx.db.query("facebookEvents").collect());
      expect(events).toHaveLength(1);
      expect(events[0].customerId).toBe(loserId);
      const rows = await t.run((ctx) => ctx.db.query("socialConversations").collect());
      expect(rows).toHaveLength(1);
      expect(rows[0].customerId).toBe(loserId);
    }, 300000);

    test("ordinary single-event writes still sync synchronously", async () => {
      const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
      const { orgId, asEditor } = await seedOrg(t, "bulk_webhook");
      const customerId = await makeCustomer(t, orgId, "Web", "Hook");

      resetSocialConversationSyncCount();
      await t.run((ctx) =>
        ctx.db.insert("instagramEvents", {
          orgId, externalId: "wh_1", kind: "dm",
          senderInstagramId: "ig_wh", customerId, text: "inbound",
        })
      );

      // The normal writer is untouched: one write, one immediate recompute, and
      // the thread is readable straight away.
      expect(readSocialConversationSyncCount()).toBe(1);
      const after = await actualConversations(asEditor, orgId);
      expect(after).toHaveLength(1);
      expect(after[0].latestText).toBe("inbound");
    });

    test("identical thread identifiers in two orgs never collapse into one key", async () => {
      const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
      const { orgId, asUser } = await seedOrg(t, "bulk_iso_a", MANAGER_PERMISSIONS);
      const { orgId: otherOrgId } = await seedOrg(t, "bulk_iso_b", MANAGER_PERMISSIONS);
      const survivorId = await makeCustomer(t, orgId, "S", "C");
      const loserId = await makeCustomer(t, orgId, "L", "C");
      const otherCustomerId = await makeCustomer(t, otherOrgId, "Other", "C");

      // Same platform and the same sender id in both orgs.
      for (const i of [0, 1]) {
        await t.run((ctx) =>
          ctx.db.insert("facebookEvents", {
            orgId, externalId: "iso_a_" + i, kind: "dm",
            senderFacebookId: "shared_sender", customerId: loserId, text: "mine",
          })
        );
        await t.run((ctx) =>
          ctx.db.insert("facebookEvents", {
            orgId: otherOrgId, externalId: "iso_b_" + i, kind: "dm",
            senderFacebookId: "shared_sender", customerId: otherCustomerId, text: "theirs",
          })
        );
      }

      await asUser.mutation(api.customers.mergeCustomers, { orgId, survivorId, loserId });

      const mine = await actualConversations(asUser, orgId);
      expect(mine).toHaveLength(1);
      expect(mine[0].customerId).toBe(survivorId);
      expect(mine[0].eventCount).toBe(2);

      // The other org's thread is untouched by a merge it had nothing to do with.
      const theirs = await t.run((ctx) =>
        ctx.db
          .query("socialConversations")
          .withIndex("by_org_lastEventAt", (q) => q.eq("orgId", otherOrgId))
          .collect()
      );
      expect(theirs).toHaveLength(1);
      expect(theirs[0].customerId).toBe(otherCustomerId);
      expect(theirs[0].eventCount).toBe(2);
    }, 300000);

    test("an event written after the deferred sync is still materialised", async () => {
      const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
      const { orgId, asUser } = await seedOrg(t, "bulk_after", MANAGER_PERMISSIONS);
      const survivorId = await makeCustomer(t, orgId, "S", "C");
      const loserId = await makeCustomer(t, orgId, "L", "C");

      await t.run((ctx) =>
        ctx.db.insert("facebookEvents", {
          orgId, externalId: "after_1", kind: "dm",
          senderFacebookId: "fb_after", customerId: loserId, text: "before merge",
        })
      );
      await asUser.mutation(api.customers.mergeCustomers, { orgId, survivorId, loserId });

      // A webhook arriving after the bulk operation goes through the normal
      // writer, so suppression cannot leak past the mutation that opted into it.
      await t.run((ctx) =>
        ctx.db.insert("facebookEvents", {
          orgId, externalId: "after_2", kind: "dm",
          senderFacebookId: "fb_after", customerId: survivorId, text: "after merge",
        })
      );

      const after = await actualConversations(asUser, orgId);
      expect(after).toHaveLength(1);
      expect(after[0].eventCount).toBe(2);
      expect(after[0].latestText).toBe("after merge");
    }, 300000);
  });

  test("requires org membership", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrg(t);

    const outsider = t.withIdentity({ subject: "conv_not_a_member" });
    await expect(
      outsider.query(api.socialInbox.listConversations, {
        orgId,
        paginationOpts: { numItems: 10, cursor: null },
      })
    ).rejects.toThrow();
  });
  }
);
