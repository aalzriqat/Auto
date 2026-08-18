import { convexTestWithComponents } from "../test-utils/convexTest";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { ALL_PERMISSIONS } from "./utils/permissions";

afterEach(() => {
  vi.useRealTimers();
});

type TestConvex = ReturnType<typeof convexTestWithComponents>;
type PaidPlan = "starter" | "professional" | "enterprise";

async function seedOwnerOrg(
  t: TestConvex,
  options: { plan?: PaidPlan; currentPeriodEnd?: number } = {}
) {
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Gate Test Dealer", createdAt: Date.now() })
  ) as Id<"organizations">;

  if (options.plan) {
    await t.run((ctx) =>
      ctx.db.insert("subscriptions", {
        orgId,
        plan: options.plan,
        status: "active",
        currentPeriodEnd: options.currentPeriodEnd,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
  }

  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: "gate_owner",
      email: "gate-owner@example.com",
      name: "Gate Owner",
    })
  ) as Id<"users">;
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "OWNER",
      permissions: ALL_PERMISSIONS,
      isSystemOwnerRole: true,
    })
  ) as Id<"roles">;
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));

  return {
    orgId,
    asOwner: t.withIdentity({ subject: "gate_owner", clerkId: "gate_owner" }),
  };
}

describe("subscription feature gates", () => {
  test("free orgs are blocked from paid direct API surfaces", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwnerOrg(t);

    await expect(asOwner.mutation(api.chartOfAccounts.initialize, { orgId }))
      .rejects.toThrow(/accounting/i);
    await expect(asOwner.mutation(api.websites.startSetup, { orgId }))
      .rejects.toThrow(/website builder/i);
    await expect(
      asOwner.mutation(api.roles.create, {
        orgId,
        name: "Finance Manager",
        permissions: ["view:finance"],
      })
    ).rejects.toThrow(/custom roles/i);
    await expect(
      asOwner.mutation(api.branches.add, {
        orgId,
        name: "Second Showroom",
        isActive: true,
      })
    ).rejects.toThrow(/multi-branch/i);
    await expect(
      asOwner.query(api.socialInbox.listConversations, {
        orgId,
        paginationOpts: { numItems: 10, cursor: null },
      })
    ).rejects.toThrow(/social inbox/i);
    await expect(
      asOwner.mutation(api.notificationPreferences.setPreference, {
        orgId,
        category: "sales",
        emailEnabled: true,
        whatsappEnabled: true,
        pushEnabled: false,
      })
    ).rejects.toThrow(/whatsapp/i);
  });

  test("expired subscriptions fall back to free-plan access once reconciled", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwnerOrg(t, {
      plan: "professional",
      currentPeriodEnd: Date.now() - 60_000,
    });

    // SCRUM-145 moved this from read-time to stored state. This assertion used
    // to hold the instant the period ended, because every gate re-derived
    // expiry from Date.now() — which is exactly what made every plan-gated
    // query uncacheable. Access now ends when the reconciler records it, within
    // the owner-accepted 5-minute bound.
    await t.mutation(internal.subscriptions.reconcileExpiredSubscriptions, {});

    await expect(asOwner.mutation(api.chartOfAccounts.initialize, { orgId }))
      .rejects.toThrow(/accounting/i);

    const row = await t.run((ctx) =>
      ctx.db.query("subscriptions").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique()
    );
    expect(row?.status).toBe("expired");
    // The plan itself is never rewritten — only entitlement lapses, so a
    // renewal restores the paid tier rather than having to re-select it.
    expect(row?.plan).toBe("professional");
  });

  test("a lapsed period grants no access beyond the reconciliation bound", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwnerOrg(t, {
      plan: "professional",
      currentPeriodEnd: Date.now() - 60_000,
    });

    // The accepted trade: stored state still says active, so the gate opens
    // until the sweep runs. Asserted explicitly so nobody "fixes" it by
    // reintroducing a clock read into the reactive path.
    await expect(asOwner.mutation(api.chartOfAccounts.initialize, { orgId }))
      .resolves.toBe(true);
  });

  test("reconciliation never downgrades a subscription before its period ends", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwnerOrg(t, {
      plan: "professional",
      currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });

    const result = await t.mutation(internal.subscriptions.reconcileExpiredSubscriptions, {});
    expect(result.expired).toBe(0);

    await expect(asOwner.mutation(api.chartOfAccounts.initialize, { orgId })).resolves.toBe(true);
  });

  test("reconciliation leaves free plans and open-ended paid plans alone", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));

    // A free row carries no currentPeriodEnd. undefined sorts BELOW every
    // number in the by_status_period_end index, so the lte(now) range returns
    // these rows — expiring them would strip every free org of its own plan and
    // break `hasFeature` for the whole deployment.
    const freeOrg = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Free Dealer", createdAt: Date.now() })
    );
    await t.run((ctx) =>
      ctx.db.insert("subscriptions", {
        orgId: freeOrg,
        plan: "free",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    // A free row that still carries a stale currentPeriodEnd from a previous
    // paid period — reachable through adminUpdateSubscription, which accepts
    // plan and currentPeriodEnd independently. Without the plan guard this row
    // reaches the comparison and gets stamped "expired", so a free org's own
    // row starts claiming a lapsed entitlement it never had. The undefined
    // guard does NOT cover this case: mutation testing showed the free-plan
    // guard survives every other fixture precisely because free rows normally
    // carry no period end.
    const downgradedOrg = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Downgraded Dealer", createdAt: Date.now() })
    );
    await t.run((ctx) =>
      ctx.db.insert("subscriptions", {
        orgId: downgradedOrg,
        plan: "free",
        status: "active",
        currentPeriodEnd: Date.now() - 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    // A paid row with no agreed end is perpetual, not already-over.
    const perpetualOrg = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Perpetual Dealer", createdAt: Date.now() })
    );
    await t.run((ctx) =>
      ctx.db.insert("subscriptions", {
        orgId: perpetualOrg,
        plan: "enterprise",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    const result = await t.mutation(internal.subscriptions.reconcileExpiredSubscriptions, {});
    expect(result.expired).toBe(0);

    const rows = await t.run((ctx) => ctx.db.query("subscriptions").collect());
    expect(rows.every((r) => r.status === "active")).toBe(true);
  });

  test("reconciliation does not re-derive cancelled or past_due from the clock", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));

    for (const status of ["cancelled", "past_due"] as const) {
      const org = await t.run((ctx) =>
        ctx.db.insert("organizations", { name: `${status} Dealer`, createdAt: Date.now() })
      );
      await t.run((ctx) =>
        ctx.db.insert("subscriptions", {
          orgId: org,
          plan: "professional",
          status,
          currentPeriodEnd: Date.now() - 60_000,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
      );
    }

    await t.mutation(internal.subscriptions.reconcileExpiredSubscriptions, {});

    const rows = await t.run((ctx) => ctx.db.query("subscriptions").collect());
    // A billing decision is the billing provider's to make. Rewriting these to
    // "expired" would destroy the reason the subscription stopped.
    expect(rows.map((r) => r.status).sort()).toEqual(["cancelled", "past_due"]);
  });

  test("a crowd of free orgs cannot starve a genuinely lapsed paid org", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));

    // `currentPeriodEnd` is optional and undefined sorts BELOW every number, so
    // a plain lte(now) range hands back every free row before it reaches any
    // paid one. With more free orgs than the page size the sweep would fill its
    // whole batch with rows it then skips, and no subscription would ever
    // expire — silently, with a green heartbeat and expired: 0 every run.
    await t.run(async (ctx) => {
      for (let i = 0; i < 150; i++) {
        const org = await ctx.db.insert("organizations", {
          name: `Free Dealer ${i}`,
          createdAt: Date.now(),
        });
        await ctx.db.insert("subscriptions", {
          orgId: org,
          plan: "free",
          status: "active",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    });

    const lapsedOrg = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Lapsed Paid Dealer", createdAt: Date.now() })
    );
    await t.run((ctx) =>
      ctx.db.insert("subscriptions", {
        orgId: lapsedOrg,
        plan: "professional",
        status: "active",
        currentPeriodEnd: Date.now() - 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    const result = await t.mutation(internal.subscriptions.reconcileExpiredSubscriptions, {});
    expect(result.expired).toBe(1);

    const row = await t.run((ctx) =>
      ctx.db.query("subscriptions").withIndex("by_org", (q) => q.eq("orgId", lapsedOrg)).unique()
    );
    expect(row?.status).toBe("expired");
  });

  test("reconciliation is idempotent", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    await seedOwnerOrg(t, { plan: "professional", currentPeriodEnd: Date.now() - 60_000 });

    const first = await t.mutation(internal.subscriptions.reconcileExpiredSubscriptions, {});
    const second = await t.mutation(internal.subscriptions.reconcileExpiredSubscriptions, {});

    expect(first.expired).toBe(1);
    expect(second.expired).toBe(0);
  });

  test("renewal reverses an expired subscription", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwnerOrg(t, {
      plan: "professional",
      currentPeriodEnd: Date.now() - 60_000,
    });

    await t.mutation(internal.subscriptions.reconcileExpiredSubscriptions, {});
    await expect(asOwner.mutation(api.chartOfAccounts.initialize, { orgId }))
      .rejects.toThrow(/accounting/i);

    // Renewal through the authoritative path. `expired` must not be a one-way
    // door — nothing about it is permanent.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("subscriptions")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .unique();
      await ctx.db.patch(row!._id, {
        status: "active",
        currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
        updatedAt: Date.now(),
      });
    });

    await expect(asOwner.mutation(api.chartOfAccounts.initialize, { orgId })).resolves.toBe(true);

    // And a later sweep must not undo the renewal.
    const result = await t.mutation(internal.subscriptions.reconcileExpiredSubscriptions, {});
    expect(result.expired).toBe(0);
    await expect(asOwner.query(api.subscriptions.getMySubscription, { orgId }))
      .resolves.toMatchObject({ status: "active", plan: "professional" });
  });

  test("professional plans allow professional gates but not enterprise gates", async () => {
    // chartOfAccounts.initialize succeeds here and schedules
    // accountingOutbox:drainPendingAccountingEvents. Left alone it fires after
    // teardown and fails the whole run with an unhandled error while every test
    // still passes. Fake timers must be installed before the scheduling call —
    // Vitest only controls timers created after this line.
    vi.useFakeTimers();
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwnerOrg(t, { plan: "professional" });

    await expect(asOwner.mutation(api.chartOfAccounts.initialize, { orgId })).resolves.toBe(true);
    await expect(
      asOwner.mutation(api.roles.create, {
        orgId,
        name: "Sales Lead",
        permissions: ["view:leads", "edit:leads"],
      })
    ).resolves.toBeDefined();
    await expect(
      asOwner.mutation(api.notificationPreferences.setPreference, {
        orgId,
        category: "sales",
        emailEnabled: true,
        whatsappEnabled: true,
        pushEnabled: false,
      })
    ).resolves.toBeNull();
    await expect(
      asOwner.query(api.socialInbox.listConversations, {
        orgId,
        paginationOpts: { numItems: 10, cursor: null },
      })
    ).resolves.toMatchObject({ page: [] });

    await expect(asOwner.mutation(api.websites.startSetup, { orgId }))
      .rejects.toThrow(/website builder/i);
    await expect(
      asOwner.mutation(api.branches.add, {
        orgId,
        name: "Second Showroom",
        isActive: true,
      })
    ).rejects.toThrow(/multi-branch/i);

    // Run the accounting drain this test queued, rather than leaving it to
    // fire once the environment is gone.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  test("enterprise plans allow enterprise-only gates", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwnerOrg(t, { plan: "enterprise" });

    await expect(asOwner.mutation(api.websites.startSetup, { orgId })).resolves.toBeDefined();
    await expect(
      asOwner.mutation(api.branches.add, {
        orgId,
        name: "Second Showroom",
        isActive: true,
      })
    ).resolves.toBeNull();

    const branches = await asOwner.query(api.branches.list, { orgId });
    expect(branches).toHaveLength(1);
    expect(branches[0].name).toBe("Second Showroom");
  });
});
