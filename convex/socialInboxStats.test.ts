import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * `socialInbox.platformStats` used to answer nine numbers by `.collect()`-ing
 * both event tables in full — Convex's #3 bandwidth consumer at 1.08 GB in a
 * single week, because it is a live subscription over the very tables social
 * ingestion writes to. It now reads three aggregate B-trees instead.
 *
 * The risk that swap introduces is not a slow query, it is a *wrong* one: a
 * count that drifts from the rows it claims to describe, silently, with nothing
 * failing at the time of the bad write. So the central test here is an
 * equivalence oracle — it re-implements the original scan-and-count over the
 * raw tables and asserts the aggregate agrees with it exactly, on a dataset
 * built to exercise every dimension of the key at once.
 *
 * These live in their own file rather than `socialInbox.test.ts` because that
 * suite predates the aggregates and covers the conversation list, which still
 * reads rows.
 */

async function seedOrgWithEditor(
  t: ReturnType<typeof convexTestWithComponents>,
  clerkId = "stats_editor_001"
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
  return { orgId, userId, asEditor: t.withIdentity({ subject: clerkId }) };
}

/** The exact algorithm the query used before the aggregates replaced it. */
function expectedStatsFromRawScan(
  igEvents: { kind: string; senderInstagramId: string }[],
  fbEvents: { kind: string; senderFacebookId: string }[]
) {
  return {
    instagram: {
      comments: igEvents.filter((e) => e.kind === "comment").length,
      dms: igEvents.filter((e) => e.kind === "dm").length,
      total: igEvents.length,
      uniqueContacts: new Set(igEvents.map((e) => e.senderInstagramId)).size,
    },
    facebook: {
      comments: fbEvents.filter((e) => e.kind === "comment").length,
      dms: fbEvents.filter((e) => e.kind === "dm").length,
      total: fbEvents.length,
      uniqueContacts: new Set(fbEvents.map((e) => e.senderFacebookId)).size,
    },
    total: igEvents.length + fbEvents.length,
  };
}

describe("socialInbox.platformStats", () => {
  test("reports zeros for an org that has never received a social event", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);

    const stats = await asEditor.query(api.socialInbox.platformStats, { orgId });

    expect(stats).toEqual({
      instagram: { comments: 0, dms: 0, total: 0, uniqueContacts: 0 },
      facebook: { comments: 0, dms: 0, total: 0, uniqueContacts: 0 },
      total: 0,
    });
  });

  test("matches a raw scan of both event tables across every kind and repeated senders", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);

    // Deliberately lopsided: senders repeat within a platform (so unique is
    // strictly below total), both kinds appear on both platforms, and the same
    // raw id string is used on Instagram *and* Facebook — the two platforms
    // must not pool their contacts.
    const igSeed: [string, "comment" | "dm"][] = [
      ["shared_id", "comment"],
      ["shared_id", "comment"],
      ["shared_id", "dm"],
      ["ig_only", "dm"],
      ["ig_second", "comment"],
    ];
    const fbSeed: [string, "comment" | "dm"][] = [
      ["shared_id", "dm"],
      ["fb_only", "comment"],
      ["fb_only", "comment"],
    ];

    let n = 0;
    for (const [sender, kind] of igSeed) {
      const i = n++;
      await t.run((ctx) =>
        ctx.db.insert("instagramEvents", {
          orgId,
          externalId: `stats_ig_${i}`,
          kind,
          senderInstagramId: sender,
        })
      );
    }
    for (const [sender, kind] of fbSeed) {
      const i = n++;
      await t.run((ctx) =>
        ctx.db.insert("facebookEvents", {
          orgId,
          externalId: `stats_fb_${i}`,
          kind,
          senderFacebookId: sender,
        })
      );
    }

    const stats = await asEditor.query(api.socialInbox.platformStats, { orgId });
    const rawIg = await t.run((ctx) => ctx.db.query("instagramEvents").collect());
    const rawFb = await t.run((ctx) => ctx.db.query("facebookEvents").collect());

    expect(stats).toEqual(expectedStatsFromRawScan(rawIg, rawFb));
    // Pinned literally too, so a change that breaks both the aggregate and the
    // oracle in the same direction still fails.
    expect(stats.instagram).toEqual({ comments: 3, dms: 2, total: 5, uniqueContacts: 3 });
    expect(stats.facebook).toEqual({ comments: 2, dms: 1, total: 3, uniqueContacts: 2 });
    expect(stats.total).toBe(8);
  });

  test("counts only the caller's org", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);

    const otherOrgId = await t.run(async (ctx) =>
      ctx.db.insert("organizations", { name: "Other Org", createdAt: Date.now() })
    );

    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "mine_1",
        kind: "comment",
        senderInstagramId: "mine",
      })
    );
    // Same sender id, different org: neither the event count nor the contact
    // count may cross the tenant boundary.
    for (const i of [0, 1, 2]) {
      await t.run((ctx) =>
        ctx.db.insert("instagramEvents", {
          orgId: otherOrgId,
          externalId: `theirs_${i}`,
          kind: "dm",
          senderInstagramId: "mine",
        })
      );
    }

    const stats = await asEditor.query(api.socialInbox.platformStats, { orgId });

    expect(stats.instagram).toEqual({ comments: 1, dms: 0, total: 1, uniqueContacts: 1 });
    expect(stats.total).toBe(1);
  });

  test("a sender that keeps messaging adds events but not contacts", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);

    for (const i of [0, 1, 2, 3]) {
      await t.run((ctx) =>
        ctx.db.insert("facebookEvents", {
          orgId,
          externalId: `repeat_${i}`,
          kind: "dm",
          senderFacebookId: "chatty",
        })
      );
    }

    const stats = await asEditor.query(api.socialInbox.platformStats, { orgId });
    expect(stats.facebook).toEqual({ comments: 0, dms: 4, total: 4, uniqueContacts: 1 });

    const contacts = await t.run((ctx) => ctx.db.query("socialContacts").collect());
    expect(contacts).toHaveLength(1);
  });

  test("bookkeeping patches on an existing event do not change any count", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);

    const eventId = await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "patched",
        kind: "comment",
        senderInstagramId: "sender_patched",
      })
    );

    const before = await asEditor.query(api.socialInbox.platformStats, { orgId });

    // The routine write path: auto-reply bookkeeping, then a manual reply.
    await t.run((ctx) =>
      ctx.db.patch(eventId, {
        autoRepliedAt: Date.now(),
        autoReplyText: "hi",
        autoReplySource: "canned",
      })
    );
    await t.run((ctx) =>
      ctx.db.patch(eventId, { manualReplyText: "follow up", manualRepliedAt: Date.now() })
    );

    const after = await asEditor.query(api.socialInbox.platformStats, { orgId });
    expect(after).toEqual(before);
    expect(after.instagram.total).toBe(1);
    expect(after.instagram.uniqueContacts).toBe(1);
  });

  test("two senders merged onto one customer still count as two contacts", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);

    const survivorId = await t.run((ctx) =>
      ctx.db.insert("customers", {
        orgId,
        firstName: "Merged",
        lastName: "Buyer",
        facebookUserId: "fb_a",
      })
    );
    for (const sender of ["fb_a", "fb_b"]) {
      await t.run((ctx) =>
        ctx.db.insert("facebookEvents", {
          orgId,
          externalId: `merge_${sender}`,
          kind: "dm",
          senderFacebookId: sender,
          customerId: survivorId,
        })
      );
    }

    // Counting distinct *customers* would report 1 here. The Set this replaced
    // counted distinct senders, and so must this.
    const stats = await asEditor.query(api.socialInbox.platformStats, { orgId });
    expect(stats.facebook.uniqueContacts).toBe(2);
    expect(stats.facebook.total).toBe(2);
  });

  test("backfills converge on the same counts for rows that predate the triggers, and are idempotent", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);

    // `runUnwrapped` writes without firing the triggers — the exact state a
    // deployment is in for every row that already existed when this shipped.
    await t.runUnwrapped(async (ctx) => {
      await ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "legacy_ig_1",
        kind: "comment",
        senderInstagramId: "legacy_a",
      });
      await ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "legacy_ig_2",
        kind: "dm",
        senderInstagramId: "legacy_a",
      });
      await ctx.db.insert("facebookEvents", {
        orgId,
        externalId: "legacy_fb_1",
        kind: "dm",
        senderFacebookId: "legacy_b",
      });
    });

    // Un-backfilled: the rows exist but no tree or contact row knows about them.
    const stale = await asEditor.query(api.socialInbox.platformStats, { orgId });
    expect(stale.total).toBe(0);

    const runBackfills = async () => {
      await t.mutation(internal.migrations.backfillInstagramEventAggregate, {});
      await t.mutation(internal.migrations.backfillFacebookEventAggregate, {});
      await t.mutation(internal.migrations.backfillInstagramSocialContacts, {});
      await t.mutation(internal.migrations.backfillFacebookSocialContacts, {});
    };

    await runBackfills();
    const healed = await asEditor.query(api.socialInbox.platformStats, { orgId });
    expect(healed.instagram).toEqual({ comments: 1, dms: 1, total: 2, uniqueContacts: 1 });
    expect(healed.facebook).toEqual({ comments: 0, dms: 1, total: 1, uniqueContacts: 1 });
    expect(healed.total).toBe(3);

    // A redrive must not double-count — this is the property that makes the
    // migration safe to re-run after a partial failure.
    await runBackfills();
    const rerun = await asEditor.query(api.socialInbox.platformStats, { orgId });
    expect(rerun).toEqual(healed);
    const contacts = await t.run((ctx) => ctx.db.query("socialContacts").collect());
    expect(contacts).toHaveLength(2);
  });

  test("the clear + backfill repair sequence rebuilds contacts from the events that remain", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);

    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "kept",
        kind: "comment",
        senderInstagramId: "kept_sender",
      })
    );
    const purgedId = await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "purged",
        kind: "comment",
        senderInstagramId: "purged_sender",
      })
    );

    // No product path reaches this — `adminData`'s hard delete is gated on
    // ADMIN_TABLES, which lists neither event table (pinned by the guard test
    // below), and the org purge removes the contact rows too. This is the
    // hypothetical the insert-only trigger is not defended against, exercised
    // directly so the recovery path stays proven.
    await t.run((ctx) => ctx.db.delete(purgedId));

    // The event tree self-heals (the aggregate trigger saw the delete); the
    // insert-only contact table does not, and reads one high.
    const drifted = await asEditor.query(api.socialInbox.platformStats, { orgId });
    expect(drifted.instagram.total).toBe(1);
    expect(drifted.instagram.uniqueContacts).toBe(2);

    vi.useFakeTimers();
    try {
      await t.mutation(internal.migrations.repairSocialContacts, {});
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }

    const repaired = await asEditor.query(api.socialInbox.platformStats, { orgId });
    expect(repaired.instagram).toEqual({ comments: 1, dms: 0, total: 1, uniqueContacts: 1 });
  });

  test("an unidentified sender counts as an event but not as a contact", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);

    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "anonymous",
        kind: "dm",
        senderInstagramId: "",
      })
    );

    const stats = await asEditor.query(api.socialInbox.platformStats, { orgId });

    // The event itself is counted exactly as before.
    expect(stats.instagram.total).toBe(1);
    expect(stats.instagram.dms).toBe(1);
    // The contact is not. This is a deliberate divergence: the `Set` this
    // replaced counted `""` as one contact and showed the dealer a person who
    // does not exist. Pinned so the difference stays a decision rather than a
    // regression — see `recordSocialContact`.
    expect(stats.instagram.uniqueContacts).toBe(0);
    const contacts = await t.run((ctx) => ctx.db.query("socialContacts").collect());
    expect(contacts).toHaveLength(0);
  });

  test("the repair sequence drains across batches, not just the first page", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
      const { orgId, asEditor } = await seedOrgWithEditor(t);

      for (const i of [0, 1, 2, 3, 4]) {
        await t.run((ctx) =>
          ctx.db.insert("facebookEvents", {
            orgId,
            externalId: `batch_${i}`,
            kind: "comment",
            senderFacebookId: `batch_sender_${i}`,
          })
        );
      }
      expect((await asEditor.query(api.socialInbox.platformStats, { orgId })).facebook.uniqueContacts).toBe(5);

      // A one-row batch forces every phase to self-schedule, and forces the
      // clear→instagram→facebook handoff to happen through the scheduler —
      // the path a single-page test never reaches. Started once, drained once.
      const first = await t.mutation(internal.migrations.repairSocialContacts, { batchSize: 1 });
      expect(first.phase).toBe("clear");
      expect(first.isDone).toBe(false);
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const rebuilt = await asEditor.query(api.socialInbox.platformStats, { orgId });
      expect(rebuilt.facebook.uniqueContacts).toBe(5);
      expect(rebuilt.facebook.total).toBe(5);
      // Exactly one row per sender — a rebuild that ran the insert phase twice,
      // or that raced its own clear, would not land here.
      const contacts = await t.run((ctx) => ctx.db.query("socialContacts").collect());
      expect(contacts).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a scoped repair leaves every other org's contacts alone", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
      const { orgId, asEditor } = await seedOrgWithEditor(t);
      const { orgId: otherOrgId, asEditor: asOther } = await seedOrgWithEditor(t, "stats_editor_002");

      for (const org of [orgId, otherOrgId]) {
        for (const i of [0, 1]) {
          await t.run((ctx) =>
            ctx.db.insert("instagramEvents", {
              orgId: org,
              externalId: `scoped_${org}_${i}`,
              kind: "comment",
              senderInstagramId: `scoped_sender_${org}_${i}`,
            })
          );
        }
      }

      await t.mutation(internal.migrations.repairSocialContacts, { orgId, batchSize: 1 });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      // Both orgs whole: the scoped clear must never walk the whole table, or
      // one org's drift zeroes every tenant's card until the rebuild catches up.
      expect((await asEditor.query(api.socialInbox.platformStats, { orgId })).instagram.uniqueContacts).toBe(2);
      expect(
        (await asOther.query(api.socialInbox.platformStats, { orgId: otherOrgId })).instagram.uniqueContacts
      ).toBe(2);
      const contacts = await t.run((ctx) => ctx.db.query("socialContacts").collect());
      expect(contacts).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  test("hard-deleting an org takes its social contacts and their counts with it", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithEditor(t);
    const { orgId: survivorOrgId, asEditor: asSurvivor } = await seedOrgWithEditor(t, "stats_editor_003");

    for (const org of [orgId, survivorOrgId]) {
      await t.run((ctx) =>
        ctx.db.insert("facebookEvents", {
          orgId: org,
          externalId: `purge_${org}`,
          kind: "dm",
          senderFacebookId: `purge_sender_${org}`,
        })
      );
    }
    expect(await t.run((ctx) => ctx.db.query("socialContacts").collect())).toHaveLength(2);

    // `socialContacts` is org-scoped and derived, so it has to be in
    // ORGANIZATION_DELETION_STEPS or a purged org's rows — and its aggregate
    // entries — outlive it.
    const deleted = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("socialContacts")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .collect();
      for (const row of rows) await ctx.db.delete(row._id);
      return rows.length;
    });
    expect(deleted).toBe(1);

    const survivor = await asSurvivor.query(api.socialInbox.platformStats, { orgId: survivorOrgId });
    expect(survivor.facebook.uniqueContacts).toBe(1);
    const remaining = await t.run((ctx) => ctx.db.query("socialContacts").collect());
    expect(remaining).toHaveLength(1);
    expect(remaining[0].orgId).toBe(survivorOrgId);
  });

  test("requires org membership", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithEditor(t);

    const outsider = t.withIdentity({ subject: "not_a_member_001" });
    await expect(outsider.query(api.socialInbox.platformStats, { orgId })).rejects.toThrow();
  });
});

/**
 * Two build-time guards for invariants the insert-only contact trigger rests
 * on. Both fail open at runtime — nothing throws, the count just drifts — so
 * they have to be caught here rather than alerted on.
 */
describe("socialContacts invariants", () => {
  const convexSource = (file: string) =>
    fs.readFileSync(path.join(process.cwd(), "convex", file), "utf8");

  test("the event tables stay out of the super-admin raw-record editor", () => {
    // `recordSocialContact` never deletes, on the grounds that no product path
    // deletes an individual event. `adminData.adminHardDelete` is gated on
    // ADMIN_TABLES; adding either event table there is a one-line change that
    // would make "unique contacts" read permanently high with no other signal.
    const adminData = convexSource("adminData.ts");
    const adminTables = adminData.slice(
      adminData.indexOf("const ADMIN_TABLES"),
      adminData.indexOf("];", adminData.indexOf("const ADMIN_TABLES"))
    );

    expect(adminTables).not.toContain("instagramEvents");
    expect(adminTables).not.toContain("facebookEvents");
  });

  test("a purged org takes its socialContacts rows with it", () => {
    // `socialContacts` is org-scoped and derived. Left out of the purge, a
    // hard-deleted org's rows and its `socialContactsByOrg` entries outlive it.
    expect(convexSource("adminOrgs.ts")).toContain('table: "socialContacts"');
  });
});
