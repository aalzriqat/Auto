/**
 * The two remaining "works until it doesn't" fan-outs.
 *
 * Both were single mutations whose read/write count grew with the number of
 * tenants. That is not a slow query — a Convex mutation that exceeds its budget
 * throws and rolls back every write, so the feature does not degrade, it stops
 * working entirely and leaves nothing behind to show it was tried.
 */
import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { ALL_PERMISSIONS } from "./utils/permissions";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

vi.mock("./utils/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./utils/env")>();
  return {
    ...actual,
    getValidatedEnv: () => ({
      ...actual.getValidatedEnv(),
      SUPER_ADMIN_EMAILS: "root@autoflow.test",
    }),
  };
});

/** An org with `members` members, all real seats. */
async function seedOrg(t: any, label: string, members: number) {
  return await t.run(async (ctx: any) => {
    const orgId = await ctx.db.insert("organizations", { name: label, createdAt: Date.now() });
    const roleId = await ctx.db.insert("roles", {
      orgId,
      name: "OWNER",
      permissions: ALL_PERMISSIONS,
      isSystemOwnerRole: true,
    });
    for (let i = 0; i < members; i++) {
      const userId = await ctx.db.insert("users", {
        clerkId: `${label}_u${i}`,
        email: `${label}-${i}@test.com`,
        name: `Member ${i}`,
      });
      await ctx.db.insert("memberships", { orgId, userId, roleId });
    }
    return orgId;
  });
}

describe("adminBroadcasts.create fans out without one unbounded mutation", () => {
  async function seedSuperAdmin(t: any) {
    await t.run(async (ctx: any) => {
      await ctx.db.insert("users", {
        clerkId: "root_admin",
        email: "root@autoflow.test",
        name: "Root",
      });
    });
    return t.withIdentity({ subject: "root_admin" });
  }

  test("reaches orgs past the first page and totals their recipients", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, import.meta.glob("./**/*.*s"));
      const asAdmin = await seedSuperAdmin(t);

      // The fan-out pages 25 orgs at a time, so 30 orgs crosses the boundary.
      // Two members each: 60 recipients if every page ran, 50 if only the first
      // did — the difference between a broadcast that reached everyone and one
      // that silently stopped a fifth of the way in.
      //
      // Like the badge cron, this is not a pre-fix reproduction: the old inline
      // loop handled 30 orgs fine, and its failure mode is a budget limit no
      // test can reach. What it does catch is the way this rewrite would
      // plausibly break — verified by deleting the reschedule, which drops the
      // count to exactly 50.
      for (let i = 0; i < 30; i++) {
        await seedOrg(t, `org${i}`, 2);
      }

      const broadcastId = await asAdmin.mutation(api.adminBroadcasts.create, {
        audience: "all_orgs",
        title: "Scheduled maintenance",
        message: "We will be down for 10 minutes tonight.",
      });

      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const notifications = await t.run((ctx: any) => ctx.db.query("notifications").collect());
      expect(notifications).toHaveLength(60);

      // recipientCount accumulates per page, so a run that died halfway would
      // leave an honest partial number rather than the zero it starts at.
      const broadcast: any = await t.run((ctx: any) => ctx.db.get(broadcastId));
      expect(broadcast.recipientCount).toBe(60);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a single-org broadcast still resolves its recipient count inline", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asAdmin = await seedSuperAdmin(t);
    const orgId = await seedOrg(t, "solo", 3);

    const broadcastId = await asAdmin.mutation(api.adminBroadcasts.create, {
      audience: "one_org",
      orgId,
      title: "Just you",
      message: "A note for this dealership only.",
    });

    // No scheduler drain: one org's fan-out is bounded by its seat cap and runs
    // inline, so the count is exact the moment `create` returns.
    const broadcast: any = await t.run((ctx: any) => ctx.db.get(broadcastId));
    expect(broadcast.recipientCount).toBe(3);
    const notifications = await t.run((ctx: any) => ctx.db.query("notifications").collect());
    expect(notifications).toHaveLength(3);
  });
});

describe("subscriptions.canAddMember counts seats exactly", () => {
  /**
   * The starter plan's cap, read from the same table the guard reads so this
   * test cannot drift from a plan-config change.
   */
  async function starterCap(t: any): Promise<number> {
    const { PLANS } = await import("./subscriptions");
    return PLANS.starter.maxUsers;
  }

  test("does not hand out a free seat when non-seat rows fill the old prefix", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const cap = await starterCap(t);

    const orgId = await t.run(async (ctx: any) =>
      ctx.db.insert("organizations", { name: "prefixed", createdAt: Date.now() })
    );
    await t.run(async (ctx: any) => {
      await ctx.db.insert("subscriptions", {
        orgId,
        plan: "starter",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    // Order is the whole point. The old guard read `cap + 50` rows ordered by
    // _creationTime and then discarded the non-seat ones, so 60 offboarding rows
    // created *first* pushed the real seats out past the prefix: it saw far fewer
    // than `cap` real members and allowed another seat on a plan already at its
    // limit. Undercounting is the direction that gives a seat away.
    await t.run(async (ctx: any) => {
      const roleId = await ctx.db.insert("roles", {
        orgId,
        name: "OWNER",
        permissions: ALL_PERMISSIONS,
        isSystemOwnerRole: true,
      });
      for (let i = 0; i < 60; i++) {
        const userId = await ctx.db.insert("users", {
          clerkId: `gone_u${i}`,
          email: `gone-${i}@test.com`,
        });
        await ctx.db.insert("memberships", {
          orgId,
          userId,
          roleId,
          offboardingStatus: "PENDING_EXTERNAL_REMOVAL",
          offboardingRequestedAt: Date.now(),
        });
      }
      for (let i = 0; i < cap; i++) {
        const userId = await ctx.db.insert("users", {
          clerkId: `seat_u${i}`,
          email: `seat-${i}@test.com`,
        });
        await ctx.db.insert("memberships", { orgId, userId, roleId });
      }
    });

    const check: any = await t.query(internal.subscriptions.canAddMember, { orgId });
    expect(check.allowed).toBe(false);
    expect(check.current).toBe(cap);
  });

  test("still allows a seat below the cap", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const cap = await starterCap(t);

    const orgId = await seedOrg(t, "roomleft", cap - 1);
    await t.run(async (ctx: any) => {
      await ctx.db.insert("subscriptions", {
        orgId,
        plan: "starter",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const check: any = await t.query(internal.subscriptions.canAddMember, { orgId });
    expect(check.allowed).toBe(true);
  });

  test("an offboarding membership frees its seat", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const cap = await starterCap(t);

    const orgId = await seedOrg(t, "leaving", cap);
    await t.run(async (ctx: any) => {
      await ctx.db.insert("subscriptions", {
        orgId,
        plan: "starter",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org", (q: any) => q.eq("orgId", orgId))
        .first();
      await ctx.db.patch(membership._id, {
        offboardingStatus: "PENDING_EXTERNAL_REMOVAL",
        offboardingRequestedAt: Date.now(),
      });
    });

    const check: any = await t.query(internal.subscriptions.canAddMember, { orgId });
    expect(check.allowed).toBe(true);
  });
});
