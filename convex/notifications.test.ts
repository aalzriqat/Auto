import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

async function seedOrgWithMember(t: ReturnType<typeof convexTest>) {
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Test Org", createdAt: Date.now() }));
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "member_001", email: "member@test.com", name: "Member" }));
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "SALES", permissions: ["view:vehicles"] }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  return { orgId, userId, asMember: t.withIdentity({ subject: "member_001" }) };
}

async function insertNotification(
  t: ReturnType<typeof convexTest>,
  orgId: Id<"organizations">,
  userId: Id<"users">,
  overrides: Partial<{ type: string; category: string; isRead: boolean; isArchived: boolean }> = {}
) {
  return await t.run((ctx) =>
    ctx.db.insert("notifications", {
      orgId,
      userId,
      type: overrides.type ?? "lead.created",
      category: overrides.category ?? "sales",
      priority: "normal",
      data: { actorName: "Bob" },
      isRead: overrides.isRead ?? false,
      isArchived: overrides.isArchived,
    })
  );
}

describe("notifications", () => {
  test("list returns only the caller's notifications, newest first, excluding archived", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId, asMember } = await seedOrgWithMember(t);

    await insertNotification(t, orgId, userId);
    await insertNotification(t, orgId, userId, { isArchived: true });

    // A different user's notification in the same org must not leak.
    const otherUserId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "other_001", email: "other@test.com" }));
    const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] }));
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: otherUserId, roleId }));
    await insertNotification(t, orgId, otherUserId);

    const result = await asMember.query(api.notifications.list, { orgId });
    expect(result).toHaveLength(1);
    expect(result[0].userId).toBe(userId);
  });

  test("unreadCount only counts unread, non-archived notifications", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId, asMember } = await seedOrgWithMember(t);

    await insertNotification(t, orgId, userId, { isRead: false });
    await insertNotification(t, orgId, userId, { isRead: false, isArchived: true });
    await insertNotification(t, orgId, userId, { isRead: true });

    const count = await asMember.query(api.notifications.unreadCount, { orgId });
    expect(count).toBe(1);
  });

  test("listPage filters by category", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId, asMember } = await seedOrgWithMember(t);

    await insertNotification(t, orgId, userId, { category: "sales" });
    await insertNotification(t, orgId, userId, { category: "finance" });

    const result = await asMember.query(api.notifications.listPage, {
      orgId,
      category: "finance",
      showArchived: false,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(result.page).toHaveLength(1);
    expect(result.page[0].category).toBe("finance");
  });

  test("markAsRead only succeeds for the caller's own notification", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId, asMember } = await seedOrgWithMember(t);

    const notifId = await insertNotification(t, orgId, userId);
    await asMember.mutation(api.notifications.markAsRead, { orgId, notificationId: notifId });

    const notif = await t.run((ctx) => ctx.db.get(notifId));
    expect(notif?.isRead).toBe(true);
  });

  test("markAsRead throws for a notification belonging to another user", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asMember } = await seedOrgWithMember(t);

    const otherUserId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "other_002", email: "other2@test.com" }));
    const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] }));
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: otherUserId, roleId }));
    const notifId = await insertNotification(t, orgId, otherUserId);

    await expect(asMember.mutation(api.notifications.markAsRead, { orgId, notificationId: notifId })).rejects.toThrow();
  });

  test("markAllAsRead marks every unread notification as read", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId, asMember } = await seedOrgWithMember(t);

    await insertNotification(t, orgId, userId);
    await insertNotification(t, orgId, userId);

    await asMember.mutation(api.notifications.markAllAsRead, { orgId });

    const count = await asMember.query(api.notifications.unreadCount, { orgId });
    expect(count).toBe(0);
  });

  test("archive sets isArchived and archivedAt, and removes it from the default feed", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId, asMember } = await seedOrgWithMember(t);

    const notifId = await insertNotification(t, orgId, userId);
    await asMember.mutation(api.notifications.archive, { orgId, notificationId: notifId });

    const notif = await t.run((ctx) => ctx.db.get(notifId));
    expect(notif?.isArchived).toBe(true);
    expect(notif?.archivedAt).toBeDefined();

    const list = await asMember.query(api.notifications.list, { orgId });
    expect(list).toHaveLength(0);
  });
});

describe("notificationPreferences", () => {
  test("getMyPreferences returns computed defaults when no rows exist", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asMember } = await seedOrgWithMember(t);

    const prefs = await asMember.query(api.notificationPreferences.getMyPreferences, { orgId });
    expect(prefs).toHaveLength(7); // one per NOTIFICATION_CATEGORIES entry

    // "finance" contains opt-out-by-default types (e.g. approval.requested), so it defaults to email-on.
    const finance = prefs.find((p) => p.category === "finance");
    expect(finance?.emailEnabled).toBe(true);
    expect(finance?.whatsappEnabled).toBe(false);
  });

  test("setPreference upserts and is reflected by getMyPreferences", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asMember } = await seedOrgWithMember(t);

    await asMember.mutation(api.notificationPreferences.setPreference, {
      orgId,
      category: "sales",
      emailEnabled: true,
      whatsappEnabled: true,
    });

    const prefs = await asMember.query(api.notificationPreferences.getMyPreferences, { orgId });
    const sales = prefs.find((p) => p.category === "sales");
    expect(sales?.emailEnabled).toBe(true);
    expect(sales?.whatsappEnabled).toBe(true);

    // Updating again should patch the same row, not insert a duplicate.
    await asMember.mutation(api.notificationPreferences.setPreference, {
      orgId,
      category: "sales",
      emailEnabled: false,
      whatsappEnabled: true,
    });
    const updated = await asMember.query(api.notificationPreferences.getMyPreferences, { orgId });
    expect(updated.filter((p) => p.category === "sales")).toHaveLength(1);
    expect(updated.find((p) => p.category === "sales")?.emailEnabled).toBe(false);
  });
});
