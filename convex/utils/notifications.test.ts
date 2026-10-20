import { convexTestWithComponents } from "../../test-utils/convexTest";
import { expect, test, describe, vi, beforeEach, afterEach } from "vitest";
import schema from "../schema";
import { notifyUser, notifyManagers, notifyAllMembers, notifyOwner, notifyByPermission, notifyFinanceManagers, getActorName, dispatch, resolveManagerRecipients, resolveManagerRecipientsPage, DISPATCH_MAX_SCHEDULED } from "./notifications";
import type { Id } from "../_generated/dataModel";
import { PERMISSIONS } from "./permissions";

vi.mock("../rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

// Every notify* helper fans out to sender actions (email/WhatsApp/push) through
// ctx.scheduler.runAfter(0, ...), and convex-test backs that with a real
// setTimeout. Left alone, those senders therefore execute on a later tick —
// after the test that scheduled them has already finished — and whatever they
// emit races the vitest worker's teardown, surfacing as
//   EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending
// which fails the entire job while every test still reports as passing. It only
// bites under CI's timing (sendNotificationEmail calls getValidatedEnv, which
// throws when the backend env isn't configured, and convex-test logs that
// failure whenever it happens to land), which is exactly what makes it a flake
// rather than an honest failure.
//
// These tests assert on the _scheduled_functions table — that a sender was or
// wasn't scheduled — and never on a sender running, so freezing setTimeout
// keeps the scheduling observable while ensuring nothing executes outside the
// test that asked for it. Only setTimeout is faked: Date and the rest stay real
// so convex-test's own timing is untouched.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

async function seedOrg(t: ReturnType<typeof convexTestWithComponents>) {
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Test Org", createdAt: Date.now() }));

  const ownerRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ["manage:users"], isSystemOwnerRole: true })
  );
  const managerRoleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "MANAGER", permissions: ["manage:users"] }));
  const salesRoleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "SALES", permissions: ["view:vehicles"] }));

  const ownerId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "owner_001", email: "owner@test.com" }));
  const managerId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "manager_001", email: "manager@test.com" }));
  const salesId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "sales_001", email: "sales@test.com" }));

  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: ownerId, roleId: ownerRoleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: managerId, roleId: managerRoleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: salesId, roleId: salesRoleId }));

  return { orgId, ownerId, managerId, salesId };
}

/** Owner + accountant (holds manage:finance) + sales (doesn't) — for notifyFinanceManagers tests. */
async function seedFinanceOrg(t: ReturnType<typeof convexTestWithComponents>) {
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Finance Org", createdAt: Date.now() }));

  const ownerRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ["manage:finance"], isSystemOwnerRole: true })
  );
  const accountantRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "ACCOUNTANT", permissions: ["manage:finance", "view:finance"] })
  );
  const salesRoleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "SALES", permissions: ["view:vehicles"] }));

  const ownerId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "fin_owner_001", email: "owner@finance.test" }));
  const accountantId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "fin_acct_001", email: "acct@finance.test" }));
  const salesId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "fin_sales_001", email: "sales@finance.test" }));

  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: ownerId, roleId: ownerRoleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: accountantId, roleId: accountantRoleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: salesId, roleId: salesRoleId }));

  return { orgId, ownerId, accountantId, salesId };
}

describe("dispatch helpers", () => {
  test("notifyUser inserts an in-app row with the type's category/priority", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, salesId } = await seedOrg(t);

    await t.run((ctx) => notifyUser(ctx, orgId, salesId, "lead.assigned", { actorName: "Alice" }, { link: "/leads" }));

    const rows = await t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", salesId)).collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("lead.assigned");
    expect(rows[0].category).toBe("sales");
    expect(rows[0].priority).toBe("normal");
    expect(rows[0].data).toEqual({ actorName: "Alice" });
    expect(rows[0].link).toBe("/leads");
  });

  test("notifyManagers fans out only to members holding MANAGE_USERS, honoring excludeUserId", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, ownerId, managerId, salesId } = await seedOrg(t);

    await t.run((ctx) => notifyManagers(ctx, orgId, "vehicle.created", { actorName: "Bob" }, { excludeUserId: ownerId }));

    const ownerRows = await t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", ownerId)).collect());
    const managerRows = await t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", managerId)).collect());
    const salesRows = await t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", salesId)).collect());

    expect(ownerRows).toHaveLength(0); // excluded
    expect(managerRows).toHaveLength(1); // holds MANAGE_USERS
    expect(salesRows).toHaveLength(0); // no MANAGE_USERS permission
  });

  test("notifyAllMembers fans out to every member of the org", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, ownerId, managerId, salesId } = await seedOrg(t);

    await t.run((ctx) => notifyAllMembers(ctx, orgId, "system.announcement", { title: "Heads up", message: "Maintenance tonight" }));

    for (const userId of [ownerId, managerId, salesId]) {
      const rows = await t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", userId)).collect());
      expect(rows).toHaveLength(1);
      expect(rows[0].data).toEqual({ title: "Heads up", message: "Maintenance tonight" });
    }
  });

  test("notifyOwner notifies only the OWNER role", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, ownerId, managerId, salesId } = await seedOrg(t);

    await t.run((ctx) => notifyOwner(ctx, orgId, "role.changed", { actorName: "Carol", roleName: "SALES" }));

    const ownerRows = await t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", ownerId)).collect());
    const managerRows = await t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", managerId)).collect());
    const salesRows = await t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", salesId)).collect());

    expect(ownerRows).toHaveLength(1);
    expect(managerRows).toHaveLength(0);
    expect(salesRows).toHaveLength(0);
  });

  test("notifyFinanceManagers fans out to every MANAGE_FINANCE holder (including the owner), not to a non-finance member", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, ownerId, accountantId, salesId } = await seedFinanceOrg(t);

    await t.run((ctx) =>
      notifyFinanceManagers(ctx, orgId, "accounting.prepaidAmortizationFailed", {
        expenseTitle: "Insurance",
        yearMonth: "2026-01",
        errorMessage: "boom",
      })
    );

    const ownerRows = await t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", ownerId)).collect());
    const accountantRows = await t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", accountantId)).collect());
    const salesRows = await t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", salesId)).collect());

    expect(ownerRows).toHaveLength(1); // isSystemOwnerRole always included, even without manage:finance
    expect(accountantRows).toHaveLength(1); // holds manage:finance
    expect(salesRows).toHaveLength(0);
  });

  test("notifyFinanceManagers honors excludeUserId — the maker isn't notified about their own request", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, ownerId, accountantId } = await seedFinanceOrg(t);

    await t.run((ctx) =>
      notifyFinanceManagers(
        ctx,
        orgId,
        "accounting.prepaidCorrectionRequested",
        { actorName: "Accountant", expenseTitle: "Insurance", amount: "300" },
        { excludeUserId: accountantId }
      )
    );

    const ownerRows = await t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", ownerId)).collect());
    const accountantRows = await t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", accountantId)).collect());

    expect(ownerRows).toHaveLength(1);
    expect(accountantRows).toHaveLength(0); // excluded
  });

  test("notifyFinanceManagers falls back to notifyOwner's no-op behavior when literally nobody in the org holds MANAGE_FINANCE or the owner role", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "No-Finance Org", createdAt: Date.now() }));
    const salesRoleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "SALES", permissions: ["view:vehicles"] }));
    const salesId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "nf_sales_001", email: "sales@nofinance.test" }));
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: salesId, roleId: salesRoleId }));

    // No MANAGE_FINANCE holder and no owner membership at all — the fallback
    // path must not throw even though there's nobody for notifyOwner to reach.
    await expect(
      t.run((ctx) =>
        notifyFinanceManagers(ctx, orgId, "accounting.prepaidAmortizationFailed", {
          expenseTitle: "Insurance",
          yearMonth: "2026-01",
          errorMessage: "boom",
        })
      )
    ).resolves.not.toThrow();

    const salesRows = await t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", salesId)).collect());
    expect(salesRows).toHaveLength(0);
  });

  test("email defaults to the type's criticalDefault when no preference row exists", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, salesId } = await seedOrg(t);
    await t.run((ctx) => ctx.db.patch(salesId, { email: "sales@test.com" }));

    // "approval.requested" has criticalDefault: true -> should schedule an email with no preference row set.
    await t.run((ctx) => notifyUser(ctx, orgId, salesId, "approval.requested", { actorName: "Dana", saleLabel: "2024 Civic" }));
    const scheduledAfterCritical = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduledAfterCritical.length).toBeGreaterThan(0);
  });

  test("email is not scheduled when the user has explicitly opted out of a category", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, salesId } = await seedOrg(t);
    await t.run((ctx) => ctx.db.patch(salesId, { email: "sales@test.com" }));
    await t.run((ctx) =>
      ctx.db.insert("notificationPreferences", {
        orgId,
        userId: salesId,
        category: "finance",
        emailEnabled: false,
        whatsappEnabled: false,
      })
    );

    await t.run((ctx) => notifyUser(ctx, orgId, salesId, "approval.requested", { actorName: "Dana", saleLabel: "2024 Civic" }));
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toHaveLength(0);
  });

  test("push is not scheduled by default even when email is (opt-in only, unlike email)", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, salesId } = await seedOrg(t);

    // "approval.requested" has criticalDefault: true, so email schedules with no
    // preference row set — but push has no criticalDefault fallback, so the total
    // scheduled count should be exactly 1 (email only), not 2.
    await t.run((ctx) => notifyUser(ctx, orgId, salesId, "approval.requested", { actorName: "Dana", saleLabel: "2024 Civic" }));
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toHaveLength(1);
  });

  test("push is scheduled once the user opts a category into pushEnabled", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, salesId } = await seedOrg(t);
    await t.run((ctx) =>
      ctx.db.insert("notificationPreferences", {
        orgId,
        userId: salesId,
        category: "inventory",
        emailEnabled: false,
        whatsappEnabled: false,
        pushEnabled: true,
      })
    );

    await t.run((ctx) => notifyUser(ctx, orgId, salesId, "vehicle.created", { actorName: "Dana" }));
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toHaveLength(1);
  });

  test("dispatch still inserts the in-app row but no-ops the rest if the user no longer exists", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, salesId } = await seedOrg(t);
    await t.run((ctx) => ctx.db.delete(salesId));

    await expect(
      t.run((ctx) => notifyUser(ctx, orgId, salesId, "vehicle.created", { actorName: "Dana" }))
    ).resolves.not.toThrow();

    const rows = await t.run((ctx) =>
      ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", salesId)).collect()
    );
    expect(rows).toHaveLength(1);
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toHaveLength(0);
  });

  test("schedules an email with no data argument at all (not just an empty object)", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, salesId } = await seedOrg(t);
    await t.run((ctx) => ctx.db.patch(salesId, { email: "sales@test.com" }));

    // "approval.requested" has criticalDefault: true, so this schedules an
    // email even with no preference row and no data argument.
    await t.run((ctx) => notifyUser(ctx, orgId, salesId, "approval.requested"));
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toHaveLength(1);
  });

  test("schedules a WhatsApp notification when enabled, the plan supports it, and the user has a phone", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, salesId } = await seedOrg(t);
    await t.run((ctx) =>
      ctx.db.insert("subscriptions", {
        orgId,
        plan: "professional",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    await t.run((ctx) => ctx.db.patch(salesId, { whatsappPhone: "+962700000000" }));
    await t.run((ctx) =>
      ctx.db.insert("notificationPreferences", {
        orgId,
        userId: salesId,
        category: "inventory",
        emailEnabled: false,
        whatsappEnabled: true,
      })
    );

    // Also omits the data argument, exercising WhatsApp's own `data ?? {}` fallback.
    await t.run((ctx) => notifyUser(ctx, orgId, salesId, "vehicle.created"));
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toHaveLength(1);
  });

  test("does not schedule WhatsApp when enabled by preference but the org's plan doesn't include it", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, salesId } = await seedOrg(t);
    await t.run((ctx) => ctx.db.patch(salesId, { whatsappPhone: "+962700000000" }));
    await t.run((ctx) =>
      ctx.db.insert("notificationPreferences", {
        orgId,
        userId: salesId,
        category: "inventory",
        emailEnabled: false,
        whatsappEnabled: true,
      })
    );

    // No subscription row -> free plan, which doesn't include whatsapp.
    await t.run((ctx) => notifyUser(ctx, orgId, salesId, "vehicle.created"));
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toHaveLength(0);
  });

  test("passes an empty object to the scheduled push action when no data is given", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, salesId } = await seedOrg(t);
    await t.run((ctx) =>
      ctx.db.insert("notificationPreferences", {
        orgId,
        userId: salesId,
        category: "inventory",
        emailEnabled: false,
        whatsappEnabled: false,
        pushEnabled: true,
      })
    );

    await t.run((ctx) => notifyUser(ctx, orgId, salesId, "vehicle.created"));
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toHaveLength(1);
  });

  test("notifyManagers skips a membership whose role has been deleted", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, managerId } = await seedOrg(t);
    const ghostUserId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "ghost_001", email: "ghost@test.com" }));
    const ghostRoleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "GHOST", permissions: ["manage:users"] }));
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: ghostUserId, roleId: ghostRoleId }));
    await t.run((ctx) => ctx.db.delete(ghostRoleId));

    await expect(
      t.run((ctx) => notifyManagers(ctx, orgId, "vehicle.created", { actorName: "Eve" }))
    ).resolves.not.toThrow();

    const managerRows = await t.run((ctx) =>
      ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", managerId)).collect()
    );
    expect(managerRows).toHaveLength(1);
    const ghostRows = await t.run((ctx) =>
      ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", ghostUserId)).collect()
    );
    expect(ghostRows).toHaveLength(0);
  });

  test("notifyAllMembers honors excludeUserId", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, ownerId, managerId, salesId } = await seedOrg(t);

    await t.run((ctx) =>
      notifyAllMembers(ctx, orgId, "system.announcement", { title: "Heads up", message: "Maintenance" }, { excludeUserId: salesId })
    );

    const salesRows = await t.run((ctx) =>
      ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", salesId)).collect()
    );
    expect(salesRows).toHaveLength(0);
    const ownerRows = await t.run((ctx) =>
      ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", ownerId)).collect()
    );
    expect(ownerRows).toHaveLength(1);
    const managerRows = await t.run((ctx) =>
      ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", managerId)).collect()
    );
    expect(managerRows).toHaveLength(1);
  });

  test("notifyByPermission skips excluded, missing-role, and unauthorized members", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, managerId, salesId } = await seedOrg(t);
    const viewerRoleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "VIEWER", permissions: [PERMISSIONS.VIEW_VEHICLES] })
    );
    const viewerId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "viewer_001", email: "viewer@test.com" })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: viewerId, roleId: viewerRoleId }));

    const ghostUserId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "ghost_perm_001", email: "ghost-perm@test.com" })
    );
    const ghostRoleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "GHOST", permissions: [PERMISSIONS.VIEW_VEHICLES] })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: ghostUserId, roleId: ghostRoleId }));
    await t.run((ctx) => ctx.db.delete(ghostRoleId));

    await t.run((ctx) =>
      notifyByPermission(ctx, orgId, PERMISSIONS.VIEW_VEHICLES, "vehicle.created", { actorName: "Nora" }, { excludeUserId: salesId })
    );

    const viewerRows = await t.run((ctx) =>
      ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", viewerId)).collect()
    );
    const salesRows = await t.run((ctx) =>
      ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", salesId)).collect()
    );
    const managerRows = await t.run((ctx) =>
      ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", managerId)).collect()
    );
    const ghostRows = await t.run((ctx) =>
      ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", ghostUserId)).collect()
    );

    expect(viewerRows).toHaveLength(1);
    expect(salesRows).toHaveLength(0);
    expect(managerRows).toHaveLength(0);
    expect(ghostRows).toHaveLength(0);
  });
});

// SCRUM-807 — notifyManagers used to re-read every membership and one role per
// membership on every call, so a cron fanning out to T tasks in one org paid
// T x (1 + M) reads for the same answer.
describe("manager recipient resolution (SCRUM-807)", () => {
  type T = ReturnType<typeof convexTestWithComponents<typeof schema>>;

  /** Counts db.get / db.query calls made through the returned ctx. */
  function counting<C extends { db: object }>(ctx: C) {
    const calls = { get: 0, query: 0 };
    const db = new Proxy(ctx.db, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== "function") return value;
        if (prop === "get" || prop === "query") {
          return (...args: unknown[]) => {
            calls[prop] += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });
    return { ctx: { ...ctx, db } as C, calls };
  }

  /** `count` extra members, all sharing one existing role. */
  async function addMembers(t: T, orgId: Id<"organizations">, roleId: Id<"roles">, count: number, tag: string) {
    const ids: Id<"users">[] = [];
    for (let i = 0; i < count; i++) {
      const userId = await t.run((ctx) =>
        ctx.db.insert("users", { clerkId: `${tag}_${i}`, email: `${tag}${i}@test.com` })
      );
      await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
      ids.push(userId);
    }
    return ids;
  }

  async function roleIdByName(t: T, orgId: Id<"organizations">, name: string) {
    const roles = await t.run((ctx) =>
      ctx.db.query("roles").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    return roles.find((r) => r.name === name)!._id;
  }

  test("looks each distinct role up once, however many memberships share it", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId } = await seedOrg(t);
    // 3 seeded members (OWNER, MANAGER, SALES) + 9 more MANAGERs + 6 more SALES.
    await addMembers(t, orgId, await roleIdByName(t, orgId, "MANAGER"), 9, "mgr");
    await addMembers(t, orgId, await roleIdByName(t, orgId, "SALES"), 6, "sls");

    const resolved = await t.run(async (ctx) => {
      const probe = counting(ctx);
      const result = await resolveManagerRecipients(probe.ctx, orgId);
      return { result, calls: probe.calls };
    });

    // 18 memberships, 3 distinct roles: one memberships query + 3 role reads.
    expect(resolved.calls).toEqual({ query: 1, get: 3 });
    expect(resolved.result).toHaveLength(11); // owner + 10 managers
  });

  test("notifyManagers pays one role read per distinct role, not one per membership", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId } = await seedOrg(t);
    await addMembers(t, orgId, await roleIdByName(t, orgId, "MANAGER"), 9, "mgr");
    await addMembers(t, orgId, await roleIdByName(t, orgId, "SALES"), 6, "sls");

    const calls = await t.run(async (ctx) => {
      const probe = counting(ctx);
      await notifyManagers(probe.ctx, orgId, "vehicle.created", { actorName: "Bob" });
      return probe.calls;
    });

    // 11 recipients. Each dispatch reads its user (get), preference and mobile
    // token (queries); the membership query + 3 role gets are the resolution.
    expect(calls.get).toBe(3 + 11);
    expect(calls.query).toBe(1 + 11 * 2);
  });

  test("recipients keep membership order, honour excludeUserId, and match what notifyManagers sends", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, ownerId, managerId } = await seedOrg(t);
    const extra = await addMembers(t, orgId, await roleIdByName(t, orgId, "MANAGER"), 3, "mgr");

    const all = await t.run((ctx) => resolveManagerRecipients(ctx, orgId));
    expect(all).toEqual([ownerId, managerId, ...extra]);

    const excluding = await t.run((ctx) => resolveManagerRecipients(ctx, orgId, ownerId));
    expect(excluding).toEqual([managerId, ...extra]);

    await t.run((ctx) => notifyManagers(ctx, orgId, "vehicle.created", { actorName: "Bob" }, { excludeUserId: ownerId }));
    const sent = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(sent.map((n) => n.userId)).toEqual(excluding);
  });

  test("keeps today's behaviour for deleted roles, soft-deleted roles, offboarding members and duplicate memberships", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, managerId } = await seedOrg(t);

    // A membership whose role row is gone: skipped.
    const ghostUserId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "ghost_1", email: "g@test.com" }));
    const ghostRoleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "GHOST", permissions: ["manage:users"] }));
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: ghostUserId, roleId: ghostRoleId }));
    await t.run((ctx) => ctx.db.delete(ghostRoleId));

    // A soft-deleted role is still a row with MANAGE_USERS: still counted.
    const softUserId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "soft_1", email: "s@test.com" }));
    const softRoleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "SOFT", permissions: ["manage:users"], isDeleted: true })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: softUserId, roleId: softRoleId }));

    // An offboarding member is NOT filtered by notifyManagers (unlike notifyByPermission).
    await t.run(async (ctx) => {
      const m = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", managerId))
        .unique();
      await ctx.db.patch(m!._id, { offboardingStatus: "PENDING_EXTERNAL_REMOVAL" });
    });

    // A duplicate membership for the same user yields two recipients (two notifications).
    const managerRoleId = await roleIdByName(t, orgId, "MANAGER");
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: managerId, roleId: managerRoleId }));

    const recipients = await t.run((ctx) => resolveManagerRecipients(ctx, orgId));
    expect(recipients.filter((id) => id === ghostUserId)).toHaveLength(0);
    expect(recipients.filter((id) => id === softUserId)).toHaveLength(1);
    expect(recipients.filter((id) => id === managerId)).toHaveLength(2);

    await t.run((ctx) => notifyManagers(ctx, orgId, "vehicle.created", { actorName: "Eve" }));
    const rows = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(rows).toHaveLength(recipients.length);
  });

  test("DISPATCH_MAX_* match the real worst case: every channel on, WhatsApp plan gate open", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId } = await seedOrg(t);
    await t.run((ctx) =>
      ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
    );
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "allchan_1", email: "all@test.com", whatsappPhone: "+962790000000" })
    );
    await t.run((ctx) =>
      ctx.db.insert("notificationPreferences", {
        orgId, userId, category: "operations", emailEnabled: true, whatsappEnabled: true, pushEnabled: true,
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("mobilePushTokens", {
        userId, token: "ExponentPushToken[allchan]", platform: "IOS", createdAt: Date.now(), lastSeenAt: Date.now(),
      })
    );

    await t.run((ctx) => dispatch(ctx, orgId, userId, "task.overdue_warning", { taskTitle: "T", assigneeName: "A" }));
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());

    // Pinned equal, not just bounded: if dispatch gains a channel, the page and
    // hop sizes derived from it (convex/crons.ts) are under-counting until this moves.
    expect(scheduled).toHaveLength(DISPATCH_MAX_SCHEDULED);
  });

  test("walking the pages yields the same recipients, in the same order, as the unpaged resolver", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId } = await seedOrg(t);
    await addMembers(t, orgId, await roleIdByName(t, orgId, "MANAGER"), 9, "mgr");
    await addMembers(t, orgId, await roleIdByName(t, orgId, "SALES"), 6, "sls");
    await addMembers(t, orgId, await roleIdByName(t, orgId, "MANAGER"), 2, "late");
    // A duplicate membership, so that quirk can fall on a page edge too.
    const managerRoleId = await roleIdByName(t, orgId, "MANAGER");
    const dupUser = (await t.run((ctx) => resolveManagerRecipients(ctx, orgId)))[1];
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: dupUser, roleId: managerRoleId }));

    const unpaged = await t.run((ctx) => resolveManagerRecipients(ctx, orgId));

    const paged: Id<"users">[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const page: Awaited<ReturnType<typeof resolveManagerRecipientsPage>> = await t.run((ctx) =>
        resolveManagerRecipientsPage(ctx, orgId, cursor, 4)
      );
      paged.push(...page.recipients);
      pages++;
      if (page.isDone) break;
      cursor = page.continueCursor;
    }

    expect(pages).toBeGreaterThan(3);
    expect(paged).toEqual(unpaged);
  });
});

describe("getActorName", () => {
  test("returns 'Someone' when unauthenticated", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const name = await t.run((ctx) => getActorName(ctx));
    expect(name).toBe("Someone");
  });

  test("returns the user's own name when set", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    await t.run((ctx) => ctx.db.insert("users", { clerkId: "actor_1", email: "a@test.com", name: "Farah" }));

    const name = await t.run((ctx) =>
      getActorName({
        ...ctx,
        auth: { ...ctx.auth, getUserIdentity: async () => ({ subject: "actor_1", name: "Identity Name" }) as any },
      } as any)
    );
    expect(name).toBe("Farah");
  });

  test("falls back to the identity's name when the user row has none", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    await t.run((ctx) => ctx.db.insert("users", { clerkId: "actor_2", email: "b@test.com" }));

    const name = await t.run((ctx) =>
      getActorName({
        ...ctx,
        auth: { ...ctx.auth, getUserIdentity: async () => ({ subject: "actor_2", name: "Identity Name" }) as any },
      } as any)
    );
    expect(name).toBe("Identity Name");
  });

  test("falls back to 'A team member' when neither the user nor identity have a name", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    await t.run((ctx) => ctx.db.insert("users", { clerkId: "actor_3", email: "c@test.com" }));

    const name = await t.run((ctx) =>
      getActorName({
        ...ctx,
        auth: { ...ctx.auth, getUserIdentity: async () => ({ subject: "actor_3" }) as any },
      } as any)
    );
    expect(name).toBe("A team member");
  });
});
