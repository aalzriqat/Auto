import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

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

async function seedOrg(
  t: ReturnType<typeof convexTestWithComponents>,
  clerkId = "conv_editor_001"
) {
  const orgId = await t.run(async (ctx) =>
    ctx.db.insert("organizations", { name: "Test Org", createdAt: Date.now() })
  );
  await t.run(async (ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { clerkId, email: `${clerkId}@test.com`, name: "Editor" })
  );
  const roleId = await t.run(async (ctx) =>
    ctx.db.insert("roles", { orgId, name: "SALES", permissions: ["view:leads", "edit:leads"] })
  );
  await t.run(async (ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  return { orgId, asEditor: t.withIdentity({ subject: clerkId }) };
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
  args: Record<string, unknown> = {}
) {
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

describe("socialInbox.listConversations — materialised threads", () => {
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
    expect(actual.map((c) => c.eventCount).sort()).toEqual([1, 1]);
    expect(actual.map((c) => c.eventCount).sort()).toEqual(
      expected.map((c) => c.eventCount).sort()
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
      const { orgId, asEditor } = await seedOrg(t);
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

      expect(await actualConversations(asEditor, orgId)).toHaveLength(0);

      const runBackfills = async () => {
        await t.mutation(internal.migrations.backfillInstagramConversations, { batchSize: 1 });
        await t.finishAllScheduledFunctions(vi.runAllTimers);
        await t.mutation(internal.migrations.backfillFacebookConversations, { batchSize: 1 });
        await t.finishAllScheduledFunctions(vi.runAllTimers);
      };

      await runBackfills();
      const healed = await actualConversations(asEditor, orgId);
      const expected = await oracleConversations(t, orgId);
      expect(healed).toHaveLength(2);
      expect(healed.map((c) => c.eventCount).sort()).toEqual([1, 2]);
      expect(healed.map((c) => c.latestCreationTime)).toEqual(
        expected.map((c) => c.latestCreationTime)
      );

      // Two events in one thread means the backfill syncs that thread twice
      // even in a single run; a redrive does it twice more. A recompute
      // converges, an increment would not.
      await runBackfills();
      expect(await actualConversations(asEditor, orgId)).toEqual(healed);
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
});
